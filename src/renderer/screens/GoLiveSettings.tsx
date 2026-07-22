/**
 * Go Live settings — everything the GO LIVE button (Phase 5) will use, and nothing that fires it.
 *
 * Four properties this screen exists to hold:
 *
 * 1. **"Not configured" is a first-class screen, not a stub.** On a machine with no
 *    `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — which is every machine until someone does the
 *    Google Cloud work — this is the *only* thing anyone will ever see here. So it says exactly
 *    what to do, in order, points at `HUMAN_TASKS.md`, and states plainly that nothing else in
 *    Verger is affected. Every control is disabled rather than hidden, because a control that
 *    vanished tells the operator nothing about why.
 * 2. **The channel readout is a safety control.** Google signs you in as whichever account the
 *    browser already had; a volunteer with a church account and a personal account has a coin-flip
 *    chance of publishing the service to the wrong one. The channel title is therefore shown large,
 *    next to an explicit "check this" line, before any broadcast can be created.
 * 3. **`public` is warned about, loudly and immediately.** Not on save — on selection, while the
 *    operator is still looking at the dropdown. Publishing a service by mistake is not undoable.
 * 4. **No stream key, ever.** `PersistentStream` has no field for one and none is added here. The
 *    ingest *address* is shown (it is not a secret); the credential stays in OBS. A regression that
 *    added a key field would be caught by `GoLiveSettings.test.tsx`.
 *
 * The title preview runs the same `expandTitleTemplate` the main process will run at creation time,
 * so what the operator reads here is what YouTube gets — rather than a second implementation of
 * `{date}` that can drift.
 */

import clsx from 'clsx'
import { Cast, CircleAlert, KeyRound, LogIn, LogOut, Save, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  BroadcastPrivacy,
  BroadcastTemplate,
  PreflightIssue,
  YouTubeStatus,
} from '@shared/youtube'
import { BROADCAST_PRIVACY, broadcastTemplateSchema, expandTitleTemplate } from '@shared/youtube'

import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { isYouTubeConfigured, summarisePreflight, useYouTubeStore } from '../store/youtubeStore'

/** The template fields as typed, before validation. */
interface TemplateDraft {
  readonly titleTemplate: string
  readonly description: string
  readonly privacy: BroadcastPrivacy
  readonly thumbnailPath: string
  readonly timeZone: string
}

function draftFromTemplate(template: BroadcastTemplate): TemplateDraft {
  return {
    titleTemplate: template.titleTemplate,
    description: template.description,
    privacy: template.privacy,
    thumbnailPath: template.thumbnailPath ?? '',
    timeZone: template.timeZone,
  }
}

function templateFromDraft(draft: TemplateDraft): BroadcastTemplate {
  return {
    titleTemplate: draft.titleTemplate,
    description: draft.description,
    privacy: draft.privacy,
    thumbnailPath: draft.thumbnailPath.trim().length === 0 ? null : draft.thumbnailPath.trim(),
    timeZone: draft.timeZone,
  }
}

/**
 * The date `{date}` should expand to.
 *
 * The scheduled start when there is one — the broadcast is *for* that day, and around midnight the
 * two genuinely differ — otherwise today.
 */
export function previewDate(scheduledStart: string, now: Date): Date {
  if (scheduledStart.length === 0) return now
  const parsed = new Date(scheduledStart)
  return Number.isNaN(parsed.getTime()) ? now : parsed
}

/** `en-CA` gives an unambiguous `YYYY-MM-DD`; Korean operators get their own conventional form. */
export function localeForTitles(language: string): string {
  return language.startsWith('ko') ? 'ko-KR' : 'en-CA'
}

/** Turn a `datetime-local` value into the ISO instant the IPC contract wants, or `null`. */
export function scheduledStartToIso(value: string): string | null {
  if (value.trim().length === 0) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function GoLiveSettings(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const status = useYouTubeStore((store) => store.status)
  const bridgeAvailable = useYouTubeStore((store) => store.bridgeAvailable)
  const authorizing = useYouTubeStore((store) => store.authorizing)
  const saving = useYouTubeStore((store) => store.saving)
  const creating = useYouTubeStore((store) => store.creating)
  const lastError = useYouTubeStore((store) => store.lastError)
  const hydrate = useYouTubeStore((store) => store.hydrate)
  const subscribe = useYouTubeStore((store) => store.subscribe)
  const signIn = useYouTubeStore((store) => store.signIn)
  const signOut = useYouTubeStore((store) => store.signOut)
  const setTemplate = useYouTubeStore((store) => store.setTemplate)
  const createBroadcast = useYouTubeStore((store) => store.createBroadcast)

  const [draft, setDraft] = useState<TemplateDraft>(() => draftFromTemplate(status.template))
  const [scheduledStart, setScheduledStart] = useState('')
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  // The store is the source of truth; the draft follows it whenever a new template arrives.
  useEffect(() => {
    setDraft(draftFromTemplate(status.template))
  }, [status.template])

  const configured = isYouTubeConfigured(status.auth.state) && bridgeAvailable
  const signedIn = status.auth.state === 'signed-in'
  const preflight = useMemo(() => summarisePreflight(status.preflight), [status.preflight])

  const titlePreview = useMemo(
    () =>
      expandTitleTemplate(
        draft.titleTemplate,
        previewDate(scheduledStart, new Date()),
        localeForTitles(i18n.language),
      ),
    [draft.titleTemplate, scheduledStart, i18n.language],
  )

  const update = (patch: Partial<TemplateDraft>): void => {
    setSaved(false)
    setInvalid(false)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaved(false)

    const next = templateFromDraft(draft)
    // The same schema the main process validates with runs here first, so a bad template is
    // refused with a readable message rather than bouncing off an IPC handler.
    if (!broadcastTemplateSchema.safeParse(next).success) {
      setInvalid(true)
      return
    }
    setInvalid(false)

    void setTemplate(next).then((result) => {
      setSaved(result.ok)
    })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('youtube.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('youtube.subtitle')}</p>
      </header>

      {!bridgeAvailable ? (
        <Panel tone="panic" title={t('youtube.bridgeUnavailable.title')}>
          <p className="max-w-3xl text-sm text-text-muted">
            {t('youtube.bridgeUnavailable.body')}
          </p>
        </Panel>
      ) : null}

      {status.auth.state === 'not-configured' ? <NotConfiguredPanel /> : null}

      <AccountPanel
        status={status}
        configured={configured}
        authorizing={authorizing}
        onSignIn={() => {
          void signIn()
        }}
        onSignOut={() => {
          void signOut()
        }}
      />

      <PreflightPanel errors={preflight.errors} warnings={preflight.warnings} />

      <TemplateForm
        draft={draft}
        scheduledStart={scheduledStart}
        titlePreview={titlePreview}
        disabled={!configured}
        saving={saving}
        saved={saved}
        invalid={invalid}
        onChange={update}
        onScheduledStartChange={(value) => {
          setSaved(false)
          setScheduledStart(value)
        }}
        onSubmit={handleSubmit}
      />

      <BroadcastPanel
        status={status}
        creating={creating}
        disabled={!configured || !signedIn || preflight.blocking}
        onCreate={() => {
          const iso = scheduledStartToIso(scheduledStart)
          void createBroadcast(iso === null ? undefined : { scheduledStartTime: iso })
        }}
      />

      <StreamPanel status={status} />

      <Panel tone="neutral" title={t('youtube.quota.title')}>
        <p className="max-w-3xl text-sm text-text-muted">{t('youtube.quota.body')}</p>
      </Panel>

      {lastError !== null ? (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t('youtube.lastError')}: {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------------------------- */

type PanelTone = 'neutral' | 'panic' | 'warning'

const PANEL_BORDER: Record<PanelTone, string> = {
  neutral: 'border-border',
  panic: 'border-panic/50',
  warning: 'border-accent-2/50',
}

const PANEL_HEADING: Record<PanelTone, string> = {
  neutral: 'text-text',
  panic: 'text-panic',
  warning: 'text-accent-2',
}

/**
 * A titled region.
 *
 * `aria-labelledby` on a `<section>` rather than `aria-label`, so the heading the operator reads
 * and the name a screen reader announces are literally the same string and cannot drift.
 */
function Panel({
  tone,
  title,
  children,
}: {
  tone: PanelTone
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className={clsx('rounded-glass-lg border bg-surface p-5', PANEL_BORDER[tone])}
    >
      <h2 id={headingId} className={clsx('font-semibold', PANEL_HEADING[tone])}>
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

/** The screen this machine will actually show. Ordered steps, not a wall of prose. */
function NotConfiguredPanel(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Panel tone="warning" title={t('youtube.notConfigured.title')}>
      <p className="max-w-3xl text-sm text-text-muted">{t('youtube.notConfigured.body')}</p>
      <ol
        aria-label={t('youtube.notConfigured.stepsLabel')}
        className="ms-5 flex list-decimal flex-col gap-2 text-sm text-text"
      >
        <li className="select-text">{t('youtube.notConfigured.step1')}</li>
        <li className="select-text">{t('youtube.notConfigured.step2')}</li>
        <li className="select-text">{t('youtube.notConfigured.step3')}</li>
        <li className="select-text">{t('youtube.notConfigured.step4')}</li>
      </ol>
      <p className="max-w-3xl select-text text-sm text-text-muted">
        {t('youtube.notConfigured.humanTasks')}
      </p>
      <p className="max-w-3xl text-sm text-text-muted">{t('youtube.notConfigured.safe')}</p>
    </Panel>
  )
}

function AccountPanel({
  status,
  configured,
  authorizing,
  onSignIn,
  onSignOut,
}: {
  status: YouTubeStatus
  configured: boolean
  authorizing: boolean
  onSignIn: () => void
  onSignOut: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, channel, lastError } = status.auth
  const signedIn = state === 'signed-in'

  return (
    <Panel tone={state === 'auth-error' ? 'panic' : 'neutral'} title={t('youtube.account.title')}>
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <dt className="text-text-muted">{t('youtube.account.stateLabel')}</dt>
        <dd data-auth-state={state} className="font-medium text-text">
          {t(`youtube.state.${state}`)}
        </dd>
      </dl>

      {signedIn ? (
        channel === null ? (
          <p className="text-sm text-text-muted">{t('youtube.account.channelUnknown')}</p>
        ) : (
          <div className="flex flex-col gap-2 rounded-glass border border-border bg-surface-2 p-4">
            <div className="flex items-center gap-2">
              <Cast aria-hidden="true" className="h-5 w-5 shrink-0 text-live" />
              <span className="text-xs uppercase tracking-wide text-text-muted">
                {t('youtube.account.connectedAsLabel')}
              </span>
            </div>
            <p className="select-text text-lg font-semibold text-text">{channel.title}</p>
            {channel.customUrl === null ? null : (
              <p className="select-text font-mono text-xs text-text-muted">{channel.customUrl}</p>
            )}
            <p className="max-w-3xl text-sm text-text-muted">
              {t('youtube.account.confirmChannel')}
            </p>
          </div>
        )
      ) : null}

      {lastError === null ? null : (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-panic">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="select-text">
            {t('youtube.account.authError')} — {lastError}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {signedIn ? (
          <Button
            variant="secondary"
            size="lg"
            icon={LogOut}
            disabled={!configured || authorizing}
            onClick={onSignOut}
          >
            {t('youtube.account.signOut')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            icon={LogIn}
            disabled={!configured || authorizing}
            onClick={onSignIn}
          >
            {authorizing ? t('youtube.account.signingIn') : t('youtube.account.signIn')}
          </Button>
        )}
      </div>

      <p className="max-w-3xl text-xs text-text-muted">
        {signedIn ? t('youtube.account.signedOutHint') : t('youtube.account.signInHint')}
      </p>
    </Panel>
  )
}

/**
 * Pre-flight, split by severity.
 *
 * Errors and warnings are separate lists with separate visible words, never one list distinguished
 * by colour: `docs/v2-notes/SHORTCUTS_AND_A11Y.md` is emphatic that colour is never the only
 * channel, and a booth is a dark room.
 */
function PreflightPanel({
  errors,
  warnings,
}: {
  errors: readonly PreflightIssue[]
  warnings: readonly PreflightIssue[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const total = errors.length + warnings.length

  return (
    <Panel tone={errors.length > 0 ? 'panic' : 'neutral'} title={t('youtube.preflight.title')}>
      {total === 0 ? (
        <p className="text-sm text-text-muted">{t('youtube.preflight.allClear')}</p>
      ) : (
        <ul
          aria-label={t('youtube.preflight.listLabel')}
          className="flex flex-col gap-2 text-sm"
        >
          {[...errors, ...warnings].map((issue) => (
            <li
              key={`${issue.severity}-${issue.code}`}
              data-preflight-severity={issue.severity}
              className={clsx(
                'flex items-start gap-2 rounded-glass border bg-surface-2 p-3',
                issue.severity === 'error' ? 'border-panic/60' : 'border-accent-2/60',
              )}
            >
              {issue.severity === 'error' ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-panic" />
              ) : (
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-accent-2"
                />
              )}
              <span className="flex flex-col gap-0.5">
                <span
                  className={clsx(
                    'text-xs font-semibold uppercase tracking-wide',
                    issue.severity === 'error' ? 'text-panic' : 'text-accent-2',
                  )}
                >
                  {t(`youtube.preflight.severity.${issue.severity}`)}
                </span>
                <span className="select-text text-text">
                  {t(`youtube.preflight.code.${issue.code}`, { defaultValue: issue.message })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-3xl text-xs text-text-muted">{t('youtube.preflight.blocksNote')}</p>
      <p className="max-w-3xl text-xs text-text-muted">{t('youtube.preflight.ccliNote')}</p>
    </Panel>
  )
}

const controlClass = clsx(
  'min-h-touch w-full select-text rounded-glass border border-border bg-surface-2 px-3',
  'text-base text-text',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-60',
)

function TemplateForm({
  draft,
  scheduledStart,
  titlePreview,
  disabled,
  saving,
  saved,
  invalid,
  onChange,
  onScheduledStartChange,
  onSubmit,
}: {
  draft: TemplateDraft
  scheduledStart: string
  titlePreview: string
  disabled: boolean
  saving: boolean
  saved: boolean
  invalid: boolean
  onChange: (patch: Partial<TemplateDraft>) => void
  onScheduledStartChange: (value: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const headingId = useId()
  const descriptionId = useId()
  const privacyId = useId()
  const scheduledId = useId()
  const timeZoneId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-glass-lg border border-border bg-surface p-5"
    >
      <h2 id={headingId} className="font-semibold text-text">
        {t('youtube.template.title')}
      </h2>

      <form
        aria-label={t('youtube.template.formLabel')}
        onSubmit={onSubmit}
        className="mt-3 flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1.5">
          <TextField
            label={t('youtube.template.titleLabel')}
            value={draft.titleTemplate}
            onValueChange={(value) => {
              onChange({ titleTemplate: value })
            }}
            hint={t('youtube.template.titleHint')}
            disabled={disabled}
            {...(invalid ? { error: t('youtube.template.invalid') } : {})}
          />
          {/* The live preview runs the shared expander, so there is exactly one implementation of
              `{date}` between here and the broadcast YouTube actually receives. */}
          <p className="text-xs font-medium text-text-muted">
            {t('youtube.template.previewLabel')}
          </p>
          <p
            data-testid="title-preview"
            aria-live="polite"
            className="select-text rounded-glass border border-border bg-surface-2 px-3 py-2 text-base text-text"
          >
            {titlePreview.length === 0 ? t('youtube.template.previewEmpty') : titlePreview}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={descriptionId} className="text-sm font-medium text-text">
            {t('youtube.template.descriptionLabel')}
          </label>
          <textarea
            id={descriptionId}
            value={draft.description}
            rows={4}
            disabled={disabled}
            aria-describedby={`${descriptionId}-hint`}
            onChange={(event) => {
              onChange({ description: event.target.value })
            }}
            className={clsx(controlClass, 'py-2')}
          />
          <p id={`${descriptionId}-hint`} className="text-xs text-text-muted">
            {t('youtube.template.descriptionHint')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={privacyId} className="text-sm font-medium text-text">
            {t('youtube.template.privacyLabel')}
          </label>
          <select
            id={privacyId}
            value={draft.privacy}
            disabled={disabled}
            aria-describedby={`${privacyId}-hint`}
            onChange={(event) => {
              onChange({ privacy: event.target.value as BroadcastPrivacy })
            }}
            className={controlClass}
          >
            {BROADCAST_PRIVACY.map((privacy) => (
              <option key={privacy} value={privacy}>
                {t(`youtube.template.privacyOption.${privacy}`)}
              </option>
            ))}
          </select>
          <p id={`${privacyId}-hint`} className="text-xs text-text-muted">
            {t('youtube.template.privacyHint')}
          </p>

          {/* Warned about on selection rather than on save: by the time an operator presses Save
              they have stopped reading, and a public service cannot be un-published. */}
          {draft.privacy === 'public' ? (
            <div
              role="alert"
              className="mt-1 flex items-start gap-2 rounded-glass border border-panic/60 bg-surface-2 p-3"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-panic" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-panic">
                  {t('youtube.publicWarning.title')}
                </span>
                <span className="max-w-3xl text-sm text-text-muted">
                  {t('youtube.publicWarning.body')}
                </span>
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={scheduledId} className="text-sm font-medium text-text">
            {t('youtube.template.scheduledLabel')}
          </label>
          <input
            id={scheduledId}
            type="datetime-local"
            value={scheduledStart}
            disabled={disabled}
            aria-describedby={`${scheduledId}-hint`}
            onChange={(event) => {
              onScheduledStartChange(event.target.value)
            }}
            className={controlClass}
          />
          <p id={`${scheduledId}-hint`} className="text-xs text-text-muted">
            {t('youtube.template.scheduledHint')}
          </p>
        </div>

        <TextField
          label={t('youtube.template.thumbnailLabel')}
          value={draft.thumbnailPath}
          onValueChange={(value) => {
            onChange({ thumbnailPath: value })
          }}
          hint={t('youtube.template.thumbnailHint')}
          disabled={disabled}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={timeZoneId} className="text-sm font-medium text-text">
            {t('youtube.template.timeZoneLabel')}
          </label>
          <input
            id={timeZoneId}
            type="text"
            value={draft.timeZone}
            disabled={disabled}
            aria-describedby={`${timeZoneId}-hint`}
            onChange={(event) => {
              onChange({ timeZone: event.target.value })
            }}
            className={controlClass}
          />
          <p id={`${timeZoneId}-hint`} className="text-xs text-text-muted">
            {t('youtube.template.timeZoneHint')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            icon={Save}
            disabled={disabled || saving}
          >
            {t('youtube.template.save')}
          </Button>
          <p role="status" className="text-sm text-text-muted">
            {saved ? t('youtube.template.saved') : ''}
          </p>
        </div>
      </form>
    </section>
  )
}

function BroadcastPanel({
  status,
  creating,
  disabled,
  onCreate,
}: {
  status: YouTubeStatus
  creating: boolean
  disabled: boolean
  onCreate: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const broadcast = status.broadcast

  return (
    <Panel tone="neutral" title={t('youtube.broadcast.title')}>
      {broadcast === null ? (
        <p className="text-sm text-text-muted">{t('youtube.broadcast.none')}</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <Row label={t('youtube.broadcast.titleLabel')} value={broadcast.title} />
          <Row
            label={t('youtube.broadcast.privacyLabel')}
            value={t(`youtube.template.privacyOption.${broadcast.privacy}`)}
          />
          <Row
            label={t('youtube.broadcast.scheduledLabel')}
            value={broadcast.scheduledStartTime}
          />
          <Row
            label={t('youtube.broadcast.lifecycleLabel')}
            value={t(`youtube.broadcast.lifecycle.${broadcast.lifecycle}`)}
          />
          <Row
            label={t('youtube.broadcast.boundLabel')}
            value={broadcast.boundStreamId ?? t('youtube.broadcast.notBound')}
          />
          {broadcast.watchUrl === null ? null : (
            <Row label={t('youtube.broadcast.watchUrlLabel')} value={broadcast.watchUrl} />
          )}
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="lg"
          icon={Cast}
          disabled={disabled || creating}
          onClick={onCreate}
        >
          {creating ? t('youtube.broadcast.creating') : t('youtube.broadcast.create')}
        </Button>
      </div>
      <p className="max-w-3xl text-xs text-text-muted">{t('youtube.broadcast.createHint')}</p>
    </Panel>
  )
}

function StreamPanel({ status }: { status: YouTubeStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const stream = status.stream

  return (
    <Panel tone="neutral" title={t('youtube.stream.title')}>
      <p className="max-w-3xl text-sm text-text-muted">{t('youtube.stream.explain')}</p>

      {stream === null ? (
        <p className="text-sm text-text-muted">{t('youtube.stream.none')}</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <Row label={t('youtube.stream.nameLabel')} value={stream.title} />
          <Row
            label={t('youtube.stream.ingestLabel')}
            value={stream.ingestAddress ?? t('youtube.stream.ingestUnknown')}
          />
          <Row
            label={t('youtube.stream.healthLabel')}
            value={t(`youtube.stream.health.${stream.health}`)}
          />
        </dl>
      )}

      {/* Stated, rather than silently omitted: an operator hunting for the credential needs to
          know it is intentionally absent, or they will assume the screen is broken. */}
      <p className="flex max-w-3xl items-start gap-1.5 text-xs text-text-muted">
        <KeyRound aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('youtube.stream.keyNote')}</span>
      </p>
    </Panel>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="select-text break-all text-text">{value}</dd>
    </>
  )
}

export default GoLiveSettings
