/**
 * The independence guarantee, expressed as an executable assertion.
 *
 * BLUEPRINT.md §6 and `CLAUDE.md`'s architecture invariants both say the same thing: **layers
 * are independent — changing one never disturbs another.** `applyOverlayCommand` is the single
 * place overlay state changes, and it is pure, so that claim is not a matter of discipline. It
 * is checkable here, once, for every command.
 *
 * For every command this file asserts that the layers the command does not target come out
 * **referentially identical** (`toBe`, not `toEqual`). Referential identity is the strong form:
 * it proves the reducer did not even rebuild the untargeted layer objects, so there is no path
 * by which a lower-third could perturb the scripture panel.
 *
 * The fixture maps below are keyed by `OverlayCommandName` and cross-checked against
 * `OVERLAY_COMMANDS` in the first test, so adding a command to the protocol without extending
 * this coverage fails rather than silently going untested.
 *
 * Standing Rule 4: no Bible verse text is authored anywhere in this repo, including fixtures.
 * `text` below is an obvious placeholder, exactly as it would be at runtime before a licensed
 * API or a verified public-domain translation supplies the real value. Caption fixtures are
 * likewise invented strings, never transcribed speech.
 */

import { describe, expect, it } from 'vitest'

import {
  LOWER_THIRD_TEMPLATES,
  OVERLAY_COMMANDS,
  OVERLAY_LAYERS,
  applyOverlayCommand,
  emptyOverlayState,
  overlayCommandSchema
} from '@shared/overlay'
import type { OverlayCommand, OverlayCommandName, OverlayState } from '@shared/overlay'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every layer populated and visible, so a leak between layers has something to destroy. */
function populatedState(): OverlayState {
  return {
    lowerThird: { visible: true, line1: 'PRESENTER NAME', line2: 'ROLE', template: 'boxed' },
    scripture: {
      visible: true,
      reference: 'REFERENCE PLACEHOLDER',
      text: 'VERSE TEXT PLACEHOLDER',
      translation: 'TRANSLATION PLACEHOLDER',
      attribution: 'ATTRIBUTION PLACEHOLDER'
    },
    slide: { visible: true, src: 'slides/placeholder.png' },
    caption: { visible: true, text: 'PLACEHOLDER SPEECH ONE', draft: true },
    revision: 7
  }
}

/** One representative, fully-specified command per name. */
const COMMANDS: { readonly [N in OverlayCommandName]: OverlayCommand } = {
  'lowerThird.show': {
    channel: 'command',
    name: 'lowerThird.show',
    payload: { line1: 'NEW NAME', line2: 'NEW ROLE', template: 'minimal' }
  },
  'lowerThird.hide': { channel: 'command', name: 'lowerThird.hide', payload: {} },
  'scripture.show': {
    channel: 'command',
    name: 'scripture.show',
    payload: {
      reference: 'NEW REFERENCE PLACEHOLDER',
      text: 'VERSE TEXT PLACEHOLDER',
      translation: 'TRANSLATION PLACEHOLDER',
      attribution: null
    }
  },
  'scripture.hide': { channel: 'command', name: 'scripture.hide', payload: {} },
  'slide.show': { channel: 'command', name: 'slide.show', payload: { src: 'slides/next.png' } },
  'slide.hide': { channel: 'command', name: 'slide.hide', payload: {} },
  'caption.show': {
    channel: 'command',
    name: 'caption.show',
    payload: { text: 'PLACEHOLDER SPEECH TWO', draft: false }
  },
  'caption.hide': { channel: 'command', name: 'caption.hide', payload: {} },
  clearAll: { channel: 'command', name: 'clearAll', payload: {} }
}

/** Which layer each command owns. `clearAll` owns all of them, by design. */
const TARGET_LAYER: {
  readonly [N in OverlayCommandName]: 'lowerThird' | 'scripture' | 'slide' | 'caption' | 'all'
} = {
  'lowerThird.show': 'lowerThird',
  'lowerThird.hide': 'lowerThird',
  'scripture.show': 'scripture',
  'scripture.hide': 'scripture',
  'slide.show': 'slide',
  'slide.hide': 'slide',
  'caption.show': 'caption',
  'caption.hide': 'caption',
  clearAll: 'all'
}

// ---------------------------------------------------------------------------
// Independence — the point of the whole phase
// ---------------------------------------------------------------------------

describe('applyOverlayCommand — layer independence', () => {
  it('covers every declared command with a fixture', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...OVERLAY_COMMANDS].sort())
    expect(Object.keys(TARGET_LAYER).sort()).toEqual([...OVERLAY_COMMANDS].sort())
  })

  for (const name of OVERLAY_COMMANDS) {
    const target = TARGET_LAYER[name]
    if (target === 'all') continue

    const untouched = OVERLAY_LAYERS.filter((layer) => layer !== target)

    it(`'${name}' leaves ${untouched.join(' and ')} referentially unchanged`, () => {
      const before = populatedState()
      const after = applyOverlayCommand(before, COMMANDS[name])

      for (const layer of untouched) {
        // Referential identity: the reducer did not rebuild the object at all.
        expect(after[layer]).toBe(before[layer])
        // And deep equality, so a future refactor to structural copies still fails loudly
        // if a VALUE changed rather than merely the identity.
        expect(after[layer]).toEqual(before[layer])
      }

      // The targeted layer really did change, otherwise the assertions above are vacuous.
      expect(after[target]).not.toBe(before[target])
    })

    it(`'${name}' does not mutate the input state`, () => {
      const before = populatedState()
      const snapshot = structuredClone(before)
      applyOverlayCommand(before, COMMANDS[name])
      expect(before).toEqual(snapshot)
    })
  }

  it('a lowerThird show/hide cycle never perturbs scripture or slide', () => {
    const start = populatedState()
    const shown = applyOverlayCommand(start, COMMANDS['lowerThird.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['lowerThird.hide'])
    const reshown = applyOverlayCommand(hidden, COMMANDS['lowerThird.show'])

    for (const state of [shown, hidden, reshown]) {
      expect(state.scripture).toBe(start.scripture)
      expect(state.slide).toBe(start.slide)
    }
  })

  it('a slide show/hide cycle never perturbs lowerThird or scripture', () => {
    const start = populatedState()
    const shown = applyOverlayCommand(start, COMMANDS['slide.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['slide.hide'])

    for (const state of [shown, hidden]) {
      expect(state.lowerThird).toBe(start.lowerThird)
      expect(state.scripture).toBe(start.scripture)
    }
  })

  it('a scripture show/hide cycle never perturbs lowerThird or slide', () => {
    const start = populatedState()
    const shown = applyOverlayCommand(start, COMMANDS['scripture.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['scripture.hide'])

    for (const state of [shown, hidden]) {
      expect(state.lowerThird).toBe(start.lowerThird)
      expect(state.slide).toBe(start.slide)
    }
  })

  it('a rapid caption stream never perturbs the other three layers', () => {
    // ASR drives this layer at partial-result rate, so it is the one layer that can issue
    // hundreds of commands during a single sermon. If a leak between layers existed anywhere,
    // this is the traffic that would find it.
    let state = populatedState()
    const start = state

    for (let i = 0; i < 50; i += 1) {
      state = applyOverlayCommand(state, {
        channel: 'command',
        name: 'caption.show',
        payload: { text: `PLACEHOLDER SPEECH ${i}`, draft: i % 2 === 0 }
      })
      expect(state.lowerThird).toBe(start.lowerThird)
      expect(state.scripture).toBe(start.scripture)
      expect(state.slide).toBe(start.slide)
    }

    const hidden = applyOverlayCommand(state, COMMANDS['caption.hide'])
    expect(hidden.lowerThird).toBe(start.lowerThird)
    expect(hidden.scripture).toBe(start.scripture)
    expect(hidden.slide).toBe(start.slide)
  })
})

// ---------------------------------------------------------------------------
// Revision
// ---------------------------------------------------------------------------

describe('applyOverlayCommand — revision', () => {
  for (const name of OVERLAY_COMMANDS) {
    it(`'${name}' increments revision by exactly one`, () => {
      const before = populatedState()
      const after = applyOverlayCommand(before, COMMANDS[name])
      expect(after.revision).toBe(before.revision + 1)
    })
  }

  it('increments on a hide that changes nothing observable', () => {
    // Already hidden. The layer is unchanged in substance, but the revision still moves, so the
    // overlay's `applied` echo can never look "caught up" when it is not.
    const hiddenAlready = applyOverlayCommand(emptyOverlayState(), COMMANDS['lowerThird.hide'])
    expect(hiddenAlready.revision).toBe(1)
    expect(hiddenAlready.lowerThird.visible).toBe(false)

    const again = applyOverlayCommand(hiddenAlready, COMMANDS['lowerThird.hide'])
    expect(again.revision).toBe(2)
    expect(again.lowerThird.visible).toBe(false)
  })

  it('increments on a repeated identical show', () => {
    const once = applyOverlayCommand(emptyOverlayState(), COMMANDS['lowerThird.show'])
    const twice = applyOverlayCommand(once, COMMANDS['lowerThird.show'])
    expect(once.revision).toBe(1)
    expect(twice.revision).toBe(2)
    expect(twice.lowerThird).toEqual(once.lowerThird)
  })

  it('advances monotonically across a long mixed sequence', () => {
    let state = emptyOverlayState()
    let expected = 0
    for (let round = 0; round < 3; round += 1) {
      for (const name of OVERLAY_COMMANDS) {
        state = applyOverlayCommand(state, COMMANDS[name])
        expected += 1
        expect(state.revision).toBe(expected)
      }
    }
    expect(state.revision).toBe(OVERLAY_COMMANDS.length * 3)
  })
})

// ---------------------------------------------------------------------------
// Per-command behaviour
// ---------------------------------------------------------------------------

describe('applyOverlayCommand — lowerThird', () => {
  it('show sets every field and makes the layer visible', () => {
    const state = applyOverlayCommand(emptyOverlayState(), COMMANDS['lowerThird.show'])
    expect(state.lowerThird).toEqual({
      visible: true,
      line1: 'NEW NAME',
      line2: 'NEW ROLE',
      template: 'minimal'
    })
  })

  it('hide clears visibility but retains the text, so a re-show is instant', () => {
    const shown = applyOverlayCommand(emptyOverlayState(), COMMANDS['lowerThird.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['lowerThird.hide'])
    expect(hidden.lowerThird.visible).toBe(false)
    expect(hidden.lowerThird.line1).toBe('NEW NAME')
    expect(hidden.lowerThird.line2).toBe('NEW ROLE')
    expect(hidden.lowerThird.template).toBe('minimal')
  })

  it('accepts every declared template', () => {
    for (const template of LOWER_THIRD_TEMPLATES) {
      const state = applyOverlayCommand(emptyOverlayState(), {
        channel: 'command',
        name: 'lowerThird.show',
        payload: { line1: 'NAME', line2: '', template }
      })
      expect(state.lowerThird.template).toBe(template)
    }
  })
})

describe('applyOverlayCommand — scripture', () => {
  it('show carries reference, text, translation and attribution through verbatim', () => {
    const state = applyOverlayCommand(emptyOverlayState(), {
      channel: 'command',
      name: 'scripture.show',
      payload: {
        reference: 'REFERENCE PLACEHOLDER',
        text: 'VERSE TEXT PLACEHOLDER',
        translation: 'TRANSLATION PLACEHOLDER',
        attribution: 'ATTRIBUTION PLACEHOLDER'
      }
    })
    expect(state.scripture).toEqual({
      visible: true,
      reference: 'REFERENCE PLACEHOLDER',
      text: 'VERSE TEXT PLACEHOLDER',
      translation: 'TRANSLATION PLACEHOLDER',
      attribution: 'ATTRIBUTION PLACEHOLDER'
    })
  })

  it('hide retains the reference and text', () => {
    const shown = applyOverlayCommand(emptyOverlayState(), COMMANDS['scripture.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['scripture.hide'])
    expect(hidden.scripture.visible).toBe(false)
    expect(hidden.scripture.reference).toBe('NEW REFERENCE PLACEHOLDER')
    expect(hidden.scripture.text).toBe('VERSE TEXT PLACEHOLDER')
  })
})

describe('applyOverlayCommand — slide', () => {
  it('show sets the source and makes the layer visible', () => {
    const state = applyOverlayCommand(emptyOverlayState(), COMMANDS['slide.show'])
    expect(state.slide).toEqual({ visible: true, src: 'slides/next.png' })
  })

  it('hide retains the source', () => {
    const shown = applyOverlayCommand(emptyOverlayState(), COMMANDS['slide.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['slide.hide'])
    expect(hidden.slide).toEqual({ visible: false, src: 'slides/next.png' })
  })
})

describe('applyOverlayCommand — caption', () => {
  it('show sets visibility, text and draft from the payload', () => {
    const state = applyOverlayCommand(emptyOverlayState(), COMMANDS['caption.show'])
    expect(state.caption).toEqual({
      visible: true,
      text: 'PLACEHOLDER SPEECH TWO',
      draft: false
    })
  })

  it('show carries draft: true through, so the overlay can style a partial differently', () => {
    const state = applyOverlayCommand(emptyOverlayState(), {
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH THREE', draft: true }
    })
    expect(state.caption).toEqual({
      visible: true,
      text: 'PLACEHOLDER SPEECH THREE',
      draft: true
    })
  })

  it('a final replaces the draft it supersedes rather than accumulating', () => {
    const draft = applyOverlayCommand(emptyOverlayState(), {
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH PARTIAL', draft: true }
    })
    const final = applyOverlayCommand(draft, {
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH FINAL', draft: false }
    })
    expect(final.caption).toEqual({ visible: true, text: 'PLACEHOLDER SPEECH FINAL', draft: false })
  })

  it('hide clears visibility immediately while retaining the last text', () => {
    // Standing Rule 1: the operator's off switch HIDES the layer, it does not merely stop new
    // text. Retention is deliberate (see the reducer's `caption.hide` case) — the driver only
    // shows again once it has something new, so nothing stale can flash back on.
    const shown = applyOverlayCommand(emptyOverlayState(), COMMANDS['caption.show'])
    const hidden = applyOverlayCommand(shown, COMMANDS['caption.hide'])
    expect(hidden.caption.visible).toBe(false)
    expect(hidden.caption.text).toBe('PLACEHOLDER SPEECH TWO')
  })

  it('hide preserves the draft flag alongside the text', () => {
    const shown = applyOverlayCommand(emptyOverlayState(), {
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH FOUR', draft: true }
    })
    const hidden = applyOverlayCommand(shown, COMMANDS['caption.hide'])
    expect(hidden.caption).toEqual({
      visible: false,
      text: 'PLACEHOLDER SPEECH FOUR',
      draft: true
    })
  })

  it('hide on an already-hidden layer keeps it hidden', () => {
    // The off switch is spammable: a worried operator hitting it twice must not resurrect
    // anything.
    const once = applyOverlayCommand(populatedState(), COMMANDS['caption.hide'])
    const twice = applyOverlayCommand(once, COMMANDS['caption.hide'])
    expect(once.caption.visible).toBe(false)
    expect(twice.caption.visible).toBe(false)
    expect(twice.caption.text).toBe(once.caption.text)
  })
})

describe('applyOverlayCommand — clearAll', () => {
  it('resets every layer to the empty state but still bumps revision', () => {
    const before = populatedState()
    const after = applyOverlayCommand(before, COMMANDS.clearAll)
    const blank = emptyOverlayState()

    for (const layer of OVERLAY_LAYERS) {
      expect(after[layer]).toEqual(blank[layer])
    }
    expect(after.revision).toBe(before.revision + 1)
  })

  it('is idempotent in substance and never resets the revision counter', () => {
    const once = applyOverlayCommand(populatedState(), COMMANDS.clearAll)
    const twice = applyOverlayCommand(once, COMMANDS.clearAll)
    for (const layer of OVERLAY_LAYERS) {
      expect(twice[layer]).toEqual(once[layer])
    }
    expect(twice.revision).toBe(once.revision + 1)
  })
})

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe('overlayCommandSchema defaults, as seen by the reducer', () => {
  it("defaults line2 to '' and template to 'bar'", () => {
    const parsed = overlayCommandSchema.parse({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 'ONLY LINE ONE' }
    })
    const state = applyOverlayCommand(emptyOverlayState(), parsed)
    expect(state.lowerThird).toEqual({
      visible: true,
      line1: 'ONLY LINE ONE',
      line2: '',
      template: 'bar'
    })
  })

  it("defaults scripture translation to '' and attribution to null", () => {
    const parsed = overlayCommandSchema.parse({
      channel: 'command',
      name: 'scripture.show',
      payload: { reference: 'REFERENCE PLACEHOLDER', text: 'VERSE TEXT PLACEHOLDER' }
    })
    const state = applyOverlayCommand(emptyOverlayState(), parsed)
    expect(state.scripture.translation).toBe('')
    expect(state.scripture.attribution).toBeNull()
  })

  it('rejects an unknown template rather than silently defaulting it', () => {
    const parsed = overlayCommandSchema.safeParse({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 'NAME', template: 'neon-explosion' }
    })
    expect(parsed.success).toBe(false)
  })

  it('defaults caption draft to false, so an unmarked caption is treated as final', () => {
    const parsed = overlayCommandSchema.parse({
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH FIVE' }
    })
    const state = applyOverlayCommand(emptyOverlayState(), parsed)
    expect(state.caption.draft).toBe(false)
  })

  it('accepts a caption of exactly 400 characters', () => {
    const atCap = 'X'.repeat(400)
    const parsed = overlayCommandSchema.safeParse({
      channel: 'command',
      name: 'caption.show',
      payload: { text: atCap }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a caption of 401 characters rather than truncating it', () => {
    // The cap is a hard ceiling because an overflowing caption covers the person speaking. The
    // ASR driver windows long utterances down; the protocol refuses to carry a paragraph, and
    // refusing is safer than silently truncating mid-word on screen.
    const overCap = 'X'.repeat(401)
    const parsed = overlayCommandSchema.safeParse({
      channel: 'command',
      name: 'caption.show',
      payload: { text: overCap }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an empty caption, so the layer is never shown with nothing in it', () => {
    const parsed = overlayCommandSchema.safeParse({
      channel: 'command',
      name: 'caption.show',
      payload: { text: '' }
    })
    expect(parsed.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The blank starting state
// ---------------------------------------------------------------------------

describe('emptyOverlayState', () => {
  it('starts every layer hidden at revision 0', () => {
    const state = emptyOverlayState()
    expect(state.revision).toBe(0)
    for (const layer of OVERLAY_LAYERS) {
      expect(state[layer].visible).toBe(false)
    }
  })

  it('returns a fresh object each call, so one server cannot alias another', () => {
    expect(emptyOverlayState()).not.toBe(emptyOverlayState())
    expect(emptyOverlayState()).toEqual(emptyOverlayState())
  })
})
