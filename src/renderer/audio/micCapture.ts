/**
 * Microphone capture for ASR.
 *
 * ## Why this lives in the renderer
 *
 * Only the renderer has `getUserMedia`. Electron's main process has no microphone at all without a
 * native module, so audio is captured here and pushed to main over `asr:push-audio`. That is a
 * deliberate deviation from the phase prompt's "capture in the main process", which is not
 * achievable in Electron with the dependencies this project has.
 *
 * ## What comes out
 *
 * `@shared/asr` fixes the wire format: **16 kHz, mono, signed 16-bit little-endian**, in
 * {@link ASR_CHUNK_MS} slices. Both Deepgram and faster-whisper want exactly that, so resampling
 * once here beats doing it per-provider, and one channel halves the IPC traffic for no accuracy
 * loss on a single speaker at a pulpit.
 *
 * ## Three constraint flags are deliberately OFF
 *
 * `echoCancellation`, `noiseSuppression` and `autoGainControl` are all disabled. They are tuned
 * for conference calls: AGC pumps a preacher's dynamics flat and then hunts during pauses, noise
 * suppression eats room tone and the quiet consonants that disambiguate Korean particles, and echo
 * cancellation is meaningless when there is no far-end signal. Every one of them measurably hurts
 * recognition on a sermon. Leave them off.
 *
 * ## Clamping, not wrapping
 *
 * A Float32 sample outside ±1.0 is normal on a hot pulpit mic. Converting it by truncation would
 * wrap `+1.2` round to a large negative int — an instantaneous full-scale discontinuity, which is
 * a loud click in the audio and a garbage token in the transcript. {@link floatSampleToInt16}
 * saturates instead. This is asserted by tests at and beyond both rails.
 *
 * ## Injectable on purpose
 *
 * jsdom has no `AudioContext`, no `AudioWorklet` and no `navigator.mediaDevices`. Every browser
 * dependency is a structural interface supplied through {@link MicCaptureDeps}, so the conversion,
 * chunking, enumeration and teardown paths are all exercised under vitest without a real device.
 *
 * No Node globals: this module is part of the renderer bundle.
 */

import type { AudioInputDevice } from '@shared/asr'
import { ASR_CHANNELS, ASR_CHUNK_MS, ASR_SAMPLE_RATE } from '@shared/asr'
import type { Result } from '@shared/result'
import { ErrorCode, err, ok, toAppError } from '@shared/result'

/* --------------------------------- format helpers (pure) --------------------------------- */

/** Samples in one {@link ASR_CHUNK_MS} chunk at {@link ASR_SAMPLE_RATE}. 1600 at the defaults. */
export const ASR_CHUNK_SAMPLES = Math.round((ASR_SAMPLE_RATE * ASR_CHUNK_MS) / 1000)

/** Bytes in one chunk: two per sample, one channel. */
export const ASR_CHUNK_BYTES = ASR_CHUNK_SAMPLES * 2 * ASR_CHANNELS

/** The most negative value a signed 16-bit sample can hold. */
export const INT16_MIN = -32_768

/** The most positive value a signed 16-bit sample can hold. */
export const INT16_MAX = 32_767

/**
 * One Float32 sample as signed 16-bit, **saturating** at both rails.
 *
 * The asymmetry is not a bug: two's complement has one more negative step than positive, so `-1.0`
 * maps to −32768 and `+1.0` to +32767. Anything beyond either rail clamps to it rather than
 * wrapping. `NaN` — which a disconnected interface can produce — becomes silence, not noise.
 */
export function floatSampleToInt16(sample: number): number {
  // NaN only. `Infinity` is deliberately *not* folded in here: it is an overload, and an overload
  // clamps to the rail like any other out-of-range sample.
  if (Number.isNaN(sample)) return 0
  if (sample >= 1) return INT16_MAX
  if (sample <= -1) return INT16_MIN
  return sample < 0 ? Math.round(sample * -INT16_MIN) : Math.round(sample * INT16_MAX)
}

/** A whole buffer of Float32 samples as signed 16-bit, clamped sample by sample. */
export function float32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    output[index] = floatSampleToInt16(input[index] ?? 0)
  }
  return output
}

/**
 * Linear resample.
 *
 * Linear interpolation rather than a windowed-sinc filter on purpose: the browser has already
 * band-limited the signal (the capture graph runs at the context's rate), the ratio here is a
 * downsample of at most 3× from 48 kHz, and speech recognition front-ends are far more sensitive
 * to latency and dropouts than to the aliasing this leaves behind. A no-op when the rates match,
 * which is the common case because the capture context is *asked* for 16 kHz.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0)

  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(Math.max(0, length))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const fraction = position - left
    const a = input[left] ?? 0
    const b = input[left + 1] ?? a
    output[index] = a + (b - a) * fraction
  }
  return output
}

/**
 * Cuts a continuous sample stream into fixed-size chunks.
 *
 * The audio graph hands over whatever block size it likes (128 frames for a worklet, 4096 for a
 * script processor, and neither is a whole number of 100 ms slices at 16 kHz), so the remainder has
 * to be carried across callbacks. Dropping it instead would clip a syllable every few blocks.
 */
export interface PcmChunker {
  /** Add samples; emits zero or more whole chunks. */
  push: (samples: Int16Array) => void
  /** Samples held back, waiting for the rest of a chunk. */
  pending: () => number
  /** Throw away the partial chunk. Called on stop — a fragment of a stopped session is noise. */
  reset: () => void
}

export function createPcmChunker(
  samplesPerChunk: number,
  emit: (chunk: ArrayBuffer) => void,
): PcmChunker {
  const size = Math.max(1, Math.floor(samplesPerChunk))
  let carry = new Int16Array(size)
  let filled = 0

  return {
    push: (samples) => {
      let offset = 0
      while (offset < samples.length) {
        const take = Math.min(size - filled, samples.length - offset)
        carry.set(samples.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        if (filled === size) {
          // A fresh buffer per chunk: the ArrayBuffer crosses the IPC boundary and is neutered by
          // structured clone, so reusing `carry` would hand the next chunk a detached buffer.
          const chunk = new Int16Array(carry)
          emit(chunk.buffer)
          filled = 0
        }
      }
    },
    pending: () => filled,
    reset: () => {
      carry = new Int16Array(size)
      filled = 0
    },
  }
}

/* ------------------------------- structural browser interfaces ------------------------------- */

/** The one method this module needs from a `MediaStreamTrack`. */
export interface MediaStreamTrackLike {
  stop: () => void
  readonly kind?: string
  readonly label?: string
}

export interface MediaStreamLike {
  getTracks: () => readonly MediaStreamTrackLike[]
}

export interface MediaDeviceInfoLike {
  readonly deviceId: string
  readonly kind: string
  readonly label: string
}

export interface MediaDevicesLike {
  getUserMedia: (constraints: MediaConstraintsLike) => Promise<MediaStreamLike>
  enumerateDevices: () => Promise<readonly MediaDeviceInfoLike[]>
}

/** Exactly the constraint shape this module builds — spelled out so the flags are visible. */
export interface MediaConstraintsLike {
  readonly audio: {
    readonly deviceId?: { readonly exact: string }
    readonly channelCount: number
    readonly echoCancellation: false
    readonly noiseSuppression: false
    readonly autoGainControl: false
  }
}

export interface AudioNodeLike {
  connect: (destination: AudioNodeLike) => void
  disconnect: () => void
}

/** The message port a worklet posts Float32 blocks back through. */
export interface WorkletPortLike {
  onmessage: ((event: { data: unknown }) => void) | null
  close?: () => void
}

export interface AudioWorkletNodeLike extends AudioNodeLike {
  readonly port: WorkletPortLike
}

export interface ScriptProcessorNodeLike extends AudioNodeLike {
  onaudioprocess: ((event: ScriptProcessorEventLike) => void) | null
}

export interface ScriptProcessorEventLike {
  readonly inputBuffer: { getChannelData: (channel: number) => Float32Array }
}

export interface AudioContextLike {
  readonly sampleRate: number
  readonly destination: AudioNodeLike
  readonly audioWorklet?: { addModule: (url: string) => Promise<void> }
  createMediaStreamSource: (stream: MediaStreamLike) => AudioNodeLike
  createScriptProcessor?: (
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ) => ScriptProcessorNodeLike
  close: () => Promise<void>
}

/** Everything the capture reaches the outside world through. */
export interface MicCaptureDeps {
  readonly mediaDevices: MediaDevicesLike
  /** Build a capture context. Asked for {@link ASR_SAMPLE_RATE}; may return any rate. */
  readonly createAudioContext: (sampleRate: number) => AudioContextLike
  /**
   * Construct an `AudioWorkletNode`. Absent means "no worklet available" and the capture falls
   * back to a `ScriptProcessorNode`.
   */
  readonly createWorkletNode?: (context: AudioContextLike, name: string) => AudioWorkletNodeLike
  /** Turn the worklet source into a URL `addModule` can load. Absent disables the worklet path. */
  readonly createModuleUrl?: (source: string) => string
  /** Release a URL made by {@link MicCaptureDeps.createModuleUrl}. */
  readonly revokeModuleUrl?: (url: string) => void
}

/* -------------------------------------- the worklet -------------------------------------- */

/** The registered name of the capture processor. */
export const MIC_WORKLET_NAME = 'verger-mic-capture'

/**
 * The AudioWorklet processor, as source.
 *
 * A worklet rather than `ScriptProcessorNode` because the latter is deprecated and — worse for a
 * live service — runs on the main thread, so a React render can drop audio blocks. This runs on the
 * audio thread and merely forwards raw Float32 to the main thread, where the conversion happens;
 * nothing here allocates per-sample or blocks.
 *
 * Shipped as a string and loaded from a blob URL so the renderer needs no extra build entry point
 * and no file at a path that changes between `dev` and a packaged app.
 */
export const MIC_WORKLET_SOURCE = `
class VergerMicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (channel && channel.length > 0) {
      // Copy: the render quantum's buffer is reused by the audio thread on the next call.
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}
registerProcessor(${JSON.stringify(MIC_WORKLET_NAME)}, VergerMicCaptureProcessor)
`

/* ------------------------------------ device enumeration ------------------------------------ */

/**
 * The audio inputs this machine has.
 *
 * Labels are empty strings until microphone permission has been granted at least once — that is
 * the browser privacy model, not a bug — so an unlabelled device keeps a stable, obviously-generic
 * placeholder rather than showing the operator a blank row.
 */
export async function listInputDevices(
  mediaDevices: MediaDevicesLike | undefined,
): Promise<Result<readonly AudioInputDevice[]>> {
  if (mediaDevices === undefined) {
    return err(ErrorCode.NOT_CONFIGURED, 'This runtime has no navigator.mediaDevices.')
  }
  try {
    const devices = await mediaDevices.enumerateDevices()
    const inputs = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label.length > 0 ? device.label : `Input ${String(index + 1)}`,
      }))
    return ok(inputs)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/** `navigator.mediaDevices` when this runtime has one. `undefined` under jsdom. */
export function browserMediaDevices(): MediaDevicesLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const devices: unknown = (navigator as { mediaDevices?: unknown }).mediaDevices
  if (devices === undefined || devices === null) return undefined
  return devices as MediaDevicesLike
}

/* --------------------------------------- the capture --------------------------------------- */

/** How the audio graph ended up delivering blocks. Surfaced so the panel can say so. */
export type MicCaptureTransport = 'worklet' | 'script-processor'

export interface MicCaptureSession {
  /** The device actually opened, or `null` when the OS default was used. */
  readonly deviceId: string | null
  readonly deviceLabel: string | null
  /** The rate the browser gave us, which is not always the rate we asked for. */
  readonly contextSampleRate: number
  readonly transport: MicCaptureTransport
}

export interface StartCaptureOptions {
  /** `null` or omitted opens the operating system's default input. */
  readonly deviceId?: string | null
  /** Called with one {@link ASR_CHUNK_BYTES}-byte chunk of 16 kHz mono s16le PCM. */
  readonly onChunk: (chunk: ArrayBuffer) => void
}

export interface MicCapture {
  start: (options: StartCaptureOptions) => Promise<Result<MicCaptureSession>>
  /** Release the device. Safe to call when not running. */
  stop: () => Promise<void>
  isRunning: () => boolean
  session: () => MicCaptureSession | null
}

/** The constraints handed to `getUserMedia`, built in one place so the flags stay auditable. */
export function micConstraints(deviceId: string | null): MediaConstraintsLike {
  return {
    audio: {
      // Spread rather than `deviceId: undefined`: `exactOptionalPropertyTypes` forbids assigning
      // undefined, and a browser treats a present-but-undefined key differently from an absent one.
      ...(deviceId === null || deviceId.length === 0 ? {} : { deviceId: { exact: deviceId } }),
      channelCount: ASR_CHANNELS,
      // See the module header. These three are off deliberately and permanently.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  }
}

/**
 * Build a capture bound to the supplied browser surface.
 *
 * Nothing here throws: a denied permission, an absent device and a graph that will not build all
 * come back as an `Err`. A microphone that cannot be opened must never take the console down with
 * it — the operator carries on manually (Standing Rule 1).
 */
export function createMicCapture(deps: MicCaptureDeps): MicCapture {
  let stream: MediaStreamLike | null = null
  let context: AudioContextLike | null = null
  let source: AudioNodeLike | null = null
  let worklet: AudioWorkletNodeLike | null = null
  let processor: ScriptProcessorNodeLike | null = null
  let moduleUrl: string | null = null
  let current: MicCaptureSession | null = null

  const teardown = async (): Promise<void> => {
    // Tracks first and unconditionally. The OS microphone indicator is driven by the tracks, and a
    // light still burning after the service is both alarming and a genuine privacy problem — so it
    // is released before anything that could plausibly fail.
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // A track that refuses to stop must not prevent the rest of the teardown.
        }
      }
      stream = null
    }
    if (worklet !== null) {
      worklet.port.onmessage = null
      try {
        worklet.port.close?.()
      } catch {
        /* already closed */
      }
      try {
        worklet.disconnect()
      } catch {
        /* already detached */
      }
      worklet = null
    }
    if (processor !== null) {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
      } catch {
        /* already detached */
      }
      processor = null
    }
    if (source !== null) {
      try {
        source.disconnect()
      } catch {
        /* already detached */
      }
      source = null
    }
    if (context !== null) {
      const closing = context
      context = null
      try {
        await closing.close()
      } catch {
        /* a context that will not close is not worth failing a stop over */
      }
    }
    if (moduleUrl !== null) {
      deps.revokeModuleUrl?.(moduleUrl)
      moduleUrl = null
    }
    current = null
  }

  const start = async (options: StartCaptureOptions): Promise<Result<MicCaptureSession>> => {
    // Restarting on a different device is a normal operator action mid-soundcheck; make it safe by
    // always releasing the previous graph first rather than leaking a second open microphone.
    await teardown()

    const deviceId = options.deviceId ?? null

    try {
      stream = await deps.mediaDevices.getUserMedia(micConstraints(deviceId))
    } catch (cause) {
      await teardown()
      return { ok: false, error: toAppError(cause, ErrorCode.NOT_CONFIGURED) }
    }

    try {
      context = deps.createAudioContext(ASR_SAMPLE_RATE)
      source = context.createMediaStreamSource(stream)
    } catch (cause) {
      await teardown()
      return { ok: false, error: toAppError(cause) }
    }

    const contextRate = context.sampleRate
    const chunker = createPcmChunker(ASR_CHUNK_SAMPLES, options.onChunk)
    const handleBlock = (block: Float32Array): void => {
      chunker.push(float32ToInt16(resampleLinear(block, contextRate, ASR_SAMPLE_RATE)))
    }

    let transport: MicCaptureTransport | null = null

    // Preferred path: an AudioWorklet on the audio thread.
    if (
      context.audioWorklet !== undefined &&
      deps.createWorkletNode !== undefined &&
      deps.createModuleUrl !== undefined
    ) {
      try {
        moduleUrl = deps.createModuleUrl(MIC_WORKLET_SOURCE)
        await context.audioWorklet.addModule(moduleUrl)
        const node = deps.createWorkletNode(context, MIC_WORKLET_NAME)
        node.port.onmessage = (event) => {
          if (event.data instanceof Float32Array) handleBlock(event.data)
        }
        source.connect(node)
        worklet = node
        transport = 'worklet'
      } catch {
        // Fall through to the deprecated node rather than failing. A worklet that will not load is
        // a reason to be slower, not a reason to have no transcript.
        if (moduleUrl !== null) {
          deps.revokeModuleUrl?.(moduleUrl)
          moduleUrl = null
        }
        worklet = null
      }
    }

    if (transport === null && context.createScriptProcessor !== undefined) {
      try {
        // 4096 frames ≈ 256 ms at 16 kHz. Smaller sizes glitch on a main thread that is also
        // rendering React; the chunker re-slices to 100 ms regardless, so this costs buffering,
        // not resolution.
        const node = context.createScriptProcessor(4096, ASR_CHANNELS, ASR_CHANNELS)
        node.onaudioprocess = (event) => {
          handleBlock(event.inputBuffer.getChannelData(0))
        }
        source.connect(node)
        // A ScriptProcessorNode only fires while it is connected to a destination. Nothing is
        // audible because the node writes no output samples.
        node.connect(context.destination)
        processor = node
        transport = 'script-processor'
      } catch {
        processor = null
      }
    }

    if (transport === null) {
      await teardown()
      return err(
        ErrorCode.INTERNAL,
        'This runtime supports neither an AudioWorklet nor a ScriptProcessorNode, so the microphone cannot be captured.',
      )
    }

    const track = stream.getTracks().find((candidate) => candidate.kind !== 'video')
    const label = track?.label ?? ''
    current = {
      deviceId,
      deviceLabel: label.length > 0 ? label : null,
      contextSampleRate: contextRate,
      transport,
    }
    return ok(current)
  }

  return {
    start,
    // The partial chunk held by the session's chunker is dropped with the chunker itself: a
    // fragment of a stopped session is noise, not speech, and flushing it would push a
    // half-length buffer the recogniser has to guess at.
    stop: teardown,
    isRunning: () => current !== null,
    session: () => current,
  }
}

/**
 * A capture wired to the real browser, or an `Err` when this runtime has no audio at all.
 *
 * Called by the transcript panel; jsdom takes the `Err` branch, which is why every UI test injects
 * a fake instead of monkey-patching globals.
 */
export function createBrowserMicCapture(): Result<MicCapture> {
  const mediaDevices = browserMediaDevices()
  if (mediaDevices === undefined) {
    return err(
      ErrorCode.NOT_CONFIGURED,
      'This runtime has no microphone access (navigator.mediaDevices is unavailable).',
    )
  }

  const globalScope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
  const AudioContextCtor = globalScope['AudioContext'] as
    | (new (options: { sampleRate: number }) => AudioContextLike)
    | undefined
  if (AudioContextCtor === undefined) {
    return err(ErrorCode.NOT_CONFIGURED, 'This runtime has no AudioContext.')
  }

  const WorkletNodeCtor = globalScope['AudioWorkletNode'] as
    | (new (context: AudioContextLike, name: string) => AudioWorkletNodeLike)
    | undefined
  const BlobCtor = globalScope['Blob'] as
    | (new (parts: readonly string[], options: { type: string }) => Blob)
    | undefined
  const urls = globalScope['URL'] as
    | { createObjectURL: (blob: Blob) => string; revokeObjectURL: (url: string) => void }
    | undefined

  const deps: MicCaptureDeps = {
    mediaDevices,
    createAudioContext: (sampleRate) => new AudioContextCtor({ sampleRate }),
    // Spread rather than an explicit `undefined`: `exactOptionalPropertyTypes` treats a
    // present-but-undefined optional as an error, and the worklet path is genuinely absent in a
    // runtime that has no `AudioWorkletNode`.
    ...(WorkletNodeCtor === undefined
      ? {}
      : {
          createWorkletNode: (context: AudioContextLike, name: string) =>
            new WorkletNodeCtor(context, name),
        }),
    ...(BlobCtor === undefined || urls === undefined
      ? {}
      : {
          createModuleUrl: (source: string) =>
            urls.createObjectURL(new BlobCtor([source], { type: 'text/javascript' })),
          revokeModuleUrl: (url: string) => {
            urls.revokeObjectURL(url)
          },
        }),
  }

  return ok(createMicCapture(deps))
}
