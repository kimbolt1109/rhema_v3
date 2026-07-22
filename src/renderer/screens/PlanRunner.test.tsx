/**
 * The live plan surface's contract.
 *
 * The load-bearing assertion in this file is a *negative* one: **BACK must not re-fire the cue.**
 * `stepBack()` in `src/shared/plan.ts` moves the pointer and leaves `firedCueIds` alone, and this
 * screen has to match that — an undo that re-shows the slide the operator was trying to remove is
 * not an undo. An absence cannot be seen on a screenshot or in a snapshot, so it is asserted here
 * against the controller's real call log.
 *
 * The other one worth naming is the pre-load. BLUEPRINT.md §4 promises the next slide is fetched
 * before it is needed; that is only true if an `<img>` for the next asset is in the document
 * *before* the advance, so the test asserts exactly that ordering rather than trusting the markup
 * to look right.
 *
 * ## Fixtures
 *
 * Standing Rule 4: every fixture here is an obvious placeholder — "SLIDE 1", "PLACEHOLDER TITLE".
 * No hymn lyrics, no verse text, no real sermon. The scripture cue carries a *reference* and
 * nothing else, which is all `ScripturePayload` can hold by construction.
 *
 * ## Why a fake controller rather than the mock bridge
 *
 * `PlanRunner` takes a {@link PlanRunnerController} — the minimal seam it needs — so these tests
 * inject a recording fake. That keeps this file independent of `planStore.ts` and of the plan half
 * of `mockVergerApi.ts`, both of which belong to another agent. The screen's *own* default
 * controller (the direct `window.verger.plan` binding) is covered by the no-bridge test, which is
 * the case that must degrade rather than throw.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PlanState } from '@shared/ipc'
import type { Cue, PlanPosition, ServicePlan } from '@shared/plan'
import { emptyServicePlan, initialPlanPosition } from '@shared/plan'

import '../i18n'
import { resetPlanStore } from '../store/planStore'
import { PlanRunner } from './PlanRunner'
import type { PlanRunnerController } from './PlanRunner'

/** The screen mounts inside `<main>` in the app shell; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

// --- Fixtures. Placeholders only, per Standing Rule 4. ------------------------------------------

const SLIDE_ONE_ASSET = 'slides/slide-001.png'
const SLIDE_TWO_ASSET = 'slides/slide-002.png'

const CUE_SLIDE_ONE: Cue = {
  id: 'cue-1',
  type: 'slide',
  label: 'SLIDE 1',
  trigger: { mode: 'manual' },
  payload: { asset: SLIDE_ONE_ASSET, sourceSlide: 1 },
}

const CUE_LOWER_THIRD: Cue = {
  id: 'cue-2',
  type: 'lowerthird',
  label: 'PLACEHOLDER TITLE',
  trigger: { mode: 'manual' },
  payload: { line1: 'PLACEHOLDER NAME', line2: 'PLACEHOLDER ROLE' },
}

const CUE_SCRIPTURE: Cue = {
  id: 'cue-3',
  type: 'scripture',
  // A reference only. `ScripturePayload` has no `text` field, deliberately.
  label: 'READING',
  trigger: { mode: 'manual' },
  payload: { reference: 'John 3:16', translation: 'KJV' },
}

const CUE_SLIDE_TWO: Cue = {
  id: 'cue-4',
  type: 'slide',
  label: 'SLIDE 2',
  trigger: { mode: 'manual' },
  payload: { asset: SLIDE_TWO_ASSET, sourceSlide: 2 },
}

const CUES: readonly Cue[] = [CUE_SLIDE_ONE, CUE_LOWER_THIRD, CUE_SCRIPTURE, CUE_SLIDE_TWO]

function plan(cues: readonly Cue[] = CUES): ServicePlan {
  return { ...emptyServicePlan('PLACEHOLDER SERVICE'), cues }
}

function planState(position: PlanPosition, cues: readonly Cue[] = CUES): PlanState {
  return { plan: plan(cues), position, path: null, dirty: false, lastFired: null }
}

/** Everything the fake controller recorded. Assert against this, not on spies. */
interface ControllerCalls {
  readonly advance: number[]
  readonly back: number[]
  readonly fireCue: string[]
}

interface FakeController {
  readonly controller: PlanRunnerController
  readonly calls: ControllerCalls
}

function makeController(
  state: PlanState,
  overrides: Partial<Omit<PlanRunnerController, 'state'>> = {},
): FakeController {
  const calls: ControllerCalls = { advance: [], back: [], fireCue: [] }
  const controller: PlanRunnerController = {
    state,
    bridgeAvailable: true,
    busy: false,
    lastError: null,
    advance: () => {
      calls.advance.push(calls.advance.length)
    },
    back: () => {
      calls.back.push(calls.back.length)
    },
    fireCue: (cueId) => {
      calls.fireCue.push(cueId)
    },
    ...overrides,
  }
  return { controller, calls }
}

function renderRunner(controller: PlanRunnerController, onOpenEditor?: () => void): void {
  render(
    <Landmark>
      <PlanRunner
        controller={controller}
        {...(onOpenEditor === undefined ? {} : { onOpenEditor })}
      />
    </Landmark>,
  )
}

/** A tap: down then up inside `MAX_TAP_MS`. Anything slower is deliberately not an advance. */
function tapKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
}

describe('PlanRunner', () => {
  // `planStore` is a module singleton and outlives a single test; a leaked `busy: true` from the
  // no-bridge test would silently disable every button in the next file to mount the screen.
  beforeEach(() => {
    resetPlanStore()
  })

  describe('NOW / NEXT', () => {
    it('shows the current cue as NOW and the following one as NEXT', () => {
      const { controller } = makeController(planState({ index: 0, firedCueIds: ['cue-1'] }))
      renderRunner(controller)

      const now = within(screen.getByTestId('plan-now'))
      const next = within(screen.getByTestId('plan-next'))

      expect(now.getByText('SLIDE 1')).toBeInTheDocument()
      expect(next.getByText('PLACEHOLDER TITLE')).toBeInTheDocument()
      // The NEXT card must not be showing the cue that is already live.
      expect(next.queryByText('SLIDE 1')).not.toBeInTheDocument()
    })

    it('says the plan has not started, and offers the first cue as NEXT', () => {
      const { controller } = makeController(planState(initialPlanPosition()))
      renderRunner(controller)

      expect(screen.getByTestId('plan-now')).toHaveTextContent(/not started/i)
      expect(within(screen.getByTestId('plan-next')).getByText('SLIDE 1')).toBeInTheDocument()
      expect(screen.getByTestId('plan-position')).toHaveTextContent('— / 4')
    })

    it('renders a scripture cue as a reference, with no verse text field anywhere', () => {
      const { controller } = makeController(planState({ index: 1, firedCueIds: [] }))
      renderRunner(controller)

      const next = within(screen.getByTestId('plan-next'))
      expect(next.getByText('John 3:16')).toBeInTheDocument()
      expect(next.getByText('KJV')).toBeInTheDocument()
      expect(screen.getByTestId('plan-next')).toHaveTextContent(/fetched when the cue fires/i)
    })

    it('shows the service mode read-only', () => {
      const { controller } = makeController(planState({ index: 0, firedCueIds: [] }))
      renderRunner(controller)

      const mode = screen.getByTestId('plan-mode')
      expect(mode).toHaveTextContent(/assist/i)
      // Read-only in Phase 6: the trust dial is Phase 8's, and nothing here may change the mode.
      expect(within(mode).queryByRole('button')).toBeNull()
      expect(within(mode).queryByRole('combobox')).toBeNull()
    })
  })

  describe('advance and back', () => {
    it('calls advance when the ADVANCE button is pressed', async () => {
      const user = userEvent.setup()
      const { controller, calls } = makeController(planState({ index: 0, firedCueIds: ['cue-1'] }))
      renderRunner(controller)

      await user.click(screen.getByTestId('plan-advance'))

      expect(calls.advance).toHaveLength(1)
      expect(calls.fireCue).toHaveLength(0)
    })

    it('calls back when the BACK button is pressed, and never re-fires the cue', async () => {
      const user = userEvent.setup()
      const { controller, calls } = makeController(
        planState({ index: 2, firedCueIds: ['cue-1', 'cue-2', 'cue-3'] }),
      )
      renderRunner(controller)

      await user.click(screen.getByTestId('plan-back'))

      expect(calls.back).toHaveLength(1)
      // The assertion this whole file exists for: stepping back is a pointer move, not a fire.
      expect(calls.fireCue).toHaveLength(0)
      expect(calls.advance).toHaveLength(0)
    })

    it('wires SPACE to advance and BACKSPACE to back', () => {
      const { controller, calls } = makeController(planState({ index: 1, firedCueIds: ['cue-1'] }))
      renderRunner(controller)

      tapKey(' ')
      expect(calls.advance).toHaveLength(1)

      tapKey('Backspace')
      expect(calls.back).toHaveLength(1)
      expect(calls.fireCue).toHaveLength(0)
    })

    it('disables ADVANCE at the end of the plan', () => {
      const { controller } = makeController(planState({ index: 3, firedCueIds: [] }))
      renderRunner(controller)
      expect(screen.getByTestId('plan-advance')).toBeDisabled()
    })

    it('disables BACK before the first cue has fired', () => {
      const { controller } = makeController(planState(initialPlanPosition()))
      renderRunner(controller)
      expect(screen.getByTestId('plan-back')).toBeDisabled()
    })

    it('fires a cue the operator taps in the list', async () => {
      const user = userEvent.setup()
      const { controller, calls } = makeController(planState({ index: 0, firedCueIds: ['cue-1'] }))
      renderRunner(controller)

      await user.click(screen.getByRole('button', { name: /READING/ }))

      expect(calls.fireCue).toEqual(['cue-3'])
    })
  })

  describe('the cue list', () => {
    it('marks the current cue and distinguishes the ones already fired', () => {
      const { controller } = makeController(
        planState({ index: 1, firedCueIds: ['cue-1', 'cue-2'] }),
      )
      const { container } = render(
        <Landmark>
          <PlanRunner controller={controller} />
        </Landmark>,
      )

      const rows = container.querySelectorAll('li[data-cue-id]')
      expect(rows).toHaveLength(4)
      expect(container.querySelector('li[data-cue-id="cue-2"]')).toHaveAttribute(
        'data-current',
        'true',
      )
      expect(container.querySelector('li[data-cue-id="cue-1"]')).toHaveAttribute(
        'data-fired',
        'true',
      )
      expect(container.querySelector('li[data-cue-id="cue-4"]')).toHaveAttribute(
        'data-fired',
        'false',
      )
      // The position is announced, not merely tinted.
      expect(
        container.querySelector('li[data-cue-id="cue-2"] button'),
      ).toHaveAttribute('aria-current', 'step')
    })
  })

  describe('pre-loading', () => {
    it('has the next slide image in the document before the advance', async () => {
      const user = userEvent.setup()
      const { controller, calls } = makeController(planState(initialPlanPosition()))
      renderRunner(controller)

      // NEXT is SLIDE 1: its thumbnail is the pre-load, and it must already be fetched.
      const nextImage = screen.getByTestId('plan-next-image')
      expect(nextImage).toHaveAttribute('data-asset', SLIDE_ONE_ASSET)
      expect(nextImage.getAttribute('src')).toContain('slide-001.png')

      // …and the look-ahead strip has warmed the slide after it, before anything was pressed.
      const preloaded = screen
        .getAllByTestId('plan-preload-image')
        .map((image) => image.getAttribute('data-asset'))
      expect(preloaded).toContain(SLIDE_ONE_ASSET)
      expect(preloaded).toContain(SLIDE_TWO_ASSET)

      expect(calls.advance).toHaveLength(0)
      await user.click(screen.getByTestId('plan-advance'))
      expect(calls.advance).toHaveLength(1)
    })

    it('shows a labelled placeholder rather than a broken image for an unservable asset', () => {
      const traversal: Cue = {
        ...CUE_SLIDE_ONE,
        id: 'cue-bad',
        payload: { asset: '../../secrets/slide.png' },
      }
      const { controller } = makeController(planState({ index: 0, firedCueIds: [] }, [traversal]))
      renderRunner(controller)

      expect(screen.getByTestId('plan-now')).toHaveTextContent(/unavailable/i)
      expect(screen.queryByTestId('plan-now-image')).toBeNull()
    })
  })

  describe('the empty plan', () => {
    it('explains itself and offers the editor rather than rendering a dead screen', async () => {
      const user = userEvent.setup()
      const opened: number[] = []
      const { controller } = makeController(planState(initialPlanPosition(), []))
      renderRunner(controller, () => {
        opened.push(opened.length)
      })

      expect(screen.getByText(/no cues in this service plan yet/i)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /open the plan editor/i }))
      expect(opened).toHaveLength(1)
    })

    it('degrades to the empty state, with an explanation, when the preload bridge is absent', async () => {
      // No controller and no `window.verger`: the screen's default `planStore` binding must
      // explain the missing bridge rather than throw (Standing Rule 5).
      expect(window.verger).toBeUndefined()
      render(
        <Landmark>
          <PlanRunner />
        </Landmark>,
      )

      expect(screen.getByText(/no cues in this service plan yet/i)).toBeInTheDocument()
      await expect(screen.findByRole('alert')).resolves.toHaveTextContent(/window\.verger/i)
    })
  })

  describe('accessibility', () => {
    it('has no axe violations while running a plan', async () => {
      const { controller } = makeController(planState({ index: 1, firedCueIds: ['cue-1'] }))
      const { container } = render(
        <Landmark>
          <PlanRunner controller={controller} />
        </Landmark>,
      )

      await expect(axe(container)).resolves.toHaveNoViolations()
    })

    it('has no axe violations in the empty state', async () => {
      const { controller } = makeController(planState(initialPlanPosition(), []))
      const { container } = render(
        <Landmark>
          <PlanRunner
            controller={controller}
            onOpenEditor={() => {
              /* no-op */
            }}
          />
        </Landmark>,
      )

      await expect(axe(container)).resolves.toHaveNoViolations()
    })
  })
})
