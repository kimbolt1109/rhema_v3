/**
 * Scripture reference detection and resolution.
 *
 * BLUEPRINT.md §4 calls this "often the single highest-value feature": it works in fully
 * extemporaneous preaching, where the plan-follower has nothing to follow. The pastor says
 * "요한복음 3장 16절" or "turn to John 3:16" and the right verse appears.
 *
 * ## Standing Rule 4 governs this entire module
 *
 * Nothing here contains verse text, and nothing here may ever be used to author it. A detector
 * emits a REFERENCE. Text is resolved at fire time from a licensed API (ESV / API.Bible) or from
 * a verified public-domain translation downloaded at runtime — never bundled, never typed into
 * this repo. See `docs/v2-notes/LEGAL_AND_CONTENT.md`.
 *
 * ## The confidence bands are not arbitrary
 *
 * They come from two build eras of the prior project and are recorded in
 * `docs/v2-notes/ASR_PIPELINE.md`; the mined README resolves the conflict between them in favour
 * of the later, shipped set. Changing these numbers changes how often a wrong verse appears in
 * front of a congregation, so they are named constants with the reasoning attached rather than
 * literals scattered through a matcher.
 *
 * Node-global free.
 */

import { z } from 'zod'

/**
 * An exact or standard-abbreviation match — "John 3:16", "요한복음 3장 16절".
 *
 * High enough to auto-show, but ONLY once the verse text has actually been resolved
 * ({@link canAutoShow}). Confidence in the *reference* says nothing about whether we have the
 * *text*, and showing an empty scripture card is worse than showing nothing.
 */
export const CONFIDENCE_EXACT = 0.95

/** One edit away from a known book name — a plausible ASR slip. Offer it, flagged uncertain. */
export const CONFIDENCE_FUZZY = 0.65

/** A weak match. Offer it, clearly marked, never auto-fire. */
export const CONFIDENCE_WEAK = 0.5

/**
 * Below this, discard silently.
 *
 * Not "show it in grey" — discard. A stream of low-confidence guesses trains the operator to
 * ignore the panel, which costs more than the occasional missed reference.
 */
export const CONFIDENCE_DISCARD = 0.5

/** How certain the detector is, banded for the UI. */
export type ScriptureConfidenceBand = 'exact' | 'fuzzy' | 'weak'

/** Which band a raw confidence falls into, or `null` when it should be discarded. */
export function confidenceBand(confidence: number): ScriptureConfidenceBand | null {
  if (confidence >= CONFIDENCE_EXACT) return 'exact'
  if (confidence >= CONFIDENCE_FUZZY) return 'fuzzy'
  if (confidence >= CONFIDENCE_WEAK) return 'weak'
  return null
}

/** A detected reference. Carries NO verse text — that is resolved separately. */
export interface ScriptureReference {
  /** Canonical English book name, e.g. `John`. Used as the resolution key. */
  readonly book: string
  /** The book name as actually spoken, e.g. `요한복음`. Shown so the operator can sanity-check. */
  readonly spokenBook: string
  readonly chapter: number
  /** `null` for a whole-chapter reference ("Romans chapter 8"). */
  readonly verse: number | null
  /** End of a range ("verses 1 to 4"), or `null`. */
  readonly verseEnd: number | null
  readonly confidence: number
  readonly band: ScriptureConfidenceBand
  /** The transcript span this came from, for the operator to check against. */
  readonly sourceText: string
}

/** A reference plus its resolved text, once a provider has supplied it. */
export interface ResolvedScripture {
  readonly reference: ScriptureReference
  /**
   * The verse text.
   *
   * Supplied at runtime by a licensed API or a verified public-domain file. NEVER authored in
   * this repository, never committed, never included in a test fixture.
   */
  readonly text: string
  readonly translation: string
  /** Required by most licences, and rendered on the overlay whenever present. */
  readonly attribution: string | null
}

/**
 * Whether a detection may fire itself without the operator confirming.
 *
 * **Both** conditions are required, and the second is the one that matters:
 *
 * 1. the reference match is in the `exact` band, AND
 * 2. **the verse text has actually been resolved.**
 *
 * `docs/v2-notes/ASR_PIPELINE.md` records this as a hard gate. Auto-showing a confident reference
 * whose text failed to resolve puts an empty scripture card on the congregation screen — the
 * failure is invisible to the operator until someone tells them.
 */
export function canAutoShow(
  reference: ScriptureReference,
  resolved: ResolvedScripture | null,
): boolean {
  if (reference.band !== 'exact') return false
  if (resolved === null) return false
  return resolved.text.trim().length > 0
}

/** Where verse text came from. */
export type ScriptureSourceKind = 'licensed-api' | 'public-domain' | 'unavailable'

/** A translation Verger can resolve against. */
export interface TranslationSource {
  readonly code: string
  readonly name: string
  readonly language: string
  readonly kind: ScriptureSourceKind
  /**
   * Licence, verbatim from the catalogue.
   *
   * `docs/v2-notes/LEGAL_AND_CONTENT.md` describes a quarantine rule for translations whose
   * public-domain status is contested — the Korean KRV specifically. An unverified translation
   * must not be offered just because a file for it exists.
   */
  readonly license: string
  readonly attribution: string | null
  /** False while the PD status is unconfirmed; such a translation is never selectable. */
  readonly verified: boolean
}

/** Validation for a reference crossing a process boundary. */
export const scriptureReferenceSchema = z.object({
  book: z.string().min(1).max(60),
  spokenBook: z.string().min(1).max(60),
  chapter: z.number().int().min(1).max(150),
  verse: z.number().int().min(1).max(200).nullable(),
  verseEnd: z.number().int().min(1).max(200).nullable(),
  confidence: z.number().min(0).max(1),
  band: z.enum(['exact', 'fuzzy', 'weak']),
  sourceText: z.string().max(500),
})

/** Render a reference for display, e.g. `John 3:16` or `요한복음 3:16-18`. */
export function formatReference(reference: ScriptureReference, useSpoken = false): string {
  const book = useSpoken ? reference.spokenBook : reference.book
  if (reference.verse === null) return `${book} ${reference.chapter}`
  if (reference.verseEnd !== null && reference.verseEnd !== reference.verse) {
    return `${book} ${reference.chapter}:${reference.verse}-${reference.verseEnd}`
  }
  return `${book} ${reference.chapter}:${reference.verse}`
}

/**
 * Korean priming phrases — spoken just BEFORE a reference.
 *
 * "받으실 말씀은…" ("the word we will receive is…") reliably precedes the reference in Korean
 * preaching. Priming on it lets the detector raise its confidence for the next few seconds, which
 * is what makes the difference between catching a reference and missing it when the ASR garbles
 * one syllable of the book name.
 */
export const KO_PRIMING_PHRASES: readonly string[] = [
  '받으실 말씀은',
  '오늘의 말씀은',
  '본문은',
  '말씀을 봉독하겠습니다',
  '함께 읽겠습니다',
]

/** English priming phrases, same idea. */
export const EN_PRIMING_PHRASES: readonly string[] = [
  'turn to',
  'turn with me to',
  'our text today',
  "today's reading",
  'the word of god says',
  'listen to',
]

/** How long a priming phrase raises confidence for. */
export const PRIMING_WINDOW_MS = 15_000

/** The confidence bonus applied while primed. Enough to lift a `fuzzy` match into consideration. */
export const PRIMING_BONUS = 0.1
