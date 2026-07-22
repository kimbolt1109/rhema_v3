/**
 * The safety-critical half of Phase 3, asserted key by key.
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6: rhema_v2 shipped plain ESC as an instant
 * clear-everything and had to walk it back. Every test below exists so a refactor cannot quietly
 * re-merge "hand control back to the operator" with "destroy something visible".
 *
 * Fake timers and an injected clock throughout — a suite that actually waits three seconds for a
 * PANIC is a suite nobody runs.
 */

import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DispatchedAction, KeyBinding } from '@shared/actions'
import {
  ActionId,
  DEFAULT_KEY_BINDINGS,
  DISABLE_AI_HOLD_MS,
  MAX_TAP_MS,
  MIN_DESTRUCTIVE_HOLD_MS,
  PANIC_HOLD_MS,
  isSafeBinding,
} from '@shared/actions'
import type { LogFields } from '@shared/log'

import { createActionDispatcher } from './ActionDispatcher'
import type { KeyboardTimers } from './useKeyboardActions'
import { useKeyboardActions } from './useKeyboardActions'

type LogFn = (message: string, fields?: LogFields) => void

/** Test clock, advanced in lockstep with the fake timers by {@link advance}. */
let clockMs = 0

/** Proves the injection point: the hook schedules holds through these, not through `window`. */
const timers: KeyboardTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle)
  },
}

function advance(ms: number): void {
  clockMs += ms
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

interface Harness {
  readonly fired: DispatchedAction[]
  readonly unmount: () => void
}

function mount(overrides: { bindings?: readonly KeyBinding[]; enabled?: boolean } = {}): Harness {
  const fired: DispatchedAction[] = []
  const dispatcher = createActionDispatcher({
    now: () => clockMs,
    logger: { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() },
  })
  dispatcher.subscribe((dispatched) => fired.push(dispatched))

  const { unmount } = renderHook(() =>
    useKeyboardActions({
      dispatcher,
      now: () => clockMs,
      timers,
      ...overrides,
    }),
  )

  return { fired, unmount }
}

function keyDown(key: string, init: KeyboardEventInit = {}, target: Element | Window = window): void {
  act(() => {
    fireEvent.keyDown(target, { key, ...init })
  })
}

function keyUp(key: string, init: KeyboardEventInit = {}, target: Element | Window = window): void {
  act(() => {
    fireEvent.keyUp(target, { key, ...init })
  })
}

/** The actions fired so far, in order. */
function actions(harness: Harness): string[] {
  return harness.fired.map((entry) => entry.action)
}

describe('useKeyboardActions', () => {
  beforeEach(() => {
    clockMs = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('SPACE — advance on tap, PANIC on hold, on one physical key', () => {
    it('fires advance on a tap, and never panic', () => {
      const harness = mount()

      keyDown(' ')
      advance(120)
      keyUp(' ')

      expect(actions(harness)).toEqual([ActionId.advance])
      expect(harness.fired[0]?.source).toBe('keyboard')

      // Nothing may arrive later either: the hold timer must be dead.
      advance(PANIC_HOLD_MS * 2)
      expect(actions(harness)).toEqual([ActionId.advance])
    })

    it('fires panic the moment the hold elapses, while the key is still down', () => {
      const harness = mount()

      keyDown(' ')
      advance(PANIC_HOLD_MS - 1)
      expect(actions(harness)).toEqual([])

      advance(1)
      // Feedback at the moment of commitment, not on release.
      expect(actions(harness)).toEqual([ActionId.panic])
    })

    it('does not also fire advance when the panic hold is released', () => {
      const harness = mount()

      keyDown(' ')
      advance(PANIC_HOLD_MS + 500)
      keyUp(' ')
      advance(5000)

      expect(actions(harness)).toEqual([ActionId.panic])
    })

    it('fires nothing when SPACE is held past a tap but released before the hold', () => {
      const harness = mount()

      keyDown(' ')
      advance(MAX_TAP_MS + 1)
      keyUp(' ')
      advance(5000)

      // Deliberate: too long to be a tap, too short to be a hold, so it is neither.
      expect(actions(harness)).toEqual([])
    })

    it('can be tapped repeatedly, once per press', () => {
      const harness = mount()

      for (let i = 0; i < 3; i += 1) {
        keyDown(' ')
        advance(100)
        keyUp(' ')
        advance(50)
      }

      expect(actions(harness)).toEqual([ActionId.advance, ActionId.advance, ActionId.advance])
    })
  })

  describe('ESC — non-destructive hand-back-control, and nothing at all on a tap', () => {
    it('fires nothing when ESC is tapped', () => {
      const harness = mount()

      keyDown('Escape')
      advance(80)
      keyUp('Escape')
      advance(5000)

      expect(actions(harness)).toEqual([])
    })

    it('fires disableAi — and only disableAi — after a 2s hold', () => {
      const harness = mount()

      keyDown('Escape')
      advance(DISABLE_AI_HOLD_MS - 1)
      expect(actions(harness)).toEqual([])

      advance(1)
      expect(actions(harness)).toEqual([ActionId.disableAi])

      keyUp('Escape')
      advance(5000)
      // Never clearAll, never black: hand-back-control is non-destructive by construction.
      expect(actions(harness)).toEqual([ActionId.disableAi])
    })

    it('fires lowerThirdDismiss on SHIFT+ESC, and never disableAi', () => {
      const harness = mount()

      keyDown('Escape', { shiftKey: true })
      advance(100)
      keyUp('Escape', { shiftKey: true })

      expect(actions(harness)).toEqual([ActionId.lowerThirdDismiss])
    })

    it('does not let the unmodified ESC hold shadow SHIFT+ESC', () => {
      const harness = mount()

      // Holding SHIFT+ESC well past the ESC hold threshold must NOT disable the AI: the
      // modifier-qualified binding is a tap binding and the two are different bindings.
      keyDown('Escape', { shiftKey: true })
      advance(DISABLE_AI_HOLD_MS + 500)
      expect(actions(harness)).toEqual([])

      keyUp('Escape', { shiftKey: true })
      expect(actions(harness)).toEqual([])
    })
  })

  describe('the rest of the default map', () => {
    it('requires a hold for BLACK and fires nothing on a tap', () => {
      const harness = mount()

      keyDown('b')
      advance(100)
      keyUp('b')
      advance(5000)
      expect(actions(harness)).toEqual([])

      keyDown('b')
      advance(MIN_DESTRUCTIVE_HOLD_MS)
      expect(actions(harness)).toEqual([ActionId.black])
    })

    it('fires logo and freeze on a tap', () => {
      const harness = mount()

      keyDown('l')
      advance(50)
      keyUp('l')
      keyDown('f')
      advance(50)
      keyUp('f')

      expect(actions(harness)).toEqual([ActionId.logo, ActionId.freeze])
    })

    it('carries the camera slot as the action param', () => {
      const harness = mount()

      for (const key of ['1', '2', '3', '4']) {
        keyDown(key)
        advance(60)
        keyUp(key)
      }

      expect(harness.fired.map((entry) => [entry.action, entry.param])).toEqual([
        [ActionId.cameraSelect, 'cam1'],
        [ActionId.cameraSelect, 'cam2'],
        [ActionId.cameraSelect, 'wide'],
        [ActionId.cameraSelect, 'pulpit'],
      ])
    })

    it('ignores a key that is bound to nothing', () => {
      const harness = mount()

      keyDown('q')
      advance(60)
      keyUp('q')
      advance(5000)

      expect(actions(harness)).toEqual([])
    })

    it('matches a lettered binding with CapsLock on', () => {
      const harness = mount()

      keyDown('L')
      advance(60)
      keyUp('L')

      expect(actions(harness)).toEqual([ActionId.logo])
    })
  })

  describe('autorepeat', () => {
    it('ignores repeat keydowns so a tap binding fires once', () => {
      const harness = mount()

      keyDown(' ')
      advance(100)
      keyDown(' ', { repeat: true })
      advance(100)
      keyDown(' ', { repeat: true })
      advance(50)
      keyUp(' ')

      expect(actions(harness)).toEqual([ActionId.advance])
    })

    it('does not let repeat keydowns restart the hold timer', () => {
      const harness = mount()

      keyDown(' ')
      for (let elapsed = 0; elapsed < PANIC_HOLD_MS; elapsed += 500) {
        advance(500)
        keyDown(' ', { repeat: true })
      }

      expect(actions(harness)).toEqual([ActionId.panic])
    })
  })

  describe('text entry', () => {
    it('fires nothing while focus is in an input — typing a name must not black the output', () => {
      const harness = mount()
      const { getByRole } = render(<input aria-label="Lower third line 1" />)
      const field = getByRole('textbox')

      keyDown('b', {}, field)
      advance(MIN_DESTRUCTIVE_HOLD_MS + 500)
      keyUp('b', {}, field)

      keyDown(' ', {}, field)
      advance(100)
      keyUp(' ', {}, field)

      keyDown('Escape', {}, field)
      advance(DISABLE_AI_HOLD_MS + 500)
      keyUp('Escape', {}, field)

      expect(actions(harness)).toEqual([])
    })

    it('fires nothing while focus is in a textarea', () => {
      const harness = mount()
      const { container } = render(<textarea defaultValue="" />)
      const field = container.querySelector('textarea')
      expect(field).not.toBeNull()

      keyDown(' ', {}, field as Element)
      advance(100)
      keyUp(' ', {}, field as Element)

      expect(actions(harness)).toEqual([])
    })

    it('fires nothing while focus is inside a contenteditable host', () => {
      const harness = mount()
      const { container } = render(
        <div contentEditable suppressContentEditableWarning>
          <span data-testid="inner">text</span>
        </div>,
      )
      const inner = container.querySelector('[data-testid="inner"]')
      expect(inner).not.toBeNull()

      keyDown(' ', {}, inner as Element)
      advance(100)
      keyUp(' ', {}, inner as Element)

      expect(actions(harness)).toEqual([])
    })

    it('still fires for a non-editable element such as a button', () => {
      const harness = mount()
      const { getByRole } = render(<button type="button">Advance</button>)
      const button = getByRole('button')

      keyDown(' ', {}, button)
      advance(100)
      keyUp(' ', {}, button)

      expect(actions(harness)).toEqual([ActionId.advance])
    })
  })

  describe('resilience and teardown', () => {
    it('keeps dispatching after a handler throws', () => {
      const fired: DispatchedAction[] = []
      const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() }
      const dispatcher = createActionDispatcher({ now: () => clockMs, logger })
      dispatcher.subscribe((dispatched) => fired.push(dispatched))
      dispatcher.register(ActionId.advance, () => {
        throw new Error('advance handler exploded')
      })
      renderHook(() => useKeyboardActions({ dispatcher, now: () => clockMs, timers }))

      keyDown(' ')
      advance(100)
      keyUp(' ')

      // The first press blew up inside its handler; the keyboard must still be alive.
      keyDown('l')
      advance(100)
      keyUp('l')

      expect(fired.map((entry) => entry.action)).toEqual([ActionId.advance, ActionId.logo])
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('removes its listeners on unmount', () => {
      const harness = mount()
      harness.unmount()

      keyDown(' ')
      advance(100)
      keyUp(' ')
      advance(PANIC_HOLD_MS * 2)

      expect(actions(harness)).toEqual([])
    })

    it('cancels a pending hold timer on unmount', () => {
      const harness = mount()

      keyDown(' ')
      advance(PANIC_HOLD_MS - 500)
      harness.unmount()
      advance(PANIC_HOLD_MS * 2)

      // A PANIC firing into a torn-down tree is exactly the kind of ghost this prevents.
      expect(actions(harness)).toEqual([])
    })

    it('cancels an in-flight hold when the window loses focus', () => {
      const harness = mount()

      keyDown(' ')
      advance(PANIC_HOLD_MS - 500)
      act(() => {
        fireEvent.blur(window)
      })
      advance(PANIC_HOLD_MS * 2)

      expect(actions(harness)).toEqual([])
    })

    it('fires nothing at all while disabled', () => {
      const harness = mount({ enabled: false })

      keyDown(' ')
      advance(PANIC_HOLD_MS + 100)
      keyUp(' ')

      expect(actions(harness)).toEqual([])
    })

    it('honours a custom binding list', () => {
      const bindings: readonly KeyBinding[] = [
        { action: ActionId.advance, key: 'Enter', gesture: 'tap' },
      ]
      const harness = mount({ bindings })

      keyDown('Enter')
      advance(80)
      keyUp('Enter')

      // The default SPACE binding must be gone, not merged.
      keyDown(' ')
      advance(80)
      keyUp(' ')

      expect(actions(harness)).toEqual([ActionId.advance])
    })
  })
})

describe('binding safety (isSafeBinding)', () => {
  it('rejects a destructive action bound to a tap', () => {
    // This is the v2 regression in one line: `ESC` clearing every overlay on release.
    expect(isSafeBinding({ action: ActionId.clearAll, key: 'Escape', gesture: 'tap' })).toBe(false)
    expect(isSafeBinding({ action: ActionId.black, key: 'b', gesture: 'tap' })).toBe(false)
  })

  it('rejects a destructive action bound to a hold that is too short', () => {
    expect(
      isSafeBinding({
        action: ActionId.clearAll,
        key: 'c',
        gesture: 'hold',
        holdMs: MIN_DESTRUCTIVE_HOLD_MS - 1,
      }),
    ).toBe(false)
    // A hold binding with no duration at all is not a hold.
    expect(isSafeBinding({ action: ActionId.black, key: 'b', gesture: 'hold' })).toBe(false)
  })

  it('accepts a destructive action held for the full floor', () => {
    expect(
      isSafeBinding({
        action: ActionId.black,
        key: 'b',
        gesture: 'hold',
        holdMs: MIN_DESTRUCTIVE_HOLD_MS,
      }),
    ).toBe(true)
  })

  it('accepts every default binding', () => {
    for (const binding of DEFAULT_KEY_BINDINGS) {
      expect(isSafeBinding(binding), `${binding.action} on "${binding.key}"`).toBe(true)
    }
  })
})
