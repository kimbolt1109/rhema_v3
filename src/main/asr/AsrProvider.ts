/**
 * `AsrProvider` — the single interface both recognisers implement.
 *
 * Verger ships two engines with opposite failure modes (BLUEPRINT.md §8): Deepgram, which is
 * lower latency and much better at Korean but dies with the internet, and faster-whisper, which
 * keeps working offline but needs a GPU. `AsrService` owns the policy for choosing between them;
 * this file owns the shape they must both present so that policy can be written once.
 *
 * ## The draft/final contract lives here
 *
 * Everything a provider emits is a {@link TranscriptSegment}. For one span of speech it emits
 * many `isFinal: false` partials — each one REPLACING the previous, all sharing a stable `id` —
 * and then exactly one `isFinal: true` segment that supersedes them all. Consumers key on `id`
 * and replace; they never append until the final arrives. The local adapter's two-tier scheduler
 * obeys the same rule with different machinery: a `tiny` draft partial inside ~500 ms, then a
 * `small` final that replaces it (`docs/v2-notes/ASR_PIPELINE.md` §1).
 *
 * A provider that emits a fresh `id` per partial would make the transcript panel append flicker
 * instead of refining a line, so the id is part of the contract, not an implementation detail.
 *
 * ## Nothing here throws
 *
 * `start` and `stop` return a {@link Result}; errors that happen *while running* arrive on
 * {@link AsrProvider.onError} rather than as a rejected promise, because by then there is no
 * call to reject. A dead provider must produce a red light and silence — never a hang and never
 * an exception into the cue engine (Standing Rule 1: the operator carries on manually).
 */

import type { AsrLanguage, AsrProviderId, TranscriptSegment } from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'

/** Notified once per transcript fragment. Must not throw; the service wraps it anyway. */
export type AsrSegmentListener = (segment: TranscriptSegment) => void

/**
 * Notified when a running session hits trouble.
 *
 * One call is *not* a reason to switch providers — a websocket blip mid-sermon is normal. The
 * service debounces these; see `AsrService`'s failover policy.
 */
export type AsrErrorListener = (error: AppError) => void

/**
 * What a provider needs to open a session.
 *
 * Note what is absent: there is no audio device handle and no stream. Capture happens in the
 * RENDERER, because only it has `getUserMedia` — Electron's main process has no microphone
 * without a native module. Audio arrives afterwards, chunk by chunk, on
 * {@link AsrProvider.pushAudio}. `deviceId` is carried here for logging and for the status
 * readout only; no provider opens it.
 */
export interface AsrStartOptions {
  readonly language: AsrLanguage
  /**
   * Keyword-boost list — the pastor's name, the church name, hymn titles, recurring terms.
   *
   * BLUEPRINT.md §8 calls this essential, and it is: these are proper nouns a generic model has
   * never seen, so they are exactly the words it gets wrong and exactly the words a cue depends
   * on. Cloud passes them as keyterms; local passes them as an initial prompt.
   */
  readonly customVocabulary: readonly string[]
  /** Local model size (`tiny`, `small`, …). Ignored by the cloud adapter. */
  readonly localModel: string
  /** Informational: which input the renderer is capturing. Never opened by a provider. */
  readonly deviceId: string | null
}

/**
 * One speech recogniser.
 *
 * Implemented by the Deepgram (cloud) and faster-whisper (local) adapters. The service holds
 * these structurally, so a test drives the whole fallback policy with two forty-line doubles and
 * no network, no Python and no API key.
 */
export interface AsrProvider {
  /** Which engine this is. Stamped onto every segment so a fallback is visible in the UI. */
  getId(): AsrProviderId

  /**
   * Whether this provider could run *right now* — a key present, a sidecar available.
   *
   * Cheap and synchronous: the service calls it on every `start()` and while computing the
   * resting status, so it must not dial anything or spawn anything. `false` is a resting state,
   * not a failure (Standing Rule 5).
   */
  isConfigured(): boolean

  /**
   * Open a session. Resolves `Ok` once the provider is ready to accept audio.
   *
   * The service applies its own deadline around this, so an implementation that never resolves
   * degrades to the fallback rather than hanging the booth — but implementations should still
   * bound their own connect.
   */
  start(options: AsrStartOptions): Promise<Result<void>>

  /**
   * Hand over one PCM chunk: 16 kHz, mono, signed 16-bit little-endian, ~100 ms (`ASR_CHUNK_MS`).
   *
   * **Fire-and-forget. This MUST NOT throw and MUST NOT block.** It is called roughly ten times a
   * second for the entire length of a service — an hour is ~36,000 calls — from an IPC handler on
   * the main process's only thread. A synchronous exception here would tear down the audio path
   * mid-sermon; a blocking write would stall every other thing the main process does, including
   * the GO LIVE button. Implementations buffer or drop internally and report trouble on
   * {@link onError}. Audio pushed while the provider is not started is discarded silently.
   *
   * Raw audio is never logged (nor is its content inspected here) — it is a live recording of a
   * congregation.
   */
  pushAudio(chunk: Uint8Array): void

  /**
   * Close the session and release the socket or the child process.
   *
   * Must be safe to call when never started and safe to call twice. An `Err` is informational:
   * the service treats the provider as stopped regardless, because refusing to let go of a dead
   * recogniser would strand the operator on it.
   */
  stop(): Promise<Result<void>>

  /** Subscribe to transcript fragments. Returns the unsubscribe. */
  onSegment(callback: AsrSegmentListener): Unsubscribe

  /** Subscribe to runtime errors. Returns the unsubscribe. */
  onError(callback: AsrErrorListener): Unsubscribe
}

/**
 * Human-readable provider names, for status text the operator reads under pressure.
 *
 * "Deepgram failed; running on faster-whisper (local)" tells them what happened and what they
 * have now. "provider=whisper" does not.
 */
export const ASR_PROVIDER_LABELS: Readonly<Record<AsrProviderId, string>> = {
  deepgram: 'Deepgram (cloud)',
  whisper: 'faster-whisper (local)',
}

/** The label for a provider id, falling back to the id itself for forward compatibility. */
export function asrProviderLabel(id: AsrProviderId): string {
  return ASR_PROVIDER_LABELS[id]
}
