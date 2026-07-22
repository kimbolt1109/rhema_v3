/**
 * `isLikelyHallucination` — exhaustive tests for the one filter that stands between Whisper's
 * imagination and the congregation screen.
 *
 * Why this deserves its own file. Whisper is trained on subtitle corpora, so when it is fed
 * silence it does not emit nothing — it emits the most likely thing a subtitle track says next:
 * "Thank you for watching", "구독과 좋아요", "[음악]". During a silent prayer that text would
 * appear in the transcript looking exactly as confident as real speech, and — far worse for
 * Verger — it could match a hot phrase or a plan anchor and fire a cue at the congregation.
 *
 * The filter is deliberately **conservative**: it rejects a segment only when the segment is
 * ENTIRELY one of the known artefacts. Dropping real speech mid-sermon is much worse than letting
 * one stray artefact through, because the operator can ignore a bad line but cannot recover a
 * missed one. The whole-segment property is therefore the load-bearing test here, not a detail.
 *
 * Standing Rule 4: every string below is invented placeholder text. No transcript, no lyric and
 * no verse from any real service appears in this repo.
 */

import { describe, expect, it } from 'vitest'

import { HALLUCINATION_PHRASES, isLikelyHallucination } from '@shared/asr'

describe('isLikelyHallucination — the known artefacts', () => {
  it.each([...HALLUCINATION_PHRASES])('rejects %j when it is the whole segment', (phrase) => {
    expect(isLikelyHallucination(phrase)).toBe(true)
  })

  it('rejects every phrase upper-cased, because Whisper capitalises inconsistently', () => {
    for (const phrase of HALLUCINATION_PHRASES) {
      expect(isLikelyHallucination(phrase.toUpperCase())).toBe(true)
    }
  })

  it('rejects every phrase with leading and trailing whitespace', () => {
    for (const phrase of HALLUCINATION_PHRASES) {
      expect(isLikelyHallucination(`  ${phrase}\n`)).toBe(true)
    }
  })

  it('covers the artefacts that matter most on a Korean stream', () => {
    expect(isLikelyHallucination('시청해 주셔서 감사합니다')).toBe(true)
    expect(isLikelyHallucination('구독과 좋아요')).toBe(true)
    expect(isLikelyHallucination('MBC 뉴스')).toBe(true)
    expect(isLikelyHallucination('[음악]')).toBe(true)
    expect(isLikelyHallucination('[박수]')).toBe(true)
  })

  it('covers the two single-token artefacts a naive filter would miss', () => {
    // Whisper emits a bare "you" and a bare "." for near-silence more than any other artefact.
    expect(isLikelyHallucination('you')).toBe(true)
    expect(isLikelyHallucination('You')).toBe(true)
    expect(isLikelyHallucination('.')).toBe(true)
  })
})

describe('isLikelyHallucination — empty and whitespace', () => {
  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
    ['mixed whitespace', ' \t\n\r '],
  ])('rejects %s', (_label, text) => {
    expect(isLikelyHallucination(text)).toBe(true)
  })
})

describe('isLikelyHallucination — normalisation', () => {
  it('is case-insensitive', () => {
    expect(isLikelyHallucination('THANK YOU FOR WATCHING')).toBe(true)
    expect(isLikelyHallucination('Thank You For Watching')).toBe(true)
    expect(isLikelyHallucination('tHaNk YoU fOr WaTcHiNg')).toBe(true)
  })

  it('collapses runs of internal whitespace', () => {
    expect(isLikelyHallucination('thank   you  for     watching')).toBe(true)
    expect(isLikelyHallucination('please\tsubscribe')).toBe(true)
    expect(isLikelyHallucination('시청해   주셔서\n감사합니다')).toBe(true)
  })

  it('trims and normalises at the same time', () => {
    expect(isLikelyHallucination('\n  THANKS   FOR  WATCHING \t')).toBe(true)
  })

  it('does not strip punctuation, so a trailing full stop keeps real speech alive', () => {
    // "." alone is an artefact; a sentence that merely ends in one is speech.
    expect(isLikelyHallucination('Amen.')).toBe(false)
  })
})

describe('isLikelyHallucination — conservative by design', () => {
  it('keeps a real sentence that CONTAINS an artefact phrase', () => {
    expect(
      isLikelyHallucination('Before we begin, thank you for watching over one another this week.')
    ).toBe(false)
    expect(isLikelyHallucination('And so we please subscribe to a different hope entirely.')).toBe(
      false
    )
    expect(isLikelyHallucination('오늘 예배를 시청해 주셔서 감사합니다 라고 인사했습니다')).toBe(
      false
    )
  })

  it('keeps a sentence that merely starts or ends with an artefact phrase', () => {
    expect(isLikelyHallucination('thank you for watching and for praying with us')).toBe(false)
    expect(isLikelyHallucination('the closing words were please subscribe')).toBe(false)
  })

  it('keeps ordinary speech containing the word "you"', () => {
    expect(isLikelyHallucination('you are welcome here')).toBe(false)
    expect(isLikelyHallucination('and you')).toBe(false)
    expect(isLikelyHallucination('you.')).toBe(false)
  })

  it('keeps ordinary speech containing a bracketed marker', () => {
    expect(isLikelyHallucination('the [music] began after the reading')).toBe(false)
  })

  it('keeps liturgical repetition, which a repeat-collapsing filter would eat', () => {
    // docs/v2-notes/ASR_PIPELINE.md §3: rhema_v2 shipped a repeat-collapse that broke "holy holy
    // holy" and had to be fixed. Verger's filter does not collapse repeats at all, so short
    // liturgical runs pass untouched.
    expect(isLikelyHallucination('holy holy holy')).toBe(false)
    expect(isLikelyHallucination('할렐루야 할렐루야 할렐루야')).toBe(false)
  })
})

describe('isLikelyHallucination — 감사합니다 is speech, not an artefact', () => {
  /**
   * The single most important negative case in this file.
   *
   * Whisper does emit a bare "감사합니다" on silence — but a Korean pulpit says it constantly, to
   * open a prayer, to close a notice, to thank a reader. Filtering it would silently delete real
   * speech several times per service. It is therefore deliberately absent from
   * `HALLUCINATION_PHRASES`, and this test exists to stop a future contributor "fixing" that.
   */
  it('keeps a bare 감사합니다', () => {
    expect(isLikelyHallucination('감사합니다')).toBe(false)
    expect(isLikelyHallucination('  감사합니다  ')).toBe(false)
  })

  it('keeps 감사합니다 in a sentence', () => {
    expect(isLikelyHallucination('함께해 주셔서 감사합니다')).toBe(false)
  })

  it('is not in the artefact list', () => {
    expect(HALLUCINATION_PHRASES).not.toContain('감사합니다')
  })

  it('still rejects the longer YouTube-outro form it appears inside', () => {
    // The artefact is the whole outro sentence, not the polite word on its own.
    expect(isLikelyHallucination('시청해 주셔서 감사합니다')).toBe(true)
  })
})

describe('isLikelyHallucination — purity', () => {
  it('returns the same answer for the same input, every time', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(isLikelyHallucination('thanks for watching')).toBe(true)
      expect(isLikelyHallucination('the sermon continues')).toBe(false)
    }
  })

  it('does not mutate its input', () => {
    const text = '  Thank You For Watching  '
    isLikelyHallucination(text)
    expect(text).toBe('  Thank You For Watching  ')
  })

  it('accepts arbitrary long text without special-casing it', () => {
    const long = 'a sentence about the morning notices '.repeat(200)
    expect(isLikelyHallucination(long)).toBe(false)
  })
})
