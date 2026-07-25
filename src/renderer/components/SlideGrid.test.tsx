/**
 * The slide grid's contract — the main surface of the console after the TASK 2 redesign.
 *
 * Three assertions in here are load-bearing, and each one guards a mistake the module comment in
 * `SlideGrid.tsx` says was considered and rejected:
 *
 * 1. **Every cue gets a tile, numbered by plan index.** Filtering to slide cues would look tidier
 *    and would desynchronise the tile number from `PlanPosition.index`, so "jump to tile N" would
 *    fire a cue the operator is not pointing at. The mixed-plan numbering test is the guard.
 * 2. **The grid stops following while the operator scrolls by hand.** An operator looking ten
 *    minutes ahead must not be yanked back to NOW because the service advanced — but if they have
 *    not touched anything, the current slide must never be off-screen. Both halves of that are
 *    asserted against a driven clock, because the interesting one is an *absence* of a call.
 * 3. **Only the near tiles are fetched eagerly.** A 102-slide deck is roughly 50 MB of PNG; the
 *    `loading` attribute is the whole defence on a 1366×768 church PC, and it is invisible on a
 *    screenshot, so it is asserted directly against {@link EAGER_TILE_RADIUS}.
 *
 * ## Fixtures
 *
 * Standing Rule 4: every label here is an obvious placeholder — "SLIDE 1", "PLACEHOLDER TITLE".
 * The scripture cue carries a *reference* and nothing else, which is all `ScripturePayload` can
 * hold by construction. Slides are opaque images with `alt=""`; no text is ever read out of one.
 *
 * ## No store to reset
 *
 * `SlideGrid` is fully prop-driven — it touches no zustand store and no preload bridge — so there
 * is deliberately no store reset in `beforeEach`. The injectable `now` and `assetUrl` seams are
 * what make it testable without one.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Cue } from '@shared/plan'

import '../i18n'
import { MOCK_NOW, mockCue } from '../test/mockVergerApi'
import type { AssetUrlResolver } from './CuePreview'
import { EAGER_TILE_RADIUS, MANUAL_SCROLL_GRACE_MS, SlideGrid, slideAsset } from './SlideGrid'

/** The grid renders a `<section>` landmark; axe's `region` rule expects it inside a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

// --- Fixtures. Placeholders only, per Standing Rule 4. ------------------------------------------

/** A deterministic resolver, so a test never depends on the overlay server's port or route. */
const testAssetUrl: AssetUrlResolver = (asset) => `/assets/${asset}`

function slideAssetPath(number: number): string {
  return `slides/slide-${String(number).padStart(3, '0')}.png`
}

function slideCue(number: number): Cue {
  return mockCue({
    id: `cue-slide-${number}`,
    type: 'slide',
    label: `SLIDE ${number}`,
    payload: { asset: slideAssetPath(number), sourceSlide: number },
  })
}

const CUE_LOWER_THIRD: Cue = mockCue({
  id: 'cue-lower-third',
  type: 'lowerthird',
  label: 'PLACEHOLDER TITLE',
  payload: { line1: 'PLACEHOLDER NAME', line2: 'PLACEHOLDER ROLE' },
})

const CUE_SCRIPTURE: Cue = mockCue({
  id: 'cue-reading',
  type: 'scripture',
  // A REFERENCE. `ScripturePayload` has no `text` field, deliberately.
  label: 'PLACEHOLDER READING',
  payload: { reference: 'John 3:16' },
})

/**
 * A mixed plan: slide, lower third, scripture, slide.
 *
 * Mixed on purpose — this is the fixture that proves tile numbering follows the *plan* index and
 * not a filtered slides-only index.
 */
const MIXED_CUES: readonly Cue[] = [slideCue(1), CUE_LOWER_THIRD, CUE_SCRIPTURE, slideCue(2)]

/** Long enough that tiles exist both inside and outside the eager window. */
const DECK: readonly Cue[] = Array.from({ length: 12 }, (_, index) => slideCue(index + 1))

// --- Harness ------------------------------------------------------------------------------------

interface GridOverrides {
  readonly cues?: readonly Cue[]
  readonly currentIndex?: number
  readonly firedCueIds?: readonly string[]
  readonly busy?: boolean
  readonly assetUrl?: AssetUrlResolver
  readonly onOpenPlan?: () => void
  readonly now?: () => number
}

interface GridHarness {
  readonly container: HTMLElement
  /** Every cue id `onSelect` was called with, in order. Assert against this, not on a spy. */
  readonly selected: string[]
  /** Move the plan pointer, the way a fired cue would. */
  readonly moveTo: (currentIndex: number) => void
}

function renderGrid(overrides: GridOverrides = {}): GridHarness {
  const selected: string[] = []
  const cues = overrides.cues ?? MIXED_CUES
  const firedCueIds = overrides.firedCueIds ?? []
  const busy = overrides.busy ?? false
  const assetUrl = overrides.assetUrl ?? testAssetUrl
  const now = overrides.now ?? ((): number => MOCK_NOW)

  const node = (currentIndex: number): React.JSX.Element => (
    <Landmark>
      <SlideGrid
        cues={cues}
        currentIndex={currentIndex}
        firedCueIds={firedCueIds}
        onSelect={(cueId) => {
          selected.push(cueId)
        }}
        busy={busy}
        assetUrl={assetUrl}
        now={now}
        // Injected so a test is not at the mercy of smooth scrolling.
        scrollBehavior="auto"
        {...(overrides.onOpenPlan === undefined ? {} : { onOpenPlan: overrides.onOpenPlan })}
      />
    </Landmark>
  )

  const view = render(node(overrides.currentIndex ?? 0))
  return {
    container: view.container,
    selected,
    moveTo: (currentIndex) => {
      view.rerender(node(currentIndex))
    },
  }
}

/** The `<li>` for a cue. Throws rather than returning null, so a failure names the missing tile. */
function tile(container: HTMLElement, cueId: string): HTMLElement {
  const node = container.querySelector(`li[data-cue-id="${cueId}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`no tile rendered for cue "${cueId}"`)
  return node
}

function attributes(container: HTMLElement, selector: string, attribute: string): (string | null)[] {
  return Array.from(container.querySelectorAll(selector)).map((node) =>
    node.getAttribute(attribute),
  )
}

/** The plan-index numbers of the tiles whose descendants match `selector`. */
function slideNumbersOf(container: HTMLElement, selector: string): (string | null)[] {
  return Array.from(container.querySelectorAll(selector)).map(
    (node) => node.closest('li')?.getAttribute('data-slide-number') ?? null,
  )
}

describe('SlideGrid', () => {
  describe('one tile per cue, numbered by plan index', () => {
    it('renders every cue in plan order, including the ones that are not slides', () => {
      const { container } = renderGrid({ currentIndex: 0 })

      expect(container.querySelectorAll('li[data-cue-id]')).toHaveLength(MIXED_CUES.length)
      expect(attributes(container, 'li[data-cue-id]', 'data-cue-id')).toEqual([
        'cue-slide-1',
        'cue-lower-third',
        'cue-reading',
        'cue-slide-2',
      ])
      // The assertion this file exists for: numbering is the *plan* index + 1, so the lower third
      // and the reading each consume a number. A slides-only grid would number the second slide 2.
      expect(attributes(container, 'li[data-cue-id]', 'data-slide-number')).toEqual([
        '1',
        '2',
        '3',
        '4',
      ])
      expect(tile(container, 'cue-slide-2')).toHaveAttribute('data-slide-number', '4')
    })

    it('puts the number and the cue label in each tile’s accessible name', () => {
      renderGrid({ currentIndex: 0 })

      expect(screen.getByRole('button', { name: 'Slide 1: SLIDE 1' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Slide 3: PLACEHOLDER READING' })).toBeInTheDocument()
    })

    it('exposes which cues have already fired', () => {
      const { container } = renderGrid({
        currentIndex: 1,
        firedCueIds: ['cue-slide-1', 'cue-lower-third'],
      })

      expect(tile(container, 'cue-slide-1')).toHaveAttribute('data-fired', 'true')
      expect(tile(container, 'cue-lower-third')).toHaveAttribute('data-fired', 'true')
      expect(tile(container, 'cue-reading')).toHaveAttribute('data-fired', 'false')
    })
  })

  describe('NOW and NEXT', () => {
    it('marks exactly one tile current and exactly one tile next', () => {
      const { container } = renderGrid({ currentIndex: 1 })

      expect(container.querySelectorAll('li[data-current="true"]')).toHaveLength(1)
      expect(container.querySelectorAll('li[data-next="true"]')).toHaveLength(1)
      expect(tile(container, 'cue-lower-third')).toHaveAttribute('data-current', 'true')
      expect(tile(container, 'cue-reading')).toHaveAttribute('data-next', 'true')
      expect(tile(container, 'cue-slide-1')).toHaveAttribute('data-current', 'false')
      expect(tile(container, 'cue-slide-1')).toHaveAttribute('data-next', 'false')
    })

    it('announces the current tile, so the accent ring is never the only signal', () => {
      const { container } = renderGrid({ currentIndex: 1 })

      expect(container.querySelectorAll('button[aria-current]')).toHaveLength(1)
      expect(within(tile(container, 'cue-lower-third')).getByRole('button')).toHaveAttribute(
        'aria-current',
        'step',
      )
    })

    it('has no current tile before the first cue has fired, and offers tile 1 as next', () => {
      // `PlanPosition.index === -1` is the launch state: nothing has fired, so nothing is live.
      const { container } = renderGrid({ currentIndex: -1 })

      expect(container.querySelectorAll('li[data-current="true"]')).toHaveLength(0)
      expect(container.querySelectorAll('button[aria-current]')).toHaveLength(0)
      expect(container.querySelectorAll('li[data-next="true"]')).toHaveLength(1)
      expect(tile(container, 'cue-slide-1')).toHaveAttribute('data-next', 'true')
      // …and the first tile is still the roving tab stop, or `Tab` could not reach the grid at all.
      expect(within(tile(container, 'cue-slide-1')).getByRole('button')).toHaveAttribute(
        'tabindex',
        '0',
      )
    })

    it('has no next tile on the last cue of the plan', () => {
      const { container } = renderGrid({ currentIndex: MIXED_CUES.length - 1 })

      expect(container.querySelectorAll('li[data-next="true"]')).toHaveLength(0)
      expect(tile(container, 'cue-slide-2')).toHaveAttribute('data-current', 'true')
    })
  })

  describe('firing a cue', () => {
    it('reports the tapped cue’s id, not its tile number', async () => {
      const user = userEvent.setup()
      const { selected } = renderGrid({ currentIndex: 0 })

      await user.click(screen.getByRole('button', { name: 'Slide 3: PLACEHOLDER READING' }))

      expect(selected).toEqual(['cue-reading'])
    })

    it('disables every tile while a plan round trip is in flight, so a double-tap cannot double-fire', () => {
      const busyGrid = renderGrid({ currentIndex: 0, busy: true })

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(MIXED_CUES.length)
      for (const button of buttons) expect(button).toBeDisabled()

      const press = (harness: GridHarness): void => {
        fireEvent.click(within(tile(harness.container, 'cue-reading')).getByRole('button'))
      }

      press(busyGrid)
      expect(busyGrid.selected).toEqual([])

      // The same press on an idle grid *does* fire, so the assertion above is about `busy` and not
      // about `fireEvent.click` quietly doing nothing.
      cleanup()
      const idleGrid = renderGrid({ currentIndex: 0 })
      press(idleGrid)
      expect(idleGrid.selected).toEqual(['cue-reading'])
    })
  })

  describe('what a tile shows', () => {
    it('paints a slide cue as an image, addressed by its plan-relative asset', () => {
      const { container } = renderGrid({ currentIndex: 0 })

      const image = within(tile(container, 'cue-slide-1')).getByTestId('slide-tile-image')
      expect(image).toHaveAttribute('data-asset', slideAssetPath(1))
      expect(image).toHaveAttribute('src', `/assets/${slideAssetPath(1)}`)
      // `alt=""`: the operator's own numbering carries the meaning, and no text is ever read out
      // of a slide image (Standing Rule 4).
      expect(image).toHaveAttribute('alt', '')
    })

    it('renders no image for a cue that has no picture, but still names it', () => {
      const { container } = renderGrid({ currentIndex: 0 })

      // There is no picture of "show the lower third" or of a scripture reference.
      expect(tile(container, 'cue-lower-third').querySelector('img')).toBeNull()
      expect(tile(container, 'cue-reading').querySelector('img')).toBeNull()
      expect(tile(container, 'cue-lower-third')).toHaveTextContent('PLACEHOLDER TITLE')
      expect(tile(container, 'cue-reading')).toHaveTextContent('PLACEHOLDER READING')

      // Exactly the two slide cues produced an image.
      expect(screen.getAllByTestId('slide-tile-image')).toHaveLength(2)
    })

    it('falls back to the label rather than a broken image when the asset cannot be served', () => {
      const traversal = mockCue({
        id: 'cue-bad',
        type: 'slide',
        label: 'SLIDE 1',
        payload: { asset: '../../secrets/slide.png' },
      })
      const { container } = renderGrid({
        cues: [traversal],
        currentIndex: 0,
        // The real `defaultAssetUrl` refuses a `..` segment by returning null; mirror that.
        assetUrl: () => null,
      })

      expect(tile(container, 'cue-bad').querySelector('img')).toBeNull()
      expect(tile(container, 'cue-bad')).toHaveTextContent('SLIDE 1')
    })
  })

  describe('eager loading window', () => {
    it('fetches only the tiles near the current one eagerly', () => {
      const current = 5
      const { container } = renderGrid({ cues: DECK, currentIndex: current })

      // Derived from the exported constant, so a change to the window has to change this number
      // deliberately rather than silently.
      const expectedEager = Array.from(
        { length: EAGER_TILE_RADIUS * 2 + 1 },
        (_, offset) => String(current + 1 - EAGER_TILE_RADIUS + offset),
      )
      expect(slideNumbersOf(container, 'img[loading="eager"]')).toEqual(expectedEager)
      expect(expectedEager).toContain(String(current + 1))

      // …and the rest of a 12-slide deck is genuinely deferred. Both halves have to be present or
      // the assertion would pass on a grid that eagerly fetched everything.
      const lazy = slideNumbersOf(container, 'img[loading="lazy"]')
      expect(lazy).toHaveLength(DECK.length - expectedEager.length)
      expect(lazy).toContain('1')
      expect(lazy).toContain(String(DECK.length))
    })

    it('moves the window with the plan pointer', () => {
      const { container, moveTo } = renderGrid({ cues: DECK, currentIndex: 0 })

      expect(slideNumbersOf(container, 'img[loading="lazy"]')).toContain('12')

      moveTo(DECK.length - 1)

      expect(slideNumbersOf(container, 'img[loading="eager"]')).toContain('12')
      expect(slideNumbersOf(container, 'img[loading="lazy"]')).toContain('1')
    })
  })

  /**
   * jsdom implements no scroll API at all, so `scrollIntoView` is stubbed onto the prototype for
   * this block and removed again afterwards. The component's own guard means an unstubbed run
   * degrades to a no-op rather than throwing — which is why the *positive* case has to be asserted
   * here too, or a regression that stopped following would be invisible.
   */
  describe('following the current slide', () => {
    const HAD_SCROLL_INTO_VIEW = Object.prototype.hasOwnProperty.call(
      Element.prototype,
      'scrollIntoView',
    )
    const ORIGINAL_SCROLL_INTO_VIEW: typeof Element.prototype.scrollIntoView | undefined =
      Element.prototype.scrollIntoView

    /** Driven by hand: a real 1.5-second wait in a unit suite is both slow and flaky. */
    let clock = MOCK_NOW
    const now = (): number => clock
    let scrollIntoView = vi.fn()

    beforeEach(() => {
      clock = MOCK_NOW
      scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView
    })

    afterEach(() => {
      if (HAD_SCROLL_INTO_VIEW && ORIGINAL_SCROLL_INTO_VIEW !== undefined) {
        Element.prototype.scrollIntoView = ORIGINAL_SCROLL_INTO_VIEW
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      }
    })

    it('brings the current tile into view when the plan advances', () => {
      const { moveTo } = renderGrid({ cues: DECK, currentIndex: 0, now })

      // The mount itself follows: on relaunch mid-service the current slide must not be off-screen.
      expect(scrollIntoView).toHaveBeenCalled()
      scrollIntoView.mockClear()

      moveTo(7)

      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })

    it('never scroll-jacks the operator, and resumes following once they have stopped', () => {
      const { moveTo } = renderGrid({ cues: DECK, currentIndex: 0, now })
      scrollIntoView.mockClear()

      // The operator is looking ahead at what is coming in ten minutes.
      fireEvent.wheel(screen.getByTestId('slide-grid'))
      moveTo(1)
      expect(scrollIntoView).not.toHaveBeenCalled()

      // Still inside the grace period by a millisecond: still theirs, not the grid's.
      clock += MANUAL_SCROLL_GRACE_MS - 1
      moveTo(2)
      expect(scrollIntoView).not.toHaveBeenCalled()

      // Grace elapsed. Following resumes, or the current slide could stay off-screen forever.
      clock += 1
      moveTo(3)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })

    it('restarts the grace period on every hand scroll', () => {
      const { moveTo } = renderGrid({ cues: DECK, currentIndex: 0, now })
      scrollIntoView.mockClear()
      const grid = screen.getByTestId('slide-grid')

      fireEvent.wheel(grid)
      clock += MANUAL_SCROLL_GRACE_MS - 1
      // A second flick, just before the first one expired: the clock starts over.
      fireEvent.wheel(grid)
      clock += MANUAL_SCROLL_GRACE_MS - 1
      moveTo(4)

      expect(scrollIntoView).not.toHaveBeenCalled()
    })

    it('has nothing to follow before the first cue has fired', () => {
      renderGrid({ cues: DECK, currentIndex: -1, now })

      // No tile is current at `index === -1`, so the grid must not scroll anywhere on open.
      expect(scrollIntoView).not.toHaveBeenCalled()
    })
  })

  describe('the empty plan', () => {
    it('explains itself and offers the plan editor rather than rendering a dead surface', async () => {
      const user = userEvent.setup()
      const opened: number[] = []
      renderGrid({
        cues: [],
        onOpenPlan: () => {
          opened.push(opened.length)
        },
      })

      expect(screen.getByText('No service plan is open.')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Open a plan — or import a PowerPoint deck — and every slide appears here as a tile you can tap.',
        ),
      ).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Open the plan editor' }))
      expect(opened).toHaveLength(1)
    })

    it('omits the offer when there is nowhere to send the operator', () => {
      renderGrid({ cues: [] })

      expect(screen.getByText('No service plan is open.')).toBeInTheDocument()
      expect(screen.queryByTestId('grid-open-plan')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    })
  })

  describe('slideAsset', () => {
    it('returns the asset for a slide cue', () => {
      expect(slideAsset(slideCue(1))).toBe(slideAssetPath(1))
    })

    it('returns null for a cue that is not a slide', () => {
      expect(slideAsset(CUE_SCRIPTURE)).toBeNull()
      expect(slideAsset(CUE_LOWER_THIRD)).toBeNull()
      expect(slideAsset(mockCue({ id: 'cue-scene', type: 'scene', payload: { scene: 'Wide' } }))).toBeNull()
    })

    it('returns null for a slide cue whose payload is malformed', () => {
      // An empty asset and a payload of the wrong shape are both reachable from a hand-edited or
      // badly imported plan file, and neither may become an `<img src="">`.
      expect(slideAsset(mockCue({ type: 'slide', payload: { asset: '' } }))).toBeNull()
      expect(slideAsset(mockCue({ type: 'slide', payload: { scene: 'Wide' } }))).toBeNull()
    })
  })

  describe('accessibility', () => {
    it('has no axe violations with a plan loaded', async () => {
      const { container } = renderGrid({ currentIndex: 1, firedCueIds: ['cue-slide-1'] })

      await expect(axe(container)).resolves.toHaveNoViolations()
    })

    it('has no axe violations in the empty state', async () => {
      const { container } = renderGrid({
        cues: [],
        onOpenPlan: () => {
          /* no-op */
        },
      })

      await expect(axe(container)).resolves.toHaveNoViolations()
    })
  })
})
