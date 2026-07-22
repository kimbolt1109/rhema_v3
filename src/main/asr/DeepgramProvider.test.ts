/**
 * Unit tests for the Deepgram cloud ASR adapter.
 *
 * **Zero network.** The SDK is never loaded: `DeepgramProvider` takes a
 * {@link DeepgramClientFactory} and this file injects a hand-written fake. That is deliberate —
 * an injected seam beats `vi.mock` here because it also proves the production wiring has exactly
 * one place the real client is constructed.
 *
 * **No copyrighted fixtures** (Standing Rule 4). All audio is synthesised arithmetically
 * ({@link pcmSilence}, {@link pcmSineTone}) and every transcript string is invented placeholder
 * text. There is not a line of scripture, hymn or sermon anywhere in this file.
 */

import { describe, expect, it, vi } from 'vitest'

import { ASR_CHANNELS, ASR_SAMPLE_RATE, defaultAsrSettings } from '@shared/asr'
import type { AsrState, TranscriptSegment } from '@shared/asr'
import type { LogFields, Logger, LogLevel } from '@shared/log'
import { ErrorCode } from '@shared/result'

import {
  DEEPGRAM_MODEL_BY_LANGUAGE,
  DEEPGRAM_RECONNECT_POLICY,
  DEFAULT_ENDPOINTING_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DeepgramProvider,
  MAX_BOOST_TERMS,
  asResultsMessage,
  normaliseConfidence,
  normaliseVocabulary,
  supportsKeyterm
} from './DeepgramProvider'
import type { AsrStartOptions } from './AsrProvider'
import type {
  AsrTimerHandle,
  AsrTimers,
  DeepgramClientFactory,
  DeepgramCloseEvent,
  DeepgramConnectArgs,
  DeepgramLiveSocketLike
} from './DeepgramProvider'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A recorded log call, so a test can assert on what did — and did not — reach the logger. */
interface LogRecordCapture {
  readonly level: LogLevel
  readonly message: string
  readonly fields: LogFields | undefined
}

function createRecordingLogger(): { logger: Logger; records: LogRecordCapture[] } {
  const records: LogRecordCapture[] = []
  const make = (level: LogLevel) => (message: string, fields?: LogFields) => {
    records.push({ level, message, fields })
  }
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger
  }
  return { logger, records }
}

interface ScheduledTimer {
  readonly handle: number
  readonly handler: () => void
  readonly delayMs: number
  readonly repeating: boolean
}

/**
 * Deterministic timers.
 *
 * Hand-rolled rather than `vi.useFakeTimers()` because the provider takes its timers as a
 * dependency: driving them explicitly keeps the async plumbing (which uses the *real* event loop
 * to flush microtasks) untangled from the reconnect schedule under test.
 */
class TestTimers implements AsrTimers {
  private nextHandle = 1
  readonly scheduled = new Map<number, ScheduledTimer>()
  readonly cleared: number[] = []

  setTimeout(handler: () => void, delayMs: number): AsrTimerHandle {
    const handle = this.nextHandle++
    this.scheduled.set(handle, { handle, handler, delayMs, repeating: false })
    return handle
  }

  clearTimeout(handle: AsrTimerHandle): void {
    this.cleared.push(Number(handle))
    this.scheduled.delete(Number(handle))
  }

  setInterval(handler: () => void, delayMs: number): AsrTimerHandle {
    const handle = this.nextHandle++
    this.scheduled.set(handle, { handle, handler, delayMs, repeating: true })
    return handle
  }

  clearInterval(handle: AsrTimerHandle): void {
    this.cleared.push(Number(handle))
    this.scheduled.delete(Number(handle))
  }

  /** The single pending one-shot timer, or `null`. */
  pendingTimeout(): ScheduledTimer | null {
    for (const timer of this.scheduled.values()) if (!timer.repeating) return timer
    return null
  }

  /** The single pending repeating timer, or `null`. */
  pendingInterval(): ScheduledTimer | null {
    for (const timer of this.scheduled.values()) if (timer.repeating) return timer
    return null
  }

  /** Fire the pending one-shot timer, removing it first (as a real timer would). */
  runPendingTimeout(): void {
    const timer = this.pendingTimeout()
    if (timer === null) throw new Error('no pending timeout')
    this.scheduled.delete(timer.handle)
    timer.handler()
  }

  runPendingInterval(): void {
    const timer = this.pendingInterval()
    if (timer === null) throw new Error('no pending interval')
    timer.handler()
  }
}

type SocketHandlers = {
  open?: () => void
  message?: (message: unknown) => void
  close?: (event: DeepgramCloseEvent) => void
  error?: (error: Error) => void
}

/** A stand-in for the SDK's `V1Socket`, faithful to the parts that matter. */
class FakeSocket implements DeepgramLiveSocketLike {
  private readonly handlers: SocketHandlers = {}
  /** Copies, because the provider hands out views over a shared buffer. */
  readonly sent: Uint8Array[] = []
  keepAlives = 0
  closeStreams = 0
  closeCalls = 0
  /** The SDK's `sendMedia` asserts the socket is open before writing; so does this. */
  isOpen = false

  on(event: 'open', callback: () => void): void
  on(event: 'message', callback: (message: unknown) => void): void
  on(event: 'close', callback: (event: DeepgramCloseEvent) => void): void
  on(event: 'error', callback: (error: Error) => void): void
  on(event: string, callback: unknown): void {
    ;(this.handlers as Record<string, unknown>)[event] = callback
  }

  sendMedia(data: ArrayBufferView): void {
    if (!this.isOpen) throw new Error('socket is not open')
    this.sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
  }

  sendKeepAlive(): void {
    if (!this.isOpen) throw new Error('socket is not open')
    this.keepAlives += 1
  }

  sendCloseStream(): void {
    if (!this.isOpen) throw new Error('socket is not open')
    this.closeStreams += 1
  }

  close(): void {
    this.closeCalls += 1
    this.isOpen = false
  }

  // -- driving the fake from a test ---------------------------------------

  emitOpen(): void {
    this.isOpen = true
    this.handlers.open?.()
  }

  emitMessage(message: unknown): void {
    this.handlers.message?.(message)
  }

  emitError(error: Error): void {
    this.handlers.error?.(error)
  }

  emitClose(code: number, reason = ''): void {
    this.isOpen = false
    this.handlers.close?.({ code, reason })
  }
}

/** Records every connect and hands out fresh sockets; can be told to fail the next N attempts. */
class FakeDeepgram {
  readonly sockets: FakeSocket[] = []
  readonly connectArgs: DeepgramConnectArgs[] = []
  readonly apiKeys: string[] = []
  failures = 0

  readonly factory: DeepgramClientFactory = (apiKey) => ({
    connect: async (args) => {
      this.apiKeys.push(apiKey)
      this.connectArgs.push(args)
      if (this.failures > 0) {
        this.failures -= 1
        return Promise.reject(new Error('connect refused by test double'))
      }
      const socket = new FakeSocket()
      this.sockets.push(socket)
      return Promise.resolve(socket)
    }
  })

  lastSocket(): FakeSocket {
    const socket = this.sockets.at(-1)
    if (socket === undefined) throw new Error('no socket was created')
    return socket
  }

  lastArgs(): DeepgramConnectArgs {
    const args = this.connectArgs.at(-1)
    if (args === undefined) throw new Error('connect was never called')
    return args
  }
}

// ---------------------------------------------------------------------------
// Synthesised audio — Standing Rule 4: no recorded fixtures, ever
// ---------------------------------------------------------------------------

const BYTES_PER_SAMPLE = 2

/** `ms` of digital silence as 16 kHz mono 16-bit PCM. */
function pcmSilence(ms: number): ArrayBuffer {
  const samples = Math.round((ASR_SAMPLE_RATE * ms) / 1000) * ASR_CHANNELS
  return new ArrayBuffer(samples * BYTES_PER_SAMPLE)
}

/** `ms` of a pure sine tone, computed rather than recorded. */
function pcmSineTone(ms: number, hz = 440): ArrayBuffer {
  const samples = Math.round((ASR_SAMPLE_RATE * ms) / 1000) * ASR_CHANNELS
  const buffer = new ArrayBuffer(samples * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * hz * index) / ASR_SAMPLE_RATE) * 12_000)
    view.setInt16(index * BYTES_PER_SAMPLE, value, true)
  }
  return buffer
}

/** A chunk of `size` bytes every one of which is `fill`, so eviction order is observable. */
function markedChunk(size: number, fill: number): ArrayBuffer {
  const bytes = new Uint8Array(size).fill(fill)
  return bytes.buffer
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Invented proper nouns. Exactly the kind of term BLUEPRINT.md §8 says must be boosted. */
const VOCABULARY = ['Pastor Placeholder', 'Verger Test Church', 'Placeholder Hymn 123'] as const

const API_KEY = 'dg-secret-key-must-never-be-logged-0123456789'

/** Start options as `AsrService` would build them from the operator's saved settings. */
function settings(overrides: Partial<AsrStartOptions> = {}): AsrStartOptions {
  const defaults = defaultAsrSettings()
  return {
    language: defaults.language,
    customVocabulary: [...VOCABULARY],
    localModel: defaults.localModel,
    deviceId: defaults.deviceId,
    ...overrides
  }
}

interface Harness {
  readonly provider: DeepgramProvider
  readonly deepgram: FakeDeepgram
  readonly timers: TestTimers
  readonly records: LogRecordCapture[]
  readonly segments: TranscriptSegment[]
  readonly states: AsrState[]
  setNow(value: number): void
}

function createHarness(
  overrides: {
    apiKey?: string | null
    maxBufferedBytes?: number
    model?: string
    keepAliveIntervalMs?: number
  } = {}
): Harness {
  const deepgram = new FakeDeepgram()
  const timers = new TestTimers()
  const { logger, records } = createRecordingLogger()
  const segments: TranscriptSegment[] = []
  const states: AsrState[] = []
  let clock = 1_000_000

  const provider = new DeepgramProvider({
    apiKey: overrides.apiKey === undefined ? API_KEY : overrides.apiKey,
    createClient: deepgram.factory,
    timers,
    logger,
    now: () => clock,
    // 0.5 ⇒ the symmetric jitter offset is exactly zero, so backoff delays are the bare
    // exponential sequence and can be asserted to the millisecond.
    random: () => 0.5,
    ...(overrides.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: overrides.maxBufferedBytes }),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.keepAliveIntervalMs === undefined
      ? {}
      : { keepAliveIntervalMs: overrides.keepAliveIntervalMs })
  })

  provider.onSegment((segment) => segments.push(segment))
  provider.onStateChange((state) => states.push(state))

  return {
    provider,
    deepgram,
    timers,
    records,
    segments,
    states,
    setNow: (value: number) => {
      clock = value
    }
  }
}

/** Let queued microtasks (the provider's internal `await`s) run. Real timers, not fake ones. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** A Deepgram `Results` frame, shaped exactly as `ListenV1Results` declares it. */
function resultsFrame(options: {
  transcript: string
  isFinal: boolean
  start: number
  duration: number
  confidence?: number
}): unknown {
  return {
    type: 'Results',
    channel_index: [0, 1],
    start: options.start,
    duration: options.duration,
    is_final: options.isFinal,
    speech_final: options.isFinal,
    channel: {
      alternatives: [
        {
          transcript: options.transcript,
          confidence: options.confidence ?? 0.94,
          words: []
        }
      ]
    },
    metadata: {
      request_id: 'req-placeholder',
      model_uuid: 'model-placeholder',
      model_info: { name: 'nova-2', version: 'test', arch: 'test' }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('routes boosting to keyterm only for nova-3', () => {
    expect(supportsKeyterm('nova-3')).toBe(true)
    expect(supportsKeyterm('nova-3-general')).toBe(true)
    expect(supportsKeyterm('NOVA-3')).toBe(true)
    expect(supportsKeyterm('nova-2')).toBe(false)
    expect(supportsKeyterm('enhanced')).toBe(false)
  })

  it('trims, drops blanks and de-duplicates the vocabulary case-insensitively', () => {
    expect(normaliseVocabulary(['  Placeholder One  ', 'placeholder one', '', '   ', 'Two'])).toEqual([
      'Placeholder One',
      'Two'
    ])
  })

  it('caps the vocabulary so the connect URL stays inside server limits', () => {
    const many = Array.from({ length: MAX_BOOST_TERMS + 40 }, (_unused, index) => `term-${String(index)}`)
    expect(normaliseVocabulary(many)).toHaveLength(MAX_BOOST_TERMS)
  })

  it('recognises only Results frames', () => {
    expect(asResultsMessage(resultsFrame({ transcript: 'x', isFinal: false, start: 0, duration: 1 }))).not.toBeNull()
    expect(asResultsMessage({ type: 'Metadata' })).toBeNull()
    expect(asResultsMessage({ type: 'UtteranceEnd' })).toBeNull()
    expect(asResultsMessage(null)).toBeNull()
    expect(asResultsMessage('Results')).toBeNull()
  })

  it('clamps confidence and maps a missing or non-finite one to null', () => {
    expect(normaliseConfidence(0.5)).toBe(0.5)
    expect(normaliseConfidence(1.4)).toBe(1)
    expect(normaliseConfidence(-2)).toBe(0)
    expect(normaliseConfidence(undefined)).toBeNull()
    expect(normaliseConfidence(Number.NaN)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Not configured (Standing Rule 5)
// ---------------------------------------------------------------------------

describe('when DEEPGRAM_API_KEY is absent', () => {
  it('reports not-configured, refuses to start, and opens no socket', async () => {
    const harness = createHarness({ apiKey: null })

    expect(harness.provider.isConfigured()).toBe(false)
    expect(harness.provider.getState()).toBe('not-configured')

    const started = await harness.provider.start(settings())

    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(harness.deepgram.connectArgs).toHaveLength(0)
    expect(harness.deepgram.sockets).toHaveLength(0)
    expect(harness.timers.scheduled.size).toBe(0)
    expect(harness.provider.getState()).toBe('not-configured')
  })

  it('treats a whitespace-only key as absent', async () => {
    const harness = createHarness({ apiKey: '   ' })
    expect(harness.provider.isConfigured()).toBe(false)
    const started = await harness.provider.start(settings())
    expect(started.ok).toBe(false)
    expect(harness.deepgram.connectArgs).toHaveLength(0)
  })

  it('rejects pushed audio without touching the network', () => {
    const harness = createHarness({ apiKey: null })
    const result = harness.provider.pushAudio(pcmSilence(100))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(harness.deepgram.sockets).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Connect options
// ---------------------------------------------------------------------------

describe('connect options', () => {
  it('requests Korean linear16 16 kHz mono with interim results and boosted vocabulary', async () => {
    const harness = createHarness()

    const started = await harness.provider.start(settings({ language: 'ko' }))
    expect(started.ok).toBe(true)

    const args = harness.deepgram.lastArgs()
    expect(args.language).toBe('ko')
    expect(args.model).toBe(DEEPGRAM_MODEL_BY_LANGUAGE.ko)
    expect(args.interim_results).toBe('true')
    expect(args.punctuate).toBe('true')
    expect(args.smart_format).toBe('true')
    expect(args.endpointing).toBe(DEFAULT_ENDPOINTING_MS)
    expect(args.encoding).toBe('linear16')
    expect(args.sample_rate).toBe(ASR_SAMPLE_RATE)
    expect(args.channels).toBe(ASR_CHANNELS)
    // nova-2 predates key-term prompting, so the boost list travels as `keywords`.
    expect(args.keywords).toEqual([...VOCABULARY])
    expect(args.keyterm).toBeUndefined()
    // The SDK's own reconnect loop is disabled; this provider owns reconnection.
    expect(args.reconnectAttempts).toBe(0)
    expect(harness.deepgram.apiKeys).toEqual([API_KEY])
  })

  it('uses keyterm instead of keywords on a nova-3 model', async () => {
    const harness = createHarness()
    await harness.provider.start(settings({ language: 'en' }))

    const args = harness.deepgram.lastArgs()
    expect(args.model).toBe(DEEPGRAM_MODEL_BY_LANGUAGE.en)
    expect(args.model.startsWith('nova-3')).toBe(true)
    expect(args.keyterm).toEqual([...VOCABULARY])
    expect(args.keywords).toBeUndefined()
  })

  it('honours a model override and re-routes the boost parameter with it', async () => {
    const harness = createHarness({ model: 'nova-3-general' })
    await harness.provider.start(settings({ language: 'ko' }))

    const args = harness.deepgram.lastArgs()
    expect(args.model).toBe('nova-3-general')
    expect(args.language).toBe('ko')
    expect(args.keyterm).toEqual([...VOCABULARY])
  })

  it('omits both boost parameters when the operator has no vocabulary yet', async () => {
    const harness = createHarness()
    await harness.provider.start(settings({ customVocabulary: [] }))

    const args = harness.deepgram.lastArgs()
    expect(args.keyterm).toBeUndefined()
    expect(args.keywords).toBeUndefined()
  })

  it('is a no-op when start is called twice', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    await harness.provider.start(settings())
    expect(harness.deepgram.connectArgs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The draft/final contract
// ---------------------------------------------------------------------------

describe('transcript mapping', () => {
  it('gives every partial in one span the same id and lets the final supersede them', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    socket.emitMessage(resultsFrame({ transcript: 'placeholder', isFinal: false, start: 0, duration: 0.4 }))
    socket.emitMessage(resultsFrame({ transcript: 'placeholder utterance', isFinal: false, start: 0, duration: 0.9 }))
    socket.emitMessage(
      resultsFrame({ transcript: 'placeholder utterance one.', isFinal: true, start: 0, duration: 1.2, confidence: 0.88 })
    )

    expect(harness.segments).toHaveLength(3)
    const ids = new Set(harness.segments.map((segment) => segment.id))
    expect(ids.size).toBe(1)
    expect(harness.segments.map((segment) => segment.isFinal)).toEqual([false, false, true])
    expect(harness.segments.every((segment) => segment.provider === 'deepgram')).toBe(true)
    // `isDraft` is the local two-tier scheduler's concept; the cloud never sets it.
    expect(harness.segments.every((segment) => !segment.isDraft)).toBe(true)

    const final = harness.segments[2]
    expect(final?.text).toBe('placeholder utterance one.')
    expect(final?.tsStart).toBe(0)
    expect(final?.tsEnd).toBe(1200)
    expect(final?.confidence).toBe(0.88)
  })

  it('starts a fresh id once the previous span has been finalised', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    socket.emitMessage(resultsFrame({ transcript: 'first span', isFinal: false, start: 0, duration: 0.5 }))
    socket.emitMessage(resultsFrame({ transcript: 'first span done', isFinal: true, start: 0, duration: 0.8 }))
    socket.emitMessage(resultsFrame({ transcript: 'second span', isFinal: false, start: 1.0, duration: 0.5 }))

    const [firstPartial, firstFinal, secondPartial] = harness.segments
    expect(firstPartial?.id).toBe(firstFinal?.id)
    expect(secondPartial?.id).not.toBe(firstFinal?.id)
    expect(secondPartial?.tsStart).toBe(1000)
  })

  it('ignores empty results but still lets an empty final close the span', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    socket.emitMessage(resultsFrame({ transcript: 'spoken', isFinal: false, start: 0, duration: 0.5 }))
    socket.emitMessage(resultsFrame({ transcript: '   ', isFinal: true, start: 0, duration: 0.6 }))
    socket.emitMessage(resultsFrame({ transcript: 'next', isFinal: false, start: 2, duration: 0.5 }))

    expect(harness.segments).toHaveLength(2)
    expect(harness.segments[0]?.id).not.toBe(harness.segments[1]?.id)
  })

  it('ignores non-Results frames and malformed payloads', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    socket.emitMessage({ type: 'Metadata', request_id: 'x' })
    socket.emitMessage({ type: 'UtteranceEnd', last_word_end: 1 })
    socket.emitMessage({ type: 'Results' })
    socket.emitMessage('not an object')
    socket.emitMessage(null)

    expect(harness.segments).toHaveLength(0)
  })

  it('shifts timestamps onto the session clock after a mid-session reconnect', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    harness.deepgram.lastSocket().emitOpen()

    // 30 s into the service the socket drops; Deepgram's `start` restarts at 0 on the new one.
    harness.setNow(1_030_000)
    harness.deepgram.lastSocket().emitClose(1006, 'abnormal')
    harness.timers.runPendingTimeout()
    await settle()

    const reconnected = harness.deepgram.lastSocket()
    reconnected.emitOpen()
    reconnected.emitMessage(resultsFrame({ transcript: 'after reconnect', isFinal: true, start: 0.5, duration: 0.5 }))

    expect(harness.segments[0]?.tsStart).toBe(30_500)
    expect(harness.segments[0]?.tsEnd).toBe(31_000)
  })

  it('does not let a throwing listener stop the others', async () => {
    const harness = createHarness()
    const seen: string[] = []
    harness.provider.onSegment(() => {
      throw new Error('listener exploded')
    })
    harness.provider.onSegment((segment) => seen.push(segment.text))

    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()
    socket.emitMessage(resultsFrame({ transcript: 'still delivered', isFinal: true, start: 0, duration: 1 }))

    expect(seen).toEqual(['still delivered'])
  })
})

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe('reconnection', () => {
  it('backs off exponentially after an unexpected close', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    harness.deepgram.lastSocket().emitOpen()
    expect(harness.provider.getState()).toBe('listening')

    harness.deepgram.lastSocket().emitClose(1006, 'abnormal closure')
    expect(harness.provider.getState()).toBe('starting')

    const first = harness.timers.pendingTimeout()
    expect(first?.delayMs).toBe(DEEPGRAM_RECONNECT_POLICY.baseDelayMs)

    harness.timers.runPendingTimeout()
    await settle()
    expect(harness.deepgram.connectArgs).toHaveLength(2)

    // Second failure in a row: the delay doubles.
    harness.deepgram.lastSocket().emitClose(1006)
    expect(harness.timers.pendingTimeout()?.delayMs).toBe(DEEPGRAM_RECONNECT_POLICY.baseDelayMs * 2)

    harness.timers.runPendingTimeout()
    await settle()
    harness.deepgram.lastSocket().emitClose(1006)
    expect(harness.timers.pendingTimeout()?.delayMs).toBe(DEEPGRAM_RECONNECT_POLICY.baseDelayMs * 4)
  })

  it('resets the backoff once a connection succeeds', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    harness.deepgram.lastSocket().emitOpen()

    harness.deepgram.lastSocket().emitClose(1006)
    harness.timers.runPendingTimeout()
    await settle()
    harness.deepgram.lastSocket().emitOpen()
    expect(harness.provider.getState()).toBe('listening')

    harness.deepgram.lastSocket().emitClose(1006)
    expect(harness.timers.pendingTimeout()?.delayMs).toBe(DEEPGRAM_RECONNECT_POLICY.baseDelayMs)
  })

  it('keeps retrying when a reconnect attempt itself fails to connect', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    harness.deepgram.lastSocket().emitOpen()

    harness.deepgram.failures = 1
    harness.deepgram.lastSocket().emitClose(1006)
    harness.timers.runPendingTimeout()
    await settle()

    // The failed attempt scheduled another one rather than giving up mid-service.
    expect(harness.timers.pendingTimeout()).not.toBeNull()
    harness.timers.runPendingTimeout()
    await settle()
    expect(harness.deepgram.sockets).toHaveLength(2)
  })

  it('does not reconnect after an operator-initiated stop', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    await harness.provider.stop()
    socket.emitClose(1006)

    expect(harness.timers.pendingTimeout()).toBeNull()
    expect(harness.deepgram.connectArgs).toHaveLength(1)
  })

  it('reports failed and schedules nothing when the very first connect fails', async () => {
    const harness = createHarness()
    harness.deepgram.failures = 1

    const started = await harness.provider.start(settings())

    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(harness.provider.getState()).toBe('failed')
    expect(harness.timers.scheduled.size).toBe(0)
    expect(harness.provider.getLastError()).not.toBeNull()
  })

  it('records a socket error without tearing the session down itself', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    socket.emitError(new Error('transport hiccup'))

    // The close handler owns reconnection; an error alone must not schedule a second one.
    expect(harness.timers.pendingTimeout()).toBeNull()
    expect(harness.provider.getState()).toBe('listening')
  })
})

describe('keepalive', () => {
  it('pokes an idle socket so a silent prayer does not cost the connection', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    expect(harness.timers.pendingInterval()?.delayMs).toBe(DEFAULT_KEEPALIVE_MS)
    harness.timers.runPendingInterval()
    harness.timers.runPendingInterval()
    expect(socket.keepAlives).toBe(2)
  })

  it('cancels the keepalive when the socket closes', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()
    const intervalHandle = harness.timers.pendingInterval()?.handle

    socket.emitClose(1006)

    expect(harness.timers.pendingInterval()).toBeNull()
    expect(harness.timers.cleared).toContain(intervalHandle)
  })
})

// ---------------------------------------------------------------------------
// The outbound buffer
// ---------------------------------------------------------------------------

describe('outbound audio buffer', () => {
  it('defaults to five seconds of 16 kHz mono 16-bit PCM', () => {
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(160_000)
  })

  it('holds audio while the socket is still opening and flushes it in order', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()

    expect(harness.provider.pushAudio(pcmSilence(100)).ok).toBe(true)
    expect(harness.provider.pushAudio(pcmSineTone(100)).ok).toBe(true)
    expect(socket.sent).toHaveLength(0)
    expect(harness.provider.getBufferedBytes()).toBe(2 * 3200)

    socket.emitOpen()

    expect(socket.sent).toHaveLength(2)
    expect(harness.provider.getBufferedBytes()).toBe(0)
    // Order preserved: silence first, tone second.
    expect(socket.sent[0]?.every((byte) => byte === 0)).toBe(true)
    expect(socket.sent[1]?.some((byte) => byte !== 0)).toBe(true)
  })

  it('drops the OLDEST audio rather than growing without bound, and logs it', async () => {
    const harness = createHarness({ maxBufferedBytes: 300 })
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()

    // Socket not open yet, so all four chunks queue. The fourth evicts the first.
    harness.provider.pushAudio(markedChunk(100, 1))
    harness.provider.pushAudio(markedChunk(100, 2))
    harness.provider.pushAudio(markedChunk(100, 3))
    expect(harness.provider.getDroppedChunkCount()).toBe(0)

    harness.provider.pushAudio(markedChunk(100, 4))

    expect(harness.provider.getBufferedBytes()).toBe(300)
    expect(harness.provider.getDroppedChunkCount()).toBe(1)

    const dropWarning = harness.records.find(
      (record) => record.level === 'warn' && record.message.includes('buffer full')
    )
    expect(dropWarning).toBeDefined()
    expect(dropWarning?.fields?.['droppedChunks']).toBe(1)

    socket.emitOpen()
    expect(socket.sent.map((chunk) => chunk[0])).toEqual([2, 3, 4])
  })

  it('leaves the queue intact when the socket rejects a write', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    // Simulate the SDK's open-socket assertion firing between chunks.
    socket.isOpen = false
    harness.provider.pushAudio(markedChunk(100, 7))

    expect(socket.sent).toHaveLength(0)
    expect(harness.provider.getBufferedBytes()).toBe(100)

    socket.isOpen = true
    harness.provider.pushAudio(markedChunk(100, 8))
    expect(socket.sent.map((chunk) => chunk[0])).toEqual([7, 8])
  })

  it('refuses audio before start', () => {
    const harness = createHarness()
    const result = harness.provider.pushAudio(pcmSilence(100))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
  })

  it('accepts an empty chunk without queueing anything', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    expect(harness.provider.pushAudio(new ArrayBuffer(0)).ok).toBe(true)
    expect(harness.provider.getBufferedBytes()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('flushes, closes and cancels every timer', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()
    harness.provider.pushAudio(pcmSilence(100))

    const stopped = await harness.provider.stop()

    expect(stopped.ok).toBe(true)
    expect(socket.closeStreams).toBe(1)
    expect(socket.closeCalls).toBe(1)
    expect(harness.timers.scheduled.size).toBe(0)
    expect(harness.provider.getState()).toBe('idle')
    expect(harness.provider.getBufferedBytes()).toBe(0)
  })

  it('cancels a pending reconnect', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    harness.deepgram.lastSocket().emitOpen()
    harness.deepgram.lastSocket().emitClose(1006)
    expect(harness.timers.pendingTimeout()).not.toBeNull()

    await harness.provider.stop()

    expect(harness.timers.scheduled.size).toBe(0)
  })

  it('is idempotent and safe with no socket at all', async () => {
    const harness = createHarness()
    expect((await harness.provider.stop()).ok).toBe(true)
    expect((await harness.provider.stop()).ok).toBe(true)
  })

  it('dispose stops and detaches every listener', async () => {
    const harness = createHarness()
    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()

    await harness.provider.dispose()
    socket.emitMessage(resultsFrame({ transcript: 'after dispose', isFinal: true, start: 0, duration: 1 }))

    expect(harness.segments).toHaveLength(0)
    expect(socket.closeCalls).toBe(1)
  })

  it('returns to not-configured on stop when there is no key', async () => {
    const harness = createHarness({ apiKey: null })
    await harness.provider.stop()
    expect(harness.provider.getState()).toBe('not-configured')
  })
})

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('secret handling', () => {
  it('never hands the API key to the logger, only its presence', async () => {
    const harness = createHarness()

    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()
    socket.emitMessage(resultsFrame({ transcript: 'placeholder', isFinal: true, start: 0, duration: 1 }))
    socket.emitError(new Error('transport hiccup'))
    socket.emitClose(1006, 'abnormal')
    await harness.provider.stop()

    const serialised = JSON.stringify(harness.records)
    expect(harness.records.length).toBeGreaterThan(0)
    expect(serialised).not.toContain(API_KEY)
    expect(serialised).not.toContain('dg-secret')

    const connecting = harness.records.find((record) => record.message.includes('connecting'))
    expect(connecting?.fields?.['hasApiKey']).toBe(true)
  })

  it('logs presence as false, and nothing else, when unconfigured', async () => {
    const harness = createHarness({ apiKey: null })
    await harness.provider.start(settings())

    const record = harness.records.find((entry) => entry.message.includes('not configured'))
    expect(record?.fields?.['hasApiKey']).toBe(false)
    expect(JSON.stringify(harness.records)).not.toContain(API_KEY)
  })

  it('does not log raw audio bytes when the buffer overflows', async () => {
    const harness = createHarness({ maxBufferedBytes: 100 })
    await harness.provider.start(settings())
    harness.provider.pushAudio(pcmSineTone(50))
    harness.provider.pushAudio(pcmSineTone(50))

    const warning = harness.records.find((record) => record.message.includes('buffer full'))
    expect(warning).toBeDefined()
    for (const value of Object.values(warning?.fields ?? {})) {
      expect(typeof value).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('state transitions', () => {
  it('walks idle -> starting -> listening and never reports degraded', async () => {
    const harness = createHarness()
    expect(harness.provider.getState()).toBe('idle')

    await harness.provider.start(settings())
    expect(harness.provider.getState()).toBe('starting')

    harness.deepgram.lastSocket().emitOpen()
    expect(harness.provider.getState()).toBe('listening')

    await harness.provider.stop()

    expect(harness.states).toEqual(['starting', 'listening', 'idle'])
    // `degraded` describes a fallback across providers; only the owning service can say that.
    expect(harness.states).not.toContain('degraded')
  })

  it('notifies subscribers and stops notifying after unsubscribe', async () => {
    const harness = createHarness()
    const seen: AsrState[] = []
    const unsubscribe = harness.provider.onStateChange((state) => seen.push(state))

    await harness.provider.start(settings())
    unsubscribe()
    harness.deepgram.lastSocket().emitOpen()

    expect(seen).toEqual(['starting'])
  })

  it('identifies itself as the deepgram provider', () => {
    const harness = createHarness()
    expect(harness.provider.getId()).toBe('deepgram')
  })

  it('reports runtime trouble on onError rather than by throwing', async () => {
    const harness = createHarness()
    const errors: string[] = []
    harness.provider.onError((error) => errors.push(error.code))

    await harness.provider.start(settings())
    const socket = harness.deepgram.lastSocket()
    socket.emitOpen()
    socket.emitError(new Error('transport hiccup'))
    socket.emitClose(1006, 'abnormal')

    expect(errors).toEqual([ErrorCode.INTERNAL, ErrorCode.NOT_CONNECTED])
  })

  it('reports a refused first connection on onError too', async () => {
    const harness = createHarness()
    const errors: string[] = []
    harness.provider.onError((error) => errors.push(error.code))
    harness.deepgram.failures = 1

    await harness.provider.start(settings())

    expect(errors).toEqual([ErrorCode.NOT_CONNECTED])
  })

  it('survives a throwing state listener', async () => {
    const harness = createHarness()
    const spy = vi.fn()
    harness.provider.onStateChange(() => {
      throw new Error('state listener exploded')
    })
    harness.provider.onStateChange(spy)

    await harness.provider.start(settings())

    expect(spy).toHaveBeenCalled()
  })
})
