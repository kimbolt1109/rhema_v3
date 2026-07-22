/**
 * The GO LIVE / END orchestrator — one button takes the service live, one button ends it, and
 * the local recording always runs.
 *
 * This file is where BLUEPRINT.md §5 steps 1-5 become a sequence, and where three of the
 * standing rules are enforced in code rather than in prose:
 *
 * ## 1. Always-on local recording (Standing Rule 3)
 *
 * Streaming and recording are started by ONE seam call — {@link GoLiveOutputs.startStreamAndRecord}
 * — and this module has no other way to start a stream. There is no `startStream` verb on the
 * seam, no flag that skips the recording, and no branch that starts one output without asking
 * for the other. `GoLiveService.test.ts` asserts that structurally (the source contains no
 * single-output start call) as well as behaviourally (every path that streams also records).
 * A failed `StartRecord` is LOUD: the `record` step goes `failed`, the error is surfaced in
 * {@link GoLiveState.lastError}, the phase lands `partial` rather than a reassuring `live`, and
 * the logger says in plain words that the service is running without its backup.
 *
 * ## 2. Verger must never wedge the broadcast
 *
 * Nothing in the GO LIVE sequence stops anything. Every step failure is recorded and the
 * sequence continues; the only `Stop*` requests in this file are the two inside {@link
 * GoLiveService.end}, which run because an operator asked to end the service. A failed YouTube
 * transition, an ingest that never turns healthy, a broadcast that could not be created — none
 * of them takes OBS off air, because OBS reaching the congregation is worth more than Verger's
 * idea of tidiness. That is what `partial` is for: OBS is streaming and recording, YouTube did
 * not transition, and the operator is told exactly that.
 *
 * ## 3. Crash re-attach (Standing Rule 2)
 *
 * {@link GoLiveService.initialize} reads OBS's real output state at launch. If OBS is already
 * streaming or recording, the app crashed mid-service, and starting again would push a second
 * stream and start a second recording. Verger ADOPTS what OBS is doing instead: `reattached:
 * true`, `liveSince` derived from OBS's own timecode rather than invented, and **not one
 * `Start*` request issued**.
 *
 * ## Everything is injected, nothing throws
 *
 * The OBS outputs, the YouTube service, the clock and the timers are all structural seams
 * declared in this file, so the whole orchestration is driven in tests with no OBS Studio, no
 * Google account and no network — which is exactly the machine this was built on. Every method
 * returns a {@link Result}; every seam call and every subscriber callback is wrapped.
 */

import { GO_LIVE_STEPS, idleGoLiveState, shouldReattach } from '@shared/golive'
import type {
  GoLivePhase,
  GoLiveState,
  GoLiveStep,
  GoLiveStepStatus,
  ObsOutputState,
  StepState
} from '@shared/golive'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { AppError, Result } from '@shared/result'
import type { BroadcastLifecycle, StreamHealth, YouTubeStatus } from '@shared/youtube'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The outcome of one {@link GoLiveOutputs.startStreamAndRecord} call.
 *
 * A structural subset of `ObsOutputs.StartOutputsOutcome` (`src/main/obs/outputs.ts`), declared
 * here so this module compiles and tests without importing that one. The two outputs are
 * reported SEPARATELY because "one worked and the other did not" is a real Sunday morning and
 * the panel renders `stream` and `record` as two independent steps.
 */
export interface StartOutputsSummary {
  /** True when OBS is streaming after the call — whether Verger started it or it already was. */
  readonly streaming: boolean
  /** True when OBS is recording after the call. */
  readonly recording: boolean
  /** Non-null when `StartStream` failed. */
  readonly streamError: AppError | null
  /** Non-null when `StartRecord` failed. The service is running without a backup — say so. */
  readonly recordError: AppError | null
  readonly streamAlreadyRunning?: boolean
  readonly recordAlreadyRunning?: boolean
}

/**
 * The slice of the OBS outputs module this orchestrator uses.
 *
 * Note what is NOT here: there is no `startStream` and no `startRecord`. The only way this file
 * can start anything is the combined verb, so "streaming without recording" is not a state the
 * orchestrator is able to ask for (Standing Rule 3). The stop verbs are separate precisely
 * because END must be able to stop the stream first and the recording LAST.
 */
export interface GoLiveOutputs {
  /** Read what OBS is actually doing. Observation only — never a cached opinion. */
  readOutputState(): Promise<Result<ObsOutputState>>
  /** Start the stream AND the recording, together, always. */
  startStreamAndRecord(): Promise<Result<StartOutputsSummary>>
  /** `StopStream`. Operator-initiated only. */
  stopStream(): Promise<Result<unknown>>
  /** `StopRecord`. Operator-initiated only, and always the last thing END does. */
  stopRecord(): Promise<Result<unknown>>
}

/**
 * The slice of the YouTube service this orchestrator uses.
 *
 * Structural, so Phase 4's `YouTubeService` satisfies it without this file importing it — and so
 * the tests can hand over a forty-line double with no `googleapis`, no OAuth and no quota.
 */
export interface GoLiveYouTube {
  /** The cached status. A read of local state: no network, no quota. */
  getStatus(): YouTubeStatus
  createBroadcast(options?: { readonly scheduledStartTime?: string }): Promise<Result<unknown>>
  transition(status: BroadcastLifecycle): Promise<Result<unknown>>
  /** Re-read the persistent stream's ingest health. 1 quota unit per call. */
  pollStreamHealth(): Promise<Result<{ readonly health: StreamHealth }>>
}

/** Opaque handle returned by {@link GoLiveTimers.setTimeout}. */
export type GoLiveTimerHandle = ReturnType<typeof setTimeout> | number

/** The timer surface, injected so the health poll is driven by fake timers in tests. */
export interface GoLiveTimers {
  setTimeout(handler: () => void, delayMs: number): GoLiveTimerHandle
  clearTimeout(handle: GoLiveTimerHandle): void
}

/**
 * The real timers.
 *
 * The globals are resolved at call time rather than captured at module load, so a test that
 * installs fake timers after importing this module still intercepts them.
 */
export const realGoLiveTimers: GoLiveTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How often the health step re-reads OBS and YouTube.
 *
 * Two seconds: fast enough that the operator sees movement, slow enough that a ten-minute wait
 * would still be a rounding error against YouTube's daily quota (1 unit per `liveStreams.list`).
 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000

/**
 * How long the health step waits before giving up.
 *
 * YouTube routinely reports `noData` for twenty or thirty seconds after OBS starts pushing, so a
 * short deadline would call a perfectly healthy service broken. Ninety seconds is generous, and
 * hitting it costs nothing except a `partial` phase — nothing is stopped.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 90_000

/** Ingest health values good enough to make a broadcast public. */
const HEALTHY_INGEST: readonly StreamHealth[] = ['good', 'ok']

/** Broadcast lifecycles that mean "this one is still usable for today's service". */
const REUSABLE_LIFECYCLES: readonly BroadcastLifecycle[] = ['created', 'ready', 'testing', 'live']

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Constructor dependencies. `outputs`, `youtube` and `logger` are required. */
export interface GoLiveServiceOptions {
  readonly outputs: GoLiveOutputs
  readonly youtube: GoLiveYouTube
  readonly logger: Logger
  readonly timers?: GoLiveTimers
  /** Epoch-milliseconds clock. Injected so elapsed time is deterministic in tests. */
  readonly now?: () => number
  readonly pollIntervalMs?: number
  readonly healthTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class GoLiveService {
  private readonly outputs: GoLiveOutputs
  private readonly youtube: GoLiveYouTube
  private readonly log: Logger
  private readonly timers: GoLiveTimers
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly healthTimeoutMs: number

  private state: GoLiveState = idleGoLiveState()
  private lastAppError: AppError | null = null

  private readonly subscribers = new Set<(state: GoLiveState) => void>()

  /** True while `start()` or `end()` is running. The re-entrancy guard. */
  private busy = false
  private disposed = false

  /** Pending health-poll sleeps, so `dispose()` cannot leave a promise hanging. */
  private readonly sleeping = new Set<{ handle: GoLiveTimerHandle; resolve: () => void }>()

  constructor(options: GoLiveServiceOptions) {
    this.outputs = options.outputs
    this.youtube = options.youtube
    this.log = options.logger.child('golive')
    this.timers = options.timers ?? realGoLiveTimers
    this.now = options.now ?? Date.now
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.healthTimeoutMs = Math.max(0, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The current state. Always a complete, serialisable snapshot. */
  getState(): GoLiveState {
    return this.state
  }

  /**
   * Subscribe to state changes.
   *
   * Called after EVERY step transition, so the panel renders progress instead of freezing for
   * the thirty seconds a go-live takes.
   */
  onState(callback: (state: GoLiveState) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // Re-attach
  // -------------------------------------------------------------------------

  /**
   * Read OBS's output state at startup and adopt it if OBS is already running.
   *
   * **Issues no `Start*` request of any kind, ever.** The single OBS interaction here is one
   * read. If OBS is streaming or recording ({@link shouldReattach}), the app crashed or was
   * restarted mid-service, and the only correct behaviour is to adopt: pressing GO LIVE again
   * would push a second stream and start a second recording, and Verger does not own that state
   * (Standing Rule 2).
   *
   * `liveSince` is derived from OBS's own stream timecode. If OBS does not report one it stays
   * `null` — an unknown elapsed time renders as "unknown", never as an invented "00:00".
   *
   * A failed read is not fatal and not a re-attach: the state stays `idle`, the error is
   * returned for the caller to log, and the operator can still press GO LIVE (OBS being
   * unreachable at launch is the ordinary "OBS is not open yet" case).
   */
  async initialize(): Promise<Result<GoLiveState>> {
    if (this.disposed) return this.disposedError()
    if (this.busy) {
      return err(ErrorCode.INVALID_ARG, 'cannot re-attach while a GO LIVE or END is running')
    }

    const observed = await this.safe(
      () => this.outputs.readOutputState(),
      'the OBS output state could not be read'
    )
    if (!observed.ok) {
      this.log.warn('could not read the OBS output state at startup; assuming nothing is running', {
        code: observed.error.code,
        message: observed.error.message
      })
      return observed
    }

    const obs = observed.value
    this.setState({ obs })

    if (!shouldReattach(obs)) {
      this.log.info('OBS is idle at startup; nothing to re-attach to')
      return ok(this.state)
    }

    const adopted = obs.streaming ? 'adopted from OBS, which was already streaming' : null
    const recordAdopted = obs.recording ? 'adopted from OBS, which was already recording' : null

    const steps: readonly GoLiveStepStatus[] = GO_LIVE_STEPS.map((step) =>
      this.adoptedStep(step, obs, adopted, recordAdopted)
    )

    // Streaming without a local recording is a real, reportable problem — the service has no
    // backup — but it is emphatically NOT a reason to stop the stream.
    const missingBackup = obs.streaming && !obs.recording
    const phase: GoLivePhase = obs.streaming && obs.recording ? 'live' : 'partial'
    this.lastAppError = missingBackup
      ? {
          code: ErrorCode.OBS_ERROR,
          message: 'OBS is streaming without a local recording — this service has no backup file'
        }
      : null

    this.setState({
      phase,
      steps,
      reattached: true,
      liveSince: deriveLiveSince(obs, this.now()),
      lastError: this.lastAppError === null ? null : this.lastAppError.message
    })

    this.log.warn('re-attached to an OBS session that was already running', {
      streaming: obs.streaming,
      recording: obs.recording,
      phase,
      streamTimecodeMs: obs.streamTimecodeMs
    })
    return ok(this.state)
  }

  /** Alias for {@link initialize}, named for what it does at the call site. */
  async reattach(): Promise<Result<GoLiveState>> {
    return this.initialize()
  }

  // -------------------------------------------------------------------------
  // GO LIVE
  // -------------------------------------------------------------------------

  /**
   * Run the whole GO LIVE sequence.
   *
   * Refused (with an `Err`, having done nothing) when a go-live is already running or when OBS
   * is already live — running the sequence twice would double-start both outputs.
   *
   * The return value is the outcome, not a verdict: `live` and `partial` both return `Ok`,
   * because a partial go-live is a state the operator must see and act on rather than an error
   * the call "failed" with. Only `failed` — nothing streaming, nothing recording — returns `Err`.
   */
  async start(): Promise<Result<GoLiveState>> {
    if (this.disposed) return this.disposedError()

    const phase = this.state.phase
    if (this.busy || phase === 'starting' || phase === 'ending') {
      return err(
        ErrorCode.INVALID_ARG,
        'GO LIVE is already running; ignoring the second press',
        phase
      )
    }
    if (phase === 'live' || phase === 'partial') {
      return err(
        ErrorCode.INVALID_ARG,
        'OBS is already live; pressing GO LIVE again would start a second stream and a second recording',
        phase
      )
    }

    this.busy = true
    try {
      return await this.runStart()
    } finally {
      this.busy = false
    }
  }

  private async runStart(): Promise<Result<GoLiveState>> {
    this.lastAppError = null
    this.setState({
      phase: 'starting',
      steps: idleGoLiveState().steps,
      liveSince: null,
      lastError: null,
      reattached: false
    })
    this.log.info('GO LIVE requested')

    const youtube = this.youtubeAvailability()

    // --- 1. broadcast -------------------------------------------------------
    const broadcast = await this.runBroadcastStep(youtube)

    // --- 2 + 3. stream and record ------------------------------------------
    const outputs = await this.runOutputsStep()

    // --- 4. health ----------------------------------------------------------
    const healthy = await this.runHealthStep(outputs.streaming, youtube.usable && broadcast.exists)

    // --- 5. transition ------------------------------------------------------
    const transitioned = await this.runTransitionStep(youtube, broadcast, healthy)

    return this.settleStart(youtube, outputs, healthy, transitioned)
  }

  /**
   * Step 1 — ensure a broadcast exists and is bound.
   *
   * When YouTube is not configured this step is `skipped`, **not** `failed`, and the sequence
   * carries on. An operator with no Google account must still be able to press GO LIVE and get a
   * local recording plus an OBS stream to whatever OBS is configured for — that is the difference
   * between a degraded service and no service.
   */
  private async runBroadcastStep(
    youtube: YouTubeAvailability
  ): Promise<{ exists: boolean; alreadyLive: boolean }> {
    this.markStep('broadcast', 'running', null)

    if (!youtube.usable) {
      this.markStep('broadcast', 'skipped', youtube.reason)
      this.log.info('going live without YouTube', { reason: youtube.reason })
      return { exists: false, alreadyLive: false }
    }

    const existing = youtube.status?.broadcast ?? null
    if (
      existing !== null &&
      existing.boundStreamId !== null &&
      REUSABLE_LIFECYCLES.includes(existing.lifecycle)
    ) {
      this.markStep('broadcast', 'done', `reusing the bound broadcast "${existing.title}"`)
      return { exists: true, alreadyLive: existing.lifecycle === 'live' }
    }

    const created = await this.safe(
      () => this.youtube.createBroadcast(),
      'the YouTube broadcast could not be created'
    )
    if (!created.ok) {
      this.recordFailure('broadcast', created.error)
      return { exists: false, alreadyLive: false }
    }

    this.markStep('broadcast', 'done', 'the broadcast was created and bound')
    return { exists: true, alreadyLive: false }
  }

  /**
   * Steps 2 and 3 — the stream and the recording, started together.
   *
   * One seam call starts both. A recording that fails to start is reported at maximum volume and
   * changes the final phase to `partial`, but it never stops the stream: the service reaching the
   * congregation outranks the backup copy of it.
   */
  private async runOutputsStep(): Promise<StartOutputsSummary> {
    this.markStep('stream', 'running', null)
    this.markStep('record', 'running', null)

    const started = await this.safe(
      () => this.outputs.startStreamAndRecord(),
      'OBS could not be asked to start the stream and the recording'
    )

    if (!started.ok) {
      this.recordFailure('stream', started.error)
      this.recordFailure('record', started.error)
      this.log.error('neither the stream nor the recording started', {
        code: started.error.code,
        message: started.error.message
      })
      await this.refreshOutputState()
      return { streaming: false, recording: false, streamError: started.error, recordError: started.error }
    }

    const outcome = started.value

    if (outcome.streaming) {
      this.markStep(
        'stream',
        'done',
        outcome.streamAlreadyRunning === true ? 'OBS was already streaming' : 'OBS is streaming'
      )
    } else {
      this.recordFailure(
        'stream',
        outcome.streamError ?? { code: ErrorCode.OBS_ERROR, message: 'OBS did not start the stream' }
      )
    }

    if (outcome.recording) {
      this.markStep(
        'record',
        'done',
        outcome.recordAlreadyRunning === true ? 'OBS was already recording' : 'OBS is recording locally'
      )
    } else {
      const error = outcome.recordError ?? {
        code: ErrorCode.OBS_ERROR,
        message: 'OBS did not start the local recording'
      }
      this.recordFailure('record', error)
      // Standing Rule 3: this is never a quiet skip. The operator has to know NOW, while the
      // service is running, that there is no backup file — not afterwards.
      this.log.error(
        'THE LOCAL RECORDING DID NOT START — this service is not being backed up to disk',
        { message: error.message, detail: error.detail, streaming: outcome.streaming }
      )
    }

    if (outcome.streaming) {
      this.setState({ liveSince: this.now() })
    }

    await this.refreshOutputState()
    return outcome
  }

  /**
   * Step 4 — poll until the ingest is healthy, or give up.
   *
   * Giving up stops NOTHING. It marks the step `failed`, which lands the phase on `partial`, and
   * the operator decides what to do: wait, retry, or drive OBS by hand. The transition is then
   * skipped deliberately — making a broadcast public over an unhealthy ingest shows viewers a
   * broken player, which is worse than a broadcast that goes public a minute late.
   */
  private async runHealthStep(streaming: boolean, checkYouTube: boolean): Promise<boolean> {
    this.markStep('health', 'running', null)

    if (!streaming) {
      this.markStep('health', 'skipped', 'OBS is not streaming, so there is no ingest to check')
      return false
    }

    const deadline = this.now() + this.healthTimeoutMs
    for (;;) {
      if (this.disposed) {
        this.markStep('health', 'failed', 'the app shut down while waiting for the ingest')
        return false
      }

      const obs = await this.refreshOutputState()
      const ingest = checkYouTube ? await this.readIngestHealth() : null

      if (isHealthy(obs, ingest)) {
        this.markStep(
          'health',
          'done',
          ingest === null ? 'OBS reports a healthy stream' : `YouTube reports ingest health "${ingest}"`
        )
        return true
      }

      if (this.now() >= deadline) {
        const message = `the stream did not become healthy within ${Math.round(this.healthTimeoutMs / 1000)}s — OBS is still streaming and recording`
        this.markStep('health', 'failed', message)
        this.lastAppError = { code: ErrorCode.TIMEOUT, message }
        this.setState({ lastError: message })
        this.log.warn('the ingest health check timed out; nothing has been stopped', {
          streaming: obs.streaming,
          recording: obs.recording,
          reconnecting: obs.streamReconnecting,
          ingest
        })
        return false
      }

      await this.sleep(this.pollIntervalMs)
    }
  }

  /**
   * Step 5 — make the broadcast public.
   *
   * The irreversible one, and therefore the last one. A failure here is `partial`, never
   * `failed`: OBS is streaming and recording, and saying "failed" about a service that is going
   * out to disk and to YouTube's ingest would be a lie in the more dangerous direction.
   */
  private async runTransitionStep(
    youtube: YouTubeAvailability,
    broadcast: { exists: boolean; alreadyLive: boolean },
    healthy: boolean
  ): Promise<boolean> {
    this.markStep('transition', 'running', null)

    if (!youtube.usable) {
      this.markStep('transition', 'skipped', youtube.reason)
      return false
    }
    if (!broadcast.exists) {
      this.markStep('transition', 'skipped', 'there is no broadcast to make public')
      return false
    }
    if (broadcast.alreadyLive) {
      this.markStep('transition', 'done', 'the broadcast was already live')
      return true
    }
    if (!healthy) {
      this.markStep(
        'transition',
        'skipped',
        'the ingest is not healthy; going live now would show viewers a broken player'
      )
      return false
    }

    const moved = await this.safe(
      () => this.youtube.transition('live'),
      'the YouTube broadcast could not be transitioned to live'
    )
    if (!moved.ok) {
      this.recordFailure('transition', moved.error)
      this.log.error('the YouTube transition failed; OBS keeps streaming and recording', {
        code: moved.error.code,
        message: moved.error.message
      })
      return false
    }

    this.markStep('transition', 'done', 'the broadcast is live on YouTube')
    return true
  }

  /** Decide the final phase, and nothing else. Stops nothing, whatever it decides. */
  private settleStart(
    youtube: YouTubeAvailability,
    outputs: StartOutputsSummary,
    healthy: boolean,
    transitioned: boolean
  ): Result<GoLiveState> {
    const running = outputs.streaming || outputs.recording
    if (!running) {
      const error =
        this.lastAppError ??
        ({ code: ErrorCode.OBS_ERROR, message: 'neither the stream nor the recording started' } as AppError)
      this.lastAppError = error
      this.setState({ phase: 'failed', liveSince: null, lastError: error.message })
      this.log.error('GO LIVE failed; OBS is neither streaming nor recording', {
        message: error.message
      })
      return { ok: false, error }
    }

    const transitionState = this.stepState('transition')
    const youtubeSettled = transitioned || (transitionState === 'skipped' && !youtube.usable)
    const clean = outputs.streaming && outputs.recording && healthy && youtubeSettled

    const phase: GoLivePhase = clean ? 'live' : 'partial'
    this.setState({
      phase,
      lastError: clean ? null : (this.lastAppError?.message ?? this.state.lastError)
    })

    if (clean) {
      this.log.info('GO LIVE complete', { reattached: false })
    } else {
      this.log.warn('GO LIVE finished partially; OBS is still streaming and/or recording', {
        streaming: outputs.streaming,
        recording: outputs.recording,
        healthy,
        transitioned
      })
    }
    return ok(this.state)
  }

  // -------------------------------------------------------------------------
  // END
  // -------------------------------------------------------------------------

  /**
   * End the service: transition to `complete`, stop the stream, then stop the recording.
   *
   * The order is the point. Stopping the recording LAST means a YouTube outage, an expired
   * token or a dead network cannot cost the operator the local file — the one artefact that
   * cannot be recreated. Every sub-step runs even if the ones before it failed, and each failure
   * is reported rather than swallowed.
   *
   * `end()` while idle is a no-op success: an accidental press must not send OBS anything.
   */
  async end(): Promise<Result<GoLiveState>> {
    if (this.disposed) return this.disposedError()
    if (this.busy) {
      return err(ErrorCode.INVALID_ARG, 'a GO LIVE or END is already running', this.state.phase)
    }
    if (this.state.phase === 'idle') {
      this.log.info('END pressed while idle; there is nothing to end')
      return ok(this.state)
    }

    this.busy = true
    try {
      return await this.runEnd()
    } finally {
      this.busy = false
    }
  }

  private async runEnd(): Promise<Result<GoLiveState>> {
    this.setState({ phase: 'ending', lastError: null })
    this.lastAppError = null
    this.log.info('END requested')

    const failures: AppError[] = []

    // 1. YouTube first — best effort, and its failure must not reach the two stops below.
    const youtube = this.youtubeAvailability()
    const hasBroadcast = youtube.status !== null && youtube.status.broadcast !== null
    if (youtube.usable && hasBroadcast) {
      this.markStep('transition', 'running', null)
      const completed = await this.safe(
        () => this.youtube.transition('complete'),
        'the YouTube broadcast could not be transitioned to complete'
      )
      if (completed.ok) {
        this.markStep('transition', 'done', 'the broadcast is marked complete')
      } else {
        failures.push(completed.error)
        this.markStep('transition', 'failed', completed.error.message)
        this.log.warn('could not complete the YouTube broadcast; still stopping OBS', {
          message: completed.error.message
        })
      }
    } else {
      this.markStep('transition', 'skipped', youtube.usable ? 'there is no broadcast' : youtube.reason)
    }

    // 2. Stop the stream.
    this.markStep('stream', 'running', null)
    const stoppedStream = await this.safe(
      () => this.outputs.stopStream(),
      'OBS could not be asked to stop the stream'
    )
    if (stoppedStream.ok) {
      this.markStep('stream', 'done', 'the stream is stopped')
    } else {
      failures.push(stoppedStream.error)
      this.markStep('stream', 'failed', stoppedStream.error.message)
    }

    // 3. Stop the recording — LAST, unconditionally, whatever happened above.
    this.markStep('record', 'running', null)
    const stoppedRecord = await this.safe(
      () => this.outputs.stopRecord(),
      'OBS could not be asked to stop the recording'
    )
    if (stoppedRecord.ok) {
      this.markStep('record', 'done', 'the recording is stopped and the file is closed')
    } else {
      failures.push(stoppedRecord.error)
      this.markStep('record', 'failed', stoppedRecord.error.message)
      this.log.error('OBS did not stop the recording; check the file in OBS', {
        message: stoppedRecord.error.message
      })
    }

    const obs = await this.refreshOutputState()
    const stillRunning = obs.streaming || obs.recording
    const first = failures[0] ?? null
    this.lastAppError = first

    if (stillRunning) {
      const message = 'OBS is still streaming or recording after END — stop it in OBS'
      this.setState({ phase: 'failed', lastError: message })
      this.log.error(message, { streaming: obs.streaming, recording: obs.recording })
    } else {
      this.setState({
        phase: 'idle',
        liveSince: null,
        reattached: false,
        lastError: first === null ? null : first.message
      })
      this.log.info('END complete', { failures: failures.length })
    }

    if (first !== null) return { ok: false, error: first }
    return ok(this.state)
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Release every resource. Leaves no timer and no subscriber behind — and, deliberately,
   * stops neither the stream nor the recording. OBS keeps going; that is the whole design.
   */
  dispose(): void {
    this.disposed = true
    for (const pending of [...this.sleeping]) {
      try {
        this.timers.clearTimeout(pending.handle)
      } catch {
        /* a fake or already-fired timer — nothing to cancel */
      }
      pending.resolve()
    }
    this.sleeping.clear()
    this.subscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read OBS's output state, updating the snapshot. A failed read leaves the last one. */
  private async refreshOutputState(): Promise<ObsOutputState> {
    const observed = await this.safe(
      () => this.outputs.readOutputState(),
      'the OBS output state could not be read'
    )
    if (!observed.ok) {
      this.log.debug('could not refresh the OBS output state', {
        code: observed.error.code,
        message: observed.error.message
      })
      return this.state.obs
    }
    this.setState({ obs: observed.value })
    return observed.value
  }

  /** YouTube's ingest health, or `null` when it cannot be read — which is not evidence of a fault. */
  private async readIngestHealth(): Promise<StreamHealth | null> {
    const polled = await this.safe(
      () => this.youtube.pollStreamHealth(),
      'the YouTube ingest health could not be read'
    )
    if (!polled.ok) {
      this.log.debug('could not read the YouTube ingest health', { message: polled.error.message })
      return null
    }
    return polled.value.health
  }

  /** Whether YouTube can be used at all right now, and the plain-English reason when it cannot. */
  private youtubeAvailability(): YouTubeAvailability {
    let status: YouTubeStatus
    try {
      status = this.youtube.getStatus()
    } catch (cause) {
      this.log.warn('the YouTube service could not be read', { cause })
      return { usable: false, reason: 'the YouTube service is unavailable', status: null }
    }

    if (status.auth.state === 'not-configured') {
      return {
        usable: false,
        reason: 'YouTube is not configured — streaming and recording locally only',
        status
      }
    }
    return { usable: true, reason: '', status }
  }

  private recordFailure(step: GoLiveStep, error: AppError): void {
    this.lastAppError = error
    this.markStep(step, 'failed', error.message)
    this.setState({ lastError: error.message })
  }

  private stepState(step: GoLiveStep): StepState | null {
    return this.state.steps.find((entry) => entry.step === step)?.state ?? null
  }

  /** Update one step and publish. Every step transition is visible to the UI. */
  private markStep(step: GoLiveStep, state: StepState, message: string | null): void {
    const at = this.now()
    const steps = this.state.steps.map((entry) => {
      if (entry.step !== step) return entry
      const startedAt = state === 'running' ? at : (entry.startedAt ?? at)
      const finishedAt = state === 'running' || state === 'pending' ? null : at
      return { step: entry.step, state, message, startedAt, finishedAt }
    })
    this.setState({ steps })
  }

  private setState(patch: Partial<GoLiveState>): void {
    this.state = { ...this.state, ...patch }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.state
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('a GO LIVE state subscriber threw', { cause })
      }
    }
  }

  /**
   * Wait between health polls.
   *
   * Registered in {@link sleeping} so `dispose()` can cancel the timer AND settle the promise —
   * a shutdown mid-poll must not leave the sequence awaiting a timer that will never fire.
   */
  private sleep(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const pending: { handle: GoLiveTimerHandle; resolve: () => void } = {
        handle: 0,
        resolve: () => {
          if (this.sleeping.delete(pending)) resolve()
        }
      }
      try {
        pending.handle = this.timers.setTimeout(() => {
          pending.resolve()
        }, delayMs)
      } catch (cause) {
        this.log.warn('the health poll timer could not be scheduled', { cause })
        resolve()
        return
      }
      this.sleeping.add(pending)
    })
  }

  /**
   * Call a seam, converting anything it throws into an `Err`.
   *
   * Every one of these crosses a boundary this class does not own, and an exception escaping
   * into a GO LIVE sequence would take the booth UI down mid-service.
   */
  private async safe<T>(
    operation: () => Promise<Result<T>>,
    fallback: string
  ): Promise<Result<T>> {
    try {
      const result = await operation()
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, fallback, 'the dependency did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  private disposedError(): Result<GoLiveState> {
    return err(ErrorCode.INTERNAL, 'the GO LIVE service has been disposed')
  }

  /** One adopted step, for the crash re-attach path. Nothing here started anything. */
  private adoptedStep(
    step: GoLiveStep,
    obs: ObsOutputState,
    streamMessage: string | null,
    recordMessage: string | null
  ): GoLiveStepStatus {
    const at = this.now()
    const settled = (state: StepState, message: string): GoLiveStepStatus => ({
      step,
      state,
      message,
      startedAt: at,
      finishedAt: at
    })

    if (step === 'stream') {
      return obs.streaming
        ? settled('done', streamMessage ?? 'adopted from OBS')
        : settled('skipped', 'OBS is not streaming')
    }
    if (step === 'record') {
      return obs.recording
        ? settled('done', recordMessage ?? 'adopted from OBS')
        : settled('skipped', 'OBS is not recording — this service has no local backup')
    }
    return settled('skipped', 'adopted from a session Verger did not start')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What {@link GoLiveService.youtubeAvailability} answers. */
interface YouTubeAvailability {
  readonly usable: boolean
  readonly reason: string
  readonly status: YouTubeStatus | null
}

/**
 * Whether the ingest is good enough to make the broadcast public.
 *
 * OBS must be streaming and not mid-reconnect. YouTube's opinion is used when it is available:
 * `bad` and `noData` block, while an ingest health that could not be READ (`null`) does not —
 * a failed quota-cheap poll is not evidence that the stream is broken, and refusing to go live
 * over it would hand YouTube's flakiness a veto on the service.
 */
export function isHealthy(obs: ObsOutputState, ingest: StreamHealth | null): boolean {
  if (!obs.streaming) return false
  if (obs.streamReconnecting) return false
  if (ingest === null) return true
  return HEALTHY_INGEST.includes(ingest)
}

/**
 * When the current output actually started, derived from OBS's own timecode.
 *
 * Never invented: an OBS that reports no timecode yields `null`, which the UI renders as an
 * unknown elapsed time rather than a confident and wrong "00:00".
 */
export function deriveLiveSince(obs: ObsOutputState, now: number): number | null {
  const timecode = obs.streamTimecodeMs ?? obs.recordTimecodeMs
  if (timecode === null) return null
  return now - timecode
}
