/**
 * The local ASR adapter: spawn, supervise and talk to the faster-whisper sidecar.
 *
 * The model itself lives in Python (`resources/asr/whisper_sidecar.py`) because that is where
 * faster-whisper is. This file is everything on the TypeScript side of that pipe: working out
 * which interpreter to run, keeping the child alive across crashes, reassembling its
 * line-delimited JSON, and turning it into {@link TranscriptSegment}s.
 *
 * ## Why the local adapter exists at all
 *
 * BLUEPRINT.md §8: cloud ASR is lower latency and better at Korean, but it dies with the
 * internet — and the internet is already carrying the stream. This adapter is what the system
 * degrades *to*, so its own failure modes have to be gentler than the thing it is backing up.
 * Nothing here throws, nothing here blocks, and nothing here can wedge the booth UI.
 *
 * ## The draft/final contract
 *
 * The sidecar runs the two-tier scheduler from `docs/v2-notes/ASR_PIPELINE.md`: a `tiny` draft
 * pass every ~500 ms and a `small` final pass every ~5 s. Both carry the **same id**; the draft
 * is `isFinal: false, isDraft: true` and the final that supersedes it is `isFinal: true`. The
 * consumer replaces by id and never appends until the final lands. This file preserves that
 * relationship exactly, with one addition: ids are prefixed with a **restart epoch**
 * (`w0-w3`, `w1-w3`, …) so that a sidecar restart — which resets the child's own counter to
 * zero — cannot make a fresh segment collide with, and silently overwrite, one the operator
 * already has on screen.
 *
 * ## Supervision
 *
 * A live service does not get to stop transcribing because a Python process died. The child is
 * respawned with exponential backoff, the gap is surfaced on the status so the operator can see
 * it, and after {@link WhisperRestartPolicy.maxAttempts} consecutive failures the provider goes
 * `failed` rather than thrashing. `stop()` and `dispose()` both kill the child — never leave an
 * orphaned Python process holding the GPU.
 *
 * ## Everything is injected
 *
 * `spawn`, the path resolution, the clock, the timers and the logger are all constructor seams,
 * so the unit tests drive the whole state machine — restart backoff included — without a real
 * process. The one test that *does* run the real interpreter is guarded on the venv existing.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'

import { isLikelyHallucination } from '@shared/asr'
import type { AsrLanguage, AsrProviderId, TranscriptSegment } from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'

import type {
  AsrErrorListener,
  AsrProvider,
  AsrSegmentListener,
  AsrStartOptions
} from './AsrProvider'

// ---------------------------------------------------------------------------
// Process seams
// ---------------------------------------------------------------------------

/** The slice of a writable child stdin this file uses. */
export interface WhisperChildStdin {
  /** Returns `false` when the kernel buffer is full — the backpressure signal. */
  write(chunk: Uint8Array): boolean
  end(): void
  on(event: 'drain' | 'error' | 'close', listener: (payload?: unknown) => void): unknown
}

/** The slice of a readable child stream this file uses. */
export interface WhisperChildStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** The slice of `ChildProcess` this file uses. Structural, so a test mock is thirty lines. */
export interface WhisperChild {
  readonly pid?: number | undefined
  readonly stdin: WhisperChildStdin | null
  readonly stdout: WhisperChildStream | null
  readonly stderr: WhisperChildStream | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  /**
   * Terminate the child. Declared with no parameters on purpose.
   *
   * Node types `kill(signal?: NodeJS.Signals | number)`, and a seam that widened that to `string`
   * would not accept a real `ChildProcess` under `strictFunctionTypes`. The default signal is
   * SIGTERM, which is what we want anyway.
   */
  kill(): boolean
}

/** Options passed through to `child_process.spawn`. */
export interface WhisperSpawnOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly windowsHide?: boolean
}

/** The spawn seam. */
export type WhisperSpawn = (
  command: string,
  args: readonly string[],
  options: WhisperSpawnOptions
) => WhisperChild

/**
 * The real spawn.
 *
 * `stdio: 'pipe'` on all three is not optional: stdout carries the protocol, stdin carries the
 * PCM, and stderr carries diagnostics that must go to the log rather than to the operator's
 * console. Inheriting any of them would break the protocol.
 */
export const defaultWhisperSpawn: WhisperSpawn = (command, args, options) =>
  spawn(command, [...args], {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe']
  })

// ---------------------------------------------------------------------------
// Locating the interpreter
// ---------------------------------------------------------------------------

/** Where the sidecar and the interpreter that runs it were found. */
export interface WhisperRuntimePaths {
  /** Absolute path to the Python executable inside the provisioned venv. */
  readonly interpreter: string
  /** Absolute path to `whisper_sidecar.py`. */
  readonly script: string
}

/** Inputs for {@link resolveWhisperRuntime}. Injected so this is testable without Electron. */
export interface ResolveWhisperRuntimeOptions {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean
  /** `process.resourcesPath`. Ignored in development. */
  readonly resourcesPath: string
  /** Directory the running main bundle lives in (`out/main` in both dev and production). */
  readonly moduleDir: string
  /** An explicit repository root to search first. Used when there is no bundle directory yet. */
  readonly repoRoot?: string
  /** `process.platform`. Decides `Scripts/python.exe` versus `bin/python3`. */
  readonly platform?: string
  /** Existence probe. Injected for tests. */
  readonly exists?: (path: string) => boolean
}

/**
 * The venv-relative path of the interpreter, which differs by platform.
 *
 * Windows venvs put the executable in `Scripts/python.exe`; POSIX venvs use `bin/python3`.
 * Getting this wrong produces a "not configured" that looks like a missing venv, which is the
 * most confusing possible way to fail.
 */
function interpreterRelativePath(platform: string): readonly string[] {
  return platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']
}

/**
 * Find the bundled Python venv and the sidecar script.
 *
 * Returns `NOT_CONFIGURED` — never an exception, never a throw — when either is absent. That is
 * a **legitimate resting state**, not a bug: a machine that has never provisioned the venv should
 * run the cloud adapter and show the local one as unavailable, exactly as an empty
 * `DEEPGRAM_API_KEY` makes the cloud adapter unavailable (Standing Rule 5). The error message
 * names the path that was missing, because "not configured" with no path is unactionable.
 */
export function resolveWhisperRuntime(
  options: ResolveWhisperRuntimeOptions
): Result<WhisperRuntimePaths> {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const relative = interpreterRelativePath(platform)

  // In development the repo root is two levels above `out/main`; when packaged, the venv and the
  // script are shipped as unpacked extra resources next to the asar.
  const roots = options.isPackaged
    ? [options.resourcesPath, join(options.moduleDir, '..', '..')]
    : [
        ...(options.repoRoot === undefined ? [] : [options.repoRoot]),
        join(options.moduleDir, '..', '..'),
        join(options.moduleDir, '..', '..', '..')
      ]

  const interpreterCandidates: string[] = []
  const scriptCandidates: string[] = []
  for (const root of roots) {
    interpreterCandidates.push(join(root, 'resources', 'asr-venv', ...relative))
    scriptCandidates.push(join(root, 'resources', 'asr', 'whisper_sidecar.py'))
  }
  if (options.isPackaged) {
    interpreterCandidates.push(join(options.resourcesPath, 'asr-venv', ...relative))
    scriptCandidates.push(join(options.resourcesPath, 'asr', 'whisper_sidecar.py'))
  }

  const interpreter = interpreterCandidates.find((candidate) => exists(candidate))
  if (interpreter === undefined) {
    return err(
      ErrorCode.NOT_CONFIGURED,
      'the local Whisper Python environment is not installed',
      `looked for ${interpreterCandidates[0] ?? 'resources/asr-venv'}`
    )
  }

  const script = scriptCandidates.find((candidate) => exists(candidate))
  if (script === undefined) {
    return err(
      ErrorCode.NOT_CONFIGURED,
      'the local Whisper sidecar script is missing',
      `looked for ${scriptCandidates[0] ?? 'resources/asr/whisper_sidecar.py'}`
    )
  }

  return ok({ interpreter, script })
}

// ---------------------------------------------------------------------------
// Line reassembly — the classic sidecar bug
// ---------------------------------------------------------------------------

/** Largest line we will accumulate before assuming the child is producing garbage. */
export const MAX_SIDECAR_LINE_LENGTH = 1_000_000

/**
 * Reassemble newline-delimited records from arbitrarily-chunked stream data.
 *
 * A pipe delivers bytes, not messages. One `data` event can carry half a JSON object, or three
 * objects and a fragment of a fourth. Feeding `JSON.parse` a raw chunk works in every manual
 * test and then fails in production the first time a transcript is long enough to straddle a
 * 64 KB boundary. This class is the fix, and `WhisperProvider.test.ts` drives it byte by byte.
 *
 * The trailing partial is capped: a child that emits a megabyte with no newline is malfunctioning,
 * and buffering it forever would turn a sidecar bug into a main-process memory leak.
 */
export class LineAssembler {
  private buffer = ''
  private overflows = 0

  constructor(private readonly maxLineLength: number = MAX_SIDECAR_LINE_LENGTH) {}

  /** Feed a chunk of text; get back the complete lines it completed, in order. */
  push(text: string): string[] {
    this.buffer += text
    const lines: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      // Tolerate CRLF: Python's `newline="\n"` reconfigure should prevent it, but a future
      // change on either side must not silently corrupt every message.
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = ''
      this.overflows += 1
    }
    return lines
  }

  /** Emit whatever is left when the stream ends without a trailing newline. */
  flush(): string[] {
    const remainder = this.buffer
    this.buffer = ''
    return remainder.length > 0 ? [remainder] : []
  }

  /** How many times an over-long partial line has been discarded. Surfaced in the log. */
  get overflowCount(): number {
    return this.overflows
  }

  /** Length of the partial line currently held. Exposed for tests and diagnostics. */
  get pendingLength(): number {
    return this.buffer.length
  }
}

// ---------------------------------------------------------------------------
// The sidecar protocol
// ---------------------------------------------------------------------------

/** A `{"type":"segment"}` record, already validated. */
export interface SidecarSegment {
  readonly id: string
  readonly text: string
  readonly isFinal: boolean
  readonly tsStart: number
  readonly tsEnd: number
  readonly confidence: number | null
  readonly isDraft: boolean
}

/** Everything the sidecar can say, after validation. */
export type SidecarMessage =
  | {
      readonly kind: 'ready'
      readonly device: string
      readonly computeType: string
      readonly draftModel: string
      readonly finalModel: string
    }
  | { readonly kind: 'segment'; readonly segment: SidecarSegment }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'bye' }
  | { readonly kind: 'other'; readonly type: string }

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Parse one line of the sidecar's stdout.
 *
 * Returns `null` for anything that is not a well-formed message — a blank line, a Python warning
 * that escaped onto the wrong stream, a truncated object, a segment missing its id. **A malformed
 * line is never fatal.** The caller logs it at debug and reads the next one, because the
 * alternative is a stray `UserWarning` from a transitive dependency ending the operator's
 * transcript mid-service.
 */
export function parseSidecarLine(line: string): SidecarMessage | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>

  const type = record['type']
  if (typeof type !== 'string') return null

  switch (type) {
    case 'ready':
      return {
        kind: 'ready',
        device: readString(record, 'device', 'unknown'),
        computeType: readString(record, 'computeType', 'unknown'),
        draftModel: readString(record, 'draftModel', 'unknown'),
        finalModel: readString(record, 'finalModel', 'unknown')
      }
    case 'error': {
      const message = readString(record, 'message', '')
      return message.length > 0 ? { kind: 'error', message } : null
    }
    case 'bye':
      return { kind: 'bye' }
    case 'segment': {
      const id = record['id']
      const text = record['text']
      const tsStart = readFiniteNumber(record, 'tsStart')
      const tsEnd = readFiniteNumber(record, 'tsEnd')
      if (typeof id !== 'string' || id.length === 0) return null
      if (typeof text !== 'string') return null
      if (tsStart === null || tsEnd === null) return null
      const confidence = readFiniteNumber(record, 'confidence')
      return {
        kind: 'segment',
        segment: {
          id,
          text,
          isFinal: record['isFinal'] === true,
          tsStart,
          tsEnd,
          // A confidence outside [0,1] is a bug somewhere; clamp rather than propagate nonsense.
          confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)),
          isDraft: record['isDraft'] === true
        }
      }
    }
    default:
      return { kind: 'other', type }
  }
}

// ---------------------------------------------------------------------------
// Sidecar configuration
// ---------------------------------------------------------------------------

/** The JSON object written as the first stdin line. Mirrors `Config` in `whisper_sidecar.py`. */
export interface SidecarConfig {
  readonly draftModel: string
  readonly finalModel: string
  readonly language: AsrLanguage
  readonly device: 'auto' | 'cuda' | 'cpu'
  readonly computeType: 'auto' | 'int8' | 'int8_float16' | 'float16' | 'float32'
  readonly customVocabulary: readonly string[]
  readonly draftIntervalMs: number
  readonly finalIntervalMs: number
  readonly maxUtteranceMs: number
  readonly maxVramMb: number
}

/** The draft tier. Fixed at `tiny`: its whole job is to be fast, and anything larger is not. */
export const WHISPER_DRAFT_MODEL = 'tiny'

/**
 * Two-tier cadence, straight from `docs/v2-notes/ASR_PIPELINE.md` §1 — 500 ms draft, 5 s final,
 * and a 30 s hard cap so a VAD that fails to close cannot grow one utterance without bound.
 */
export const WHISPER_DRAFT_INTERVAL_MS = 500
export const WHISPER_FINAL_INTERVAL_MS = 5_000
export const WHISPER_MAX_UTTERANCE_MS = 30_000

/**
 * VRAM budget for the final tier, in MB.
 *
 * 4096 is this machine's GTX 1650. The sidecar downgrades a model that does not fit rather than
 * OOMing, so raising this on a bigger card is the only change needed to run a bigger model.
 */
export const WHISPER_DEFAULT_VRAM_MB = 4_096

/** Build the config line from the session's start options. */
export function buildSidecarConfig(
  options: AsrStartOptions,
  overrides: Partial<SidecarConfig> = {}
): SidecarConfig {
  return {
    draftModel: WHISPER_DRAFT_MODEL,
    finalModel: options.localModel,
    language: options.language,
    device: 'auto',
    computeType: 'auto',
    customVocabulary: [...options.customVocabulary],
    draftIntervalMs: WHISPER_DRAFT_INTERVAL_MS,
    finalIntervalMs: WHISPER_FINAL_INTERVAL_MS,
    maxUtteranceMs: WHISPER_MAX_UTTERANCE_MS,
    maxVramMb: WHISPER_DEFAULT_VRAM_MB,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Restart policy
// ---------------------------------------------------------------------------

/** How the supervisor respawns a dead sidecar. */
export interface WhisperRestartPolicy {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /** Consecutive failures before the provider gives up and reports `failed`. */
  readonly maxAttempts: number
  /** A child that survived this long is considered healthy; the attempt counter resets. */
  readonly healthyAfterMs: number
}

/** The defaults. Fast first retry (a crash mid-sermon should be invisible), then back off. */
export const DEFAULT_WHISPER_RESTART_POLICY: WhisperRestartPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 6,
  healthyAfterMs: 30_000
}

/**
 * Delay before restart attempt `attempt` (0-based).
 *
 * Pure, and deliberately jitter-free: there is exactly one sidecar on one machine, so there is no
 * thundering herd to spread out, and a deterministic sequence is a testable one. Every hostile
 * input produces a finite, non-negative, capped delay — a `NaN` handed to `setTimeout` fires
 * immediately and turns backoff into a spin loop against a machine that is already struggling.
 */
export function whisperRestartDelayMs(
  attempt: number,
  policy: WhisperRestartPolicy = DEFAULT_WHISPER_RESTART_POLICY
): number {
  const base = Number.isFinite(policy.baseDelayMs) ? Math.max(0, policy.baseDelayMs) : 500
  const max = Number.isFinite(policy.maxDelayMs) ? Math.max(base, policy.maxDelayMs) : base
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  const exponent = Math.min(safeAttempt, 30)
  const delay = base * 2 ** exponent
  return Math.min(max, Number.isFinite(delay) ? delay : max)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The provider's own lifecycle.
 *
 * Mapped to {@link import('@shared/asr').AsrState} by the service that owns provider selection:
 * `restarting` is the interesting one — it means "no transcript is arriving right now but one is
 * expected back", which the service surfaces as `degraded` when a fallback exists and as `failed`
 * only once {@link WhisperRestartPolicy.maxAttempts} is spent.
 */
export type WhisperProviderState =
  | 'not-configured'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'restarting'
  | 'failed'

/** What the provider knows about itself. Pushed to subscribers on every change. */
export interface WhisperProviderStatus {
  readonly state: WhisperProviderState
  /** `cuda` or `cpu`, as the sidecar actually resolved it — not as it was requested. */
  readonly device: string | null
  readonly computeType: string | null
  readonly draftModel: string | null
  readonly finalModel: string | null
  readonly lastError: string | null
  /** Epoch ms the current session started. */
  readonly since: number | null
  /** How many times the sidecar has been respawned during this session. */
  readonly restarts: number
  /** Epoch ms the current transcript gap started, or null while transcribing. */
  readonly gapSince: number | null
  /** Audio chunks dropped to stay inside the backpressure budget. */
  readonly droppedChunks: number
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** Constructor seams. Every one has a real default, so production wiring is a bare `new`. */
export interface WhisperProviderOptions {
  readonly spawn?: WhisperSpawn
  /** Resolved once at construction; a failure becomes `not-configured`. */
  readonly paths?: WhisperRuntimePaths
  readonly resolvePaths?: () => Result<WhisperRuntimePaths>
  readonly logger?: Logger
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly restartPolicy?: WhisperRestartPolicy
  /** Bytes of PCM held when the child's stdin is backed up. Default is ~5 s of audio. */
  readonly maxPendingBytes?: number
  /** Milliseconds `stop()` waits for a clean exit before killing. */
  readonly stopGraceMs?: number
  /**
   * Milliseconds `start()` waits for the sidecar's `ready` before resolving anyway.
   *
   * Deliberately shorter than `AsrService`'s own 12 s start deadline. A warm start reaches
   * `ready` in about 3 s and resolves there; a **cold** start is downloading half a gigabyte of
   * model weights from HuggingFace and cannot possibly make any deadline, so rather than let the
   * service time us out and fail over, `start()` resolves `Ok` and readiness is reported on the
   * status instead. Audio pushed in the meantime is queued and trimmed by the same backpressure
   * rule as everything else — a cold start costs the first few seconds of transcript, not the
   * session.
   */
  readonly readyTimeoutMs?: number
  /** Overrides folded into the config line. Used by tests to shrink the model tiers. */
  readonly configOverrides?: Partial<SidecarConfig>
}

/** 5 seconds of 16 kHz mono s16le. Beyond this we drop the oldest audio rather than buffer. */
export const DEFAULT_MAX_PENDING_BYTES = 16_000 * 2 * 5

/** How long `stop()` waits for the child to flush and exit before it kills. */
export const DEFAULT_STOP_GRACE_MS = 3_000

/** How long `start()` waits for `ready` before resolving optimistically. */
export const DEFAULT_READY_TIMEOUT_MS = 8_000

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER
}

/**
 * Spawns, supervises and speaks to the faster-whisper sidecar.
 *
 * Every public method returns a {@link Result} and none of them throw. Every callback handed to a
 * subscriber is wrapped, because a subscriber that throws is a subscriber bug and must not become
 * a main-process crash.
 */
export class WhisperProvider implements AsrProvider {
  private readonly spawnFn: WhisperSpawn
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly policy: WhisperRestartPolicy
  private readonly maxPendingBytes: number
  private readonly stopGraceMs: number
  private readonly readyTimeoutMs: number
  private readonly configOverrides: Partial<SidecarConfig>

  private readonly pathsResult: Result<WhisperRuntimePaths>

  private state: WhisperProviderState
  private device: string | null = null
  private computeType: string | null = null
  private draftModel: string | null = null
  private finalModel: string | null = null
  private lastError: string | null = null
  private sessionStartedAt: number | null = null
  private restarts = 0
  private gapSince: number | null = null
  private droppedChunks = 0

  /** Running means "the operator asked for a transcript", independent of any one child's life. */
  private running = false
  private startOptions: AsrStartOptions | null = null
  private child: WhisperChild | null = null
  private childSpawnedAt = 0
  private attempt = 0
  private restartHandle: unknown = null
  private stopHandle: unknown = null

  /** Bumped on every spawn, and prefixed onto segment ids so restarts cannot collide. */
  private epoch = 0
  private sessionOffsetMs = 0
  private lastDraftId: string | null = null

  private stdout = new LineAssembler()
  private stderrLines = new LineAssembler()
  private readonly decoder = new TextDecoder('utf-8')
  private readonly stderrDecoder = new TextDecoder('utf-8')

  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private canWrite = true

  private readonly segmentSubscribers = new Set<AsrSegmentListener>()
  private readonly errorSubscribers = new Set<AsrErrorListener>()
  private readonly statusSubscribers = new Set<(status: WhisperProviderStatus) => void>()

  /** Resolves the pending `start()` promise. Null when no start is in flight. */
  private pendingStart: ((result: Result<void>) => void) | null = null
  private readyHandle: unknown = null

  constructor(options: WhisperProviderOptions = {}) {
    this.spawnFn = options.spawn ?? defaultWhisperSpawn
    this.log = (options.logger ?? NOOP_LOGGER).child('asr:whisper')
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
    this.policy = options.restartPolicy ?? DEFAULT_WHISPER_RESTART_POLICY
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.configOverrides = options.configOverrides ?? {}

    this.pathsResult =
      options.paths !== undefined
        ? ok(options.paths)
        : (options.resolvePaths ?? defaultResolvePaths)()
    this.state = this.pathsResult.ok ? 'idle' : 'not-configured'
    if (!this.pathsResult.ok) {
      this.lastError = this.pathsResult.error.message
    }
  }

  // -- introspection ----------------------------------------------------

  /** Which engine this is. Stamped onto every segment so a fallback is visible in the UI. */
  getId(): AsrProviderId {
    return 'whisper'
  }

  /**
   * Is the local adapter usable on this machine at all?
   *
   * `false` here is the same class of answer as an empty `DEEPGRAM_API_KEY`: the subsystem
   * reports itself unavailable, the service drops it from the plan, and the app is otherwise
   * unaffected (Standing Rule 5). Cheap and synchronous — it spawns nothing.
   */
  isConfigured(): boolean {
    return this.pathsResult.ok
  }

  /**
   * The resolved interpreter and script, or the `NOT_CONFIGURED` error explaining what is missing.
   *
   * {@link isConfigured} answers the service's yes/no question; this answers the settings panel's
   * "why not, and where did you look?".
   */
  runtimePaths(): Result<WhisperRuntimePaths> {
    return this.pathsResult
  }

  getStatus(): WhisperProviderStatus {
    return {
      state: this.state,
      device: this.device,
      computeType: this.computeType,
      draftModel: this.draftModel,
      finalModel: this.finalModel,
      lastError: this.lastError,
      since: this.sessionStartedAt,
      restarts: this.restarts,
      gapSince: this.gapSince,
      droppedChunks: this.droppedChunks
    }
  }

  onSegment(callback: AsrSegmentListener): Unsubscribe {
    this.segmentSubscribers.add(callback)
    return () => {
      this.segmentSubscribers.delete(callback)
    }
  }

  /**
   * Subscribe to runtime failures.
   *
   * These are what the service's failover policy counts. A single one is not a reason to switch —
   * a sidecar that crashed and came back inside a second cost nobody anything — which is why the
   * provider reports them and the service, not this file, decides what they mean.
   */
  onError(callback: AsrErrorListener): Unsubscribe {
    this.errorSubscribers.add(callback)
    return () => {
      this.errorSubscribers.delete(callback)
    }
  }

  onStatus(callback: (status: WhisperProviderStatus) => void): Unsubscribe {
    this.statusSubscribers.add(callback)
    return () => {
      this.statusSubscribers.delete(callback)
    }
  }

  // -- lifecycle --------------------------------------------------------

  /**
   * Start transcribing.
   *
   * Idempotent: starting an already-running provider is a no-op success, because the operator
   * double-tapping a button must never produce two Python processes fighting over one GPU.
   *
   * Resolves when the sidecar reports `ready`, or after {@link WhisperProviderOptions.readyTimeoutMs}
   * — whichever comes first. It never resolves later than that, and it never rejects.
   */
  start(options: AsrStartOptions): Promise<Result<void>> {
    if (!this.pathsResult.ok) return Promise.resolve(this.pathsResult)
    if (this.running) return Promise.resolve(ok(undefined))

    this.running = true
    this.startOptions = options
    this.restarts = 0
    this.attempt = 0
    this.droppedChunks = 0
    this.sessionStartedAt = this.now()
    this.lastError = null
    this.gapSince = this.now()
    this.setState('starting')

    const spawned = this.spawnChild()
    if (!spawned.ok) {
      return Promise.resolve(spawned)
    }

    return new Promise<Result<void>>((resolve) => {
      this.pendingStart = resolve
      this.readyHandle = this.setTimer(() => {
        this.readyHandle = null
        // Not an error: the sidecar is very probably still downloading model weights. Say so, and
        // let the status carry the truth from here on.
        this.log.info('the local recogniser has not reported ready yet; continuing anyway')
        this.settleStart(ok(undefined))
      }, this.readyTimeoutMs)
    })
  }

  /** Resolve a pending `start()` exactly once, and drop its deadline. */
  private settleStart(result: Result<void>): void {
    if (this.readyHandle !== null) {
      this.clearTimer(this.readyHandle)
      this.readyHandle = null
    }
    const resolve = this.pendingStart
    this.pendingStart = null
    if (resolve !== null) resolve(result)
  }

  /**
   * Stop transcribing and make sure the child is gone.
   *
   * Resolves once the child has exited or the grace period expires — whichever comes first. It
   * never waits indefinitely, because "the operator closed the app" is not a moment to block on
   * a Python process that has decided to hang.
   */
  stop(): Promise<Result<void>> {
    this.running = false
    this.startOptions = null
    this.cancelRestart()
    this.settleStart(ok(undefined))

    const child = this.child
    if (child === null) {
      this.resetSessionState()
      this.setState(this.pathsResult.ok ? 'idle' : 'not-configured')
      return Promise.resolve(ok(undefined))
    }

    return new Promise<Result<void>>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        if (this.stopHandle !== null) {
          this.clearTimer(this.stopHandle)
          this.stopHandle = null
        }
        this.killChild(child)
        this.child = null
        this.resetSessionState()
        this.setState(this.pathsResult.ok ? 'idle' : 'not-configured')
        resolve(ok(undefined))
      }

      // Closing stdin is what makes the sidecar flush its last partial utterance and exit
      // cleanly; the kill below is the guarantee that it goes away even if it does not.
      try {
        child.stdin?.end()
      } catch (cause) {
        this.log.debug('closing sidecar stdin failed', { detail: String(cause) })
      }
      child.on('exit', () => {
        finish()
      })
      this.stopHandle = this.setTimer(() => {
        this.log.warn('sidecar did not exit within the grace period; killing it')
        finish()
      }, this.stopGraceMs)
    })
  }

  /**
   * Tear down completely. Safe to call from `app.on('will-quit')`.
   *
   * The whole point is the last line: never leave an orphaned Python process holding the GPU.
   */
  dispose(): void {
    this.running = false
    this.cancelRestart()
    this.settleStart(ok(undefined))
    if (this.stopHandle !== null) {
      this.clearTimer(this.stopHandle)
      this.stopHandle = null
    }
    if (this.child !== null) {
      this.killChild(this.child)
      this.child = null
    }
    this.segmentSubscribers.clear()
    this.errorSubscribers.clear()
    this.statusSubscribers.clear()
    this.resetSessionState()
  }

  // -- audio ------------------------------------------------------------

  /**
   * Hand one PCM chunk to the sidecar. 16 kHz mono s16le, per `@shared/asr`.
   *
   * **Backpressure drops the oldest audio, not the newest.** If the child's stdin cannot keep up
   * — a CPU-only final pass on a slow machine, a child mid-restart — the queue is trimmed from
   * the front. Buffering without bound would trade a few lost seconds for an out-of-memory crash
   * during the sermon, and dropping the *newest* would make the transcript permanently lag the
   * preacher instead of skipping and catching up.
   */
  pushAudio(chunk: Uint8Array): Result<void> {
    if (!this.running) return err(ErrorCode.NOT_CONNECTED, 'the local recogniser is not running')
    if (chunk.byteLength === 0) return ok(undefined)

    this.pending.push(chunk)
    this.pendingBytes += chunk.byteLength
    while (this.pendingBytes > this.maxPendingBytes && this.pending.length > 0) {
      const oldest = this.pending.shift()
      if (oldest === undefined) break
      this.pendingBytes -= oldest.byteLength
      this.droppedChunks += 1
    }
    this.flushPending()
    return ok(undefined)
  }

  private flushPending(): void {
    const stdin = this.child?.stdin
    if (stdin === null || stdin === undefined) return
    while (this.canWrite && this.pending.length > 0) {
      const chunk = this.pending.shift()
      if (chunk === undefined) break
      this.pendingBytes -= chunk.byteLength
      try {
        this.canWrite = stdin.write(chunk)
      } catch (cause) {
        // EPIPE: the child died between the exit event and this write. Supervision handles it.
        this.log.debug('writing audio to the sidecar failed', { detail: String(cause) })
        this.canWrite = false
        return
      }
    }
  }

  // -- the child --------------------------------------------------------

  private spawnChild(): Result<void> {
    if (!this.pathsResult.ok) return this.pathsResult
    const startOptions = this.startOptions
    if (startOptions === null) {
      return err(ErrorCode.INVALID_ARG, 'no ASR start options for this session')
    }

    const { interpreter, script } = this.pathsResult.value
    let child: WhisperChild
    try {
      // `-u` is not optional: without unbuffered stdio, Python holds the first several KB of the
      // protocol stream in its own buffer and the first transcript arrives minutes late.
      child = this.spawnFn(interpreter, ['-u', script], { windowsHide: true })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.lastError = message
      this.log.error('could not spawn the Whisper sidecar', { detail: message })
      this.scheduleRestart()
      return err(ErrorCode.INTERNAL, 'could not start the local recogniser', message)
    }

    this.child = child
    this.childSpawnedAt = this.now()
    this.epoch += 1
    this.stdout = new LineAssembler()
    this.stderrLines = new LineAssembler()
    this.canWrite = true
    this.lastDraftId = null

    child.stdout?.on('data', (chunk) => {
      this.handleStdout(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      this.handleStderr(chunk)
    })
    child.stdin?.on('drain', () => {
      this.canWrite = true
      this.flushPending()
    })
    child.stdin?.on('error', (cause) => {
      this.canWrite = false
      this.log.debug('sidecar stdin error', { detail: String(cause) })
    })
    child.on('error', (error) => {
      this.lastError = error.message
      this.log.error('sidecar process error', { detail: error.message })
    })
    child.on('exit', (code, signal) => {
      this.handleExit(child, code, signal)
    })

    const config = buildSidecarConfig(startOptions, this.configOverrides)
    try {
      const line = `${JSON.stringify(config)}\n`
      child.stdin?.write(new TextEncoder().encode(line))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.log.error('could not write the sidecar config line', { detail: message })
      this.killChild(child)
      return err(ErrorCode.INTERNAL, 'could not configure the local recogniser', message)
    }

    // Vocabulary TERMS are logged nowhere — only the count. They are the pastor's name and the
    // church's name, and a rolling log file is not the place for them.
    this.log.info('whisper sidecar spawned', {
      pid: child.pid ?? null,
      finalModel: config.finalModel,
      draftModel: config.draftModel,
      language: config.language,
      vocabularyTerms: config.customVocabulary.length
    })
    this.setState('starting')
    return ok(undefined)
  }

  private handleStdout(chunk: unknown): void {
    // Decoded in streaming mode: a Korean transcript split across two chunks mid-codepoint would
    // otherwise arrive with a replacement character wedged into the middle of a word.
    for (const line of this.stdout.push(this.toText(chunk, this.decoder))) {
      this.handleLine(line)
    }
  }

  private handleStderr(chunk: unknown): void {
    for (const line of this.stderrLines.push(this.toText(chunk, this.stderrDecoder))) {
      if (line.trim().length > 0) this.log.debug('sidecar', { line })
    }
  }

  private toText(chunk: unknown, decoder: TextDecoder): string {
    if (typeof chunk === 'string') return chunk
    if (chunk instanceof Uint8Array) return decoder.decode(chunk, { stream: true })
    if (chunk instanceof ArrayBuffer) return decoder.decode(new Uint8Array(chunk), { stream: true })
    return String(chunk)
  }

  private handleLine(line: string): void {
    const message = parseSidecarLine(line)
    if (message === null) {
      // Not fatal, and deliberately not a warning: a dependency's UserWarning on the wrong stream
      // is the common case, and warning on every one of them would bury the real failures.
      if (line.trim().length > 0) this.log.debug('unparseable sidecar line ignored')
      return
    }

    switch (message.kind) {
      case 'ready': {
        this.device = message.device
        this.computeType = message.computeType
        this.draftModel = message.draftModel
        this.finalModel = message.finalModel
        this.gapSince = null
        this.sessionOffsetMs = Math.max(0, this.now() - (this.sessionStartedAt ?? this.now()))
        this.log.info('whisper sidecar ready', {
          device: message.device,
          computeType: message.computeType,
          draftModel: message.draftModel,
          finalModel: message.finalModel
        })
        this.setState('listening')
        this.settleStart(ok(undefined))
        this.flushPending()
        return
      }
      case 'segment':
        this.emitSegment(message.segment)
        return
      case 'error':
        this.lastError = message.message
        this.log.warn('whisper sidecar reported an error', { detail: message.message })
        this.publishStatus()
        this.emitError({
          code: ErrorCode.INTERNAL,
          message: 'the local recogniser reported a failure',
          detail: message.message
        })
        return
      case 'bye':
      case 'other':
        return
      default:
        return
    }
  }

  /**
   * Turn a sidecar segment into a {@link TranscriptSegment} and publish it.
   *
   * Two things happen here that the sidecar cannot do for itself:
   *
   * 1. **Epoch-prefixed ids.** The child numbers segments from zero; after a restart it does so
   *    again. Without the prefix, `w3` from the new child would *replace* `w3` from the old one
   *    in a consumer keyed on id, silently rewriting transcript the operator already read.
   * 2. **Hallucination filtering** (`isLikelyHallucination`, `@shared/asr`). Whisper emits
   *    "thank you for watching" and friends when fed silence, and a phrase like that could match
   *    a hot-phrase and fire a cue during a silent prayer. A filtered *draft* is dropped; a
   *    filtered *final* is emitted with empty text when a draft went out under the same id, so
   *    the consumer clears it instead of being left showing a partial that never gets corrected.
   */
  private emitSegment(segment: SidecarSegment): void {
    const id = `w${this.epoch}-${segment.id}`
    const hallucinated = isLikelyHallucination(segment.text)

    if (hallucinated && !segment.isFinal) {
      this.log.debug('dropped a hallucinated draft')
      return
    }
    if (hallucinated && segment.isFinal && this.lastDraftId !== id) {
      this.log.debug('dropped a hallucinated final')
      this.lastDraftId = null
      return
    }

    const text = hallucinated ? '' : segment.text
    const transcript: TranscriptSegment = {
      id,
      text,
      isFinal: segment.isFinal,
      tsStart: Math.round(segment.tsStart + this.sessionOffsetMs),
      tsEnd: Math.round(segment.tsEnd + this.sessionOffsetMs),
      confidence: segment.confidence,
      provider: 'whisper',
      isDraft: segment.isDraft
    }

    this.lastDraftId = segment.isFinal ? null : id
    if (this.state !== 'listening') this.setState('listening')
    this.gapSince = null

    for (const subscriber of [...this.segmentSubscribers]) {
      try {
        subscriber(transcript)
      } catch (cause) {
        this.log.error('a transcript subscriber threw', { detail: String(cause) })
      }
    }
  }

  private handleExit(child: WhisperChild, code: number | null, signal: string | null): void {
    if (this.child !== child) return
    this.child = null
    this.canWrite = false

    if (!this.running) return

    const lived = this.now() - this.childSpawnedAt
    if (lived >= this.policy.healthyAfterMs) {
      // It ran a full service's worth before dying — treat this as the first failure, not the
      // seventh. Otherwise six crashes spread across three months would retire the adapter.
      this.attempt = 0
    }
    this.restarts += 1
    this.gapSince = this.now()
    this.lastError = `the local recogniser exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    this.log.warn('whisper sidecar exited unexpectedly', {
      code,
      signal,
      livedMs: lived,
      restarts: this.restarts
    })
    this.emitError({
      code: ErrorCode.NOT_CONNECTED,
      message: 'the local recogniser stopped unexpectedly',
      detail: this.lastError
    })
    this.scheduleRestart()
  }

  /** Publish a runtime failure. Wrapped, because a throwing subscriber is not our crash to take. */
  private emitError(error: AppError): void {
    for (const subscriber of [...this.errorSubscribers]) {
      try {
        subscriber(error)
      } catch (cause) {
        this.log.error('an ASR error subscriber threw', { detail: String(cause) })
      }
    }
  }

  private scheduleRestart(): void {
    if (!this.running) return
    if (this.attempt >= this.policy.maxAttempts) {
      this.log.error('giving up on the local recogniser after repeated failures', {
        attempts: this.attempt
      })
      this.setState('failed')
      this.settleStart(
        err(ErrorCode.INTERNAL, 'the local recogniser could not be started', this.lastError ?? '')
      )
      return
    }

    const delay = whisperRestartDelayMs(this.attempt, this.policy)
    this.attempt += 1
    this.setState('restarting')
    this.log.info('restarting the whisper sidecar', { attempt: this.attempt, delayMs: delay })
    this.cancelRestart()
    this.restartHandle = this.setTimer(() => {
      this.restartHandle = null
      if (!this.running) return
      this.spawnChild()
    }, delay)
  }

  private cancelRestart(): void {
    if (this.restartHandle !== null) {
      this.clearTimer(this.restartHandle)
      this.restartHandle = null
    }
  }

  private killChild(child: WhisperChild): void {
    try {
      child.kill()
    } catch (cause) {
      this.log.debug('killing the sidecar failed', { detail: String(cause) })
    }
  }

  private resetSessionState(): void {
    this.pending = []
    this.pendingBytes = 0
    this.canWrite = true
    this.gapSince = null
    this.sessionStartedAt = null
    this.device = null
    this.computeType = null
    this.draftModel = null
    this.finalModel = null
    this.lastDraftId = null
  }

  private setState(next: WhisperProviderState): void {
    if (this.state === next) {
      this.publishStatus()
      return
    }
    this.state = next
    this.publishStatus()
  }

  private publishStatus(): void {
    const status = this.getStatus()
    for (const subscriber of [...this.statusSubscribers]) {
      try {
        subscriber(status)
      } catch (cause) {
        this.log.error('a status subscriber threw', { detail: String(cause) })
      }
    }
  }
}

/**
 * Production path resolution.
 *
 * Kept out of the class so the class never imports Electron; `index.ts` may pass a different
 * resolver built from the real `app.isPackaged` and `process.resourcesPath`. The default here
 * works in a plain Node process, which is what the tests and `--selftest` runs need.
 */
function defaultResolvePaths(): Result<WhisperRuntimePaths> {
  return resolveWhisperRuntime({
    isPackaged: false,
    resourcesPath: '',
    moduleDir: join(process.cwd(), 'out', 'main'),
    repoRoot: process.cwd()
  })
}
