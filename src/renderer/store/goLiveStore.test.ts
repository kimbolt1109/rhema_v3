/**
 * The GO LIVE store's contract.
 *
 * Four properties carry the phase:
 *
 *  - **Recording always starts with the stream.** Every successful start leaves `obs.recording`
 *    true. There is no argument, flag or option anywhere in this file that could make it false,
 *    because there is none in the contract (Standing Rule 3).
 *  - **A refusal never blanks the mirrored state.** If `start` or `end` is refused while OBS is
 *    streaming, the store keeps saying OBS is streaming. Verger must never react to its own error
 *    by claiming the broadcast stopped.
 *  - **`partial` survives as `partial`.** A pushed partial state is not rounded to live or failed.
 *  - **Crash re-attach is adopted, not re-run.** Hydrating into a state OBS was already in leaves
 *    `reattached: true` and issues no start.
 *
 * Nothing here touches the network or OBS: the whole surface runs against `createMockVergerApi`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { emptyObsOutputState, idleGoLiveState } from '@shared/golive'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_ELAPSED_MS,
  MOCK_NOW,
  MOCK_RECORDING_PATH,
  installMockVergerApi,
  mockFailedGoLiveState,
  mockLiveGoLiveState,
  mockObsOutputState,
  mockPartialGoLiveState,
  mockReattachedGoLiveState,
  mockSignedInYouTubeStatus,
  mockStartingGoLiveState,
  mockStreamingObsOutputState,
} from '../test/mockVergerApi'
import {
  GO_LIVE_BRIDGE_UNAVAILABLE_MESSAGE,
  droppedFrameRatio,
  elapsedMs,
  failedStep,
  formatElapsed,
  isRecordingMissing,
  recordingElapsedMs,
  resetGoLiveStore,
  runningStep,
  useGoLiveStore,
} from './goLiveStore'

describe('goLiveStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetGoLiveStore()
  })

  it('settles into idle instead of throwing', async () => {
    await useGoLiveStore.getState().hydrate()

    const store = useGoLiveStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.state).toEqual(idleGoLiveState())
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.lastError?.message).toBe(GO_LIVE_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from start and end rather than dereferencing undefined', async () => {
    const started = await useGoLiveStore.getState().start()
    const ended = await useGoLiveStore.getState().end()

    for (const result of [started, ended]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    }
    expect(useGoLiveStore.getState().starting).toBe(false)
    expect(useGoLiveStore.getState().ending).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = useGoLiveStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(useGoLiveStore.getState().bridgeAvailable).toBe(false)
  })
})

describe('goLiveStore', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetGoLiveStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates to idle with no error before anything has been started', async () => {
    await useGoLiveStore.getState().hydrate()

    const store = useGoLiveStore.getState()
    expect(store.bridgeAvailable).toBe(true)
    expect(store.hydrated).toBe(true)
    expect(store.state.phase).toBe('idle')
    expect(store.state.obs).toEqual(emptyObsOutputState())
    expect(store.lastError).toBeNull()
  })

  it('starts the local recording whenever it starts the stream — Standing Rule 3', async () => {
    await useGoLiveStore.getState().hydrate()

    const result = await useGoLiveStore.getState().start()

    expect(installed.mock.calls.goLiveStart).toHaveLength(1)
    expect(result.ok).toBe(true)
    const store = useGoLiveStore.getState()
    expect(store.state.obs.streaming).toBe(true)
    // The assertion this whole phase exists for.
    expect(store.state.obs.recording).toBe(true)
    expect(store.state.steps.find((step) => step.step === 'record')?.state).toBe('done')
    expect(store.starting).toBe(false)
  })

  it('still streams and records when YouTube is not configured, skipping only YouTube', async () => {
    // The default fixture is a machine with no GOOGLE_CLIENT_ID. That is this machine.
    await useGoLiveStore.getState().hydrate()

    await useGoLiveStore.getState().start()

    const { state } = useGoLiveStore.getState()
    expect(state.obs.streaming).toBe(true)
    expect(state.obs.recording).toBe(true)
    expect(state.steps.find((step) => step.step === 'broadcast')?.state).toBe('skipped')
    expect(state.steps.find((step) => step.step === 'transition')?.state).toBe('skipped')
  })

  it('runs the YouTube steps for real once signed in', async () => {
    installed.mock.responses.youtubeGetStatus = ok(mockSignedInYouTubeStatus())
    await installed.mock.api.youtube.getStatus()
    await useGoLiveStore.getState().hydrate()

    await useGoLiveStore.getState().start()

    const { state } = useGoLiveStore.getState()
    expect(state.steps.every((step) => step.state === 'done')).toBe(true)
    expect(state.phase).toBe('live')
  })

  it('re-attaches instead of pushing a second stream when OBS is already live', async () => {
    installed.mock.responses.goLiveGetState = ok(mockReattachedGoLiveState())
    await useGoLiveStore.getState().hydrate()

    const store = useGoLiveStore.getState()
    expect(store.state.reattached).toBe(true)
    expect(store.state.obs.streaming).toBe(true)
    expect(store.state.obs.recording).toBe(true)
    // Hydrating adopts. It does not start.
    expect(installed.mock.calls.goLiveStart).toEqual([])

    // And if the operator presses GO LIVE anyway, the orchestrator adopts rather than doubling up.
    await useGoLiveStore.getState().start()
    expect(useGoLiveStore.getState().state.reattached).toBe(true)
    expect(useGoLiveStore.getState().state.phase).toBe('live')
  })

  it('keeps saying OBS is streaming when a start is refused mid-service', async () => {
    installed.mock.responses.goLiveGetState = ok(mockPartialGoLiveState())
    await useGoLiveStore.getState().hydrate()
    installed.mock.responses.goLiveStart = err(ErrorCode.TIMEOUT, 'YouTube did not answer')

    const result = await useGoLiveStore.getState().start()

    expect(result.ok).toBe(false)
    const store = useGoLiveStore.getState()
    // The refusal changed nothing about what OBS is doing, so the readout must not pretend it did.
    expect(store.state.phase).toBe('partial')
    expect(store.state.obs.streaming).toBe(true)
    expect(store.state.obs.recording).toBe(true)
    expect(store.lastError?.code).toBe(ErrorCode.TIMEOUT)
    expect(store.starting).toBe(false)
  })

  it('keeps the stream in the readout when END is refused', async () => {
    installed.mock.responses.goLiveGetState = ok(mockLiveGoLiveState())
    await useGoLiveStore.getState().hydrate()
    installed.mock.responses.goLiveEnd = err(ErrorCode.OBS_ERROR, 'OBS refused StopStream')

    const result = await useGoLiveStore.getState().end()

    expect(result.ok).toBe(false)
    const store = useGoLiveStore.getState()
    expect(store.state.phase).toBe('live')
    expect(store.state.obs.streaming).toBe(true)
    expect(store.lastError?.code).toBe(ErrorCode.OBS_ERROR)
    expect(store.ending).toBe(false)
  })

  it('ends the service and keeps the recording path so the backup can still be found', async () => {
    installed.mock.responses.goLiveGetState = ok(mockLiveGoLiveState())
    await useGoLiveStore.getState().hydrate()

    const result = await useGoLiveStore.getState().end()

    expect(installed.mock.calls.goLiveEnd).toHaveLength(1)
    expect(result.ok).toBe(true)
    const store = useGoLiveStore.getState()
    expect(store.state.phase).toBe('idle')
    expect(store.state.obs.streaming).toBe(false)
    expect(store.state.obs.recording).toBe(false)
    expect(store.state.obs.recordingPath).toBe(MOCK_RECORDING_PATH)
  })

  it('applies a pushed partial state verbatim rather than rounding it to live or failed', () => {
    const unsubscribe = useGoLiveStore.getState().subscribe()

    installed.mock.emit(IpcEvent.goLiveState, mockPartialGoLiveState())

    const store = useGoLiveStore.getState()
    expect(store.state.phase).toBe('partial')
    expect(store.state.obs.streaming).toBe(true)
    expect(store.state.obs.recording).toBe(true)
    expect(failedStep(store.state)?.step).toBe('transition')

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.goLiveState)).toBe(0)
  })

  it('tracks the in-flight flags from the pushed phase', () => {
    useGoLiveStore.getState().subscribe()

    installed.mock.emit(IpcEvent.goLiveState, mockStartingGoLiveState('record'))
    expect(useGoLiveStore.getState().starting).toBe(true)
    expect(runningStep(useGoLiveStore.getState().state)).toBe('record')

    installed.mock.emit(IpcEvent.goLiveState, mockLiveGoLiveState())
    expect(useGoLiveStore.getState().starting).toBe(false)
    expect(useGoLiveStore.getState().ending).toBe(false)
  })

  it('keeps the last known state when the state read fails', async () => {
    installed.mock.responses.goLiveGetState = ok(mockLiveGoLiveState())
    await useGoLiveStore.getState().hydrate()
    installed.mock.responses.goLiveGetState = err(ErrorCode.INTERNAL, 'handler blew up')

    await useGoLiveStore.getState().hydrate()

    const store = useGoLiveStore.getState()
    expect(store.state.phase).toBe('live')
    expect(store.lastError?.code).toBe(ErrorCode.INTERNAL)
    expect(store.hydrated).toBe(true)
  })

  it('converts a rejected bridge promise into an Err instead of propagating it', async () => {
    window.verger = {
      ...installed.mock.api,
      goLive: {
        ...installed.mock.api.goLive,
        start: () => Promise.reject(new Error('bridge exploded')),
      },
    }

    const result = await useGoLiveStore.getState().start()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL)
      expect(result.error.message).toBe('bridge exploded')
    }
    expect(useGoLiveStore.getState().starting).toBe(false)
  })

  it('never touches the overlay or the cameras, going live or ending', async () => {
    await useGoLiveStore.getState().hydrate()
    await useGoLiveStore.getState().start()
    await useGoLiveStore.getState().end()

    expect(installed.mock.calls.overlaySend).toEqual([])
    expect(installed.mock.calls.overlayGetState).toEqual([])
    expect(installed.mock.calls.cameraSelect).toEqual([])
    expect(installed.mock.calls.cameraSetConfig).toEqual([])
  })
})

describe('elapsedMs', () => {
  it('measures from liveSince when the app started the stream itself', () => {
    expect(elapsedMs(mockLiveGoLiveState(), MOCK_NOW)).toBe(MOCK_ELAPSED_MS)
  })

  it('falls back to OBS’s own timecode when this process never saw the start', () => {
    const reattached = mockReattachedGoLiveState({ liveSince: null })
    expect(elapsedMs(reattached, MOCK_NOW)).toBe(MOCK_ELAPSED_MS)
  })

  it('is null when nothing is running', () => {
    expect(elapsedMs(idleGoLiveState(), MOCK_NOW)).toBeNull()
  })

  it('never goes negative when the clocks disagree', () => {
    const state = mockLiveGoLiveState({ liveSince: MOCK_NOW + 5000 })
    expect(elapsedMs(state, MOCK_NOW)).toBe(0)
  })
})

describe('recordingElapsedMs', () => {
  it('is null while nothing is recording, whatever the timecode says', () => {
    expect(recordingElapsedMs(mockObsOutputState({ recordTimecodeMs: 999 }))).toBeNull()
  })

  it('reports the record timecode independently of the stream one', () => {
    const obs = mockStreamingObsOutputState({ streamTimecodeMs: 10_000, recordTimecodeMs: 20_000 })
    expect(recordingElapsedMs(obs)).toBe(20_000)
  })
})

describe('formatElapsed', () => {
  it('reads m:ss under an hour and h:mm:ss over it', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(9_000)).toBe('0:09')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_600_000)).toBe('1:00:00')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })

  it('clamps rather than printing a negative clock', () => {
    expect(formatElapsed(-5000)).toBe('0:00')
  })
})

describe('runningStep and failedStep', () => {
  it('names the step in flight so a failure can be attributed', () => {
    expect(runningStep(mockStartingGoLiveState('health'))).toBe('health')
    expect(failedStep(mockStartingGoLiveState('health'))).toBeNull()
  })

  it('names the step that broke', () => {
    expect(failedStep(mockFailedGoLiveState())?.step).toBe('stream')
    expect(failedStep(mockFailedGoLiveState())?.message).toBe('OBS refused StartStream.')
    expect(runningStep(mockFailedGoLiveState())).toBeNull()
  })

  it('reports nothing running once live', () => {
    expect(runningStep(mockLiveGoLiveState())).toBeNull()
  })
})

describe('droppedFrameRatio', () => {
  it('is null when OBS has not reported enough to say', () => {
    expect(droppedFrameRatio(emptyObsOutputState())).toBeNull()
    expect(droppedFrameRatio(mockObsOutputState({ skippedFrames: 0, totalFrames: 0 }))).toBeNull()
  })

  it('divides skipped by total', () => {
    const obs = mockObsOutputState({ skippedFrames: 50, totalFrames: 1000 })
    expect(droppedFrameRatio(obs)).toBeCloseTo(0.05)
  })
})

describe('isRecordingMissing', () => {
  it('is true exactly when the stream is up and nothing is being recorded', () => {
    expect(isRecordingMissing(mockStreamingObsOutputState())).toBe(false)
    expect(isRecordingMissing(mockStreamingObsOutputState({ recording: false }))).toBe(true)
    // Not streaming at all is not a recording failure — it is simply idle.
    expect(isRecordingMissing(emptyObsOutputState())).toBe(false)
  })
})
