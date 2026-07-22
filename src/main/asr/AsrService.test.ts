/**
 * `AsrService` behaviour, driven entirely against two hand-written provider doubles.
 *
 * No Deepgram key, no network, no Python, no GPU, no Electron. That is the point: the fallback
 * policy is the part of this subsystem that only ever executes when something has already gone
 * wrong mid-service, so it has to be provable on a laptop rather than discovered on a Sunday.
 *
 * The load-bearing blocks here are the failover ones. `degraded` and `failed` must stay distinct,
 * a single transient error must not move the transcript to another engine, and nothing — not a
 * throwing provider, not a throwing subscriber, not audio arriving after a stop — may propagate
 * an exception into the main process.
 *
 * Standing Rule 4: every transcript string below is invented placeholder text, and every PCM
 * buffer is synthesised in code (digital silence, or a 440 Hz sine). No recording and no
 * transcript of a real service exists anywhere in this repo.
 */

import { describe, expect, it, vi } from 'vitest'

import { AsrService } from '@main/asr/AsrService'
import type { AsrConfigLike, AsrTimerHandle, AsrTimers } from '@main/asr/AsrService'
import type {
  AsrErrorListener,
  AsrProvider,
  AsrSegmentListener,
  AsrStartOptions,
} from '@main/asr/AsrProvider'
import { createNullLogger } from '@main/logging/logger'
import {
  ASR_BITS_PER_SAMPLE,
  ASR_CHUNK_MS,
  ASR_SAMPLE_RATE,
  defaultAsrSettings,
} from '@shared/asr'
import type { AsrProviderId, AsrSettings, AsrStatus, TranscriptSegment } from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Synthesised audio — never a fixture file
// ---------------------------------------------------------------------------

const BYTES_PER_SAMPLE = ASR_BITS_PER_SAMPLE / 8

/** One chunk of digital silence in the pipeline's format: 16 kHz, mono, s16le. */
function silentPcm(ms: number = ASR_CHUNK_MS): Uint8Array {
  return new Uint8Array(Math.round((ASR_SAMPLE_RATE * ms) / 1000) * BYTES_PER_SAMPLE)
}

/** One chunk of a sine tone, so a test can prove audio is forwarded byte-for-byte. */
function tonePcm(hz = 440, ms: number = ASR_CHUNK_MS): Uint8Array {
  const samples = Math.round((ASR_SAMPLE_RATE * ms) / 1000)
  const buffer = new ArrayBuffer(samples * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * hz * i) / ASR_SAMPLE_RATE) * 12_000
    view.setInt16(i * BYTES_PER_SAMPLE, Math.round(value), true)
  }
  return new Uint8Array(buffer)
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type StartOutcome = 'ok' | 'error' | 'reject' | 'throw-sync' | 'hang'
type StopOutcome = 'ok' | 'error' | 'throw'

/** A fully typed `AsrProvider` that records everything and can fail in every documented way. */
class MockProvider implements AsrProvider {
  configured = true
  startOutcome: StartOutcome = 'ok'
  stopOutcome: StopOutcome = 'ok'
  pushThrows = false

  starts = 0
  stops = 0
  lastStartOptions: AsrStartOptions | null = null
  readonly chunks: Uint8Array[] = []

  private readonly segmentListeners = new Set<AsrSegmentListener>()
  private readonly errorListeners = new Set<AsrErrorListener>()

  constructor(private readonly id: AsrProviderId) {}

  getId(): AsrProviderId {
    return this.id
  }

  isConfigured(): boolean {
    return this.configured
  }

  // Deliberately NOT `async`: `throw-sync` has to throw before a promise exists, which is the
  // one failure mode an `async` method can never reproduce.
  start(options: AsrStartOptions): Promise<Result<void>> {
    this.starts += 1
    this.lastStartOptions = options
    if (this.startOutcome === 'throw-sync') throw new Error(`${this.id} threw synchronously`)
    if (this.startOutcome === 'reject') return Promise.reject(new Error(`${this.id} rejected`))
    if (this.startOutcome === 'hang') return new Promise<Result<void>>(() => undefined)
    if (this.startOutcome === 'error') {
      return Promise.resolve(err(ErrorCode.NOT_CONNECTED, `${this.id} refused to start`))
    }
    return Promise.resolve(ok(undefined))
  }

  pushAudio(chunk: Uint8Array): void {
    if (this.pushThrows) throw new Error(`${this.id} exploded on audio`)
    this.chunks.push(chunk)
  }

  stop(): Promise<Result<void>> {
    this.stops += 1
    if (this.stopOutcome === 'throw') throw new Error(`${this.id} threw on stop`)
    if (this.stopOutcome === 'error') {
      return Promise.resolve(err(ErrorCode.INTERNAL, `${this.id} could not be stopped`))
    }
    return Promise.resolve(ok(undefined))
  }

  onSegment(callback: AsrSegmentListener): Unsubscribe {
    this.segmentListeners.add(callback)
    return () => {
      this.segmentListeners.delete(callback)
    }
  }

  onError(callback: AsrErrorListener): Unsubscribe {
    this.errorListeners.add(callback)
    return () => {
      this.errorListeners.delete(callback)
    }
  }

  // --- test drivers -------------------------------------------------------

  emit(segment: TranscriptSegment): void {
    for (const listener of [...this.segmentListeners]) listener(segment)
  }

  emitError(message: string): void {
    for (const listener of [...this.errorListeners]) {
      listener({ code: ErrorCode.INTERNAL, message })
    }
  }

  /** True when the service is currently subscribed to this provider. */
  get attached(): boolean {
    return this.segmentListeners.size > 0
  }
}

/** Timers under the test's control, so a start deadline fires exactly when asked. */
class ManualTimers implements AsrTimers {
  private nextHandle = 1
  readonly pending = new Map<number, () => void>()

  setTimeout(handler: () => void, _delayMs: number): AsrTimerHandle {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.pending.set(handle, handler)
    return handle
  }

  clearTimeout(handle: AsrTimerHandle): void {
    this.pending.delete(handle as number)
  }

  fireAll(): void {
    const handlers = [...this.pending.values()]
    this.pending.clear()
    for (const handler of handlers) handler()
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: AsrService
  readonly deepgram: MockProvider
  readonly whisper: MockProvider
  readonly timers: ManualTimers
  readonly clock: { now: number }
  readonly statuses: AsrStatus[]
  readonly transcripts: TranscriptSegment[]
  readonly saved: { settings: AsrSettings | null }
  readonly persistCalls: { count: number }
}

interface HarnessOptions {
  readonly config?: AsrConfigLike
  readonly settings?: AsrSettings
  readonly providers?: readonly AsrProvider[]
  readonly failureThreshold?: number
  readonly errorWindowMs?: number
  readonly persistResult?: Result<void>
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const deepgram = new MockProvider('deepgram')
  const whisper = new MockProvider('whisper')
  const timers = new ManualTimers()
  const clock = { now: 1_000 }
  const statuses: AsrStatus[] = []
  const transcripts: TranscriptSegment[] = []
  const saved: { settings: AsrSettings | null } = { settings: options.settings ?? null }
  const persistCalls = { count: 0 }

  const service = new AsrService({
    config: options.config ?? { deepgramApiKey: 'unit-test-placeholder' },
    logger: createNullLogger(),
    providers: options.providers ?? [deepgram, whisper],
    now: () => clock.now,
    timers,
    load: () => ok(saved.settings),
    persist: (next) => {
      persistCalls.count += 1
      const result = options.persistResult ?? ok(undefined)
      if (result.ok) saved.settings = next
      return result
    },
    failureThreshold: options.failureThreshold ?? 3,
    errorWindowMs: options.errorWindowMs ?? 15_000,
  })

  service.onStatus((status) => statuses.push(status))
  service.onTranscript((segment) => transcripts.push(segment))

  return { service, deepgram, whisper, timers, clock, statuses, transcripts, saved, persistCalls }
}

/** Let queued microtasks and the failover chain settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function settingsWith(patch: Partial<AsrSettings>): AsrSettings {
  return { ...defaultAsrSettings(), ...patch }
}

let segmentCounter = 0

/** A transcript fragment with invented placeholder text. */
function segmentWith(patch: Partial<TranscriptSegment> & { readonly id?: string }): TranscriptSegment {
  segmentCounter += 1
  return {
    id: patch.id ?? `span-${String(segmentCounter)}`,
    text: patch.text ?? 'placeholder utterance one',
    isFinal: patch.isFinal ?? false,
    tsStart: patch.tsStart ?? 0,
    tsEnd: patch.tsEnd ?? 1_000,
    confidence: patch.confidence ?? 0.9,
    provider: patch.provider ?? 'deepgram',
    isDraft: patch.isDraft ?? false,
  }
}

function statusOf(service: AsrService): AsrStatus {
  const result = service.getStatus()
  if (!result.ok) throw new Error('getStatus must always succeed')
  return result.value
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

describe('AsrService — mode selection', () => {
  it('uses Deepgram and only Deepgram in cloud mode', async () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ mode: 'cloud' }))

    const started = await harness.service.start()

    expect(started.ok).toBe(true)
    expect(harness.deepgram.starts).toBe(1)
    expect(harness.whisper.starts).toBe(0)
    expect(statusOf(harness.service).provider).toBe('deepgram')
    expect(statusOf(harness.service).state).toBe('listening')
  })

  it('uses whisper and only whisper in local mode, even with a cloud key present', async () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ mode: 'local' }))

    await harness.service.start()

    expect(harness.whisper.starts).toBe(1)
    expect(harness.deepgram.starts).toBe(0)
    expect(statusOf(harness.service).provider).toBe('whisper')
  })

  it('prefers Deepgram in auto mode', async () => {
    const harness = makeHarness()

    await harness.service.start()

    expect(defaultAsrSettings().mode).toBe('auto')
    expect(harness.deepgram.starts).toBe(1)
    expect(harness.whisper.starts).toBe(0)
    expect(statusOf(harness.service).state).toBe('listening')
  })

  it('passes the language, model and custom vocabulary through to the provider', async () => {
    const harness = makeHarness()
    harness.service.setSettings(
      settingsWith({
        mode: 'local',
        language: 'en',
        localModel: 'tiny',
        customVocabulary: ['Placeholder Name', 'Placeholder Church'],
        deviceId: 'mic-7',
      })
    )

    await harness.service.start()

    expect(harness.whisper.lastStartOptions).toEqual({
      language: 'en',
      localModel: 'tiny',
      customVocabulary: ['Placeholder Name', 'Placeholder Church'],
      deviceId: 'mic-7',
    })
  })

  it('is idempotent — starting twice does not re-open the session', async () => {
    const harness = makeHarness()

    await harness.service.start()
    const second = await harness.service.start()

    expect(second.ok).toBe(true)
    expect(harness.deepgram.starts).toBe(1)
  })

  it('runs local without degrading when auto mode simply has no cloud key', async () => {
    // Nothing failed here: an empty DEEPGRAM_API_KEY is a resting state, not a fallback. A
    // permanent amber light would teach the operator to ignore amber lights.
    const harness = makeHarness({ config: { deepgramApiKey: null } })
    harness.deepgram.configured = false

    await harness.service.start()

    expect(statusOf(harness.service).state).toBe('listening')
    expect(statusOf(harness.service).provider).toBe('whisper')
    expect(statusOf(harness.service).lastError).toBeNull()
    expect(harness.deepgram.starts).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('AsrService — auto fallback', () => {
  it('falls back to whisper and reports degraded when Deepgram refuses to start', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'

    const started = await harness.service.start()

    expect(started.ok).toBe(true)
    const status = statusOf(harness.service)
    expect(status.state).toBe('degraded')
    expect(status.provider).toBe('whisper')
    expect(status.lastError).toContain('Deepgram')
    expect(harness.whisper.starts).toBe(1)
  })

  it('treats a synchronous throw from start() as a failure, not a crash', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'throw-sync'

    const started = await harness.service.start()

    expect(started.ok).toBe(true)
    expect(statusOf(harness.service).state).toBe('degraded')
    expect(statusOf(harness.service).provider).toBe('whisper')
  })

  it('treats a rejected start() as a failure', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'reject'

    await harness.service.start()

    expect(statusOf(harness.service).state).toBe('degraded')
    expect(statusOf(harness.service).provider).toBe('whisper')
  })

  it('falls back when a provider never becomes ready, rather than hanging the booth', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'hang'

    const pending = harness.service.start()
    // The provider's promise will never settle; only the deadline can rescue the session.
    harness.timers.fireAll()
    const started = await pending

    expect(started.ok).toBe(true)
    expect(statusOf(harness.service).state).toBe('degraded')
    expect(statusOf(harness.service).provider).toBe('whisper')
    expect(statusOf(harness.service).lastError).toContain('did not become ready')
  })

  it('switches after repeated runtime errors and names the provider it fell back to', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('websocket closed')
    harness.deepgram.emitError('websocket closed')
    harness.deepgram.emitError('websocket closed')
    await flush()

    const status = statusOf(harness.service)
    expect(status.state).toBe('degraded')
    expect(status.provider).toBe('whisper')
    expect(status.lastError).toContain('Deepgram (cloud) failed')
    expect(harness.deepgram.stops).toBe(1)
    expect(harness.deepgram.attached).toBe(false)
    expect(harness.whisper.attached).toBe(true)
  })

  it('does NOT switch on a single transient error', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('one dropped frame')
    await flush()

    const status = statusOf(harness.service)
    expect(status.state).toBe('listening')
    expect(status.provider).toBe('deepgram')
    // The operator still gets to see that something happened.
    expect(status.lastError).toContain('one dropped frame')
    expect(harness.whisper.starts).toBe(0)
  })

  it('does not switch on two errors when the threshold is three', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('blip')
    harness.deepgram.emitError('blip')
    await flush()

    expect(statusOf(harness.service).provider).toBe('deepgram')
    expect(harness.whisper.starts).toBe(0)
  })

  it('ages errors out of the window, so a flaky afternoon is not a dead provider', async () => {
    const harness = makeHarness({ errorWindowMs: 1_000 })
    await harness.service.start()

    for (let i = 0; i < 5; i += 1) {
      harness.deepgram.emitError('an occasional stumble')
      harness.clock.now += 5_000
    }
    await flush()

    expect(statusOf(harness.service).state).toBe('listening')
    expect(statusOf(harness.service).provider).toBe('deepgram')
  })

  it('clears the error streak when speech starts arriving again', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('blip')
    harness.deepgram.emitError('blip')
    harness.deepgram.emit(segmentWith({ text: 'placeholder utterance two' }))
    harness.deepgram.emitError('blip')
    harness.deepgram.emitError('blip')
    await flush()

    expect(statusOf(harness.service).provider).toBe('deepgram')
    expect(harness.whisper.starts).toBe(0)
  })

  it('never switches back to the preferred provider during a session', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('gone')
    harness.deepgram.emitError('gone')
    harness.deepgram.emitError('gone')
    await flush()
    expect(statusOf(harness.service).provider).toBe('whisper')

    // Deepgram is healthy again — irrelevant. Flipping engines mid-sermon rewrites the
    // transcript in front of the operator, and the local transcript is good, not broken.
    harness.whisper.emit(segmentWith({ provider: 'whisper', text: 'placeholder utterance three' }))
    await flush()

    expect(statusOf(harness.service).provider).toBe('whisper')
    expect(harness.deepgram.starts).toBe(1)
  })

  it('ignores a late error from a provider it has already abandoned', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emitError('gone')
    harness.deepgram.emitError('gone')
    harness.deepgram.emitError('gone')
    await flush()

    const before = statusOf(harness.service)
    harness.deepgram.emitError('a straggler from the old socket')
    await flush()

    expect(statusOf(harness.service)).toEqual(before)
  })

  it('goes to failed — not degraded — when the fallback also fails', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    harness.whisper.startOutcome = 'error'

    const started = await harness.service.start()

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(started.error.code).toBe(ErrorCode.INTERNAL)

    const status = statusOf(harness.service)
    expect(status.state).toBe('failed')
    expect(status.provider).toBeNull()
    expect(status.since).toBeNull()
  })

  it('goes to failed when the only provider in cloud mode dies at runtime', async () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ mode: 'cloud' }))
    await harness.service.start()

    harness.deepgram.emitError('the internet went with the stream')
    harness.deepgram.emitError('the internet went with the stream')
    harness.deepgram.emitError('the internet went with the stream')
    await flush()

    expect(statusOf(harness.service).state).toBe('failed')
    expect(statusOf(harness.service).provider).toBeNull()
    expect(harness.whisper.starts).toBe(0)
  })

  it('goes to failed when the fallback also dies at runtime', async () => {
    const harness = makeHarness()
    await harness.service.start()

    for (let i = 0; i < 3; i += 1) harness.deepgram.emitError('cloud gone')
    await flush()
    expect(statusOf(harness.service).state).toBe('degraded')

    for (let i = 0; i < 3; i += 1) harness.whisper.emitError('sidecar gone')
    await flush()

    expect(statusOf(harness.service).state).toBe('failed')
    expect(statusOf(harness.service).provider).toBeNull()
  })

  it('keeps degraded and failed distinct in the emitted status stream', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    await harness.service.start()
    for (let i = 0; i < 3; i += 1) harness.whisper.emitError('sidecar gone')
    await flush()

    const states = harness.statuses.map((status) => status.state)
    expect(states).toContain('degraded')
    expect(states).toContain('failed')
    expect(states.indexOf('degraded')).toBeLessThan(states.lastIndexOf('failed'))
  })

  it('survives a provider that throws while being stopped during failover', async () => {
    const harness = makeHarness()
    harness.deepgram.stopOutcome = 'throw'
    await harness.service.start()

    for (let i = 0; i < 3; i += 1) harness.deepgram.emitError('gone')
    await flush()

    expect(statusOf(harness.service).provider).toBe('whisper')
  })
})

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------

describe('AsrService — not configured', () => {
  it('reports not-configured at rest when nothing can run', () => {
    const harness = makeHarness({ config: { deepgramApiKey: null } })
    harness.deepgram.configured = false
    harness.whisper.configured = false

    expect(statusOf(harness.service).state).toBe('not-configured')
  })

  it('returns a renderable Result rather than throwing', async () => {
    const harness = makeHarness({ config: { deepgramApiKey: null } })
    harness.deepgram.configured = false
    harness.whisper.configured = false

    const started = await harness.service.start()

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(started.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(started.error.detail).toContain('DEEPGRAM_API_KEY')
    expect(statusOf(harness.service).state).toBe('not-configured')
  })

  it('never puts the key itself in the error, only the key name', async () => {
    const harness = makeHarness({ config: { deepgramApiKey: 'super-secret-value' } })
    harness.service.setSettings(settingsWith({ mode: 'cloud' }))
    harness.deepgram.configured = false

    const started = await harness.service.start()

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(JSON.stringify(started.error)).not.toContain('super-secret-value')
  })

  it('reports not-configured in cloud mode when only the local model is available', async () => {
    const harness = makeHarness({ config: { deepgramApiKey: null } })
    harness.deepgram.configured = false
    harness.service.setSettings(settingsWith({ mode: 'cloud' }))

    const started = await harness.service.start()

    expect(started.ok).toBe(false)
    expect(statusOf(harness.service).state).toBe('not-configured')
    expect(harness.whisper.starts).toBe(0)
  })

  it('recovers to idle once a provider becomes available', () => {
    const harness = makeHarness({ config: { deepgramApiKey: null } })
    harness.deepgram.configured = false
    harness.whisper.configured = false
    expect(statusOf(harness.service).state).toBe('not-configured')

    harness.whisper.configured = true

    expect(statusOf(harness.service).state).toBe('idle')
  })

  it('treats a provider whose isConfigured() throws as simply unavailable', () => {
    const exploding: AsrProvider = {
      getId: () => 'deepgram',
      isConfigured: () => {
        throw new Error('probe failed')
      },
      start: () => Promise.resolve(ok(undefined)),
      pushAudio: () => undefined,
      stop: () => Promise.resolve(ok(undefined)),
      onSegment: () => () => undefined,
      onError: () => () => undefined,
    }
    const harness = makeHarness({ providers: [exploding] })
    harness.service.setSettings(settingsWith({ mode: 'cloud' }))

    expect(statusOf(harness.service).state).toBe('not-configured')
  })
})

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

describe('AsrService — the draft/final replacement contract', () => {
  it('forwards every partial for a span under one stable id, then the final', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'span-a', text: 'the', isDraft: true }))
    harness.deepgram.emit(segmentWith({ id: 'span-a', text: 'the morning', isDraft: true }))
    harness.deepgram.emit(segmentWith({ id: 'span-a', text: 'the morning notice', isDraft: true }))
    harness.deepgram.emit(
      segmentWith({ id: 'span-a', text: 'the morning notices', isFinal: true, isDraft: false })
    )

    expect(harness.transcripts).toHaveLength(4)
    expect(harness.transcripts.every((segment) => segment.id === 'span-a')).toBe(true)
    expect(harness.transcripts.map((segment) => segment.isFinal)).toEqual([
      false,
      false,
      false,
      true,
    ])
    // The last one supersedes all of them; a consumer replacing by id ends on this text.
    expect(harness.transcripts.at(-1)?.text).toBe('the morning notices')
  })

  it('keeps spans separate, so two utterances never merge', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'span-a', text: 'first utterance', isFinal: true }))
    harness.deepgram.emit(segmentWith({ id: 'span-b', text: 'second utterance', isFinal: true }))

    expect(harness.transcripts.map((segment) => segment.id)).toEqual(['span-a', 'span-b'])
  })

  it('forwards a local draft and the final that replaces it under the same id', async () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ mode: 'local' }))
    await harness.service.start()

    harness.whisper.emit(
      segmentWith({ id: 'span-t', text: 'placeholder draft', provider: 'whisper', isDraft: true })
    )
    harness.whisper.emit(
      segmentWith({
        id: 'span-t',
        text: 'placeholder final',
        provider: 'whisper',
        isFinal: true,
        isDraft: false,
      })
    )

    expect(harness.transcripts).toHaveLength(2)
    expect(harness.transcripts[0]?.isDraft).toBe(true)
    expect(harness.transcripts[1]?.isDraft).toBe(false)
    expect(harness.transcripts[1]?.id).toBe('span-t')
  })

  it('ignores segments from a provider it is no longer using', async () => {
    const harness = makeHarness()
    await harness.service.start()
    for (let i = 0; i < 3; i += 1) harness.deepgram.emitError('gone')
    await flush()

    harness.deepgram.emit(segmentWith({ id: 'stale', text: 'placeholder stale text' }))

    expect(harness.transcripts.map((segment) => segment.id)).not.toContain('stale')
  })

  it('drops nothing on the floor when a subscriber throws', async () => {
    const harness = makeHarness()
    const seen: string[] = []
    harness.service.onTranscript(() => {
      throw new Error('a badly written panel')
    })
    harness.service.onTranscript((segment) => seen.push(segment.id))
    await harness.service.start()

    expect(() => {
      harness.deepgram.emit(segmentWith({ id: 'span-x' }))
    }).not.toThrow()
    expect(seen).toEqual(['span-x'])
  })

  it('stops forwarding after unsubscribe', async () => {
    const harness = makeHarness()
    const seen: string[] = []
    const unsubscribe = harness.service.onTranscript((segment) => seen.push(segment.id))
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'span-1' }))
    unsubscribe()
    harness.deepgram.emit(segmentWith({ id: 'span-2' }))

    expect(seen).toEqual(['span-1'])
  })
})

describe('AsrService — hallucination filtering', () => {
  it('drops a final that is entirely a known artefact', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(
      segmentWith({ id: 'span-h', text: 'thank you for watching', isFinal: true })
    )

    expect(harness.transcripts).toHaveLength(0)
  })

  it('drops the Korean subtitle artefacts too', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'k1', text: '시청해 주셔서 감사합니다', isFinal: true }))
    harness.deepgram.emit(segmentWith({ id: 'k2', text: '[음악]', isFinal: true }))

    expect(harness.transcripts).toHaveLength(0)
  })

  it('never filters a draft — a draft is replaced anyway, and immediacy is its whole point', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(
      segmentWith({ id: 'span-d', text: 'thank you for watching', isFinal: false, isDraft: true })
    )

    expect(harness.transcripts).toHaveLength(1)
    expect(harness.transcripts[0]?.text).toBe('thank you for watching')
  })

  it('retracts a published draft with an empty final rather than leaving a phantom on screen', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(
      segmentWith({ id: 'span-r', text: 'thank you for', isFinal: false, isDraft: true })
    )
    harness.deepgram.emit(
      segmentWith({ id: 'span-r', text: 'thank you for watching', isFinal: true, isDraft: false })
    )

    // Consumers replace by id, so an empty final erases the draft. Simply dropping the final
    // would leave "thank you for" on the transcript panel for the rest of the service.
    expect(harness.transcripts).toHaveLength(2)
    expect(harness.transcripts[1]).toMatchObject({ id: 'span-r', text: '', isFinal: true })
  })

  it('lets a real sentence containing an artefact phrase through', async () => {
    const harness = makeHarness()
    await harness.service.start()

    const text = 'thank you for watching over one another this week'
    harness.deepgram.emit(segmentWith({ id: 'span-s', text, isFinal: true }))

    expect(harness.transcripts).toHaveLength(1)
    expect(harness.transcripts[0]?.text).toBe(text)
  })

  it('lets a bare 감사합니다 through, because a pulpit says it constantly', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'span-g', text: '감사합니다', isFinal: true }))

    expect(harness.transcripts).toHaveLength(1)
  })

  it('drops an empty final, which is what a stalled provider emits', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.deepgram.emit(segmentWith({ id: 'span-e', text: '   ', isFinal: true }))

    expect(harness.transcripts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

describe('AsrService — pushAudio', () => {
  it('forwards chunks byte-for-byte to the active provider', async () => {
    const harness = makeHarness()
    await harness.service.start()

    const tone = tonePcm()
    harness.service.pushAudio(tone)

    expect(harness.deepgram.chunks).toHaveLength(1)
    expect(harness.deepgram.chunks[0]).toBe(tone)
    expect(tone.byteLength).toBe((ASR_SAMPLE_RATE * ASR_CHUNK_MS) / 1000 / (1 / BYTES_PER_SAMPLE))
  })

  it('is a harmless no-op before start', () => {
    const harness = makeHarness()

    const result = harness.service.pushAudio(silentPcm())

    expect(result.ok).toBe(true)
    expect(harness.deepgram.chunks).toHaveLength(0)
    expect(harness.whisper.chunks).toHaveLength(0)
  })

  it('is a harmless no-op after stop', async () => {
    const harness = makeHarness()
    await harness.service.start()
    await harness.service.stop()

    const result = harness.service.pushAudio(silentPcm())

    expect(result.ok).toBe(true)
    expect(harness.deepgram.chunks).toHaveLength(0)
  })

  it('is a harmless no-op once every provider has failed', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    harness.whisper.startOutcome = 'error'
    await harness.service.start()

    expect(statusOf(harness.service).state).toBe('failed')
    expect(harness.service.pushAudio(silentPcm()).ok).toBe(true)
  })

  it('never throws, even when the provider explodes on every chunk', async () => {
    const harness = makeHarness()
    await harness.service.start()
    harness.deepgram.pushThrows = true

    expect(() => harness.service.pushAudio(tonePcm())).not.toThrow()
    expect(harness.service.pushAudio(tonePcm()).ok).toBe(true)
  })

  it('counts an exploding pushAudio toward the same debounced failover', async () => {
    const harness = makeHarness()
    await harness.service.start()
    harness.deepgram.pushThrows = true

    harness.service.pushAudio(silentPcm())
    await flush()
    expect(statusOf(harness.service).provider).toBe('deepgram')

    harness.service.pushAudio(silentPcm())
    harness.service.pushAudio(silentPcm())
    await flush()

    expect(statusOf(harness.service).provider).toBe('whisper')
    expect(statusOf(harness.service).state).toBe('degraded')
  })

  it('routes audio to the fallback provider after a switch', async () => {
    const harness = makeHarness()
    await harness.service.start()
    for (let i = 0; i < 3; i += 1) harness.deepgram.emitError('gone')
    await flush()

    harness.service.pushAudio(tonePcm())

    expect(harness.whisper.chunks).toHaveLength(1)
    expect(harness.deepgram.chunks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

describe('AsrService — latency', () => {
  it('is null before any speech has been measured', async () => {
    const harness = makeHarness()
    await harness.service.start()

    expect(statusOf(harness.service).latencyMs).toBeNull()
  })

  it('measures from the first chunk of a span to its first partial', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.service.pushAudio(tonePcm())
    harness.clock.now += 300
    harness.deepgram.emit(segmentWith({ id: 'span-l1' }))

    expect(statusOf(harness.service).latencyMs).toBe(300)
  })

  it('reports the median, so one slow model load does not skew the readout', async () => {
    const harness = makeHarness()
    await harness.service.start()

    for (const [index, delay] of [200, 250, 8_000].entries()) {
      harness.service.pushAudio(tonePcm())
      harness.clock.now += delay
      harness.deepgram.emit(segmentWith({ id: `span-m${String(index)}` }))
    }

    expect(statusOf(harness.service).latencyMs).toBe(250)
  })

  it('measures only the first fragment of a span, not its refinements', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.service.pushAudio(tonePcm())
    harness.clock.now += 200
    harness.deepgram.emit(segmentWith({ id: 'span-l2', text: 'placeholder' }))
    harness.clock.now += 4_000
    harness.deepgram.emit(segmentWith({ id: 'span-l2', text: 'placeholder text', isFinal: true }))

    expect(statusOf(harness.service).latencyMs).toBe(200)
  })

  it('resets the measurement between sessions', async () => {
    const harness = makeHarness()
    await harness.service.start()
    harness.service.pushAudio(tonePcm())
    harness.clock.now += 400
    harness.deepgram.emit(segmentWith({ id: 'span-l3' }))
    expect(statusOf(harness.service).latencyMs).toBe(400)

    await harness.service.stop()
    await harness.service.start()

    expect(statusOf(harness.service).latencyMs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('AsrService — settings', () => {
  it('starts from the defaults when nothing is saved', () => {
    const harness = makeHarness()
    const settings = harness.service.getSettings()

    expect(settings.ok).toBe(true)
    if (!settings.ok) throw new Error('unreachable')
    expect(settings.value).toEqual(defaultAsrSettings())
    expect(settings.value.localModel).toBe('small')
  })

  it('round-trips through persistence', () => {
    const harness = makeHarness()
    const next = settingsWith({
      mode: 'local',
      language: 'en',
      deviceId: 'mic-2',
      customVocabulary: ['Placeholder Hymn', 'Placeholder Name'],
      localModel: 'tiny',
    })

    const saved = harness.service.setSettings(next)

    expect(saved.ok).toBe(true)
    expect(harness.saved.settings).toEqual(next)

    // A fresh service reading the same store comes back to exactly the same settings.
    const persisted = harness.saved.settings
    if (persisted === null) throw new Error('the settings were not persisted')
    const reloaded = makeHarness({ settings: persisted })
    const read = reloaded.service.getSettings()
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.value).toEqual(next)
  })

  it('rejects invalid settings without persisting them', () => {
    const harness = makeHarness()
    const bogus = { ...defaultAsrSettings(), mode: 'telepathy' } as unknown as AsrSettings

    const result = harness.service.setSettings(bogus)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(harness.persistCalls.count).toBe(0)
    expect(harness.service.getSettings()).toEqual(ok(defaultAsrSettings()))
  })

  it('keeps the new settings in memory when saving them fails', () => {
    const harness = makeHarness({
      persistResult: err(ErrorCode.IO_ERROR, 'the disk is full'),
    })

    const result = harness.service.setSettings(settingsWith({ language: 'en' }))

    expect(result.ok).toBe(false)
    // Settings that work until the app restarts beat no settings at all.
    const settings = harness.service.getSettings()
    if (!settings.ok) throw new Error('unreachable')
    expect(settings.value.language).toBe('en')
  })

  it('falls back to the defaults when the saved settings are corrupt', () => {
    const service = new AsrService({
      config: { deepgramApiKey: null },
      logger: createNullLogger(),
      providers: [],
      load: () => ok({ mode: 'nonsense' } as unknown as AsrSettings),
    })

    expect(service.getSettings()).toEqual(ok(defaultAsrSettings()))
  })

  it('falls back to the defaults when reading the saved settings throws', () => {
    const service = new AsrService({
      config: { deepgramApiKey: null },
      logger: createNullLogger(),
      providers: [],
      load: () => {
        throw new Error('the file is locked')
      },
    })

    expect(service.getSettings()).toEqual(ok(defaultAsrSettings()))
  })

  it('applies a mode change at the next start, not mid-session', async () => {
    const harness = makeHarness()
    await harness.service.start()
    expect(statusOf(harness.service).provider).toBe('deepgram')

    harness.service.setSettings(settingsWith({ mode: 'local' }))

    // Re-opening the recogniser mid-sermon would cost a gap in the transcript.
    expect(statusOf(harness.service).provider).toBe('deepgram')
    expect(harness.whisper.starts).toBe(0)

    await harness.service.stop()
    await harness.service.start()

    expect(statusOf(harness.service).provider).toBe('whisper')
  })
})

// ---------------------------------------------------------------------------
// Devices and status
// ---------------------------------------------------------------------------

describe('AsrService — devices and status', () => {
  it('resolves the device label the renderer reported', () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ deviceId: 'mic-2' }))

    harness.service.listDevices([
      { deviceId: 'mic-1', label: 'Built-in Microphone' },
      { deviceId: 'mic-2', label: 'Pulpit Condenser' },
    ])

    const status = statusOf(harness.service)
    expect(status.deviceId).toBe('mic-2')
    expect(status.deviceLabel).toBe('Pulpit Condenser')
  })

  it('reports a null label for a device that is no longer present', () => {
    const harness = makeHarness()
    harness.service.setSettings(settingsWith({ deviceId: 'mic-unplugged' }))
    harness.service.listDevices([{ deviceId: 'mic-1', label: 'Built-in Microphone' }])

    expect(statusOf(harness.service).deviceLabel).toBeNull()
  })

  it('publishes a status only when something observable changed', async () => {
    const harness = makeHarness()
    await harness.service.start()
    const count = harness.statuses.length

    harness.service.listDevices([])
    harness.service.listDevices([])

    expect(harness.statuses).toHaveLength(count)
  })

  it('keeps publishing after a status subscriber throws', async () => {
    const harness = makeHarness()
    const seen: string[] = []
    harness.service.onStatus(() => {
      throw new Error('a badly written status light')
    })
    harness.service.onStatus((status) => seen.push(status.state))

    await expect(harness.service.start()).resolves.toMatchObject({ ok: true })
    expect(seen).toContain('listening')
  })

  it('stops publishing after unsubscribe', async () => {
    const harness = makeHarness()
    const seen: string[] = []
    const unsubscribe = harness.service.onStatus((status) => seen.push(status.state))

    await harness.service.start()
    const before = seen.length
    unsubscribe()
    await harness.service.stop()

    expect(seen).toHaveLength(before)
  })

  it('retains the last error after a stop, so the operator can still read it', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    await harness.service.start()
    expect(statusOf(harness.service).lastError).not.toBeNull()

    await harness.service.stop()

    expect(statusOf(harness.service).state).toBe('idle')
    expect(statusOf(harness.service).lastError).not.toBeNull()
  })

  it('clears the last error on the next start', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    await harness.service.start()
    await harness.service.stop()

    harness.deepgram.startOutcome = 'ok'
    await harness.service.start()

    expect(statusOf(harness.service).lastError).toBeNull()
    expect(statusOf(harness.service).state).toBe('listening')
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('AsrService — lifecycle', () => {
  it('stops the active provider and detaches from it', async () => {
    const harness = makeHarness()
    await harness.service.start()

    const stopped = await harness.service.stop()

    expect(stopped.ok).toBe(true)
    expect(harness.deepgram.stops).toBe(1)
    expect(harness.deepgram.attached).toBe(false)
    expect(statusOf(harness.service).provider).toBeNull()
    expect(statusOf(harness.service).since).toBeNull()
  })

  it('reports success even when the provider refuses to stop', async () => {
    const harness = makeHarness()
    harness.deepgram.stopOutcome = 'error'
    await harness.service.start()

    // Refusing to let go of a dead recogniser would strand the operator on it.
    await expect(harness.service.stop()).resolves.toMatchObject({ ok: true })
    expect(statusOf(harness.service).state).toBe('idle')
  })

  it('is safe to stop when never started', async () => {
    const harness = makeHarness()

    await expect(harness.service.stop()).resolves.toMatchObject({ ok: true })
    expect(harness.deepgram.stops).toBe(0)
  })

  it('can be restarted after a total failure', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'error'
    harness.whisper.startOutcome = 'error'
    await harness.service.start()
    expect(statusOf(harness.service).state).toBe('failed')

    harness.deepgram.startOutcome = 'ok'
    const restarted = await harness.service.start()

    expect(restarted.ok).toBe(true)
    expect(statusOf(harness.service).state).toBe('listening')
  })

  it('refuses to start once disposed, and does not throw', async () => {
    const harness = makeHarness()
    await harness.service.start()

    harness.service.dispose()
    const started = await harness.service.start()

    expect(started.ok).toBe(false)
    expect(harness.deepgram.stops).toBe(1)
  })

  it('is safe to dispose twice', () => {
    const harness = makeHarness()

    expect(harness.service.dispose()).toEqual(ok(undefined))
    expect(harness.service.dispose()).toEqual(ok(undefined))
  })

  it('never lets an exception escape any public method', async () => {
    const harness = makeHarness()
    harness.deepgram.startOutcome = 'throw-sync'
    harness.whisper.startOutcome = 'throw-sync'

    const spy = vi.fn()
    harness.service.onStatus(spy)

    await expect(harness.service.start()).resolves.toMatchObject({ ok: false })
    expect(() => harness.service.pushAudio(silentPcm())).not.toThrow()
    await expect(harness.service.stop()).resolves.toMatchObject({ ok: true })
    expect(() => harness.service.listDevices([])).not.toThrow()
    expect(spy).toHaveBeenCalled()
  })
})
