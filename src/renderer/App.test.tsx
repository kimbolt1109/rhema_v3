/**
 * The new shell's contract: two things on screen, and everything else behind a drawer.
 *
 * The load-bearing assertion in this file is that **the service keyboard is suspended while the
 * drawer is open**. `App.tsx` hands `enabled: !drawerOpen` to `useKeyboardActions`, and that one flag
 * is the whole difference between SPACE activating the button under the operator's finger inside the
 * plan editor and SPACE advancing the live service behind it — the hook calls `preventDefault()` on
 * every key it owns, so without the suspension the button would never see the press at all. It is
 * asserted here with a positive control: the same SPACE that does nothing while the drawer is open
 * advances the plan the moment the drawer is shut, so a green result cannot come from a keyboard that
 * was simply never wired in the first place.
 *
 * The rest is the operating surface itself, and most of it is asserted as *absences* — no `banner`,
 * no `tab`, no permanent suggestion strip. The old shell was a title bar, a health strip, an
 * always-present suggestion strip and thirteen tabs; "the tabs came back" is exactly the kind of
 * regression a screenshot review waves through, so it is pinned to a query instead.
 *
 * ## localStorage is part of the behaviour here, not scenery
 *
 * `isFirstRunOnThisMachine()` reads **and writes** `'verger.preflightSeen'`, so the checklist can
 * only ever open itself once. Every test therefore clears storage and then seeds the marker (or
 * deliberately does not), and the first-run test asserts the write as well as the open — a church PC
 * that already ran the portable build must not be shown Preflight a second time just because the UI
 * moved.
 *
 * ## Fixtures
 *
 * The shared `mock*` factories throughout, which are placeholders by construction (Standing Rule 4):
 * "SLIDE 1", "PLACEHOLDER TITLE", "PLACEHOLDER READING", and a scripture cue carrying the reference
 * `John 3:16` and no text — `ScripturePayload` has no field that could hold one.
 */

import type { RenderResult } from '@testing-library/react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ok } from '@shared/result'

import { App } from './App'
import './i18n'
import { resetAsrStore } from './store/asrStore'
import { resetCameraStore } from './store/cameraStore'
import { resetCueStore, useCueStore } from './store/cueStore'
import { resetGoLiveStore } from './store/goLiveStore'
import { resetHealthStore } from './store/healthStore'
import { resetObsStore } from './store/obsStore'
import { resetOverlayStore } from './store/overlayStore'
import { resetPlanStore, usePlanStore } from './store/planStore'
import { resetYouTubeStore } from './store/youtubeStore'
import type { InstalledMockVergerApi } from './test/mockVergerApi'
import { installMockVergerApi, mockPendingCueEngineState, mockPlanState } from './test/mockVergerApi'

/**
 * The marker `isFirstRunOnThisMachine()` reads and writes.
 *
 * Spelled out here rather than imported on purpose: the literal *is* the contract with every machine
 * that already ran an earlier build, and a rename that quietly re-showed the checklist every Sunday
 * would sail past a test that asserted against whatever the constant happens to say today.
 */
const PREFLIGHT_SEEN_KEY = 'verger.preflightSeen'

/** A tap: keydown then keyup, well inside `MAX_TAP_MS`. Anything slower is not an advance. */
function tapKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }),
    )
  })
}

/** `Ctrl+,` — chrome, not a service action, so it stays live even while the keymap is suspended. */
function pressConsoleKey(): void {
  tapKey(',', { ctrlKey: true })
}

function pressEscape(): void {
  tapKey('Escape')
}

/**
 * Let every in-flight round trip land.
 *
 * A macrotask rather than a microtask: the negative assertions in this file ("SPACE did *not*
 * advance") are only worth anything if the advance would have had time to be recorded by now.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

/** Mount the shell and wait for the nine subsystems it hydrates at the root to settle. */
async function renderConsole(): Promise<RenderResult> {
  const utils = render(<App />)
  await waitFor(() => {
    expect(usePlanStore.getState().hydrated).toBe(true)
    expect(useCueStore.getState().hydrated).toBe(true)
  })
  return utils
}

describe('App', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    // A plan is open by default: the grid *is* the main surface now, so the ordinary case for this
    // shell is an operator with a deck loaded, not the launch-state empty plan.
    installed = installMockVergerApi({ planGetState: ok(mockPlanState()) })

    // Every store is a module singleton and outlives a single test; a leaked `busy: true` would
    // silently disable every tile in whichever test mounted next.
    resetObsStore()
    resetOverlayStore()
    resetCameraStore()
    resetPlanStore()
    resetYouTubeStore()
    resetGoLiveStore()
    resetAsrStore()
    resetCueStore()
    resetHealthStore()

    localStorage.clear()
    // The default for most tests: this machine has run Verger before, so the drawer starts shut.
    localStorage.setItem(PREFLIGHT_SEEN_KEY, '1')
  })

  afterEach(() => {
    installed.restore()
    localStorage.clear()
  })

  describe('the operating surface', () => {
    it('is the slide grid and the bar, with no title bar and no tabs anywhere', async () => {
      await renderConsole()

      expect(screen.getByTestId('slide-grid')).toBeInTheDocument()
      expect(screen.getByTestId('bottom-bar')).toBeInTheDocument()

      // The old shell's chrome, asserted gone: a title bar, a health strip and thirteen tabs.
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryAllByRole('tab')).toHaveLength(0)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('has no axe violations while a service is being run', async () => {
      const { container } = await renderConsole()
      await expect(axe(container)).resolves.toHaveNoViolations()
    })
  })

  describe('first run on this machine', () => {
    it('opens the drawer on Preflight, and writes the marker so it never does so again', async () => {
      localStorage.removeItem(PREFLIGHT_SEEN_KEY)

      const first = await renderConsole()

      const drawer = within(screen.getByRole('dialog'))
      expect(drawer.getByRole('tab', { name: 'Preflight' })).toHaveAttribute(
        'aria-selected',
        'true',
      )

      // Reading the marker is what wrote it. Asserting the write is the only way to know the
      // checklist cannot reappear on a machine that has already been through it.
      expect(localStorage.getItem(PREFLIGHT_SEEN_KEY)).toBe('1')

      first.unmount()

      await renderConsole()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('starts with the drawer shut when the marker is already present', async () => {
      await renderConsole()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryAllByRole('tab')).toHaveLength(0)
    })
  })

  describe('opening and closing the drawer', () => {
    it('toggles on Ctrl+, and closes on Escape', async () => {
      await renderConsole()
      expect(screen.queryByRole('dialog')).toBeNull()

      pressConsoleKey()
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      pressConsoleKey()
      expect(screen.queryByRole('dialog')).toBeNull()

      pressConsoleKey()
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      pressEscape()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('opens when the bar’s settings button is pressed', async () => {
      const user = userEvent.setup()
      await renderConsole()

      await user.click(screen.getByTestId('bottom-bar-settings'))

      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('leaves a bare Escape inert when the drawer is already shut', async () => {
      const { mock } = installed
      await renderConsole()
      expect(screen.queryByRole('dialog')).toBeNull()

      pressEscape()
      await settle()

      // Esc is not an opener, and a bare tap is not a service action either: the keymap gives Esc a
      // two-second HOLD meaning (hand control back from the AI) and the tap deliberately fires
      // nothing at all. So this keypress must be visible nowhere.
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mock.calls.cueSetMode).toHaveLength(0)
      expect(mock.calls.cuePanic).toHaveLength(0)
      expect(mock.calls.overlaySend).toHaveLength(0)
      expect(mock.calls.planAdvance).toHaveLength(0)
    })
  })

  describe('the service keyboard', () => {
    it('advances the plan on SPACE while the drawer is shut', async () => {
      const { mock } = installed
      await renderConsole()

      tapKey(' ')

      await waitFor(() => {
        expect(mock.calls.planAdvance).toHaveLength(1)
      })
    })

    it('is suspended while the drawer is open, and comes back when it shuts', async () => {
      const { mock } = installed
      await renderConsole()

      pressConsoleKey()
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      tapKey(' ')
      await settle()

      // THE assertion this file exists for. With the drawer open, SPACE belongs to whatever control
      // the operator is on inside it; it may not reach past the drawer and advance a live service.
      expect(mock.calls.planAdvance).toHaveLength(0)

      // The positive control: the very same keypress, with the drawer shut. Without this a keyboard
      // that was never wired at all would pass the assertion above.
      pressEscape()
      expect(screen.queryByRole('dialog')).toBeNull()

      tapKey(' ')
      await waitFor(() => {
        expect(mock.calls.planAdvance).toHaveLength(1)
      })
    })
  })

  describe('the suggestion card', () => {
    it('is mounted only while something is pending', async () => {
      await renderConsole()

      // Not permanent chrome: with nothing pending there is nothing for it to say, and the brief is
      // explicit that only the grid and the bar are on screen during normal operation.
      expect(screen.queryByTestId('floating-suggestion')).toBeNull()

      act(() => {
        useCueStore.setState({ state: mockPendingCueEngineState() })
      })

      // …and it floats over the console rather than living in the drawer, because a suggestion's
      // deadline is measured in seconds and cannot wait for one to be opened.
      expect(screen.getByTestId('floating-suggestion')).toBeInTheDocument()
    })
  })

  describe('the tiles', () => {
    it('renders one tile per cue, in plan order', async () => {
      const { container } = await renderConsole()

      const tiles = container.querySelectorAll('li[data-cue-id]')
      expect(tiles).toHaveLength(3)
      expect(container.querySelector('li[data-cue-id="cue-welcome"]')).toHaveAttribute(
        'data-slide-number',
        '1',
      )
      expect(container.querySelector('li[data-cue-id="cue-reading"]')).toHaveAttribute(
        'data-slide-number',
        '3',
      )
    })

    it('fires the cue whose tile the operator taps', async () => {
      const user = userEvent.setup()
      const { mock } = installed
      await renderConsole()

      // The accessible name carries the operator's own numbering — "Slide 3" — beside the label.
      await user.click(screen.getByRole('button', { name: 'Slide 3: PLACEHOLDER READING' }))

      await waitFor(() => {
        expect(mock.calls.planFireCue).toEqual([{ cueId: 'cue-reading' }])
      })
      // Tapping a tile fires that one cue. It is not an advance, and it is not a second fire.
      expect(mock.calls.planAdvance).toHaveLength(0)
    })
  })
})
