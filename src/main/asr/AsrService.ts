/**
 * `AsrService` — the session manager: settings, the active provider, and the fallback policy.
 *
 * This is the only place that decides *which* recogniser is listening. The adapters know how to
 * talk to Deepgram and to faster-whisper; they know nothing about each other, about the operator's
 * preference, or about what to do when one of them dies. That all lives here, once, so it can be
 * proved by tests that need neither an API key nor a GPU.
 *
 * ## Selection
 *
 * | mode    | preference order          |
 * |---------|---------------------------|
 * | `cloud` | Deepgram only             |
 * | `local` | faster-whisper only       |
 * | `auto`  | Deepgram, then whisper    |
 *
 * A provider that reports `isConfigured() === false` is dropped from the plan before anything is
 * attempted — an empty `DEEPGRAM_API_KEY` is a resting state, not a failure (Standing Rule 5). If
 * that empties the plan, the service reports `not-configured` and `start()` returns an `Err` the
 * settings panel can render. It never throws, and the rest of the app is unaffected.
 *
 * ## `degraded` is not `failed`
 *
 * `degraded` means a transcript is still arriving, just not from the preferred engine — Deepgram
 * dropped and the local model took over. `failed` means no transcript at all and the operator is
 * on their own. Collapsing the two would hide a fallback the operator needs to know about, so they
 * stay distinct all the way to the status light. Note the deliberate asymmetry: falling back
 * because the preferred provider *failed* is `degraded`; running on the local model in `auto` mode
 * because no cloud key was ever configured is plain `listening` — nothing broke, and a permanent
 * amber light teaches the operator to ignore amber lights.
 *
 * ## Failover is debounced and one-way, on purpose
 *
 * A single transient error must never move the transcript to another engine. Deepgram's websocket
 * hiccups; a chunk gets rejected; a sidecar misses a deadline. Switching on the first one would
 * thrash mid-sermon, and every switch costs a re-connect and a gap. So a switch needs
 * {@link DEFAULT_FAILURE_THRESHOLD} errors inside {@link DEFAULT_ERROR_WINDOW_MS}, and any
 * successful segment clears the streak.
 *
 * It is also one-way *within a session*: once we have fallen back to the local model we stay
 * there until the operator stops and starts again, even if the network returns. An operator
 * watching the provider label flip every few seconds mid-sermon is worse off than one reading a
 * stable "running local" — and the local transcript is good, not broken.
 *
 * ## Nothing throws, ever
 *
 * Every method returns a {@link Result}. Every seam — both providers, both persistence functions,
 * every subscriber callback, the clock, the timers — is wrapped, because all of them cross a
 * boundary this class does not own, and an exception escaping into the main process would take
 * the booth UI down with it while the service is live.
 */

import { asrSettingsSchema, defaultAsrSettings, isLikelyHallucination } from '@shared/asr'
import type {
  AsrProviderId,
  AsrSettings,
  AsrState,
  AsrStatus,
  AudioInputDevice,
  TranscriptSegment,
} from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { AppError, Result } from '@shared/result'

import { asrProviderLabel } from './AsrProvider'
import type { AsrProvider, AsrStartOptions } from './AsrProvider'

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Consecutive errors required before the service abandons a provider.
 *
 * Three, not one. One error is a hiccup; three inside the window is a pattern. Chosen against the
 * cost of being wrong in each direction: switching too eagerly costs a re-connect and a gap in
 * the transcript every time the network stutters, whereas switching one error late costs a
 * fraction of a sentence.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3

/**
 * How long an error stays on the books.
 *
 * Three errors spread over ten minutes is a flaky afternoon, not a dead provider. Only three
 * inside this window count as one.
 */
export const DEFAULT_ERROR_WINDOW_MS = 15_000

/**
 * Deadline on a provider's `start()`.
 *
 * A live service must never hang on us. A cloud adapter waiting forever on a socket that will
 * never open, or a sidecar waiting on a model download, has to become "fall back to the other
 * one" rather than "the ASR panel spins until the sermon ends".
 */
export const DEFAULT_START_TIMEOUT_MS = 12_000

/** Latency samples retained for the median. Enough to be stable, small enough to stay current. */
const MAX_LATENCY_SAMPLES = 200

/** Span ids remembered for latency and draft bookkeeping, before the bookkeeping is reset. */
const MAX_TRACKED_SPANS = 1_000

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of `AppConfig` this service reads.
 *
 * Deliberately one field, and it is read exactly once — at construction, and only to record
 * *whether* a key exists. The value itself is never retained, never logged and never passed on;
 * the Deepgram adapter takes the key directly from config. This slice exists so the "why is it
 * not configured" message can name `DEEPGRAM_API_KEY` without the service ever holding it.
 */
export interface AsrConfigLike {
  readonly deepgramApiKey: string | null
}

/** Opaque handle returned by {@link AsrTimers.setTimeout}. */
export type AsrTimerHandle = ReturnType<typeof setTimeout> | number

/** The timer surface, injected so start deadlines are driven by fake timers in tests. */
export interface AsrTimers {
  setTimeout(handler: () => void, delayMs: number): AsrTimerHandle
  clearTimeout(handle: AsrTimerHandle): void
}

/**
 * The real timers.
 *
 * Wrapped in arrow functions rather than referenced directly, so a test that installs fake timers
 * after importing this module still intercepts them.
 */
export const realAsrTimers: AsrTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  },
}

/** Write the settings somewhere durable. Returns a {@link Result}; must not throw. */
export type AsrSettingsWriter = (settings: AsrSettings) => Result<void>

/**
 * Read the settings back.
 *
 * `ok(null)` means "nothing saved yet", which is a resting state and not a failure — a first run
 * lands on {@link defaultAsrSettings}.
 */
export type AsrSettingsReader = () => Result<AsrSettings | null>

/** Constructor dependencies. Only `config`, `logger` and `providers` are required. */
export interface AsrServiceOptions {
  readonly config: AsrConfigLike
  readonly logger: Logger
  /**
   * Every recogniser this build knows about, in no particular order — the *mode* fixes the
   * preference, not the array. Providers are matched by `getId()`; a duplicate id is ignored.
   * An empty array is legal and yields `not-configured`.
   */
  readonly providers: readonly AsrProvider[]
  /** Clock seam. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Timer seam. Defaults to {@link realAsrTimers}. */
  readonly timers?: AsrTimers
  /** Called after every accepted `setSettings`. Omitted: settings live for the session only. */
  readonly persist?: AsrSettingsWriter
  /** Called once, at construction. Omitted: start from {@link defaultAsrSettings}. */
  readonly load?: AsrSettingsReader
  /** Override the failover threshold. Production uses {@link DEFAULT_FAILURE_THRESHOLD}. */
  readonly failureThreshold?: number
  /** Override the failover window. Production uses {@link DEFAULT_ERROR_WINDOW_MS}. */
  readonly errorWindowMs?: number
  /** Override the start deadline. Production uses {@link DEFAULT_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class AsrService {
  private readonly log: Logger
  private readonly providers: readonly AsrProvider[]
  private readonly now: () => number
  private readonly timers: AsrTimers
  private readonly persist: AsrSettingsWriter | null
  private readonly failureThreshold: number
  private readonly errorWindowMs: number
  private readonly startTimeoutMs: number

  /** Whether `.env` carried a Deepgram key. The key itself is never held here. */
  private readonly cloudKeyPresent: boolean

  private readonly statusSubscribers = new Set<(status: AsrStatus) => void>()
  private readonly transcriptSubscribers = new Set<(segment: TranscriptSegment) => void>()

  private settings: AsrSettings
  private devices: readonly AudioInputDevice[] = []

  /** Explicit lifecycle. `idle`/`not-configured` are recomputed on read; the rest are sticky. */
  private state: AsrState = 'idle'
  private active: AsrProvider | null = null
  private sessionPlan: readonly AsrProvider[] = []
  private planIndex = -1
  private sessionStartedAt: number | null = null
  private lastError: string | null = null

  private unsubscribeSegment: Unsubscribe | null = null
  private unsubscribeError: Unsubscribe | null = null

  /** Epoch-ms of recent provider errors, pruned to {@link errorWindowMs}. */
  private errorTimestamps: number[] = []

  /** Start of the current un-answered speech span, for the latency median. */
  private pendingSpanStartedAt: number | null = null
  private latencySamples: number[] = []
  private seenSpanIds = new Set<string>()
  /** Spans for which a partial has already reached consumers, so a bad final can retract it. */
  private publishedSpanIds = new Set<string>()

  private lastEmitted: AsrStatus
  private disposed = false

  constructor(options: AsrServiceOptions) {
    this.log = options.logger.child('asr')
    this.providers = dedupeProviders(options.providers)
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realAsrTimers
    this.persist = options.persist ?? null
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
    this.errorWindowMs = Math.max(0, options.errorWindowMs ?? DEFAULT_ERROR_WINDOW_MS)
    this.startTimeoutMs = Math.max(1, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    this.cloudKeyPresent = options.config.deepgramApiKey !== null
    this.settings = this.readStoredSettings(options.load)
    this.lastEmitted = this.snapshot()
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** The current settings. Always succeeds — a missing file yields the defaults. */
  getSettings(): Result<AsrSettings> {
    return ok(this.settings)
  }

  /**
   * Replace the settings.
   *
   * Validated with `asrSettingsSchema` even though the caller is typed, because this is a trust
   * boundary: by the time a payload lands here it has crossed IPC from the renderer.
   *
   * Changes take effect at the **next** `start()`, not immediately. Re-opening the recogniser
   * mid-sermon to apply a new keyword costs a gap in the transcript, and the operator who edits
   * the vocabulary list during a service is not asking for the transcript to stutter. The one
   * exception is cosmetic: the device label in the status readout updates at once.
   *
   * A persistence failure is reported but does not roll the settings back — settings that work
   * until the app restarts beat no settings at all.
   */
  setSettings(settings: AsrSettings): Result<AsrSettings> {
    const parsed = asrSettingsSchema.safeParse(settings)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      this.log.warn('rejected invalid ASR settings', { detail })
      return err(ErrorCode.INVALID_ARG, 'the ASR settings are invalid', detail)
    }

    const next: AsrSettings = {
      mode: parsed.data.mode,
      language: parsed.data.language,
      deviceId: parsed.data.deviceId,
      customVocabulary: parsed.data.customVocabulary,
      localModel: parsed.data.localModel,
    }
    const wasRunning = this.isRunning()
    this.settings = next
    this.publishStatus()

    if (wasRunning) {
      this.log.info('ASR settings changed; they apply at the next start', { mode: next.mode })
    }

    const written = this.writeSettings(next)
    if (!written.ok) return { ok: false, error: written.error }

    // Vocabulary terms are the operator's own words (a pastor's name, a hymn title) — the count
    // is the useful diagnostic, and logging the list itself would put service content in a file.
    this.log.info('ASR settings updated', {
      mode: next.mode,
      language: next.language,
      localModel: next.localModel,
      vocabularyTerms: next.customVocabulary.length,
    })
    return ok(next)
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** The live ASR status. Always succeeds. */
  getStatus(): Result<AsrStatus> {
    return ok(this.snapshot())
  }

  /** Subscribe to status changes. Fires only when something observable actually changed. */
  onStatus(callback: (status: AsrStatus) => void): Unsubscribe {
    this.statusSubscribers.add(callback)
    return () => {
      this.statusSubscribers.delete(callback)
    }
  }

  /** Subscribe to transcript fragments. Replace by `id`; append only on `isFinal`. */
  onTranscript(callback: (segment: TranscriptSegment) => void): Unsubscribe {
    this.transcriptSubscribers.add(callback)
    return () => {
      this.transcriptSubscribers.delete(callback)
    }
  }

  /**
   * Record the input devices the renderer enumerated.
   *
   * Only the renderer can call `enumerateDevices()`, so the main process learns the list by being
   * told. Used for the device label in the status; never to open anything.
   */
  listDevices(devices: readonly AudioInputDevice[]): Result<void> {
    const clean = devices.filter(
      (device) => typeof device.deviceId === 'string' && typeof device.label === 'string'
    )
    this.devices = clean.map((device) => ({ deviceId: device.deviceId, label: device.label }))
    this.publishStatus()
    return ok(undefined)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a recognition session.
   *
   * Idempotent while running: a second press of LISTEN returns the current status rather than
   * tearing down a working transcript.
   *
   * The returned `Err` is the whole error contract for the UI — `NOT_CONFIGURED` when nothing is
   * available to run (the settings panel says so and offers the key), `INTERNAL` when every
   * candidate refused. In both cases the app keeps running and the operator runs manual.
   */
  async start(): Promise<Result<AsrStatus>> {
    if (this.disposed) {
      return err(ErrorCode.INTERNAL, 'the ASR service has been disposed')
    }
    if (this.isRunning() || this.state === 'starting') {
      return ok(this.snapshot())
    }

    const plan = this.usablePlan()
    if (plan.length === 0) {
      this.state = 'not-configured'
      this.lastError = null
      this.publishStatus()
      return err(
        ErrorCode.NOT_CONFIGURED,
        'no speech recogniser is available',
        this.notConfiguredDetail()
      )
    }

    this.resetSessionBookkeeping()
    this.sessionPlan = plan
    this.planIndex = -1
    this.lastError = null
    this.state = 'starting'
    this.sessionStartedAt = this.now()
    this.publishStatus()

    return this.activateFrom(0, null)
  }

  /**
   * Close the session.
   *
   * Always succeeds from the caller's point of view. A provider that refuses to stop is logged
   * and then let go of anyway — refusing to release a dead recogniser would strand the operator
   * on it, and the whole point of this subsystem is that it can be abandoned safely.
   *
   * `lastError` survives a stop, so the operator can still read why the last session ended.
   */
  async stop(): Promise<Result<AsrStatus>> {
    const active = this.detachActive()
    this.state = 'idle'
    this.sessionPlan = []
    this.planIndex = -1
    this.sessionStartedAt = null
    this.resetSessionBookkeeping()
    this.publishStatus()

    if (active !== null) await this.stopProvider(active)
    this.publishStatus()
    return ok(this.snapshot())
  }

  /**
   * Hand one PCM chunk to the active recogniser.
   *
   * Called ~10× a second for the length of a service, so it is deliberately cheap and deliberately
   * infallible:
   *
   *  - with no active provider it is a silent no-op. Audio that arrives before `start()` or after
   *    `stop()` is dropped rather than buffered — a transcript of the ten seconds before the
   *    operator pressed LISTEN is not worth the memory;
   *  - it always returns `ok`. Returning an `Err` ten times a second would fill the log and the
   *    IPC channel with noise the operator can do nothing about. Real trouble surfaces through
   *    the provider's error channel and the status light;
   *  - a provider that throws is caught and counted toward the failover streak, never propagated.
   */
  pushAudio(chunk: Uint8Array): Result<void> {
    const active = this.active
    if (active === null) return ok(undefined)

    // The clock starts on the first chunk that is not already waiting on a partial; the next new
    // span id stops it. That is the latency the operator actually perceives: speech in, text out.
    if (this.pendingSpanStartedAt === null) this.pendingSpanStartedAt = this.now()

    try {
      active.pushAudio(chunk)
    } catch (cause) {
      const error = toAppError(cause)
      this.log.warn('the recogniser threw while accepting audio', {
        provider: active.getId(),
        detail: error.message,
      })
      this.recordProviderError(active, error)
    }
    return ok(undefined)
  }

  /** Stop, detach every subscriber, and refuse to start again. Idempotent. */
  dispose(): Result<void> {
    if (this.disposed) return ok(undefined)
    this.disposed = true
    const active = this.detachActive()
    this.state = 'idle'
    this.statusSubscribers.clear()
    this.transcriptSubscribers.clear()
    if (active !== null) void this.stopProvider(active)
    return ok(undefined)
  }

  // -------------------------------------------------------------------------
  // Provider selection
  // -------------------------------------------------------------------------

  /** Preference order for the current mode, existence-filtered but not configuration-filtered. */
  private preferenceOrder(): readonly AsrProviderId[] {
    switch (this.settings.mode) {
      case 'cloud':
        return ['deepgram']
      case 'local':
        return ['whisper']
      case 'auto':
        // Cloud first: it is better at Korean and lower latency. The local model exists precisely
        // for the moment the network — the thing already carrying the stream — is what broke.
        return ['deepgram', 'whisper']
    }
  }

  /** The providers that could actually run right now, in preference order. */
  private usablePlan(): readonly AsrProvider[] {
    const plan: AsrProvider[] = []
    for (const id of this.preferenceOrder()) {
      const provider = this.providers.find((candidate) => candidate.getId() === id)
      if (provider === undefined) continue
      if (!this.isConfigured(provider)) continue
      plan.push(provider)
    }
    return plan
  }

  /** `isConfigured()` with the boundary wrapped: a throwing provider is simply unavailable. */
  private isConfigured(provider: AsrProvider): boolean {
    try {
      return provider.isConfigured()
    } catch (cause) {
      this.log.warn('a recogniser threw while reporting its configuration', { cause })
      return false
    }
  }

  /** Plain-English reason for `not-configured`, naming keys but never values. */
  private notConfiguredDetail(): string {
    switch (this.settings.mode) {
      case 'cloud':
        return this.cloudKeyPresent
          ? 'the Deepgram adapter is unavailable'
          : 'DEEPGRAM_API_KEY is empty; add it to .env or switch ASR to Local'
      case 'local':
        return 'the local faster-whisper sidecar is unavailable on this machine'
      case 'auto':
        return this.cloudKeyPresent
          ? 'neither Deepgram nor the local faster-whisper sidecar is available'
          : 'DEEPGRAM_API_KEY is empty and the local faster-whisper sidecar is unavailable'
    }
  }

  // -------------------------------------------------------------------------
  // Activation and failover
  // -------------------------------------------------------------------------

  /**
   * Walk the plan from `index` until one provider starts.
   *
   * `priorFailure` is non-null when we got here because something already failed — which is
   * exactly the difference between `listening` and `degraded`.
   */
  private async activateFrom(
    index: number,
    priorFailure: string | null
  ): Promise<Result<AsrStatus>> {
    let failure = priorFailure

    for (let i = index; i < this.sessionPlan.length; i += 1) {
      const provider = this.sessionPlan[i]
      if (provider === undefined) continue
      if (this.disposed) break

      const started = await this.startProvider(provider)
      if (this.disposed) {
        if (started.ok) void this.stopProvider(provider)
        break
      }

      if (started.ok) {
        this.planIndex = i
        this.active = provider
        this.attachActive(provider)
        this.errorTimestamps = []
        this.state = failure === null ? 'listening' : 'degraded'
        this.lastError = failure
        this.sessionStartedAt ??= this.now()
        this.publishStatus()
        this.log.info('ASR session started', {
          provider: provider.getId(),
          state: this.state,
          language: this.settings.language,
        })
        return ok(this.snapshot())
      }

      failure = `${asrProviderLabel(provider.getId())} could not start: ${started.error.message}`
      this.log.warn('a recogniser refused to start', {
        provider: provider.getId(),
        detail: started.error.message,
      })
    }

    // Nothing left to try. Standing Rule 1: this is a red light and silence, not a crash — the
    // operator carries on manually and every other subsystem is untouched.
    this.active = null
    this.state = 'failed'
    this.lastError = failure
    this.sessionStartedAt = null
    this.publishStatus()
    this.log.error('no speech recogniser could be started; running manual', {
      detail: failure ?? 'unknown',
    })
    return err(
      ErrorCode.INTERNAL,
      'no speech recogniser could be started',
      failure ?? 'unknown failure'
    )
  }

  /**
   * `provider.start()` with a deadline and every failure mode flattened to a `Result`.
   *
   * A rejected promise, a synchronous throw, and never resolving at all are all the same thing to
   * the caller: this provider did not start, try the next one.
   */
  private startProvider(provider: AsrProvider): Promise<Result<void>> {
    const options: AsrStartOptions = {
      language: this.settings.language,
      customVocabulary: this.settings.customVocabulary,
      localModel: this.settings.localModel,
      deviceId: this.settings.deviceId,
    }

    return new Promise<Result<void>>((resolve) => {
      let settled = false
      const handle = this.timers.setTimeout(() => {
        if (settled) return
        settled = true
        resolve(
          err(
            ErrorCode.TIMEOUT,
            `it did not become ready within ${String(this.startTimeoutMs)} ms`
          )
        )
      }, this.startTimeoutMs)

      const finish = (result: Result<void>): void => {
        if (settled) return
        settled = true
        try {
          this.timers.clearTimeout(handle)
        } catch {
          /* best effort — a timer seam that throws must not sink the session */
        }
        resolve(result)
      }

      try {
        void provider.start(options).then(finish, (cause: unknown) => {
          finish({ ok: false, error: toAppError(cause) })
        })
      } catch (cause) {
        finish({ ok: false, error: toAppError(cause) })
      }
    })
  }

  /** `provider.stop()`, best effort. Never rejects, never reports outward. */
  private async stopProvider(provider: AsrProvider): Promise<void> {
    try {
      const stopped = await provider.stop()
      if (!stopped.ok) {
        this.log.warn('a recogniser reported an error while stopping', {
          provider: provider.getId(),
          detail: stopped.error.message,
        })
      }
    } catch (cause) {
      this.log.warn('a recogniser threw while stopping', { provider: provider.getId(), cause })
    }
  }

  private attachActive(provider: AsrProvider): void {
    try {
      this.unsubscribeSegment = provider.onSegment((segment) => {
        this.handleSegment(provider, segment)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to transcript segments', { cause })
    }
    try {
      this.unsubscribeError = provider.onError((error) => {
        this.recordProviderError(provider, error)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to recogniser errors', { cause })
    }
  }

  /** Detach subscriptions and return the provider that was active, if any. */
  private detachActive(): AsrProvider | null {
    runQuietly(this.unsubscribeSegment)
    runQuietly(this.unsubscribeError)
    this.unsubscribeSegment = null
    this.unsubscribeError = null
    const active = this.active
    this.active = null
    return active
  }

  /**
   * Count one runtime error and fail over if the streak crosses the threshold.
   *
   * The debounce lives here and nowhere else, so cloud websocket errors, sidecar crashes and a
   * `pushAudio` that threw all feed the same hysteretic decision.
   */
  private recordProviderError(provider: AsrProvider, error: AppError): void {
    if (this.disposed) return
    // A late error from a provider we already abandoned is history; ignore it rather than let it
    // push us further down a plan we have already moved on from.
    if (provider !== this.active) return

    const at = this.now()
    this.errorTimestamps = this.errorTimestamps.filter((ts) => at - ts <= this.errorWindowMs)
    this.errorTimestamps.push(at)
    this.lastError = `${asrProviderLabel(provider.getId())}: ${error.message}`

    if (this.errorTimestamps.length < this.failureThreshold) {
      this.log.debug('a recogniser error, below the failover threshold', {
        provider: provider.getId(),
        streak: this.errorTimestamps.length,
        threshold: this.failureThreshold,
      })
      this.publishStatus()
      return
    }

    void this.failOver(provider, error)
  }

  /**
   * Move to the next provider in the plan, or to `failed` when there is none.
   *
   * Only ever forwards. Coming back to a recovered cloud provider mid-session is deliberately not
   * implemented: the operator would watch the transcript change engine, and the two engines
   * disagree about spelling and punctuation, so the transcript visibly rewrites itself. The next
   * `start()` re-tries from the top of the plan.
   */
  private async failOver(from: AsrProvider, cause: AppError): Promise<void> {
    if (from !== this.active) return

    const reason = `${asrProviderLabel(from.getId())} failed: ${cause.message}`
    this.log.warn('failing over from a recogniser', {
      provider: from.getId(),
      errors: this.errorTimestamps.length,
      detail: cause.message,
    })

    this.detachActive()
    this.errorTimestamps = []
    this.pendingSpanStartedAt = null
    await this.stopProvider(from)
    if (this.disposed) return

    const next = this.planIndex + 1
    if (next >= this.sessionPlan.length) {
      this.state = 'failed'
      this.lastError = reason
      this.sessionStartedAt = null
      this.publishStatus()
      this.log.error('the transcript has stopped; running manual', { detail: reason })
      return
    }

    await this.activateFrom(next, reason)
  }

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------

  /**
   * Filter, measure and forward one segment.
   *
   * The hallucination filter applies to **finals only**. A draft is replaced by whatever comes
   * next anyway, so filtering it buys nothing and costs the operator the immediate feedback that
   * is the entire point of the draft tier.
   *
   * When a final *is* rejected there are two cases, and they are not the same:
   *
   *  - nothing for that span has reached the UI yet — drop it silently;
   *  - a draft for that span is already on screen — emit an empty-text final for the same `id`.
   *    Consumers replace by id, so this retracts the draft. Dropping the final instead would leave
   *    a phantom "thank you for watching" on screen forever, which is exactly the artefact the
   *    filter exists to remove.
   */
  private handleSegment(provider: AsrProvider, segment: TranscriptSegment): void {
    if (this.disposed) return
    if (provider !== this.active) return

    this.recordLatency(segment)
    // Speech is arriving, so whatever the last error was, the provider is working now.
    if (this.errorTimestamps.length > 0) {
      this.errorTimestamps = []
      this.publishStatus()
    }

    if (!segment.isFinal) {
      this.publishedSpanIds.add(segment.id)
      this.emitTranscript(segment)
      return
    }

    if (isLikelyHallucination(segment.text)) {
      const hadDraft = this.publishedSpanIds.delete(segment.id)
      this.log.debug('filtered a likely hallucination', {
        provider: provider.getId(),
        retracted: hadDraft,
        // The text itself is service content; its length is enough to debug the filter.
        length: segment.text.length,
      })
      if (hadDraft) this.emitTranscript({ ...segment, text: '', isDraft: false })
      return
    }

    this.publishedSpanIds.delete(segment.id)
    this.emitTranscript(segment)
  }

  /**
   * Record the time from the first audio of a span to its first partial.
   *
   * Only the first fragment of a span counts: the refinements that follow measure how long the
   * provider took to think again, not how long the operator waited to see anything.
   */
  private recordLatency(segment: TranscriptSegment): void {
    if (this.seenSpanIds.has(segment.id)) return
    if (this.seenSpanIds.size >= MAX_TRACKED_SPANS) this.seenSpanIds.clear()
    this.seenSpanIds.add(segment.id)

    const startedAt = this.pendingSpanStartedAt
    if (startedAt === null) return
    this.pendingSpanStartedAt = null

    const elapsed = this.now() - startedAt
    if (!Number.isFinite(elapsed) || elapsed < 0) return
    this.latencySamples.push(elapsed)
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) this.latencySamples.shift()
    this.publishStatus()
  }

  private emitTranscript(segment: TranscriptSegment): void {
    if (this.publishedSpanIds.size >= MAX_TRACKED_SPANS) this.publishedSpanIds.clear()
    for (const subscriber of [...this.transcriptSubscribers]) {
      try {
        subscriber(segment)
      } catch (cause) {
        this.log.warn('a transcript subscriber threw', { cause })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status plumbing
  // -------------------------------------------------------------------------

  private isRunning(): boolean {
    return this.state === 'listening' || this.state === 'degraded'
  }

  /**
   * At rest, `not-configured` and `idle` are derived rather than stored, because configuration can
   * change under us — a key added to `.env` and the app restarted, or a sidecar that finished
   * downloading its model.
   */
  private snapshot(): AsrStatus {
    const state: AsrState =
      this.state === 'idle' || this.state === 'not-configured'
        ? this.usablePlan().length === 0
          ? 'not-configured'
          : 'idle'
        : this.state

    const deviceId = this.settings.deviceId
    const device = deviceId === null ? undefined : this.devices.find((d) => d.deviceId === deviceId)

    return {
      state,
      provider: this.active === null ? null : this.active.getId(),
      language: this.settings.language,
      latencyMs: median(this.latencySamples),
      deviceId,
      deviceLabel: device?.label ?? null,
      lastError: this.lastError,
      since: this.sessionStartedAt,
    }
  }

  private publishStatus(): void {
    const next = this.snapshot()
    if (sameAsrStatus(next, this.lastEmitted)) return
    this.lastEmitted = next

    for (const subscriber of [...this.statusSubscribers]) {
      try {
        subscriber(next)
      } catch (cause) {
        this.log.warn('an ASR status subscriber threw', { cause })
      }
    }
  }

  private resetSessionBookkeeping(): void {
    this.errorTimestamps = []
    this.pendingSpanStartedAt = null
    this.latencySamples = []
    this.seenSpanIds = new Set<string>()
    this.publishedSpanIds = new Set<string>()
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private readStoredSettings(load: AsrSettingsReader | undefined): AsrSettings {
    if (load === undefined) return defaultAsrSettings()

    let stored: Result<AsrSettings | null>
    try {
      stored = load()
    } catch (cause) {
      this.log.warn('the saved ASR settings could not be read; using defaults', { cause })
      return defaultAsrSettings()
    }

    if (!stored.ok) {
      this.log.warn('the saved ASR settings could not be read; using defaults', {
        detail: stored.error.message,
      })
      return defaultAsrSettings()
    }
    if (stored.value === null) return defaultAsrSettings()

    const parsed = asrSettingsSchema.safeParse(stored.value)
    if (!parsed.success) {
      this.log.warn('the saved ASR settings are invalid; using defaults')
      return defaultAsrSettings()
    }
    return {
      mode: parsed.data.mode,
      language: parsed.data.language,
      deviceId: parsed.data.deviceId,
      customVocabulary: parsed.data.customVocabulary,
      localModel: parsed.data.localModel,
    }
  }

  private writeSettings(settings: AsrSettings): Result<void> {
    const persist = this.persist
    if (persist === null) return ok(undefined)

    try {
      const written = persist(settings)
      if (!written.ok) {
        this.log.error('the ASR settings could not be saved', { detail: written.error.message })
      }
      return written
    } catch (cause) {
      const error = toAppError(cause, ErrorCode.IO_ERROR)
      this.log.error('the ASR settings could not be saved', { detail: error.message })
      return { ok: false, error }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structural equality for an {@link AsrStatus}. Eight scalars. */
export function sameAsrStatus(a: AsrStatus, b: AsrStatus): boolean {
  return (
    a.state === b.state &&
    a.provider === b.provider &&
    a.language === b.language &&
    a.latencyMs === b.latencyMs &&
    a.deviceId === b.deviceId &&
    a.deviceLabel === b.deviceLabel &&
    a.lastError === b.lastError &&
    a.since === b.since
  )
}

/**
 * Median, rounded, or `null` when there is nothing to measure.
 *
 * Median rather than mean: one 8-second stall while a sidecar loaded a model would drag a mean
 * far away from what the operator is actually experiencing for the rest of the service.
 */
export function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const high = sorted[middle]
  if (high === undefined) return null
  if (sorted.length % 2 === 1) return Math.round(high)
  const low = sorted[middle - 1]
  if (low === undefined) return Math.round(high)
  return Math.round((low + high) / 2)
}

/** First provider wins per id, so a duplicated registration cannot shadow the real one. */
function dedupeProviders(providers: readonly AsrProvider[]): readonly AsrProvider[] {
  const seen = new Set<AsrProviderId>()
  const unique: AsrProvider[] = []
  for (const provider of providers) {
    let id: AsrProviderId
    try {
      id = provider.getId()
    } catch {
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(provider)
  }
  return unique
}

function runQuietly(unsubscribe: Unsubscribe | null): void {
  if (unsubscribe === null) return
  try {
    unsubscribe()
  } catch {
    /* best effort — the producer is already gone */
  }
}
