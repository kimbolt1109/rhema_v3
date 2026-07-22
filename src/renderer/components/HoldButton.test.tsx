/**
 * The safety property Standing Rule 6 and KAHNEMAN-2 actually demand, asserted directly:
 * a destructive action cannot complete in under ~1.5 seconds, and releasing early does nothing
 * at all.
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6 records that rhema_v2 shipped this as an instant tap
 * and had to walk it back after an audit. These tests exist so that regression cannot recur
 * silently.
 *
 * Fake timers throughout: real 1.5-second waits in a unit suite are both slow and flaky, and the
 * component accumulates elapsed time from interval ticks precisely so that it is deterministic
 * under them.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../i18n'
import { DEFAULT_HOLD_MS, HoldButton } from './HoldButton'

/** Advance fake timers inside `act`, so the interval's state updates are flushed. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('HoldButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('says in its accessible name that it must be held, and for how long', () => {
    render(<HoldButton label="Clear all overlays" onHoldComplete={() => undefined} />)

    const button = screen.getByRole('button', { name: /hold for 1\.5 seconds/i })
    expect(button).toHaveAccessibleName(/clear all overlays/i)
    expect(button).toHaveAccessibleName(/hold/i)
  })

  it('fires nothing when the pointer is released before the threshold', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS - 200)
    fireEvent.pointerUp(button)
    // Even if the operator lets the clock keep running afterwards, nothing may fire.
    advance(5000)

    expect(fired).toBe(0)
  })

  it('fires exactly once when held past the threshold', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS - 100)
    expect(fired).toBe(0)

    advance(200)
    expect(fired).toBe(1)

    // The interval must be dead: holding the pointer down longer cannot fire again.
    advance(5000)
    expect(fired).toBe(1)
  })

  it('honours a custom duration', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        durationMs={2000}
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(1600)
    expect(fired).toBe(0)
    advance(500)
    expect(fired).toBe(1)
  })

  it('can be held a second time', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS + 100)
    fireEvent.pointerUp(button)
    expect(fired).toBe(1)

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS + 100)
    fireEvent.pointerUp(button)
    expect(fired).toBe(2)
  })

  it('supports a keyboard hold on Space, and cancels on key-up', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.keyDown(button, { key: ' ' })
    advance(DEFAULT_HOLD_MS - 200)
    fireEvent.keyUp(button, { key: ' ' })
    advance(5000)
    expect(fired).toBe(0)

    fireEvent.keyDown(button, { key: ' ' })
    advance(DEFAULT_HOLD_MS + 100)
    expect(fired).toBe(1)
  })

  it('supports a keyboard hold on Enter without Enter itself activating the button', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    // A bare Enter press-and-release is the classic accidental activation. It must do nothing.
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyUp(button, { key: 'Enter' })
    advance(5000)
    expect(fired).toBe(0)

    fireEvent.keyDown(button, { key: 'Enter' })
    advance(DEFAULT_HOLD_MS + 100)
    expect(fired).toBe(1)
  })

  it('ignores OS key-repeat so a held key does not restart the timer', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.keyDown(button, { key: ' ' })
    advance(700)
    fireEvent.keyDown(button, { key: ' ', repeat: true })
    advance(700)
    fireEvent.keyDown(button, { key: ' ', repeat: true })
    advance(200)

    expect(fired).toBe(1)
  })

  it('cancels when the pointer leaves the button mid-hold', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS - 200)
    // Dragging off a half-held control is the universal "actually, no" gesture.
    fireEvent.pointerOut(button, { relatedTarget: document.body })
    advance(5000)

    expect(fired).toBe(0)
  })

  it('cancels on blur', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(400)
    fireEvent.blur(button)
    advance(5000)

    expect(fired).toBe(0)
  })

  it('ignores a non-primary pointer button', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, { button: 2 })
    advance(5000)

    expect(fired).toBe(0)
  })

  it('does not fire while disabled', () => {
    let fired = 0
    render(
      <HoldButton
        label="Clear all overlays"
        disabled
        onHoldComplete={() => {
          fired += 1
        }}
      />,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button)
    advance(5000)

    expect(fired).toBe(0)
  })

  it('reports progress and announces the hold', () => {
    render(<HoldButton label="Clear all overlays" onHoldComplete={() => undefined} />)
    const button = screen.getByRole('button')

    expect(button).toHaveAttribute('data-hold-progress', '0')

    fireEvent.pointerDown(button)
    advance(Math.round(DEFAULT_HOLD_MS / 2))

    expect(Number(button.getAttribute('data-hold-progress'))).toBeGreaterThan(20)
    expect(Number(button.getAttribute('data-hold-progress'))).toBeLessThan(80)
    expect(screen.getByRole('status')).toHaveTextContent(/keep holding/i)

    advance(DEFAULT_HOLD_MS)
    expect(screen.getByRole('status')).toHaveTextContent(/done/i)
  })
})
