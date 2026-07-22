/**
 * Structured JSON-lines logger for the Verger main process.
 *
 * Design constraints (Standing Rule 2 — OBS is the resilient engine, this app is a
 * convenience layer):
 *
 *  - **Logging must never take down a live service.** Every filesystem interaction is
 *    wrapped; a failing disk degrades to "no log line" and never propagates an error to
 *    the caller. There is no code path in this file that can throw.
 *  - **Never log a secret value** (Standing Rule 5). Any field whose *key* matches
 *    {@link REDACT_KEY_PATTERN} has its value replaced with {@link REDACTED} before the
 *    record is serialised, recursively, in both the file sink and the console mirror.
 *  - **Fully injectable.** The directory, clock, filesystem and console are all
 *    parameters, so the unit tests need neither Electron, a real clock, nor a real disk.
 *
 * Output format is one JSON object per line (JSON Lines), which greps, tails and
 * `jq`-filters cleanly during a service, and is trivially machine-parsed afterwards.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// `LogLevel`, `LogFields`, `Logger` and `LogRecord` are declared ONCE in
// `src/shared/log.ts` — the renderer forwards its own records over IPC into this same
// rolling file, so it needs the identical vocabulary. Re-exported here for existing
// `@main/logging/logger` importers.
export type { LogFields, Logger, LogLevel, LogRecord } from '@shared/log'

import type { LogFields, Logger, LogLevel } from '@shared/log'

/** The minimal `node:fs` surface the logger needs. Injectable for tests. */
export interface LoggerFs {
  mkdirSync(directory: string, options: { readonly recursive: true }): void
  appendFileSync(file: string, data: string): void
  statSync(file: string): { readonly size: number }
  renameSync(from: string, to: string): void
  readdirSync(directory: string): string[]
  unlinkSync(file: string): void
}

/** The minimal console surface used by the dev mirror. */
export interface LoggerConsole {
  log(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface CreateLoggerOptions {
  /** Directory the rolling log files live in — normally `<userData>/logs`. */
  readonly directory: string
  /** Minimum level to emit. Default `'info'`. */
  readonly level?: LogLevel
  /** Rotate once appending would push the active file past this many bytes. Default 5 MiB. */
  readonly maxBytes?: number
  /**
   * Total number of log files retained for this logger (the active file plus its
   * archives). Default 5 — i.e. `verger-<date>.log` plus `.1` … `.4`.
   */
  readonly maxFiles?: number
  /** Base name of the log files. Default `'verger'`. */
  readonly filePrefix?: string
  /** Clock. Default `() => new Date()`. */
  readonly now?: () => Date
  /** Injected filesystem. Default: `node:fs` sync calls. */
  readonly fs?: LoggerFs
  /** Mirror records to the console as well as the file. Enable in dev only. */
  readonly mirrorToConsole?: boolean
  /** Injected console for the mirror. Default: the global `console`. */
  readonly console?: LoggerConsole
}

/** Replacement written in place of any value whose key looks secret. */
export const REDACTED = '[redacted]'

/**
 * Field-name test for secret-bearing values. Deliberately broad: it is far cheaper to
 * over-redact an innocuous `sceneKey` than to leak an OBS password into a log a volunteer
 * emails to support.
 */
export const REDACT_KEY_PATTERN = /password|secret|token|key|dsn/i

/** 5 MiB. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** Active file plus four archives. */
export const DEFAULT_MAX_FILES = 5

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const MAX_REDACT_DEPTH = 6

/**
 * Recursively copies `fields`, replacing the value of any key matching
 * {@link REDACT_KEY_PATTERN} with {@link REDACTED}. Cycles and over-deep structures are
 * collapsed rather than followed, so this can never blow the stack on a live-service log
 * call.
 */
export function redactFields(fields: LogFields): Record<string, unknown> {
  const seen = new Set<unknown>()
  const result = redactValue(fields, 0, seen)
  return isPlainRecord(result) ? result : {}
}

function redactValue(value: unknown, depth: number, seen: Set<unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_REDACT_DEPTH) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen))
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (value instanceof Date) {
    return value.toISOString()
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = shouldRedact(key, item) ? REDACTED : redactValue(item, depth + 1, seen)
  }
  return out
}

/**
 * Whether a key/value pair must be blanked.
 *
 * Matching on the key alone is not enough. `ConfigSummary.configured` is a
 * `Record<EnvKey, boolean>` whose keys are literally `OBS_WEBSOCKET_PASSWORD`,
 * `GOOGLE_CLIENT_SECRET`, `DEEPGRAM_API_KEY` and so on — but its values are booleans meaning
 * "is this configured?". Redacting those destroys the single most useful diagnostic in the
 * startup log ("which subsystems are live?") and misleadingly implies a secret was present.
 *
 * A boolean cannot carry a secret value, so booleans are never redacted. Everything else under
 * a secret-shaped key still is.
 */
function shouldRedact(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return false
  return REDACT_KEY_PATTERN.test(key)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Default filesystem adapter
// ---------------------------------------------------------------------------

/**
 * Explicit lambdas rather than direct method references: `node:fs` declares these as
 * overload sets whose assignability to the narrow {@link LoggerFs} shape is not
 * guaranteed, and the narrow shape is what the tests fake.
 */
const nodeLoggerFs: LoggerFs = {
  mkdirSync: (directory, options) => {
    mkdirSync(directory, options)
  },
  appendFileSync: (file, data) => {
    appendFileSync(file, data, 'utf8')
  },
  statSync: (file) => statSync(file),
  renameSync: (from, to) => {
    renameSync(from, to)
  },
  readdirSync: (directory) => readdirSync(directory),
  unlinkSync: (file) => {
    unlinkSync(file)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

interface LoggerCore {
  readonly directory: string
  readonly level: LogLevel
  readonly maxBytes: number
  readonly maxFiles: number
  readonly filePrefix: string
  readonly now: () => Date
  readonly fs: LoggerFs
  readonly mirrorToConsole: boolean
  readonly console: LoggerConsole
  directoryEnsured: boolean
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const core: LoggerCore = {
    directory: options.directory,
    level: options.level ?? 'info',
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES),
    filePrefix: options.filePrefix ?? 'verger',
    now: options.now ?? (() => new Date()),
    fs: options.fs ?? nodeLoggerFs,
    mirrorToConsole: options.mirrorToConsole ?? false,
    console: options.console ?? globalThis.console,
    directoryEnsured: false
  }
  return makeLogger(core, null)
}

function makeLogger(core: LoggerCore, scope: string | null): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    write(core, level, scope, message, fields)
  }
  return {
    debug: (message, fields) => {
      emit('debug', message, fields)
    },
    info: (message, fields) => {
      emit('info', message, fields)
    },
    warn: (message, fields) => {
      emit('warn', message, fields)
    },
    error: (message, fields) => {
      emit('error', message, fields)
    },
    child: (childScope: string) =>
      makeLogger(core, scope === null ? childScope : `${scope}:${childScope}`)
  }
}

function write(
  core: LoggerCore,
  level: LogLevel,
  scope: string | null,
  message: string,
  fields?: LogFields
): void {
  // A logging call must never throw into a live-service code path. Everything below this
  // line is best-effort.
  try {
    if (LEVEL_RANK[level] < LEVEL_RANK[core.level]) return

    const timestamp = core.now()
    const record: Record<string, unknown> = {
      ...(fields === undefined ? {} : redactFields(fields)),
      ts: timestamp.toISOString(),
      level,
      msg: message
    }
    if (scope !== null) record['scope'] = scope

    const line = `${JSON.stringify(record)}\n`

    if (core.mirrorToConsole) {
      mirror(core, level, line)
    }
    appendLine(core, line, timestamp)
  } catch {
    // Swallowed by design. See the module docblock.
  }
}

function mirror(core: LoggerCore, level: LogLevel, line: string): void {
  try {
    const text = line.trimEnd()
    if (level === 'error') core.console.error(text)
    else if (level === 'warn') core.console.warn(text)
    else core.console.log(text)
  } catch {
    /* ignore */
  }
}

function appendLine(core: LoggerCore, line: string, timestamp: Date): void {
  const file = activeFilePath(core, timestamp)

  if (!core.directoryEnsured) {
    core.fs.mkdirSync(core.directory, { recursive: true })
    core.directoryEnsured = true
  }

  const currentSize = sizeOf(core, file)
  if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > core.maxBytes) {
    rotate(core, file)
  }

  core.fs.appendFileSync(file, line)
}

function activeFilePath(core: LoggerCore, timestamp: Date): string {
  return join(core.directory, `${core.filePrefix}-${isoDate(timestamp)}.log`)
}

/** `YYYY-MM-DD` in UTC — stable across timezone changes mid-service. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function sizeOf(core: LoggerCore, file: string): number {
  try {
    return core.fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Shifts `file` → `file.1` → `file.2` … dropping anything past `maxFiles - 1` archives,
 * then prunes the directory so at most `maxFiles` Verger log files survive in total
 * (which also cleans up files left behind by previous days).
 */
function rotate(core: LoggerCore, file: string): void {
  const archiveCount = core.maxFiles - 1

  if (archiveCount < 1) {
    tryUnlink(core, file)
    pruneDirectory(core, 0)
    return
  }

  tryUnlink(core, `${file}.${archiveCount}`)
  for (let index = archiveCount - 1; index >= 1; index -= 1) {
    tryRename(core, `${file}.${index}`, `${file}.${index + 1}`)
  }
  tryRename(core, file, `${file}.1`)

  // The active file has just been renamed away and is about to be recreated by the
  // caller, so the budget for what is currently on disk is one less than `maxFiles`.
  pruneDirectory(core, archiveCount)
}

function tryUnlink(core: LoggerCore, file: string): void {
  try {
    core.fs.unlinkSync(file)
  } catch {
    /* not present — nothing to drop */
  }
}

function tryRename(core: LoggerCore, from: string, to: string): void {
  try {
    core.fs.renameSync(from, to)
  } catch {
    /* not present — nothing to shift */
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface LogFileName {
  readonly name: string
  readonly date: string
  readonly archive: number
}

/** Deletes the oldest Verger log files until at most `keep` of them remain on disk. */
function pruneDirectory(core: LoggerCore, keep: number): void {
  let entries: string[]
  try {
    entries = core.fs.readdirSync(core.directory)
  } catch {
    return
  }

  const pattern = new RegExp(
    `^${escapeForRegExp(core.filePrefix)}-(\\d{4}-\\d{2}-\\d{2})\\.log(?:\\.(\\d+))?$`
  )

  const files: LogFileName[] = []
  for (const name of entries) {
    const match = pattern.exec(name)
    if (match === null) continue
    const date = match[1]
    if (date === undefined) continue
    const archiveText = match[2]
    files.push({ name, date, archive: archiveText === undefined ? 0 : Number(archiveText) })
  }

  // Newest first: latest date wins; within a date, a lower archive index is newer
  // (`.log` is the active file, `.1` the most recently rotated).
  files.sort((a, b) => (a.date === b.date ? a.archive - b.archive : a.date < b.date ? 1 : -1))

  for (const stale of files.slice(Math.max(0, keep))) {
    tryUnlink(core, join(core.directory, stale.name))
  }
}

/**
 * A logger that discards everything. Useful as a default dependency so no module has to
 * branch on "do I have a logger yet".
 */
export function createNullLogger(): Logger {
  const noop = (): void => {}
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger
  }
  return logger
}
