/**
 * `GoLiveService` behaviour — the most safety-critical suite in the project.
 *
 * Everything here runs against hand-written doubles and fake timers: no OBS Studio, no Google
 * account, no network, no real clock. That is not a convenience, it is the requirement — the
 * machine this was written on has neither OBS nor credentials, and "the recording always starts"
 * has to be provable on a laptop rather than discovered on a Sunday.
 *
 * Three promises are asserted here, and each is worth stating plainly:
 *
 *  1. **Recording starts whenever streaming does** (Standing Rule 3). Asserted structurally —
 *     the service has no way to start one output on its own, because the seam has no such verb
 *     and the source contains no such call — and behaviourally on every path that streams.
 *  2. **Verger never stops the broadcast as a reaction to its own error.** Every failure path
 *     asserts that `stopStream` and `stopRecord` were NOT called.
 *  3. **A crash mid-service is re-attached to, not double-started.** The re-attach test asserts
 *     that not one start request is issued.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GoLiveService, deriveLiveSince, isHealthy } from '@main/golive/GoLiveService'
import type { GoLiveOutputs, GoLiveYouTube, StartOutputsSummary } from '@main/golive/GoLiveService'
import { createNullLogger } from '@main/logging/logger'
import { GO_LIVE_STEPS, emptyObsOutputState } from '@shared/golive'
import type { GoLiveState, GoLiveStep, ObsOutputState, StepState } from '@shared/golive'
import { ErrorCode, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { BroadcastLifecycle, StreamHealth, YouTubeStatus } from '@shared/youtube'

// ---------------------------------------------------------------------------
// Module mocks, for the wiring test at the bottom
// ---------------------------------------------------------------------------

/**
 * The OBS client and the YouTube service are replaced wholesale so that importing
 * `@main/golive` needs neither `obs-websocket-js` nor Electron — and so the wiring test can
 * prove that building the singleton talks to neither of them.
 */
const wiring = vi.hoisted(() => ({ obsRequests: [] as string[], youtubeCalls: [] as string[] }))

vi.mock('@main/obs', () => ({
  getObsClient: () => ({
    call: (requestType: string) => {
      wiring.obsRequests.push(requestType)
      return Promise.resolve({
        ok: false,
        error: { code: 'NOT_CONNECTED', message: 'there is no OBS in a unit test' }
      })
    },
    getStatus: () => ({ state: 'not-configured' }),
    onStatus: () => () => undefined
  })
}))

vi.mock('@main/youtube', () => ({
  getYouTubeService: () => ({
    getStatus: () => {
      wiring.youtubeCalls.push('getStatus')
      return {
        auth: { state: 'not-configured', channel: null, lastError: null },
        broadcast: null,
        stream: null,
        template: defaultBroadcastTemplate(),
        preflight: []
      }
    },
    createBroadcast: () => {
      wiring.youtubeCalls.push('createBroadcast')
      return Promise.resolve({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'no account' } })
    },
    transition: () => {
      wiring.youtubeCalls.push('transition')
      return Promise.resolve({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'no account' } })
    },
    pollStreamHealth: () => {
      wiring.youtubeCalls.push('pollStreamHealth')
      return Promise.resolve({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'no account' } })
    }
  })
}))

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const OBS_ERROR: AppError = { code: ErrorCode.OBS_ERROR, message: 'OBS said no' }

/**
 * A fully typed {@link GoLiveOutputs} that records every call, in order.
 *
 * Note that there is no way to make it start a stream without a recording: the seam it
 * implements has exactly one start verb. That is the design under test.
 */
class MockOutputs implements GoLiveOutputs {
  readonly calls: string[] = []

  state: ObsOutputState = emptyObsOutputState()

  /** How many times OBS was asked to start each output. These must never diverge. */
  streamStartRequests = 0
  recordStartRequests = 0

  /** Set to make the whole start call fail (OBS disconnected). */
  startFailure: AppError | null = null
  /** Set to make only `StartStream` fail. */
  streamError: AppError | null = null
  /** Set to make only `StartRecord` fail. */
  recordError: AppError | null = null
  readFailure: AppError | null = null
  stopStreamError: AppError | null = null
  stopRecordError: AppError | null = null
  /** Request names that throw, proving the service never lets an exception escape. */
  readonly throwing = new Set<string>()

  async readOutputState(): Promise<Result<ObsOutputState>> {
    this.calls.push('readOutputState')
    if (this.throwing.has('readOutputState')) throw new Error('the socket exploded')
    if (this.readFailure !== null) return { ok: false, error: this.readFailure }
    return ok(this.state)
  }

  async startStreamAndRecord(): Promise<Result<StartOutputsSummary>> {
    this.calls.push('startStreamAndRecord')
    if (this.throwing.has('startStreamAndRecord')) throw new Error('the socket exploded')
    if (this.startFailure !== null) return { ok: false, error: this.startFailure }

    // Both requests are issued, always — this double mirrors `ObsOutputs.startStreamAndRecord`,
    // which has no early return between the two sends.
    this.streamStartRequests += 1
    this.recordStartRequests += 1

    const streaming = this.streamError === null
    const recording = this.recordError === null
    this.state = {
      ...this.state,
      streaming: this.state.streaming || streaming,
      recording: this.state.recording || recording,
      streamTimecodeMs: streaming ? 0 : this.state.streamTimecodeMs,
      recordTimecodeMs: recording ? 0 : this.state.recordTimecodeMs,
      recordingPath: recording ? 'D:/services/2026-07-19.mkv' : this.state.recordingPath
    }
    return ok({
      streaming,
      recording,
      streamError: this.streamError,
      recordError: this.recordError
    })
  }

  async stopStream(): Promise<Result<unknown>> {
    this.calls.push('stopStream')
    if (this.stopStreamError !== null) return { ok: false, error: this.stopStreamError }
    this.state = { ...this.state, streaming: false }
    return ok({ request: 'StopStream' })
  }

  async stopRecord(): Promise<Result<unknown>> {
    this.calls.push('stopRecord')
    if (this.stopRecordError !== null) return { ok: false, error: this.stopRecordError }
    this.state = { ...this.state, recording: false }
    return ok({ request: 'StopRecord' })
  }

  /** Every call that could have started an output. Must be empty on the re-attach path. */
  startCalls(): readonly string[] {
    return this.calls.filter((call) => call.startsWith('start'))
  }

  /** Every stop. Must be empty on every GO LIVE failure path. */
  stopCalls(): readonly string[] {
    return this.calls.filter((call) => call.startsWith('stop'))
  }
}

function youtubeStatus(patch: Partial<YouTubeStatus> = {}): YouTubeStatus {
  return {
    auth: {
      state: 'signed-in',
      channel: { id: 'UC-church', title: 'Grace Church', customUrl: null },
      lastError: null
    },
    broadcast: null,
    stream: null,
    template: defaultBroadcastTemplate(),
    preflight: [],
    ...patch
  }
}

const BOUND_BROADCAST = {
  id: 'bc-1',
  title: 'Sunday Service — 2026-07-19',
  privacy: 'unlisted' as const,
  scheduledStartTime: '2026-07-19T10:00:00.000Z',
  lifecycle: 'ready' as BroadcastLifecycle,
  boundStreamId: 'st-1',
  watchUrl: 'https://youtu.be/bc-1'
}

class MockYouTube implements GoLiveYouTube {
  readonly calls: string[] = []

  status: YouTubeStatus = youtubeStatus()
  createError: AppError | null = null
  transitionError: AppError | null = null
  healthError: AppError | null = null
  /** The ingest health reported by each successive poll; the last value repeats. */
  health: StreamHealth = 'good'
  polls = 0

  getStatus(): YouTubeStatus {
    return this.status
  }

  async createBroadcast(): Promise<Result<unknown>> {
    this.calls.push('createBroadcast')
    if (this.createError !== null) return { ok: false, error: this.createError }
    this.status = { ...this.status, broadcast: BOUND_BROADCAST }
    return ok(BOUND_BROADCAST)
  }

  async transition(status: BroadcastLifecycle): Promise<Result<unknown>> {
    this.calls.push(`transition:${status}`)
    if (this.transitionError !== null) return { ok: false, error: this.transitionError }
    this.status = {
      ...this.status,
      broadcast:
        this.status.broadcast === null ? null : { ...this.status.broadcast, lifecycle: status }
    }
    return ok(this.status.broadcast)
  }

  async pollStreamHealth(): Promise<Result<{ readonly health: StreamHealth }>> {
    this.calls.push('pollStreamHealth')
    this.polls += 1
    if (this.healthError !== null) return { ok: false, error: this.healthError }
    return ok({ health: this.health })
  }
}

interface Harness {
  readonly service: GoLiveService
  readonly outputs: MockOutputs
  readonly youtube: MockYouTube
  readonly states: GoLiveState[]
}

function createHarness(patch: { healthTimeoutMs?: number; pollIntervalMs?: number } = {}): Harness {
  const outputs = new MockOutputs()
  const youtube = new MockYouTube()
  const states: GoLiveState[] = []

  const service = new GoLiveService({
    outputs,
    youtube,
    logger: createNullLogger(),
    pollIntervalMs: patch.pollIntervalMs ?? 1_000,
    healthTimeoutMs: patch.healthTimeoutMs ?? 10_000
  })
  service.onState((state) => states.push(state))

  return { service, outputs, youtube, states }
}

/** Drive a whole GO LIVE (or END) to completion through the fake clock. */
async function settle<T>(pending: Promise<T>, ms = 120_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return pending
}

function stepOf(state: GoLiveState, step: GoLiveStep): StepState {
  return state.steps.find((entry) => entry.step === step)?.state ?? 'pending'
}

function messageOf(state: GoLiveState, step: GoLiveStep): string | null {
  return state.steps.find((entry) => entry.step === step)?.message ?? null
}

/** The order in which steps first went `running`, across every published state. */
function runningOrder(states: readonly GoLiveState[]): readonly GoLiveStep[] {
  const seen: GoLiveStep[] = []
  for (const state of states) {
    for (const entry of state.steps) {
      if (entry.state === 'running' && !seen.includes(entry.step)) seen.push(entry.step)
    }
  }
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-19T09:55:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Standing Rule 3 — the recording is not optional
// ---------------------------------------------------------------------------

describe('always-on local recording (Standing Rule 3)', () => {
  it('has no code path that starts a stream without also starting a recording', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./GoLiveService.ts', import.meta.url)),
      'utf8'
    )

    // The seam has exactly one start verb, and the source calls exactly that. A `startStream(`
    // or `startRecord(` anywhere in this file — declaration or call — would mean the
    // orchestrator had acquired the ability to run one output without the other.
    expect(source).not.toMatch(/\bstartStream\s*\(/)
    expect(source).not.toMatch(/\bstartRecord\s*\(/)
    // Nor may it reach past the seam and send the raw requests itself. (String literals only:
    // naming them in a doc comment is documentation, not an OBS request.)
    expect(source).not.toMatch(/['"]StartStream['"]/)
    expect(source).not.toMatch(/['"]StartRecord['"]/)
    expect(source).toMatch(/startStreamAndRecord\s*\(/)

    // And there is deliberately no flag anywhere that could turn the recording off.
    expect(source).not.toMatch(/skipRecord|noRecord|recordingEnabled|disableRecord/i)
  })

  it('starts the recording with the stream on the happy path', async () => {
    const { service, outputs } = createHarness()

    await settle(service.start())

    expect(outputs.streamStartRequests).toBe(1)
    expect(outputs.recordStartRequests).toBe(1)
    expect(outputs.recordStartRequests).toBe(outputs.streamStartRequests)
    expect(outputs.state.recording).toBe(true)
  })

  it('reports a failed recording loudly and does NOT stop the stream', async () => {
    const { service, outputs } = createHarness()
    outputs.recordError = { code: ErrorCode.OBS_ERROR, message: 'the disk is full' }

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(stepOf(state, 'record')).toBe('failed')
    expect(messageOf(state, 'record')).toBe('the disk is full')
    expect(state.lastError).toContain('disk is full')
    // Loud, but never fatal to the broadcast: the stream is up and nothing was stopped.
    expect(stepOf(state, 'stream')).toBe('done')
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.state.streaming).toBe(true)
    // And the phase is honest: not a reassuring green LIVE while the backup is missing.
    expect(state.phase).toBe('partial')
  })

  it('still attempts the recording when the stream itself fails', async () => {
    const { service, outputs } = createHarness()
    outputs.streamError = { code: ErrorCode.OBS_ERROR, message: 'no ingest configured' }

    await settle(service.start())

    expect(outputs.recordStartRequests).toBe(1)
    const state = service.getState()
    expect(stepOf(state, 'stream')).toBe('failed')
    expect(stepOf(state, 'record')).toBe('done')
    // Recording locally with no stream is a partial service, not a failed one.
    expect(state.phase).toBe('partial')
    expect(outputs.stopCalls()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('GO LIVE — the happy path', () => {
  it('drives all five steps in order and lands live', async () => {
    const { service, outputs, youtube, states } = createHarness()
    const pressedAt = Date.now()

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(state.phase).toBe('live')
    expect(state.reattached).toBe(false)
    expect(state.lastError).toBeNull()

    expect(runningOrder(states)).toEqual([...GO_LIVE_STEPS])
    for (const step of GO_LIVE_STEPS) {
      expect(stepOf(state, step)).toBe('done')
    }

    expect(youtube.calls).toEqual([
      'createBroadcast',
      'pollStreamHealth',
      'transition:live'
    ])
    expect(outputs.calls).toContain('startStreamAndRecord')
    expect(outputs.stopCalls()).toEqual([])
    // The clock the operator sees starts when OBS started streaming, not when the sequence ended.
    expect(state.liveSince).toBe(pressedAt)
    expect(state.obs.recordingPath).toBe('D:/services/2026-07-19.mkv')
  })

  it('reuses a broadcast that is already created and bound', async () => {
    const { service, youtube } = createHarness()
    youtube.status = youtubeStatus({ broadcast: BOUND_BROADCAST })

    await settle(service.start())

    expect(youtube.calls).not.toContain('createBroadcast')
    expect(messageOf(service.getState(), 'broadcast')).toContain('reusing')
    expect(service.getState().phase).toBe('live')
  })

  it('publishes state after every step so the UI can render progress', async () => {
    const { service, states } = createHarness()

    await settle(service.start())

    // Every step must have been observed both running and settled by a subscriber — a UI that
    // only sees the final state renders a thirty-second freeze.
    for (const step of GO_LIVE_STEPS) {
      expect(states.some((state) => stepOf(state, step) === 'running')).toBe(true)
      expect(states.some((state) => stepOf(state, step) === 'done')).toBe(true)
    }
    expect(states[0]?.phase).toBe('starting')
    expect(states[states.length - 1]?.phase).toBe('live')
    expect(states.length).toBeGreaterThanOrEqual(GO_LIVE_STEPS.length * 2)
  })
})

// ---------------------------------------------------------------------------
// Degradation — the app must never wedge the broadcast
// ---------------------------------------------------------------------------

describe('GO LIVE — degradation', () => {
  it('lands partial when the YouTube transition fails, and stops nothing', async () => {
    const { service, outputs, youtube } = createHarness()
    youtube.transitionError = { code: ErrorCode.RATE_LIMITED, message: 'quota exceeded' }

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(state.phase).toBe('partial')
    expect(stepOf(state, 'transition')).toBe('failed')
    expect(state.lastError).toContain('quota exceeded')

    // The whole point: OBS is untouched by our failure.
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.state.streaming).toBe(true)
    expect(outputs.state.recording).toBe(true)
    expect(stepOf(state, 'stream')).toBe('done')
    expect(stepOf(state, 'record')).toBe('done')
  })

  it('lands partial when the ingest never becomes healthy, and stops nothing', async () => {
    const { service, outputs, youtube } = createHarness({
      healthTimeoutMs: 10_000,
      pollIntervalMs: 1_000
    })
    youtube.health = 'noData'

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(state.phase).toBe('partial')
    expect(stepOf(state, 'health')).toBe('failed')
    expect(messageOf(state, 'health')).toContain('still streaming and recording')

    // A timeout is not a reason to make an unhealthy broadcast public...
    expect(stepOf(state, 'transition')).toBe('skipped')
    expect(youtube.calls).not.toContain('transition:live')
    // ...nor a reason to take anything down.
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.state.streaming).toBe(true)
    expect(outputs.state.recording).toBe(true)
    expect(youtube.polls).toBeGreaterThan(1)
  })

  it('goes live once a slow ingest turns healthy', async () => {
    const { service, youtube } = createHarness({ healthTimeoutMs: 30_000, pollIntervalMs: 1_000 })
    youtube.health = 'noData'
    // Flip to healthy after a few polls, exactly as YouTube does in the first half-minute.
    const original = youtube.pollStreamHealth.bind(youtube)
    youtube.pollStreamHealth = async () => {
      const answer = await original()
      if (youtube.polls >= 3) youtube.health = 'good'
      return answer
    }

    await settle(service.start())

    expect(service.getState().phase).toBe('live')
    expect(stepOf(service.getState(), 'health')).toBe('done')
  })

  it('fails — and stops nothing — when OBS starts neither output', async () => {
    const { service, outputs } = createHarness()
    outputs.startFailure = { code: ErrorCode.NOT_CONNECTED, message: 'OBS is not connected' }

    const result = await settle(service.start())

    expect(result.ok).toBe(false)
    const state = service.getState()
    expect(state.phase).toBe('failed')
    expect(stepOf(state, 'stream')).toBe('failed')
    expect(stepOf(state, 'record')).toBe('failed')
    expect(stepOf(state, 'health')).toBe('skipped')
    expect(stepOf(state, 'transition')).toBe('skipped')
    expect(outputs.stopCalls()).toEqual([])
  })

  it('carries on to stream and record when the broadcast cannot be created', async () => {
    const { service, outputs, youtube } = createHarness()
    youtube.createError = { code: ErrorCode.RATE_LIMITED, message: 'the daily quota is spent' }

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(stepOf(state, 'broadcast')).toBe('failed')
    // The service still happens, locally and to OBS's configured ingest.
    expect(stepOf(state, 'stream')).toBe('done')
    expect(stepOf(state, 'record')).toBe('done')
    expect(stepOf(state, 'transition')).toBe('skipped')
    expect(state.phase).toBe('partial')
    expect(outputs.stopCalls()).toEqual([])
  })

  it('never lets a throwing dependency escape', async () => {
    const { service, outputs } = createHarness()
    outputs.throwing.add('startStreamAndRecord')

    const result = await settle(service.start())

    expect(result.ok).toBe(false)
    expect(service.getState().phase).toBe('failed')
    expect(service.getState().lastError).toContain('exploded')
  })
})

// ---------------------------------------------------------------------------
// No Google account on this machine
// ---------------------------------------------------------------------------

describe('GO LIVE — YouTube not configured', () => {
  it('skips the broadcast and the transition but still streams and records', async () => {
    const { service, outputs, youtube } = createHarness()
    youtube.status = youtubeStatus({
      auth: { state: 'not-configured', channel: null, lastError: null }
    })

    const result = await settle(service.start())

    expect(result.ok).toBe(true)
    const state = service.getState()

    expect(stepOf(state, 'broadcast')).toBe('skipped')
    expect(stepOf(state, 'transition')).toBe('skipped')
    expect(messageOf(state, 'broadcast')).toContain('not configured')

    expect(stepOf(state, 'stream')).toBe('done')
    expect(stepOf(state, 'record')).toBe('done')
    expect(stepOf(state, 'health')).toBe('done')
    expect(outputs.streamStartRequests).toBe(1)
    expect(outputs.recordStartRequests).toBe(1)

    // Degraded but working is `live`: there is nothing outstanding to fix.
    expect(state.phase).toBe('live')
    expect(state.lastError).toBeNull()
    // Not one YouTube call was attempted — no quota, no network, no OAuth.
    expect(youtube.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// END
// ---------------------------------------------------------------------------

describe('END', () => {
  it('transitions, stops the stream, and stops the recording LAST', async () => {
    const { service, outputs, youtube } = createHarness()
    await settle(service.start())
    outputs.calls.length = 0
    youtube.calls.length = 0

    const result = await settle(service.end())

    expect(result.ok).toBe(true)
    expect(youtube.calls).toEqual(['transition:complete'])
    // The order is the guarantee: the local file is closed only after everything else.
    expect(outputs.calls.filter((call) => call.startsWith('stop'))).toEqual([
      'stopStream',
      'stopRecord'
    ])
    expect(outputs.calls.indexOf('stopRecord')).toBeGreaterThan(outputs.calls.indexOf('stopStream'))

    const state = service.getState()
    expect(state.phase).toBe('idle')
    expect(state.liveSince).toBeNull()
    expect(outputs.state.streaming).toBe(false)
    expect(outputs.state.recording).toBe(false)
  })

  it('stops both outputs even when the YouTube transition fails', async () => {
    const { service, outputs, youtube } = createHarness()
    await settle(service.start())
    outputs.calls.length = 0
    youtube.transitionError = { code: ErrorCode.TIMEOUT, message: 'YouTube did not answer' }

    const result = await settle(service.end())

    expect(result.ok).toBe(false)
    expect(outputs.calls.filter((call) => call.startsWith('stop'))).toEqual([
      'stopStream',
      'stopRecord'
    ])
    expect(outputs.state.streaming).toBe(false)
    expect(outputs.state.recording).toBe(false)
    expect(service.getState().phase).toBe('idle')
  })

  it('still stops the recording when stopping the stream fails', async () => {
    const { service, outputs } = createHarness()
    await settle(service.start())
    outputs.stopStreamError = { code: ErrorCode.OBS_ERROR, message: 'OBS refused StopStream' }
    outputs.calls.length = 0

    const result = await settle(service.end())

    expect(result.ok).toBe(false)
    expect(outputs.calls).toContain('stopRecord')
    expect(outputs.state.recording).toBe(false)
    // OBS is still streaming, so the phase says so rather than pretending the service ended.
    expect(service.getState().phase).toBe('failed')
    expect(service.getState().lastError).toContain('still streaming')
  })

  it('is a no-op success while idle', async () => {
    const { service, outputs, youtube } = createHarness()

    const result = await service.end()

    expect(result.ok).toBe(true)
    expect(service.getState().phase).toBe('idle')
    expect(outputs.calls).toEqual([])
    expect(youtube.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Crash re-attach
// ---------------------------------------------------------------------------

describe('re-attach after a crash', () => {
  it('adopts an OBS session that is already streaming and recording, issuing no Start*', async () => {
    const { service, outputs, youtube } = createHarness()
    outputs.state = {
      ...emptyObsOutputState(),
      streaming: true,
      recording: true,
      streamTimecodeMs: 12 * 60_000,
      recordTimecodeMs: 12 * 60_000,
      recordingPath: 'D:/services/2026-07-19.mkv'
    }

    const result = await service.initialize()

    expect(result.ok).toBe(true)
    const state = service.getState()
    expect(state.phase).toBe('live')
    expect(state.reattached).toBe(true)
    // Derived from OBS's timecode, never invented.
    expect(state.liveSince).toBe(Date.now() - 12 * 60_000)
    expect(state.obs.recordingPath).toBe('D:/services/2026-07-19.mkv')

    expect(stepOf(state, 'stream')).toBe('done')
    expect(stepOf(state, 'record')).toBe('done')
    expect(messageOf(state, 'stream')).toContain('already streaming')

    // The whole point of re-attaching: nothing was started, and nothing was asked of YouTube.
    expect(outputs.startCalls()).toEqual([])
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.calls).toEqual(['readOutputState'])
    expect(youtube.calls).toEqual([])
  })

  it('adopts a recording-only session as partial and says the backup is unmatched', async () => {
    const { service, outputs } = createHarness()
    outputs.state = { ...emptyObsOutputState(), streaming: true, recording: false, streamTimecodeMs: 1_000 }

    await service.initialize()

    const state = service.getState()
    expect(state.phase).toBe('partial')
    expect(state.reattached).toBe(true)
    expect(stepOf(state, 'record')).toBe('skipped')
    expect(state.lastError).toContain('no backup')
    expect(outputs.startCalls()).toEqual([])
  })

  it('refuses a GO LIVE once it has re-attached, so nothing is double-started', async () => {
    const { service, outputs } = createHarness()
    outputs.state = { ...emptyObsOutputState(), streaming: true, recording: true }

    await service.initialize()
    const result = await service.start()

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('already live')
    expect(outputs.startCalls()).toEqual([])
  })

  it('stays idle when OBS is not running anything', async () => {
    const { service } = createHarness()

    const result = await service.initialize()

    expect(result.ok).toBe(true)
    expect(service.getState().phase).toBe('idle')
    expect(service.getState().reattached).toBe(false)
  })

  it('stays idle and reports the failure when OBS cannot be read', async () => {
    const { service, outputs } = createHarness()
    outputs.readFailure = { code: ErrorCode.NOT_CONNECTED, message: 'OBS is not open yet' }

    const result = await service.initialize()

    expect(result.ok).toBe(false)
    expect(service.getState().phase).toBe('idle')
    expect(service.getState().reattached).toBe(false)
  })

  it('exposes reattach() as the same entry point', async () => {
    const { service, outputs } = createHarness()
    outputs.state = { ...emptyObsOutputState(), streaming: true, recording: true }

    const result = await service.reattach()

    expect(result.ok).toBe(true)
    expect(service.getState().reattached).toBe(true)
    expect(outputs.startCalls()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('guards', () => {
  it('refuses a second start() while the first is still running', async () => {
    const { service, outputs } = createHarness()

    const first = service.start()
    const second = await service.start()

    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error.code).toBe(ErrorCode.INVALID_ARG)

    await settle(first)
    // One press, one start: the sequence did not run twice.
    expect(outputs.calls.filter((call) => call === 'startStreamAndRecord')).toHaveLength(1)
    expect(outputs.streamStartRequests).toBe(1)
    expect(outputs.recordStartRequests).toBe(1)
  })

  it('refuses start() while already live', async () => {
    const { service, outputs } = createHarness()
    await settle(service.start())

    const again = await service.start()

    expect(again.ok).toBe(false)
    expect(outputs.streamStartRequests).toBe(1)
  })

  it('refuses start() while partial, because OBS is still running', async () => {
    const { service, outputs, youtube } = createHarness()
    youtube.transitionError = OBS_ERROR
    await settle(service.start())
    expect(service.getState().phase).toBe('partial')

    const again = await service.start()

    expect(again.ok).toBe(false)
    expect(outputs.streamStartRequests).toBe(1)
  })

  it('allows a retry after a failed start', async () => {
    const { service, outputs } = createHarness()
    outputs.startFailure = { code: ErrorCode.NOT_CONNECTED, message: 'OBS is not connected' }
    await settle(service.start())
    expect(service.getState().phase).toBe('failed')

    outputs.startFailure = null
    const retry = await settle(service.start())

    expect(retry.ok).toBe(true)
    expect(service.getState().phase).toBe('live')
  })

  it('stops publishing and cancels its timers once disposed', async () => {
    const { service, states } = createHarness()

    service.dispose()
    const before = states.length
    const result = await service.start()

    expect(result.ok).toBe(false)
    expect(states.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  const streaming: ObsOutputState = { ...emptyObsOutputState(), streaming: true }

  it('treats an unreadable ingest health as no evidence of a fault', () => {
    expect(isHealthy(streaming, null)).toBe(true)
  })

  it('blocks on bad, noData and a reconnecting OBS', () => {
    expect(isHealthy(streaming, 'bad')).toBe(false)
    expect(isHealthy(streaming, 'noData')).toBe(false)
    expect(isHealthy({ ...streaming, streamReconnecting: true }, 'good')).toBe(false)
    expect(isHealthy(emptyObsOutputState(), 'good')).toBe(false)
  })

  it('accepts good and ok', () => {
    expect(isHealthy(streaming, 'good')).toBe(true)
    expect(isHealthy(streaming, 'ok')).toBe(true)
  })

  it('never invents a liveSince', () => {
    expect(deriveLiveSince(emptyObsOutputState(), 1_000)).toBeNull()
    expect(deriveLiveSince({ ...streaming, streamTimecodeMs: 400 }, 1_000)).toBe(600)
    expect(deriveLiveSince({ ...emptyObsOutputState(), recordTimecodeMs: 250 }, 1_000)).toBe(750)
  })
})

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

describe('getGoLiveService', () => {
  it('is lazy and inert: constructing it sends OBS and YouTube nothing', async () => {
    wiring.obsRequests.length = 0
    wiring.youtubeCalls.length = 0

    const module = await import('@main/golive')
    const service = module.getGoLiveService()

    expect(service.getState().phase).toBe('idle')
    expect(service.getState().obs.streaming).toBe(false)
    // No socket write, no read, no quota spent — the first OBS request happens when the
    // operator (or `initialize()`) asks for one.
    expect(wiring.obsRequests).toEqual([])
    expect(wiring.youtubeCalls).toEqual([])
    // Callable with no arguments, and the same instance every time.
    expect(module.getGoLiveService()).toBe(service)

    module.resetGoLiveService()
  })
})
