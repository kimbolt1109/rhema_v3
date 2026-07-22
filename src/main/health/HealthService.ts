/**
 * The health aggregator — one strip of lights for a booth with one operator.
 *
 * BLUEPRINT.md §9 is a table of failure modes. This file is the half of Phase 9 that makes every
 * one of them *visible*: it subscribes to every subsystem, maps each subsystem's own vocabulary
 * onto the four-level {@link HealthLevel} scale, and publishes a single {@link HealthSnapshot}.
 *
 * ## Three rules this file exists to enforce
 *
 * 1. **Amber means something.** `degraded` is reserved for "working, but not the way you
 *    configured it" — the recogniser fell back to local, OBS is retrying a dropped RTMP link,
 *    the plan-follower lost the script. A subsystem that is simply *unconfigured* maps to
 *    `not-configured`, which is a resting state and never an alarm. A permanently amber light
 *    teaches an operator to ignore amber, and that is worse than no light at all. Every mapper
 *    below was written with that single question in mind: "would this light be amber all
 *    morning on a normal Sunday?" If yes, it is not amber.
 *
 * 2. **`stillWorks` is the most valuable string on the dashboard.** "Stream reconnecting — the
 *    local recording is unaffected" is the difference between an operator staying calm and an
 *    operator stopping the service to investigate. Every `degraded` and every `down` verdict
 *    here carries one, and each names something concrete that is *still happening*, not a
 *    reassurance.
 *
 * 3. **A red OBS light does not mean the service stopped.** Standing Rule 2: OBS is the resilient
 *    engine and Verger is a convenience layer. When the WebSocket drops mid-service OBS keeps
 *    streaming and recording; only Verger's *view* of it is gone. `mapObs` says exactly that, and
 *    `isServiceStillGoingOut()` (in `@shared/health`) deliberately never consults the OBS light.
 *
 * ## Nothing here acts
 *
 * This service reads and reports. It has no verb that starts, stops, reloads or blanks anything —
 * an aggregator that can act is an aggregator that can act *wrongly*, mid-service, in reaction to
 * a status flap. Recovery actions live behind explicit operator gestures elsewhere.
 *
 * ## The seams are structural and local
 *
 * Every source is a hand-written interface matching the real class's shape, so this file imports
 * no service, needs no OBS, no Google account and no network, and `src/main/health/index.ts` can
 * pass the real singletons by structural typing alone. All six are **required**: a missing source
 * is then a compile error rather than a silently inert light, which is precisely the failure this
 * project has now shipped four times (STATUS.md cycles 2, 4, 5 and 8).
 */

import {
  SUBSYSTEMS,
  initialHealth,
  worstLevel,
} from '@shared/health'
import type { HealthSnapshot, SubsystemHealth, SubsystemId } from '@shared/health'
import type { CueEngineState } from '@shared/cue'
import type { GoLiveState, ObsOutputState } from '@shared/golive'
import type { Unsubscribe } from '@shared/ipc'
import type { OverlayServerInfo } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { ObsStatus } from '@shared/obs'
import type { AsrStatus } from '@shared/asr'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import type { YouTubeAuthStatus, YouTubeStatus } from '@shared/youtube'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Matches `ObsClient`. Read-only: the aggregator never connects, disconnects or calls OBS. */
export interface HealthObsLike {
  getStatus(): ObsStatus
  onStatus(callback: (status: ObsStatus) => void): Unsubscribe
}

/** Matches `OverlayServer`. Read-only: the aggregator never sends an overlay command. */
export interface HealthOverlayLike {
  getInfo(): OverlayServerInfo
  onInfo(callback: (info: OverlayServerInfo) => void): Unsubscribe
}

/** Matches `AsrService`. Read-only: the aggregator never starts or stops a session. */
export interface HealthAsrLike {
  getStatus(): Result<AsrStatus>
  onStatus(callback: (status: AsrStatus) => void): Unsubscribe
}

/** Matches `YouTubeService`. Read-only: the aggregator never signs in or spends quota. */
export interface HealthYouTubeLike {
  getStatus(): YouTubeStatus
  onStatus(callback: (status: YouTubeStatus) => void): Unsubscribe
}

/**
 * Matches `GoLiveService`.
 *
 * Read-only, and emphatically so: this seam has no `start`, no `end`, no `stopStream` and no
 * `stopRecord`, because a health aggregator that could reach those verbs could end a service in
 * reaction to a status flap.
 */
export interface HealthGoLiveLike {
  getState(): GoLiveState
  onState(callback: (state: GoLiveState) => void): Unsubscribe
}

/** Matches `CueEngine`. Read-only: the aggregator never fires, confirms or panics. */
export interface HealthCueLike {
  getState(): Result<CueEngineState>
  onState(callback: (state: CueEngineState) => void): Unsubscribe
}

/** Opaque handle returned by {@link HealthTimers.setTimeout}. */
export type HealthTimerHandle = ReturnType<typeof setTimeout> | number

/** The timer surface, injected so the coalescing window is driven by fake timers in tests. */
export interface HealthTimers {
  setTimeout(handler: () => void, delayMs: number): HealthTimerHandle
  clearTimeout(handle: HealthTimerHandle): void
}

/**
 * The real timers.
 *
 * Globals are resolved at call time rather than captured at module load, so a test that installs
 * fake timers after importing this module still intercepts them.
 */
export const realHealthTimers: HealthTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  },
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The coalescing window: at most one snapshot per 250 ms, i.e. ~4 per second.
 *
 * OBS chatters — a reconnect loop changes `attempt` and `nextRetryInMs` several times a second,
 * and each change would otherwise be an IPC message and a React render. Four a second is far
 * faster than an operator can read and slow enough to be free.
 */
export const HEALTH_EMIT_INTERVAL_MS = 250

/**
 * Dropped-frame fraction at which the stream light turns amber.
 *
 * 5% is where a viewer starts to notice stutter. Below that, encoder frame drops are normal on a
 * machine also running PowerPoint and a browser source, and an amber light for normal behaviour
 * is exactly the amber this project refuses to ship.
 */
export const DROPPED_FRAME_DEGRADED_RATIO = 0.05

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** A mapper's answer: everything about one light except when it was entered. */
export type SubsystemVerdict = Pick<SubsystemHealth, 'level' | 'detail' | 'stillWorks'>

/** A light that is working exactly as configured. Never carries a `stillWorks`. */
function working(detail: string): SubsystemVerdict {
  return { level: 'ok', detail, stillWorks: null }
}

/** A resting state: nothing is configured, nothing is wrong, nothing to do. */
function resting(detail: string): SubsystemVerdict {
  return { level: 'not-configured', detail, stillWorks: null }
}

/** Working, but not as configured. `stillWorks` is mandatory by signature. */
function degraded(detail: string, stillWorks: string): SubsystemVerdict {
  return { level: 'degraded', detail, stillWorks }
}

/** Not working. `stillWorks` is mandatory by signature — this is the string that keeps a head. */
function down(detail: string, stillWorks: string): SubsystemVerdict {
  return { level: 'down', detail, stillWorks }
}

/**
 * What OBS is still doing for the congregation while Verger cannot see it.
 *
 * The whole architecture in one sentence. When the WebSocket is gone but OBS was streaming, the
 * service is unaffected — OBS owns that state and never asked Verger's permission to keep going.
 */
function obsStillWorks(outputs: ObsOutputState | null): string {
  if (outputs !== null && (outputs.streaming || outputs.recording)) {
    return 'OBS is still streaming and recording on its own — Verger just cannot see it'
  }
  return 'the overlay page and the service plan are unaffected; camera switching and GO LIVE need OBS'
}

/**
 * The OBS connection light.
 *
 * `not-configured` is the resting state for a machine with no `OBS_WEBSOCKET_URL` (Standing
 * Rule 5). `auth-failed` is `down` and terminal — the client deliberately stops retrying a
 * rejected password, so an amber "reconnecting…" would be a lie.
 */
export function mapObs(status: ObsStatus, outputs: ObsOutputState | null): SubsystemVerdict {
  switch (status.state) {
    case 'not-configured':
      return resting('no OBS WebSocket address configured')
    case 'connected': {
      const scene = status.currentProgramScene
      return working(scene === null ? 'connected' : `connected — scene "${scene}"`)
    }
    case 'connecting':
      return degraded('connecting to OBS', obsStillWorks(outputs))
    case 'idle':
      return degraded('not connected yet', obsStillWorks(outputs))
    case 'reconnecting':
      return degraded(`reconnecting (attempt ${status.attempt})`, obsStillWorks(outputs))
    case 'auth-failed':
      return down('the OBS password was rejected', obsStillWorks(outputs))
    case 'disconnected':
      return down('not connected to Verger', obsStillWorks(outputs))
  }
}

/**
 * The overlay light.
 *
 * Zero attached clients is `degraded`, not `down`: the server is healthy and the state cache is
 * intact, but nothing is rendering it, so a lower third pressed now would appear nowhere. That is
 * precisely "working, but not as configured", and it is the light that catches the single most
 * common setup mistake — the OBS browser source pointing at the wrong URL.
 */
export function mapOverlay(info: OverlayServerInfo): SubsystemVerdict {
  const unaffected = 'cameras and streaming are unaffected'
  if (info.lastError !== null) return down(info.lastError, unaffected)
  if (!info.running) return down('the overlay server is not running', unaffected)
  if (info.clients === 0) return degraded('no browser source attached', unaffected)
  return working(info.clients === 1 ? '1 browser source attached' : `${info.clients} browser sources attached`)
}

/**
 * The ASR light.
 *
 * `degraded` means a transcript is still arriving from a fallback provider; `failed` means the
 * operator is on their own for cues. Collapsing the two would hide a fallback worth knowing
 * about, which is why `AsrStatus` distinguishes them in the first place.
 */
export function mapAsr(status: AsrStatus): SubsystemVerdict {
  switch (status.state) {
    case 'not-configured':
      return resting('no speech recogniser configured')
    case 'idle':
      return working('ready, not listening')
    case 'starting':
      return working('starting up')
    case 'listening': {
      const provider = status.provider ?? 'unknown'
      const latency = status.latencyMs === null ? '' : ` (${status.latencyMs} ms)`
      return working(`listening via ${provider}${latency}`)
    }
    case 'degraded':
      return degraded(
        `fell back to ${status.provider ?? 'another recogniser'}`,
        'transcription is still arriving, so cue suggestions keep working',
      )
    case 'failed':
      return down(
        status.lastError ?? 'the recogniser stopped',
        'cue suggestions are off; the plan still advances manually',
      )
  }
}

/**
 * The YouTube light.
 *
 * `signed-out` is `not-configured`, not amber. A church that streams once a week and signs in on
 * Sunday morning would otherwise stare at an amber light for six days, which is how an operator
 * learns that amber means nothing.
 */
export function mapYouTube(status: YouTubeAuthStatus): SubsystemVerdict {
  const unaffected =
    'OBS keeps streaming and recording; only the YouTube broadcast controls are unavailable'
  switch (status.state) {
    case 'not-configured':
      return resting('no Google client credentials configured')
    case 'signed-out':
      return resting('signed out — GO LIVE needs a Google sign-in')
    case 'authorizing':
      return degraded('waiting for the Google sign-in', unaffected)
    case 'signed-in': {
      const channel = status.channel
      return working(channel === null ? 'signed in' : `signed in as ${channel.title}`)
    }
    case 'auth-error':
      return down(status.lastError ?? 'the Google sign-in failed', unaffected)
  }
}

/**
 * The recording light.
 *
 * Streaming without recording is `down`, deliberately. Standing Rule 3 makes the local recording
 * unconditional because the internet is the part that fails and a service is un-repeatable; if
 * the stream is up and the disk is not, the operator has lost their backup and must be told in
 * red, not in amber.
 */
export function mapRecording(state: GoLiveState): SubsystemVerdict {
  const outputs = state.obs
  if (outputs.recording && outputs.recordingPaused) {
    return degraded(
      'recording is paused',
      outputs.streaming ? 'the stream is still going out' : 'nothing else is affected',
    )
  }
  if (outputs.recording) {
    const path = outputs.recordingPath
    return working(path === null ? 'recording' : `recording to ${path}`)
  }
  if (outputs.streaming) {
    return down(
      'the stream is live but nothing is being recorded',
      'the stream is still going out — but there is no local backup if it drops',
    )
  }
  return resting('not recording')
}

/**
 * The stream light.
 *
 * The `reconnecting` case is the one BLUEPRINT.md §9 opens with: the internet drops mid-service,
 * OBS retries on its own, and the operator's only question is whether they have lost the service.
 * They have not — the disk kept writing — and that is what the string says.
 */
export function mapStream(state: GoLiveState): SubsystemVerdict {
  const outputs = state.obs
  const recordingUnaffected = 'the local recording is unaffected'

  if (!outputs.streaming) {
    if (state.phase === 'failed') {
      return down(
        state.lastError ?? 'going live failed',
        outputs.recording ? recordingUnaffected : 'nothing was started, so nothing was lost',
      )
    }
    return resting('not streaming')
  }

  if (outputs.streamReconnecting) {
    return degraded('reconnecting to the ingest server', recordingUnaffected)
  }

  if (state.phase === 'partial') {
    return degraded(
      'pushing to YouTube, but the broadcast is not public yet',
      recordingUnaffected,
    )
  }

  const { skippedFrames, totalFrames } = outputs
  if (skippedFrames !== null && totalFrames !== null && totalFrames > 0) {
    const ratio = skippedFrames / totalFrames
    if (ratio >= DROPPED_FRAME_DEGRADED_RATIO) {
      return degraded(`dropping frames (${Math.round(ratio * 100)}%)`, recordingUnaffected)
    }
  }

  return working('live')
}

/**
 * The automation light.
 *
 * Panic is `degraded`, never `down`: the operator chose it, everything downstream still works,
 * and a red light for a deliberate act would be an alarm about a decision. "No plan loaded" is
 * `not-configured` for the same reason a missing key is — most of the week there is no plan.
 */
export function mapAutomation(state: CueEngineState): SubsystemVerdict {
  const manualStillWorks =
    'the stream, the recording and the overlay are untouched; the plan still advances manually'

  if (state.panicked) return degraded('PANIC — automation halted, full manual', manualStillWorks)
  if (!state.enabled) return resting('automation is switched off')
  if (state.alignment === 'no-plan') return resting('no service plan loaded')
  if (state.alignment === 'lost') {
    return degraded(
      'off script — not following the plan',
      'scripture and hot-phrase suggestions still arrive; the plan still advances manually',
    )
  }
  return working(`following the plan in ${state.mode} (cue ${state.position + 1})`)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor dependencies.
 *
 * All six sources are required on purpose — see the module docblock. `now` and `timers` are
 * injected so the coalescing window is deterministic under fake timers.
 */
export interface HealthServiceOptions {
  readonly obs: HealthObsLike
  readonly overlay: HealthOverlayLike
  readonly asr: HealthAsrLike
  readonly youtube: HealthYouTubeLike
  readonly goLive: HealthGoLiveLike
  readonly cue: HealthCueLike
  readonly logger: Logger
  readonly now?: () => number
  readonly timers?: HealthTimers
  /** Override the coalescing window. Clamped to >= 0. */
  readonly minEmitIntervalMs?: number
}

/** The last reading from each source. `null` means "not read yet", which maps to a resting light. */
interface SourceReadings {
  obs: ObsStatus | null
  overlay: OverlayServerInfo | null
  asr: AsrStatus | null
  youtube: YouTubeStatus | null
  goLive: GoLiveState | null
  cue: CueEngineState | null
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class HealthService {
  private readonly sources: Pick<
    HealthServiceOptions,
    'obs' | 'overlay' | 'asr' | 'youtube' | 'goLive' | 'cue'
  >

  private readonly log: Logger
  private readonly now: () => number
  private readonly timers: HealthTimers
  private readonly minEmitIntervalMs: number

  private readonly readings: SourceReadings = {
    obs: null,
    overlay: null,
    asr: null,
    youtube: null,
    goLive: null,
    cue: null,
  }

  private lights: readonly SubsystemHealth[]
  private snapshot: HealthSnapshot

  private readonly subscribers = new Set<(snapshot: HealthSnapshot) => void>()
  private readonly unsubscribes: Unsubscribe[] = []

  /** Trailing-edge coalescing state. */
  private pendingEmit: HealthTimerHandle | null = null
  private lastEmitAt = Number.NEGATIVE_INFINITY

  private started = false
  private disposed = false

  constructor(options: HealthServiceOptions) {
    this.sources = {
      obs: options.obs,
      overlay: options.overlay,
      asr: options.asr,
      youtube: options.youtube,
      goLive: options.goLive,
      cue: options.cue,
    }
    this.log = options.logger.child('health')
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realHealthTimers
    this.minEmitIntervalMs = Math.max(0, options.minEmitIntervalMs ?? HEALTH_EMIT_INTERVAL_MS)

    const at = this.now()
    this.lights = SUBSYSTEMS.map((id) => initialHealth(id, at))
    this.snapshot = { subsystems: this.lights, worst: worstLevel(this.lights), at }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Read every source once and subscribe to all of them.
   *
   * Idempotent, and performs no I/O: every call is an in-process getter or an in-process
   * subscription. `src/main/health/index.ts` calls this while building the singleton, so a
   * `getHealthService()` that nobody remembered to start is not a state this app can be in.
   */
  start(): Result<HealthSnapshot> {
    if (this.disposed) return this.disposedError()
    if (this.started) return ok(this.snapshot)
    this.started = true

    this.readAll()

    this.subscribe('obs', () =>
      this.sources.obs.onStatus((status) => {
        this.readings.obs = status
        this.recompute()
      }),
    )
    this.subscribe('overlay', () =>
      this.sources.overlay.onInfo((info) => {
        this.readings.overlay = info
        this.recompute()
      }),
    )
    this.subscribe('asr', () =>
      this.sources.asr.onStatus((status) => {
        this.readings.asr = status
        this.recompute()
      }),
    )
    this.subscribe('youtube', () =>
      this.sources.youtube.onStatus((status) => {
        this.readings.youtube = status
        this.recompute()
      }),
    )
    this.subscribe('goLive', () =>
      this.sources.goLive.onState((state) => {
        this.readings.goLive = state
        this.recompute()
      }),
    )
    this.subscribe('cue', () =>
      this.sources.cue.onState((state) => {
        this.readings.cue = state
        this.recompute()
      }),
    )

    this.recompute()
    this.log.info('health aggregator watching every subsystem', { sources: 6 })
    return ok(this.snapshot)
  }

  /** Release every subscription and any pending emit. Publishes nothing on the way out. */
  dispose(): void {
    this.disposed = true
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      try {
        unsubscribe()
      } catch (cause) {
        this.log.warn('a health source threw while unsubscribing', { detail: String(cause) })
      }
    }
    if (this.pendingEmit !== null) {
      this.timers.clearTimeout(this.pendingEmit)
      this.pendingEmit = null
    }
    this.subscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The current dashboard. Never throttled — the IPC `healthGet` must answer immediately. */
  getSnapshot(): Result<HealthSnapshot> {
    if (this.disposed) return this.disposedError()
    return ok(this.snapshot)
  }

  /**
   * Subscribe to snapshots.
   *
   * Coalesced to at most one per {@link HEALTH_EMIT_INTERVAL_MS}, trailing-edge, so the LAST
   * state of a burst always arrives. A subscriber that throws is logged and skipped: one broken
   * renderer bridge must not stop the other lights updating.
   */
  onSnapshot(callback: (snapshot: HealthSnapshot) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Re-read every source and recompute.
   *
   * For the caller that knows something changed out-of-band — an overlay reload, a re-attach at
   * startup — without waiting for the source's own event.
   */
  refresh(): Result<HealthSnapshot> {
    if (this.disposed) return this.disposedError()
    this.readAll()
    this.recompute()
    return ok(this.snapshot)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Subscribe to one source, containing anything it throws on the way in. */
  private subscribe(name: string, attach: () => Unsubscribe): void {
    try {
      this.unsubscribes.push(attach())
    } catch (cause) {
      this.log.error('a health source could not be subscribed to', {
        source: name,
        detail: String(cause),
      })
    }
  }

  /** Read every getter, tolerating a source that throws or answers with an `Err`. */
  private readAll(): void {
    this.readings.obs = this.read('obs', () => this.sources.obs.getStatus()) ?? this.readings.obs
    this.readings.overlay =
      this.read('overlay', () => this.sources.overlay.getInfo()) ?? this.readings.overlay
    this.readings.asr = this.readResult('asr', () => this.sources.asr.getStatus()) ?? this.readings.asr
    this.readings.youtube =
      this.read('youtube', () => this.sources.youtube.getStatus()) ?? this.readings.youtube
    this.readings.goLive =
      this.read('goLive', () => this.sources.goLive.getState()) ?? this.readings.goLive
    this.readings.cue = this.readResult('cue', () => this.sources.cue.getState()) ?? this.readings.cue
  }

  private read<T>(name: string, get: () => T): T | null {
    try {
      return get()
    } catch (cause) {
      this.log.error('a health source threw while being read', {
        source: name,
        detail: String(cause),
      })
      return null
    }
  }

  private readResult<T>(name: string, get: () => Result<T>): T | null {
    const result = this.read(name, get)
    if (result === null) return null
    if (!result.ok) {
      this.log.warn('a health source declined to report', {
        source: name,
        code: result.error.code,
      })
      return null
    }
    return result.value
  }

  /** Derive every light, keep `since` across an unchanged level, and emit only on a real change. */
  private recompute(): void {
    if (this.disposed) return

    const at = this.now()
    const previous = new Map(this.lights.map((light) => [light.id, light]))
    const verdicts = this.verdicts()

    let changed = false
    const next: SubsystemHealth[] = SUBSYSTEMS.map((id) => {
      const verdict = verdicts[id]
      const before = previous.get(id)
      const since = before !== undefined && before.level === verdict.level ? before.since : at
      const light: SubsystemHealth = {
        id,
        level: verdict.level,
        detail: verdict.detail,
        stillWorks: verdict.stillWorks,
        since,
      }
      if (!sameLight(light, before)) changed = true
      return light
    })

    this.lights = next
    this.snapshot = { subsystems: next, worst: worstLevel(next), at }
    if (changed) this.scheduleEmit()
  }

  /** One verdict per subsystem. A source not yet read rests rather than alarming. */
  private verdicts(): Record<SubsystemId, SubsystemVerdict> {
    const { obs, overlay, asr, youtube, goLive, cue } = this.readings
    const notRead = resting('not configured')
    return {
      obs: obs === null ? notRead : mapObs(obs, goLive === null ? null : goLive.obs),
      overlay: overlay === null ? notRead : mapOverlay(overlay),
      asr: asr === null ? notRead : mapAsr(asr),
      youtube: youtube === null ? notRead : mapYouTube(youtube.auth),
      recording: goLive === null ? resting('not recording') : mapRecording(goLive),
      stream: goLive === null ? resting('not streaming') : mapStream(goLive),
      automation: cue === null ? notRead : mapAutomation(cue),
    }
  }

  /**
   * Trailing-edge throttle.
   *
   * The first change of a quiet period emits at once (the operator sees it instantly); further
   * changes inside the window schedule one trailing emit that carries whatever the state is when
   * the timer fires. A leading-only throttle would drop the last change of a burst — which is
   * always the one that matters, because it is the state the system settled in.
   */
  private scheduleEmit(): void {
    if (this.pendingEmit !== null) return

    const elapsed = this.now() - this.lastEmitAt
    if (elapsed >= this.minEmitIntervalMs) {
      this.emit()
      return
    }

    const wait = Math.max(0, this.minEmitIntervalMs - elapsed)
    this.pendingEmit = this.timers.setTimeout(() => {
      this.pendingEmit = null
      this.emit()
    }, wait)
  }

  private emit(): void {
    if (this.disposed) return
    this.lastEmitAt = this.now()
    const snapshot = this.snapshot
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.error('a health subscriber threw; the aggregator carried on', {
          detail: String(cause),
        })
      }
    }
  }

  private disposedError(): Result<never> {
    return err(ErrorCode.INTERNAL, 'the health service has been disposed')
  }
}

/** Whether two lights are indistinguishable to an operator. `since` is derived, so it is ignored. */
function sameLight(a: SubsystemHealth, b: SubsystemHealth | undefined): boolean {
  if (b === undefined) return false
  return a.level === b.level && a.detail === b.detail && a.stillWorks === b.stillWorks
}
