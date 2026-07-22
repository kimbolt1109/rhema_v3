/**
 * Confidence tuning — the numbers that decide how sure Verger has to be before it acts.
 *
 * ## Why this screen is mostly prose
 *
 * A settings page of unlabelled sliders is an invitation to drag everything to zero on a quiet
 * Tuesday, because on a quiet Tuesday nothing bad happens. The bad thing happens on Sunday, in
 * front of the congregation, and by then nobody remembers touching this page.
 *
 * So every control here carries two sentences: what the number *is*, and **what happens when you
 * lower it**. That second sentence always says the same thing in the same words — *lower this and
 * the system will act on less certainty* — because a consistent phrase is what an operator
 * actually reads on the fourth slider. Anything looser than the recommended value is called out
 * in place, while the operator is still looking at it.
 *
 * ## What this screen can and cannot change in this build — stated honestly
 *
 * Exactly one of these numbers is persisted today: the **default auto-fire threshold**, which
 * lives in `CueEngineSettings` and round-trips through `cue.setSettings`.
 *
 * The scripture confidence bands (`CONFIDENCE_EXACT`, `CONFIDENCE_FUZZY`), the plan anchor match
 * threshold (`ANCHOR_MATCH_THRESHOLD`) and the auto-fire dwell floor (`MIN_AUTO_FIRE_GAP_MS`) are
 * **compile-time constants** in `@shared/scripture` and `@shared/cue`. There is no IPC channel in
 * this build that can change them, so they are shown read-only, at their real values, with the
 * same explanation as everything else. A slider that moves and changes nothing would be a lie
 * told to the one person who most needs to trust this page; a read-only slider that says where the
 * number is and what lowering it would cost is the truth.
 *
 * Every value on this page is READ from the shared constants. None of them is retyped here — if a
 * threshold changes in `@shared`, this screen changes with it.
 *
 * ## Per-cue overrides
 *
 * Listed, not edited: they are authored in the plan editor and they live in the plan file. The
 * asymmetry from `CueOptions` is repeated here in the UI — `confirmAlways` only ever makes a cue
 * safer, so it is never flagged; a per-cue threshold *below* the service default is, because that
 * is the one direction a cue can be made more dangerous than the service it sits in.
 */

import { RotateCcw, Save, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ANCHOR_MATCH_THRESHOLD,
  MIN_AUTO_FIRE_GAP_MS,
  defaultCueEngineSettings,
} from '@shared/cue'
import type { Cue } from '@shared/plan'
import { CONFIDENCE_EXACT, CONFIDENCE_FUZZY } from '@shared/scripture'

import { Button } from '../components/Button'
import { useCueStore } from '../store/cueStore'
import { usePlanStore } from '../store/planStore'

// ---------------------------------------------------------------------------
// The recommended values — read, never retyped
// ---------------------------------------------------------------------------

/**
 * Where each dial should sit.
 *
 * Every field is read from the shared contract: `defaultCueEngineSettings()` for the auto-fire
 * threshold, `@shared/scripture` for the bands, `@shared/cue` for the anchor threshold and the
 * dwell floor. Reset-to-recommended and the looser-than-default warnings both measure against
 * this object, so there is exactly one definition of "recommended" in the renderer.
 */
export const RECOMMENDED_TUNING = {
  autoFireThreshold: defaultCueEngineSettings().autoFireThreshold,
  scriptureExact: CONFIDENCE_EXACT,
  scriptureFuzzy: CONFIDENCE_FUZZY,
  anchorMatch: ANCHOR_MATCH_THRESHOLD,
  minAutoFireGapMs: MIN_AUTO_FIRE_GAP_MS,
} as const

/** The widest a gap slider goes. Ten seconds is already an eternity mid-service. */
export const MAX_AUTO_FIRE_GAP_MS = 10_000

/**
 * Clamp a confidence into `[0, 1]`.
 *
 * A confidence is a probability, and `cueEngineSettingsSchema` enforces the same range at the IPC
 * boundary. Clamping here means a dragged slider, a pasted value or a `NaN` from an empty field
 * can never become a save the main process has to refuse. `NaN` resolves to the recommended value
 * rather than to zero: an unreadable input must not silently become "fire on anything".
 */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return RECOMMENDED_TUNING.autoFireThreshold
  return Math.min(Math.max(value, 0), 1)
}

/** Whether a value lets the system act on less certainty than recommended. */
export function isLooserThanRecommended(value: number, recommended: number): boolean {
  return value < recommended
}

/** A percentage, for the readout beside each slider. */
export function formatConfidence(value: number): string {
  return `${String(Math.round(clampConfidence(value) * 100))}%`
}

// ---------------------------------------------------------------------------
// Per-cue overrides
// ---------------------------------------------------------------------------

/** One row of the per-cue override list. */
export interface CueOverrideRow {
  readonly id: string
  readonly label: string
  /** The cue's own threshold, or `null` when it inherits the service default. */
  readonly autoFireThreshold: number | null
  readonly confirmAlways: boolean
  /** True when this cue would fire on LESS certainty than the service default. */
  readonly looser: boolean
}

/**
 * Every cue that overrides the service defaults.
 *
 * `confirmAlways` is never `looser`. It can only ever block an auto-fire, and a cue may always be
 * made safer than the service default — never more dangerous (`CueOptions`, `shouldAutoFire`).
 */
export function collectCueOverrides(
  cues: readonly Cue[],
  serviceDefault: number,
): readonly CueOverrideRow[] {
  const rows: CueOverrideRow[] = []
  for (const cue of cues) {
    const threshold = cue.options?.autoFireThreshold
    const confirmAlways = cue.options?.confirmAlways === true
    if (threshold === undefined && !confirmAlways) continue
    rows.push({
      id: cue.id,
      label: cue.label,
      autoFireThreshold: threshold ?? null,
      confirmAlways,
      looser: threshold !== undefined && isLooserThanRecommended(threshold, serviceDefault),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function TuningSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const settings = useCueStore((state) => state.settings)
  const setSettings = useCueStore((state) => state.setSettings)
  const hydrate = useCueStore((state) => state.hydrate)
  const subscribe = useCueStore((state) => state.subscribe)
  const busy = useCueStore((state) => state.busy)
  const lastError = useCueStore((state) => state.lastError)

  // Read, not hydrated: the plan is owned by the plan screens and this page only reports what is
  // already loaded. Hydrating here would let a settings page reopen a plan.
  const cues = usePlanStore((state) => state.plan.cues)

  const [draft, setDraft] = useState<number>(settings.autoFireThreshold)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  // The store is the source of truth; the draft follows whatever the main process reported.
  useEffect(() => {
    setDraft(settings.autoFireThreshold)
  }, [settings.autoFireThreshold])

  const looser = isLooserThanRecommended(draft, RECOMMENDED_TUNING.autoFireThreshold)
  const overrides = collectCueOverrides(cues, draft)

  const commit = (value: number): void => {
    const next = clampConfidence(value)
    setDraft(next)
    setSaved(false)
    void setSettings({ ...settings, autoFireThreshold: next }).then((result) => {
      setSaved(result.ok)
    })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">
          {t('tuning.title', { defaultValue: 'Confidence tuning' })}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          {t('tuning.subtitle', {
            defaultValue:
              'These numbers decide how sure Verger has to be before it does anything on its own. ' +
              'Every one of them is a trade: raise it and the console asks you more often, lower it ' +
              'and the system will act on less certainty.',
          })}
        </p>
      </header>

      <section
        aria-label={t('tuning.scope.title', { defaultValue: 'What this screen changes' })}
        className="rounded-glass-lg border border-border bg-surface p-5"
      >
        <h2 className="font-semibold text-text">
          {t('tuning.scope.title', { defaultValue: 'What this screen changes' })}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-text-muted">
          {t('tuning.scope.body', {
            defaultValue:
              'Only the default auto-fire threshold is saved in this build. The scripture bands, the ' +
              'plan anchor threshold and the auto-fire gap are compiled into Verger and are shown here ' +
              'read-only, at their real values, so you can see what the system is actually working to.',
          })}
        </p>
      </section>

      <fieldset className="flex flex-col gap-4 rounded-glass-lg border border-border bg-surface p-5">
        <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
          {t('tuning.autoFire.legend', { defaultValue: 'Auto-fire' })}
        </legend>

        <TuningSlider
          id="tuning-auto-fire-threshold"
          label={t('tuning.autoFire.label', { defaultValue: 'Default auto-fire threshold' })}
          value={draft}
          recommended={RECOMMENDED_TUNING.autoFireThreshold}
          onChange={(value) => {
            setSaved(false)
            setDraft(clampConfidence(value))
          }}
          plain={t('tuning.autoFire.plain', {
            defaultValue:
              'In auto mode, a cue may fire itself only when the match is at least this confident. ' +
              'Cues below it are offered to you instead.',
          })}
          consequence={t('tuning.autoFire.consequence', {
            defaultValue:
              'Lower this and the system will act on less certainty: more cues fire without you, and ' +
              'more of the ones that fire will be wrong — on the congregation screen, where you cannot ' +
              'take them back.',
          })}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={Save}
            disabled={busy}
            onClick={() => {
              commit(draft)
            }}
          >
            {t('tuning.save', { defaultValue: 'Save tuning' })}
          </Button>
          <Button
            variant="secondary"
            icon={RotateCcw}
            disabled={busy}
            onClick={() => {
              commit(RECOMMENDED_TUNING.autoFireThreshold)
            }}
          >
            {t('tuning.reset', {
              defaultValue: 'Reset to recommended',
              value: formatConfidence(RECOMMENDED_TUNING.autoFireThreshold),
            })}
          </Button>
          <p role="status" className="text-sm text-text-muted">
            {saved ? t('tuning.saved', { defaultValue: 'Tuning saved.' }) : ''}
          </p>
        </div>

        {looser ? (
          <p
            role="alert"
            data-testid="tuning-loose-warning"
            className="flex items-start gap-2 text-sm font-medium text-panic"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('tuning.autoFire.looseWarning', {
              defaultValue:
                'This is looser than recommended. Verger will act on less certainty than the setting ' +
                'this build was tested with.',
            })}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-4 rounded-glass-lg border border-border bg-surface p-5">
        <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
          {t('tuning.scripture.legend', { defaultValue: 'Scripture confidence bands' })}
        </legend>

        <TuningSlider
          id="tuning-scripture-exact"
          fixed
          label={t('tuning.scripture.exactLabel', { defaultValue: 'Exact reference band' })}
          value={RECOMMENDED_TUNING.scriptureExact}
          recommended={RECOMMENDED_TUNING.scriptureExact}
          plain={t('tuning.scripture.exactPlain', {
            defaultValue:
              'At or above this, a spoken reference is treated as exact. Only an exact reference is ' +
              'ever allowed to show itself, and only once its text has actually been fetched.',
          })}
          consequence={t('tuning.scripture.exactConsequence', {
            defaultValue:
              'Lower this and the system will act on less certainty: a near-miss gets treated as a ' +
              'certainty, so the wrong passage can go up while the right one is being read.',
          })}
        />

        <TuningSlider
          id="tuning-scripture-fuzzy"
          fixed
          label={t('tuning.scripture.fuzzyLabel', { defaultValue: 'Offered reference band' })}
          value={RECOMMENDED_TUNING.scriptureFuzzy}
          recommended={RECOMMENDED_TUNING.scriptureFuzzy}
          plain={t('tuning.scripture.fuzzyPlain', {
            defaultValue:
              'Between this and the exact band, a reference is offered to you flagged as uncertain. ' +
              'Below it, the guess is discarded rather than shown.',
          })}
          consequence={t('tuning.scripture.fuzzyConsequence', {
            defaultValue:
              'Lower this and the system will act on less certainty: the panel fills with weak guesses, ' +
              'and a panel full of noise is a panel you stop reading — which is worse than missing one ' +
              'reference.',
          })}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4 rounded-glass-lg border border-border bg-surface p-5">
        <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
          {t('tuning.plan.legend', { defaultValue: 'Following the plan' })}
        </legend>

        <TuningSlider
          id="tuning-anchor-match"
          fixed
          label={t('tuning.plan.anchorLabel', { defaultValue: 'Anchor match threshold' })}
          value={RECOMMENDED_TUNING.anchorMatch}
          recommended={RECOMMENDED_TUNING.anchorMatch}
          plain={t('tuning.plan.anchorPlain', {
            defaultValue:
              'How closely what was said must match a cue’s anchor phrase before the plan pointer moves ' +
              'to it. Deliberately stricter than the scripture bands.',
          })}
          consequence={t('tuning.plan.anchorConsequence', {
            defaultValue:
              'Lower this and the system will act on less certainty: the follower jumps on a loose ' +
              'resemblance, which is how a service ends up three slides ahead of the preacher.',
          })}
        />

        <TuningSlider
          id="tuning-auto-fire-gap"
          fixed
          unit="ms"
          max={MAX_AUTO_FIRE_GAP_MS}
          step={250}
          label={t('tuning.plan.gapLabel', { defaultValue: 'Minimum gap between auto-fires' })}
          value={RECOMMENDED_TUNING.minAutoFireGapMs}
          recommended={RECOMMENDED_TUNING.minAutoFireGapMs}
          plain={t('tuning.plan.gapPlain', {
            defaultValue:
              'The floor between two automatic fires, in milliseconds. It is also the window you have ' +
              'to veto one.',
          })}
          consequence={t('tuning.plan.gapConsequence', {
            defaultValue:
              'Lower this and the system will act faster than you can stop it: a burst of transcript can ' +
              'fire three cues in a second and the congregation watches the slides flicker past.',
          })}
        />
      </fieldset>

      <section
        aria-label={t('tuning.overrides.title', { defaultValue: 'Per-cue overrides' })}
        className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5"
      >
        <h2 className="font-semibold text-text">
          {t('tuning.overrides.title', { defaultValue: 'Per-cue overrides' })}
        </h2>
        <p className="max-w-3xl text-sm text-text-muted">
          {t('tuning.overrides.hint', {
            defaultValue:
              'Cues in the open plan that set their own rules. These are authored in the plan editor and ' +
              'saved in the plan file — this list is here so you can see them all in one place.',
          })}
        </p>

        {overrides.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t('tuning.overrides.empty', {
              defaultValue: 'No cue in this plan overrides the service default.',
            })}
          </p>
        ) : (
          <ul
            aria-label={t('tuning.overrides.listLabel', { defaultValue: 'Cues with their own rules' })}
            className="flex flex-col gap-2"
          >
            {overrides.map((row) => (
              <li
                key={row.id}
                data-testid={`tuning-override-${row.id}`}
                data-looser={row.looser ? 'true' : 'false'}
                className="flex flex-col gap-1 rounded-glass border border-border bg-surface-2 p-3"
              >
                <span className="text-sm font-medium text-text">{row.label}</span>
                <span className="text-xs text-text-muted">
                  {row.autoFireThreshold === null
                    ? t('tuning.overrides.inherits', {
                        defaultValue: 'Uses the service default threshold.',
                      })
                    : t('tuning.overrides.threshold', {
                        defaultValue: `Auto-fire threshold ${formatConfidence(row.autoFireThreshold)}`,
                        value: formatConfidence(row.autoFireThreshold),
                      })}
                </span>
                {row.confirmAlways ? (
                  <span className="text-xs text-text-muted">
                    {t('tuning.overrides.confirmAlways', {
                      defaultValue:
                        'Always asks first. This cue can never fire on its own, whatever the mode.',
                    })}
                  </span>
                ) : null}
                {row.looser ? (
                  <span className="flex items-start gap-2 text-xs font-medium text-panic">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('tuning.overrides.looseWarning', {
                      defaultValue:
                        'Looser than the service default — this cue will act on less certainty than the ' +
                        'rest of the service.',
                    })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {lastError === null ? null : (
        <p className="text-xs text-panic">
          {t('tuning.saveFailed', { defaultValue: 'The tuning was not saved.' })} {lastError.message}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One slider
// ---------------------------------------------------------------------------

interface TuningSliderProps {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly recommended: number
  readonly plain: string
  readonly consequence: string
  /** Compiled into this build: rendered read-only with an explanation. See the module docblock. */
  readonly fixed?: boolean
  readonly max?: number
  readonly step?: number
  readonly unit?: 'confidence' | 'ms'
  readonly onChange?: (value: number) => void
}

function TuningSlider({
  id,
  label,
  value,
  recommended,
  plain,
  consequence,
  fixed = false,
  max = 1,
  step = 0.01,
  unit = 'confidence',
  onChange,
}: TuningSliderProps): React.JSX.Element {
  const { t } = useTranslation()
  const readout = unit === 'ms' ? `${String(Math.round(value))} ms` : formatConfidence(value)
  const recommendedReadout =
    unit === 'ms' ? `${String(Math.round(recommended))} ms` : formatConfidence(recommended)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        <span data-testid={`${id}-readout`} className="text-sm tabular-nums text-text">
          {readout}
        </span>
      </div>

      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        disabled={fixed}
        aria-describedby={`${id}-plain ${id}-consequence ${id}-recommended`}
        aria-valuetext={readout}
        onChange={(event) => {
          onChange?.(Number(event.target.value))
        }}
        className="h-2 w-full cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-70"
      />

      <p id={`${id}-plain`} className="max-w-3xl text-xs text-text-muted">
        {plain}
      </p>
      <p id={`${id}-consequence`} className="max-w-3xl text-xs text-text-muted">
        {consequence}
      </p>
      <p id={`${id}-recommended`} className="max-w-3xl text-xs text-text-muted">
        {fixed
          ? t('tuning.fixedHint', {
              defaultValue: `Fixed at ${recommendedReadout} in this build — changing it is a code change, not a setting.`,
              value: recommendedReadout,
            })
          : t('tuning.recommendedHint', {
              defaultValue: `Recommended: ${recommendedReadout}.`,
              value: recommendedReadout,
            })}
      </p>
    </div>
  )
}

export default TuningSettings
