/**
 * The live plan surface — the screen the operator actually stares at during a service.
 *
 * BLUEPRINT.md §7 and the Phase 6 brief: the plan has to be a completely usable manual slide
 * driver with **no ASR, no cue engine and no network**. Everything here works from one key and one
 * button, and every cue's `trigger.mode` is `manual` until Phase 8 says otherwise. This is the
 * fallback the automation degrades to, so it is built first and it is built plain.
 *
 * ## The three things on screen, in priority order
 *
 * 1. **NOW and NEXT, large.** The operator must know what SPACE will do *before* pressing it. NEXT
 *    is therefore given at least as much visual weight as NOW: what is already on the congregation
 *    screen is visible on the program monitor, but what is about to be on it exists only here.
 * 2. **ADVANCE and BACK.** Big, and mirroring the keyboard exactly — the button and the key go
 *    through the same {@link ActionDispatcher} action, so a foot pedal that emits SPACE gets the
 *    identical code path (`src/shared/actions.ts`).
 * 3. **The cue list**, scrolled to the current position, with fired cues visually distinct.
 *
 * ## BACK does not re-fire, and that is a safety property
 *
 * `stepBack()` in `src/shared/plan.ts` moves the pointer and deliberately leaves `firedCueIds`
 * alone. This screen matches that: BACK calls `plan.back()` and **never** `plan.fireCue()`.
 * Re-firing on the way back would mean the undo for a mis-fire re-shows the slide the operator was
 * trying to get rid of — the exact opposite of an undo. The test file asserts the absence of that
 * call, because an absence is not something a screenshot can show.
 *
 * ## Pre-loading
 *
 * BLUEPRINT.md §4 promises "the next slide is **pre-loaded** so firing is instant". The NEXT card's
 * thumbnail already fetches the image, and a hidden strip does the same for the couple of slide
 * cues after it, so an advance is a cache hit rather than a disk read. It costs a few kilobytes and
 * removes the one visible stutter in the manual path.
 *
 * ## Where the state comes from
 *
 * `planStore.ts` is another agent's file, read here and never written. This screen still declares
 * the **minimal seam it needs** — {@link PlanRunnerController}, seven members wide — and defaults to
 * a store-backed implementation of it. The seam is not ceremony: it is what keeps the live surface
 * unable to edit, save, import or reorder the plan (those are the editor's, and a running screen
 * that can silently rewrite the plan is a running screen that will), and it is what lets the tests
 * assert on a recording fake instead of on a module singleton.
 *
 * ## Keyboard wiring
 *
 * `useKeyboardActions` was left untouched. It already takes an {@link ActionDispatcher}, and
 * `ActionDispatcher.register(action, handler)` is the designed extension point — so the plan is
 * wired to `advance`/`back` *here*, in the consuming component, by registering two handlers. Adding
 * a second registration path inside the hook would duplicate the dispatcher and put new, untested
 * branches inside the tap/hold state machine that the SHORTCUTS_AND_A11Y incident report exists to
 * protect. Note the hook's own SPACE-hold binding still maps to PANIC; nothing here shadows it.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import clsx from 'clsx'
import { ChevronLeft, ChevronRight, CircleAlert, ListOrdered, Pencil } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionId } from '@shared/actions'
import type { PlanState } from '@shared/ipc'
import type { Cue, ServiceMode } from '@shared/plan'
import { cueAt } from '@shared/plan'
import type { AppError } from '@shared/result'

import type { AssetUrlResolver } from '../components/CuePreview'
import { CuePreview, defaultAssetUrl } from '../components/CuePreview'
import type { ActionDispatcher } from '../input/ActionDispatcher'
import { createActionDispatcher } from '../input/ActionDispatcher'
import { useKeyboardActions } from '../input/useKeyboardActions'
import { usePlanStore } from '../store/planStore'

/** How many upcoming slide assets are warmed in the hidden pre-load strip, beyond NEXT itself. */
export const PRELOAD_LOOKAHEAD = 2

/**
 * The slice of plan state and behaviour this screen needs.
 *
 * Deliberately not `PlanState & { ...everything }`: the runner may advance, step back, and fire a
 * cue the operator taps in the list. It may not edit, save, import or reorder — those belong to the
 * editor, and a live surface that can silently rewrite the plan is a live surface that will.
 */
export interface PlanRunnerController {
  /** The main process's snapshot. Never locally invented. */
  readonly state: PlanState
  /** False when `window.verger` is missing; drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True while a round trip is in flight, so a double-press cannot double-advance. */
  readonly busy: boolean
  /** The last refusal, kept so the screen can explain why a press did nothing. */
  readonly lastError: AppError | null
  /** Fire the next cue and move the pointer to it. */
  readonly advance: () => void
  /** Move the pointer back one. Fires nothing. */
  readonly back: () => void
  /** Fire one specific cue — the operator tapping a row to jump. */
  readonly fireCue: (cueId: string) => void
}

/**
 * The default controller: `planStore`, narrowed to the three things a live surface may do.
 *
 * The store is read here and never written to — it is another agent's file. Narrowing it is the
 * point: `PlanStoreState` also carries `setPlan`, `addCue`, `removeCue`, `reorderCues`, `save` and
 * `importDeck`, and none of those may be reachable from a screen the operator is pounding SPACE on
 * mid-service.
 *
 * `enabled` exists because hooks cannot be called conditionally: {@link PlanRunner} always calls
 * this, and switches the hydrate/subscribe effect off when a controller was injected, so an
 * injected controller never has a second subscription running behind it.
 */
export function usePlanStoreController(enabled = true): PlanRunnerController {
  const plan = usePlanStore((store) => store.plan)
  const position = usePlanStore((store) => store.position)
  const path = usePlanStore((store) => store.path)
  const dirty = usePlanStore((store) => store.dirty)
  const lastFired = usePlanStore((store) => store.lastFired)
  const bridgeAvailable = usePlanStore((store) => store.bridgeAvailable)
  const busy = usePlanStore((store) => store.busy)
  const lastError = usePlanStore((store) => store.lastError)
  const hydrate = usePlanStore((store) => store.hydrate)
  const subscribe = usePlanStore((store) => store.subscribe)
  const advanceAction = usePlanStore((store) => store.advance)
  const backAction = usePlanStore((store) => store.back)
  const fireCueAction = usePlanStore((store) => store.fireCue)

  useEffect(() => {
    if (!enabled) return undefined
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [enabled, hydrate, subscribe])

  // The store's actions resolve with a `Result` this screen has no use for: a refusal is already
  // recorded in `lastError` and rendered, and there is nothing sensible a button's onClick could
  // do with a rejected promise that the store has not already done.
  const advance = useCallback(() => {
    void advanceAction()
  }, [advanceAction])
  const back = useCallback(() => {
    void backAction()
  }, [backAction])
  const fireCue = useCallback(
    (cueId: string) => {
      void fireCueAction(cueId)
    },
    [fireCueAction],
  )

  const state = useMemo<PlanState>(
    () => ({ plan, position, path, dirty, lastFired }),
    [plan, position, path, dirty, lastFired],
  )

  return useMemo(
    () => ({ state, bridgeAvailable, busy, lastError, advance, back, fireCue }),
    [state, bridgeAvailable, busy, lastError, advance, back, fireCue],
  )
}

export interface PlanRunnerProps {
  /** Defaults to {@link usePlanStoreController}. A test injects a recording fake here. */
  readonly controller?: PlanRunnerController
  /** Defaults to a dispatcher owned by this screen. Pass the app-wide one once it exists. */
  readonly dispatcher?: ActionDispatcher
  /** Set false to release the keyboard — e.g. while a modal owns it. Defaults to true. */
  readonly keyboardEnabled?: boolean
  /** Called by the empty state's "open the plan editor" control. */
  readonly onOpenEditor?: () => void
  /** Defaults to {@link defaultAssetUrl}. */
  readonly assetUrl?: AssetUrlResolver
}

/** English fallbacks for the service-mode word, used until the `plan.*` locale keys land. */
const SERVICE_MODE_LABELS: Readonly<Record<ServiceMode, string>> = {
  assist: 'Assist',
  auto: 'Auto',
  manual: 'Manual',
}

/**
 * Tints for the mode badge.
 *
 * `auto` is the only one that is not muted: full autonomy is the state an operator most needs to
 * notice they are in, and Phase 8's trust dial will make it changeable. Until then this readout is
 * strictly read-only — a control that silently promoted a service to auto would be the single most
 * dangerous widget on this screen.
 */
const SERVICE_MODE_TONES: Readonly<Record<ServiceMode, string>> = {
  assist: 'text-text-muted',
  auto: 'text-accent-2',
  manual: 'text-text-muted',
}

/** Collect the upcoming slide assets worth warming, nearest first, de-duplicated. */
export function upcomingSlideAssets(
  cues: readonly Cue[],
  fromIndex: number,
  limit: number,
): readonly string[] {
  const assets: string[] = []
  for (let index = fromIndex; index < cues.length && assets.length < limit; index += 1) {
    const cue = cues[index]
    if (cue === undefined || cue.type !== 'slide') continue
    const asset = (cue.payload as { asset?: unknown }).asset
    if (typeof asset !== 'string' || asset.length === 0) continue
    if (!assets.includes(asset)) assets.push(asset)
  }
  return assets
}

export function PlanRunner({
  controller,
  dispatcher,
  keyboardEnabled = true,
  onOpenEditor,
  assetUrl = defaultAssetUrl,
}: PlanRunnerProps): React.JSX.Element {
  const { t } = useTranslation()

  const fallbackController = usePlanStoreController(controller === undefined)
  const active = controller ?? fallbackController

  const { plan, position, lastFired } = active.state
  const total = plan.cues.length
  const nowCue = cueAt(plan, position.index)
  const upNext = cueAt(plan, position.index + 1)

  // The keyboard handlers are registered once and read the newest callbacks through this ref, so a
  // re-render never leaves SPACE pointing at a stale closure mid-service.
  const latest = useRef({ advance: active.advance, back: active.back })
  useEffect(() => {
    latest.current = { advance: active.advance, back: active.back }
  })

  const ownDispatcher = useMemo(() => dispatcher ?? createActionDispatcher(), [dispatcher])

  useEffect(() => {
    const offAdvance = ownDispatcher.register(ActionId.advance, () => {
      latest.current.advance()
    })
    const offBack = ownDispatcher.register(ActionId.back, () => {
      latest.current.back()
    })
    return () => {
      offAdvance()
      offBack()
    }
  }, [ownDispatcher])

  useKeyboardActions({ dispatcher: ownDispatcher, enabled: keyboardEnabled })

  // Keep the current row on screen. `scrollIntoView` is guarded because jsdom does not implement
  // it, and a live surface may not fall over because a test environment lacks a scroll API.
  const currentRowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    const node = currentRowRef.current
    if (node === null || typeof node.scrollIntoView !== 'function') return
    node.scrollIntoView({ block: 'center' })
  }, [position.index])

  const preloadAssets = useMemo(
    () => upcomingSlideAssets(plan.cues, position.index + 1, PRELOAD_LOOKAHEAD + 1),
    [plan.cues, position.index],
  )

  const errorMessage = active.lastError === null ? null : active.lastError.message

  if (total === 0) {
    return (
      <section
        aria-label={t('plan.runner.label', { defaultValue: 'Plan runner' })}
        className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <ListOrdered aria-hidden="true" className="h-10 w-10 text-text-muted" />
        <h2 className="text-xl font-semibold text-text">
          {t('plan.empty.title', { defaultValue: 'No cues in this service plan yet.' })}
        </h2>
        <p className="max-w-prose text-sm text-text-muted">
          {active.bridgeAvailable
            ? t('plan.empty.body', {
                defaultValue:
                  'Author the order of service in the plan editor — or import a PowerPoint deck — then come back here to run it.',
              })
            : t('plan.empty.noBridge', {
                defaultValue:
                  'Verger cannot reach its main process, so no plan can be loaded. Restart the app.',
              })}
        </p>
        <button
          type="button"
          onClick={onOpenEditor}
          disabled={onOpenEditor === undefined}
          className="inline-flex min-h-touch items-center justify-center gap-2 rounded-glass border border-accent bg-surface-2 px-6 font-medium text-text transition-colors hover:bg-accent hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted"
        >
          <Pencil aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>{t('plan.empty.openEditor', { defaultValue: 'Open the plan editor' })}</span>
        </button>
        {errorMessage === null ? null : (
          <p role="alert" className="max-w-prose text-sm text-panic">
            {errorMessage}
          </p>
        )}
      </section>
    )
  }

  return (
    <section
      aria-label={t('plan.runner.label', { defaultValue: 'Plan runner' })}
      className="flex h-full min-h-0 flex-col gap-4 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">
          {plan.service.length === 0
            ? t('plan.untitledService', { defaultValue: 'Untitled service' })
            : plan.service}
        </h2>
        <div className="flex items-center gap-4">
          <p data-testid="plan-position" className="font-mono text-sm text-text-muted">
            {position.index < 0 ? '—' : String(position.index + 1)} / {String(total)}
          </p>
          {/* Read-only in Phase 6. The trust dial that changes this lands in Phase 8. */}
          <p
            data-testid="plan-mode"
            className={clsx('text-xs uppercase tracking-wide', SERVICE_MODE_TONES[plan.defaultMode])}
          >
            <span className="text-text-muted">
              {t('plan.modeLabel', { defaultValue: 'Mode' })}
              {': '}
            </span>
            {t(`plan.mode.${plan.defaultMode}`, {
              defaultValue: SERVICE_MODE_LABELS[plan.defaultMode],
            })}
          </p>
        </div>
      </header>

      {errorMessage === null ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-glass border border-panic/60 bg-surface-2 p-3 text-sm text-panic"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </p>
      )}

      <div className="grid min-h-0 gap-4 lg:grid-cols-2">
        <article
          aria-labelledby="plan-now-heading"
          data-testid="plan-now"
          className="flex flex-col gap-3 rounded-glass border border-border bg-surface p-4"
        >
          <h3 id="plan-now-heading" className="text-sm font-bold uppercase tracking-widest text-text-muted">
            {t('plan.now', { defaultValue: 'Now' })}
          </h3>
          <CuePreview
            cue={nowCue}
            assetUrl={assetUrl}
            imageTestId="plan-now-image"
            emptyLabel={t('plan.notStarted', {
              defaultValue: 'Not started. Press SPACE to fire the first cue.',
            })}
          />
        </article>

        <article
          aria-labelledby="plan-next-heading"
          data-testid="plan-next"
          className="flex flex-col gap-3 rounded-glass border border-accent/60 bg-surface p-4"
        >
          <h3 id="plan-next-heading" className="text-sm font-bold uppercase tracking-widest text-accent">
            {t('plan.next', { defaultValue: 'Next' })}
          </h3>
          <CuePreview
            cue={upNext}
            assetUrl={assetUrl}
            imageTestId="plan-next-image"
            emptyLabel={t('plan.endOfPlan', { defaultValue: 'End of the plan. Nothing follows.' })}
          />
        </article>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="plan-advance"
          onClick={active.advance}
          disabled={upNext === null || active.busy}
          className="inline-flex min-h-touch-xl flex-1 items-center justify-center gap-3 rounded-glass border border-accent-hover bg-accent px-8 text-lg font-bold text-text transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted"
        >
          <ChevronRight aria-hidden="true" className="h-6 w-6 shrink-0" />
          <span>{t('plan.advance', { defaultValue: 'Advance (SPACE)' })}</span>
        </button>
        <button
          type="button"
          data-testid="plan-back"
          onClick={active.back}
          disabled={position.index < 0 || active.busy}
          className="inline-flex min-h-touch-lg items-center justify-center gap-2 rounded-glass border border-border bg-surface-2 px-6 font-medium text-text transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:text-text-muted"
        >
          <ChevronLeft aria-hidden="true" className="h-5 w-5 shrink-0" />
          <span>{t('plan.back', { defaultValue: 'Back' })}</span>
        </button>
      </div>

      {lastFired === null ? null : (
        <p className="text-xs text-text-muted">
          {t('plan.lastFired', { defaultValue: 'Last fired' })}
          {': '}
          <span className="text-text">{lastFired.label}</span>
        </p>
      )}

      <ol
        aria-label={t('plan.cueListLabel', { defaultValue: 'Service cues' })}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-glass border border-border bg-surface p-2"
      >
        {plan.cues.map((cue, index) => {
          const isCurrent = index === position.index
          const fired = position.firedCueIds.includes(cue.id)
          return (
            <li
              key={cue.id}
              ref={isCurrent ? currentRowRef : null}
              data-cue-id={cue.id}
              data-fired={fired ? 'true' : 'false'}
              data-current={isCurrent ? 'true' : 'false'}
            >
              <button
                type="button"
                // `aria-current` rather than a colour alone: the operator's position in the plan is
                // information a screen reader has to be able to report too.
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => {
                  active.fireCue(cue.id)
                }}
                disabled={active.busy}
                className={clsx(
                  'flex min-h-touch w-full items-center gap-3 rounded-glass border px-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  'disabled:cursor-not-allowed',
                  isCurrent
                    ? 'border-accent bg-surface-2 text-text'
                    : 'border-transparent hover:border-border',
                  // Fired-but-not-current is dimmed AND marked, never dimmed alone: colour is
                  // never the only channel (`docs/v2-notes/SHORTCUTS_AND_A11Y.md`).
                  !isCurrent && fired ? 'text-text-muted' : 'text-text',
                )}
              >
                <span className="w-8 shrink-0 font-mono text-xs text-text-muted">
                  {String(index + 1)}
                </span>
                <span className="truncate">{cue.label}</span>
                <span className="ml-auto shrink-0 text-xs uppercase tracking-wide text-text-muted">
                  {fired
                    ? t('plan.fired', { defaultValue: 'Fired' })
                    : t(`plan.cueType.${cue.type}`, { defaultValue: cue.type })}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {/*
        The pre-load strip. `sr-only` keeps it out of the visual layout and out of the accessibility
        tree while leaving the images genuinely fetched — BLUEPRINT.md §4's "the next slide is
        pre-loaded so firing is instant", for the price of a couple of cached thumbnails.
      */}
      <div aria-hidden="true" data-testid="plan-preload" className="sr-only">
        {preloadAssets.map((asset) => {
          const url = assetUrl(asset)
          if (url === null) return null
          return (
            <img
              key={asset}
              src={url}
              alt=""
              loading="eager"
              decoding="async"
              data-testid="plan-preload-image"
              data-asset={asset}
            />
          )
        })}
      </div>
    </section>
  )
}

export default PlanRunner
