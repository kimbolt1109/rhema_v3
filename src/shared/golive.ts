/**
 * The GO LIVE / END orchestration contract.
 *
 * BLUEPRINT.md §5: one button takes you live end-to-end, one button ends cleanly, and the local
 * recording always runs.
 *
 * ## Always-on local recording (Standing Rule 3)
 *
 * Whenever streaming starts, OBS local recording starts too. It is the backup when the internet
 * wobbles mid-service, and a service is un-repeatable. This is **never** optional and there is
 * deliberately no flag here to disable it — the absence of that flag is the design.
 *
 * ## The app must never wedge the broadcast
 *
 * Every step can fail independently, and failure never cascades into stopping the stream or the
 * recording. If the YouTube transition fails, OBS keeps pushing and recording and the operator is
 * told; if the app crashes outright, OBS carries on and the next launch RE-ATTACHES to whatever
 * OBS is already doing rather than starting a second stream.
 *
 * Node-global free.
 */

/**
 * The ordered steps of going live.
 *
 * Ordered so the irreversible, externally-visible step (`transition`, which makes the broadcast
 * public) happens LAST, only after ingest is confirmed healthy. Going live to an unhealthy
 * stream shows viewers a broken player.
 */
export const GO_LIVE_STEPS = [
  /** Ensure a broadcast exists and is bound to the persistent stream (Phase 4). */
  'broadcast',
  /** OBS StartStream — push RTMP to YouTube's ingest. */
  'stream',
  /** OBS StartRecord — the always-on local backup. Starts with the stream, never after. */
  'record',
  /** Poll OBS output state and YouTube ingest health until good. */
  'health',
  /** liveBroadcasts.transition -> 'live'. The irreversible one. */
  'transition',
] as const

/** Union of the step names. */
export type GoLiveStep = (typeof GO_LIVE_STEPS)[number]

/** How one step is going. */
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** One step's progress, surfaced per-step so a failure names exactly what broke. */
export interface GoLiveStepStatus {
  readonly step: GoLiveStep
  readonly state: StepState
  readonly message: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

/**
 * The overall phase.
 *
 * `partial` is the important one and exists because it is the honest description of the most
 * likely real failure: OBS is streaming and recording, but YouTube did not transition. The
 * broadcast is going to disk and to YouTube's ingest, yet is not public. Collapsing that into
 * either "live" or "failed" would lie to the operator in opposite directions.
 */
export type GoLivePhase = 'idle' | 'starting' | 'live' | 'partial' | 'ending' | 'failed'

/** What OBS is actually doing, observed rather than assumed. */
export interface ObsOutputState {
  readonly streaming: boolean
  readonly recording: boolean
  readonly recordingPaused: boolean
  /** OBS's own reconnect indicator, when it is retrying a dropped RTMP connection. */
  readonly streamReconnecting: boolean
  /** Milliseconds of output, as OBS reports it. */
  readonly streamTimecodeMs: number | null
  readonly recordTimecodeMs: number | null
  /** Dropped frames, for the health readout. */
  readonly skippedFrames: number | null
  readonly totalFrames: number | null
  /** Absolute path of the file OBS is writing, once known. The operator's backup. */
  readonly recordingPath: string | null
}

/** A blank output state, used before OBS has been asked. */
export function emptyObsOutputState(): ObsOutputState {
  return {
    streaming: false,
    recording: false,
    recordingPaused: false,
    streamReconnecting: false,
    streamTimecodeMs: null,
    recordTimecodeMs: null,
    skippedFrames: null,
    totalFrames: null,
    recordingPath: null,
  }
}

/** Everything the LIVE indicator needs. */
export interface GoLiveState {
  readonly phase: GoLivePhase
  readonly steps: readonly GoLiveStepStatus[]
  /** Epoch ms when the stream actually started, for the elapsed-time readout. */
  readonly liveSince: number | null
  readonly obs: ObsOutputState
  /** The failure that moved us to `failed` or `partial`, if any. */
  readonly lastError: string | null
  /**
   * True when this state was recovered by re-attaching to an already-running OBS after an app
   * restart, rather than started by this process. The UI says so, because the elapsed time will
   * not match when the operator pressed the button.
   */
  readonly reattached: boolean
}

/** The resting state. */
export function idleGoLiveState(): GoLiveState {
  return {
    phase: 'idle',
    steps: GO_LIVE_STEPS.map((step) => ({
      step,
      state: 'pending' as StepState,
      message: null,
      startedAt: null,
      finishedAt: null,
    })),
    liveSince: null,
    obs: emptyObsOutputState(),
    lastError: null,
    reattached: false,
  }
}

/**
 * Whether ending requires a held confirmation.
 *
 * Always true while anything is live. Ending a service by a mis-click is unrecoverable — the
 * broadcast is over and the congregation saw it end. Per
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md`, destructive actions are holds, never taps.
 */
export function endRequiresHold(state: GoLiveState): boolean {
  return state.phase === 'live' || state.phase === 'partial' || state.obs.streaming
}

/**
 * Whether the app should RE-ATTACH rather than start.
 *
 * If OBS is already streaming or recording when Verger starts up, the app crashed (or was
 * restarted) mid-service. Starting again would push a second stream and start a second recording.
 * Verger adopts what OBS is already doing instead — Standing Rule 2: OBS owns that state.
 */
export function shouldReattach(obs: ObsOutputState): boolean {
  return obs.streaming || obs.recording
}
