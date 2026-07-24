/**
 * Locate, read, and (on first launch) create the operator's `config.json` next to the launcher.
 *
 * This is the impure half of the portable-config contract; the pure shape and mapping live in
 * `src/shared/appConfig.ts`. It is deliberately Electron-free — the caller supplies `isPackaged` and
 * the executable's directory — so it unit-tests in a plain Node process, the same discipline that
 * keeps `OverlayServer` testable.
 *
 * ## Where the file lives, and why it matters
 *
 * The audit that motivated this found that dotenv resolves `.env` from `process.cwd()`, which for a
 * double-clicked packaged exe is not reliably the folder the exe sits in. So for a **packaged** build
 * we resolve `config.json` (and the sibling `.env`) explicitly against the executable's own
 * directory. `START.bat` also `cd`s there, so both paths agree.
 *
 * ## Dev is left completely alone
 *
 * When not packaged, this manages nothing unless a `config.json` already happens to sit in the cwd
 * (which lets a developer opt in to test the path). It never *writes* a `config.json` into the repo,
 * and it emits no env overrides — so the existing `.env` dev flow, and every test that depends on it,
 * behaves exactly as before. `managed` is the flag the caller uses to know whether to apply anything.
 *
 * ## Standing Rule 5
 *
 * Nothing here throws. A missing file is written from the default and the app continues. An
 * unreadable or malformed file is reported as a warning, the operator's file is left untouched (so a
 * hand-editing mistake is recoverable), and the app continues on the parsed-with-defaults config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_PORTABLE_CONFIG,
  portableConfigSchema,
  resolvePortableConfig,
  serializePortableConfig,
} from '@shared/appConfig'
import type { PortableConfig, ResolvedPortableConfig } from '@shared/appConfig'

/** The fixed filename read next to the launcher. */
export const PORTABLE_CONFIG_FILENAME = 'config.json'

/** How the effective config was obtained — surfaced in the startup log and the Preflight screen. */
export type PortableConfigSource =
  | 'default-written' // packaged, no file existed: a default config.json was written
  | 'file' // an existing config.json was read and parsed
  | 'invalid-fell-back' // a config.json existed but was unreadable/corrupt: defaults used, file kept
  | 'dev-env' // not packaged and no config.json present: .env flow, nothing managed

export interface LoadPortableConfigOptions {
  /** `app.isPackaged`. Decides whether we manage a file and where it lives. */
  readonly isPackaged: boolean
  /** `dirname(app.getPath('exe'))`. The folder the launcher sits in. */
  readonly exeDir: string
  /** Override the directory `config.json` is read from. Defaults per `isPackaged`. Tests use this. */
  readonly configDir?: string
}

/**
 * The resolved portable configuration plus everything the launcher needs to wire it up.
 *
 * `managed` is the load-bearing flag: when `false`, the caller applies no env overrides and no
 * overlay-port override, preserving the pure `.env` dev flow. `envFilePath` is the explicit path to
 * hand dotenv so `.env` is found deterministically next to the exe (null in dev — use dotenv's cwd
 * default).
 */
export interface PortableConfigResult extends ResolvedPortableConfig {
  readonly managed: boolean
  readonly source: PortableConfigSource
  readonly configDir: string
  readonly configPath: string
  readonly envFilePath: string | null
  readonly warnings: readonly string[]
}

/**
 * Read (or create) `config.json` and resolve it into env overrides + settings.
 *
 * Never throws. See the module header for the dev/packaged split and the Standing Rule 5 behaviour.
 */
export function loadPortableConfig(options: LoadPortableConfigOptions): PortableConfigResult {
  const configDir = options.configDir ?? (options.isPackaged ? options.exeDir : process.cwd())
  const configPath = join(configDir, PORTABLE_CONFIG_FILENAME)
  const envFilePath = options.isPackaged ? join(configDir, '.env') : null
  const warnings: string[] = []

  const fileExists = existsSync(configPath)

  // Dev with no file present: manage nothing, so the `.env` flow is byte-for-byte unchanged.
  if (!fileExists && !options.isPackaged) {
    return unmanaged('dev-env', configDir, configPath, envFilePath, warnings)
  }

  // Packaged with no file: write the default and continue on it (the user's "if missing, write a
  // default one and continue").
  if (!fileExists) {
    const writeWarning = tryWriteDefault(configPath)
    if (writeWarning !== null) {
      warnings.push(writeWarning)
      // Could not write (read-only USB, permissions). Still run on the in-memory default rather than
      // refusing to start.
      return managedResult(
        'invalid-fell-back',
        DEFAULT_PORTABLE_CONFIG,
        configDir,
        configPath,
        envFilePath,
        warnings,
      )
    }
    return managedResult(
      'default-written',
      DEFAULT_PORTABLE_CONFIG,
      configDir,
      configPath,
      envFilePath,
      warnings,
    )
  }

  // A file exists (in dev or packaged): read and parse it forgivingly.
  const parsed = tryReadConfig(configPath)
  if (parsed.warning !== null) warnings.push(parsed.warning)
  const source: PortableConfigSource = parsed.warning !== null ? 'invalid-fell-back' : 'file'
  return managedResult(source, parsed.config, configDir, configPath, envFilePath, warnings)
}

/** Read + parse a config file. Returns the parsed config and, if anything went wrong, a warning. */
function tryReadConfig(configPath: string): { config: PortableConfig; warning: string | null } {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (cause) {
    return {
      config: DEFAULT_PORTABLE_CONFIG,
      warning: `config.json could not be read (${describe(cause)}); using defaults`,
    }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (cause) {
    return {
      config: DEFAULT_PORTABLE_CONFIG,
      warning: `config.json is not valid JSON (${describe(cause)}); using defaults — the file was left unchanged`,
    }
  }

  // The schema never throws (every field has `.catch`), so per-field typos silently fall back. A
  // top-level non-object still parses to the full default via the object-level `.catch`.
  return { config: portableConfigSchema.parse(json), warning: null }
}

/** Write the default config. Returns null on success, or a warning string on failure. */
function tryWriteDefault(configPath: string): string | null {
  try {
    const dir = dirname(configPath)
    if (dir.length > 0) mkdirSync(dir, { recursive: true })
    writeFileSync(configPath, serializePortableConfig(DEFAULT_PORTABLE_CONFIG), 'utf8')
    return null
  } catch (cause) {
    return `could not write a default config.json (${describe(cause)}); running on built-in defaults`
  }
}

function managedResult(
  source: PortableConfigSource,
  config: PortableConfig,
  configDir: string,
  configPath: string,
  envFilePath: string | null,
  warnings: readonly string[],
): PortableConfigResult {
  const resolved = resolvePortableConfig(config)
  return { ...resolved, managed: true, source, configDir, configPath, envFilePath, warnings }
}

function unmanaged(
  source: PortableConfigSource,
  configDir: string,
  configPath: string,
  envFilePath: string | null,
  warnings: readonly string[],
): PortableConfigResult {
  const resolved = resolvePortableConfig(DEFAULT_PORTABLE_CONFIG)
  return {
    ...resolved,
    envOverrides: {}, // dev flow: apply nothing, leave `.env` in sole charge
    managed: false,
    source,
    configDir,
    configPath,
    envFilePath,
    warnings,
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
