/**
 * Windowing is load-bearing, not cosmetic.
 *
 * `caption.show`'s schema REJECTS text longer than {@link CAPTION_MAX_CHARS} rather than
 * truncating it, so a driver that fails to window does not produce a clipped caption — it produces
 * no caption at all, silently, from the first long sentence of the sermon onward. These tests pin
 * the boundary exactly.
 *
 * Fixtures are invented placeholder words. Standing Rule 4: no real sermon text, verse text or
 * lyrics in this repo, including in tests.
 */

import { describe, expect, it } from 'vitest'

import {
  CAPTION_IDLE_HIDE_MS,
  CAPTION_MAX_CHARS,
  idleCaptionState,
  windowCaptionText,
} from './caption'
import { overlayCommandPayloadSchemas } from './overlay'

/** `count` space-separated 5-character words, so length is predictable. */
function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${String(i % 10)}rd${String(i % 10)}`).join(' ')
}

describe('the resting caption state', () => {
  it('is off, finals-only and empty', () => {
    // Standing Rule 1: unreviewed machine output must never be on screen because of a default.
    expect(idleCaptionState()).toEqual({ enabled: false, showDrafts: false, lastText: '' })
  })

  it('returns a fresh object each time, so a caller cannot mutate the default', () => {
    expect(idleCaptionState()).not.toBe(idleCaptionState())
  })
})

describe('windowCaptionText', () => {
  it('leaves text that already fits completely alone', () => {
    expect(windowCaptionText('PLACEHOLDER SPEECH ONE')).toBe('PLACEHOLDER SPEECH ONE')
  })

  it('collapses runs of whitespace and trims, so layout cannot be broken by the recogniser', () => {
    expect(windowCaptionText('  PLACEHOLDER   SPEECH \n ONE  ')).toBe('PLACEHOLDER SPEECH ONE')
  })

  it('treats empty and whitespace-only input as nothing worth showing', () => {
    expect(windowCaptionText('')).toBe('')
    expect(windowCaptionText('   \n\t ')).toBe('')
  })

  it('never returns more than the cap, for input far over it', () => {
    const long = words(400)
    expect(long.length).toBeGreaterThan(CAPTION_MAX_CHARS * 2)
    expect(windowCaptionText(long).length).toBeLessThanOrEqual(CAPTION_MAX_CHARS)
  })

  it('accepts exactly the cap unchanged, and windows one character over it', () => {
    const exact = 'x'.repeat(CAPTION_MAX_CHARS)
    expect(windowCaptionText(exact)).toBe(exact)
    expect(windowCaptionText('x'.repeat(CAPTION_MAX_CHARS + 1)).length).toBe(CAPTION_MAX_CHARS)
  })

  it('keeps the END of the utterance, because a caption reads out what is being said now', () => {
    const windowed = windowCaptionText(`${'x'.repeat(CAPTION_MAX_CHARS)} PLACEHOLDER TAIL`)
    expect(windowed.endsWith('PLACEHOLDER TAIL')).toBe(true)
    expect(windowed.length).toBe(CAPTION_MAX_CHARS)
    // Trimmed from the FRONT: fewer leading x's survived than were sent. (Note the cut here is
    // deliberately hard rather than at the word boundary — the only boundary sits 383 characters
    // in, and honouring it would discard almost the whole window. See the next test.)
    expect((windowed.match(/x/g) ?? []).length).toBeLessThan(CAPTION_MAX_CHARS)
  })

  it('does NOT sacrifice most of the window to tidy the edge', () => {
    // One enormous unbroken token followed by a short tail: honouring the only boundary would
    // throw away nearly everything, so the cut stays hard and the reader still gets the text.
    const windowed = windowCaptionText(`${'x'.repeat(CAPTION_MAX_CHARS * 2)} tail`)
    expect(windowed.length).toBeGreaterThan(Math.floor(CAPTION_MAX_CHARS / 2))
  })

  it('never returns text that starts or ends with whitespace', () => {
    // Regression. An earlier version guarded the boundary with `> 0` instead of `>= 0`, so a cut
    // landing exactly ON a space skipped the boundary branch and returned the tail verbatim —
    // leading space included, which renders as an indent on the congregation screen. A cut landing
    // on a space is the ordinary case, not an edge case.
    for (const count of [30, 60, 61, 120, 200]) {
      const windowed = windowCaptionText(words(count))
      expect(windowed).toBe(windowed.trim())
      expect(windowed.startsWith(' ')).toBe(false)
    }
  })

  it('honours a caller-supplied cap', () => {
    expect(windowCaptionText(words(50), 20).length).toBeLessThanOrEqual(20)
  })

  it('produces text the overlay protocol will actually accept', () => {
    // The real coupling: whatever comes out of here must survive `caption.show`'s schema, which is
    // what makes an over-length utterance a non-event rather than a silent outage.
    const schema = overlayCommandPayloadSchemas['caption.show']
    for (const input of [words(500), 'x'.repeat(5000), words(3)]) {
      expect(schema.safeParse({ text: windowCaptionText(input), draft: false }).success).toBe(true)
    }
  })

  it('is the same cap the protocol enforces', () => {
    // Drift guard: if one moves without the other, long captions vanish in production while every
    // unit test still passes.
    const schema = overlayCommandPayloadSchemas['caption.show']
    expect(schema.safeParse({ text: 'x'.repeat(CAPTION_MAX_CHARS) }).success).toBe(true)
    expect(schema.safeParse({ text: 'x'.repeat(CAPTION_MAX_CHARS + 1) }).success).toBe(false)
  })
})

describe('the idle-hide delay', () => {
  it('is long enough to read a line and short enough not to become furniture', () => {
    expect(CAPTION_IDLE_HIDE_MS).toBeGreaterThanOrEqual(3_000)
    expect(CAPTION_IDLE_HIDE_MS).toBeLessThanOrEqual(15_000)
  })
})
