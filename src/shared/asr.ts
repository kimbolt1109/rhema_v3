/**
 * The ASR (speech-to-text) contract.
 *
 * BLUEPRINT.md §4 and §8. The cue engine needs a running transcript of the pulpit mic. This
 * module defines the provider-agnostic vocabulary; Phase 7 builds two adapters behind it —
 * Deepgram (cloud, low-latency Korean) and faster-whisper (local, offline).
 *
 * ## Why an abstraction and not just one provider
 *
 * The two have opposite failure modes, and a live service needs both. Cloud ASR is lower latency
 * and much better at Korean, but it dies with the internet — and the internet is already carrying
 * the stream. Local ASR keeps working when the network drops, but needs a capable GPU. Making the
 * provider swappable at runtime means a network failure degrades to local rather than to nothing.
 *
 * ## Degrading is the normal case, not the exception
 *
 * If ASR fails entirely the system falls back to fully manual and the operator carries on
 * (Standing Rule 1). Nothing here may block: a dead provider produces a red status light and
 * silence, never a hang and never an exception into the cue engine.
 *
 * Node-global free.
 */

import { z } from 'zod'

/** Which engine is producing the transcript. */
export const ASR_PROVIDERS = ['deepgram', 'whisper'] as const

/** Union of the provider ids. */
export type AsrProviderId = (typeof ASR_PROVIDERS)[number]

/**
 * How the provider is chosen.
 *
 * `auto` is the default: cloud while it is healthy, falling back to local when it fails. That
 * ordering is deliberate — cloud is better at Korean, and the local fallback exists for the
 * moment the network is the thing that broke.
 */
export const ASR_SELECTION_MODES = ['cloud', 'local', 'auto'] as const

/** Union of the selection modes. */
export type AsrSelectionMode = (typeof ASR_SELECTION_MODES)[number]

/** Recognition language. Korean-first product; English is common in the same service. */
export const ASR_LANGUAGES = ['ko', 'en'] as const

/** Union of the language codes. */
export type AsrLanguage = (typeof ASR_LANGUAGES)[number]

/**
 * One transcript fragment.
 *
 * ## The draft/final contract — get this right or the UI flickers nonsense
 *
 * A provider emits many `isFinal: false` partials for the same span of speech, each *replacing*
 * the previous one, then exactly one `isFinal: true` result that supersedes them all. Consumers
 * must key on `id` and replace, never append, until `isFinal` arrives.
 *
 * The local adapter's two-tier scheduler works the same way: a fast draft model emits a partial
 * within ~500ms so the operator sees something immediately, and a larger, slower model emits the
 * final that REPLACES it (`docs/v2-notes/ASR_PIPELINE.md`).
 */
export interface TranscriptSegment {
  /** Stable across the partials that refine one span, so a consumer can replace rather than append. */
  readonly id: string
  readonly text: string
  readonly isFinal: boolean
  /** Milliseconds since the session started. */
  readonly tsStart: number
  readonly tsEnd: number
  /** Provider confidence in [0,1], or `null` when it does not report one. */
  readonly confidence: number | null
  /** Which engine produced this. Shown in the transcript panel so a fallback is visible. */
  readonly provider: AsrProviderId
  /** True when emitted by the fast draft model and a better final is still coming. */
  readonly isDraft: boolean
}

/** Lifecycle of an ASR session. */
export type AsrState = 'not-configured' | 'idle' | 'starting' | 'listening' | 'degraded' | 'failed'

/**
 * Live ASR status.
 *
 * `degraded` means a transcript is still arriving but not from the preferred provider — e.g.
 * Deepgram failed and the local adapter took over. It is deliberately distinct from `failed`:
 * one is "working, but worse", the other is "you are on your own now". Collapsing them would
 * hide a fallback the operator should know about.
 */
export interface AsrStatus {
  readonly state: AsrState
  readonly provider: AsrProviderId | null
  readonly language: AsrLanguage
  /** Median milliseconds from speech to first partial. Null before enough samples. */
  readonly latencyMs: number | null
  /** Input device currently captured, or null. */
  readonly deviceId: string | null
  readonly deviceLabel: string | null
  readonly lastError: string | null
  /** Epoch ms the session started, for an uptime readout. */
  readonly since: number | null
}

/** The blank status. */
export function idleAsrStatus(language: AsrLanguage = 'ko'): AsrStatus {
  return {
    state: 'idle',
    provider: null,
    language,
    latencyMs: null,
    deviceId: null,
    deviceLabel: null,
    lastError: null,
    since: null,
  }
}

/**
 * Operator-tunable ASR settings.
 *
 * `customVocabulary` is the highest-leverage field here. BLUEPRINT.md §8 is explicit: boosting
 * the pastor's name, the church name, hymn titles and recurring terms "sharply improves accuracy
 * on exactly the words that matter" — and those are precisely the words a generic model gets
 * wrong, because they are proper nouns it has never seen.
 */
export interface AsrSettings {
  readonly mode: AsrSelectionMode
  readonly language: AsrLanguage
  readonly deviceId: string | null
  /** Keyword boost list. Order is not significant. */
  readonly customVocabulary: readonly string[]
  /** Local model size. Larger is more accurate and slower; bounded by VRAM. */
  readonly localModel: string
}

/** Defaults: cloud-preferred, Korean, no vocabulary yet. */
export function defaultAsrSettings(): AsrSettings {
  return {
    mode: 'auto',
    language: 'ko',
    deviceId: null,
    customVocabulary: [],
    // `small` rather than `large-v3`: the dev machine has a 4 GB GTX 1650, and a model that does
    // not fit is worse than a smaller one that does. Overridable in settings.
    localModel: 'small',
  }
}

/** An available audio input. */
export interface AudioInputDevice {
  readonly deviceId: string
  readonly label: string
}

/** Validation for the settings, used at the IPC boundary. */
export const asrSettingsSchema = z.object({
  mode: z.enum(ASR_SELECTION_MODES),
  language: z.enum(ASR_LANGUAGES),
  deviceId: z.string().max(300).nullable(),
  customVocabulary: z.array(z.string().min(1).max(80)).max(500),
  localModel: z.string().min(1).max(60),
})

// ---------------------------------------------------------------------------
// Audio format
// ---------------------------------------------------------------------------

/**
 * The PCM format carried from the renderer's microphone capture to the main process.
 *
 * 16 kHz mono 16-bit is what both Whisper and Deepgram want. Resampling once at the source beats
 * doing it per-provider, and mono halves the IPC traffic for no accuracy loss on a single speaker.
 */
export const ASR_SAMPLE_RATE = 16_000

/** One channel. A pulpit mic is one speaker. */
export const ASR_CHANNELS = 1

/** Bits per sample; signed little-endian. */
export const ASR_BITS_PER_SAMPLE = 16

/**
 * Audio chunk duration.
 *
 * 100 ms balances two failure modes: much smaller floods IPC with tiny messages, much larger adds
 * latency the operator feels as the transcript lagging the preacher.
 */
export const ASR_CHUNK_MS = 100

// ---------------------------------------------------------------------------
// Hallucination filtering
// ---------------------------------------------------------------------------

/**
 * Phrases Whisper emits when fed silence or noise.
 *
 * These are artefacts of the training data (subtitle corpora), not speech. Left unfiltered they
 * appear mid-service as confident-looking transcript, and — worse for Verger — could match a
 * hot-phrase or anchor and fire a cue during a silent prayer. See
 * `docs/v2-notes/ASR_PIPELINE.md`.
 *
 * Matching is case-insensitive and whitespace-normalised, and applies to a WHOLE segment only:
 * a legitimate sentence that happens to contain one of these substrings must survive.
 */
export const HALLUCINATION_PHRASES: readonly string[] = [
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'subscribe to my channel',
  '시청해 주셔서 감사합니다',
  '구독과 좋아요',
  'mbc 뉴스',
  '한글자막 by',
  '[음악]',
  '[박수]',
  '[music]',
  '[applause]',
  'you',
  '.',
]

/**
 * Whether a segment looks like a hallucination rather than speech.
 *
 * Pure, so it is exhaustively testable. Deliberately conservative: it only rejects a segment that
 * is ENTIRELY one of the known artefacts. Dropping real speech during a sermon is far worse than
 * letting one stray artefact through, since the operator can ignore a bad line but cannot recover
 * a missed one.
 *
 * Note `감사합니다` ("thank you") is NOT in the list even though Whisper emits it on silence: it
 * is also an extremely common thing to actually say from a pulpit, and suppressing it would drop
 * real speech.
 */
export function isLikelyHallucination(text: string): boolean {
  const normalised = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalised.length === 0) return true
  return HALLUCINATION_PHRASES.some((phrase) => normalised === phrase.toLowerCase())
}
