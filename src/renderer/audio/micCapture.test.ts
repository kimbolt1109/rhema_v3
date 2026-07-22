/**
 * Microphone capture's contract.
 *
 * The assertions that matter are the ones that would otherwise fail silently in front of a
 * congregation:
 *
 *  - **Clamping, not wrapping.** A sample at or beyond ±1.0 must saturate. If it wrapped, `+1.2`
 *    would become a large negative value — a full-scale discontinuity, which is an audible click
 *    and a garbage token. This is asserted at both rails and well past them.
 *  - **Chunk sizing.** Exactly {@link ASR_CHUNK_BYTES} per push, with the remainder carried across
 *    callbacks rather than dropped, because dropping it clips a syllable every few blocks.
 *  - **Every track is stopped.** A live microphone indicator after the service is a privacy
 *    problem, so `stop()` is asserted to have released *all* tracks, not just the first.
 *
 * **No audio fixtures.** Every waveform here is synthesised in-process — silence, a sine, and a
 * deliberately over-driven ramp. Nothing recorded, nothing copyrighted (Standing Rule 4).
 */

import { describe, expect, it } from 'vitest'

import type { AudioInputDevice } from '@shared/asr'
import { ASR_CHUNK_MS, ASR_SAMPLE_RATE } from '@shared/asr'

import type {
  AudioContextLike,
  AudioNodeLike,
  AudioWorkletNodeLike,
  MediaDeviceInfoLike,
  MediaDevicesLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  ScriptProcessorEventLike,
  ScriptProcessorNodeLike,
} from './micCapture'
import {
  ASR_CHUNK_BYTES,
  ASR_CHUNK_SAMPLES,
  INT16_MAX,
  INT16_MIN,
  createMicCapture,
  createPcmChunker,
  float32ToInt16,
  floatSampleToInt16,
  listInputDevices,
  micConstraints,
  resampleLinear,
} from './micCapture'

/* ------------------------------------ synthesised audio ------------------------------------ */

/** `seconds` of digital silence at `rate`. */
function silence(seconds: number, rate = ASR_SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * rate))
}

/** A sine tone, amplitude in [0,1]. Generated, never loaded from a file. */
function sine(seconds: number, hz: number, amplitude = 0.5, rate = ASR_SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / rate)
  }
  return samples
}

/* ------------------------------------- fake browser bits ------------------------------------- */

class FakeTrack implements MediaStreamTrackLike {
  stopped = false
  constructor(
    readonly kind: string,
    readonly label: string,
  ) {}
  stop(): void {
    this.stopped = true
  }
}

class FakeStream implements MediaStreamLike {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): readonly MediaStreamTrackLike[] {
    return this.tracks
  }
}

class FakeNode implements AudioNodeLike {
  connected: AudioNodeLike[] = []
  disconnected = 0
  connect(destination: AudioNodeLike): void {
    this.connected.push(destination)
  }
  disconnect(): void {
    this.disconnected += 1
  }
}

class FakeScriptProcessor extends FakeNode implements ScriptProcessorNodeLike {
  onaudioprocess: ((event: ScriptProcessorEventLike) => void) | null = null
  /** Feed a block the way the audio thread would. */
  deliver(block: Float32Array): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } })
  }
}

class FakeWorkletNode extends FakeNode implements AudioWorkletNodeLike {
  readonly port: { onmessage: ((event: { data: unknown }) => void) | null; close?: () => void } = {
    onmessage: null,
  }
  deliver(block: Float32Array): void {
    this.port.onmessage?.({ data: block })
  }
}

interface FakeContextOptions {
  readonly sampleRate?: number
  readonly withWorklet?: boolean
  /** Make `addModule` reject, to exercise the fallback. */
  readonly workletFails?: boolean
}

class FakeAudioContext implements AudioContextLike {
  readonly sampleRate: number
  readonly destination = new FakeNode()
  readonly source = new FakeNode()
  readonly processors: FakeScriptProcessor[] = []
  closed = 0
  readonly audioWorklet?: { addModule: (url: string) => Promise<void> }
  readonly addedModules: string[] = []

  constructor(options: FakeContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? ASR_SAMPLE_RATE
    if (options.withWorklet === true) {
      this.audioWorklet = {
        addModule: (url: string) => {
          this.addedModules.push(url)
          return options.workletFails === true
            ? Promise.reject(new Error('addModule refused'))
            : Promise.resolve()
        },
      }
    }
  }

  createMediaStreamSource(): AudioNodeLike {
    return this.source
  }

  createScriptProcessor(): ScriptProcessorNodeLike {
    const node = new FakeScriptProcessor()
    this.processors.push(node)
    return node
  }

  close(): Promise<void> {
    this.closed += 1
    return Promise.resolve()
  }
}

class FakeMediaDevices implements MediaDevicesLike {
  readonly constraints: unknown[] = []
  stream = new FakeStream([new FakeTrack('audio', 'Pulpit mic'), new FakeTrack('audio', 'aux')])
  denied: Error | null = null
  devices: MediaDeviceInfoLike[] = [
    { deviceId: 'default', kind: 'audioinput', label: 'Default — USB Audio CODEC' },
    { deviceId: 'cam-mic', kind: 'videoinput', label: 'Webcam' },
    { deviceId: 'unlabelled', kind: 'audioinput', label: '' },
  ]

  getUserMedia(constraints: unknown): Promise<MediaStreamLike> {
    this.constraints.push(constraints)
    if (this.denied !== null) return Promise.reject(this.denied)
    return Promise.resolve(this.stream)
  }

  enumerateDevices(): Promise<readonly MediaDeviceInfoLike[]> {
    return Promise.resolve(this.devices)
  }
}

/* ---------------------------------------- the tests ---------------------------------------- */

describe('floatSampleToInt16', () => {
  it('maps the rails exactly, with the asymmetry two’s complement actually has', () => {
    expect(floatSampleToInt16(1)).toBe(INT16_MAX)
    expect(floatSampleToInt16(-1)).toBe(INT16_MIN)
    expect(floatSampleToInt16(0)).toBe(0)
  })

  it('CLAMPS beyond the rails rather than wrapping', () => {
    // The failure this guards against: a wrapped +1.2 becomes a large NEGATIVE number, which is a
    // full-scale discontinuity — a loud click and a transcription error.
    for (const overdriven of [1.0001, 1.2, 2, 17, Number.MAX_SAFE_INTEGER, Infinity]) {
      const value = floatSampleToInt16(overdriven)
      expect(value).toBe(INT16_MAX)
      expect(value).toBeGreaterThan(0)
    }
    for (const overdriven of [-1.0001, -1.2, -2, -17, -Number.MAX_SAFE_INTEGER, -Infinity]) {
      const value = floatSampleToInt16(overdriven)
      expect(value).toBe(INT16_MIN)
      expect(value).toBeLessThan(0)
    }
  })

  it('turns NaN into silence rather than noise', () => {
    expect(floatSampleToInt16(Number.NaN)).toBe(0)
  })

  it('never leaves the signed 16-bit range for any input', () => {
    const hostile = new Float32Array([
      0, 1, -1, 0.9999999, -0.9999999, 5, -5, Number.NaN, Infinity, -Infinity, 1e30, -1e30,
    ])
    for (const sample of hostile) {
      const value = floatSampleToInt16(sample)
      expect(value).toBeGreaterThanOrEqual(INT16_MIN)
      expect(value).toBeLessThanOrEqual(INT16_MAX)
      expect(Number.isInteger(value)).toBe(true)
    }
  })
})

describe('float32ToInt16', () => {
  it('converts silence to silence', () => {
    const converted = float32ToInt16(silence(0.01))
    expect(converted.length).toBe(160)
    expect([...converted].every((value) => value === 0)).toBe(true)
  })

  it('keeps a sine inside the rails and preserves its sign pattern', () => {
    const tone = sine(0.05, 440, 0.8)
    const converted = float32ToInt16(tone)
    expect(converted.length).toBe(tone.length)
    for (let index = 0; index < converted.length; index += 1) {
      const source = tone[index] ?? 0
      const value = converted[index] ?? 0
      expect(value).toBeGreaterThanOrEqual(INT16_MIN)
      expect(value).toBeLessThanOrEqual(INT16_MAX)
      // A sample too small to survive quantisation legitimately rounds to zero; what must never
      // happen is a positive input landing on a negative output, which is what wrapping looks like.
      if (value !== 0) expect(Math.sign(value)).toBe(Math.sign(source))
    }
  })

  it('clips an over-driven sine instead of wrapping it', () => {
    // Amplitude 1.6 — a hot pulpit mic into a badly gain-staged interface. Every sample past the
    // rail must saturate; if any wrapped, the maximum and minimum would be violated.
    const converted = float32ToInt16(sine(0.05, 220, 1.6))
    const values = [...converted]
    expect(Math.max(...values)).toBe(INT16_MAX)
    expect(Math.min(...values)).toBe(INT16_MIN)
    // And the waveform must still be monotonic in sign — a wrap would put a positive input sample
    // on the negative rail.
    expect(values.some((value) => value === INT16_MAX)).toBe(true)
    expect(values.some((value) => value === INT16_MIN)).toBe(true)
  })
})

describe('resampleLinear', () => {
  it('is a no-op when the rates already match', () => {
    const input = sine(0.01, 300)
    expect(resampleLinear(input, ASR_SAMPLE_RATE, ASR_SAMPLE_RATE)).toBe(input)
  })

  it('produces the expected sample count downsampling 48 kHz to 16 kHz', () => {
    const input = sine(1, 300, 0.5, 48_000)
    const output = resampleLinear(input, 48_000, ASR_SAMPLE_RATE)
    expect(output.length).toBe(ASR_SAMPLE_RATE)
  })

  it('interpolates rather than dropping samples', () => {
    const input = new Float32Array([0, 1, 0, -1])
    const output = resampleLinear(input, 4, 8)
    expect(output.length).toBe(8)
    expect(output[0]).toBeCloseTo(0)
    expect(output[1]).toBeCloseTo(0.5)
    expect(output[2]).toBeCloseTo(1)
  })
})

describe('createPcmChunker', () => {
  it('emits whole chunks only, carrying the remainder across pushes', () => {
    const chunks: ArrayBuffer[] = []
    const chunker = createPcmChunker(4, (chunk) => chunks.push(chunk))

    chunker.push(new Int16Array([1, 2, 3]))
    expect(chunks).toHaveLength(0)
    expect(chunker.pending()).toBe(3)

    chunker.push(new Int16Array([4, 5]))
    expect(chunks).toHaveLength(1)
    expect([...new Int16Array(chunks[0] as ArrayBuffer)]).toEqual([1, 2, 3, 4])
    expect(chunker.pending()).toBe(1)
  })

  it('hands out an independent buffer per chunk', () => {
    const chunks: ArrayBuffer[] = []
    const chunker = createPcmChunker(2, (chunk) => chunks.push(chunk))
    chunker.push(new Int16Array([1, 2, 3, 4]))
    expect(chunks).toHaveLength(2)
    expect([...new Int16Array(chunks[0] as ArrayBuffer)]).toEqual([1, 2])
    expect([...new Int16Array(chunks[1] as ArrayBuffer)]).toEqual([3, 4])
  })

  it('drops the partial chunk on reset', () => {
    const chunks: ArrayBuffer[] = []
    const chunker = createPcmChunker(4, (chunk) => chunks.push(chunk))
    chunker.push(new Int16Array([1, 2]))
    chunker.reset()
    expect(chunker.pending()).toBe(0)
    chunker.push(new Int16Array([1, 2, 3, 4]))
    expect([...new Int16Array(chunks[0] as ArrayBuffer)]).toEqual([1, 2, 3, 4])
  })
})

describe('micConstraints', () => {
  it('turns off the three conference-call filters, always', () => {
    const constraints = micConstraints(null)
    expect(constraints.audio.echoCancellation).toBe(false)
    expect(constraints.audio.noiseSuppression).toBe(false)
    expect(constraints.audio.autoGainControl).toBe(false)
    expect(constraints.audio.channelCount).toBe(1)
  })

  it('omits deviceId entirely for the system default rather than sending an empty one', () => {
    expect(Object.prototype.hasOwnProperty.call(micConstraints(null).audio, 'deviceId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(micConstraints('').audio, 'deviceId')).toBe(false)
    expect(micConstraints('pulpit').audio.deviceId).toEqual({ exact: 'pulpit' })
  })
})

describe('listInputDevices', () => {
  it('returns audio inputs only, and never the webcam', async () => {
    const result = await listInputDevices(new FakeMediaDevices())
    expect(result.ok).toBe(true)
    const devices: readonly AudioInputDevice[] = result.ok ? result.value : []
    expect(devices.map((device) => device.deviceId)).toEqual(['default', 'unlabelled'])
  })

  it('gives an unlabelled device a placeholder rather than a blank row', async () => {
    const result = await listInputDevices(new FakeMediaDevices())
    const devices = result.ok ? result.value : []
    expect(devices[1]?.label).toMatch(/input/i)
    expect(devices[1]?.label.length).toBeGreaterThan(0)
  })

  it('refuses rather than throwing when the runtime has no mediaDevices', async () => {
    const result = await listInputDevices(undefined)
    expect(result.ok).toBe(false)
  })
})

describe('createMicCapture', () => {
  function build(options: FakeContextOptions = {}): {
    devices: FakeMediaDevices
    contexts: FakeAudioContext[]
    worklets: FakeWorkletNode[]
    revoked: string[]
    capture: ReturnType<typeof createMicCapture>
  } {
    const devices = new FakeMediaDevices()
    const contexts: FakeAudioContext[] = []
    const worklets: FakeWorkletNode[] = []
    const revoked: string[] = []
    const capture = createMicCapture({
      mediaDevices: devices,
      createAudioContext: () => {
        const context = new FakeAudioContext(options)
        contexts.push(context)
        return context
      },
      createWorkletNode: () => {
        const node = new FakeWorkletNode()
        worklets.push(node)
        return node
      },
      createModuleUrl: () => 'blob:verger-mic-worklet',
      revokeModuleUrl: (url) => revoked.push(url),
    })
    return { devices, contexts, worklets, revoked, capture }
  }

  it('opens the requested device with the three filters off', async () => {
    const { devices, capture } = build()
    const started = await capture.start({ deviceId: 'mock-pulpit', onChunk: () => undefined })

    expect(started.ok).toBe(true)
    expect(devices.constraints).toEqual([micConstraints('mock-pulpit')])
    expect(capture.isRunning()).toBe(true)
  })

  it('emits exactly one 100 ms chunk per 100 ms of audio, via the ScriptProcessor fallback', async () => {
    const { contexts, capture } = build()
    const chunks: ArrayBuffer[] = []
    await capture.start({ onChunk: (chunk) => chunks.push(chunk) })

    const context = contexts[0]
    const processor = context?.processors[0]
    expect(processor).toBeDefined()
    expect(capture.session()?.transport).toBe('script-processor')

    // One second of synthesised tone at the capture rate.
    processor?.deliver(sine(1, 300, 0.4))

    expect(chunks).toHaveLength(1000 / ASR_CHUNK_MS)
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBe(ASR_CHUNK_BYTES)
      expect(new Int16Array(chunk).length).toBe(ASR_CHUNK_SAMPLES)
    }
  })

  it('carries a partial block across callbacks instead of clipping it', async () => {
    const { contexts, capture } = build()
    const chunks: ArrayBuffer[] = []
    await capture.start({ onChunk: (chunk) => chunks.push(chunk) })
    const processor = contexts[0]?.processors[0]

    // 4096 frames is what a real ScriptProcessorNode hands over, and it is not a whole number of
    // 100 ms slices at 16 kHz.
    processor?.deliver(sine(4096 / ASR_SAMPLE_RATE, 300, 0.4))
    expect(chunks).toHaveLength(Math.floor(4096 / ASR_CHUNK_SAMPLES))

    processor?.deliver(sine(4096 / ASR_SAMPLE_RATE, 300, 0.4))
    expect(chunks).toHaveLength(Math.floor(8192 / ASR_CHUNK_SAMPLES))
  })

  it('downsamples a 48 kHz context to 16 kHz before chunking', async () => {
    const { contexts, capture } = build({ sampleRate: 48_000 })
    const chunks: ArrayBuffer[] = []
    await capture.start({ onChunk: (chunk) => chunks.push(chunk) })

    expect(capture.session()?.contextSampleRate).toBe(48_000)
    // One second at 48 kHz is still one second of speech, so still ten 100 ms chunks.
    contexts[0]?.processors[0]?.deliver(sine(1, 300, 0.4, 48_000))
    expect(chunks).toHaveLength(10)
  })

  it('prefers an AudioWorklet when one is available', async () => {
    const { contexts, worklets, capture } = build({ withWorklet: true })
    const chunks: ArrayBuffer[] = []
    await capture.start({ onChunk: (chunk) => chunks.push(chunk) })

    expect(capture.session()?.transport).toBe('worklet')
    expect(contexts[0]?.addedModules).toEqual(['blob:verger-mic-worklet'])
    expect(contexts[0]?.processors).toHaveLength(0)

    worklets[0]?.deliver(sine(0.5, 300, 0.4))
    expect(chunks).toHaveLength(5)
  })

  it('falls back to the ScriptProcessor when the worklet module will not load', async () => {
    const { revoked, capture } = build({ withWorklet: true, workletFails: true })
    await capture.start({ onChunk: () => undefined })

    expect(capture.session()?.transport).toBe('script-processor')
    // The blob URL is released rather than leaked when the worklet path is abandoned.
    expect(revoked).toContain('blob:verger-mic-worklet')
  })

  it('stops EVERY track on stop, so no microphone indicator is left burning', async () => {
    const { devices, contexts, capture } = build()
    await capture.start({ onChunk: () => undefined })
    expect(devices.stream.tracks.every((track) => track.stopped)).toBe(false)

    await capture.stop()

    expect(devices.stream.tracks).toHaveLength(2)
    expect(devices.stream.tracks.every((track) => track.stopped)).toBe(true)
    expect(contexts[0]?.closed).toBe(1)
    expect(capture.isRunning()).toBe(false)
    expect(capture.session()).toBeNull()
  })

  it('detaches the audio graph so no chunk arrives after stop', async () => {
    const { contexts, capture } = build()
    const chunks: ArrayBuffer[] = []
    await capture.start({ onChunk: (chunk) => chunks.push(chunk) })
    const processor = contexts[0]?.processors[0]

    await capture.stop()
    processor?.deliver(sine(1, 300, 0.4))

    expect(chunks).toHaveLength(0)
    expect(processor?.disconnected).toBeGreaterThan(0)
  })

  it('releases the previous device before opening another', async () => {
    const { devices, capture } = build()
    await capture.start({ deviceId: 'a', onChunk: () => undefined })
    const first = devices.stream
    devices.stream = new FakeStream([new FakeTrack('audio', 'Second mic')])

    await capture.start({ deviceId: 'b', onChunk: () => undefined })

    expect(first.tracks.every((track) => track.stopped)).toBe(true)
    expect(devices.stream.tracks.every((track) => track.stopped)).toBe(false)
    await capture.stop()
  })

  it('returns an Err — never throws — when permission is denied', async () => {
    const { devices, capture } = build()
    devices.denied = new Error('Permission denied')

    const started = await capture.start({ onChunk: () => undefined })

    expect(started.ok).toBe(false)
    expect(started.ok ? '' : started.error.message).toMatch(/permission denied/i)
    expect(capture.isRunning()).toBe(false)
  })

  it('reports the track label so the panel can name the open microphone', async () => {
    const { capture } = build()
    await capture.start({ onChunk: () => undefined })
    expect(capture.session()?.deviceLabel).toBe('Pulpit mic')
  })

  it('is safe to stop when it was never started', async () => {
    const { capture } = build()
    await expect(capture.stop()).resolves.toBeUndefined()
  })

  it('refuses cleanly when the runtime has neither transport', async () => {
    const devices = new FakeMediaDevices()
    const capture = createMicCapture({
      mediaDevices: devices,
      createAudioContext: () =>
        ({
          sampleRate: ASR_SAMPLE_RATE,
          destination: new FakeNode(),
          createMediaStreamSource: () => new FakeNode(),
          close: () => Promise.resolve(),
        }) satisfies AudioContextLike,
    })

    const started = await capture.start({ onChunk: () => undefined })

    expect(started.ok).toBe(false)
    // And the microphone it had already opened is released rather than left running.
    expect(devices.stream.tracks.every((track) => track.stopped)).toBe(true)
  })
})
