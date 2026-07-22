/**
 * Scripture detector behaviour.
 *
 * ## Standing Rule 4 governs this file as hard as it governs the detector
 *
 * Every transcript below is INVENTED. There is no real sermon here, no real congregation, and —
 * most importantly — **no verse text anywhere**, not even as a comment or an example. The detector
 * emits references; where a fixture needs to stand in for resolved text it says
 * `VERSE TEXT PLACEHOLDER` and nothing else. If a future edit to this file ever needs a real verse
 * to make a test pass, the test is wrong.
 *
 * ## What is actually being pinned
 *
 * The detector's job is not "find as many references as possible" — it is "never put a wrong verse
 * in front of a congregation". So the suite spends as much effort on what must NOT be detected
 * (impossible chapters, garbage book names, priming that must never reach the `exact` band) as on
 * what must.
 */

import { describe, expect, it } from 'vitest'

import { BOOKS, BOOK_COUNT, findBookById } from '@main/cue/books'
import {
  MAX_REFERENCES_PER_UTTERANCE,
  boundedLevenshtein,
  detect,
  englishExactKeys,
  findPrimingPhrase,
  isPrimingActive,
  koreanExactKeys,
  parseEnglishNumber,
  parseKoreanNumeral,
} from '@main/cue/scriptureDetector'
import {
  CONFIDENCE_EXACT,
  CONFIDENCE_FUZZY,
  CONFIDENCE_WEAK,
  PRIMING_BONUS,
  PRIMING_WINDOW_MS,
  scriptureReferenceSchema,
} from '@shared/scripture'
import type { ScriptureReference } from '@shared/scripture'

/** A fixed, arbitrary clock. The detector reads no real one, so this can be any number. */
const NOW = 1_700_000_000_000

function refs(text: string, primedAt: number | null = null): ScriptureReference[] {
  return detect(text, { now: NOW, primedAt })
}

function only(text: string, primedAt: number | null = null): ScriptureReference {
  const found = refs(text, primedAt)
  expect(found, `expected exactly one reference in ${JSON.stringify(text)}`).toHaveLength(1)
  const first = found[0]
  if (first === undefined) throw new Error('unreachable: length asserted above')
  return first
}

describe('the book table', () => {
  it('holds the whole canon exactly once', () => {
    expect(BOOKS).toHaveLength(BOOK_COUNT)
    expect(new Set(BOOKS.map((book) => book.id)).size).toBe(BOOK_COUNT)
    expect(BOOKS.filter((book) => book.testament === 'ot')).toHaveLength(39)
    expect(BOOKS.filter((book) => book.testament === 'nt')).toHaveLength(27)
  })

  it('gives every book a Korean name and abbreviation, both unique', () => {
    for (const book of BOOKS) {
      expect(book.ko.length, book.id).toBeGreaterThan(0)
      expect(book.koAbbr.length, book.id).toBeGreaterThan(0)
    }
    expect(new Set(BOOKS.map((book) => book.ko)).size).toBe(BOOK_COUNT)
    expect(new Set(BOOKS.map((book) => book.koAbbr)).size).toBe(BOOK_COUNT)
  })

  it('marks the numbered books with an ordinal and a shared base name', () => {
    const john1 = findBookById('1 John')
    const john3 = findBookById('3 John')
    const samuel1 = findBookById('1 Samuel')
    expect(john1?.ordinal).toBe(1)
    expect(john1?.baseName).toBe('John')
    expect(john3?.ordinal).toBe(3)
    expect(samuel1?.ko).toBe('사무엘상')
    expect(samuel1?.koAbbr).toBe('삼상')
    expect(findBookById('John')?.ordinal).toBeNull()
  })

  it('keeps chapter and verse bounds inside the shared IPC schema', () => {
    for (const book of BOOKS) {
      expect(book.chapters, book.id).toBeGreaterThanOrEqual(1)
      expect(book.chapters, book.id).toBeLessThanOrEqual(150)
      expect(book.maxVerse, book.id).toBeGreaterThanOrEqual(1)
      expect(book.maxVerse, book.id).toBeLessThanOrEqual(200)
    }
    expect(findBookById('John')?.chapters).toBe(21)
    expect(findBookById('Psalms')?.chapters).toBe(150)
    expect(findBookById('Jude')?.chapters).toBe(1)
  })

  it('never lets two books claim the same exact-match key', () => {
    // A collision here would silently point an `exact`-confidence detection at the wrong book,
    // which is the single most expensive mistake this component can make.
    const en = englishExactKeys()
    const ko = koreanExactKeys()
    expect(en.size).toBeGreaterThan(200)
    expect(ko.size).toBeGreaterThan(130)
    expect(en.get('john')?.id).toBe('John')
    expect(en.get('1john')?.id).toBe('1 John')
    expect(en.get('firstjohn')?.id).toBe('1 John')
    expect(ko.get('요한복음')?.id).toBe('John')
    expect(ko.get('요일')?.id).toBe('1 John')
  })

  it('does not list "Jon" as an abbreviation, so it stays available as a misheard "John"', () => {
    for (const book of BOOKS) {
      expect(book.abbreviations.map((a) => a.toLowerCase())).not.toContain('jon')
    }
  })
})

describe('numeral parsing', () => {
  it('reads spoken English numbers that actually compose', () => {
    expect(parseEnglishNumber('three')).toBe(3)
    expect(parseEnglishNumber('sixteen')).toBe(16)
    expect(parseEnglishNumber('twenty three')).toBe(23)
    expect(parseEnglishNumber('one hundred nineteen')).toBe(119)
    expect(parseEnglishNumber('banana')).toBeNull()
  })

  it('reads Sino-Korean numerals', () => {
    expect(parseKoreanNumeral('삼')).toBe(3)
    expect(parseKoreanNumeral('십육')).toBe(16)
    expect(parseKoreanNumeral('십륙')).toBe(16)
    expect(parseKoreanNumeral('이십삼')).toBe(23)
    expect(parseKoreanNumeral('백이십삼')).toBe(123)
    expect(parseKoreanNumeral('가나')).toBeNull()
  })
})

describe('Korean forms', () => {
  it('detects "요한복음 3장 16절"', () => {
    const found = only('오늘 우리가 살펴볼 구절은 요한복음 3장 16절 입니다')
    expect(found.book).toBe('John')
    expect(found.spokenBook).toBe('요한복음')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
    expect(found.verseEnd).toBeNull()
    expect(found.band).toBe('exact')
    expect(found.confidence).toBe(CONFIDENCE_EXACT)
  })

  it('detects the colon form "요한복음 3:16"', () => {
    const found = only('요한복음 3:16 을 함께 보겠습니다')
    expect(found.book).toBe('John')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
  })

  it('detects a Korean range "요한복음 3장 16-18절"', () => {
    const found = only('요한복음 3장 16-18절 까지 읽겠습니다')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
    expect(found.verseEnd).toBe(18)
  })

  it('detects a whole chapter "요한복음 3장"', () => {
    const found = only('요한복음 3장 전체를 다루려고 합니다')
    expect(found.book).toBe('John')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBeNull()
  })

  it('detects the abbreviated form "요 3:16"', () => {
    const found = only('요 3:16 참고하세요')
    expect(found.book).toBe('John')
    expect(found.spokenBook).toBe('요')
    expect(found.verse).toBe(16)
    expect(found.band).toBe('exact')
  })

  it('detects Sino-Korean spoken numerals "요한복음 삼장 십육절"', () => {
    const found = only('요한복음 삼장 십육절 말씀입니다')
    expect(found.book).toBe('John')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
  })

  it('handles the Psalms counter 편', () => {
    const found = only('시편 23편 1절 을 보십시오')
    expect(found.book).toBe('Psalms')
    expect(found.chapter).toBe(23)
    expect(found.verse).toBe(1)
  })

  it('distinguishes 요한일서 from 요한복음', () => {
    expect(only('요한일서 4장 8절').book).toBe('1 John')
    expect(only('요한1서 4장 8절').book).toBe('1 John')
    expect(only('요한복음 4장 8절').book).toBe('John')
  })

  it('does not read an ordinary word after 장 as a Sino-Korean verse', () => {
    // 이 is the numeral 2; without the mandatory 절 this would become 요한복음 3:2.
    const found = only('요한복음 3장 이하의 내용을 살펴봅니다')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBeNull()
  })
})

describe('English forms', () => {
  it('detects "John 3:16"', () => {
    const found = only('We are looking at John 3:16 this morning')
    expect(found.book).toBe('John')
    expect(found.spokenBook).toBe('John')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
    expect(found.band).toBe('exact')
  })

  it('detects "John chapter 3 verse 16"', () => {
    const found = only('Please open to John chapter 3 verse 16 with me')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
  })

  it('detects a whole chapter "Romans chapter 8"', () => {
    const found = only('The whole argument of Romans chapter 8 hangs together')
    expect(found.book).toBe('Romans')
    expect(found.chapter).toBe(8)
    expect(found.verse).toBeNull()
  })

  it('detects "First Corinthians 13"', () => {
    const found = only('That is what First Corinthians 13 is about')
    expect(found.book).toBe('1 Corinthians')
    expect(found.chapter).toBe(13)
    expect(found.verse).toBeNull()
    expect(found.band).toBe('exact')
  })

  it('detects the digit and roman-numeral ordinal forms too', () => {
    expect(only('see 1 Corinthians 13:4 today').book).toBe('1 Corinthians')
    expect(only('see II Timothy 2:2 today').book).toBe('2 Timothy')
    expect(only('see 2nd Peter 1:20 today').book).toBe('2 Peter')
  })

  it('detects spelled-out numbers in "turn to John three sixteen"', () => {
    const found = only('I want you to turn to John three sixteen with me')
    expect(found.book).toBe('John')
    expect(found.chapter).toBe(3)
    expect(found.verse).toBe(16)
  })

  it('detects an English range "1 Corinthians 13:4-8"', () => {
    const found = only('Look at 1 Corinthians 13:4-8 for a moment')
    expect(found.book).toBe('1 Corinthians')
    expect(found.chapter).toBe(13)
    expect(found.verse).toBe(4)
    expect(found.verseEnd).toBe(8)
  })

  it('detects a spoken range "Romans 8 verses 1 to 4"', () => {
    const found = only('We will read Romans 8 verses 1 to 4 only')
    expect(found.chapter).toBe(8)
    expect(found.verse).toBe(1)
    expect(found.verseEnd).toBe(4)
  })

  it('detects standard abbreviations at exact confidence', () => {
    const jn = only('the note in Jn 3:16 says so')
    expect(jn.book).toBe('John')
    expect(jn.band).toBe('exact')
    expect(only('a line from Ps 23:1 there').book).toBe('Psalms')
    expect(only('as 1 Cor 13:4 puts it').book).toBe('1 Corinthians')
  })

  it('treats a bare number in a one-chapter book as a verse', () => {
    const found = only('There is a phrase in Jude 5 worth noting')
    expect(found.book).toBe('Jude')
    expect(found.chapter).toBe(1)
    expect(found.verse).toBe(5)
  })

  it('does not turn a stray spoken number after a digit chapter into a verse', () => {
    // "Romans 8 one of the great chapters" must stay a whole-chapter reference.
    const found = only('Romans 8 one of the great chapters in all of scripture')
    expect(found.chapter).toBe(8)
    expect(found.verse).toBeNull()
  })
})

describe('fuzzy matching', () => {
  it('lands a Levenshtein-1 book name in the fuzzy band', () => {
    const found = only('the reading is Jon 3:16 this morning')
    expect(found.book).toBe('John')
    expect(found.spokenBook).toBe('Jon')
    expect(found.band).toBe('fuzzy')
    expect(found.confidence).toBe(CONFIDENCE_FUZZY)
  })

  it('lands a Levenshtein-1 Korean book name in the fuzzy band', () => {
    const found = only('요한봄음 3장 16절 을 보겠습니다')
    expect(found.book).toBe('John')
    expect(found.band).toBe('fuzzy')
    expect(found.confidence).toBe(CONFIDENCE_FUZZY)
  })

  it('lands a Levenshtein-2 book name in the weak band', () => {
    const found = only('the reading is Romens chapter 8 today')
    expect(found.book).toBe('Romans')
    expect(found.band).toBe('fuzzy')
  })

  it('returns nothing at all for a book name that is simply not one', () => {
    expect(refs('the reading is Blorptrex 3:16 today')).toEqual([])
    expect(refs('Zzzyxwq chapter 4 verse 2')).toEqual([])
  })

  it('does not fuzzy-match against abbreviations, so "room 3:16" is not Romans', () => {
    expect(refs('we are meeting in room 3:16 downstairs')).toEqual([])
  })

  it('bounds the edit-distance helper rather than computing the true distance', () => {
    expect(boundedLevenshtein('john', 'john', 2)).toBe(0)
    expect(boundedLevenshtein('jon', 'john', 2)).toBe(1)
    expect(boundedLevenshtein('jon', 'job', 2)).toBe(1)
    expect(boundedLevenshtein('romens', 'romans', 2)).toBe(1)
    // Past the cap the exact value is meaningless — only "further than you care about" is promised.
    expect(boundedLevenshtein('room', 'romans', 2)).toBeGreaterThan(2)
    expect(boundedLevenshtein('blorptrex', 'john', 2)).toBeGreaterThan(2)
  })

  it('prefers an inserted character over a substituted one at the same distance', () => {
    // "Jon" is one edit from both Job and John; the ASR dropping a character is the likelier slip.
    expect(only('the reading is Jon 3:16 this morning').book).toBe('John')
  })
})

describe('priming', () => {
  it('finds the Korean and English priming phrases', () => {
    expect(findPrimingPhrase('오늘 받으실 말씀은 다음과 같습니다')?.language).toBe('ko')
    expect(findPrimingPhrase('I want you to turn to the next page')?.language).toBe('en')
    expect(findPrimingPhrase('nothing of the sort here')).toBeNull()
  })

  it('ages a remembered priming timestamp out of its window', () => {
    expect(isPrimingActive(NOW - 1_000, NOW)).toBe(true)
    expect(isPrimingActive(NOW - PRIMING_WINDOW_MS, NOW)).toBe(true)
    expect(isPrimingActive(NOW - PRIMING_WINDOW_MS - 1, NOW)).toBe(false)
    expect(isPrimingActive(null, NOW)).toBe(false)
  })

  it('lifts a fuzzy match while primed and drops it back once the window expires', () => {
    const unprimed = only('the reading is Jon 3:16 this morning')
    expect(unprimed.confidence).toBe(CONFIDENCE_FUZZY)

    const primed = only('the reading is Jon 3:16 this morning', NOW - 5_000)
    expect(primed.confidence).toBeCloseTo(CONFIDENCE_FUZZY + PRIMING_BONUS, 10)
    expect(primed.book).toBe('John')

    const expired = only('the reading is Jon 3:16 this morning', NOW - PRIMING_WINDOW_MS - 1)
    expect(expired.confidence).toBe(CONFIDENCE_FUZZY)
  })

  it('primes from a phrase inside the same utterance', () => {
    const found = only('받으실 말씀은 요한봄음 3장 16절 입니다')
    expect(found.book).toBe('John')
    expect(found.confidence).toBeCloseTo(CONFIDENCE_FUZZY + PRIMING_BONUS, 10)
    expect(found.band).toBe('fuzzy')
  })

  it('never promotes a guess into the exact band, however primed', () => {
    // The safety property: `exact` is the only band `canAutoShow()` will consider, so priming
    // must never be able to manufacture one. CONFIDENCE_FUZZY + PRIMING_BONUS < CONFIDENCE_EXACT.
    expect(CONFIDENCE_FUZZY + PRIMING_BONUS).toBeLessThan(CONFIDENCE_EXACT)
    expect(CONFIDENCE_WEAK + PRIMING_BONUS).toBeLessThan(CONFIDENCE_EXACT)
    const primed = only('받으실 말씀은 요한봄음 3장 16절 입니다')
    expect(primed.band).not.toBe('exact')
  })
})

describe('validation against the book table', () => {
  it('rejects a chapter that cannot exist', () => {
    // John has 21 chapters. "John 99" is a mis-detection, not a misheard reference.
    expect(refs('somebody said John 99:1 which is odd')).toEqual([])
    expect(refs('요한복음 99장 1절')).toEqual([])
  })

  it('rejects a verse that cannot exist', () => {
    expect(refs('they claimed Genesis 3:400 was the text')).toEqual([])
  })

  it('keeps the start verse when only the range end is impossible', () => {
    const found = only('Genesis 1:1-400 apparently')
    expect(found.chapter).toBe(1)
    expect(found.verse).toBe(1)
    expect(found.verseEnd).toBeNull()
  })

  it('accepts the last real chapter of a book and rejects the one after it', () => {
    expect(only('John 21:25 is the closing line').chapter).toBe(21)
    expect(refs('John 22:1 does not exist')).toEqual([])
    expect(only('Psalm 150 is the last one').chapter).toBe(150)
    expect(refs('Psalm 151 is not in this canon')).toEqual([])
  })
})

describe('whole utterances', () => {
  it('finds several references in one sentence, in order', () => {
    const found = refs('우리는 요한복음 3장 16절과 로마서 8장 28절을 함께 봅니다')
    expect(found.map((r) => r.book)).toEqual(['John', 'Romans'])
    expect(found[0]?.verse).toBe(16)
    expect(found[1]?.chapter).toBe(8)
    expect(found[1]?.verse).toBe(28)
  })

  it('finds several English references in one sentence', () => {
    const found = refs('We read John 3:16 and then Romans chapter 8 before the offering')
    expect(found.map((r) => r.book)).toEqual(['John', 'Romans'])
  })

  it('mixes languages in one utterance', () => {
    const found = refs('요한복음 3장 16절 and also Romans 8:28 together')
    expect(found.map((r) => r.book)).toEqual(['John', 'Romans'])
  })

  it('caps how many references one utterance may produce', () => {
    const sentence = Array.from({ length: 20 }, (_, i) => `Psalm ${i + 1}:1`).join(' and ')
    expect(refs(sentence).length).toBeLessThanOrEqual(MAX_REFERENCES_PER_UTTERANCE)
  })

  it('returns nothing for ordinary speech with no reference in it', () => {
    expect(refs('Good morning everyone, it is wonderful to be together again today')).toEqual([])
    expect(refs('오늘 이렇게 함께 모여서 감사합니다')).toEqual([])
    expect(refs('')).toEqual([])
  })

  it('never emits anything but a reference — no verse text, ever', () => {
    const found = refs(
      '받으실 말씀은 요한복음 3장 16절 이고 그 다음은 Romans 8:28 입니다. VERSE TEXT PLACEHOLDER',
    )
    expect(found.length).toBeGreaterThan(0)
    for (const reference of found) {
      // The shared schema is the boundary contract: it has no field that could carry verse text.
      expect(scriptureReferenceSchema.safeParse(reference).success).toBe(true)
      expect(Object.keys(reference).sort()).toEqual([
        'band',
        'book',
        'chapter',
        'confidence',
        'sourceText',
        'spokenBook',
        'verse',
        'verseEnd',
      ])
    }
  })
})

describe('robustness', () => {
  it('completes fast on adversarial input rather than backtracking catastrophically', () => {
    const adversarial = [
      'John '.repeat(800),
      'John chapter '.repeat(300),
      '요한복음 '.repeat(600),
      `${'1 '.repeat(1000)}Corinthians`,
      'one hundred '.repeat(300),
      `John ${'3'.repeat(2000)}`,
      `${'요'.repeat(3000)}3장`,
      'a'.repeat(6000),
      `${'John chapter one hundred nineteen verse '.repeat(100)}1`,
    ]
    const started = performance.now()
    for (const input of adversarial) detect(input, { now: NOW })
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(50)
  })

  it('never throws, whatever it is handed', () => {
    const nasty: unknown[] = [null, undefined, 42, {}, [], '\u0000\uFFFD', '::::', '장장장장', '\uD800']
    for (const value of nasty) {
      expect(() => detect(value as string, { now: NOW })).not.toThrow()
    }
  })

  it('produces references that always satisfy the shared IPC schema', () => {
    const samples = [
      '요한복음 3장 16절',
      'First Corinthians 13',
      'Psalm 150',
      'Jude 5',
      'Jon 3:16',
      '시편 119편 105절',
      '1 Corinthians 13:4-8',
    ]
    for (const sample of samples) {
      for (const reference of refs(sample)) {
        const parsed = scriptureReferenceSchema.safeParse(reference)
        expect(parsed.success, `${sample} -> ${JSON.stringify(reference)}`).toBe(true)
      }
    }
  })
})
