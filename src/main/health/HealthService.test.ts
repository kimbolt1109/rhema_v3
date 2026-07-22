/**
 * `HealthService` behaviour — the dashboard an operator reads instead of investigating.
 *
 * Everything here runs against hand-written doubles and fake timers: no OBS Studio, no Google
 * account, no recogniser, no network, no real clock. That is the requirement, not a convenience —
 * the machine this was written on has none of those, and "amber means something" has to be
 * provable on a laptop rather than discovered on a Sunday.
 *
 * Four promises are asserted here:
 *
 *  1. Every `degraded` and every `down` verdict carries a `stillWorks` string, and the four the
 *     phase specified verbatim are asserted verbatim.
 *  2. A subsystem that is merely unconfigured is NEVER amber.
 *  3. `isServiceStillGoingOut()` stays true when OBS is down but the stream is up — the whole
 *     architecture in one assertion.
 *  4. The coalescing throttle emits the LAST state of a burst, and a subscriber that throws
 *     cannot stop the other subscribers or the aggregator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DROPPED_FRAME_DEGRADED_RATIO,
  HEALTH_EMIT_INTERVAL_MS,
  HealthService,
  mapAsr,
  mapAutomation,
  mapObs,
  mapOverlay,
  mapRecording,
  mapStream,
  mapYouTube,
  realHealthTimers,
} from '@main/health/HealthService'
import type {
  HealthAsrLike,
  HealthCueLike,
  HealthGoLiveLike,
  HealthObsLike,
  HealthOverlayLike,
  HealthYouTubeLike,
} from '@main/health/HealthService'
import { createNullLogger } from '@main/logging/logger'
import { idleAsrStatus } from '@shared/asr'
import type { AsrStatus } from '@shared/asr'
import { idleCueEngineState } from '@shared/cue'
import type { CueEngineState } from '@shared/cue'
import { emptyObsOutputState, idleGoLiveState } from '@shared/golive'
import type { GoLiveState, ObsOutputState } from '@shared/golive'
import { SUBSYSTEMS, isServiceStillGoingOut, worstLevel } from '@shared/health'
import type { HealthSnapshot, SubsystemHealth, SubsystemId } from '@shared/health'
import type { OverlayServerInfo } from '@shared/ipc'
import { initialObsStatus } from '@shared/obs'
import type { ObsStatus } from '@shared/obs'
import { ok } from '@shared/result'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { YouTubeAuthStatus, YouTubeStatus } from '@shared/youtube'

// ---------------------------------------------------------------------------
// Module mocks, for the wiring test at the bottom
// ---------------------------------------------------------------------------

/**
 * Every sibling singleton is replaced wholesale, so importing `@main/health` needs neither
 * Electron, `obs-websocket-js`, `googleapis` nor a bound port — and so the wiring test can prove
 * that building the singleton subscribes to all six sources and calls nothing that acts.
 */
const wiring = vi.hoisted(() => ({
  subscribed: [] as string[],
  actions: [] as string[],
}))

vi.mock('@main/obs', () => ({
  getObsClient: () => ({
    getStatus: () => ({ state: 'not-configured', since: 0, attempt: 0 }),
    onStatus: () => {
      wiring.subscribed.push('obs')
      return () => undefined
    },
  }),
}))

vi.mock('@main/overlay', () => ({
  getOverlayServer: () => ({
    getInfo: () => ({
      running: false,
      host: '127.0.0.1',
      port: 7320,
      pageUrl: '',
      clients: 0,
      lastError: null,
    }),
    getState: () => ({ revision: 0 }),
    onInfo: () => {
      wiring.subscribed.push('overlay')
      return () => undefined
    },
    send: () => {
      wiring.actions.push('overlay.send')
      return { ok: true, value: {} }
    },
  }),
}))

vi.mock('@main/asr', () => ({
  getAsrService: () => ({
    getStatus: () => ({ ok: true, value: { state: 'not-configured' } }),
    onStatus: () => {
      wiring.subscribed.push('asr')
      return () => undefined
    },
  }),
}))

vi.mock('@main/youtube', () => ({
  getYouTubeService: () => ({
    getStatus: () => ({ auth: { state: 'not-configured', channel: null, lastError: null } }),
    onStatus: () => {
      wiring.subscribed.push('youtube')
      return () => undefined
    },
  }),
}))

vi.mock('@main/golive', () => ({
  getGoLiveService: () => ({
    getState: () => ({ phase: 'idle', obs: { streaming: false, recording: false } }),
    onState: () => {
      wiring.subscribed.push('goLive')
      return () => undefined
    },
  }),
}))

vi.mock('@main/cue', () => ({
  getCueEngine: () => ({
    getState: () => ({ ok: true, value: { enabled: true, alignment: 'no-plan', panicked: false } }),
    onState: () => {
      wiring.subscribed.push('cue')
      return () => undefined
    },
    dismiss: () => {
      wiring.actions.push('cue.dismiss')
      return { ok: true, value: undefined }
    },
  }),
}))

vi.mock('@main/plan', () => ({
  getPlanService: () => ({
    getState: () => ({ ok: true, value: { position: { index: -1 } } }),
    back: () => {
      wiring.actions.push('plan.back')
      return { ok: true, value: undefined }
    },
  }),
}))

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function obsStatus(overrides: Partial<ObsStatus> = {}): ObsStatus {
  return { ...initialObsStatus('not-configured', 0), ...overrides }
}

function overlayInfo(overrides: Partial<OverlayServerInfo> = {}): OverlayServerInfo {
  return {
    running: true,
    host: '127.0.0.1',
    port: 7320,
    pageUrl: 'http://127.0.0.1:7320/overlay',
    clients: 1,
    lastError: null,
    ...overrides,
  }
}

function asrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return { ...idleAsrStatus(), ...overrides }
}

function youTubeStatus(auth: Partial<YouTubeAuthStatus> = {}): YouTubeStatus {
  return {
    auth: { state: 'not-configured', channel: null, lastError: null, ...auth },
    broadcast: null,
    stream: null,
    template: defaultBroadcastTemplate(),
    preflight: [],
  }
}

function goLiveState(
  obs: Partial<ObsOutputState> = {},
  overrides: Partial<Omit<GoLiveState, 'obs'>> = {},
): GoLiveState {
  return {
    ...idleGoLiveState(),
    ...overrides,
    obs: { ...emptyObsOutputState(), ...obs },
  }
}

function cueState(overrides: Partial<CueEngineState> = {}): CueEngineState {
  return { ...idleCueEngineState(), ...overrides }
}

/** A controllable source: `push()` drives the subscriber the service registered. */
class Source<T> {
  private readonly listeners = new Set<(value: T) => void>()
  subscribeCount = 0

  constructor(public current: T) {}

  readonly subscribe = (callback: (value: T) => void): (() => void) => {
    this.subscribeCount += 1
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  push(value: T): void {
    this.current = value
    for (const listener of [...this.listeners]) listener(value)
  }
}

interface Harness {
  readonly service: HealthService
  readonly obs: Source<ObsStatus>
  readonly overlay: Source<OverlayServerInfo>
  readonly asr: Source<AsrStatus>
  readonly youtube: Source<YouTubeStatus>
  readonly goLive: Source<GoLiveState>
  readonly cue: Source<CueEngineState>
  readonly snapshots: HealthSnapshot[]
  advance(ms: number): void
  light(id: SubsystemId): SubsystemHealth
}

let clock = 1_000

function build(minEmitIntervalMs = HEALTH_EMIT_INTERVAL_MS): Harness {
  const obs = new Source<ObsStatus>(obsStatus())
  const overlay = new Source<OverlayServerInfo>(overlayInfo())
  const asr = new Source<AsrStatus>(asrStatus({ state: 'not-configured' }))
  const youtube = new Source<YouTubeStatus>(youTubeStatus())
  const goLive = new Source<GoLiveState>(goLiveState())
  const cue = new Source<CueEngineState>(cueState())

  const obsSeam: HealthObsLike = { getStatus: () => obs.current, onStatus: obs.subscribe }
  const overlaySeam: HealthOverlayLike = {
    getInfo: () => overlay.current,
    onInfo: overlay.subscribe,
  }
  const asrSeam: HealthAsrLike = { getStatus: () => ok(asr.current), onStatus: asr.subscribe }
  const youtubeSeam: HealthYouTubeLike = {
    getStatus: () => youtube.current,
    onStatus: youtube.subscribe,
  }
  const goLiveSeam: HealthGoLiveLike = { getState: () => goLive.current, onState: goLive.subscribe }
  const cueSeam: HealthCueLike = { getState: () => ok(cue.current), onState: cue.subscribe }

  const service = new HealthService({
    obs: obsSeam,
    overlay: overlaySeam,
    asr: asrSeam,
    youtube: youtubeSeam,
    goLive: goLiveSeam,
    cue: cueSeam,
    logger: createNullLogger(),
    now: () => clock,
    timers: realHealthTimers,
    minEmitIntervalMs,
  })

  const snapshots: HealthSnapshot[] = []
  service.onSnapshot((snapshot) => {
    snapshots.push(snapshot)
  })
  service.start()

  return {
    service,
    obs,
    overlay,
    asr,
    youtube,
    goLive,
    cue,
    snapshots,
    advance: (ms: number) => {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
    light: (id: SubsystemId) => {
      const snapshot = service.getSnapshot()
      if (!snapshot.ok) throw new Error('the service refused to report')
      const found = snapshot.value.subsystems.find((subsystem) => subsystem.id === id)
      if (found === undefined) throw new Error(`no light for ${id}`)
      return found
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000
  wiring.subscribed.length = 0
  wiring.actions.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// The mappers
// ---------------------------------------------------------------------------

describe('mapObs', () => {
  it('says exactly what still works when OBS drops while streaming', () => {
    const verdict = mapObs(obsStatus({ state: 'disconnected' }), {
      ...emptyObsOutputState(),
      streaming: true,
      recording: true,
    })

    expect(verdict.level).toBe('down')
    expect(verdict.detail).toBe('not connected to Verger')
    expect(verdict.stillWorks).toBe(
      'OBS is still streaming and recording on its own — Verger just cannot see it',
    )
  })

  it('is not-configured, never amber, without an address', () => {
    const verdict = mapObs(obsStatus({ state: 'not-configured' }), null)
    expect(verdict.level).toBe('not-configured')
    expect(verdict.stillWorks).toBeNull()
  })

  it('counts reconnect attempts in the detail', () => {
    const verdict = mapObs(obsStatus({ state: 'reconnecting', attempt: 3 }), null)
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('reconnecting (attempt 3)')
    expect(verdict.stillWorks).not.toBeNull()
  })

  it('is down and terminal on a rejected password', () => {
    const verdict = mapObs(obsStatus({ state: 'auth-failed' }), null)
    expect(verdict.level).toBe('down')
    expect(verdict.detail).toBe('the OBS password was rejected')
    expect(verdict.detail).not.toContain('reconnect')
  })

  it('names the program scene when connected', () => {
    const verdict = mapObs(obsStatus({ state: 'connected', currentProgramScene: 'Cam 1' }), null)
    expect(verdict).toEqual({ level: 'ok', detail: 'connected — scene "Cam 1"', stillWorks: null })
  })
})

describe('mapOverlay', () => {
  it('is amber with the server up and no browser source attached', () => {
    const verdict = mapOverlay(overlayInfo({ clients: 0 }))
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('no browser source attached')
    expect(verdict.stillWorks).toBe('cameras and streaming are unaffected')
  })

  it('is down when the server is not running, and still says what works', () => {
    const verdict = mapOverlay(overlayInfo({ running: false, clients: 0 }))
    expect(verdict.level).toBe('down')
    expect(verdict.stillWorks).toBe('cameras and streaming are unaffected')
  })

  it('counts attached sources when healthy', () => {
    expect(mapOverlay(overlayInfo({ clients: 1 })).detail).toBe('1 browser source attached')
    expect(mapOverlay(overlayInfo({ clients: 2 })).detail).toBe('2 browser sources attached')
    expect(mapOverlay(overlayInfo({ clients: 2 })).level).toBe('ok')
  })
})

describe('mapAsr', () => {
  it('tells the operator the plan still advances manually when the recogniser fails', () => {
    const verdict = mapAsr(asrStatus({ state: 'failed', lastError: 'the model process exited' }))
    expect(verdict.level).toBe('down')
    expect(verdict.detail).toBe('the model process exited')
    expect(verdict.stillWorks).toBe('cue suggestions are off; the plan still advances manually')
  })

  it('is amber, with the fallback named, when it falls back to local', () => {
    const verdict = mapAsr(asrStatus({ state: 'degraded', provider: 'whisper' }))
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('fell back to whisper')
    expect(verdict.stillWorks).toBe('transcription is still arriving, so cue suggestions keep working')
  })

  it('is not-configured, never amber, with no recogniser configured', () => {
    expect(mapAsr(asrStatus({ state: 'not-configured' })).level).toBe('not-configured')
  })

  it('treats idle and listening as working', () => {
    expect(mapAsr(asrStatus({ state: 'idle' })).level).toBe('ok')
    expect(mapAsr(asrStatus({ state: 'listening', provider: 'whisper', latencyMs: 420 }))).toEqual({
      level: 'ok',
      detail: 'listening via whisper (420 ms)',
      stillWorks: null,
    })
  })
})

describe('mapYouTube', () => {
  it('is not-configured — not amber — when signed out, so amber keeps its meaning', () => {
    expect(mapYouTube({ state: 'signed-out', channel: null, lastError: null }).level).toBe(
      'not-configured',
    )
    expect(mapYouTube({ state: 'not-configured', channel: null, lastError: null }).level).toBe(
      'not-configured',
    )
  })

  it('is down on an auth error and says OBS keeps going', () => {
    const verdict = mapYouTube({ state: 'auth-error', channel: null, lastError: 'token revoked' })
    expect(verdict.level).toBe('down')
    expect(verdict.detail).toBe('token revoked')
    expect(verdict.stillWorks).toBe(
      'OBS keeps streaming and recording; only the YouTube broadcast controls are unavailable',
    )
  })

  it('names the channel when signed in', () => {
    const verdict = mapYouTube({
      state: 'signed-in',
      channel: { id: 'c1', title: 'Grace Church', customUrl: null },
      lastError: null,
    })
    expect(verdict).toEqual({ level: 'ok', detail: 'signed in as Grace Church', stillWorks: null })
  })
})

describe('mapRecording', () => {
  it('is red when the stream is live and nothing is recording (Standing Rule 3)', () => {
    const verdict = mapRecording(goLiveState({ streaming: true, recording: false }))
    expect(verdict.level).toBe('down')
    expect(verdict.stillWorks).toBe(
      'the stream is still going out — but there is no local backup if it drops',
    )
  })

  it('is amber while paused, and says the stream is unaffected', () => {
    const verdict = mapRecording(
      goLiveState({ streaming: true, recording: true, recordingPaused: true }),
    )
    expect(verdict.level).toBe('degraded')
    expect(verdict.stillWorks).toBe('the stream is still going out')
  })

  it('rests rather than alarms before anything has started', () => {
    expect(mapRecording(goLiveState()).level).toBe('not-configured')
  })

  it('names the file it is writing', () => {
    const verdict = mapRecording(goLiveState({ recording: true, recordingPath: 'D:/svc.mkv' }))
    expect(verdict).toEqual({ level: 'ok', detail: 'recording to D:/svc.mkv', stillWorks: null })
  })
})

describe('mapStream', () => {
  it('says the local recording is unaffected while reconnecting', () => {
    const verdict = mapStream(
      goLiveState({ streaming: true, recording: true, streamReconnecting: true }),
    )
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('reconnecting to the ingest server')
    expect(verdict.stillWorks).toBe('the local recording is unaffected')
  })

  it('is amber, not green, while OBS pushes to a broadcast that never went public', () => {
    const verdict = mapStream(goLiveState({ streaming: true, recording: true }, { phase: 'partial' }))
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('pushing to YouTube, but the broadcast is not public yet')
    expect(verdict.stillWorks).toBe('the local recording is unaffected')
  })

  it('turns amber once dropped frames pass the threshold, and not before', () => {
    const below = mapStream(
      goLiveState({ streaming: true, skippedFrames: 1, totalFrames: 1_000 }),
    )
    expect(below.level).toBe('ok')

    const ratio = DROPPED_FRAME_DEGRADED_RATIO
    const above = mapStream(
      goLiveState({ streaming: true, skippedFrames: Math.ceil(1_000 * ratio), totalFrames: 1_000 }),
    )
    expect(above.level).toBe('degraded')
    expect(above.stillWorks).toBe('the local recording is unaffected')
  })

  it('rests when nothing was ever started, and reddens when going live failed', () => {
    expect(mapStream(goLiveState()).level).toBe('not-configured')
    const failed = mapStream(goLiveState({}, { phase: 'failed', lastError: 'ingest refused' }))
    expect(failed.level).toBe('down')
    expect(failed.detail).toBe('ingest refused')
  })
})

describe('mapAutomation', () => {
  it('treats panic as amber with everything downstream named as untouched', () => {
    const verdict = mapAutomation(cueState({ panicked: true, mode: 'manual' }))
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('PANIC — automation halted, full manual')
    expect(verdict.stillWorks).toBe(
      'the stream, the recording and the overlay are untouched; the plan still advances manually',
    )
  })

  it('is amber and explicit when the speaker goes off script', () => {
    const verdict = mapAutomation(cueState({ alignment: 'lost' }))
    expect(verdict.level).toBe('degraded')
    expect(verdict.detail).toBe('off script — not following the plan')
    expect(verdict.stillWorks).not.toBeNull()
  })

  it('rests with no plan loaded and with automation switched off', () => {
    expect(mapAutomation(cueState({ alignment: 'no-plan' })).level).toBe('not-configured')
    expect(mapAutomation(cueState({ enabled: false, alignment: 'aligned' })).level).toBe(
      'not-configured',
    )
  })
})

describe('every degraded and down verdict', () => {
  it('carries a stillWorks string, and every ok and not-configured one does not', () => {
    const verdicts = [
      mapObs(obsStatus({ state: 'reconnecting' }), null),
      mapObs(obsStatus({ state: 'disconnected' }), null),
      mapObs(obsStatus({ state: 'auth-failed' }), null),
      mapObs(obsStatus({ state: 'connecting' }), null),
      mapObs(obsStatus({ state: 'idle' }), null),
      mapObs(obsStatus({ state: 'connected' }), null),
      mapObs(obsStatus({ state: 'not-configured' }), null),
      mapOverlay(overlayInfo({ clients: 0 })),
      mapOverlay(overlayInfo({ running: false })),
      mapOverlay(overlayInfo({ lastError: 'EADDRINUSE' })),
      mapOverlay(overlayInfo()),
      ...(['not-configured', 'idle', 'starting', 'listening', 'degraded', 'failed'] as const).map(
        (state) => mapAsr(asrStatus({ state })),
      ),
      ...(
        ['not-configured', 'signed-out', 'authorizing', 'signed-in', 'auth-error'] as const
      ).map((state) => mapYouTube({ state, channel: null, lastError: null })),
      mapRecording(goLiveState({ streaming: true })),
      mapRecording(goLiveState({ recording: true, recordingPaused: true })),
      mapRecording(goLiveState({ recording: true })),
      mapRecording(goLiveState()),
      mapStream(goLiveState({ streaming: true, streamReconnecting: true })),
      mapStream(goLiveState({ streaming: true })),
      mapStream(goLiveState({}, { phase: 'failed' })),
      mapStream(goLiveState()),
      mapAutomation(cueState({ panicked: true })),
      mapAutomation(cueState({ alignment: 'lost' })),
      mapAutomation(cueState({ alignment: 'aligned' })),
      mapAutomation(cueState()),
    ]

    for (const verdict of verdicts) {
      if (verdict.level === 'degraded' || verdict.level === 'down') {
        expect(verdict.stillWorks, `"${verdict.detail}" must say what still works`).toBeTruthy()
      } else {
        expect(verdict.stillWorks, `"${verdict.detail}" is not a failure`).toBeNull()
      }
      expect(verdict.detail.length).toBeGreaterThan(0)
    }
  })

  it('never turns a merely unconfigured subsystem amber', () => {
    const unconfigured = [
      mapObs(obsStatus({ state: 'not-configured' }), null),
      mapAsr(asrStatus({ state: 'not-configured' })),
      mapYouTube({ state: 'not-configured', channel: null, lastError: null }),
      mapYouTube({ state: 'signed-out', channel: null, lastError: null }),
      mapRecording(goLiveState()),
      mapStream(goLiveState()),
      mapAutomation(cueState({ alignment: 'no-plan' })),
    ]
    for (const verdict of unconfigured) {
      expect(verdict.level).toBe('not-configured')
    }
  })
})

// ---------------------------------------------------------------------------
// The aggregator
// ---------------------------------------------------------------------------

describe('HealthService', () => {
  it('seeds a light for every subsystem from the sources at start', () => {
    const harness = build()
    const snapshot = harness.service.getSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return

    expect(snapshot.value.subsystems.map((subsystem) => subsystem.id)).toEqual([...SUBSYSTEMS])
    expect(harness.obs.subscribeCount).toBe(1)
    expect(harness.overlay.subscribeCount).toBe(1)
    expect(harness.asr.subscribeCount).toBe(1)
    expect(harness.youtube.subscribeCount).toBe(1)
    expect(harness.goLive.subscribeCount).toBe(1)
    expect(harness.cue.subscribeCount).toBe(1)
  })

  it('rolls the worst level up, with not-configured ranking below degraded', () => {
    const harness = build()
    harness.overlay.push(overlayInfo({ clients: 1 }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)

    const resting = harness.service.getSnapshot()
    expect(resting.ok && resting.value.worst).toBe('not-configured')

    harness.asr.push(asrStatus({ state: 'degraded', provider: 'whisper' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    const amber = harness.service.getSnapshot()
    expect(amber.ok && amber.value.worst).toBe('degraded')

    harness.obs.push(obsStatus({ state: 'disconnected' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    const red = harness.service.getSnapshot()
    expect(red.ok && red.value.worst).toBe('down')
    if (red.ok) expect(worstLevel(red.value.subsystems)).toBe('down')
  })

  it('keeps the service "still going out" when OBS is down but the stream is up', () => {
    const harness = build()

    harness.goLive.push(goLiveState({ streaming: true, recording: true }, { phase: 'live' }))
    harness.obs.push(obsStatus({ state: 'disconnected' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)

    const snapshot = harness.service.getSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return

    expect(harness.light('obs').level).toBe('down')
    expect(snapshot.value.worst).toBe('down')
    // The whole point of the architecture: a red OBS light is not a stopped service.
    expect(isServiceStillGoingOut(snapshot.value)).toBe(true)
    expect(harness.light('obs').stillWorks).toBe(
      'OBS is still streaming and recording on its own — Verger just cannot see it',
    )
  })

  it('reports the service as not going out when nothing is streaming or recording', () => {
    const harness = build()
    const snapshot = harness.service.getSnapshot()
    expect(snapshot.ok && isServiceStillGoingOut(snapshot.value)).toBe(false)
  })

  it('holds `since` while a level persists and moves it when the level changes', () => {
    const harness = build()
    harness.obs.push(obsStatus({ state: 'reconnecting', attempt: 1 }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    const first = harness.light('obs').since

    harness.obs.push(obsStatus({ state: 'reconnecting', attempt: 2 }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    expect(harness.light('obs').detail).toBe('reconnecting (attempt 2)')
    expect(harness.light('obs').since).toBe(first)

    harness.obs.push(obsStatus({ state: 'disconnected' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    expect(harness.light('obs').since).toBeGreaterThan(first)
  })

  it('emits the LAST state of a burst, not the first (a trailing-edge throttle)', () => {
    const harness = build()
    harness.snapshots.length = 0

    // A reconnect loop chattering inside one window.
    harness.obs.push(obsStatus({ state: 'reconnecting', attempt: 1 }))
    harness.advance(10)
    harness.obs.push(obsStatus({ state: 'reconnecting', attempt: 2 }))
    harness.advance(10)
    harness.obs.push(obsStatus({ state: 'reconnecting', attempt: 3 }))
    harness.advance(10)
    harness.obs.push(obsStatus({ state: 'connected', currentProgramScene: 'Cam 1' }))

    // The window opened by the start snapshot is still closing, so nothing has gone out yet —
    // and a leading-edge-only throttle would now drop every one of those four changes.
    expect(harness.snapshots.length).toBe(0)

    harness.advance(HEALTH_EMIT_INTERVAL_MS)

    expect(harness.snapshots.length).toBe(1)
    const last = harness.snapshots[harness.snapshots.length - 1]
    expect(last).toBeDefined()
    const obsLight = last?.subsystems.find((subsystem) => subsystem.id === 'obs')
    expect(obsLight?.level).toBe('ok')
    expect(obsLight?.detail).toBe('connected — scene "Cam 1"')
  })

  it('coalesces a burst to at most ~4 snapshots a second', () => {
    const harness = build()
    harness.snapshots.length = 0

    for (let attempt = 1; attempt <= 40; attempt += 1) {
      harness.obs.push(obsStatus({ state: 'reconnecting', attempt }))
      harness.advance(25)
    }
    harness.advance(HEALTH_EMIT_INTERVAL_MS)

    // 40 changes across 1 second must not become 40 IPC messages.
    expect(harness.snapshots.length).toBeLessThanOrEqual(6)
    expect(harness.snapshots.length).toBeGreaterThan(0)
    const last = harness.snapshots[harness.snapshots.length - 1]
    expect(last?.subsystems.find((subsystem) => subsystem.id === 'obs')?.detail).toBe(
      'reconnecting (attempt 40)',
    )
  })

  it('does not emit when nothing an operator can see has changed', () => {
    const harness = build()
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    harness.snapshots.length = 0

    // Same state, pushed again: `since` and the timestamps move, the lights do not.
    harness.obs.push(obsStatus())
    harness.advance(HEALTH_EMIT_INTERVAL_MS * 2)
    expect(harness.snapshots).toEqual([])
  })

  it('contains a throwing subscriber: the others still receive the snapshot', () => {
    const harness = build()
    const seen: string[] = []

    harness.service.onSnapshot(() => {
      seen.push('before')
      throw new Error('the renderer bridge is gone')
    })
    harness.service.onSnapshot(() => {
      seen.push('after')
    })

    harness.obs.push(obsStatus({ state: 'disconnected' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)

    expect(seen).toContain('before')
    expect(seen).toContain('after')

    // And the aggregator is still alive and still updating.
    harness.asr.push(asrStatus({ state: 'failed', lastError: 'gone' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    expect(harness.light('asr').level).toBe('down')
  })

  it('survives a source that throws when read, and keeps the other lights', () => {
    const exploding: HealthObsLike = {
      getStatus: () => {
        throw new Error('the OBS client is mid-teardown')
      },
      onStatus: () => () => undefined,
    }
    const service = new HealthService({
      obs: exploding,
      overlay: { getInfo: () => overlayInfo({ clients: 0 }), onInfo: () => () => undefined },
      asr: { getStatus: () => ok(asrStatus()), onStatus: () => () => undefined },
      youtube: { getStatus: () => youTubeStatus(), onStatus: () => () => undefined },
      goLive: { getState: () => goLiveState(), onState: () => () => undefined },
      cue: { getState: () => ok(cueState()), onState: () => () => undefined },
      logger: createNullLogger(),
      now: () => clock,
    })

    expect(() => service.start()).not.toThrow()
    const snapshot = service.getSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.subsystems.find((s) => s.id === 'obs')?.level).toBe('not-configured')
    expect(snapshot.value.subsystems.find((s) => s.id === 'overlay')?.level).toBe('degraded')
    service.dispose()
  })

  it('stops publishing and releases its sources once disposed', () => {
    const harness = build()
    harness.advance(HEALTH_EMIT_INTERVAL_MS)
    harness.snapshots.length = 0

    harness.service.dispose()
    harness.obs.push(obsStatus({ state: 'disconnected' }))
    harness.advance(HEALTH_EMIT_INTERVAL_MS * 4)

    expect(harness.snapshots).toEqual([])
    expect(harness.service.getSnapshot().ok).toBe(false)
  })

  it('refreshes on demand for state that changed without an event', () => {
    const harness = build()
    harness.overlay.current = overlayInfo({ clients: 0 })
    const refreshed = harness.service.refresh()
    expect(refreshed.ok).toBe(true)
    expect(harness.light('overlay').detail).toBe('no browser source attached')
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('getHealthService', () => {
  it('is zero-arg callable, subscribes to all six sources, and acts on nothing', async () => {
    const module = await import('@main/health')

    const service = module.getHealthService()
    expect(service).toBeInstanceOf(HealthService)
    expect(module.getHealthService()).toBe(service)

    // The point of this test: the aggregator built by the real wiring is CONNECTED. Four phases
    // shipped a component wired to nothing and every unit test passed (STATUS.md cycles 2, 4, 5, 8).
    expect([...wiring.subscribed].sort()).toEqual(['asr', 'cue', 'goLive', 'obs', 'overlay', 'youtube'])

    // …and it did nothing that changes what the congregation sees.
    expect(wiring.actions).toEqual([])

    const snapshot = service.getSnapshot()
    expect(snapshot.ok).toBe(true)
    if (snapshot.ok) expect(snapshot.value.subsystems).toHaveLength(SUBSYSTEMS.length)

    module.resetHealthService()
  })
})
