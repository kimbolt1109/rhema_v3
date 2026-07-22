/**
 * The pending suggestion — the single most time-critical surface in Verger.
 *
 * An operator has about a second to decide. So the card answers four questions in a fixed order and
 * in that order every time, because a layout that moves is a layout that has to be re-read:
 *
 *  1. **What would happen** — the cue that would fire, or the reference that would be shown.
 *  2. **Why** — the detector's own sentence, verbatim. It is the only thing that lets an operator
 *     tell "it heard the anchor phrase" from "it heard something a bit like it".
 *  3. **How sure**, and **which detector** said so. A plan match at 79% and a scripture match at
 *     99% deserve different reactions.
 *  4. **What happens if you do nothing** — spelled out, never implied.
 *
 * ## The scripture gate is re-applied here
 *
 * `docs/v2-notes/ASR_PIPELINE.md` records the hard rule: a confident *reference* says nothing about
 * whether the *text* resolved, and auto-showing a reference whose text failed puts an empty
 * scripture card in front of the congregation — a failure invisible to the operator until somebody
 * tells them. So when the text is unavailable this card says so in plain words, states that nothing
 * will auto-show whatever the mode, and {@link willAutoFire} independently refuses the auto-fire.
 * The engine already refuses it; this refuses it again. A cue may always be made safer.
 *
 * ## Nothing here applies anything
 *
 * Every action goes through the store, which goes through the bridge. This component has no path to
 * the overlay, the plan or OBS, which is what makes CONFIRM and DISMISS symmetrical and instant.
 *
 * ## Standing Rule 4
 *
 * No verse text is authored here. The card renders a {@link ResolvedScripture} handed to it at
 * runtime, with its translation and attribution, and says "text unavailable" when there is none.
 */

import clsx from 'clsx'
import { Check, RotateCcw, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionId } from '@shared/actions'
import type { CueSuggestion } from '@shared/cue'
import type { Cue } from '@shared/plan'
import { formatReference } from '@shared/scripture'

import type { ActionDispatcher } from '../input/ActionDispatcher'
import { classifyResolution, useCueStore, willAutoFire } from '../store/cueStore'
import { usePlanStore } from '../store/planStore'

export interface SuggestionPanelProps {
  /**
   * The input layer, when one is wired.
   *
   * Optional so the panel can be rendered and tested with no keyboard at all. When supplied it
   * registers `suggestion.confirm` (Y) and `suggestion.dismiss` (N) — the two bindings already in
   * `@shared/actions` — so a foot pedal emitting those keys works with no further wiring.
   */
  readonly dispatcher?: ActionDispatcher
}

/** The cue a suggestion points at, or `null` when it points at none / at one that has gone. */
function cueForSuggestion(cues: readonly Cue[], suggestion: CueSuggestion | null): Cue | null {
  if (suggestion === null || suggestion.cueId === null) return null
  return cues.find((cue) => cue.id === suggestion.cueId) ?? null
}

/** Confidence as a whole percentage. Rounded once, here, so every readout agrees. */
export function confidencePercent(confidence: number): number {
  return Math.round(confidence * 100)
}

/** One labelled fact in the card. Label above value, because the value is what gets scanned. */
function Fact({
  label,
  children,
  testId,
}: {
  label: string
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

/**
 * The scripture half of a suggestion.
 *
 * Split out because its failure case is the one that matters: an unresolved reference must never
 * render as a tidy empty card.
 */
function ScriptureDetail({
  suggestion,
}: {
  suggestion: CueSuggestion
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const resolved = useCueStore((state) => state.resolved)
  const resolving = useCueStore((state) => state.resolving)
  const resolveError = useCueStore((state) => state.resolveError)

  const reference = suggestion.reference
  if (reference === null) return null

  const resolution = classifyResolution(suggestion, resolved, resolving)
  const spoken = formatReference(reference, true)
  const canonical = formatReference(reference)

  return (
    <div
      data-testid="cue-scripture-detail"
      data-resolution={resolution}
      className="rounded-glass border border-border bg-surface-2 p-3"
    >
      <p className="text-lg font-semibold text-text">{canonical}</p>
      {spoken === canonical ? null : (
        <p className="text-xs text-text-muted">{t('cue.suggestion.spokenAs', { reference: spoken })}</p>
      )}
      <p className="mt-1 text-xs text-text-muted">{t(`cue.band.${reference.band}`)}</p>

      {resolution === 'resolving' ? (
        <p className="mt-2 text-sm text-text-muted">{t('cue.suggestion.resolving')}</p>
      ) : null}

      {resolution === 'resolved' && resolved !== null ? (
        <dl className="mt-2 grid grid-cols-2 gap-2">
          <Fact label={t('cue.suggestion.translationLabel')} testId="cue-scripture-translation">
            {resolved.translation}
          </Fact>
          <Fact label={t('cue.suggestion.attributionLabel')} testId="cue-scripture-attribution">
            {resolved.attribution ?? t('cue.suggestion.attributionNone')}
          </Fact>
        </dl>
      ) : null}

      {resolution === 'unavailable' ? (
        // Deliberately loud, and deliberately not a tidy empty card. This is the state the
        // never-auto-show-unless-resolved gate exists for.
        <div className="mt-2 rounded-glass border border-panic/60 bg-panic/10 p-2">
          <p className="text-sm font-semibold text-panic">{t('cue.suggestion.textUnavailable')}</p>
          <p className="mt-1 text-xs text-text">{t('cue.suggestion.textUnavailableDetail')}</p>
          {resolveError === null ? null : (
            <p className="mt-1 text-xs text-text-muted">
              {t('cue.suggestion.textUnavailableReason', { reason: resolveError.message })}
            </p>
          )}
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-text-muted">{t('cue.suggestion.textNote')}</p>
    </div>
  )
}

/** The compact "nothing pending" readout. Never a big empty box. */
function IdleReadout({
  onUndo,
  lastFiredLabel,
}: {
  onUndo: (() => void) | null
  lastFiredLabel: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const engine = useCueStore((state) => state.state)
  const cues = usePlanStore((state) => state.plan.cues)

  const positionText =
    engine.position < 0
      ? t('cue.position.beforeStart')
      : (() => {
          const cue = cues[engine.position]
          const ordinal = engine.position + 1
          return cue === undefined
            ? t('cue.position.unknownCue', { ordinal })
            : t('cue.position.cue', { ordinal, label: cue.label })
        })()

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span
        data-testid="cue-idle-mode"
        className={clsx(
          'rounded-glass border px-2 py-1 font-medium',
          engine.panicked
            ? 'border-panic/60 text-panic'
            : 'border-border text-text',
        )}
      >
        {engine.panicked ? t('cue.subsystem.panicked') : t(`cue.mode.${engine.mode}`)}
      </span>
      <span data-testid="cue-idle-alignment" className="text-text-muted">
        {t(`cue.alignment.${engine.alignment}`)}
      </span>
      <span data-testid="cue-idle-position" className="text-text-muted">
        {t('cue.position.label')}: {positionText}
      </span>
      <span className="text-text-muted">{t('cue.suggestion.none')}</span>
      {onUndo === null || lastFiredLabel === null ? null : (
        <button
          type="button"
          onClick={onUndo}
          className="ms-auto inline-flex min-h-touch items-center gap-2 rounded-glass border border-border bg-surface-2 px-3 text-xs font-medium text-text hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('cue.suggestion.undo', { label: lastFiredLabel })}
        </button>
      )}
    </div>
  )
}

export function SuggestionPanel({ dispatcher }: SuggestionPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()

  const engine = useCueStore((state) => state.state)
  const resolved = useCueStore((state) => state.resolved)
  const resolving = useCueStore((state) => state.resolving)
  const busy = useCueStore((state) => state.busy)
  const bridgeAvailable = useCueStore((state) => state.bridgeAvailable)
  const hydrated = useCueStore((state) => state.hydrated)
  const lastError = useCueStore((state) => state.lastError)
  const cues = usePlanStore((state) => state.plan.cues)
  const back = usePlanStore((state) => state.back)

  // Handlers read the store at dispatch time rather than closing over `pending`. A Y that fired
  // against the suggestion showing a second ago is exactly the race `syncToActual` exists to kill,
  // and the input layer must not reintroduce it one level up.
  useEffect(() => {
    if (dispatcher === undefined) return undefined
    const offConfirm = dispatcher.register(ActionId.confirm, () => {
      void useCueStore.getState().confirm()
    })
    const offDismiss = dispatcher.register(ActionId.dismiss, () => {
      void useCueStore.getState().dismiss()
    })
    return () => {
      offConfirm()
      offDismiss()
    }
  }, [dispatcher])

  const pending = engine.pending
  const cue = cueForSuggestion(cues, pending)
  const cueMissing = pending !== null && pending.cueId !== null && cue === null

  const lastFired = engine.recent[0] ?? null
  const lastFiredCue = cueForSuggestion(cues, lastFired)
  // BACK steps the *plan* back, so it is only offered for a suggestion that moved the plan. A
  // scripture overlay is not undone by rewinding the order of service, and a button that claimed
  // otherwise would move the operator's position for no reason mid-service.
  const lastFiredLabel = lastFiredCue?.label ?? null
  const undo =
    lastFiredCue === null
      ? null
      : (): void => {
          void back()
        }

  if (pending === null) {
    return (
      <section
        role="region"
        aria-label={t('cue.suggestion.idleRegionLabel')}
        data-testid="cue-suggestion-panel"
        data-pending="false"
        data-mode={engine.mode}
        data-panicked={engine.panicked ? 'true' : 'false'}
        className="border-b border-border bg-surface px-4 py-2"
      >
        {bridgeAvailable || !hydrated ? null : (
          <p className="mb-1 text-xs text-panic">{t('cue.bridgeUnavailable.body')}</p>
        )}
        <IdleReadout onUndo={undo} lastFiredLabel={lastFiredLabel} />
      </section>
    )
  }

  const what =
    pending.reference !== null
      ? t('cue.suggestion.showScripture', { reference: formatReference(pending.reference) })
      : cue !== null
        ? t('cue.suggestion.fireCue', { label: cue.label })
        : t('cue.suggestion.fireCueUnknown')

  // Both halves have to agree before this reads as "about to fire": the shared rule, and the
  // renderer's own re-application of the scripture text gate.
  const autoFiring = willAutoFire(pending, engine.mode, engine.panicked, resolved)
  const resolution = classifyResolution(pending, resolved, resolving)

  return (
    <section
      role="region"
      aria-label={t('cue.suggestion.regionLabel')}
      data-testid="cue-suggestion-panel"
      data-pending="true"
      data-suggestion-id={pending.id}
      data-detector={pending.detector}
      data-auto-fire={autoFiring ? 'true' : 'false'}
      data-mode={engine.mode}
      className={clsx(
        'border-b-2 bg-surface px-4 py-3',
        autoFiring ? 'border-accent-2' : 'border-accent',
      )}
    >
      {/* Announced once, politely. The visible card carries the same words; a screen-reader user
          must not have to hunt the tree to find out a decision is waiting. */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {t('cue.suggestion.announce', { what, why: pending.why })}
      </span>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-text-muted">
            {t('cue.suggestion.whatLabel')}
          </p>
          <p data-testid="cue-suggestion-what" className="text-xl font-semibold text-text">
            {what}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            <Fact label={t('cue.suggestion.whyLabel')} testId="cue-suggestion-why">
              {pending.why}
            </Fact>
            <Fact label={t('cue.suggestion.confidenceLabel')} testId="cue-suggestion-confidence">
              {t('cue.suggestion.confidenceValue', {
                percent: confidencePercent(pending.confidence),
              })}
            </Fact>
            <Fact label={t('cue.suggestion.detectorLabel')} testId="cue-suggestion-detector">
              {t(`cue.detector.${pending.detector}`)}
            </Fact>
          </dl>

          {pending.reference === null ? null : (
            <div className="mt-3 max-w-xl">
              <ScriptureDetail suggestion={pending} />
            </div>
          )}

          {cueMissing ? (
            <p role="alert" className="mt-2 text-sm text-panic">
              {t('cue.suggestion.cueMissing')}
            </p>
          ) : null}

          <p
            data-testid="cue-suggestion-consequence"
            className={clsx('mt-3 text-sm', autoFiring ? 'text-accent-2' : 'text-text-muted')}
          >
            {autoFiring ? t('cue.suggestion.willAutoFire') : t('cue.suggestion.willNotAutoFire')}
          </p>

          {lastError === null ? null : (
            <p className="mt-2 text-xs text-panic">
              {t('cue.suggestion.error')}: {lastError.message}
            </p>
          )}
        </div>

        {/* The two decisions, side by side and both large. Symmetry is the point: a DISMISS that is
            smaller or further away than CONFIRM is a thumb on the scale. */}
        <div className="flex shrink-0 flex-wrap items-stretch gap-3">
          <button
            type="button"
            data-testid="cue-confirm"
            disabled={busy || cueMissing}
            onClick={() => {
              void useCueStore.getState().confirm(pending.id)
            }}
            className="inline-flex min-h-touch-lg min-w-touch-lg flex-col items-center justify-center rounded-glass border border-accent-hover bg-accent px-6 text-base font-semibold text-text shadow-glow transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted disabled:shadow-none"
          >
            <span className="flex items-center gap-2">
              <Check aria-hidden="true" className="h-5 w-5 shrink-0" />
              {t('cue.suggestion.confirm')}
            </span>
            <span aria-hidden="true" className="text-[11px] font-normal text-text-muted">
              {t('cue.suggestion.confirmHint')}
            </span>
          </button>

          <button
            type="button"
            data-testid="cue-dismiss"
            onClick={() => {
              void useCueStore.getState().dismiss(pending.id)
            }}
            className="inline-flex min-h-touch-lg min-w-touch-lg flex-col items-center justify-center rounded-glass border border-border bg-surface-2 px-6 text-base font-semibold text-text transition-colors hover:border-panic/60 hover:text-panic focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="flex items-center gap-2">
              <X aria-hidden="true" className="h-5 w-5 shrink-0" />
              {t('cue.suggestion.dismiss')}
            </span>
            <span aria-hidden="true" className="text-[11px] font-normal text-text-muted">
              {t('cue.suggestion.dismissHint')}
            </span>
          </button>
        </div>
      </div>

      {undo === null || lastFiredLabel === null ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2">
          <span className="text-[11px] uppercase tracking-wide text-text-muted">
            {t('cue.suggestion.lastFiredLabel')}
          </span>
          <button
            type="button"
            data-testid="cue-undo"
            onClick={undo}
            className="inline-flex min-h-touch items-center gap-2 rounded-glass border border-border bg-surface-2 px-3 text-xs font-medium text-text hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t('cue.suggestion.undo', { label: lastFiredLabel })}
          </button>
          <span className="text-[11px] text-text-muted">{t('cue.suggestion.undoHint')}</span>
        </div>
      )}

      {resolution === 'unavailable' ? (
        // Repeated outside the scripture card, next to the buttons, because this is the one fact
        // that changes what CONFIRM means and the operator's eyes are on the buttons.
        <p data-testid="cue-no-auto-show" className="mt-2 text-xs text-panic">
          {t('cue.suggestion.textUnavailable')} — {t('cue.suggestion.textUnavailableDetail')}
        </p>
      ) : null}
    </section>
  )
}

export default SuggestionPanel
