/**
 * The Connection screen — Phase 1's only view.
 *
 * What it shows and why:
 *
 * - The **big status light** first, above the form. The operator's most common question is "am I
 *   connected right now", not "what is the URL".
 * - **`not-configured` gets instructions, not an error.** Standing Rule 5: an empty config is an
 *   expected resting state. The copy names the exact OBS menu path and points at HUMAN_TASKS.md,
 *   because installing OBS is a human-only step the app cannot do for anyone.
 * - **`auth-failed` explains the deliberate non-retry.** `src/shared/obs.ts` documents why that
 *   state is terminal; the operator has to be told that the silence is a decision, or they will
 *   sit waiting for a reconnect that is never coming.
 * - **When connected, everything shown is an observation.** OBS version, obs-websocket version,
 *   RPC version, and the scene list are all read from OBS. There is no control here that changes
 *   OBS's state — Standing Rule 2, and scene switching is a later phase.
 */

import { Info, Layers, Plug, Unplug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { obsUrlSchema } from '@shared/config'

import { Button } from '../components/Button'
import { StatusIndicator } from '../components/StatusIndicator'
import { TextField } from '../components/TextField'
import { useObsStore } from '../store/obsStore'

/** obs-websocket v5's default. Prefilled, not imposed — the operator can replace it. */
export const DEFAULT_OBS_URL = 'ws://127.0.0.1:4455'

/** States in which a Disconnect action is meaningful. */
const LIVE_STATES = new Set(['connecting', 'connected', 'reconnecting'])

export function ConnectionScreen(): React.JSX.Element {
  const { t } = useTranslation()

  const status = useObsStore((state) => state.status)
  const sceneList = useObsStore((state) => state.sceneList)
  const connecting = useObsStore((state) => state.connecting)
  const bridgeAvailable = useObsStore((state) => state.bridgeAvailable)
  const hydrate = useObsStore((state) => state.hydrate)
  const subscribe = useObsStore((state) => state.subscribe)
  const connect = useObsStore((state) => state.connect)
  const disconnect = useObsStore((state) => state.disconnect)

  const [url, setUrl] = useState<string>(DEFAULT_OBS_URL)
  const [password, setPassword] = useState<string>('')
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    // Subscribe BEFORE hydrating, so a status pushed while the initial read is in flight is not
    // dropped on the floor.
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  const urlError = useMemo(() => {
    if (!submitted) return undefined
    return obsUrlSchema.safeParse(url).success ? undefined : t('connection.urlInvalid')
  }, [submitted, url, t])

  const showDisconnect = LIVE_STATES.has(status.state)

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSubmitted(true)
    if (!obsUrlSchema.safeParse(url).success) return
    // An empty field means "OBS has authentication turned off" — `null`, not `''`. The
    // distinction is load-bearing in `src/shared/obs.ts`.
    void connect({ url, password: password.length === 0 ? null : password })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('connection.title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">{t('connection.subtitle')}</p>
      </header>

      <StatusIndicator status={status} />

      {!bridgeAvailable ? (
        <Callout title={t('connection.bridgeUnavailable.title')} tone="panic">
          <p>{t('connection.bridgeUnavailable.body')}</p>
        </Callout>
      ) : null}

      {status.state === 'not-configured' && bridgeAvailable ? (
        <Callout title={t('connection.notConfigured.title')} tone="muted">
          <p>{t('connection.notConfigured.body')}</p>
          <p className="mt-2 font-medium text-text">{t('connection.notConfigured.humanTasks')}</p>
        </Callout>
      ) : null}

      {status.state === 'auth-failed' ? (
        <Callout title={t('connection.authFailed.title')} tone="panic">
          <p>{t('connection.authFailed.body')}</p>
          <p className="mt-2">{t('connection.authFailed.noRetry')}</p>
        </Callout>
      ) : null}

      <form
        aria-label={t('connection.formLabel')}
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-glass-lg border border-border bg-surface p-5"
      >
        <TextField
          id="obs-url"
          name="obsUrl"
          label={t('connection.urlLabel')}
          value={url}
          onValueChange={setUrl}
          placeholder={t('connection.urlPlaceholder')}
          hint={t('connection.urlHint')}
          autoComplete="off"
          {...(urlError !== undefined ? { error: urlError } : {})}
        />

        <TextField
          id="obs-password"
          name="obsPassword"
          type="password"
          label={t('connection.passwordLabel')}
          value={password}
          onValueChange={setPassword}
          hint={t('connection.passwordHint')}
          autoComplete="off"
        />

        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" size="lg" icon={Plug} disabled={connecting}>
            {connecting ? t('actions.connecting') : t('actions.connect')}
          </Button>

          {showDisconnect ? (
            <Button
              variant="danger"
              size="lg"
              icon={Unplug}
              disabled={connecting}
              onClick={() => {
                void disconnect()
              }}
            >
              {t('actions.disconnect')}
            </Button>
          ) : null}
        </div>
      </form>

      {status.state === 'connected' ? (
        <section
          aria-label={t('connection.details.title')}
          className="rounded-glass-lg border border-border bg-surface p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
            {t('connection.details.title')}
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Detail
              term={t('connection.details.obsVersion')}
              value={status.obsVersion ?? t('connection.details.unknown')}
            />
            <Detail
              term={t('connection.details.websocketVersion')}
              value={status.obsWebSocketVersion ?? t('connection.details.unknown')}
            />
            <Detail
              term={t('connection.details.rpcVersion')}
              value={
                status.rpcVersion === null
                  ? t('connection.details.unknown')
                  : String(status.rpcVersion)
              }
            />
            <Detail
              term={t('connection.details.currentScene')}
              value={status.currentProgramScene ?? t('connection.details.unknown')}
            />
          </dl>
        </section>
      ) : null}

      {status.state === 'connected' ? (
        <section
          aria-label={t('connection.scenes.title')}
          className="rounded-glass-lg border border-border bg-surface p-5"
        >
          <div className="flex items-center gap-2">
            <Layers aria-hidden="true" className="h-4 w-4 text-text-muted" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
              {t('connection.scenes.title')}
            </h2>
          </div>

          {sceneList === null || sceneList.scenes.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">{t('connection.scenes.empty')}</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-text-muted">
                {t('connection.scenes.countLabel', { total: sceneList.scenes.length })}
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {sceneList.scenes.map((scene) => {
                  const isProgram = scene.name === sceneList.currentProgramScene
                  const isPreview = scene.name === sceneList.currentPreviewScene
                  return (
                    <li
                      key={`${String(scene.index)}-${scene.name}`}
                      className="flex min-h-touch items-center justify-between gap-3 rounded-glass border border-border bg-surface-2 px-3"
                    >
                      <span className="truncate text-sm text-text">{scene.name}</span>
                      <span className="flex shrink-0 gap-2">
                        {isProgram ? <Badge tone="live">{t('connection.scenes.program')}</Badge> : null}
                        {isPreview ? (
                          <Badge tone="accent">{t('connection.scenes.preview')}</Badge>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          <p className="mt-3 flex items-start gap-1.5 text-xs text-text-muted">
            <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('connection.scenes.readOnlyNote')}</span>
          </p>
        </section>
      ) : null}
    </div>
  )
}

function Detail({ term, value }: { term: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-glass border border-border bg-surface-2 px-3 py-2">
      <dt className="text-xs text-text-muted">{term}</dt>
      <dd className="select-text font-mono text-sm text-text">{value}</dd>
    </div>
  )
}

function Badge({
  tone,
  children,
}: {
  tone: 'live' | 'accent'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={
        tone === 'live'
          ? 'rounded-glass border border-live/60 px-2 py-0.5 text-xs font-medium text-live'
          : 'rounded-glass border border-accent/60 px-2 py-0.5 text-xs font-medium text-accent-2'
      }
    >
      {children}
    </span>
  )
}

function Callout({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'panic' | 'muted'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className={
        tone === 'panic'
          ? 'rounded-glass-lg border border-panic/50 bg-surface p-5'
          : 'rounded-glass-lg border border-border bg-surface p-5'
      }
    >
      <h2 className={tone === 'panic' ? 'font-semibold text-panic' : 'font-semibold text-text'}>
        {title}
      </h2>
      <div className="mt-2 max-w-2xl text-sm text-text-muted">{children}</div>
    </section>
  )
}
