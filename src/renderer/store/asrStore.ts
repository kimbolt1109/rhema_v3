/**
 * The renderer's view of speech recognition.
 *
 * `src/shared/asr.ts` is the contract; this store mirrors the last {@link AsrStatus} and
 * {@link AsrSettings} the main process reported, and holds the rolling transcript.
 *
 * ## The draft/final replacement contract
 *
 * This is the one piece of real logic in the file, and the one that decides whether the transcript
 * reads like speech or like flickering gibberish. A provider emits **many** `isFinal: false`
 * partials for one span of speech, each refining the last, then exactly one `isFinal: true` result
 * that supersedes them all. They all carry the **same `id`**.
 *
 * So {@link mergeSegment} replaces by id and only appends when the id is new. Appending partials
 * would print "오늘", "오늘 우리", "오늘 우리는" as three separate lines. The local two-tier
 * scheduler works identically — a `tiny` draft inside ~500 ms, then a `small` final that replaces
 * it — which is why `isDraft` is a flag on the segment rather than a separate stream.
 *
 * One asymmetry is deliberate: a **final is never un-finalised**. If a late partial arrives after
 * the final for the same id (reordered IPC, or a provider re-emitting), it is dropped. Letting it
 * through would rewind a settled line to a worse guess in front of the operator.
 *
 * ## The buffer is capped
 *
 * A 90-minute service at conversational speed is thousands of segments. {@link
 * TRANSCRIPT_BUFFER_LIMIT} keeps the last 200 and drops the oldest, so memory is bounded and the
 * panel's DOM stays small. The transcript is a live working surface, not an archive; anything that
 * needs the whole thing (the cue engine, Phase 8) reads it from the main process.
 *
 * ## Nothing blocks and nothing throws
 *
 * `window.verger` is optional (jsdom, or a preload that failed to load) and every action returns an
 * `Err` rather than dereferencing `undefined`. A dead ASR provider produces a red light and an
 * empty transcript, never a hang — the operator runs manual and nothing is blocked (Standing
 * Rule 1).
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { AsrSettings, AsrStatus, AudioInputDevice, TranscriptSegment } from '@shared/asr'
import { defaultAsrSettings, idleAsrStatus } from '@shared/asr'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `asr.bridgeUnavailable` copy instead — this string is for the log file.
 */
export const ASR_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; speech recognition is disabled.'

/** How many segments the rolling buffer keeps. See the header. */
export const TRANSCRIPT_BUFFER_LIMIT = 200

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: ASR_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, ASR_BRIDGE_UNAVAILABLE_MESSAGE)
}

async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/* ------------------------------ pure reducers, unit-testable ------------------------------ */

/**
 * Fold one segment into the rolling buffer.
 *
 * Pure and exported so the replacement contract is tested directly rather than through a
 * component. See the header for why each branch exists.
 */
export function mergeSegment(
  segments: readonly TranscriptSegment[],
  next: TranscriptSegment,
  limit: number = TRANSCRIPT_BUFFER_LIMIT,
): readonly TranscriptSegment[] {
  const index = segments.findIndex((segment) => segment.id === next.id)

  if (index >= 0) {
    const existing = segments[index]
    // A settled line is never rewound to a guess.
    if (existing !== undefined && existing.isFinal && !next.isFinal) return segments
    // Replaced **in place** rather than moved to the end: a partial arriving late for an earlier
    // span must not reorder the transcript under the operator's eyes.
    const replaced = segments.slice()
    replaced[index] = next
    return replaced
  }

  const appended = [...segments, next]
  return appended.length > limit ? appended.slice(appended.length - limit) : appended
}

/** Whether a transcript is arriving at all. `degraded` counts — that is the whole point of it. */
export function isTranscribing(status: AsrStatus): boolean {
  return status.state === 'listening' || status.state === 'degraded'
}

/**
 * Whether the operator is on their own.
 *
 * `failed` and `not-configured` both mean "no transcript", and the panel says so in plain words.
 * They are still two different states elsewhere: one is a fault, the other is a subsystem that was
 * never switched on (Standing Rule 5).
 */
export function isRunningManual(status: AsrStatus): boolean {
  return status.state === 'failed' || status.state === 'not-configured'
}

/* ---------------------------------------- the store ---------------------------------------- */

export interface AsrStoreState {
  /** The last status observed by the main process. Never locally invented. */
  readonly status: AsrStatus
  readonly settings: AsrSettings
  /** The rolling transcript, oldest first, capped at {@link TRANSCRIPT_BUFFER_LIMIT}. */
  readonly segments: readonly TranscriptSegment[]
  /** Audio inputs the renderer enumerated. Empty until the settings screen has looked. */
  readonly devices: readonly AudioInputDevice[]
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link AsrStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a start/stop/settings round trip is in flight. */
  readonly busy: boolean
  /** True while the renderer's own microphone capture is running. */
  readonly capturing: boolean
  readonly lastError: AppError | null

  hydrate: () => Promise<void>
  /** Wire the push channels. Returns an unsubscribe — call it on unmount. */
  subscribe: () => Unsubscribe
  start: () => Promise<Result<AsrStatus>>
  stop: () => Promise<Result<AsrStatus>>
  setSettings: (settings: AsrSettings) => Promise<Result<AsrSettings>>
  /** Hand one PCM chunk to the recogniser. Renderer -> main; see `micCapture.ts`. */
  pushAudio: (chunk: ArrayBuffer) => Promise<Result<void>>
  /** Publish the enumerated inputs to main and remember them locally. */
  reportDevices: (devices: readonly AudioInputDevice[]) => Promise<Result<void>>
  /** Fold a segment in. Exposed so the panel's own capture loop and tests share one path. */
  ingest: (segment: TranscriptSegment) => void
  /** Note that the renderer's microphone is (not) running. Purely a local flag. */
  setCapturing: (capturing: boolean) => void
  /** Empty the rolling buffer. The operator's "clear" button, not an automatic action. */
  clearTranscript: () => void
}

const noop: Unsubscribe = () => undefined

export const useAsrStore = create<AsrStoreState>()((set) => ({
  status: idleAsrStatus(),
  settings: defaultAsrSettings(),
  segments: [],
  devices: [],
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  busy: false,
  capturing: false,
  lastError: null,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        status: idleAsrStatus(),
        bridgeAvailable: false,
        hydrated: true,
        busy: false,
        lastError: bridgeUnavailableError(),
      })
      return
    }

    set({ bridgeAvailable: true })

    const [status, settings] = await Promise.all([
      callBridge((bridge) => bridge.asr.getStatus()),
      callBridge((bridge) => bridge.asr.getSettings()),
    ])

    if (status.ok) set({ status: status.value })
    if (settings.ok) set({ settings: settings.value })

    const failure = !status.ok ? status.error : !settings.ok ? settings.error : null
    // The last known status is kept rather than blanked: a failed refresh is not evidence that
    // recognition stopped.
    set({ hydrated: true, lastError: failure })
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false })
      return noop
    }

    const offStatus = api.asr.onStatus((status) => {
      set({ status })
    })
    const offTranscript = api.asr.onTranscript((segment) => {
      set((state) => ({ segments: mergeSegment(state.segments, segment) }))
    })

    return () => {
      offStatus()
      offTranscript()
    }
  },

  start: async () => {
    set({ busy: true })
    const result = await callBridge((bridge) => bridge.asr.start())
    if (result.ok) {
      set({ status: result.value, busy: false, lastError: null })
    } else {
      // The mirrored status is deliberately untouched. A refused start says nothing about whether
      // a session that was already running is still running.
      set({ busy: false, lastError: result.error })
    }
    return result
  },

  stop: async () => {
    set({ busy: true })
    const result = await callBridge((bridge) => bridge.asr.stop())
    if (result.ok) {
      set({ status: result.value, busy: false, lastError: null })
    } else {
      set({ busy: false, lastError: result.error })
    }
    return result
  },

  setSettings: async (settings) => {
    set({ busy: true })
    const result = await callBridge((bridge) => bridge.asr.setSettings(settings))
    if (result.ok) {
      set({ settings: result.value, busy: false, lastError: null })
    } else {
      set({ busy: false, lastError: result.error })
    }
    return result
  },

  pushAudio: async (chunk) => {
    // Deliberately does NOT set `busy` and deliberately does NOT record `lastError` on failure:
    // this runs ten times a second, and a per-chunk error banner would strobe. A genuinely broken
    // session shows up as the status going `failed`, which is the main process's call to make.
    return callBridge((bridge) => bridge.asr.pushAudio(chunk))
  },

  reportDevices: async (devices) => {
    set({ devices })
    return callBridge((bridge) => bridge.asr.listDevices(devices))
  },

  ingest: (segment) => {
    set((state) => ({ segments: mergeSegment(state.segments, segment) }))
  },

  setCapturing: (capturing) => {
    set({ capturing })
  },

  clearTranscript: () => {
    set({ segments: [] })
  },
}))

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked transcript from one test silently breaks the next.
 */
export function resetAsrStore(): void {
  useAsrStore.setState({
    status: idleAsrStatus(),
    settings: defaultAsrSettings(),
    segments: [],
    devices: [],
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    busy: false,
    capturing: false,
    lastError: null,
  })
}
