/**
 * The Overlay panel — the operator's control surface for the independent overlay layer.
 *
 * BLUEPRINT.md §6: the lower-third is its own LAYER, not a slide. An OBS scene is
 * `camera source(s) + a persistent Overlays browser source on top`, so switching cameras never
 * touches the overlay and showing a lower-third never touches the camera. That independence shows
 * up here as three separate blocks with three separate SHOW/HIDE pairs — there is deliberately no
 * combined "show everything" control, because a control that mutates two layers at once is how the
 * independence quietly dies.
 *
 * Design notes:
 *
 * - **The state readout is not decoration.** It is the operator's only view of what the
 *   congregation can see without turning to the program monitor. It shows the server's snapshot,
 *   never the contents of the input fields — typing a name into `line1` changes nothing on screen
 *   until SHOW is pressed, and the readout must not imply otherwise. `revision` is shown so a
 *   stuck overlay is visible as a number that stopped moving.
 * - **Zero attached overlays while a layer is visible is an alarm**, not a footnote:
 *   `src/shared/ipc.ts` records that this is exactly the case where OBS's Overlays browser source
 *   has died and nothing at all is on screen while this panel cheerfully says "visible".
 * - **The OBS URL comes from `OverlayServerInfo.pageUrl`**, never rebuilt here. If this component
 *   string-built a URL it would eventually disagree with what the server actually bound, which is
 *   the precise drift `src/shared/net.ts` exists to prevent.
 * - **CLEAR ALL is a hold, and it is the only destructive control on the panel.** Standing Rule 6
 *   plus FITTS-3 (`docs/v2-notes/SHORTCUTS_AND_A11Y.md`): it sits in its own bordered zone at the
 *   bottom, far from every SHOW button, and it cannot complete in under 1.5 s.
 * - **Verger never ships verse text.** The scripture `text` field is labelled as supplied at
 *   runtime — from a licensed API or a verified public-domain file — per Standing Rule 4.
 */

import clsx from 'clsx'
import {
  BookOpen,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Server,
  Trash2,
  Type,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { LowerThirdTemplate, OverlayCommand } from '@shared/overlay'
import { LOWER_THIRD_TEMPLATES } from '@shared/overlay'

import { Button } from '../components/Button'
import { HoldButton } from '../components/HoldButton'
import { TextField } from '../components/TextField'
import { anyLayerVisible, useOverlayStore } from '../store/overlayStore'

/** How long CLEAR ALL must be held. Above the 1.5 s KAHNEMAN-2 floor, matching v2's shipped 2 s. */
export const CLEAR_ALL_HOLD_MS = 2000

export function OverlayPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const state = useOverlayStore((store) => store.state)
  const serverInfo = useOverlayStore((store) => store.serverInfo)
  const bridgeAvailable = useOverlayStore((store) => store.bridgeAvailable)
  const sending = useOverlayStore((store) => store.sending)
  const lastError = useOverlayStore((store) => store.lastError)
  const hydrate = useOverlayStore((store) => store.hydrate)
  const subscribe = useOverlayStore((store) => store.subscribe)
  const send = useOverlayStore((store) => store.send)

  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [template, setTemplate] = useState<LowerThirdTemplate>('bar')

  const [reference, setReference] = useState('')
  const [verseText, setVerseText] = useState('')
  const [translation, setTranslation] = useState('')
  const [attribution, setAttribution] = useState('')

  const [slideSrc, setSlideSrc] = useState('')

  useEffect(() => {
    // Subscribe BEFORE hydrating, so a snapshot broadcast while the initial read is in flight is
    // not dropped on the floor.
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  const dispatch = (command: OverlayCommand): void => {
    void send(command)
  }

  const layersVisible = anyLayerVisible(state)
  const noOverlaysAttached = serverInfo.clients === 0

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('overlay.title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">{t('overlay.subtitle')}</p>
      </header>

      {!bridgeAvailable ? (
        <section
          aria-label={t('overlay.bridgeUnavailable.title')}
          className="rounded-glass-lg border border-panic/50 bg-surface p-5"
        >
          <h2 className="font-semibold text-panic">{t('overlay.bridgeUnavailable.title')}</h2>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {t('overlay.bridgeUnavailable.body')}
          </p>
        </section>
      ) : null}

      <ServerBlock />

      {layersVisible && noOverlaysAttached ? (
        <section
          role="alert"
          aria-label={t('overlay.warning.noClientsTitle')}
          className="rounded-glass-lg border-2 border-panic bg-surface p-5"
        >
          <h2 className="flex items-center gap-2 font-semibold text-panic">
            <CircleAlert aria-hidden="true" className="h-5 w-5 shrink-0" />
            {t('overlay.warning.noClientsTitle')}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {t('overlay.warning.noClientsBody')}
          </p>
        </section>
      ) : null}

      <StateReadout />

      {/* ---------------------------------------------------------------- lower third */}
      <LayerSection icon={Type} title={t('overlay.lowerThird.title')}>
        <TextField
          id="overlay-lower-third-line1"
          label={t('overlay.lowerThird.line1')}
          value={line1}
          onValueChange={setLine1}
          hint={t('overlay.lowerThird.line1Hint')}
          autoComplete="off"
        />
        <TextField
          id="overlay-lower-third-line2"
          label={t('overlay.lowerThird.line2')}
          value={line2}
          onValueChange={setLine2}
          hint={t('overlay.lowerThird.line2Hint')}
          autoComplete="off"
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text">
            {t('overlay.lowerThird.template')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {LOWER_THIRD_TEMPLATES.map((option) => (
              <label
                key={option}
                className={clsx(
                  'flex min-h-touch cursor-pointer items-center gap-2 rounded-glass border px-4',
                  'text-sm text-text',
                  option === template ? 'border-accent bg-surface-2' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  name="overlay-lower-third-template"
                  value={option}
                  checked={option === template}
                  onChange={() => {
                    setTemplate(option)
                  }}
                  className="h-4 w-4 accent-accent"
                />
                {t(`overlay.lowerThird.templateOption.${option}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <LayerActions
          showLabel={t('overlay.lowerThird.show')}
          hideLabel={t('overlay.lowerThird.hide')}
          disabled={sending}
          onShow={() => {
            dispatch({
              channel: 'command',
              name: 'lowerThird.show',
              payload: { line1, line2, template },
            })
          }}
          onHide={() => {
            dispatch({ channel: 'command', name: 'lowerThird.hide', payload: {} })
          }}
        />
      </LayerSection>

      {/* ------------------------------------------------------------------ scripture */}
      <LayerSection icon={BookOpen} title={t('overlay.scripture.title')}>
        <TextField
          id="overlay-scripture-reference"
          label={t('overlay.scripture.reference')}
          value={reference}
          onValueChange={setReference}
          hint={t('overlay.scripture.referenceHint')}
          autoComplete="off"
        />

        <TextArea
          id="overlay-scripture-text"
          label={t('overlay.scripture.text')}
          value={verseText}
          onValueChange={setVerseText}
          hint={t('overlay.scripture.textHint')}
        />

        <TextField
          id="overlay-scripture-translation"
          label={t('overlay.scripture.translation')}
          value={translation}
          onValueChange={setTranslation}
          hint={t('overlay.scripture.translationHint')}
          autoComplete="off"
        />
        <TextField
          id="overlay-scripture-attribution"
          label={t('overlay.scripture.attribution')}
          value={attribution}
          onValueChange={setAttribution}
          hint={t('overlay.scripture.attributionHint')}
          autoComplete="off"
        />

        <LayerActions
          showLabel={t('overlay.scripture.show')}
          hideLabel={t('overlay.scripture.hide')}
          disabled={sending || reference.trim().length === 0}
          onShow={() => {
            dispatch({
              channel: 'command',
              name: 'scripture.show',
              payload: {
                reference,
                text: verseText,
                translation,
                // An empty field means "no attribution supplied", which the protocol spells
                // `null`; `''` would render an empty credit line over the congregation's screen.
                attribution: attribution.trim().length === 0 ? null : attribution,
              },
            })
          }}
          onHide={() => {
            dispatch({ channel: 'command', name: 'scripture.hide', payload: {} })
          }}
        />
      </LayerSection>

      {/* ---------------------------------------------------------------------- slide */}
      <LayerSection icon={ImageIcon} title={t('overlay.slide.title')}>
        <TextField
          id="overlay-slide-src"
          label={t('overlay.slide.src')}
          value={slideSrc}
          onValueChange={setSlideSrc}
          hint={t('overlay.slide.srcHint')}
          autoComplete="off"
        />

        <LayerActions
          showLabel={t('overlay.slide.show')}
          hideLabel={t('overlay.slide.hide')}
          disabled={sending || slideSrc.trim().length === 0}
          onShow={() => {
            dispatch({ channel: 'command', name: 'slide.show', payload: { src: slideSrc } })
          }}
          onHide={() => {
            dispatch({ channel: 'command', name: 'slide.hide', payload: {} })
          }}
        />
      </LayerSection>

      {lastError !== null ? (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      ) : null}

      {/* ------------------------------------------------------------------ clear all */}
      <section
        aria-label={t('overlay.clear.title')}
        // `mt-10` and a dedicated panic-toned border are the physical separation FITTS-3 asks
        // for. This is the only destructive control on the panel and it must not sit within
        // slipping distance of a SHOW button.
        className="mt-10 flex flex-col items-start gap-3 rounded-glass-lg border-2 border-dashed border-panic/50 bg-surface p-5"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-panic">
          {t('overlay.clear.title')}
        </h2>
        <p className="max-w-2xl text-sm text-text-muted">{t('overlay.clear.description')}</p>
        <HoldButton
          id="overlay-clear-all"
          label={t('overlay.clear.label')}
          icon={Trash2}
          durationMs={CLEAR_ALL_HOLD_MS}
          disabled={sending}
          onHoldComplete={() => {
            dispatch({ channel: 'command', name: 'clearAll', payload: {} })
          }}
        />
      </section>
    </div>
  )
}

/** The server status block, including the exact URL to paste into an OBS Browser Source. */
function ServerBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const serverInfo = useOverlayStore((store) => store.serverInfo)
  const [copied, setCopied] = useState(false)
  const urlId = useId()

  const copyUrl = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) return
    void clipboard
      .writeText(serverInfo.pageUrl)
      .then(() => {
        setCopied(true)
      })
      .catch(() => {
        setCopied(false)
      })
  }

  return (
    <section
      aria-label={t('overlay.server.title')}
      data-overlay-server={serverInfo.running ? 'running' : 'stopped'}
      className="rounded-glass-lg border border-border bg-surface p-5"
    >
      <div className="flex items-center gap-2">
        <Server
          aria-hidden="true"
          className={clsx('h-4 w-4 shrink-0', serverInfo.running ? 'text-live' : 'text-panic')}
        />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('overlay.server.title')}
        </h2>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Detail
          term={t('overlay.server.stateLabel')}
          value={serverInfo.running ? t('overlay.server.running') : t('overlay.server.stopped')}
        />
        <Detail
          term={t('overlay.server.address')}
          value={`${serverInfo.host}:${String(serverInfo.port)}`}
        />
        <Detail
          term={t('overlay.server.clients')}
          value={t('overlay.server.clientsValue', { total: serverInfo.clients })}
        />
      </dl>

      <div className="mt-4 rounded-glass border border-accent/50 bg-surface-2 p-4">
        <p id={urlId} className="text-sm font-semibold text-text">
          {t('overlay.server.obsUrlLabel')}
        </p>
        <p className="mt-1 text-xs text-text-muted">{t('overlay.server.obsUrlHint')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <code
            data-testid="overlay-page-url"
            className="select-text break-all rounded-glass border border-border bg-background px-3 py-2 font-mono text-sm text-accent-2"
          >
            {serverInfo.pageUrl}
          </code>
          {/* No `aria-label`: the visible text is the accessible name, so the two can never
              disagree. `aria-describedby` supplies the context ("Paste this into an OBS Browser
              Source") without overriding the name. */}
          <Button icon={Copy} aria-describedby={urlId} onClick={copyUrl}>
            {copied ? t('overlay.server.copied') : t('overlay.server.copy')}
          </Button>
        </div>
      </div>

      {serverInfo.lastError !== null ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">{serverInfo.lastError}</span>
        </p>
      ) : null}
    </section>
  )
}

/** What is actually on screen right now, per layer, straight from the server's snapshot. */
function StateReadout(): React.JSX.Element {
  const { t } = useTranslation()
  const state = useOverlayStore((store) => store.state)

  const rows: readonly { id: string; label: string; visible: boolean; summary: string }[] = [
    {
      id: 'lowerThird',
      label: t('overlay.readout.lowerThird'),
      visible: state.lowerThird.visible,
      summary: [state.lowerThird.line1, state.lowerThird.line2].filter((v) => v.length > 0).join(' · '),
    },
    {
      id: 'scripture',
      label: t('overlay.readout.scripture'),
      visible: state.scripture.visible,
      summary: state.scripture.reference,
    },
    {
      id: 'slide',
      label: t('overlay.readout.slide'),
      visible: state.slide.visible,
      summary: state.slide.src,
    },
  ]

  return (
    <section
      aria-label={t('overlay.readout.title')}
      className="rounded-glass-lg border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('overlay.readout.title')}
        </h2>
        <p className="font-mono text-xs text-text-muted" data-testid="overlay-revision">
          {t('overlay.readout.revision', { revision: state.revision })}
        </p>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.id}
            data-layer={row.id}
            data-layer-visible={row.visible ? 'true' : 'false'}
            className="flex min-h-touch flex-wrap items-center justify-between gap-3 rounded-glass border border-border bg-surface-2 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-sm text-text">
              {row.visible ? (
                <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-live" />
              ) : (
                <EyeOff aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              )}
              {row.label}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-3">
              {row.summary.length > 0 ? (
                <span className="truncate text-xs text-text-muted">{row.summary}</span>
              ) : null}
              {/* Text, not colour alone — the operator reads this from across a dark room. */}
              <span
                className={clsx(
                  'rounded-glass border px-2 py-0.5 text-xs font-medium',
                  row.visible ? 'border-live/60 text-live' : 'border-border text-text-muted',
                )}
              >
                {row.visible ? t('overlay.readout.visible') : t('overlay.readout.hidden')}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LayerSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 rounded-glass-lg border border-border bg-surface p-5"
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      </div>
      {children}
    </section>
  )
}

/**
 * One layer's SHOW / HIDE pair.
 *
 * The accessible names are per-layer ("Show lower third", not "Show"), because a screen reader
 * user tabbing through six identically-named buttons has no way to tell which layer they are about
 * to put on the congregation's screen.
 */
function LayerActions({
  showLabel,
  hideLabel,
  disabled,
  onShow,
  onHide,
}: {
  showLabel: string
  hideLabel: string
  disabled: boolean
  onShow: () => void
  onHide: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="primary" size="lg" icon={Eye} aria-label={showLabel} disabled={disabled} onClick={onShow}>
        {t('actions.show')}
      </Button>
      <Button variant="secondary" size="lg" icon={EyeOff} aria-label={hideLabel} onClick={onHide}>
        {t('actions.hide')}
      </Button>
    </div>
  )
}

/** A multi-line field. `TextField` is single-line only, and verse text is not. */
function TextArea({
  id,
  label,
  value,
  onValueChange,
  hint,
}: {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
  hint: string
}): React.JSX.Element {
  const hintId = `${id}-hint`

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={4}
        aria-describedby={hintId}
        spellCheck={false}
        onChange={(event) => {
          onValueChange(event.target.value)
        }}
        className={clsx(
          'w-full select-text rounded-glass border border-border bg-surface-2 px-3 py-2',
          'text-base text-text placeholder:text-text-muted/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      />
      <p id={hintId} className="text-xs text-text-muted">
        {hint}
      </p>
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

export default OverlayPanel
