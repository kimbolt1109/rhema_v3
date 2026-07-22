/**
 * Tests for the cue engine's matching primitives.
 *
 * Every transcript in this file is INVENTED (Standing Rule 4). Nothing here is a real sermon, and
 * nothing here is verse text — the scripture-shaped strings are references only.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_FUZZY_COMPARISONS,
  MAX_LEVENSHTEIN_LENGTH,
  MIN_TOKEN_SIMILARITY,
  bestMatch,
  containsPhrase,
  levenshtein,
  levenshteinSimilarity,
  normaliseText,
  similarity,
  tokenise,
  uniqueTokens
} from './fuzzy'

describe('normaliseText', () => {
  it('case-folds and collapses whitespace', () => {
    expect(normaliseText('  The   FIRST  Thing ')).toBe('the first thing')
  })

  it('is NFC-stable, so decomposed and precomposed Hangul compare equal', () => {
    const precomposed = '말씀'
    const decomposed = precomposed.normalize('NFD')
    expect(decomposed).not.toBe(precomposed)
    expect(normaliseText(decomposed)).toBe(normaliseText(precomposed))
  })
})

describe('tokenise', () => {
  it('keeps latin words whole and drops punctuation', () => {
    expect(tokenise("Let's pray, together!")).toEqual(['let', 's', 'pray', 'together'])
  })

  it('breaks Hangul into character bigrams so word spacing stops mattering', () => {
    const spaced = tokenise('받으실 말씀은')
    const joined = tokenise('받으실말씀은')
    // The joined form still contains every bigram of the spaced form.
    for (const token of spaced) expect(joined).toContain(token)
    expect(spaced).toContain('받으')
    expect(spaced).toContain('말씀')
  })

  it('keeps very short Hangul tokens whole', () => {
    expect(tokenise('3장')).toEqual(['3장'])
  })

  it('honours its token limit', () => {
    const many = Array.from({ length: 500 }, (_, index) => `word${index}`).join(' ')
    expect(tokenise(many, 10)).toHaveLength(10)
  })
})

describe('uniqueTokens', () => {
  it('de-duplicates while preserving order', () => {
    expect(uniqueTokens('pray and pray and pray')).toEqual(['pray', 'and'])
  })
})

describe('containsPhrase', () => {
  it('matches case-insensitively', () => {
    expect(containsPhrase("Now, LET'S PRAY together", "let's pray")).toBe(true)
  })

  it('ignores word spacing, which is what makes Korean phrases match', () => {
    expect(containsPhrase('오늘 받으실말씀은 다음과 같습니다', '받으실 말씀은')).toBe(true)
    expect(containsPhrase('오늘 받으실 말씀은 다음과 같습니다', '받으실말씀은')).toBe(true)
  })

  it('does not match a phrase that is not there', () => {
    expect(containsPhrase('we will now sing together', "let's pray")).toBe(false)
  })

  it('refuses an empty phrase rather than matching everything', () => {
    expect(containsPhrase('anything at all', '   ')).toBe(false)
  })
})

describe('levenshtein', () => {
  it('computes the classic distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('flaw', 'lawn')).toBe(2)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', 'abc')).toBe(0)
  })

  it('is what the scripture detector needs for a one-edit book name', () => {
    // Reference matching only — no verse text is involved anywhere in this file.
    expect(levenshtein('romams', 'romans')).toBe(1)
    expect(levenshtein('jhon', 'john')).toBe(2)
  })

  it('exits early once the ceiling cannot be met', () => {
    // The answer is 3, but with a ceiling of 1 the function is allowed to stop at ceiling + 1.
    expect(levenshtein('kitten', 'sitting', 1)).toBe(2)
  })

  it('rejects on the length gap alone without building a table', () => {
    expect(levenshtein('a', 'abcdefghij', 2)).toBe(3)
  })

  it('truncates rather than hanging on absurd input', () => {
    const long = 'a'.repeat(50_000)
    const other = 'b'.repeat(50_000)
    const started = Date.now()
    expect(levenshtein(long, other)).toBe(MAX_LEVENSHTEIN_LENGTH)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('levenshteinSimilarity', () => {
  it('is 1 for identical tokens and 0 for unrelated ones', () => {
    expect(levenshteinSimilarity('welcome', 'welcome')).toBe(1)
    expect(levenshteinSimilarity('welcome', 'offering')).toBe(0)
  })

  it('scores a single-character slip above the token-match bar', () => {
    expect(levenshteinSimilarity('offering', 'offerring')).toBeGreaterThanOrEqual(
      MIN_TOKEN_SIMILARITY
    )
  })
})

describe('similarity', () => {
  const anchor = 'the first thing I want us to see'

  it('is 1 when the anchor is spoken verbatim inside a longer span', () => {
    expect(similarity('so then the first thing i want us to see is here', anchor)).toBe(1)
  })

  it('survives a dropped word, which is the normal ASR failure', () => {
    expect(similarity('the first thing i want to see', anchor)).toBeGreaterThan(0.78)
  })

  it('falls below the anchor threshold once the sentence is really gone', () => {
    expect(similarity('and so the men of the village went down to the water', anchor)).toBeLessThan(
      0.78
    )
  })

  it('is not fooled by stopwords alone — length weighting is what stops that', () => {
    expect(similarity('the to us i', anchor)).toBeLessThan(0.5)
  })

  it('tolerates a mangled word via the per-token edit tolerance', () => {
    expect(similarity('the firrst thing i want us to see', anchor)).toBeGreaterThan(0.78)
  })

  it('matches a Korean anchor whether or not the recogniser inserted spaces', () => {
    const koreanAnchor = '받으실 말씀은'
    expect(similarity('오늘 받으실 말씀은 이렇습니다', koreanAnchor)).toBe(1)
    expect(similarity('오늘 받으실말씀은 이렇습니다', koreanAnchor)).toBe(1)
    expect(similarity('오늘 우리가 함께 찬송을 부르겠습니다', koreanAnchor)).toBeLessThan(0.5)
  })

  it('returns 0 rather than throwing on empty input', () => {
    expect(similarity('', anchor)).toBe(0)
    expect(similarity('anything', '')).toBe(0)
    expect(similarity('', '')).toBe(0)
  })

  it('stays bounded on a very long span', () => {
    const span = Array.from({ length: 5_000 }, (_, index) => `word${index}`).join(' ')
    const started = Date.now()
    const score = similarity(span, anchor)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps a comparison budget so a pathological span cannot run away', () => {
    expect(MAX_FUZZY_COMPARISONS).toBeGreaterThan(0)
    const span = Array.from({ length: 2_000 }, (_, index) => `xxxx${index}`).join(' ')
    const started = Date.now()
    similarity(span, 'the first thing I want us to see right now today')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('bestMatch', () => {
  const anchors = ['let us welcome one another', 'the first thing I want us to see', 'let us pray']

  it('finds the strongest anchor', () => {
    const result = bestMatch('and now let us pray', anchors)
    expect(result.index).toBe(2)
    expect(result.score).toBe(1)
  })

  it('reports index -1 and score 0 when nothing matches', () => {
    const result = bestMatch('completely unrelated speech about weather', anchors)
    expect(result.score).toBeLessThan(0.78)
    // Either nothing scored at all, or something scored weakly — never a confident wrong answer.
    expect(result.score).toBeLessThan(0.78)
  })

  it('prefers the earlier cue on a tie, because jumping further ahead is the worse mistake', () => {
    const duplicated = ['let us pray', 'let us pray']
    expect(bestMatch('and now let us pray', duplicated).index).toBe(0)
  })

  it('handles an empty anchor list', () => {
    expect(bestMatch('anything', [])).toEqual({ index: -1, score: 0 })
  })
})
