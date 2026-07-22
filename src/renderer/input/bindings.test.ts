/**
 * The keymap store's contract.
 *
 * Most of these are negative properties, and the most important one is a single sentence: **a
 * destructive action can never be saved as a tap, or as a hold shorter than
 * `MIN_DESTRUCTIVE_HOLD_MS`.** That is rhema_v2's instant-clear-ESC regression, and the remap
 * screen is the obvious way to re-introduce it, so the refusal is asserted here at the storage
 * gate — including the assertion that *nothing was written*, because a rejected save that still
 * wrote would survive the restart and defeat the point.
 *
 * The merge test is the other one worth reading: it simulates a *later version* of Verger by
 * passing a defaults list containing an action the operator's stored map has never seen, and
 * asserts both halves — their customisation survives, the new action appears.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { KeyBinding } from '@shared/actions'
import {
  ActionId,
  DEFAULT_KEY_BINDINGS,
  DISABLE_AI_HOLD_MS,
  MIN_DESTRUCTIVE_HOLD_MS,
} from '@shared/actions'

import type { BindingStorage } from './bindings'
import {
  BINDINGS_STORAGE_KEY,
  DEFAULT_HOLD_MS,
  MAX_HOLD_MS,
  MIN_HOLD_MS,
  RejectionReason,
  applyCapture,
  bindingSignature,
  captureKey,
  findConflicts,
  formatChord,
  holdFloorFor,
  keyLabel,
  loadBindings,
  mergeWithDefaults,
  resetBindings,
  saveBindings,
  validateBinding,
  validateBindings,
  withGesture,
  withHoldMs,
} from './bindings'

/** An in-memory `Storage` that records what it was asked to do. */
class FakeStorage implements BindingStorage {
  readonly items = new Map<string, string>()
  readonly writes: { key: string; value: string }[] = []
  readonly removals: string[] = []
  /** Set to make every write throw, standing in for a quota or a blocked-site-data profile. */
  failWrites = false

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.writes.push({ key, value })
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    this.removals.push(key)
    this.items.delete(key)
  }
}

/** A tap binding for `action`, so each test states only what it is actually testing. */
function tap(action: ActionId, key: string): KeyBinding {
  return { action, key, gesture: 'tap' }
}

function hold(action: ActionId, key: string, holdMs: number): KeyBinding {
  return { action, key, gesture: 'hold', holdMs }
}

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
})

describe('capture', () => {
  it('records whatever key was pressed — which is how a pedal is bound', () => {
    // A foot pedal is a keyboard: the operator presses it and the browser reports a key. F13 is
    // the classic "programmable pedal" code precisely because no software uses it.
    expect(captureKey({ key: 'F13' })).toEqual({ key: 'F13' })
  })

  it('records the modifiers that were down, and omits the ones that were not', () => {
    const captured = captureKey({ key: 'Escape', shiftKey: true, ctrlKey: false })
    expect(captured).toEqual({ key: 'Escape', shift: true })
    expect(captured).not.toHaveProperty('ctrl')
  })

  it('ignores a bare modifier, so holding SHIFT on the way to a chord records nothing', () => {
    expect(captureKey({ key: 'Shift', shiftKey: true })).toBeNull()
    expect(captureKey({ key: 'Control', ctrlKey: true })).toBeNull()
    expect(captureKey({ key: '' })).toBeNull()
  })

  it('applies a capture without leaving a stale modifier behind', () => {
    const before: KeyBinding = { action: ActionId.logo, key: 'l', gesture: 'tap', shift: true }
    const after = applyCapture(before, { key: 'F14' })
    expect(after).toEqual({ action: ActionId.logo, key: 'F14', gesture: 'tap' })
    expect(after).not.toHaveProperty('shift')
  })

  it('preserves gesture, hold and param across a rebind', () => {
    const before: KeyBinding = { action: ActionId.cameraSelect, key: '1', gesture: 'tap', param: 'cam1' }
    expect(applyCapture(before, { key: 'F13' })).toEqual({
      action: ActionId.cameraSelect,
      key: 'F13',
      gesture: 'tap',
      param: 'cam1',
    })

    const destructive = hold(ActionId.clearAll, 'c', 2000)
    expect(applyCapture(destructive, { key: 'F15', ctrl: true })).toEqual({
      action: ActionId.clearAll,
      key: 'F15',
      gesture: 'hold',
      holdMs: 2000,
      ctrl: true,
    })
  })
})

describe('validation — the v2 regression guard', () => {
  it('refuses a destructive action bound to a tap, and says why', () => {
    const rejection = validateBinding(tap(ActionId.clearAll, 'c'))
    expect(rejection?.reason).toBe(RejectionReason.DESTRUCTIVE_TAP)
    expect(rejection?.message).toMatch(/must be a hold, never a tap/i)
  })

  it('refuses a destructive hold under the floor, and names the floor', () => {
    const rejection = validateBinding(hold(ActionId.black, 'b', MIN_DESTRUCTIVE_HOLD_MS - 1))
    expect(rejection?.reason).toBe(RejectionReason.DESTRUCTIVE_HOLD_TOO_SHORT)
    expect(rejection?.message).toContain(String(MIN_DESTRUCTIVE_HOLD_MS))
  })

  it('accepts a destructive hold exactly at the floor', () => {
    expect(validateBinding(hold(ActionId.black, 'b', MIN_DESTRUCTIVE_HOLD_MS))).toBeNull()
  })

  it('leaves non-destructive actions alone — disableAi is deliberately not destructive', () => {
    expect(validateBinding(hold(ActionId.disableAi, 'Escape', DISABLE_AI_HOLD_MS))).toBeNull()
    expect(validateBinding(tap(ActionId.advance, ' '))).toBeNull()
  })

  it('refuses a hold with no duration, an absurd duration, or a bare modifier key', () => {
    expect(validateBinding({ action: ActionId.logo, key: 'l', gesture: 'hold' })?.reason).toBe(
      RejectionReason.BAD_HOLD_MS,
    )
    expect(validateBinding(hold(ActionId.logo, 'l', MAX_HOLD_MS + 1))?.reason).toBe(
      RejectionReason.BAD_HOLD_MS,
    )
    expect(validateBinding(hold(ActionId.logo, 'l', 10))?.reason).toBe(RejectionReason.BAD_HOLD_MS)
    expect(validateBinding(tap(ActionId.logo, 'Shift'))?.reason).toBe(RejectionReason.EMPTY_KEY)
    expect(validateBinding(tap(ActionId.logo, ''))?.reason).toBe(RejectionReason.EMPTY_KEY)
  })

  it('refuses an action that does not exist', () => {
    const rogue = { action: 'output.nuke', key: 'x', gesture: 'tap' } as unknown as KeyBinding
    expect(validateBinding(rogue)?.reason).toBe(RejectionReason.UNKNOWN_ACTION)
  })

  it('passes the shipped defaults', () => {
    expect(validateBindings(DEFAULT_KEY_BINDINGS)).toEqual([])
  })
})

describe('conflicts', () => {
  it('reports two bindings on the same key, modifiers and gesture', () => {
    const conflicts = findConflicts([tap(ActionId.logo, 'l'), tap(ActionId.freeze, 'l')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.bindings.map((binding) => binding.action)).toEqual([
      ActionId.logo,
      ActionId.freeze,
    ])
  })

  it('does not report the same key used by two different gestures', () => {
    // SPACE tap = advance, SPACE hold = PANIC. This coexistence is the design, not a bug.
    expect(findConflicts([tap(ActionId.advance, ' '), hold(ActionId.panic, ' ', 3000)])).toEqual([])
  })

  it('does not report the same key qualified by different modifiers', () => {
    expect(
      findConflicts([
        tap(ActionId.logo, 'l'),
        { action: ActionId.freeze, key: 'l', gesture: 'tap', shift: true },
      ]),
    ).toEqual([])
  })

  it('treats B and b as the same key, exactly as the dispatcher does', () => {
    const conflicts = findConflicts([tap(ActionId.logo, 'b'), tap(ActionId.freeze, 'B')])
    expect(conflicts).toHaveLength(1)
  })

  it('finds none in the shipped defaults', () => {
    expect(findConflicts(DEFAULT_KEY_BINDINGS)).toEqual([])
  })

  it('signs a chord by key, modifiers and gesture', () => {
    expect(bindingSignature({ action: ActionId.logo, key: 'L', gesture: 'tap', shift: true })).toBe(
      'shift+l/tap',
    )
  })
})

describe('merge', () => {
  /** A pretend later version: everything shipped today, plus one action nobody has bound yet. */
  const laterDefaults: readonly KeyBinding[] = [
    ...DEFAULT_KEY_BINDINGS,
    hold(ActionId.clearAll, 'x', MIN_DESTRUCTIVE_HOLD_MS),
  ]

  it('keeps a user binding and adds an action introduced after they saved', () => {
    const stored: readonly KeyBinding[] = [tap(ActionId.advance, 'F13')]

    const merged = mergeWithDefaults(stored, laterDefaults)

    expect(merged.filter((binding) => binding.action === ActionId.advance)).toEqual([
      tap(ActionId.advance, 'F13'),
    ])
    expect(merged.find((binding) => binding.action === ActionId.clearAll)).toEqual(
      hold(ActionId.clearAll, 'x', MIN_DESTRUCTIVE_HOLD_MS),
    )
    // And everything else the operator never touched is still there.
    expect(merged.find((binding) => binding.action === ActionId.freeze)).toEqual(
      DEFAULT_KEY_BINDINGS.find((binding) => binding.action === ActionId.freeze),
    )
  })

  it('keeps every camera slot distinct, because identity is action + param', () => {
    const stored: readonly KeyBinding[] = [
      { action: ActionId.cameraSelect, key: 'F1', gesture: 'tap', param: 'wide' },
    ]

    const merged = mergeWithDefaults(stored)
    const cameras = merged.filter((binding) => binding.action === ActionId.cameraSelect)

    expect(cameras).toHaveLength(4)
    expect(cameras.find((binding) => binding.param === 'wide')?.key).toBe('F1')
    expect(cameras.find((binding) => binding.param === 'cam1')?.key).toBe('1')
  })

  it('keeps two user bindings for one action — pedal and keyboard together', () => {
    const stored: readonly KeyBinding[] = [tap(ActionId.advance, ' '), tap(ActionId.advance, 'F13')]
    const merged = mergeWithDefaults(stored)
    expect(merged.filter((binding) => binding.action === ActionId.advance)).toHaveLength(2)
  })

  it('drops a stored binding for an action the current version no longer has', () => {
    const merged = mergeWithDefaults([tap(ActionId.freeze, 'f')], [tap(ActionId.advance, ' ')])
    expect(merged).toEqual([tap(ActionId.advance, ' ')])
  })
})

describe('load', () => {
  it('returns the defaults when nothing has ever been saved', () => {
    expect(loadBindings(storage)).toEqual({ bindings: DEFAULT_KEY_BINDINGS, repaired: false })
  })

  it('returns the defaults when there is no storage at all', () => {
    expect(loadBindings(null).bindings).toEqual(DEFAULT_KEY_BINDINGS)
  })

  it('merges a stored map over the defaults', () => {
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify([tap(ActionId.advance, 'F13')]))

    const loaded = loadBindings(storage)

    expect(loaded.repaired).toBe(false)
    expect(loaded.bindings.find((binding) => binding.action === ActionId.advance)?.key).toBe('F13')
    expect(loaded.bindings).toHaveLength(DEFAULT_KEY_BINDINGS.length)
  })

  it('falls back to the defaults on unparseable JSON rather than leaving the booth keyless', () => {
    storage.setItem(BINDINGS_STORAGE_KEY, '{not json')
    expect(loadBindings(storage)).toEqual({ bindings: DEFAULT_KEY_BINDINGS, repaired: true })
  })

  it('discards a hand-edited unsafe binding and restores its default', () => {
    // Someone edited localStorage by hand and made `black` a tap. It must not come back.
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify([tap(ActionId.black, 'b')]))

    const loaded = loadBindings(storage)
    const black = loaded.bindings.find((binding) => binding.action === ActionId.black)

    expect(loaded.repaired).toBe(true)
    expect(black?.gesture).toBe('hold')
    expect(black?.holdMs).toBeGreaterThanOrEqual(MIN_DESTRUCTIVE_HOLD_MS)
  })

  it('survives a storage that throws on read', () => {
    const hostile: BindingStorage = {
      getItem() {
        throw new Error('site data blocked')
      },
      setItem() {},
      removeItem() {},
    }
    expect(loadBindings(hostile)).toEqual({ bindings: DEFAULT_KEY_BINDINGS, repaired: true })
  })
})

describe('save', () => {
  it('writes a valid map and reports its conflicts', () => {
    const map = [tap(ActionId.advance, 'F13'), tap(ActionId.back, 'F14')]

    const result = saveBindings(map, storage)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a successful save')
    expect(result.value.conflicts).toEqual([])
    expect(JSON.parse(storage.items.get(BINDINGS_STORAGE_KEY) ?? 'null')).toEqual(map)
  })

  it('refuses a destructive tap AND writes nothing', () => {
    const result = saveBindings([tap(ActionId.clearAll, 'c')], storage)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the save to be refused')
    expect(result.error.code).toBe('INVALID_ARG')
    expect(result.error.message).toMatch(/must be a hold, never a tap/i)
    expect(result.error.detail).toContain(RejectionReason.DESTRUCTIVE_TAP)
    // The whole point: a refused save leaves storage untouched, so a restart cannot resurrect it.
    expect(storage.writes).toEqual([])
    expect(storage.items.has(BINDINGS_STORAGE_KEY)).toBe(false)
  })

  it('refuses a destructive hold under the floor and writes nothing', () => {
    const result = saveBindings([hold(ActionId.black, 'b', 500)], storage)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the save to be refused')
    expect(result.error.detail).toContain(RejectionReason.DESTRUCTIVE_HOLD_TOO_SHORT)
    expect(storage.writes).toEqual([])
  })

  it('saves a conflicting map but reports the conflict', () => {
    const result = saveBindings([tap(ActionId.logo, 'l'), tap(ActionId.freeze, 'l')], storage)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a successful save')
    expect(result.value.conflicts).toHaveLength(1)
  })

  it('returns an IO error instead of throwing when the write fails', () => {
    storage.failWrites = true
    const result = saveBindings([tap(ActionId.advance, ' ')], storage)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the save to fail')
    expect(result.error.code).toBe('IO_ERROR')
  })

  it('returns an IO error when there is no storage', () => {
    const result = saveBindings([tap(ActionId.advance, ' ')], null)
    expect(result.ok).toBe(false)
  })
})

describe('reset', () => {
  it('forgets the stored map and hands back the defaults', () => {
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify([tap(ActionId.advance, 'F13')]))

    expect(resetBindings(storage)).toEqual(DEFAULT_KEY_BINDINGS)

    expect(storage.removals).toEqual([BINDINGS_STORAGE_KEY])
    expect(loadBindings(storage).bindings).toEqual(DEFAULT_KEY_BINDINGS)
  })
})

describe('gesture and hold editing', () => {
  it('lands a destructive action on the safety floor when switched to a hold', () => {
    const switched = withGesture(tap(ActionId.clearAll, 'c'), 'hold')
    expect(switched.holdMs).toBe(MIN_DESTRUCTIVE_HOLD_MS)
    expect(validateBinding(switched)).toBeNull()
  })

  it('gives a non-destructive action the ordinary default hold', () => {
    expect(withGesture(tap(ActionId.logo, 'l'), 'hold').holdMs).toBe(DEFAULT_HOLD_MS)
  })

  it('drops holdMs entirely when switched to a tap', () => {
    const switched = withGesture(hold(ActionId.logo, 'l', 1000), 'tap')
    expect(switched).not.toHaveProperty('holdMs')
  })

  it('clamps an edited hold to the action floor and to the ceiling', () => {
    expect(withHoldMs(hold(ActionId.black, 'b', 2000), 100).holdMs).toBe(MIN_DESTRUCTIVE_HOLD_MS)
    expect(withHoldMs(hold(ActionId.logo, 'l', 1000), 10).holdMs).toBe(MIN_HOLD_MS)
    expect(withHoldMs(hold(ActionId.logo, 'l', 1000), 99_999).holdMs).toBe(MAX_HOLD_MS)
    expect(withHoldMs(tap(ActionId.logo, 'l'), 2000)).not.toHaveProperty('holdMs')
  })

  it('knows which floor applies to which action', () => {
    expect(holdFloorFor(ActionId.black)).toBe(MIN_DESTRUCTIVE_HOLD_MS)
    expect(holdFloorFor(ActionId.clearAll)).toBe(MIN_DESTRUCTIVE_HOLD_MS)
    expect(holdFloorFor(ActionId.disableAi)).toBe(MIN_HOLD_MS)
  })
})

describe('labels for the printed card', () => {
  it('names keys an operator can read on paper', () => {
    expect(keyLabel(' ')).toBe('Space')
    expect(keyLabel('Escape')).toBe('Esc')
    expect(keyLabel('b')).toBe('B')
    expect(keyLabel('F13')).toBe('F13')
  })

  it('formats a chord in a fixed modifier order', () => {
    expect(formatChord({ action: ActionId.logo, key: 'l', gesture: 'tap' })).toBe('L')
    expect(
      formatChord({
        action: ActionId.lowerThirdDismiss,
        key: 'Escape',
        gesture: 'tap',
        shift: true,
      }),
    ).toBe('Shift + Esc')
    expect(
      formatChord({ action: ActionId.logo, key: 'l', gesture: 'tap', ctrl: true, alt: true, shift: true }),
    ).toBe('Ctrl + Alt + Shift + L')
  })
})
