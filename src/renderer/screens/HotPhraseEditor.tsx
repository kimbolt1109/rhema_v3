/**
 * Hot phrases — a spoken phrase bound to a cue.
 *
 * The third detector, and the one that needs nothing: no plan, no alignment, no look-ahead window.
 * "let's pray" fires the prayer slide whether or not the sermon ever went near the script, which is
 * why BLUEPRINT.md §4 keeps it running when the plan-follower has given up.
 *
 * ## The short-phrase warning is the whole safety story here
 *
 * A hot phrase is a substring match against a live transcript. A three-character phrase is not a
 * phrase, it is a syllable, and it turns up inside ordinary words several times a minute — so it
 * will fire a cue in front of the congregation when nobody meant it to. The editor therefore warns
 * loudly below {@link MIN_SAFE_HOT_PHRASE_LENGTH} and refuses outright below the schema's floor.
 * It warns rather than refuses in the middle band because a legitimate short Korean phrase exists
 * and the operator, not this component, is the one who knows their own service.
 *
 * ## Binding
 *
 * A phrase must name a cue that exists. With no plan authored there is nothing to bind to, and the
 * editor says so instead of offering an empty picker that produces phrases which fire nothing.
 */

import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { HotPhrase } from '@shared/cue'

import { useCueStore } from '../store/cueStore'
import { usePlanStore } from '../store/planStore'

/**
 * Below this many characters a phrase is warned about.
 *
 * Four is not a magic number so much as the point at which a Korean or English fragment stops being
 * findable inside ordinary speech by accident. See the module note.
 */
export const MIN_SAFE_HOT_PHRASE_LENGTH = 4

/** The schema's own floor (`cueEngineSettingsSchema`), below which a phrase cannot be saved. */
export const MIN_HOT_PHRASE_LENGTH = 2

/** How many phrases the settings schema accepts. */
export const MAX_HOT_PHRASES = 200

/** Whether a phrase is short enough to fire by accident. Exported so the test states the rule. */
export function isRiskilyShort(phrase: string): boolean {
  const trimmed = phrase.trim()
  return trimmed.length > 0 && trimmed.length < MIN_SAFE_HOT_PHRASE_LENGTH
}

/** Why an add was refused, or `null` when it is acceptable. */
export type HotPhraseRejection = 'too-short' | 'duplicate' | 'full'

export function rejectHotPhrase(
  phrase: string,
  existing: readonly HotPhrase[],
): HotPhraseRejection | null {
  const trimmed = phrase.trim()
  if (trimmed.length < MIN_HOT_PHRASE_LENGTH) return 'too-short'
  if (existing.some((entry) => entry.phrase.trim().toLowerCase() === trimmed.toLowerCase())) {
    return 'duplicate'
  }
  if (existing.length >= MAX_HOT_PHRASES) return 'full'
  return null
}

let phraseCounter = 0
function newPhraseId(): string {
  const maybeCrypto = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto
  if (maybeCrypto !== undefined && typeof maybeCrypto.randomUUID === 'function') {
    return `phrase-${maybeCrypto.randomUUID()}`
  }
  phraseCounter += 1
  return `phrase-${String(Date.now())}-${String(phraseCounter)}`
}

export function HotPhraseEditor(): React.JSX.Element {
  const { t } = useTranslation()

  const settings = useCueStore((state) => state.settings)
  const setSettings = useCueStore((state) => state.setSettings)
  const busy = useCueStore((state) => state.busy)
  const lastError = useCueStore((state) => state.lastError)
  const cues = usePlanStore((state) => state.plan.cues)

  const [draft, setDraft] = useState('')
  const [draftCueId, setDraftCueId] = useState('')
  const [rejection, setRejection] = useState<HotPhraseRejection | null>(null)

  const phrases = settings.hotPhrases
  const hasCues = cues.length > 0
  const selectedCueId = draftCueId.length > 0 ? draftCueId : (cues[0]?.id ?? '')

  const save = (next: readonly HotPhrase[]): void => {
    void setSettings({ ...settings, hotPhrases: next })
  }

  const add = (): void => {
    const refusal = rejectHotPhrase(draft, phrases)
    setRejection(refusal)
    if (refusal !== null || !hasCues) return
    save([
      ...phrases,
      { id: newPhraseId(), phrase: draft.trim(), cueId: selectedCueId, enabled: true },
    ])
    setDraft('')
  }

  return (
    <section
      aria-label={t('cue.hotPhrases.title')}
      data-testid="hot-phrase-editor"
      className="flex flex-col gap-4 rounded-glass border border-border bg-surface p-4"
    >
      <div>
        <h2 className="text-base font-semibold text-text">{t('cue.hotPhrases.title')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">{t('cue.hotPhrases.subtitle')}</p>
      </div>

      {hasCues ? null : (
        <p role="note" className="text-sm text-text-muted">
          {t('cue.hotPhrases.noCues')}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="hot-phrase-new" className="text-xs font-medium text-text-muted">
            {t('cue.hotPhrases.phraseLabel')}
          </label>
          <input
            id="hot-phrase-new"
            type="text"
            value={draft}
            placeholder={t('cue.hotPhrases.phrasePlaceholder')}
            onChange={(event) => {
              setDraft(event.target.value)
              setRejection(null)
            }}
            className="min-h-touch w-64 rounded-glass border border-border bg-surface-2 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hot-phrase-new-cue" className="text-xs font-medium text-text-muted">
            {t('cue.hotPhrases.cueLabel')}
          </label>
          <select
            id="hot-phrase-new-cue"
            value={selectedCueId}
            disabled={!hasCues}
            onChange={(event) => {
              setDraftCueId(event.target.value)
            }}
            className="min-h-touch rounded-glass border border-border bg-surface-2 px-3 text-sm text-text disabled:opacity-60"
          >
            {cues.map((cue) => (
              <option key={cue.id} value={cue.id}>
                {cue.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          data-testid="hot-phrase-add"
          disabled={busy || !hasCues}
          onClick={add}
          className="inline-flex min-h-touch items-center gap-2 rounded-glass border border-border bg-surface-2 px-4 text-sm font-medium text-text hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('cue.hotPhrases.add')}
        </button>
      </div>

      {rejection === null ? null : (
        <p role="alert" data-testid="hot-phrase-rejection" className="text-sm text-panic">
          {rejection === 'too-short'
            ? t('cue.hotPhrases.tooShort', { min: MIN_HOT_PHRASE_LENGTH })
            : rejection === 'duplicate'
              ? t('cue.hotPhrases.duplicate')
              : t('cue.hotPhrases.full')}
        </p>
      )}

      {/* The draft is warned about before it is ever saved: telling the operator afterwards is
          telling them once the accident is already configured. */}
      {isRiskilyShort(draft) ? (
        <p data-testid="hot-phrase-draft-warning" className="flex items-start gap-2 text-sm text-panic">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('cue.hotPhrases.shortWarning', { min: MIN_SAFE_HOT_PHRASE_LENGTH })}
        </p>
      ) : null}

      {phrases.length === 0 ? (
        <div>
          <p className="text-sm text-text-muted">{t('cue.hotPhrases.empty')}</p>
          <p className="text-xs text-text-muted">{t('cue.hotPhrases.emptyHint')}</p>
        </div>
      ) : (
        <ul aria-label={t('cue.hotPhrases.listLabel')} className="flex flex-col gap-2">
          {phrases.map((entry) => {
            const short = isRiskilyShort(entry.phrase)
            return (
              <li
                key={entry.id}
                data-testid={`hot-phrase-${entry.id}`}
                data-short={short ? 'true' : 'false'}
                data-enabled={entry.enabled ? 'true' : 'false'}
                className="flex flex-wrap items-center gap-3 rounded-glass border border-border bg-surface-2 p-3"
              >
                <input
                  id={`hot-phrase-enabled-${entry.id}`}
                  type="checkbox"
                  checked={entry.enabled}
                  disabled={busy}
                  onChange={(event) => {
                    save(
                      phrases.map((candidate) =>
                        candidate.id === entry.id
                          ? { ...candidate, enabled: event.target.checked }
                          : candidate,
                      ),
                    )
                  }}
                  className="h-5 w-5 shrink-0"
                />
                <label
                  htmlFor={`hot-phrase-enabled-${entry.id}`}
                  className="text-sm font-medium text-text"
                >
                  {t('cue.hotPhrases.enableLabel', { phrase: entry.phrase })}
                </label>

                <label htmlFor={`hot-phrase-cue-${entry.id}`} className="sr-only">
                  {t('cue.hotPhrases.cueLabel')}
                </label>
                <select
                  id={`hot-phrase-cue-${entry.id}`}
                  value={entry.cueId}
                  disabled={busy || !hasCues}
                  onChange={(event) => {
                    save(
                      phrases.map((candidate) =>
                        candidate.id === entry.id
                          ? { ...candidate, cueId: event.target.value }
                          : candidate,
                      ),
                    )
                  }}
                  className="min-h-touch rounded-glass border border-border bg-surface px-3 text-sm text-text disabled:opacity-60"
                >
                  {cues.some((cue) => cue.id === entry.cueId) ? null : (
                    <option value={entry.cueId}>{entry.cueId}</option>
                  )}
                  {cues.map((cue) => (
                    <option key={cue.id} value={cue.id}>
                      {cue.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    save(phrases.filter((candidate) => candidate.id !== entry.id))
                  }}
                  className="ms-auto inline-flex min-h-touch items-center gap-2 rounded-glass border border-border px-3 text-sm text-text hover:border-panic/60 hover:text-panic focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {t('cue.hotPhrases.remove', { phrase: entry.phrase })}
                </button>

                {short ? (
                  <p className="flex w-full items-start gap-2 text-xs text-panic">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    {t('cue.hotPhrases.shortWarning', { min: MIN_SAFE_HOT_PHRASE_LENGTH })}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {lastError === null ? null : (
        <p className="text-xs text-panic">
          {t('cue.hotPhrases.saveFailed')} {lastError.message}
        </p>
      )}
    </section>
  )
}

export default HotPhraseEditor
