/**
 * The remap screen's contract.
 *
 * Two properties carry the weight. First, **capture records whatever key arrives** — that is the
 * entire foot-pedal and Stream Deck integration, because both are keyboards, and the test presses
 * `F13` exactly as an operator would press the pedal. Second, **the screen cannot be used to
 * re-create rhema_v2's instant-clear regression**: a destructive action set to a tap, or to a hold
 * under `MIN_DESTRUCTIVE_HOLD_MS`, is refused with a reason, and nothing reaches storage.
 *
 * The third one is quieter and matters just as much: pressing a key during capture must **not**
 * also fire that key's action. Binding `b` to your pedal should not black out the program while you
 * are binding it, so the capture listener is asserted to swallow the event before a window-level
 * keyboard listener — which is exactly where `useKeyboardActions` lives — can see it.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KeyBinding } from '@shared/actions'
import { ActionId, DEFAULT_KEY_BINDINGS, MIN_DESTRUCTIVE_HOLD_MS } from '@shared/actions'

import '../i18n'
import type { BindingStorage } from '../input/bindings'
import { BINDINGS_STORAGE_KEY } from '../input/bindings'
import { ShortcutSettings } from './ShortcutSettings'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** In-memory storage that records writes, so "nothing was saved" is assertable. */
class FakeStorage implements BindingStorage {
  readonly items = new Map<string, string>()
  readonly writes: string[] = []
  readonly removals: string[] = []

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes.push(value)
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    this.removals.push(key)
    this.items.delete(key)
  }
}

/** Rows shown: one per default binding, plus one placeholder for each action with no default. */
const ROW_COUNT = DEFAULT_KEY_BINDINGS.length + 1

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
})

afterEach(() => {
  vi.useRealTimers()
})

/** The map as it was actually written, or `null` when nothing was. */
function savedBindings(): readonly KeyBinding[] | null {
  const raw = storage.getItem(BINDINGS_STORAGE_KEY)
  return raw === null ? null : (JSON.parse(raw) as readonly KeyBinding[])
}

function renderScreen(onChange?: (bindings: readonly KeyBinding[]) => void): void {
  render(
    onChange === undefined ? (
      <ShortcutSettings storage={storage} />
    ) : (
      <ShortcutSettings storage={storage} onChange={onChange} />
    ),
    { wrapper: Landmark },
  )
}

/** The row (`<tr>`) whose row header matches `name`. */
function row(name: RegExp): HTMLElement {
  const header = screen.getByRole('rowheader', { name })
  const parent = header.closest('tr')
  if (parent === null) throw new Error(`no row for ${String(name)}`)
  return parent
}

describe('ShortcutSettings', () => {
  it('lists every default binding with its chord and gesture', () => {
    renderScreen()

    // One row per binding, not per action: the four camera buttons are four rows. Plus one row
    // for the single action that ships unbound.
    expect(screen.getAllByRole('rowheader')).toHaveLength(ROW_COUNT)
    expect(within(row(/^Advance/)).getByText('Space')).toBeInTheDocument()
    expect(within(row(/Dismiss lower third/)).getByText('Shift + Esc')).toBeInTheDocument()
    expect(within(row(/Camera — wide/)).getByText('3')).toBeInTheDocument()
  })

  it('offers the actions that ship with no key at all, without inventing one', () => {
    renderScreen()

    // `clearAll` is deliberately not in the default keymap — it lives on a distant on-screen hold.
    // It still gets a row, so a pedal board can reach it, and it is shown as unbound rather than
    // as some made-up key.
    expect(within(row(/Clear all overlays/)).getByText(/not bound/i)).toBeInTheDocument()
    expect(
      DEFAULT_KEY_BINDINGS.some((binding) => binding.action === ActionId.clearAll),
    ).toBe(false)
  })

  it('saves without complaining about the unbound row', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(savedBindings()).toHaveLength(DEFAULT_KEY_BINDINGS.length)
  })

  it('explains that a pedal or Stream Deck is bound by pressing it', () => {
    renderScreen()
    const panel = screen.getByRole('region', { name: /foot pedals and stream decks/i })
    expect(panel).toHaveTextContent(/just a keyboard/i)
    expect(panel).toHaveTextContent(/press the pedal/i)
  })

  it('records whatever key is pressed during capture — this is how a pedal is bound', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: /rebind show logo slate/i }))
    expect(screen.getByText(/press the key, foot pedal or stream deck button/i)).toBeInTheDocument()

    // The operator stamps on the pedal. It is a keyboard, so a key code arrives.
    fireEvent.keyDown(window, { key: 'F13' })

    expect(within(row(/Show logo slate/)).getByText('F13')).toBeInTheDocument()
    expect(screen.queryByText(/press the key, foot pedal/i)).not.toBeInTheDocument()
  })

  it('records modifiers, and ignores a bare modifier so a chord can be pressed', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: /rebind freeze frame/i }))
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
    // Still capturing: SHIFT alone is not a binding.
    expect(screen.getByText(/press the key, foot pedal/i)).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'F14', shiftKey: true })
    expect(within(row(/Freeze frame/)).getByText('Shift + F14')).toBeInTheDocument()
  })

  it('does not let the key being bound fire its own action', async () => {
    // `useKeyboardActions` listens on the window in the bubble phase. Capture must swallow the
    // press before it gets there, or binding `b` to a pedal would black out the program.
    const seenByTheApp = vi.fn()
    window.addEventListener('keydown', seenByTheApp)
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: /rebind advance/i }))
    fireEvent.keyDown(window, { key: 'b' })

    expect(seenByTheApp).not.toHaveBeenCalled()
    window.removeEventListener('keydown', seenByTheApp)
  })

  it('cancels capture on Tab without binding it', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(screen.getByRole('button', { name: /rebind show logo slate/i }))
    fireEvent.keyDown(window, { key: 'Tab' })

    expect(screen.queryByText(/press the key, foot pedal/i)).not.toBeInTheDocument()
    expect(within(row(/Show logo slate/)).getByText('L')).toBeInTheDocument()
  })

  it('saves a remapped key and hands the new map to the caller', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderScreen(onChange)

    await user.click(screen.getByRole('button', { name: /rebind advance/i }))
    fireEvent.keyDown(window, { key: 'F13' })
    await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

    expect(screen.getByText(/shortcuts saved/i)).toBeInTheDocument()
    const saved = savedBindings()
    expect(saved?.find((binding) => binding.action === ActionId.advance)?.key).toBe('F13')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  describe('the v2 regression guard', () => {
    it('refuses a destructive action bound to a tap, names the reason, and saves nothing', async () => {
      const user = userEvent.setup()
      renderScreen()

      await user.selectOptions(screen.getByLabelText(/gesture for black out program/i), 'tap')
      await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

      expect(screen.getByRole('alert')).toHaveTextContent(
        /black out program can blank the output, so it must be a hold, never a tap/i,
      )
      expect(storage.writes).toEqual([])
      expect(savedBindings()).toBeNull()
      expect(screen.queryByText(/shortcuts saved/i)).not.toBeInTheDocument()
    })

    it('warns on the row itself, before the operator even presses Save', async () => {
      const user = userEvent.setup()
      renderScreen()

      await user.selectOptions(screen.getByLabelText(/gesture for black out program/i), 'tap')

      expect(within(row(/Black out program/)).getByText(/never a tap/i)).toBeInTheDocument()
    })

    it('refuses a destructive hold under the floor and saves nothing', async () => {
      const user = userEvent.setup()
      renderScreen()

      const holdField = screen.getByLabelText(/hold duration for black out program/i)
      await user.clear(holdField)
      await user.type(holdField, '500')
      await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

      expect(screen.getByRole('alert')).toHaveTextContent(
        new RegExp(`held for at least ${String(MIN_DESTRUCTIVE_HOLD_MS)} ms`, 'i'),
      )
      expect(storage.writes).toEqual([])
    })

    it('accepts a destructive hold at exactly the floor', async () => {
      const user = userEvent.setup()
      renderScreen()

      const holdField = screen.getByLabelText(/hold duration for black out program/i)
      await user.clear(holdField)
      await user.type(holdField, String(MIN_DESTRUCTIVE_HOLD_MS))
      await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(
        savedBindings()?.find((binding) => binding.action === ActionId.black)?.holdMs,
      ).toBe(MIN_DESTRUCTIVE_HOLD_MS)
    })

    it('puts a destructive action on the floor when it is switched back to a hold', async () => {
      const user = userEvent.setup()
      renderScreen()

      await user.selectOptions(screen.getByLabelText(/gesture for black out program/i), 'tap')
      await user.selectOptions(screen.getByLabelText(/gesture for black out program/i), 'hold')

      expect(screen.getByLabelText(/hold duration for black out program/i)).toHaveValue(
        String(MIN_DESTRUCTIVE_HOLD_MS),
      )

      // The floor is the *destructive* floor, not a global one: an ordinary action gets the
      // ordinary default, which is shorter.
      await user.selectOptions(screen.getByLabelText(/gesture for show logo slate/i), 'hold')
      expect(screen.getByLabelText(/hold duration for show logo slate/i)).toHaveValue('1000')
    })
  })

  it('reports a conflict when two actions land on the same key and gesture', async () => {
    const user = userEvent.setup()
    renderScreen()

    // `l` is already the logo slate. Binding freeze to it makes one of them dead.
    await user.click(screen.getByRole('button', { name: /rebind freeze frame/i }))
    fireEvent.keyDown(window, { key: 'l' })

    const warning = within(row(/Freeze frame/)).getByText(/conflict/i)
    expect(warning).toHaveTextContent(/show logo slate/i)
    expect(warning).toHaveTextContent(/freeze frame/i)
    expect(within(row(/Show logo slate/)).getByText(/conflict/i)).toBeInTheDocument()
  })

  it('starts from the saved map, so a remap survives a reopen', () => {
    storage.setItem(
      BINDINGS_STORAGE_KEY,
      JSON.stringify([{ action: ActionId.advance, key: 'F13', gesture: 'tap' }]),
    )

    renderScreen()

    expect(within(row(/^Advance/)).getByText('F13')).toBeInTheDocument()
    // And everything the operator never touched is still listed.
    expect(screen.getAllByRole('rowheader')).toHaveLength(ROW_COUNT)
  })

  it('shows a printable card covering the whole map', async () => {
    const user = userEvent.setup()
    renderScreen()

    expect(screen.queryByRole('region', { name: /shortcut card/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /printable card/i }))

    const card = screen.getByRole('region', { name: /shortcut card/i })
    expect(within(card).getAllByRole('listitem')).toHaveLength(DEFAULT_KEY_BINDINGS.length)
    expect(within(card).getByText(/Esc — hold 2s/)).toBeInTheDocument()
    expect(within(card).getByText(/Space — tap/)).toBeInTheDocument()
  })

  it('restores the defaults, but only after a deliberate hold', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderScreen(onChange)

    await user.click(screen.getByRole('button', { name: /rebind advance/i }))
    fireEvent.keyDown(window, { key: 'F13' })
    expect(within(row(/^Advance/)).getByText('F13')).toBeInTheDocument()

    const reset = screen.getByRole('button', { name: /reset all shortcuts to defaults/i })

    vi.useFakeTimers()
    // A click is not enough — HoldButton has no onClick at all.
    fireEvent.pointerDown(reset)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    fireEvent.pointerUp(reset)
    act(() => {
      vi.advanceTimersByTime(MIN_DESTRUCTIVE_HOLD_MS)
    })
    expect(within(row(/^Advance/)).getByText('F13')).toBeInTheDocument()

    fireEvent.pointerDown(reset)
    act(() => {
      vi.advanceTimersByTime(MIN_DESTRUCTIVE_HOLD_MS + 100)
    })
    fireEvent.pointerUp(reset)

    expect(within(row(/^Advance/)).getByText('Space')).toBeInTheDocument()
    expect(storage.removals).toEqual([BINDINGS_STORAGE_KEY])
    expect(onChange).toHaveBeenCalledWith(DEFAULT_KEY_BINDINGS)
  })

  it('says so when a stored map had to be repaired', () => {
    storage.setItem(BINDINGS_STORAGE_KEY, '{not json')
    renderScreen()
    expect(screen.getByText(/could not be read and were put back to their defaults/i)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<ShortcutSettings storage={storage} />, { wrapper: Landmark })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations while capturing or showing the card', async () => {
    const user = userEvent.setup()
    const { container } = render(<ShortcutSettings storage={storage} />, { wrapper: Landmark })

    await user.click(screen.getByRole('button', { name: /printable card/i }))
    await user.click(screen.getByRole('button', { name: /rebind advance/i }))

    expect(await axe(container)).toHaveNoViolations()
  })
})

/**
 * A host that keeps the saved map in state, standing in for the app wiring the screen's `onChange`
 * into `useKeyboardActions`. Asserts the contract the app depends on: what comes out of `onChange`
 * is a complete, valid map — not a diff and not a partial list.
 */
function Host(): React.JSX.Element {
  const [bindings, setBindings] = useState<readonly KeyBinding[]>(DEFAULT_KEY_BINDINGS)
  return (
    <>
      <p data-testid="binding-count">{bindings.length}</p>
      <ShortcutSettings storage={storage} onChange={setBindings} />
    </>
  )
}

describe('handing the map back to the app', () => {
  it('emits the whole map on save', async () => {
    const user = userEvent.setup()
    render(<Host />, { wrapper: Landmark })

    await user.click(screen.getByRole('button', { name: /rebind advance/i }))
    fireEvent.keyDown(window, { key: 'F13' })
    await user.click(screen.getByRole('button', { name: /save shortcuts/i }))

    expect(screen.getByTestId('binding-count')).toHaveTextContent(
      String(DEFAULT_KEY_BINDINGS.length),
    )
  })
})
