/**
 * The plan editor's contract — the manual-first assertions of Phase 6.
 *
 * Six of these are load-bearing rather than descriptive:
 *
 *  - **Reordering works from the KEYBOARD.** Not "the drag library is wired up" — an actual
 *    Space / ArrowDown / Space sequence on the grip handle, asserted to produce a reordered plan
 *    on the wire. A booth operator on a trackpad at 7am, or anyone who does not use a pointer at
 *    all, has to be able to move a cue.
 *  - **The unavailable importer explains itself and is disabled.** This machine genuinely has no
 *    PowerPoint converter, so this is the ordinary path here, not an edge case. The control is
 *    disabled *and* the backend's own `detail` is printed *and* pressing it sends nothing.
 *  - **Import progress renders stage and counts.** A slow conversion must not look frozen.
 *  - **Deleting a cue needs the full hold.** A short press produces zero `plan.set` calls.
 *  - **A scripture cue offers no text field.** Standing Rule 4, asserted through the UI: there is
 *    no textbox whose accessible name mentions text, and the explanatory note is present.
 *  - **The dirty indicator moves.** "Did I save that?" is the question it exists to answer.
 *
 * Everything runs against `createMockVergerApi`: no OBS, no network, no .pptx.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { ok } from '@shared/result'

import '../i18n'
import { DEFAULT_HOLD_MS } from '../components/HoldButton'
import { resetPlanStore } from '../store/planStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_DECK_IMPORTER_AVAILABLE,
  MOCK_DECK_IMPORTER_UNAVAILABLE,
  installMockVergerApi,
  mockDeckImportProgress,
  mockPlanState,
} from '../test/mockVergerApi'
import { PlanEditor } from './PlanEditor'

/** The screen lives inside `<main>` in App.tsx; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Wait until the plan has hydrated, so assertions never race the initial reads. */
async function ready(): Promise<HTMLElement[]> {
  return screen.findAllByTestId(/^cue-row-/)
}

function rowIds(): string[] {
  return screen
    .getAllByTestId(/^cue-row-/)
    .map((row) => row.getAttribute('data-cue-id') ?? '')
}

/**
 * Give every cue row a real, distinct rectangle.
 *
 * jsdom reports every element as 0x0, and `@dnd-kit`'s keyboard coordinate getter decides where a
 * cue can move by comparing rect tops — with all-zero rects it has nothing to compare and the drag
 * silently goes nowhere. Stubbing the geometry is what lets the *real* sensor run in this
 * environment; nothing about the component under test is faked.
 */
function stubRowGeometry(): void {
  const rowHeight = 60
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element): DOMRect {
      const row = this.closest('[data-cue-id]')
      const list = document.querySelector('[data-testid="cue-list"]')
      if (row !== null && list !== null) {
        const index = Array.from(list.querySelectorAll('[data-cue-id]')).indexOf(row)
        const top = index * rowHeight
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 400,
          bottom: top + rowHeight - 4,
          width: 400,
          height: rowHeight - 4,
          toJSON: () => ({}),
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect
    },
  })
}

describe('PlanEditor', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ planGetState: ok(mockPlanState()) })
    resetPlanStore()
    // jsdom implements neither of these, and `@dnd-kit` reaches for both.
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = (): void => undefined
    }
  })

  afterEach(() => {
    installed.restore()
  })

  it('renders the authored plan in order, with the type and trigger of each cue', async () => {
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    expect(rowIds()).toEqual(['cue-welcome', 'cue-slide-1', 'cue-reading'])
    expect(screen.getByTestId('plan-service')).toHaveTextContent('PLACEHOLDER SERVICE')
    expect(screen.getByTestId('cue-trigger-cue-welcome')).toHaveAttribute(
      'data-trigger-mode',
      'manual',
    )
    // Nothing has fired, so the first cue is "next" rather than "on screen".
    expect(screen.getByTestId('cue-row-cue-welcome')).toHaveAttribute('data-position', 'next')
  })

  it('highlights the cue on screen and the next one distinctly', async () => {
    installed.mock.responses.planGetState = ok(
      mockPlanState({ position: { index: 1, firedCueIds: ['cue-slide-1'] } }),
    )
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(screen.getByTestId('cue-row-cue-slide-1')).toHaveAttribute('data-position', 'current')
    })
    expect(screen.getByTestId('cue-row-cue-reading')).toHaveAttribute('data-position', 'next')
    expect(screen.getByTestId('cue-row-cue-welcome')).toHaveAttribute('data-position', 'other')
    expect(screen.getByTestId('driver-next')).toHaveTextContent('PLACEHOLDER READING')
  })

  it('reorders a cue from the KEYBOARD, and persists the new order', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()
    stubRowGeometry()

    const handle = screen.getByTestId('cue-drag-cue-welcome')
    handle.focus()
    // Space picks the cue up, ArrowDown moves it one slot, Space drops it. No pointer involved.
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowDown]')
    await user.keyboard('[Space]')

    await waitFor(() => {
      expect(installed.mock.calls.planSet).toHaveLength(1)
    })
    expect(installed.mock.calls.planSet[0]?.cues.map((cue) => cue.id)).toEqual([
      'cue-slide-1',
      'cue-welcome',
      'cue-reading',
    ])
    expect(rowIds()).toEqual(['cue-slide-1', 'cue-welcome', 'cue-reading'])
  })

  it('adds a cue on a manual trigger and opens it in the editor', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.selectOptions(screen.getByLabelText(/type of cue to add/i), 'lowerthird')
    await user.click(screen.getByTestId('plan-add-cue'))

    await waitFor(() => {
      expect(installed.mock.calls.planSet).toHaveLength(1)
    })
    const pushed = installed.mock.calls.planSet[0]
    expect(pushed?.cues).toHaveLength(4)
    // Phase 6's premise: there is no path through this UI that authors a non-manual cue by accident.
    expect(pushed?.cues[3]?.trigger).toEqual({ mode: 'manual' })
    expect(pushed?.cues[3]?.type).toBe('lowerthird')
    expect(await screen.findByTestId('cue-editor')).toBeInTheDocument()
  })

  it('fires a single cue by its play button, and moves the pointer to it', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByTestId('cue-fire-cue-reading'))

    await waitFor(() => {
      expect(installed.mock.calls.planFireCue).toEqual([{ cueId: 'cue-reading' }])
    })
    expect(screen.getByTestId('driver-current')).toHaveTextContent('PLACEHOLDER READING')
    // Firing a cue is not a camera switch and not an overlay command.
    expect(installed.mock.calls.cameraSelect).toEqual([])
  })

  it('advances and steps back by hand — the whole manual driver, with no ASR', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByTestId('plan-advance'))
    await waitFor(() => {
      expect(installed.mock.calls.planAdvance).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId('cue-row-cue-welcome')).toHaveAttribute('data-position', 'current')
    })

    await user.click(screen.getByTestId('plan-back'))
    await waitFor(() => {
      expect(installed.mock.calls.planBack).toHaveLength(1)
    })
  })

  it('says plainly that no converter is installed, and disables import rather than failing on click', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    const importButton = await screen.findByTestId('plan-import')
    await waitFor(() => {
      expect(importButton).toBeDisabled()
    })

    const notice = screen.getByTestId('importer-unavailable')
    // The backend's own sentence, verbatim — not a generic "unavailable".
    expect(notice).toHaveTextContent(MOCK_DECK_IMPORTER_UNAVAILABLE.detail ?? '')
    expect(notice).toHaveTextContent(/install libreoffice/i)
    // And what to do in the meantime, because "come back when you have installed something" is
    // not an answer on a Sunday morning.
    expect(notice).toHaveTextContent(/export the deck to png/i)
    // The reason is the button's accessible description, not merely nearby decoration.
    expect(importButton).toHaveAccessibleDescription(/no powerpoint converter is installed/i)

    await user.click(importButton)
    expect(installed.mock.calls.planImportDeck).toEqual([])
  })

  it('renders import progress with the stage and the slide count', async () => {
    installed.mock.responses.planGetImporterStatus = ok(MOCK_DECK_IMPORTER_AVAILABLE)
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(screen.getByTestId('plan-import')).toBeEnabled()
    })

    act(() => {
      installed.mock.emit(IpcEvent.planImportProgress, mockDeckImportProgress())
    })

    const progress = await screen.findByTestId('import-progress')
    expect(progress).toHaveAttribute('data-stage', 'converting')
    expect(progress).toHaveTextContent(/converting slides to images/i)
    expect(screen.getByTestId('import-progress-count')).toHaveTextContent('3 of 12 slides')
    expect(screen.getByRole('progressbar', { name: /import progress/i })).toBeInTheDocument()
  })

  it('offers a scripture cue a reference and no text box, and says why', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByTestId('cue-select-cue-reading'))

    const editor = await screen.findByTestId('cue-editor')
    expect(within(editor).getByLabelText(/^reference$/i)).toHaveValue('John 3:16')
    expect(within(editor).getByTestId('scripture-no-text-note')).toHaveTextContent(
      /never written into the plan file/i,
    )
    // There is no field for the verse itself, under any name.
    expect(within(editor).queryByLabelText(/verse text/i)).toBeNull()
    expect(within(editor).queryByLabelText(/^text$/i)).toBeNull()
    expect(within(editor).queryByRole('textbox', { name: /body|verse|passage text/i })).toBeNull()
  })

  it('rejects a non-manual trigger with no text, in words, at authoring time', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByTestId('cue-select-cue-slide-1'))
    const editor = await screen.findByTestId('cue-editor')
    await user.selectOptions(within(editor).getByLabelText(/fires when/i), 'anchor')

    const error = await within(editor).findByTestId('trigger-text-error')
    expect(error).toHaveTextContent(/needs text to match against/i)
    expect(within(editor).getByLabelText(/text to match/i)).toHaveAttribute('aria-invalid', 'true')
    // Announced, not merely coloured: the field's error is its accessible description.
    expect(within(editor).getByLabelText(/text to match/i)).toHaveAccessibleDescription(
      /needs text to match against/i,
    )
    // And the cue is refused as a whole, so nobody saves a cue that can never fire.
    expect(within(editor).getByText(/not valid yet and will not save/i)).toBeInTheDocument()
  })

  it('shows the dirty indicator once an edit lands, and clears it on save', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    expect(screen.getByTestId('plan-dirty')).toHaveAttribute('data-dirty', 'false')
    expect(screen.getByTestId('plan-dirty')).toHaveTextContent(/saved/i)

    await user.click(screen.getByTestId('plan-add-cue'))
    await waitFor(() => {
      expect(screen.getByTestId('plan-dirty')).toHaveAttribute('data-dirty', 'true')
    })
    expect(screen.getByTestId('plan-dirty')).toHaveTextContent(/unsaved changes/i)

    await user.click(screen.getByTestId('plan-save'))
    await waitFor(() => {
      expect(screen.getByTestId('plan-dirty')).toHaveAttribute('data-dirty', 'false')
    })
    expect(installed.mock.calls.planSave).toHaveLength(1)
  })

  it('persists an edited label once the typing settles', async () => {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByTestId('cue-select-cue-slide-1'))
    const editor = await screen.findByTestId('cue-editor')
    await user.clear(within(editor).getByLabelText(/^label$/i))
    await user.type(within(editor).getByLabelText(/^label$/i), 'SLIDE 2')

    await waitFor(() => {
      expect(installed.mock.calls.planSet).toHaveLength(1)
    })
    // One write for the whole burst of typing, not one per character.
    expect(installed.mock.calls.planSet[0]?.cues[1]?.label).toBe('SLIDE 2')
    expect(screen.getByTestId('cue-row-cue-slide-1')).toHaveTextContent('SLIDE 2')
  })

  it('has no axe violations, list and editor together', async () => {
    const user = userEvent.setup()
    const { container } = render(<PlanEditor />, { wrapper: Landmark })
    await ready()

    // With the editor panel open, so its fields, fieldsets and the hold-to-delete button are all
    // in the tree being audited rather than only the list.
    await user.click(screen.getByTestId('cue-select-cue-reading'))
    await screen.findByTestId('cue-editor')

    expect(await axe(container)).toHaveNoViolations()
  })
})

/**
 * Deleting a cue, on fake timers.
 *
 * Its own block so the hold timer is driven deliberately. `fireEvent` rather than `userEvent` for
 * the same reason `HoldButton`'s own suite uses it: a real 1.5-second wait is slow and flaky, and
 * the component accumulates elapsed time from interval ticks precisely so it is deterministic.
 */
describe('PlanEditor delete', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ planGetState: ok(mockPlanState()) })
    resetPlanStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    installed.restore()
  })

  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  async function openDeleteButton(): Promise<HTMLElement> {
    const user = userEvent.setup()
    render(<PlanEditor />, { wrapper: Landmark })
    await screen.findAllByTestId(/^cue-row-/)
    await user.click(screen.getByTestId('cue-select-cue-slide-1'))
    await screen.findByTestId('cue-editor')
    return screen.getByRole('button', { name: /delete cue/i })
  }

  it('does not delete on a short press', async () => {
    const button = await openDeleteButton()
    vi.useFakeTimers()

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS - 200)
    fireEvent.pointerUp(button)
    advance(500)

    expect(installed.mock.calls.planSet).toEqual([])
    expect(screen.getAllByTestId(/^cue-row-/)).toHaveLength(3)
  })

  it('deletes only after the full hold', async () => {
    const button = await openDeleteButton()
    vi.useFakeTimers()

    fireEvent.pointerDown(button)
    advance(DEFAULT_HOLD_MS + 100)

    expect(installed.mock.calls.planSet).toHaveLength(1)
    expect(installed.mock.calls.planSet[0]?.cues.map((cue) => cue.id)).toEqual([
      'cue-welcome',
      'cue-reading',
    ])
  })
})
