/**
 * The slide grid — PowerPoint's Slide Sorter, for a service.
 *
 * This is the whole main surface of the console now: the operator sees their deck laid out the way
 * they laid it out in PowerPoint (`슬라이드 정렬 보기`), with one tile ringed as NOW and the next one
 * ringed more faintly. Everything else that used to sit on screen — thirteen tabs, a title bar, a
 * status strip, seven settings panels — has moved into the settings drawer.
 *
 * ## Why every cue gets a tile, not just the slide cues
 *
 * A "slide grid" over a plan that also contains scene, scripture, lower-third and action cues could
 * be built two ways. Filtering to slide cues only would look tidier and would be wrong: the plan's
 * pointer is `position.index` into `plan.cues`, so a filtered grid's tile number would stop matching
 * the operator's actual position the moment a non-slide cue existed, and "jump to tile 40" would fire
 * a different cue than the one under their finger. Every cue therefore gets a tile, in plan order,
 * numbered by plan index. Non-slide cues render as a typed card rather than a picture, which is also
 * the honest thing to show — there is no image to show for "switch to the Wide scene".
 *
 * For the two decks this church actually runs, every cue *is* a slide, so the grid is a pure slide
 * sorter in practice.
 *
 * ## Arrow keys are not the grid's
 *
 * A composite grid widget would normally take `ArrowRight`/`ArrowLeft` to move focus between tiles.
 * Here those keys are bound globally to *advance* and *back* (`src/shared/actions.ts`), and that wins:
 * the most-used key in a live service may not change meaning depending on which tile happens to hold
 * focus. So the grid uses a **roving tabIndex** — only the current tile is a tab stop, which keeps
 * `Tab` from wading through 102 buttons — and leaves the arrows alone. Nothing becomes unreachable:
 * every cue is reachable sequentially with the global keys, `Enter` fires the focused tile, and a
 * pointer or touchscreen can jump anywhere.
 *
 * ## The scroll rule that matters
 *
 * The grid follows the current slide, and **stops following while the operator is scrolling by
 * hand**. A booth operator looking ahead at what is coming in ten minutes must not be yanked back to
 * NOW because the service advanced; equally, if they have not touched anything, the current slide
 * must never be off-screen. {@link MANUAL_SCROLL_GRACE_MS} is that grace period, and the pointer /
 * wheel / touch listeners are what start it.
 *
 * ## Standing Rule 4
 *
 * A slide is an **opaque image**. This component paints the picture and the plan's own slide number.
 * It never reads text out of a slide, and there is no code path here that could.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import clsx from 'clsx'
import { LayoutGrid } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Cue } from '@shared/plan'
import { cuePayloadSchemas } from '@shared/plan'

import type { AssetUrlResolver } from './CuePreview'
import { CUE_TYPE_ICONS, defaultAssetUrl } from './CuePreview'

/**
 * How long the grid stops auto-following after the operator scrolls by hand.
 *
 * Long enough to read the tiles either side of where they stopped, short enough that they are not
 * left staring at the wrong part of the service two cues later. Any manual scroll restarts it.
 */
export const MANUAL_SCROLL_GRACE_MS = 1500

/**
 * How many tiles either side of the current one are fetched eagerly.
 *
 * BLUEPRINT.md §4 promises the next slide is pre-loaded so firing is instant, and this is where that
 * happens now. Everything outside the window is `loading="lazy"` — a 102-slide deck is roughly 50 MB
 * of PNG, and fetching all of it on open would stall a 1366×768 church PC for seconds.
 */
export const EAGER_TILE_RADIUS = 3

/** The slide image path for a slide cue, or `null` for any other cue or a malformed payload. */
export function slideAsset(cue: Cue): string | null {
  if (cue.type !== 'slide') return null
  const parsed = cuePayloadSchemas.slide.safeParse(cue.payload)
  return parsed.success ? parsed.data.asset : null
}

/** Whether this environment has asked for no motion. Guarded: jsdom has no `matchMedia`. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface SlideGridProps {
  readonly cues: readonly Cue[]
  /** `position.index` — `-1` before the first cue has fired. */
  readonly currentIndex: number
  /** Fired cue ids, exposed as `data-fired` for diagnostics. Not a visual channel. */
  readonly firedCueIds?: readonly string[]
  /** The operator tapped a tile: fire that cue and move the pointer to it. */
  readonly onSelect: (cueId: string) => void
  /** True while a plan round trip is in flight, so a double-tap cannot double-fire. */
  readonly busy?: boolean
  /** Defaults to {@link defaultAssetUrl}. */
  readonly assetUrl?: AssetUrlResolver
  /** Offered by the empty state, to open the plan section of the drawer. */
  readonly onOpenPlan?: () => void
  /** Injectable clock for the manual-scroll grace period. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Injectable so tests are not at the mercy of smooth scrolling. */
  readonly scrollBehavior?: ScrollBehavior
}

export function SlideGrid({
  cues,
  currentIndex,
  firedCueIds = [],
  onSelect,
  busy = false,
  assetUrl = defaultAssetUrl,
  onOpenPlan,
  now = Date.now,
  scrollBehavior,
}: SlideGridProps): React.JSX.Element {
  const { t } = useTranslation()

  /**
   * Assets whose image failed to load.
   *
   * A refused path is already handled by the resolver returning `null`; this covers the path that
   * resolves and then 404s, which is the likelier failure on a strange machine — the plan came across
   * to the USB stick but its `assets\slides\` folder did not, or the overlay server is not up yet.
   * Without it the operator gets a wall of empty rectangles with no explanation, because `alt=""`
   * renders as nothing. With it they get the same labelled placeholder a non-slide cue gets, which is
   * what `RUNBOOK.md` tells them to look for.
   */
  const [failedAssets, setFailedAssets] = useState<ReadonlySet<string>>(() => new Set())

  const noteFailedAsset = useCallback((asset: string): void => {
    setFailedAssets((previous) => {
      if (previous.has(asset)) return previous
      const next = new Set(previous)
      next.add(asset)
      return next
    })
  }, [])

  const currentTileRef = useRef<HTMLLIElement | null>(null)
  /** When the operator last scrolled by hand. `0` means "never", so the first follow always runs. */
  const lastManualScrollAt = useRef(0)

  const noteManualScroll = useCallback((): void => {
    lastManualScrollAt.current = now()
  }, [now])

  const behavior: ScrollBehavior = scrollBehavior ?? (prefersReducedMotion() ? 'auto' : 'smooth')

  // Follow the current slide — unless the operator is scrolling, in which case stay out of the way.
  useEffect(() => {
    const node = currentTileRef.current
    if (node === null) return
    if (now() - lastManualScrollAt.current < MANUAL_SCROLL_GRACE_MS) return
    // jsdom does not implement `scrollIntoView`, and a live surface may not fall over because a
    // test environment lacks a scroll API.
    if (typeof node.scrollIntoView !== 'function') return
    // `block: 'nearest'` rather than `'center'`: if the tile is already visible this is a no-op,
    // which is the difference between "keep it in view" and "recentre the grid on every advance".
    node.scrollIntoView({ behavior, block: 'nearest' })
  }, [currentIndex, cues, behavior, now])

  const firedSet = useMemo(() => new Set(firedCueIds), [firedCueIds])

  if (cues.length === 0) {
    return (
      <section
        aria-label={t('console.grid.label')}
        className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <LayoutGrid aria-hidden="true" className="h-12 w-12 text-text-muted" />
        <h2 className="text-balance text-title text-text">{t('console.grid.empty.title')}</h2>
        <p className="max-w-prose text-pretty text-body text-text-muted">
          {t('console.grid.empty.body')}
        </p>
        {onOpenPlan === undefined ? null : (
          // Opening a plan is a ready/go action, so it wears preview green as a border and a tint.
          // The old `hover:bg-accent` would now paint a light chalk surface, which ERGO-1 forbids.
          <button
            type="button"
            data-testid="grid-open-plan"
            onClick={onOpenPlan}
            className="inline-flex min-h-touch-lg items-center justify-center rounded-panel border border-live bg-live/10 px-6 text-label uppercase tracking-[0.08em] text-text shadow-edge transition-colors duration-[120ms] ease-instrument hover:bg-surface-3"
          >
            {t('console.grid.empty.action')}
          </button>
        )}
      </section>
    )
  }

  return (
    <section
      aria-label={t('console.grid.label')}
      data-testid="slide-grid"
      onWheel={noteManualScroll}
      onTouchMove={noteManualScroll}
      onPointerDown={noteManualScroll}
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-3"
    >
      <ul
        // `repeat(auto-fill, minmax(220px, 1fr))`: five columns at 1366px, eight at 1920, and a
        // 220×124 tile is far past the 44px floor without anybody having to pick a breakpoint.
        //
        // `gap-3` (12px) is STRUCTURAL, not taste. The NOW frame extends 5px beyond the tile box on
        // every side (3px ring + 2px offset), so two adjacent frames consume 10px of the gap.
        // Tightening this to `gap-2` makes the program frame collide with its neighbour.
        className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]"
      >
        {cues.map((cue, index) => {
          const isCurrent = index === currentIndex
          const isNext = index === currentIndex + 1
          const asset = slideAsset(cue)
          const url =
            asset === null || failedAssets.has(asset) ? null : assetUrl(asset)
          const Icon = CUE_TYPE_ICONS[cue.type]
          const eager = Math.abs(index - currentIndex) <= EAGER_TILE_RADIUS

          return (
            <li
              key={cue.id}
              ref={isCurrent ? currentTileRef : null}
              data-cue-id={cue.id}
              data-slide-number={String(index + 1)}
              data-current={isCurrent ? 'true' : 'false'}
              data-next={isNext ? 'true' : 'false'}
              data-fired={firedSet.has(cue.id) ? 'true' : 'false'}
            >
              <button
                type="button"
                // `aria-current="step"` carries the operator's position for a screen reader, so the
                // frame below is never the only channel saying which slide is live.
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={t('console.grid.tile', { number: index + 1, label: cue.label })}
                // Roving tabIndex — see the module note on why the arrows are not ours.
                tabIndex={isCurrent || (currentIndex < 0 && index === 0) ? 0 : -1}
                disabled={busy}
                onClick={() => {
                  onSelect(cue.id)
                }}
                className={clsx(
                  'group relative block w-full rounded-tile border bg-background',
                  // Colour and edges only. The tile physically cannot move or fade: a wave of
                  // lifting thumbnails across a 102-tile instrument surface reads, in peripheral
                  // vision, as a cue firing.
                  'transition-[border-color,box-shadow] duration-[120ms] ease-instrument',
                  'disabled:cursor-not-allowed',
                  'hover:border-accent-hover',
                  // The 1px page-black gutter between any state frame and the artwork. Load-bearing:
                  // program red against a mid-grey slide is 1.02:1, so without this the NOW frame
                  // would vanish into a real deck.
                  'shadow-keyline',
                  isCurrent
                    ? // PROGRAM. Outside in: 3px red ring, 2px page-black gap, 1px red border, 1px
                      // keyline, artwork — so red's faces only ever touch #0d0d0c, at 5.30:1.
                      'border-tally ring-[3px] ring-tally ring-offset-2 ring-offset-background'
                    : isNext
                      ? // PREVIEW. A single 2px green line: structurally different from NOW (no
                        // offset gap, no rail) and a third of its mass, so the two read apart by
                        // shape before they read apart by hue.
                        'border-live ring-1 ring-live'
                      : 'border-border',
                )}
              >
                {/*
                  No dimming, anywhere. `opacity` was writing to the same channel as
                  `disabled:opacity-60`, so a hundred of a hundred and two tiles read as dead
                  controls — and it dimmed the operator's wayfinding number along with the artwork.
                  Calm comes from the chrome instead: a hairline, the ink gutter, and the fact that a
                  non-current tile carries no emphasis treatment at all.
                */}
                <span className="relative block aspect-[16/9] w-full overflow-hidden rounded-[3px] bg-background">
                  {url === null ? (
                    <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                      <Icon aria-hidden="true" className="h-6 w-6 shrink-0 text-text-muted" />
                      <span className="line-clamp-2 text-meta text-text-muted">{cue.label}</span>
                    </span>
                  ) : (
                    // `alt=""`: the operator's own numbering carries the meaning, and the slide's
                    // text is never read out of the image (Standing Rule 4).
                    <img
                      src={url}
                      alt=""
                      loading={eager ? 'eager' : 'lazy'}
                      decoding="async"
                      onError={() => {
                        if (asset !== null) noteFailedAsset(asset)
                      }}
                      data-testid="slide-tile-image"
                      data-asset={asset ?? ''}
                      className="h-full w-full object-contain"
                    />
                  )}
                </span>

                {/*
                  A flush-mounted corner tab, not a floating pill. Opaque `bg-surface` on purpose: a
                  label the operator needs may never be composited over somebody else's pixels.
                */}
                <span className="absolute left-0 top-0 z-10 rounded-br-chip rounded-tl-tile bg-surface px-1 py-px font-num text-micro tabular-nums text-text-muted">
                  {index + 1}
                </span>

                {isCurrent || isNext ? (
                  <span
                    className={clsx(
                      'absolute right-0 top-0 z-10 rounded-bl-chip rounded-tr-tile bg-surface px-1 py-px text-micro uppercase text-text ring-1 ring-inset',
                      isCurrent ? 'ring-tally' : 'ring-live',
                    )}
                  >
                    {isCurrent ? t('console.grid.now') : t('console.grid.next')}
                  </span>
                ) : null}

                {/* The program-bus rail: a filled saturated field, which by this theme's one rule
                    means a STATE of the system rather than an affordance. */}
                {isCurrent ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-1 rounded-b-[2px] bg-tally"
                  />
                ) : null}

                {/* Read direction by position, not brightness — and it finally makes `data-fired`
                    mean something on screen. */}
                {!isCurrent && !isNext && firedSet.has(cue.id) ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-[2px] rounded-b-[2px] bg-border-strong"
                  />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default SlideGrid
