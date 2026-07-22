/**
 * The renderer's view of GO LIVE.
 *
 * `src/shared/golive.ts` is the contract; this store is a mirror of the last {@link GoLiveState}
 * the main process reported, and nothing here invents one. Three properties matter more than the
 * code that implements them:
 *
 * 1. **It never predicts.** Pressing GO LIVE does not flip the phase to `live`; it asks, and the
 *    readout moves when the main process says it moved. The operator has to be able to trust the
 *    LIVE indicator absolutely — it is the only thing telling them whether a congregation that is
 *    not in the room can see the service.
 * 2. **A refusal never blanks the mirrored state.** If `start` or `end` comes back as an `Err`, the
 *    last known state is kept exactly as it was and only `lastError` moves. OBS may well still be
 *    streaming and recording; resetting the store to idle on our own error would put a "NOT LIVE"
 *    readout above a live stream, which is the worst lie this app could tell.
 * 3. **Nothing throws.** `window.verger` is optional (jsdom, or a preload that failed to load) and
 *    every action returns an `Err` rather than dereferencing `undefined`, exactly like `obsStore`,
 *    `cameraStore` and `youtubeStore`.
 *
 * There is deliberately **no** action here that stops a recording independently of ending the
 * service, and no flag anywhere that starts a stream without one. Standing Rule 3 is enforced by
 * the absence of the option, not by a default value someone can flip.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { GoLiveState, GoLiveStep, GoLiveStepStatus, ObsOutputState } from '@shared/golive'
import { idleGoLiveState } from '@shared/golive'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `goLive.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const GO_LIVE_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; GO LIVE is disabled.'

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: GO_LIVE_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, GO_LIVE_BRIDGE_UNAVAILABLE_MESSAGE)
}

/** Run an operation against the bridge, converting every failure mode into an `Err`. */
async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/* ------------------------------ pure readouts, unit-testable ------------------------------ */

/**
 * How long the stream has been up, in milliseconds, or `null` when it has not.
 *
 * `liveSince` first, because it is an absolute instant and survives the app being busy. OBS's own
 * `streamTimecodeMs` is the fallback for the re-attach case, where this process was not running
 * when the stream started and therefore has no instant of its own to subtract from.
 */
export function elapsedMs(state: GoLiveState, now: number): number | null {
  if (state.liveSince !== null) return Math.max(0, now - state.liveSince)
  if (state.obs.streamTimecodeMs !== null) return Math.max(0, state.obs.streamTimecodeMs)
  return null
}

/** How long OBS has been writing the local file, or `null` when it is not. */
export function recordingElapsedMs(obs: ObsOutputState): number | null {
  if (!obs.recording) return null
  return obs.recordTimecodeMs === null ? null : Math.max(0, obs.recordTimecodeMs)
}

/**
 * `h:mm:ss`, or `m:ss` under an hour.
 *
 * Not `Intl.DurationFormat` — it is not available in every Electron/Chromium this app will run on,
 * and a clock the operator glances at mid-service must never be the thing that throws.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`
}

/** The step currently in flight, or `null`. Drives "which step is running", never a spinner. */
export function runningStep(state: GoLiveState): GoLiveStep | null {
  return state.steps.find((step) => step.state === 'running')?.step ?? null
}

/** The first step that failed, with its message — the answer to "what broke?". */
export function failedStep(state: GoLiveState): GoLiveStepStatus | null {
  return state.steps.find((step) => step.state === 'failed') ?? null
}

/**
 * Dropped-frame ratio as a fraction of 0–1, or `null` when OBS has not reported enough to say.
 *
 * A zero-frame total is `null`, not `0`: "no frames yet" and "no frames dropped" are different
 * facts and a health readout that conflates them is worse than one that admits it does not know.
 */
export function droppedFrameRatio(obs: ObsOutputState): number | null {
  const { skippedFrames, totalFrames } = obs
  if (skippedFrames === null || totalFrames === null || totalFrames <= 0) return null
  return Math.min(1, Math.max(0, skippedFrames / totalFrames))
}

/**
 * True when OBS is streaming but not recording.
 *
 * Standing Rule 3 says this must never happen, which is precisely why it needs a name: if
 * `StartRecord` fails the operator gets a loud, visible failure, not a silent skip. The stream is
 * emphatically *not* stopped in response — that would be Verger wedging the broadcast over its own
 * problem.
 */
export function isRecordingMissing(obs: ObsOutputState): boolean {
  return obs.streaming && !obs.recording
}

/* ---------------------------------------- the store ---------------------------------------- */

export interface GoLiveStoreState {
  /** The last state observed by the main process. Never locally invented. */
  readonly state: GoLiveState
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link GoLiveStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a GO LIVE round trip is in flight. */
  readonly starting: boolean
  /** True while an END round trip is in flight. */
  readonly ending: boolean
  /** The last refusal, kept so the panel can explain why a press did nothing. */
  readonly lastError: AppError | null

  /** Pull the whole state from the main process, including any stream it re-attached to. */
  hydrate: () => Promise<void>
  /**
   * Wire the push channel. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `useGoLiveStore.subscribe`. Reach it via
   * `useGoLiveStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  /** Run the whole GO LIVE sequence. The local recording always starts with the stream. */
  start: () => Promise<Result<GoLiveState>>
  /** End the service: transition to complete, stop the stream, stop the recording. */
  end: () => Promise<Result<GoLiveState>>
}

const noop: Unsubscribe = () => undefined

export const useGoLiveStore = create<GoLiveStoreState>()((set) => ({
  state: idleGoLiveState(),
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  starting: false,
  ending: false,
  lastError: null,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        state: idleGoLiveState(),
        bridgeAvailable: false,
        hydrated: true,
        starting: false,
        ending: false,
        lastError: bridgeUnavailableError(),
      })
      return
    }

    set({ bridgeAvailable: true })

    const result = await callBridge((bridge) => bridge.goLive.getState())
    if (result.ok) {
      // This is where crash re-attach surfaces: the main process has already looked at OBS and,
      // if it was mid-service, handed back a state with `reattached: true`.
      set({ state: result.value, hydrated: true, lastError: null })
    } else {
      // The last known state is kept rather than blanked — see the header.
      set({ hydrated: true, lastError: result.error })
    }
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false })
      return noop
    }

    return api.goLive.onState((state) => {
      // A pushed state is the main process settling, so it ends whatever was in flight — except
      // where the phase itself says the sequence is still running.
      set({
        state,
        starting: state.phase === 'starting',
        ending: state.phase === 'ending',
      })
    })
  },

  start: async () => {
    set({ starting: true })
    const result = await callBridge((bridge) => bridge.goLive.start())
    if (result.ok) {
      set({ state: result.value, starting: false, lastError: null })
    } else {
      // Deliberately does NOT reset the mirrored state. A refused start may still have left OBS
      // streaming, and Verger must never respond to its own error by claiming — or making — the
      // broadcast stop.
      set({ starting: false, lastError: result.error })
    }
    return result
  },

  end: async () => {
    set({ ending: true })
    const result = await callBridge((bridge) => bridge.goLive.end())
    if (result.ok) {
      set({ state: result.value, ending: false, lastError: null })
    } else {
      set({ ending: false, lastError: result.error })
    }
    return result
  },
}))

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `starting: true` from one test silently breaks the next.
 */
export function resetGoLiveStore(): void {
  useGoLiveStore.setState({
    state: idleGoLiveState(),
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    starting: false,
    ending: false,
    lastError: null,
  })
}
