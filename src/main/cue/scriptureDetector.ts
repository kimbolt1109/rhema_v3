/**
 * The scripture detector — BLUEPRINT.md §4's "often the single highest-value feature".
 *
 * The pastor says "요한복음 3장 16절" or "turn to John 3:16" mid-sermon and the right reference
 * appears in the operator's panel. It needs no service plan, so it keeps working in fully
 * extemporaneous preaching — which is exactly when the plan-follower has gone quiet.
 *
 * ## Standing Rule 4 — this file emits REFERENCES, never text
 *
 * Nothing here produces, contains, or could produce verse text. `detect()` returns
 * {@link ScriptureReference} values: a book id, a chapter, maybe a verse, and a confidence. Text is
 * resolved later from a licensed API or a verified public-domain source
 * (`docs/v2-notes/LEGAL_AND_CONTENT.md`), and `canAutoShow()` in `@shared/scripture` refuses to
 * auto-show anything whose text did not actually resolve.
 *
 * ## Purity
 *
 * `detect()` is a pure function of `(text, options)`. No I/O, no `Date.now()` — the clock is
 * injected as `options.now` so priming windows are testable to the millisecond. It also never
 * throws: a detector that can crash the transcript pipeline mid-service is worse than one that
 * occasionally returns nothing, so the whole body is wrapped and degrades to `[]`.
 *
 * ## Confidence
 *
 * Bands come from `@shared/scripture` and are not restated here. Exact book name or standard
 * abbreviation → `CONFIDENCE_EXACT`; one edit from a full book name → `CONFIDENCE_FUZZY`; two
 * edits → `CONFIDENCE_WEAK`; three or more → nothing is returned at all. `confidenceBand()` does
 * the banding.
 *
 * A useful safety property falls out of the numbers: `CONFIDENCE_FUZZY + PRIMING_BONUS` is 0.75,
 * still below `CONFIDENCE_EXACT`. **Priming can never manufacture an `exact` match**, so it can
 * never manufacture an auto-showable one either. It only raises a guess's rank among guesses.
 *
 * ## Why these regexes cannot catastrophically backtrack
 *
 * They run against every transcript final for ninety minutes; `docs/v2-notes/` flags ReDoS
 * explicitly. Three structural properties make blow-up impossible rather than unlikely:
 *
 * 1. **Every quantifier is bounded and small** — `{0,2}`, `{0,3}`, `{1,3}`, `{1,5}`, `{2,8}`,
 *    `{3,20}`. There is no `*` or `+` anywhere in any pattern in this file.
 * 2. **No bounded quantifier greater than one is applied to a group that itself contains a
 *    quantifier.** The only quantifier ever wrapped around a quantified group is `?` (i.e. `{0,1}`)
 *    and one `{0,2}` over a fixed-separator group. The number of ways the engine can carve up a
 *    window is therefore a small constant (a product of a handful of 2s and 3s), not exponential
 *    in the input length. That is precisely the property `(a+)+` lacks.
 * 3. **The book alternations are alternations of escaped literals**, so a failed alternative
 *    consumes nothing and offers no ambiguity to backtrack into.
 *
 * With per-position work bounded by a constant, total work is linear in the scanned text, and the
 * scanned text is itself capped at {@link MAX_SCAN_CHARS}. `scriptureDetector.test.ts` pins this
 * with an adversarial input and a wall-clock budget.
 */

import {
  CONFIDENCE_EXACT,
  CONFIDENCE_FUZZY,
  CONFIDENCE_WEAK,
  EN_PRIMING_PHRASES,
  KO_PRIMING_PHRASES,
  PRIMING_BONUS,
  PRIMING_WINDOW_MS,
  confidenceBand,
} from '@shared/scripture'
import type { ScriptureReference } from '@shared/scripture'

import {
  BOOKS,
  englishFullNames,
  englishVariants,
  isValidChapter,
  isValidVerse,
  koreanFullNames,
  koreanVariants,
  normalizeEnglishName,
  normalizeKoreanName,
} from './books'
import type { BibleBook } from './books'

/**
 * Hard cap on how much of one transcript segment is scanned.
 *
 * A final from a well-behaved ASR is a sentence or two. Anything past this is either a stuck
 * decoder or someone pasting a document into the transcript, and neither deserves unbounded CPU
 * during a live service.
 */
export const MAX_SCAN_CHARS = 4000

/** Most references returned from a single utterance. A burst past this is noise, not preaching. */
export const MAX_REFERENCES_PER_UTTERANCE = 8

/** Longest Levenshtein distance considered at all. Three or more edits is a different word. */
const MAX_EDIT_DISTANCE = 2

/** Below this candidate length a single edit is not evidence of anything. */
const MIN_FUZZY_LENGTH_EN = 3

/** Two edits need a longer word to be meaningful — three-letter words are two edits from everything. */
const MIN_FUZZY_LENGTH_EN_DISTANCE_2 = 6

/** Korean is syllable-dense, so a shorter name carries more information — but not a 2-syllable one. */
const MIN_FUZZY_LENGTH_KO = 3

/** Options for {@link detect}. The clock is injected; the detector never reads one. */
export interface ScriptureDetectOptions {
  /** Epoch ms of this transcript segment. Used only to age the priming window. */
  readonly now: number
  /**
   * Epoch ms a priming phrase was last heard in an *earlier* segment, or `null`.
   *
   * A phrase inside `text` itself also primes references that follow it, so a caller that does not
   * track priming across segments still gets the single-utterance case for free.
   */
  readonly primedAt?: number | null
  /** Override {@link MAX_REFERENCES_PER_UTTERANCE}. */
  readonly maxResults?: number
}

/** Where a priming phrase was found, so the caller can remember the timestamp. */
export interface PrimingHit {
  readonly phrase: string
  readonly language: 'ko' | 'en'
  /** Index into the scanned text. References *after* this index are primed. */
  readonly index: number
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Numerals
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EN_ONES: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
}

const EN_TEENS: Readonly<Record<string, number>> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
}

const EN_TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
}

function alternation(words: readonly string[]): string {
  return [...words].sort((a, b) => b.length - a.length).join('|')
}

const ONES_ALT = alternation(Object.keys(EN_ONES))
const TEENS_ALT = alternation(Object.keys(EN_TEENS))
const TENS_ALT = alternation(Object.keys(EN_TENS))
const WORD_SEP = '[\\s-]{1,2}'

/**
 * A well-formed spoken English number, 1–999.
 *
 * The grammar matters more than the vocabulary. A loose "up to three number words in a row" pattern
 * swallows "John three sixteen" as the single number 319 and loses the verse; this grammar can only
 * match `three`, leaving ` sixteen` for the verse slot to claim.
 */
const EN_UNDER_100 = `(?:(?:${TENS_ALT})(?:${WORD_SEP}(?:${ONES_ALT}))?|(?:${TEENS_ALT})|(?:${ONES_ALT}))`
const EN_NUMBER = `(?:(?:${ONES_ALT})${WORD_SEP}hundred(?:${WORD_SEP}${EN_UNDER_100})?|${EN_UNDER_100})`

/** Parse a spoken English number matched by {@link EN_NUMBER}. Returns `null` if it does not compose. */
export function parseEnglishNumber(raw: string): number | null {
  const tokens = raw.toLowerCase().split(/[\s-]+/).filter(Boolean)
  if (tokens.length === 0) return null
  let total = 0
  let current = 0
  for (const token of tokens) {
    if (token === 'hundred') {
      current = (current === 0 ? 1 : current) * 100
      total += current
      current = 0
      continue
    }
    const value = EN_ONES[token] ?? EN_TEENS[token] ?? EN_TENS[token]
    if (value === undefined) return null
    current += value
  }
  total += current
  return total > 0 && total < 1000 ? total : null
}

/**
 * Sino-Korean numeral syllables.
 *
 * `륙` is included alongside `육` because 십륙 and 십육 are both heard for 16 depending on the
 * speaker and on how the ASR resolved the initial-sound rule.
 */
const KO_DIGIT_VALUES: Readonly<Record<string, number>> = {
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  륙: 6,
  칠: 7,
  팔: 8,
  구: 9,
}

const KO_NUMERAL_CLASS = '[일이삼사오육륙칠팔구십백]{1,5}'

/**
 * Parse a Sino-Korean numeral, 1–999 — 삼 → 3, 십육 → 16, 백이십삼 → 123.
 *
 * NOT covered, deliberately: native Korean numerals (하나/둘/셋), 천 and above, and ordinal forms
 * (첫째). None appear in a chapter-and-verse citation, and every one of them is a common enough
 * ordinary word that admitting it would cost more in false positives than it earns.
 */
export function parseKoreanNumeral(raw: string): number | null {
  if (raw.length === 0) return null
  let total = 0
  let current = 0
  for (const ch of raw) {
    if (ch === '십') {
      total += (current === 0 ? 1 : current) * 10
      current = 0
      continue
    }
    if (ch === '백') {
      total += (current === 0 ? 1 : current) * 100
      current = 0
      continue
    }
    const value = KO_DIGIT_VALUES[ch]
    if (value === undefined) return null
    current += value
  }
  total += current
  return total > 0 && total < 1000 ? total : null
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Book indexes
// ─────────────────────────────────────────────────────────────────────────────────────────────

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A literal variant becomes a pattern whose internal spaces tolerate ASR spacing noise. */
function variantPattern(variant: string): string {
  return escapeRegex(variant).split(' ').join('[\\s.]{0,3}')
}

function buildAlternation(variants: readonly string[]): string {
  const patterns = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(variantPattern)
  return [...new Set(patterns)].join('|')
}

/** Exact-index key: case and separators folded away, nothing else. */
function exactKeyEn(raw: string): string {
  return raw.toLowerCase().replace(/[\s.]/g, '')
}

const EN_EXACT_INDEX = new Map<string, BibleBook>()
const KO_EXACT_INDEX = new Map<string, BibleBook>()
const EN_ALL_VARIANTS: string[] = []
const KO_ALL_VARIANTS: string[] = []

/** `[normalized full name, book]` pairs — the only set the fuzzy matcher may search. */
const EN_FUZZY_INDEX: Array<readonly [string, BibleBook]> = []
const KO_FUZZY_INDEX: Array<readonly [string, BibleBook]> = []

for (const book of BOOKS) {
  for (const variant of englishVariants(book)) {
    EN_ALL_VARIANTS.push(variant)
    const key = exactKeyEn(variant)
    if (!EN_EXACT_INDEX.has(key)) EN_EXACT_INDEX.set(key, book)
    const folded = normalizeEnglishName(variant)
    if (!EN_EXACT_INDEX.has(folded)) EN_EXACT_INDEX.set(folded, book)
  }
  for (const name of englishFullNames(book)) {
    EN_FUZZY_INDEX.push([normalizeEnglishName(name), book])
  }
  for (const variant of koreanVariants(book)) {
    KO_ALL_VARIANTS.push(variant)
    const key = normalizeKoreanName(variant)
    if (!KO_EXACT_INDEX.has(key)) KO_EXACT_INDEX.set(key, book)
  }
  for (const name of koreanFullNames(book)) {
    KO_FUZZY_INDEX.push([normalizeKoreanName(name), book])
  }
}

const EN_BOOK_ALT = buildAlternation(EN_ALL_VARIANTS)
const KO_BOOK_ALT = buildAlternation(KO_ALL_VARIANTS)

/** Exposed for the test that asserts no two books collide on one exact key. */
export function englishExactKeys(): ReadonlyMap<string, BibleBook> {
  return EN_EXACT_INDEX
}

/** Exposed for the same reason on the Korean side. */
export function koreanExactKeys(): ReadonlyMap<string, BibleBook> {
  return KO_EXACT_INDEX
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * English, exact book name or standard abbreviation.
 *
 * Covers `John 3:16`, `John 3.16`, `John chapter 3 verse 16`, `Romans chapter 8`, `Psalm 23`,
 * `1 Corinthians 13:4-8`, `First Corinthians 13`, `turn to John three sixteen`, and
 * `Romans 8 verses 1 to 4`.
 */
const EN_EXACT_RE = new RegExp(
  '(?<![A-Za-z0-9])' +
    `(?<book>${EN_BOOK_ALT})` +
    '(?![A-Za-z])\\.?' +
    '[\\s]{0,3}' +
    '(?<chapterWord>chapters|chapter|chap)?' +
    '[\\s.]{0,3}' +
    `(?:(?<chD>[0-9]{1,3})|(?<chW>${EN_NUMBER}))` +
    '(?:' +
    `[\\s]{0,3}:[\\s]{0,3}(?:(?<vaD>[0-9]{1,3})|(?<vaW>${EN_NUMBER}))` +
    '|\\.(?<vbD>[0-9]{1,3})' +
    `|[\\s]{0,3}(?:verses|verse|vss|vs)\\.?[\\s]{0,3}(?:(?<vcD>[0-9]{1,3})|(?<vcW>${EN_NUMBER}))` +
    `|[\\s]{1,3}(?<vdW>${EN_NUMBER})` +
    ')?' +
    '(?:' +
    `[\\s]{0,3}[-–—][\\s]{0,3}(?:(?<veaD>[0-9]{1,3})|(?<veaW>${EN_NUMBER}))` +
    `|[\\s]{1,3}(?:through|thru|to)[\\s]{1,3}(?:(?<vebD>[0-9]{1,3})|(?<vebW>${EN_NUMBER}))` +
    ')?',
  'gi',
)

/**
 * Korean, exact book name or standard abbreviation.
 *
 * Covers `요한복음 3장 16절`, `요한복음 3:16`, `요한복음 3장 16-18절`, `요한복음 3장`, `요 3:16`,
 * `시편 23편 1절`, and the Sino-Korean spoken form `요한복음 삼장 십육절`.
 *
 * A Sino-Korean *verse* must be followed by `절`. Without that requirement the numeral class —
 * which contains 이, 삼, 사, 오 — happily matches the first syllable of an ordinary Korean word
 * following a chapter reference, and "요한복음 3장 이하" becomes verse 2.
 *
 * The leading `(?<![가-힣])` stops a single-syllable abbreviation such as `요` from matching the
 * tail of an unrelated word.
 */
const KO_EXACT_RE = new RegExp(
  '(?<![가-힣])' +
    `(?<kbook>${KO_BOOK_ALT})` +
    '[\\s]{0,2}' +
    '(?:' +
    '(?<kchD>[0-9]{1,3})[\\s]{0,2}(?:장|편|:)' +
    `|(?<kchK>${KO_NUMERAL_CLASS})[\\s]{0,2}(?:장|편)` +
    ')' +
    '(?:' +
    '[\\s]{0,2}(?<kvD>[0-9]{1,3})' +
    '(?:[\\s]{0,2}[-~–—][\\s]{0,2}(?<kveD>[0-9]{1,3}))?' +
    '[\\s]{0,2}절?' +
    `|[\\s]{0,2}(?<kvK>${KO_NUMERAL_CLASS})` +
    `(?:[\\s]{0,2}[-~–—][\\s]{0,2}(?<kveK>${KO_NUMERAL_CLASS}))?` +
    '[\\s]{0,2}절' +
    ')?',
  'g',
)

/**
 * English, book name unknown — the Levenshtein path.
 *
 * Requires either an explicit `chapter` word or a `chapter:verse` pair before it will even consider
 * a fuzzy book name. A bare "word number" is far too common in ordinary speech to hand to an
 * edit-distance matcher.
 */
const EN_FUZZY_RE = new RegExp(
  '(?<![A-Za-z0-9])' +
    '(?<pre>(?:[123]|1st|2nd|3rd|first|second|third|i{1,3})[\\s.]{0,3})?' +
    '(?<fbook>[A-Za-z]{3,20})(?![A-Za-z])\\.?' +
    '[\\s]{0,3}' +
    '(?<fcw>chapters|chapter|chap)?' +
    '[\\s.]{0,3}' +
    '(?<fch>[0-9]{1,3})' +
    '(?:' +
    '[\\s]{0,3}(?::[\\s]{0,3}|(?:verses|verse|vs)\\.?[\\s]{0,3})(?<fv>[0-9]{1,3})' +
    '(?:[\\s]{0,3}[-–—][\\s]{0,3}(?<fve>[0-9]{1,3}))?' +
    ')?',
  'gi',
)

/** Korean, book name unknown. The `장`/`편`/`:` marker is itself the admission ticket. */
const KO_FUZZY_RE = new RegExp(
  '(?<![가-힣])' +
    '(?<kfbook>[가-힣]{2,8})' +
    '[\\s]{0,2}(?<kfch>[0-9]{1,3})[\\s]{0,2}(?:장|편|:)' +
    '(?:' +
    '[\\s]{0,2}(?<kfv>[0-9]{1,3})' +
    '(?:[\\s]{0,2}[-~–—][\\s]{0,2}(?<kfve>[0-9]{1,3}))?' +
    '[\\s]{0,2}절?' +
    ')?',
  'g',
)

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Levenshtein
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Edit distance, abandoned as soon as it provably exceeds `cap`.
 *
 * Returns `cap + 1` for "further than you care about" rather than the true distance, so callers
 * must compare against `cap`, never use the value as a score.
 */
export function boundedLevenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const deletion = (previous[j] ?? Number.MAX_SAFE_INTEGER) + 1
      const insertion = (current[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1
      const substitution = (previous[j - 1] ?? Number.MAX_SAFE_INTEGER) + cost
      const best = Math.min(deletion, insertion, substitution)
      current[j] = best
      if (best < rowMin) rowMin = best
    }
    if (rowMin > cap) return cap + 1
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] ?? cap + 1
}

interface FuzzyMatch {
  readonly book: BibleBook
  readonly distance: number
  /** Number of characters trimmed from the front of the candidate to reach the matched form. */
  readonly trimmed: number
  readonly matchedText: string
  /** Tie-break score, lower is better. See {@link fuzzyRank}. */
  readonly rank: number
}

/** Whether every character of `a` appears in `b` in order — i.e. `b` is `a` with insertions. */
function isSubsequence(a: string, b: string): boolean {
  if (a.length > b.length) return false
  let i = 0
  for (const ch of b) {
    if (ch === a[i]) i += 1
    if (i === a.length) return true
  }
  return i === a.length
}

/**
 * Break ties between book names that are the same edit distance from what was heard.
 *
 * "Jon" is one edit from both `Job` (a substitution) and `John` (an insertion), and canonical order
 * alone would silently pick Job. An ASR that drops a character is far more common than one that
 * swaps a character and lands on a *different real book name*, so a pure insertion outranks a
 * substitution at the same distance. `docs/v2-notes/ASR_PIPELINE.md` uses exactly this case —
 * "Jon 3:16" → John at the `fuzzy` band — as its worked example.
 *
 * Distance still dominates: a one-edit substitution (rank 3) beats a two-edit insertion (rank 4).
 */
function fuzzyRank(candidate: string, key: string, distance: number): number {
  return distance * 2 + (isSubsequence(candidate, key) ? 0 : 1)
}

function bestFuzzy(
  candidate: string,
  index: readonly (readonly [string, BibleBook])[],
  minLength: number,
  minLengthForTwo: number,
  trimmed: number,
): FuzzyMatch | null {
  if (candidate.length < minLength) return null
  let best: FuzzyMatch | null = null
  for (const entry of index) {
    const [key, book] = entry
    if (key.length < minLength) continue
    const distance = boundedLevenshtein(candidate, key, MAX_EDIT_DISTANCE)
    if (distance > MAX_EDIT_DISTANCE) continue
    if (distance === MAX_EDIT_DISTANCE && candidate.length < minLengthForTwo) continue
    const rank = fuzzyRank(candidate, key, distance)
    if (best !== null && rank >= best.rank) continue
    best = { book, distance, trimmed, matchedText: candidate, rank }
    if (rank === 0) break
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Priming
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The earliest priming phrase in `text`, or `null`.
 *
 * "받으실 말씀은…" reliably precedes the reference in Korean preaching, which is what lets a
 * half-garbled book name still surface. Exported so the cue engine can remember *when* it last saw
 * one and pass that back as `primedAt` on later segments.
 */
export function findPrimingPhrase(text: string): PrimingHit | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const lower = scanned.toLowerCase()
  let best: PrimingHit | null = null
  for (const phrase of KO_PRIMING_PHRASES) {
    const index = scanned.indexOf(phrase)
    if (index === -1) continue
    if (best === null || index < best.index) best = { phrase, language: 'ko', index }
  }
  for (const phrase of EN_PRIMING_PHRASES) {
    const index = lower.indexOf(phrase.toLowerCase())
    if (index === -1) continue
    if (best === null || index < best.index) best = { phrase, language: 'en', index }
  }
  return best
}

/** Whether a remembered priming timestamp is still inside {@link PRIMING_WINDOW_MS}. */
export function isPrimingActive(primedAt: number | null | undefined, now: number): boolean {
  if (primedAt === null || primedAt === undefined) return false
  if (!Number.isFinite(primedAt) || !Number.isFinite(now)) return false
  const age = now - primedAt
  return age >= 0 && age <= PRIMING_WINDOW_MS
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  readonly start: number
  readonly end: number
  readonly book: BibleBook
  readonly spokenBook: string
  readonly chapter: number
  readonly verse: number | null
  readonly verseEnd: number | null
  readonly distance: number
  readonly sourceText: string
}

function digitsOrWords(digits: string | undefined, words: string | undefined): number | null {
  if (digits !== undefined && digits.length > 0) {
    const parsed = Number.parseInt(digits, 10)
    return Number.isInteger(parsed) ? parsed : null
  }
  if (words !== undefined && words.length > 0) return parseEnglishNumber(words)
  return null
}

function digitsOrKorean(digits: string | undefined, syllables: string | undefined): number | null {
  if (digits !== undefined && digits.length > 0) {
    const parsed = Number.parseInt(digits, 10)
    return Number.isInteger(parsed) ? parsed : null
  }
  if (syllables !== undefined && syllables.length > 0) return parseKoreanNumeral(syllables)
  return null
}

function collect(re: RegExp, text: string, onMatch: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0
  let match = re.exec(text)
  while (match !== null) {
    onMatch(match)
    if (match.index === re.lastIndex) re.lastIndex += 1
    match = re.exec(text)
  }
}

function scanEnglishExact(text: string, out: Candidate[]): void {
  collect(EN_EXACT_RE, text, (match) => {
    const groups = match.groups
    if (groups === undefined) return
    const spoken = groups['book']
    if (spoken === undefined) return
    const book = EN_EXACT_INDEX.get(exactKeyEn(spoken))
    if (book === undefined) return

    const chapter = digitsOrWords(groups['chD'], groups['chW'])
    if (chapter === null) return

    // A spelled-out verse with no marker of any kind ("Romans 8 one of the great chapters") is only
    // trusted when the chapter was spoken as a word too, which is the "John three sixteen" shape.
    const bareSpokenVerse = groups['vdW']
    const chapterWasSpelled = groups['chW'] !== undefined
    const verse =
      bareSpokenVerse !== undefined && !chapterWasSpelled
        ? null
        : (digitsOrWords(groups['vaD'], groups['vaW']) ??
          digitsOrWords(groups['vbD'], undefined) ??
          digitsOrWords(groups['vcD'], groups['vcW']) ??
          digitsOrWords(undefined, bareSpokenVerse))

    const verseEnd =
      verse === null
        ? null
        : (digitsOrWords(groups['veaD'], groups['veaW']) ??
          digitsOrWords(groups['vebD'], groups['vebW']))

    out.push({
      start: match.index,
      end: match.index + match[0].length,
      book,
      spokenBook: spoken,
      chapter,
      verse,
      verseEnd,
      distance: 0,
      sourceText: match[0],
    })
  })
}

function scanKoreanExact(text: string, out: Candidate[]): void {
  collect(KO_EXACT_RE, text, (match) => {
    const groups = match.groups
    if (groups === undefined) return
    const spoken = groups['kbook']
    if (spoken === undefined) return
    const book = KO_EXACT_INDEX.get(normalizeKoreanName(spoken))
    if (book === undefined) return

    const chapter = digitsOrKorean(groups['kchD'], groups['kchK'])
    if (chapter === null) return
    const verse = digitsOrKorean(groups['kvD'], groups['kvK'])
    const verseEnd = verse === null ? null : digitsOrKorean(groups['kveD'], groups['kveK'])

    out.push({
      start: match.index,
      end: match.index + match[0].length,
      book,
      spokenBook: spoken,
      chapter,
      verse,
      verseEnd,
      distance: 0,
      sourceText: match[0],
    })
  })
}

function scanEnglishFuzzy(text: string, out: Candidate[]): void {
  collect(EN_FUZZY_RE, text, (match) => {
    const groups = match.groups
    if (groups === undefined) return
    const bookWord = groups['fbook']
    if (bookWord === undefined) return
    const hasChapterWord = groups['fcw'] !== undefined
    const verseRaw = groups['fv']
    if (!hasChapterWord && verseRaw === undefined) return

    const prefix = groups['pre'] ?? ''
    const withPrefix = normalizeEnglishName(`${prefix}${bookWord}`)
    const withoutPrefix = normalizeEnglishName(bookWord)

    let best = bestFuzzy(
      withPrefix,
      EN_FUZZY_INDEX,
      MIN_FUZZY_LENGTH_EN,
      MIN_FUZZY_LENGTH_EN_DISTANCE_2,
      0,
    )
    if (best === null || best.rank > 0) {
      const alternative = bestFuzzy(
        withoutPrefix,
        EN_FUZZY_INDEX,
        MIN_FUZZY_LENGTH_EN,
        MIN_FUZZY_LENGTH_EN_DISTANCE_2,
        prefix.length,
      )
      if (alternative !== null && (best === null || alternative.rank < best.rank)) {
        best = alternative
      }
    }
    if (best === null) return

    const chapter = digitsOrWords(groups['fch'], undefined)
    if (chapter === null) return
    const verse = digitsOrWords(verseRaw, undefined)
    const verseEnd = verse === null ? null : digitsOrWords(groups['fve'], undefined)

    const start = match.index + best.trimmed
    out.push({
      start,
      end: match.index + match[0].length,
      book: best.book,
      spokenBook: best.trimmed > 0 ? bookWord : `${prefix}${bookWord}`.trim(),
      chapter,
      verse,
      verseEnd,
      distance: best.distance,
      sourceText: text.slice(start, match.index + match[0].length),
    })
  })
}

function scanKoreanFuzzy(text: string, out: Candidate[]): void {
  collect(KO_FUZZY_RE, text, (match) => {
    const groups = match.groups
    if (groups === undefined) return
    const candidate = groups['kfbook']
    if (candidate === undefined) return

    // Try the longest trailing run of syllables first: a missing space ("말씀은요한복음3장") would
    // otherwise glue the priming phrase onto the book name and lose the match entirely.
    let best: FuzzyMatch | null = null
    for (let length = candidate.length; length >= MIN_FUZZY_LENGTH_KO; length -= 1) {
      const suffix = candidate.slice(candidate.length - length)
      const found = bestFuzzy(
        suffix,
        KO_FUZZY_INDEX,
        MIN_FUZZY_LENGTH_KO,
        MIN_FUZZY_LENGTH_KO,
        candidate.length - length,
      )
      if (found === null) continue
      if (best === null || found.rank < best.rank) best = found
      if (best.rank === 0) break
    }
    if (best === null) return

    const chapter = digitsOrKorean(groups['kfch'], undefined)
    if (chapter === null) return
    const verse = digitsOrKorean(groups['kfv'], undefined)
    const verseEnd = verse === null ? null : digitsOrKorean(groups['kfve'], undefined)

    const start = match.index + best.trimmed
    out.push({
      start,
      end: match.index + match[0].length,
      book: best.book,
      spokenBook: candidate.slice(best.trimmed),
      chapter,
      verse,
      verseEnd,
      distance: best.distance,
      sourceText: text.slice(start, match.index + match[0].length),
    })
  })
}

/**
 * Apply the book table as a validity filter.
 *
 * Returns `null` when the numbers cannot exist, which is the cheapest and highest-yield false
 * positive filter available: "John 99" is not a mis-heard reference, it is not a reference.
 */
function validate(candidate: Candidate): Candidate | null {
  const { book } = candidate
  let chapter = candidate.chapter
  let verse = candidate.verse
  let verseEnd = candidate.verseEnd

  // "Jude 5" means verse 5 of the only chapter there is. Same for Obadiah, Philemon, 2/3 John.
  if (book.chapters === 1 && verse === null && chapter > 1) {
    verse = chapter
    chapter = 1
  }

  if (!isValidChapter(book, chapter)) return null
  if (verse !== null && !isValidVerse(book, verse)) return null
  if (verseEnd !== null && (verse === null || verseEnd <= verse || !isValidVerse(book, verseEnd))) {
    // The start verse is still a perfectly good reference; only the range end is nonsense.
    verseEnd = null
  }

  return { ...candidate, chapter, verse, verseEnd }
}

function baseConfidence(distance: number): number | null {
  if (distance === 0) return CONFIDENCE_EXACT
  if (distance === 1) return CONFIDENCE_FUZZY
  if (distance === 2) return CONFIDENCE_WEAK
  return null
}

/**
 * Detect scripture references in one transcript segment.
 *
 * Pure: same inputs, same outputs, no clock, no I/O, no throwing. Returns references ordered by
 * their position in the text, at most `maxResults` of them, with overlapping detections resolved in
 * favour of the more confident one.
 */
export function detect(text: string, options: ScriptureDetectOptions): ScriptureReference[] {
  try {
    if (typeof text !== 'string' || text.length === 0) return []
    const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text

    const candidates: Candidate[] = []
    scanKoreanExact(scanned, candidates)
    scanEnglishExact(scanned, candidates)
    scanKoreanFuzzy(scanned, candidates)
    scanEnglishFuzzy(scanned, candidates)
    if (candidates.length === 0) return []

    const priming = findPrimingPhrase(scanned)
    const carriedPriming = isPrimingActive(options.primedAt, options.now)

    const scored: Array<{ candidate: Candidate; confidence: number }> = []
    for (const raw of candidates) {
      const candidate = validate(raw)
      if (candidate === null) continue
      const base = baseConfidence(candidate.distance)
      if (base === null) continue
      const primed = carriedPriming || (priming !== null && priming.index < candidate.start)
      const confidence = primed ? Math.min(1, base + PRIMING_BONUS) : base
      if (confidenceBand(confidence) === null) continue
      scored.push({ candidate, confidence })
    }
    if (scored.length === 0) return []

    // Highest confidence wins a contested span; ties go to the longer, then the earlier, match.
    scored.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      const spanA = a.candidate.end - a.candidate.start
      const spanB = b.candidate.end - b.candidate.start
      if (spanB !== spanA) return spanB - spanA
      return a.candidate.start - b.candidate.start
    })

    const accepted: Array<{ candidate: Candidate; confidence: number }> = []
    for (const entry of scored) {
      const overlaps = accepted.some(
        (taken) =>
          entry.candidate.start < taken.candidate.end && taken.candidate.start < entry.candidate.end,
      )
      if (!overlaps) accepted.push(entry)
    }

    accepted.sort((a, b) => a.candidate.start - b.candidate.start)

    const limit = options.maxResults ?? MAX_REFERENCES_PER_UTTERANCE
    const references: ScriptureReference[] = []
    for (const entry of accepted) {
      if (references.length >= limit) break
      const band = confidenceBand(entry.confidence)
      if (band === null) continue
      references.push({
        book: entry.candidate.book.id,
        spokenBook: entry.candidate.spokenBook.trim().slice(0, 60),
        chapter: entry.candidate.chapter,
        verse: entry.candidate.verse,
        verseEnd: entry.candidate.verseEnd,
        confidence: entry.confidence,
        band,
        sourceText: entry.candidate.sourceText.trim().slice(0, 500),
      })
    }
    return references
  } catch {
    // A detector that can crash the transcript pipeline mid-service is worse than one that
    // occasionally sees nothing. There is no recovery to attempt and nothing to report upward.
    return []
  }
}
