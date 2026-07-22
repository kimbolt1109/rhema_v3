/**
 * Speech settings.
 *
 * Four controls and one editor, and the editor is the one that matters.
 *
 * ## Custom vocabulary is the highest-leverage setting in the app
 *
 * BLUEPRINT.md §8 is explicit, and `@shared/asr` repeats it: boosting the pastor's name, the church
 * name, hymn titles and recurring terms "sharply improves accuracy on exactly the words that
 * matter". Those are proper nouns a generic model has never seen, so they are precisely the words
 * it gets wrong — and precisely the words a cue is likely to key off. The editor therefore says so
 * in as many words rather than presenting an unexplained list box.
 *
 * ## Provider mode is a three-way choice, not a checkbox
 *
 * Cloud is lower latency and much better at Korean; local keeps working when the network — which is
 * already carrying the stream — drops. `auto` prefers cloud and falls back to local, which is why
 * it is the default. Each option carries its own sentence of explanation, because "Auto" alone
 * tells an operator nothing about what happens when the internet dies mid-sermon.
 *
 * ## The not-configured explanation is not an error
 *
 * `DEEPGRAM_API_KEY` is empty on this machine and no key is coming. Standing Rule 5 makes that a
 * resting state, so the panel explains what is missing and points at `HUMAN_TASKS.md`, rather than
 * showing a red failure for a subsystem nobody switched on.
 *
 * Device enumeration is injected ({@link AsrSettingsProps.listDevices}) because jsdom has no
 * `navigator.mediaDevices`; the default reads the real browser and degrades to an explanation.
 */

import clsx from 'clsx'
import { CircleAlert, Plus, RefreshCw, Save, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AsrLanguage,
  AsrSelectionMode,
  AsrSettings as AsrSettingsValue,
  AudioInputDevice,
} from '@shared/asr'
import { ASR_LANGUAGES, ASR_SELECTION_MODES, asrSettingsSchema } from '@shared/asr'
import type { Result } from '@shared/result'

import { browserMediaDevices, listInputDevices } from '../audio/micCapture'
import { Button } from '../components/Button'
import { useAsrStore } from '../store/asrStore'

/**
 * Local model sizes offered.
 *
 * Bounded by VRAM, and the build machine has a 4 GB GTX 1650 — `large-v3` does not fit on it, which
 * is why `small` is the default and the option carries a warning rather than being hidden. A model
 * that does not fit is worse than a smaller one that does. `docs/v2-notes/NETWORK_AND_HARDWARE.md`.
 */
export const LOCAL_MODEL_OPTIONS: readonly string[] = ['tiny', 'base', 'small', 'medium', 'large-v3']

/** The longest term `asrSettingsSchema` will accept. */
export const MAX_VOCABULARY_TERM_LENGTH = 80

/** The most terms `asrSettingsSchema` will accept. */
export const MAX_VOCABULARY_TERMS = 500

/**
 * Fold a typed term into the list.
 *
 * Pure, so the add rules are tested directly. Trims, refuses blanks, refuses duplicates
 * case-insensitively (an operator who types "은혜교회" twice meant it once) and refuses anything
 * the shared schema would reject rather than sending it and being refused at the IPC boundary.
 */
export function addVocabularyTerm(
  terms: readonly string[],
  raw: string,
): { readonly terms: readonly string[]; readonly rejected: 'blank' | 'duplicate' | 'too-long' | 'full' | null } {
  const term = raw.trim().replace(/\s+/g, ' ')
  if (term.length === 0) return { terms, rejected: 'blank' }
  if (term.length > MAX_VOCABULARY_TERM_LENGTH) return { terms, rejected: 'too-long' }
  if (terms.length >= MAX_VOCABULARY_TERMS) return { terms, rejected: 'full' }
  const folded = term.toLocaleLowerCase()
  if (terms.some((existing) => existing.toLocaleLowerCase() === folded)) {
    return { terms, rejected: 'duplicate' }
  }
  return { terms: [...terms, term], rejected: null }
}

/** Remove a term by exact value. */
export function removeVocabularyTerm(terms: readonly string[], term: string): readonly string[] {
  return terms.filter((existing) => existing !== term)
}

export interface AsrSettingsProps {
  /** How to enumerate audio inputs. Injected for jsdom; defaults to the real browser. */
  readonly listDevices?: () => Promise<Result<readonly AudioInputDevice[]>>
}

export function AsrSettings({
  listDevices = () => listInputDevices(browserMediaDevices()),
}: AsrSettingsProps = {}): React.JSX.Element {
  const { t } = useTranslation()

  const settings = useAsrStore((store) => store.settings)
  const status = useAsrStore((store) => store.status)
  const devices = useAsrStore((store) => store.devices)
  const busy = useAsrStore((store) => store.busy)
  const lastError = useAsrStore((store) => store.lastError)
  const hydrate = useAsrStore((store) => store.hydrate)
  const subscribe = useAsrStore((store) => store.subscribe)
  const setSettings = useAsrStore((store) => store.setSettings)
  const reportDevices = useAsrStore((store) => store.reportDevices)

  const [draft, setDraft] = useState<AsrSettingsValue>(settings)
  const [term, setTerm] = useState('')
  const [rejection, setRejection] = useState<string | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  // The store is the source of truth; the draft follows it whenever new settings arrive.
  useEffect(() => {
    setDraft(settings)
  }, [settings])

  const refreshDevices = useCallback(async (): Promise<void> => {
    const result = await listDevices()
    if (result.ok) {
      setDeviceError(null)
      await reportDevices(result.value)
    } else {
      // Not a failure banner: a runtime without device enumeration (or without permission yet) is
      // an ordinary state, and the system-default input still works.
      setDeviceError(result.error.message)
    }
  }, [listDevices, reportDevices])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const update = (patch: Partial<AsrSettingsValue>): void => {
    setSaved(false)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const handleAddTerm = (): void => {
    const result = addVocabularyTerm(draft.customVocabulary, term)
    if (result.rejected !== null) {
      setRejection(t(`asr.settings.vocabulary.rejected.${result.rejected}`))
      return
    }
    setRejection(null)
    setTerm('')
    update({ customVocabulary: result.terms })
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaved(false)

    // The same schema the main process validates with runs here first, so a bad value is refused
    // with a readable message instead of bouncing off an IPC handler.
    if (!asrSettingsSchema.safeParse(draft).success) {
      setRejection(t('asr.settings.invalid'))
      return
    }
    setRejection(null)
    void setSettings(draft).then((result) => {
      setSaved(result.ok)
    })
  }

  const deviceOptions: readonly AudioInputDevice[] =
    draft.deviceId !== null &&
    draft.deviceId.length > 0 &&
    !devices.some((device) => device.deviceId === draft.deviceId)
      ? // Keep an already-saved device selectable even when it is not currently plugged in.
        // Without this, opening this screen with the interface unplugged and pressing Save would
        // silently blank a working mapping.
        [...devices, { deviceId: draft.deviceId, label: t('asr.settings.deviceMissing') }]
      : devices

  const modelOptions = LOCAL_MODEL_OPTIONS.includes(draft.localModel)
    ? LOCAL_MODEL_OPTIONS
    : [...LOCAL_MODEL_OPTIONS, draft.localModel]

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('asr.settings.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('asr.settings.subtitle')}</p>
      </header>

      {status.state === 'not-configured' ? (
        <section
          aria-label={t('asr.settings.notConfigured.title')}
          className="rounded-glass-lg border border-border bg-surface p-5"
        >
          <h2 className="font-semibold text-text">{t('asr.settings.notConfigured.title')}</h2>
          <p className="mt-2 max-w-3xl text-sm text-text-muted">
            {t('asr.settings.notConfigured.body')}
          </p>
          <p className="mt-2 max-w-3xl text-sm text-text-muted">
            {t('asr.settings.notConfigured.humanTasks')}
          </p>
        </section>
      ) : null}

      <form
        aria-label={t('asr.settings.formLabel')}
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
      >
        <fieldset className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5">
          <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('asr.settings.modeLegend')}
          </legend>
          <p className="text-xs text-text-muted">{t('asr.settings.modeHint')}</p>
          {ASR_SELECTION_MODES.map((mode) => (
            <Radio
              key={mode}
              name="asr-mode"
              id={`asr-mode-${mode}`}
              checked={draft.mode === mode}
              label={t(`asr.settings.mode.${mode}`)}
              detail={t(`asr.settings.modeDetail.${mode}`)}
              onSelect={() => {
                update({ mode: mode as AsrSelectionMode })
              }}
            />
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5">
          <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('asr.settings.languageLegend')}
          </legend>
          <p className="text-xs text-text-muted">{t('asr.settings.languageHint')}</p>
          {ASR_LANGUAGES.map((language) => (
            <Radio
              key={language}
              name="asr-language"
              id={`asr-language-${language}`}
              checked={draft.language === language}
              label={t(`asr.settings.language.${language}`)}
              onSelect={() => {
                update({ language: language as AsrLanguage })
              }}
            />
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5">
          <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('asr.settings.deviceLegend')}
          </legend>
          <label htmlFor="asr-device" className="text-sm font-medium text-text">
            {t('asr.settings.deviceLabel')}
          </label>
          <select
            id="asr-device"
            value={draft.deviceId ?? ''}
            aria-describedby="asr-device-hint"
            onChange={(event) => {
              update({ deviceId: event.target.value.length === 0 ? null : event.target.value })
            }}
            className={selectClass}
          >
            <option value="">{t('asr.settings.deviceDefault')}</option>
            {deviceOptions.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <p id="asr-device-hint" className="text-xs text-text-muted">
            {deviceError === null ? t('asr.settings.deviceHint') : t('asr.settings.deviceUnavailable')}
          </p>
          <div>
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={() => {
                void refreshDevices()
              }}
            >
              {t('asr.settings.deviceRefresh')}
            </Button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5">
          <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('asr.settings.modelLegend')}
          </legend>
          <label htmlFor="asr-model" className="text-sm font-medium text-text">
            {t('asr.settings.modelLabel')}
          </label>
          <select
            id="asr-model"
            value={draft.localModel}
            aria-describedby="asr-model-hint"
            onChange={(event) => {
              update({ localModel: event.target.value })
            }}
            className={selectClass}
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <p id="asr-model-hint" className="text-xs text-text-muted">
            {t('asr.settings.modelHint')}
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5">
          <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('asr.settings.vocabulary.legend')}
          </legend>
          <p className="max-w-3xl text-sm text-text-muted">{t('asr.settings.vocabulary.hint')}</p>
          <p className="max-w-3xl text-xs text-text-muted">
            {t('asr.settings.vocabulary.examples')}
          </p>

          <label htmlFor="asr-vocabulary-term" className="text-sm font-medium text-text">
            {t('asr.settings.vocabulary.addLabel')}
          </label>
          <div className="flex flex-wrap items-start gap-2">
            <input
              id="asr-vocabulary-term"
              type="text"
              value={term}
              maxLength={MAX_VOCABULARY_TERM_LENGTH}
              aria-describedby={rejection === null ? undefined : 'asr-vocabulary-error'}
              onChange={(event) => {
                setRejection(null)
                setTerm(event.target.value)
              }}
              onKeyDown={(event) => {
                // Enter adds the term rather than submitting the whole form — an operator typing a
                // list of names should not save-and-close after the first one.
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleAddTerm()
                }
              }}
              className={clsx(
                'min-h-touch min-w-[16rem] flex-1 select-text rounded-glass border border-border bg-surface-2 px-3',
                'text-base text-text',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            />
            <Button variant="secondary" icon={Plus} onClick={handleAddTerm}>
              {t('asr.settings.vocabulary.add')}
            </Button>
          </div>
          {rejection === null ? null : (
            <p id="asr-vocabulary-error" role="alert" className="text-xs font-medium text-panic">
              {rejection}
            </p>
          )}

          {draft.customVocabulary.length === 0 ? (
            <p className="text-sm text-text-muted">{t('asr.settings.vocabulary.empty')}</p>
          ) : (
            <ul aria-label={t('asr.settings.vocabulary.listLabel')} className="flex flex-wrap gap-2">
              {draft.customVocabulary.map((entry) => (
                <li
                  key={entry}
                  className="flex items-center gap-2 rounded-glass border border-border bg-surface-2 py-1 pl-3 pr-1"
                >
                  <span className="select-text text-sm text-text">{entry}</span>
                  <button
                    type="button"
                    aria-label={t('asr.settings.vocabulary.remove', { term: entry })}
                    onClick={() => {
                      setRejection(null)
                      update({ customVocabulary: removeVocabularyTerm(draft.customVocabulary, entry) })
                    }}
                    className="inline-flex h-touch w-touch items-center justify-center rounded-glass text-text-muted hover:text-panic focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="lg" icon={Save} disabled={busy}>
            {t('asr.settings.save')}
          </Button>
          <p role="status" className="text-sm text-text-muted">
            {saved ? t('asr.settings.saved') : ''}
          </p>
        </div>
      </form>

      {lastError !== null ? (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      ) : null}
    </div>
  )
}

const selectClass = clsx(
  'min-h-touch w-full rounded-glass border border-border bg-surface-2 px-3',
  'text-base text-text',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
)

function Radio({
  name,
  id,
  checked,
  label,
  detail,
  onSelect,
}: {
  name: string
  id: string
  checked: boolean
  label: string
  detail?: string
  onSelect: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <input
        type="radio"
        id={id}
        name={name}
        checked={checked}
        onChange={onSelect}
        // The detail is a *description*, not part of the name. Folding it into the label would
        // make the option's accessible name a whole paragraph, which a screen reader has to read
        // out before the operator learns which radio they are on.
        aria-describedby={detail === undefined ? undefined : `${id}-detail`}
        className="mt-1 h-5 w-5 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {detail === undefined ? null : (
          <span id={`${id}-detail`} className="text-xs text-text-muted">
            {detail}
          </span>
        )}
      </div>
    </div>
  )
}

export default AsrSettings
