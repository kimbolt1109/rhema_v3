/**
 * The one-cue editor.
 *
 * Type, label, trigger, payload and per-cue automation options — the whole authoring surface for a
 * single cue, in one column, with the fields changing to match the type.
 *
 * ## Why a `scripture` cue has no text box
 *
 * Because `ScripturePayload` has no `text` field, and that is deliberate (Standing Rule 4). A plan
 * carrying verse text is invalid *by construction*, so there is nothing here to type it into. That
 * absence is confusing unless it is explained, so the panel says the quiet part out loud: the
 * wording is resolved at fire time from a licensed source and is never stored in the plan file.
 * An operator who understands why the box is missing will not go looking for a workaround.
 *
 * ## Why an empty non-manual trigger is an error, not a warning
 *
 * `cueSchema` rejects it: an `anchor`, `scripture` or `hotphrase` trigger with no text can never
 * match anything, so the cue would sit in the service silently never firing. Catching it here, at
 * authoring time on a Tuesday, is the entire point — the alternative is discovering it on Sunday.
 *
 * ## Automation options are a safety dial, and they only turn one way
 *
 * `confirmAlways` beats any service-level auto mode, and the copy says so. Per `src/shared/plan.ts`
 * a cue may always be made *safer* than the service default, never more dangerous.
 */

import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import type { Cue, CueOptions, CuePayload, CueType, TriggerMode } from '@shared/plan'
import { CUE_TYPES, TRIGGER_MODES, cueSchema } from '@shared/plan'

import { HoldButton } from './HoldButton'
import { defaultPayloadFor } from '../store/planStore'

export interface CueEditorPanelProps {
  readonly cue: Cue
  /** Called with a whole replacement cue on every keystroke. The parent decides when to persist. */
  readonly onChange: (cue: Cue) => void
  /** Called only after a completed hold. Deleting a cue mid-service is not undoable in one tap. */
  readonly onDelete: () => void
  readonly disabled?: boolean
}

/** Read one string field out of a payload without asserting which member of the union it is. */
function readString(payload: CuePayload, key: string): string {
  const record: Record<string, unknown> = { ...payload }
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** Read one numeric field the same way. Returns `''` so it can drive a controlled input. */
function readNumber(payload: CuePayload, key: string): string {
  const record: Record<string, unknown> = { ...payload }
  const value = record[key]
  return typeof value === 'number' ? String(value) : ''
}

/** Drop `options` entirely when nothing is set, rather than leaving an empty object in the file. */
function withOptions(cue: Cue, next: CueOptions): Cue {
  if (next.autoFireThreshold === undefined && next.confirmAlways === undefined) {
    const { options: _dropped, ...rest } = cue
    return rest
  }
  return { ...cue, options: next }
}

const inputClass =
  'min-h-touch w-full rounded-glass border border-border bg-surface-2 px-3 text-sm text-text ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'disabled:text-text-muted'

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}

export function CueEditorPanel({
  cue,
  onChange,
  onDelete,
  disabled = false,
}: CueEditorPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const uid = useId()

  const parsed = cueSchema.safeParse(cue)
  const issues = parsed.success ? [] : parsed.error.issues
  const triggerTextIssue = issues.find((issue) => issue.path.join('.') === 'trigger.text')

  const setPayload = (payload: CuePayload): void => {
    onChange({ ...cue, payload })
  }

  const setType = (type: CueType): void => {
    // The payload is replaced, not migrated: a `slide` asset path is meaningless as a `scene`
    // name, and carrying it across would produce a cue that validates and does the wrong thing.
    onChange({ ...cue, type, payload: defaultPayloadFor(type) })
  }

  const setTriggerMode = (mode: TriggerMode): void => {
    if (mode === 'manual') {
      // `manual` carries no text at all — see `CueTrigger` in `src/shared/plan.ts`.
      onChange({ ...cue, trigger: { mode } })
      return
    }
    onChange({ ...cue, trigger: { mode, text: cue.trigger.text ?? '' } })
  }

  const ids = {
    type: `${uid}-type`,
    label: `${uid}-label`,
    triggerMode: `${uid}-trigger-mode`,
    triggerText: `${uid}-trigger-text`,
    note: `${uid}-note`,
    threshold: `${uid}-threshold`,
    confirm: `${uid}-confirm`,
    payload: `${uid}-payload`,
    payload2: `${uid}-payload-2`,
    payload3: `${uid}-payload-3`,
  }

  const threshold = cue.options?.autoFireThreshold
  const confirmAlways = cue.options?.confirmAlways ?? false

  return (
    <section
      aria-label={t('plan.editor.title')}
      data-testid="cue-editor"
      className="flex flex-col gap-5 rounded-glass-lg border border-border bg-surface p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">{t('plan.editor.title')}</h2>
          <p className="text-xs text-text-muted">{cue.id}</p>
        </div>
      </header>

      {parsed.success ? null : (
        <p role="alert" className="rounded-glass border border-panic/60 bg-surface-2 p-3 text-sm text-panic">
          {t('plan.editor.invalid')}
        </p>
      )}

      <Field id={ids.type} label={t('plan.editor.typeField')}>
        <select
          id={ids.type}
          value={cue.type}
          disabled={disabled}
          onChange={(event) => {
            setType(event.target.value as CueType)
          }}
          className={inputClass}
        >
          {CUE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`plan.cueType.${type}`)}
            </option>
          ))}
        </select>
      </Field>

      <Field id={ids.label} label={t('plan.editor.labelField')} hint={t('plan.editor.labelHint')}>
        <input
          id={ids.label}
          type="text"
          value={cue.label}
          disabled={disabled}
          aria-describedby={`${ids.label}-hint`}
          onChange={(event) => {
            onChange({ ...cue, label: event.target.value })
          }}
          className={inputClass}
        />
      </Field>

      {/* ------------------------------- payload, per type ------------------------------- */}

      {cue.type === 'scene' ? (
        <Field id={ids.payload} label={t('plan.payload.scene')} hint={t('plan.payload.sceneHint')}>
          <input
            id={ids.payload}
            type="text"
            value={readString(cue.payload, 'scene')}
            disabled={disabled}
            aria-describedby={`${ids.payload}-hint`}
            onChange={(event) => {
              setPayload({ scene: event.target.value })
            }}
            className={inputClass}
          />
        </Field>
      ) : null}

      {cue.type === 'slide' ? (
        <>
          <Field
            id={ids.payload}
            label={t('plan.payload.asset')}
            hint={t('plan.payload.slideAssetHint')}
          >
            <input
              id={ids.payload}
              type="text"
              value={readString(cue.payload, 'asset')}
              disabled={disabled}
              aria-describedby={`${ids.payload}-hint`}
              onChange={(event) => {
                const sourceSlide = Number(readNumber(cue.payload, 'sourceSlide'))
                setPayload(
                  Number.isFinite(sourceSlide) && sourceSlide > 0
                    ? { asset: event.target.value, sourceSlide }
                    : { asset: event.target.value },
                )
              }}
              className={inputClass}
            />
          </Field>
          <Field id={ids.payload2} label={t('plan.payload.sourceSlide')}>
            <input
              id={ids.payload2}
              type="number"
              min={1}
              value={readNumber(cue.payload, 'sourceSlide')}
              disabled={disabled}
              onChange={(event) => {
                const asset = readString(cue.payload, 'asset')
                const parsedSlide = Number.parseInt(event.target.value, 10)
                setPayload(
                  Number.isFinite(parsedSlide) && parsedSlide > 0
                    ? { asset, sourceSlide: parsedSlide }
                    : { asset },
                )
              }}
              className={inputClass}
            />
          </Field>
        </>
      ) : null}

      {cue.type === 'media' ? (
        <>
          <Field
            id={ids.payload}
            label={t('plan.payload.asset')}
            hint={t('plan.payload.mediaAssetHint')}
          >
            <input
              id={ids.payload}
              type="text"
              value={readString(cue.payload, 'asset')}
              disabled={disabled}
              aria-describedby={`${ids.payload}-hint`}
              onChange={(event) => {
                const obsInputName = readString(cue.payload, 'obsInputName')
                setPayload(
                  obsInputName.length > 0
                    ? { asset: event.target.value, obsInputName }
                    : { asset: event.target.value },
                )
              }}
              className={inputClass}
            />
          </Field>
          <Field id={ids.payload2} label={t('plan.payload.obsInputName')}>
            <input
              id={ids.payload2}
              type="text"
              value={readString(cue.payload, 'obsInputName')}
              disabled={disabled}
              onChange={(event) => {
                const asset = readString(cue.payload, 'asset')
                setPayload(
                  event.target.value.length > 0
                    ? { asset, obsInputName: event.target.value }
                    : { asset },
                )
              }}
              className={inputClass}
            />
          </Field>
        </>
      ) : null}

      {cue.type === 'scripture' ? (
        <>
          <Field
            id={ids.payload}
            label={t('plan.payload.reference')}
            hint={t('plan.payload.referenceHint')}
          >
            <input
              id={ids.payload}
              type="text"
              value={readString(cue.payload, 'reference')}
              disabled={disabled}
              aria-describedby={`${ids.payload}-hint`}
              onChange={(event) => {
                const translation = readString(cue.payload, 'translation')
                setPayload(
                  translation.length > 0
                    ? { reference: event.target.value, translation }
                    : { reference: event.target.value },
                )
              }}
              className={inputClass}
            />
          </Field>
          <Field id={ids.payload2} label={t('plan.payload.translation')}>
            <input
              id={ids.payload2}
              type="text"
              value={readString(cue.payload, 'translation')}
              disabled={disabled}
              onChange={(event) => {
                const reference = readString(cue.payload, 'reference')
                setPayload(
                  event.target.value.length > 0
                    ? { reference, translation: event.target.value }
                    : { reference },
                )
              }}
              className={inputClass}
            />
          </Field>
          {/* The missing-text explainer. Not decoration: it is the answer to the first question
              every operator asks when they look at this form. */}
          <p
            data-testid="scripture-no-text-note"
            className="rounded-glass border border-border bg-surface-2 p-3 text-xs text-text-muted"
          >
            {t('plan.scriptureNote')}
          </p>
        </>
      ) : null}

      {cue.type === 'lowerthird' ? (
        <>
          <Field id={ids.payload} label={t('plan.payload.line1')}>
            <input
              id={ids.payload}
              type="text"
              value={readString(cue.payload, 'line1')}
              disabled={disabled}
              onChange={(event) => {
                const line2 = readString(cue.payload, 'line2')
                const template = readString(cue.payload, 'template')
                setPayload({
                  line1: event.target.value,
                  ...(line2.length > 0 ? { line2 } : {}),
                  ...(template.length > 0 ? { template } : {}),
                })
              }}
              className={inputClass}
            />
          </Field>
          <Field id={ids.payload2} label={t('plan.payload.line2')}>
            <input
              id={ids.payload2}
              type="text"
              value={readString(cue.payload, 'line2')}
              disabled={disabled}
              onChange={(event) => {
                const line1 = readString(cue.payload, 'line1')
                const template = readString(cue.payload, 'template')
                setPayload({
                  line1,
                  ...(event.target.value.length > 0 ? { line2: event.target.value } : {}),
                  ...(template.length > 0 ? { template } : {}),
                })
              }}
              className={inputClass}
            />
          </Field>
          <Field id={ids.payload3} label={t('plan.payload.template')}>
            <input
              id={ids.payload3}
              type="text"
              value={readString(cue.payload, 'template')}
              disabled={disabled}
              onChange={(event) => {
                const line1 = readString(cue.payload, 'line1')
                const line2 = readString(cue.payload, 'line2')
                setPayload({
                  line1,
                  ...(line2.length > 0 ? { line2 } : {}),
                  ...(event.target.value.length > 0 ? { template: event.target.value } : {}),
                })
              }}
              className={inputClass}
            />
          </Field>
        </>
      ) : null}

      {cue.type === 'action' ? (
        <Field
          id={ids.payload}
          label={t('plan.payload.action')}
          hint={t('plan.payload.actionHint')}
        >
          <input
            id={ids.payload}
            type="text"
            value={readString(cue.payload, 'action')}
            disabled={disabled}
            aria-describedby={`${ids.payload}-hint`}
            onChange={(event) => {
              setPayload({ action: event.target.value })
            }}
            className={inputClass}
          />
        </Field>
      ) : null}

      {/* ------------------------------------ trigger ------------------------------------ */}

      <fieldset className="flex flex-col gap-3 rounded-glass border border-border p-4">
        <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
          {t('plan.trigger.label')}
        </legend>

        <Field
          id={ids.triggerMode}
          label={t('plan.trigger.modeField')}
          hint={t('plan.trigger.modeHint')}
        >
          <select
            id={ids.triggerMode}
            value={cue.trigger.mode}
            disabled={disabled}
            aria-describedby={`${ids.triggerMode}-hint`}
            onChange={(event) => {
              setTriggerMode(event.target.value as TriggerMode)
            }}
            className={inputClass}
          >
            {TRIGGER_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`plan.trigger.mode.${mode}`)}
              </option>
            ))}
          </select>
        </Field>

        {cue.trigger.mode === 'manual' ? (
          <p className="text-xs text-text-muted">{t('plan.trigger.manualNote')}</p>
        ) : (
          <Field id={ids.triggerText} label={t('plan.trigger.textField')}>
            <input
              id={ids.triggerText}
              type="text"
              value={cue.trigger.text ?? ''}
              disabled={disabled}
              aria-invalid={triggerTextIssue === undefined ? undefined : true}
              aria-describedby={
                triggerTextIssue === undefined ? undefined : `${ids.triggerText}-error`
              }
              onChange={(event) => {
                onChange({
                  ...cue,
                  trigger: { mode: cue.trigger.mode, text: event.target.value },
                })
              }}
              className={clsx(inputClass, triggerTextIssue !== undefined && 'border-panic')}
            />
            {triggerTextIssue === undefined ? null : (
              <p
                id={`${ids.triggerText}-error`}
                role="alert"
                data-testid="trigger-text-error"
                className="text-xs font-medium text-panic"
              >
                {t('plan.trigger.textRequired', {
                  mode: t(`plan.trigger.mode.${cue.trigger.mode}`),
                })}
              </p>
            )}
          </Field>
        )}
      </fieldset>

      {/* ------------------------------------ options ------------------------------------ */}

      <fieldset className="flex flex-col gap-3 rounded-glass border border-border p-4">
        <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
          {t('plan.options.title')}
        </legend>

        <Field
          id={ids.threshold}
          label={t('plan.options.autoFireThreshold')}
          hint={t('plan.options.autoFireThresholdHint')}
        >
          <div className="flex items-center gap-3">
            <input
              id={ids.threshold}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={threshold ?? 0.8}
              disabled={disabled}
              aria-describedby={`${ids.threshold}-hint`}
              aria-valuetext={`${String(Math.round((threshold ?? 0.8) * 100))}%`}
              onChange={(event) => {
                onChange(
                  withOptions(cue, {
                    autoFireThreshold: Number(event.target.value),
                    ...(cue.options?.confirmAlways === undefined
                      ? {}
                      : { confirmAlways: cue.options.confirmAlways }),
                  }),
                )
              }}
              className="flex-1"
            />
            <span data-testid="threshold-readout" className="w-16 text-end font-mono text-sm text-text">
              {threshold === undefined
                ? t('plan.options.thresholdUnset')
                : `${String(Math.round(threshold * 100))}%`}
            </span>
          </div>
        </Field>

        <div className="flex items-start gap-3">
          <input
            id={ids.confirm}
            type="checkbox"
            checked={confirmAlways}
            disabled={disabled}
            aria-describedby={`${ids.confirm}-hint`}
            onChange={(event) => {
              onChange(
                withOptions(cue, {
                  ...(cue.options?.autoFireThreshold === undefined
                    ? {}
                    : { autoFireThreshold: cue.options.autoFireThreshold }),
                  ...(event.target.checked ? { confirmAlways: true } : {}),
                }),
              )
            }}
            className="mt-1 h-5 w-5 shrink-0"
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.confirm} className="text-sm font-medium text-text">
              {t('plan.options.confirmAlways')}
            </label>
            <p id={`${ids.confirm}-hint`} className="text-xs text-text-muted">
              {t('plan.options.confirmAlwaysHint')}
            </p>
          </div>
        </div>
      </fieldset>

      <Field id={ids.note} label={t('plan.editor.noteField')} hint={t('plan.editor.noteHint')}>
        <textarea
          id={ids.note}
          rows={2}
          value={cue.note ?? ''}
          disabled={disabled}
          aria-describedby={`${ids.note}-hint`}
          onChange={(event) => {
            if (event.target.value.length === 0) {
              const { note: _dropped, ...rest } = cue
              onChange(rest)
              return
            }
            onChange({ ...cue, note: event.target.value })
          }}
          className="w-full rounded-glass border border-border bg-surface-2 p-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      {/* Far from the primary controls, and a hold rather than a tap: Standing Rule 6. */}
      <div className="flex justify-end border-t border-border pt-4">
        <HoldButton
          label={t('plan.editor.delete')}
          icon={Trash2}
          disabled={disabled}
          onHoldComplete={onDelete}
        />
      </div>
    </section>
  )
}
