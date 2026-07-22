/**
 * The trust dial, and the master PANIC switch.
 *
 * BLUEPRINT.md §4 calls the dial "what makes it safe", and the shape of this component is an
 * argument about which of the three modes an operator should be running:
 *
 *  - **Assist is the default and it is marked as such, twice** — as the contract's default and as
 *    the recommendation. It is the mode with a massive workload cut and near-zero risk.
 *  - **Auto carries a plainly worded caution, always visible, not behind a tooltip.** The cost of
 *    Auto is not abstract: a high-confidence cue reaches the congregation screen before the
 *    operator is asked, and the veto only exists after it is already up. Anyone choosing it should
 *    have read that sentence.
 *  - **Manual is offered without editorialising.** It is a legitimate choice, not a failure state.
 *
 * ## PANIC
 *
 * Physically separated from the mode buttons (FITTS-3), in the panic colour, and a {@link
 * HoldButton} rather than a tap (Standing Rule 6). Its label and its group name both state what it
 * does **and what it does not do**, because the reassurance is the entire reason an operator will
 * dare to press it mid-service: `docs/v2-notes/SHORTCUTS_AND_A11Y.md` records that v2's equivalent
 * control could blank the congregation screen, and that operators learned not to touch it.
 *
 * Coming back is deliberately asymmetric: PANIC is one hold away, RESUME is an explicit button and
 * nothing else in the app clears the flag. Automation never returns on its own.
 */

import clsx from 'clsx'
import { OctagonAlert, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TrustMode } from '@shared/cue'
import { TRUST_MODES } from '@shared/cue'

import { useCueStore } from '../store/cueStore'
import { HoldButton } from './HoldButton'

/** The mode Verger recommends, and the one the contract defaults to. */
export const RECOMMENDED_MODE: TrustMode = 'assist'

export function TrustDial(): React.JSX.Element {
  const { t } = useTranslation()

  const engine = useCueStore((state) => state.state)
  const busy = useCueStore((state) => state.busy)
  const setMode = useCueStore((state) => state.setMode)
  const panic = useCueStore((state) => state.panic)
  const resume = useCueStore((state) => state.resume)

  const panicked = engine.panicked

  return (
    <section
      aria-label={t('cue.trust.title')}
      data-testid="trust-dial"
      data-mode={engine.mode}
      data-panicked={panicked ? 'true' : 'false'}
      className="flex flex-col gap-4 rounded-glass border border-border bg-surface p-4"
    >
      <div>
        <h2 className="text-base font-semibold text-text">{t('cue.trust.title')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">{t('cue.trust.subtitle')}</p>
      </div>

      {panicked ? (
        // First in the reading order and impossible to mistake for anything else. A halted engine
        // that looked like a running one is the worst failure this screen could have.
        <div
          role="alert"
          data-testid="panic-active"
          className="rounded-glass border-2 border-panic bg-panic/10 p-3"
        >
          <p className="text-base font-semibold uppercase tracking-wide text-panic">
            {t('cue.panic.panickedTitle')}
          </p>
          <p className="mt-1 text-sm text-text">{t('cue.panic.panickedBody')}</p>
          <ul className="mt-2 space-y-1 text-xs text-text-muted">
            <li>{t('cue.panic.notStream')}</li>
            <li>{t('cue.panic.notRecording')}</li>
            <li>{t('cue.panic.notScreen')}</li>
          </ul>
          <button
            type="button"
            data-testid="panic-resume"
            disabled={busy}
            onClick={() => {
              void resume()
            }}
            className="mt-3 inline-flex min-h-touch-lg items-center gap-2 rounded-glass border border-accent-hover bg-accent px-6 text-base font-semibold text-text shadow-glow hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted disabled:shadow-none"
          >
            <Play aria-hidden="true" className="h-5 w-5 shrink-0" />
            {t('cue.panic.resume')}
          </button>
          <p className="mt-2 text-xs text-text-muted">{t('cue.panic.resumeHint')}</p>
        </div>
      ) : null}

      <div
        role="radiogroup"
        aria-label={t('cue.trust.groupLabel')}
        data-testid="trust-dial-modes"
        className="grid gap-3 sm:grid-cols-3"
      >
        {TRUST_MODES.map((mode) => {
          const selected = engine.mode === mode
          const recommended = mode === RECOMMENDED_MODE

          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`trust-mode-${mode}`}
              data-selected={selected ? 'true' : 'false'}
              data-recommended={recommended ? 'true' : 'false'}
              disabled={busy || panicked}
              onClick={() => {
                void setMode(mode)
              }}
              className={clsx(
                'flex min-h-touch-lg flex-col items-start gap-1 rounded-glass border-2 p-3 text-start',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:cursor-not-allowed disabled:opacity-60',
                selected ? 'border-accent bg-surface-2' : 'border-border bg-surface-2/50',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-text">{t(`cue.mode.${mode}`)}</span>
                {recommended ? (
                  <>
                    <span className="rounded-glass border border-accent/60 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t('cue.modeBadge.default')}
                    </span>
                    <span className="rounded-glass border border-accent/60 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t('cue.modeBadge.recommended')}
                    </span>
                  </>
                ) : null}
              </span>
              <span className="text-xs text-text-muted">{t(`cue.modeDetail.${mode}`)}</span>
              {mode === 'auto' ? (
                // Always visible, never a tooltip. Somebody choosing Auto has to have been told.
                <span
                  data-testid="trust-auto-caution"
                  className="mt-1 rounded-glass border border-panic/50 bg-panic/10 p-2 text-xs text-panic"
                >
                  {t('cue.trust.autoCaution')}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <p className="text-xs text-text-muted" data-testid="trust-current">
        {panicked
          ? t('cue.panic.lockedWhilePanicked')
          : t('cue.trust.current', { mode: t(`cue.mode.${engine.mode}`) })}
      </p>
      <p className="text-xs text-text-muted">{t('cue.trust.perCueNote')}</p>

      {/* Physically separated: its own block, its own border, well below the mode buttons. */}
      <div
        role="group"
        aria-label={t('cue.panic.regionLabel')}
        data-testid="panic-control"
        className="mt-6 flex flex-col gap-3 border-t border-border pt-6"
      >
        <div className="flex items-center gap-2">
          <OctagonAlert aria-hidden="true" className="h-5 w-5 shrink-0 text-panic" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-panic">
            {t('cue.panic.title')}
          </h3>
        </div>
        <p className="max-w-2xl text-sm text-text">{t('cue.panic.does')}</p>

        <div className="max-w-2xl rounded-glass border border-border bg-surface-2 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('cue.panic.doesNotLabel')}
          </p>
          <ul className="mt-1 space-y-1 text-sm text-text">
            <li>{t('cue.panic.notStream')}</li>
            <li>{t('cue.panic.notRecording')}</li>
            <li>{t('cue.panic.notScreen')}</li>
          </ul>
          <p className="mt-2 text-xs text-text-muted">{t('cue.panic.reassurance')}</p>
        </div>

        <HoldButton
          id="cue-panic"
          label={t('cue.panic.label')}
          // Left at {@link DEFAULT_HOLD_MS}: the blueprint's 1.5 s floor for a deliberate action,
          // and no longer. An emergency control that takes three seconds is one the operator
          // gives up on halfway through and stops trusting.
          disabled={panicked}
          icon={OctagonAlert}
          onHoldComplete={() => {
            void panic()
          }}
          className="self-start"
        />
      </div>
    </section>
  )
}

export default TrustDial
