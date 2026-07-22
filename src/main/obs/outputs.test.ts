/**
 * `outputs.ts` behaviour, driven entirely against a hand-written client double.
 *
 * OBS Studio is not installed on the machine running these tests and no request ever leaves the
 * process — the seam (`call` / `getStatus` / `onStatus` / `onObsEvent`) is mocked whole. The
 * assertions are behavioural: **which requests reached the client, in what order**, and what the
 * caller was told. That matters more here than anywhere else in Verger, because the two rules
 * this module exists to enforce are both statements about requests:
 *
 *  1. Standing Rule 3 — starting the stream ALWAYS also starts the recording.
 *  2. Verger never stops a stream or a recording as a reaction to its own error, so a failed
 *     `StartRecord` must be provably followed by no `StopStream` at all.
 */

import { describe, expect, it } from 'vitest'

import { createNullLogger } from '@main/logging/logger'
import { ObsClient } from '@main/obs/ObsClient'
import {
  OBS_OUTPUT_EVENTS,
  OBS_STATUS_OUTPUT_NOT_RUNNING,
  OBS_STATUS_OUTPUT_RUNNING,
  ObsOutputs,
  createObsOutputs,
  isOutputAlreadyRunning,
  isOutputNotRunning,
  parseTimecodeMs,
  toObsOutputState
} from '@main/obs/outputs'
import type { ObsOutputSocket } from '@main/obs/outputs'
import { emptyObsOutputState } from '@shared/golive'
import type { ObsOutputState } from '@shared/golive'
import type { Unsubscribe } from '@shared/ipc'
import { initialObsStatus } from '@shared/obs'
import type { ObsConnectionState, ObsStatus } from '@shared/obs'
import { ErrorCode, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'

// ---------------------------------------------------------------------------
// The double
// ---------------------------------------------------------------------------

type ObsEventListener = (payload?: unknown) => void

/** A complete, typed `ObsOutputSocket` with no socket, no library and no network behind it. */
class MockOutputClient implements ObsOutputSocket {
  /** Every request that reached the client, in order. The primary assertion surface. */
  readonly requests: string[] = []
  readonly responses = new Map<string, unknown>()
  readonly failures = new Map<string, AppError>()

  state: ObsConnectionState = 'connected'

  onObsEvent?: (event: string, listener: ObsEventListener) => Unsubscribe

  private readonly eventListeners = new Map<string, Set<ObsEventListener>>()
  private readonly statusListeners = new Set<(status: ObsStatus) => void>()

  constructor(options: { readonly events?: boolean } = {}) {
    if (options.events !== false) {
      this.onObsEvent = (event, listener) => {
        const set = this.eventListeners.get(event) ?? new Set<ObsEventListener>()
        set.add(listener)
        this.eventListeners.set(event, set)
        return () => {
          set.delete(listener)
        }
      }
    }
  }

  async call(requestType: string, _requestData?: Record<string, unknown>): Promise<Result<unknown>> {
    this.requests.push(requestType)
    const failure = this.failures.get(requestType)
    if (failure !== undefined) return { ok: false, error: failure }
    return ok(this.responses.get(requestType) ?? {})
  }

  getStatus(): ObsStatus {
    return initialObsStatus(this.state, 0)
  }

  onStatus(callback: (status: ObsStatus) => void): Unsubscribe {
    this.statusListeners.add(callback)
    return () => {
      this.statusListeners.delete(callback)
    }
  }

  /** Fire an OBS-side event, as if the operator had pressed a button in OBS itself. */
  emit(event: string, payload?: unknown): void {
    for (const listener of [...(this.eventListeners.get(event) ?? [])]) listener(payload)
  }

  /** Move the connection state and notify status subscribers, as `ObsClient` would. */
  setState(state: ObsConnectionState): void {
    this.state = state
    const status = this.getStatus()
    for (const listener of [...this.statusListeners]) listener(status)
  }

  eventListenerCount(): number {
    let total = 0
    for (const set of this.eventListeners.values()) total += set.size
    return total
  }
}

const STREAMING_STATUS = {
  outputActive: true,
  outputReconnecting: false,
  outputTimecode: '01:02:03.456',
  outputDuration: 3_723_456,
  outputSkippedFrames: 7,
  outputTotalFrames: 108_000,
  outputBytes: 123_456_789
}

const RECORDING_STATUS = {
  outputActive: true,
  outputPaused: false,
  outputTimecode: '00:00:12.500',
  outputDuration: 12_500,
  outputPath: 'C:\\Services\\2026-07-26 10-30-00.mkv'
}

function obsError(message: string, detail?: string): AppError {
  return detail === undefined
    ? { code: ErrorCode.OBS_ERROR, message }
    : { code: ErrorCode.OBS_ERROR, message, detail }
}

function createOutputs(client: MockOutputClient): ObsOutputs {
  return createObsOutputs({ client, logger: createNullLogger() })
}

/** Drain the microtask queue so an event-driven refresh settles before assertions. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('readOutputState', () => {
  it('maps every field OBS reports', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', STREAMING_STATUS)
    client.responses.set('GetRecordStatus', RECORDING_STATUS)

    const result = await createOutputs(client).readOutputState()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      streaming: true,
      recording: true,
      recordingPaused: false,
      streamReconnecting: false,
      streamTimecodeMs: 3_723_456,
      recordTimecodeMs: 12_500,
      skippedFrames: 7,
      totalFrames: 108_000,
      recordingPath: 'C:\\Services\\2026-07-26 10-30-00.mkv'
    } satisfies ObsOutputState)

    // Reads only, and no needless third read when OBS volunteered the path.
    expect(client.requests).toEqual(['GetStreamStatus', 'GetRecordStatus'])
  })

  it('carries OBS’s own reconnecting flag through', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: true, outputReconnecting: true })
    client.responses.set('GetRecordStatus', { outputActive: true, outputPath: 'C:\\r.mkv' })

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value.streamReconnecting).toBe(true)
    // Reconnecting is NOT "not streaming": OBS is still holding the output open.
    expect(result.ok && result.value.streaming).toBe(true)
  })

  it('tolerates an OBS that answers with nothing at all', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', {})
    client.responses.set('GetRecordStatus', {})

    const result = await createOutputs(client).readOutputState()

    // Every absent field degrades to the blank state — no throw, no NaN, no fabricated zeroes.
    expect(result.ok && result.value).toEqual(emptyObsOutputState())
  })

  it('tolerates garbage where OBS should have sent an object', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', 'not an object')
    client.responses.set('GetRecordStatus', null)

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value).toEqual(emptyObsOutputState())
  })

  it('ignores fields of the wrong type rather than trusting them', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', {
      outputActive: 'yes',
      outputSkippedFrames: '7',
      outputTotalFrames: Number.NaN,
      outputTimecode: 42
    })
    client.responses.set('GetRecordStatus', { outputActive: 1, outputPath: '   ' })

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value).toEqual(emptyObsOutputState())
  })

  it('falls back to the record directory when OBS omits the file path', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: true })
    client.responses.set('GetRecordStatus', { outputActive: true })
    client.responses.set('GetRecordDirectory', { recordDirectory: 'D:\\Verger\\recordings' })

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value.recordingPath).toBe('D:\\Verger\\recordings')
    expect(client.requests).toEqual(['GetStreamStatus', 'GetRecordStatus', 'GetRecordDirectory'])
  })

  it('never asks for the record directory when OBS is not recording', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: true })
    client.responses.set('GetRecordStatus', { outputActive: false })

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value.recordingPath).toBeNull()
    expect(client.requests).toEqual(['GetStreamStatus', 'GetRecordStatus'])
  })

  it('still reports the rest of the state when the directory lookup fails', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: true })
    client.responses.set('GetRecordStatus', { outputActive: true })
    client.failures.set('GetRecordDirectory', obsError('unsupported request'))

    const result = await createOutputs(client).readOutputState()

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.recording).toBe(true)
    expect(result.ok && result.value.recordingPath).toBeNull()
  })

  it('propagates a failed read instead of inventing a state', async () => {
    const client = new MockOutputClient()
    client.failures.set('GetStreamStatus', obsError('the OBS request timed out'))

    const result = await createOutputs(client).readOutputState()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('the OBS request timed out')
    // A failed stream read must not go on to claim anything about the recording either.
    expect(client.requests).toEqual(['GetStreamStatus'])
  })

  it('returns NOT_CONNECTED and calls nothing while OBS is down', async () => {
    const client = new MockOutputClient()
    client.state = 'reconnecting'

    const result = await createOutputs(client).readOutputState()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
      expect(result.error.detail).toBe('reconnecting')
    }
    expect(client.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Timecodes
// ---------------------------------------------------------------------------

describe('parseTimecodeMs', () => {
  it('parses the HH:MM:SS.mmm shape OBS reports', () => {
    expect(parseTimecodeMs('00:00:00.000')).toBe(0)
    expect(parseTimecodeMs('00:00:12.500')).toBe(12_500)
    expect(parseTimecodeMs('01:02:03.456')).toBe(3_723_456)
    expect(parseTimecodeMs('12:00:00.000')).toBe(43_200_000)
  })

  it('accepts the shapes obs-websocket releases have varied over', () => {
    expect(parseTimecodeMs('00:00:01')).toBe(1_000)
    expect(parseTimecodeMs('05:30')).toBe(330_000)
    expect(parseTimecodeMs('00:00:00,250')).toBe(250)
    expect(parseTimecodeMs('  00:00:02.001  ')).toBe(2_001)
  })

  it('pads a truncated fraction rather than misreading it', () => {
    expect(parseTimecodeMs('00:00:00.5')).toBe(500)
    expect(parseTimecodeMs('00:00:00.05')).toBe(50)
  })

  it('returns null for anything it cannot read, never NaN and never 0', () => {
    for (const value of ['', 'live', '--:--:--', undefined, null, 42, {}, []]) {
      expect(parseTimecodeMs(value)).toBeNull()
    }
  })

  it('falls back to outputDuration when OBS sends no timecode', async () => {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: true, outputDuration: 4_200 })
    client.responses.set('GetRecordStatus', { outputActive: true, outputPath: 'C:\\r.mkv' })

    const result = await createOutputs(client).readOutputState()

    expect(result.ok && result.value.streamTimecodeMs).toBe(4_200)
  })

  it('prefers the timecode over outputDuration when both are present', () => {
    const state = toObsOutputState({ outputTimecode: '00:00:01.000', outputDuration: 999 }, {})
    expect(state.streamTimecodeMs).toBe(1_000)
  })
})

// ---------------------------------------------------------------------------
// Standing Rule 3
// ---------------------------------------------------------------------------

describe('startStreamAndRecord — Standing Rule 3', () => {
  it('issues BOTH StartStream and StartRecord', async () => {
    const client = new MockOutputClient()

    const result = await createOutputs(client).startStreamAndRecord()

    expect(client.requests).toEqual(['StartStream', 'StartRecord'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      streaming: true,
      recording: true,
      streamAlreadyRunning: false,
      recordAlreadyRunning: false,
      streamError: null,
      recordError: null
    })
  })

  it('offers no way to skip the recording', () => {
    // The primitive takes no arguments at all: there is deliberately no flag, no option bag and
    // no overload that could ever be used to stream without a local backup.
    expect(ObsOutputs.prototype.startStreamAndRecord.length).toBe(0)
  })

  it('does NOT stop the stream when the recording fails to start', async () => {
    const client = new MockOutputClient()
    // 205 is obs-websocket's `GenericError`, NOT the 500 that means "already running" — this is a
    // real failure and must stay one.
    client.failures.set('StartRecord', obsError('Disk full', 'obs-websocket code 205'))

    const result = await createOutputs(client).startStreamAndRecord()

    // THE assertion of this module: the exact request list contains no StopStream. The service is
    // worth more than the backup, so losing the backup never takes the service off air.
    expect(client.requests).toEqual(['StartStream', 'StartRecord'])
    expect(client.requests).not.toContain('StopStream')
    expect(client.requests).not.toContain('StopRecord')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.streaming).toBe(true)
    expect(result.value.recording).toBe(false)
    expect(result.value.recordError?.message).toBe('Disk full')
    expect(result.value.streamError).toBeNull()
  })

  it('still records when the STREAM fails — the service in the room is still happening', async () => {
    const client = new MockOutputClient()
    client.failures.set('StartStream', obsError('no stream key configured'))

    const result = await createOutputs(client).startStreamAndRecord()

    expect(client.requests).toEqual(['StartStream', 'StartRecord'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.streaming).toBe(false)
    expect(result.value.recording).toBe(true)
    expect(result.value.streamError?.message).toBe('no stream key configured')
  })

  it('reports a total failure of both without stopping anything', async () => {
    const client = new MockOutputClient()
    client.failures.set('StartStream', obsError('nope'))
    client.failures.set('StartRecord', obsError('also nope'))

    const result = await createOutputs(client).startStreamAndRecord()

    expect(client.requests).toEqual(['StartStream', 'StartRecord'])
    expect(result.ok && result.value.streaming).toBe(false)
    expect(result.ok && result.value.recording).toBe(false)
  })

  it('treats an already-running recording as success, not as an error', async () => {
    const client = new MockOutputClient()
    // OBS was already recording before Verger asked — the operator pressed Start Recording, or
    // this is a re-attach after a crash. Either way it is exactly the state we wanted.
    client.failures.set(
      'StartRecord',
      obsError('Output is already active.', `obs-websocket code ${OBS_STATUS_OUTPUT_RUNNING}`)
    )

    const result = await createOutputs(client).startStreamAndRecord()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.recording).toBe(true)
    expect(result.value.recordAlreadyRunning).toBe(true)
    expect(result.value.recordError).toBeNull()
  })

  it('treats an already-running stream as success too', async () => {
    const client = new MockOutputClient()
    client.failures.set(
      'StartStream',
      obsError('Output is already active.', `obs-websocket code ${OBS_STATUS_OUTPUT_RUNNING}`)
    )

    const result = await createOutputs(client).startStreamAndRecord()

    expect(result.ok && result.value.streaming).toBe(true)
    expect(result.ok && result.value.streamAlreadyRunning).toBe(true)
    expect(result.ok && result.value.streamError).toBeNull()
  })

  it('recognises an already-running refusal from the message when OBS sends no code', async () => {
    const client = new MockOutputClient()
    client.failures.set('StartRecord', obsError('OutputRunning'))

    const result = await createOutputs(client).startStreamAndRecord()

    expect(result.ok && result.value.recording).toBe(true)
    expect(result.ok && result.value.recordAlreadyRunning).toBe(true)
  })

  it('returns NOT_CONNECTED and issues nothing while OBS is down', async () => {
    const client = new MockOutputClient()
    client.state = 'disconnected'

    const result = await createOutputs(client).startStreamAndRecord()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(client.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The individual verbs
// ---------------------------------------------------------------------------

describe('the output verbs', () => {
  it('sends exactly the request named, and nothing else', async () => {
    const client = new MockOutputClient()
    const outputs = createOutputs(client)

    expect((await outputs.startStream()).ok).toBe(true)
    expect((await outputs.stopStream()).ok).toBe(true)
    expect((await outputs.startRecord()).ok).toBe(true)
    expect((await outputs.stopRecord()).ok).toBe(true)

    expect(client.requests).toEqual(['StartStream', 'StopStream', 'StartRecord', 'StopRecord'])
  })

  it('reports which request produced the change', async () => {
    const client = new MockOutputClient()

    const result = await createOutputs(client).startRecord()

    expect(result.ok && result.value).toEqual({ request: 'StartRecord', alreadyInState: false })
  })

  it('treats stopping an output that is not running as success', async () => {
    const client = new MockOutputClient()
    client.failures.set(
      'StopStream',
      obsError('Output not running.', `obs-websocket code ${OBS_STATUS_OUTPUT_NOT_RUNNING}`)
    )
    client.failures.set('StopRecord', obsError('OutputNotRunning'))

    const outputs = createOutputs(client)
    const stream = await outputs.stopStream()
    const record = await outputs.stopRecord()

    expect(stream.ok && stream.value.alreadyInState).toBe(true)
    expect(record.ok && record.value.alreadyInState).toBe(true)
  })

  it('propagates a genuine refusal as an error', async () => {
    const client = new MockOutputClient()
    client.failures.set('StopRecord', obsError('the request timed out'))

    const result = await createOutputs(client).stopRecord()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.OBS_ERROR)
  })

  it('does not confuse an already-running refusal with a not-running one', async () => {
    const client = new MockOutputClient()
    // A `Start*` refused with OutputNotRunning is nonsense; it must NOT be swallowed as success.
    client.failures.set(
      'StartStream',
      obsError('Output not running.', `obs-websocket code ${OBS_STATUS_OUTPUT_NOT_RUNNING}`)
    )

    const result = await createOutputs(client).startStream()

    expect(result.ok).toBe(false)
  })

  it('returns NOT_CONNECTED for every verb, with no request issued', async () => {
    const client = new MockOutputClient()
    client.state = 'not-configured'
    const outputs = createOutputs(client)

    for (const result of [
      await outputs.startStream(),
      await outputs.stopStream(),
      await outputs.startRecord(),
      await outputs.stopRecord()
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
    }
    expect(client.requests).toEqual([])
  })
})

describe('the error classifiers', () => {
  it('reads the obs-websocket status code in preference to the message', () => {
    expect(isOutputAlreadyRunning(obsError('', 'obs-websocket code 500'))).toBe(true)
    expect(isOutputNotRunning(obsError('', 'obs-websocket code 501'))).toBe(true)
    expect(isOutputAlreadyRunning(obsError('', 'obs-websocket code 501'))).toBe(false)
    expect(isOutputNotRunning(obsError('', 'obs-websocket code 500'))).toBe(false)
  })

  it('falls back to the message wording', () => {
    expect(isOutputAlreadyRunning(obsError('Output is already active.'))).toBe(true)
    expect(isOutputAlreadyRunning(obsError('the stream is already running'))).toBe(true)
    expect(isOutputNotRunning(obsError('Output is not active.'))).toBe(true)
    expect(isOutputAlreadyRunning(obsError('Disk full'))).toBe(false)
    expect(isOutputNotRunning(obsError('Disk full'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

describe('subscribeOutputs', () => {
  function recordingClient(): MockOutputClient {
    const client = new MockOutputClient()
    client.responses.set('GetStreamStatus', { outputActive: false })
    client.responses.set('GetRecordStatus', { outputActive: false })
    return client
  }

  it('propagates an OBS-side start that Verger never asked for', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    // Someone pressed "Start Recording" in the OBS window.
    client.responses.set('GetRecordStatus', { outputActive: true, outputPath: 'C:\\r.mkv' })
    client.emit('RecordStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED'
    })
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.recording).toBe(true)
    expect(seen[0]?.recordingPath).toBe('C:\\r.mkv')
  })

  it('subscribes to every output event OBS can raise', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    expect(client.eventListenerCount()).toBe(OBS_OUTPUT_EVENTS.length)
    for (const event of OBS_OUTPUT_EVENTS) client.emit(event, {})
    await flush()

    expect(seen).toHaveLength(OBS_OUTPUT_EVENTS.length)
  })

  it('re-reads OBS rather than trusting the event payload', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    // The event LIES: it claims the stream started, but OBS itself still says it has not.
    client.emit('StreamStateChanged', { outputActive: true })
    await flush()

    expect(seen[0]?.streaming).toBe(false)
    expect(client.requests).toContain('GetStreamStatus')
  })

  it('refreshes when OBS comes back, because the truth may have moved while we were away', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    client.setState('reconnecting')
    await flush()
    // Nothing is emitted while disconnected: Verger does not know what OBS is doing, and saying
    // "not streaming" would be a lie that could talk the caller into starting a second stream.
    expect(seen).toEqual([])
    expect(client.requests).toEqual([])

    client.responses.set('GetStreamStatus', { outputActive: true })
    client.setState('connected')
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.streaming).toBe(true)
  })

  it('does not re-emit when the status changes without a reconnect', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    client.setState('connected')
    await flush()

    expect(seen).toEqual([])
  })

  it('stops emitting once unsubscribed, and detaches every listener', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    const unsubscribe = createOutputs(client).subscribeOutputs((state) => seen.push(state))

    unsubscribe()
    client.emit('RecordStateChanged', {})
    client.setState('reconnecting')
    client.setState('connected')
    await flush()

    expect(seen).toEqual([])
    expect(client.eventListenerCount()).toBe(0)
    expect(() => {
      unsubscribe()
    }).not.toThrow()
  })

  it('drops an in-flight refresh that lands after unsubscribing', async () => {
    const client = recordingClient()
    const seen: ObsOutputState[] = []
    const unsubscribe = createOutputs(client).subscribeOutputs((state) => seen.push(state))

    client.emit('RecordStateChanged', {})
    unsubscribe()
    await flush()

    expect(seen).toEqual([])
  })

  it('emits nothing when the refresh read fails', async () => {
    const client = recordingClient()
    client.failures.set('GetStreamStatus', obsError('OBS went away mid-event'))
    const seen: ObsOutputState[] = []
    createOutputs(client).subscribeOutputs((state) => seen.push(state))

    client.emit('StreamStateChanged', {})
    await flush()

    expect(seen).toEqual([])
  })

  it('survives a subscriber that throws', async () => {
    const client = recordingClient()
    let calls = 0
    createOutputs(client).subscribeOutputs(() => {
      calls += 1
      throw new Error('the UI blew up')
    })

    client.emit('RecordStateChanged', {})
    await flush()
    client.emit('RecordStateChanged', {})
    await flush()

    expect(calls).toBe(2)
  })

  it('degrades to reconnect-only when the client exposes no raw event hook', async () => {
    const client = new MockOutputClient({ events: false })
    client.responses.set('GetStreamStatus', { outputActive: true })
    client.responses.set('GetRecordStatus', { outputActive: false })
    const seen: ObsOutputState[] = []

    // No throw, and the status path still works — a smaller feature, never a failure.
    const unsubscribe = createOutputs(client).subscribeOutputs((state) => seen.push(state))
    client.setState('disconnected')
    client.setState('connected')
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.streaming).toBe(true)
    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('the client seam', () => {
  it('is a strict subset of ObsClient, so the real client can be passed unchanged', () => {
    // A compile-time assertion: if `ObsOutputSocket` ever asks for something `ObsClient` does not
    // offer, this file stops typechecking rather than failing at runtime in a live service.
    const asSeam = (client: ObsClient): ObsOutputSocket => client
    expect(typeof asSeam).toBe('function')
  })

  it('constructs without a logger', async () => {
    const client = new MockOutputClient()
    const outputs = new ObsOutputs({ client })

    expect((await outputs.startRecord()).ok).toBe(true)
  })
})
