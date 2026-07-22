/**
 * A button that only fires after being **held**.
 *
 * ## Why this component exists
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6 records that rhema_v2 shipped destructive actions as
 * instant taps — plain ESC cleared every overlay on keydown — and had to walk it back after an
 * audit (`PROBLEMS.md` #86/#105). The corrected design, and Standing Rule 6, is:
 *
 *  - **Nothing destructive completes in under ~1.5 s.** The blueprint's KAHNEMAN-2 rule is that an
 *    irreversible action must require deliberate System 2 engagement, which a hold forces and a
 *    tap, a double-click, or a muscle-memory keypress does not. {@link DEFAULT_HOLD_MS} is that
 *    floor.
 *  - **Releasing early fires nothing at all.** There is no partial credit and no "are you sure"
 *    dialog to dismiss by reflex.
 *  - **Destructive controls sit far from primary ones** (FITTS-3). That is the caller's job — this
 *    component only guarantees the timing half.
 *
 * ## Accessibility
 *
 * - The accessible name says the control must be held and for how long, so a screen reader user is
 *   not left pressing Enter and wondering why nothing happened.
 * - **Keyboard hold is a first-class path**, not an afterthought: Space or Enter held down runs
 *   the same timer as a pointer hold. `event.repeat` is ignored so the OS key-repeat stream does
 *   not restart the timer, and key-up cancels.
 * - Blur, pointer-up, pointer-leave and pointer-cancel all cancel. Dragging off a half-held button
 *   is the universal "actually, no" gesture and it must work here.
 * - Progress is announced through a polite live region rather than by the moving fill; the fill is
 *   `aria-hidden`, because narrating a percentage twenty times a second during a service would be
 *   hostile.
 * - `prefers-reduced-motion` removes the fill's transition. The fill still advances — it is
 *   information, not decoration — it just stops being animated between steps.
 */

import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The default hold, in milliseconds.
 *
 * 1500 ms is the blueprint's hard floor (KAHNEMAN-2: "cannot be completed in < 1.5 seconds").
 * v2's shipped "Clear All" used a round 2000 ms; callers may pass more, never usefully less.
 */
export const DEFAULT_HOLD_MS = 1500

/** How often progress is recomputed. Fine enough to look continuous, coarse enough to be cheap. */
export const HOLD_TICK_MS = 50

/** What the live region is currently saying. */
type HoldPhase = 'idle' | 'holding' | 'complete'

export interface HoldButtonProps {
  /** The visible action label, e.g. "Clear all overlays". Also feeds the accessible name. */
  readonly label: string
  /** Fired once, only after a complete hold. */
  readonly onHoldComplete: () => void
  /** Defaults to {@link DEFAULT_HOLD_MS}. */
  readonly durationMs?: number
  readonly disabled?: boolean
  /** Rendered before the label and marked `aria-hidden` — the label carries the meaning. */
  readonly icon?: LucideIcon
  readonly className?: string
  readonly id?: string
}

/**
 * Whether the operator has asked the OS for reduced motion.
 *
 * Guarded rather than assumed: `matchMedia` is absent in some non-browser DOM shims, and a missing
 * media-query API must degrade to "animate normally", never to a crash in the booth.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    if (typeof query.addEventListener !== 'function') return undefined
    const handleChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches)
    }
    query.addEventListener('change', handleChange)
    return () => {
      query.removeEventListener('change', handleChange)
    }
  }, [])

  return reduced
}

export function HoldButton({
  label,
  onHoldComplete,
  durationMs = DEFAULT_HOLD_MS,
  disabled = false,
  icon: Icon,
  className,
  id,
}: HoldButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const reducedMotion = usePrefersReducedMotion()

  const [elapsed, setElapsed] = useState(0)
  const [holding, setHolding] = useState(false)
  const [phase, setPhase] = useState<HoldPhase>('idle')
  const timerRef = useRef<number | null>(null)
  /** Mirrors `holding` for the event handlers, which must not read stale state or write in a
   *  state updater — updaters have to stay pure. */
  const holdingRef = useRef(false)

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return
    window.clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  const cancel = useCallback((): void => {
    clearTimer()
    setElapsed(0)
    // Only downgrade the announcement if a hold was actually in progress; a blur that follows a
    // completed hold must not overwrite "done" with silence.
    if (!holdingRef.current) return
    holdingRef.current = false
    setHolding(false)
    setPhase('idle')
  }, [clearTimer])

  const start = useCallback((): void => {
    if (disabled || timerRef.current !== null) return
    holdingRef.current = true
    setHolding(true)
    setPhase('holding')
    setElapsed(0)
    // Elapsed time is accumulated from ticks rather than read from the clock, so the component
    // behaves identically under vitest's fake timers and in a real browser.
    timerRef.current = window.setInterval(() => {
      setElapsed((current) => current + HOLD_TICK_MS)
    }, HOLD_TICK_MS)
  }, [disabled])

  // Firing lives in an effect, not in the interval callback: a state updater must stay pure, and
  // React may invoke it more than once. Here the callback runs exactly once per completed hold.
  useEffect(() => {
    if (!holding || elapsed < durationMs) return
    clearTimer()
    holdingRef.current = false
    setHolding(false)
    setElapsed(0)
    setPhase('complete')
    onHoldComplete()
  }, [holding, elapsed, durationMs, clearTimer, onHoldComplete])

  // An unmount mid-hold must not leave an interval running against a dead component.
  useEffect(() => clearTimer, [clearTimer])

  useEffect(() => {
    if (disabled) cancel()
  }, [disabled, cancel])

  const progress = Math.min(100, Math.round((elapsed / durationMs) * 100))
  const seconds = Number((durationMs / 1000).toFixed(1))
  const accessibleName = t('holdButton.accessibleName', { action: label, seconds })

  const announcement =
    phase === 'holding'
      ? t('holdButton.holding', { action: label })
      : phase === 'complete'
        ? t('holdButton.completed', { action: label })
        : ''

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter' && event.key !== 'Spacebar') return
    // Stop the browser scrolling on Space, and stop Enter's implicit activation from being the
    // thing that fires the action — only a completed hold may do that.
    event.preventDefault()
    if (event.repeat) return
    start()
  }

  const handleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter' && event.key !== 'Spacebar') return
    event.preventDefault()
    cancel()
  }

  return (
    <>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={accessibleName}
        data-hold-progress={progress}
        data-holding={holding ? 'true' : 'false'}
        onPointerDown={(event) => {
          // Primary button only. A right-click or a stylus barrel press must not arm a
          // destructive action.
          if (event.button > 0) return
          start()
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerOut={(event) => {
          // `pointerout` bubbles up from the label and the fill, so leaving the button for one of
          // its own children is not leaving the button. Only a pointer that has genuinely left
          // the control cancels the hold.
          const related = event.relatedTarget
          if (related instanceof Node && event.currentTarget.contains(related)) return
          cancel()
        }}
        onPointerCancel={cancel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={cancel}
        // No `onClick`: a click is precisely the gesture this component refuses to honour.
        className={clsx(
          'relative flex min-h-touch-xl min-w-touch-xl items-center justify-center gap-2',
          'overflow-hidden rounded-glass border-2 border-panic/70 bg-surface-2 px-6',
          'text-base font-semibold uppercase tracking-wide text-panic',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panic focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted disabled:opacity-60',
          className,
        )}
      >
        <span
          aria-hidden="true"
          data-testid="hold-progress-fill"
          className={clsx(
            'absolute inset-y-0 start-0 bg-panic/35',
            reducedMotion ? '' : 'transition-[width] duration-75 ease-linear',
          )}
          style={{ width: `${String(progress)}%` }}
        />
        {/* `relative` so the label paints over the fill without needing a stacking context. */}
        <span className="relative flex items-center gap-2">
          {Icon !== undefined ? <Icon aria-hidden="true" className="h-6 w-6 shrink-0" /> : null}
          <span className="flex flex-col items-center leading-tight">
            <span>{label}</span>
            {/* `aria-hidden` because the accessible name already states the hold duration;
                repeating it would make the name and the visible label disagree. */}
            <span aria-hidden="true" className="text-xs font-normal normal-case text-text-muted">
              {t('holdButton.hint', { seconds })}
            </span>
          </span>
        </span>
      </button>

      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
