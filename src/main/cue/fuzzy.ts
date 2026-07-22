/**
 * Matching primitives for the cue engine.
 *
 * Everything here runs against the LIVE transcript, on every ASR final, for the whole length of a
 * service. So the two properties that matter more than cleverness are:
 *
 * 1. **Bounded cost.** Every loop in this file has an explicit cap — token counts, string lengths
 *    and the number of pairwise comparisons are all clamped, and the fuzzy search carries a
 *    comparison budget it degrades against rather than blowing past. A matcher that is O(n·m) over
 *    an unbounded rolling window is a hang waiting for a long sermon.
 * 2. **No catastrophic backtracking.** The only regexes here are single-quantifier character
 *    classes (`/[^\p{L}\p{N}]+/u`). Nothing in this module ever compiles a pattern from operator-
 *    or ASR-supplied text, so there is no ReDoS surface at all — the v2 notes flag this explicitly
 *    and the cheapest defence is not to build dynamic regexes in the first place.
 *
 * ## Why token-based similarity and not Levenshtein over whole sentences
 *
 * ASR does not corrupt a sentence uniformly. It *drops* words, *swaps* homophones and *mangles*
 * proper nouns, while leaving most of the sentence intact. Raw edit distance over a whole span
 * punishes a single dropped word by its full length and collapses as the span grows, which is
 * exactly backwards: an anchor phrase is a short needle inside a long, noisy haystack.
 *
 * So {@link similarity} asks a different question — *how much of the anchor can I find in the
 * recent transcript?* — scoring each anchor token against the best candidate token in the span,
 * with a per-token edit-distance tolerance for the mangling. Levenshtein is still here
 * ({@link levenshtein}), but applied where it is the right tool: single words, and the book-name
 * matching the scripture detector needs.
 *
 * ## Korean
 *
 * Korean is written without reliable word spacing, and ASR spacing is worse than the written
 * convention — "받으실 말씀은" and "받으실말씀은" are the same utterance and must score the same.
 * Whitespace tokenisation alone therefore fails on exactly the phrases that matter most.
 *
 * The approach here: split on non-alphanumerics as usual, then **decompose any token containing
 * Hangul into character bigrams** (`받으실` → `받으`, `으실`). Bigrams are spacing-independent, so
 * a run joined or split by the recogniser produces overlapping token sets either way, and they are
 * short enough that one mis-recognised syllable costs one or two bigrams rather than the whole
 * word. Tokens of one or two characters are kept whole.
 *
 * Node-global free by construction (nothing here touches a Node API), though it lives in `main`.
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Longest string either side of an edit-distance computation.
 *
 * Levenshtein is O(n·m); capping at 64 characters caps one comparison at ~4k cells. Longer inputs
 * are truncated rather than refused, because a truncated comparison of a 200-character token is
 * still a useful answer and a hang is not.
 */
export const MAX_LEVENSHTEIN_LENGTH = 64

/** Most tokens taken from an anchor phrase. Anchors are phrases, not paragraphs. */
export const MAX_ANCHOR_TOKENS = 64

/**
 * Most tokens taken from a transcript span.
 *
 * The engine's rolling window is a few seconds of speech; this is a backstop against a provider
 * that emits an enormous final, not a normal-case limit.
 */
export const MAX_SPAN_TOKENS = 600

/**
 * How similar two tokens must be before a fuzzy token match counts at all.
 *
 * Below this the "match" is coincidence — three-letter words are within one edit of half the
 * dictionary — and counting it would inflate every score toward the anchor threshold.
 */
export const MIN_TOKEN_SIMILARITY = 0.7

/**
 * Only tokens within this many characters of the anchor token are considered as fuzzy candidates.
 *
 * Both a correctness filter (a 4-character token is not a mangling of an 11-character one) and the
 * mechanism that keeps the candidate scan sub-quadratic in practice.
 */
export const MAX_TOKEN_LENGTH_DELTA = 2

/**
 * Hard ceiling on edit-distance comparisons inside one {@link similarity} call.
 *
 * Reached, the search stops *improving* — already-matched tokens keep their scores and the rest
 * count as misses. Degrading toward a lower score is the safe direction: the engine's response to
 * a low score is to stay quiet.
 */
export const MAX_FUZZY_COMPARISONS = 4_000

// ---------------------------------------------------------------------------
// Normalisation and tokenisation
// ---------------------------------------------------------------------------

/**
 * Split on runs of anything that is not a letter or a digit.
 *
 * One character class, one quantifier, no alternation and no nesting — linear time on any input,
 * which is the whole requirement. Unicode-aware so Hangul, Latin and digits all survive.
 */
const SEPARATOR_PATTERN = /[^\p{L}\p{N}]+/u

/**
 * The same class, global, for stripping rather than splitting.
 *
 * Kept as a separate literal instead of reusing the one above: `String.replace` needs the `g` flag
 * to remove every run, `String.split` does not, and a shared global regex would carry `lastIndex`
 * state between calls. Two literals, no state.
 */
const SEPARATOR_STRIP_PATTERN = /[^\p{L}\p{N}]+/gu

/** Precomposed Hangul syllables. Jamo blocks are deliberately out of scope — ASR emits syllables. */
const HANGUL_PATTERN = /[가-힣]/

/**
 * Case-fold, NFC-normalise and collapse whitespace.
 *
 * NFC matters for Korean specifically: the same syllable can arrive precomposed or as conjoining
 * jamo depending on the recogniser, and two spellings of one word must not fail to match.
 */
export function normaliseText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Whether a token contains at least one Hangul syllable. */
function hasHangul(token: string): boolean {
  return HANGUL_PATTERN.test(token)
}

/**
 * Break text into comparison tokens.
 *
 * Latin/numeric tokens are kept whole; Hangul-bearing tokens longer than two characters are
 * decomposed into overlapping character bigrams so that word spacing — which Korean ASR gets
 * wrong constantly — stops mattering. See the module docblock.
 */
export function tokenise(text: string, limit: number = MAX_SPAN_TOKENS): readonly string[] {
  const tokens: string[] = []
  const words = normaliseText(text).split(SEPARATOR_PATTERN)

  for (const word of words) {
    if (tokens.length >= limit) break
    if (word.length === 0) continue

    if (!hasHangul(word) || word.length <= 2) {
      tokens.push(word)
      continue
    }
    for (let index = 0; index + 2 <= word.length; index += 1) {
      if (tokens.length >= limit) break
      tokens.push(word.slice(index, index + 2))
    }
  }
  return tokens
}

/** Tokens with duplicates removed, order preserved. Used for the anchor side of a match. */
export function uniqueTokens(text: string, limit: number = MAX_ANCHOR_TOKENS): readonly string[] {
  const seen = new Set<string>()
  for (const token of tokenise(text, limit * 4)) {
    if (seen.size >= limit) break
    seen.add(token)
  }
  return [...seen]
}

/**
 * Whether `phrase` occurs in `text`, ignoring case, punctuation and word spacing.
 *
 * The hot-phrase detector's primitive: exact and fast, deliberately not fuzzy. A hot phrase is
 * something the operator typed and the speaker says on purpose; making it fuzzy would turn a
 * precise tool into a third source of near-misses.
 *
 * Spacing is stripped from both sides before the test, so "받으실 말씀은" matches
 * "받으실말씀은" and "let's pray" matches "lets  pray".
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = stripForContains(phrase)
  if (needle.length === 0) return false
  return stripForContains(text).includes(needle)
}

function stripForContains(value: string): string {
  return normaliseText(value).replace(SEPARATOR_STRIP_PATTERN, '')
}

// ---------------------------------------------------------------------------
// Edit distance
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance, with an optional early-exit ceiling.
 *
 * Two-row dynamic programming — O(n·m) time, O(min(n,m)) space — over inputs truncated to
 * {@link MAX_LEVENSHTEIN_LENGTH}. When `maxDistance` is supplied and every cell of a row exceeds
 * it, the answer can only get larger, so the function returns `maxDistance + 1` immediately. That
 * turns the common case (two obviously different book names) into a couple of rows of work.
 *
 * Exported because the scripture detector's book-name matching needs exactly this: the
 * `fuzzy` confidence band in `@shared/scripture` is defined as "one edit away from a known book
 * name", which is a `levenshtein(spoken, book) <= 1` test.
 */
export function levenshtein(
  a: string,
  b: string,
  maxDistance: number = Number.POSITIVE_INFINITY
): number {
  const left = a.length > MAX_LEVENSHTEIN_LENGTH ? a.slice(0, MAX_LEVENSHTEIN_LENGTH) : a
  const right = b.length > MAX_LEVENSHTEIN_LENGTH ? b.slice(0, MAX_LEVENSHTEIN_LENGTH) : b

  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  // A length gap alone already exceeds the ceiling — no need to build a table for it.
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1

  let previous = new Array<number>(right.length + 1)
  let current = new Array<number>(right.length + 1)
  for (let column = 0; column <= right.length; column += 1) previous[column] = column

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row
    let rowMinimum = row
    const leftChar = left[row - 1]

    for (let column = 1; column <= right.length; column += 1) {
      const cost = leftChar === right[column - 1] ? 0 : 1
      const deletion = (previous[column] ?? row) + 1
      const insertion = (current[column - 1] ?? column) + 1
      const substitution = (previous[column - 1] ?? column - 1) + cost
      const value = Math.min(deletion, insertion, substitution)
      current[column] = value
      if (value < rowMinimum) rowMinimum = value
    }

    if (rowMinimum > maxDistance) return maxDistance + 1

    const swap = previous
    previous = current
    current = swap
  }

  return previous[right.length] ?? Math.max(left.length, right.length)
}

/**
 * Edit distance rescaled to a [0,1] similarity, 1 meaning identical.
 *
 * The ceiling is derived from {@link MIN_TOKEN_SIMILARITY}, so a pair that could not possibly
 * clear the token-match bar exits after a row or two instead of filling a table.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const longest = Math.min(Math.max(a.length, b.length), MAX_LEVENSHTEIN_LENGTH)
  if (longest === 0) return 1

  const ceiling = Math.floor(longest * (1 - MIN_TOKEN_SIMILARITY))
  const distance = levenshtein(a, b, ceiling)
  if (distance > ceiling) return 0
  return clamp01(1 - distance / longest)
}

// ---------------------------------------------------------------------------
// Span ↔ anchor similarity
// ---------------------------------------------------------------------------

/**
 * How much of `anchor` can be found in `span`, in [0,1].
 *
 * Each distinct anchor token is weighted by its length and scored against the best candidate token
 * in the span — exact hit first (a set lookup), then a length-bucketed fuzzy search that only
 * considers tokens within {@link MAX_TOKEN_LENGTH_DELTA} characters. Length weighting is what
 * stops an anchor being "matched" by its stopwords: finding *the*, *to* and *us* in a sermon is
 * not evidence of anything, and those tokens are short.
 *
 * Deliberately **unordered** and **not penalised for extra span text**. The anchor is a phrase the
 * speaker is expected to say somewhere inside several seconds of surrounding speech; requiring
 * contiguity would make one dropped word fatal, and penalising the surrounding words would make
 * the score depend on how chatty the last few seconds were rather than on whether the cue's words
 * were said.
 *
 * Returns 0 rather than throwing for empty input — nothing in the cue engine throws.
 */
export function similarity(span: string, anchor: string): number {
  const anchorTokens = uniqueTokens(anchor, MAX_ANCHOR_TOKENS)
  if (anchorTokens.length === 0) return 0

  const spanTokens = tokenise(span, MAX_SPAN_TOKENS)
  if (spanTokens.length === 0) return 0

  const spanSet = new Set(spanTokens)
  const byLength = new Map<number, string[]>()
  for (const token of spanSet) {
    const bucket = byLength.get(token.length)
    if (bucket === undefined) byLength.set(token.length, [token])
    else bucket.push(token)
  }

  let budget = MAX_FUZZY_COMPARISONS
  let totalWeight = 0
  let matchedWeight = 0

  for (const token of anchorTokens) {
    const weight = token.length
    totalWeight += weight

    if (spanSet.has(token)) {
      matchedWeight += weight
      continue
    }

    let best = 0
    for (
      let length = Math.max(1, token.length - MAX_TOKEN_LENGTH_DELTA);
      length <= token.length + MAX_TOKEN_LENGTH_DELTA;
      length += 1
    ) {
      const bucket = byLength.get(length)
      if (bucket === undefined) continue
      for (const candidate of bucket) {
        if (budget <= 0) break
        budget -= 1
        const score = levenshteinSimilarity(token, candidate)
        if (score > best) best = score
        if (best >= 1) break
      }
      if (best >= 1 || budget <= 0) break
    }

    if (best >= MIN_TOKEN_SIMILARITY) matchedWeight += weight * best
  }

  if (totalWeight === 0) return 0
  return clamp01(matchedWeight / totalWeight)
}

/**
 * The best {@link similarity} of any anchor against one span, with the winning anchor.
 *
 * A convenience for the plan-follower's look-ahead window: it scores a handful of upcoming cues
 * against the same span and wants the strongest. Returns index `-1` and score `0` for an empty
 * anchor list.
 */
export function bestMatch(
  span: string,
  anchors: readonly string[]
): { readonly index: number; readonly score: number } {
  let index = -1
  let score = 0
  for (let position = 0; position < anchors.length; position += 1) {
    const anchor = anchors[position]
    if (anchor === undefined) continue
    const candidate = similarity(span, anchor)
    // Strictly greater: on a tie the EARLIER cue wins, because the look-ahead window is ordered
    // by the service and jumping the furthest-ahead match is the more dangerous mistake.
    if (candidate > score) {
      score = candidate
      index = position
    }
  }
  return { index, score }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
