/**
 * The GO LIVE panel — the biggest, most consequential button in the app.
 *
 * BLUEPRINT.md §5: one button takes you live end-to-end, one held button ends cleanly, and the
 * local recording always runs. Everything below is shaped by the three rules Phase 5 exists to
 * enforce.
 *
 * ## 1. The recording is not a detail
 *
 * Standing Rule 3 says OBS's local recording starts whenever the stream does, with no flag to
 * disable it — so there is no toggle on this screen, and the RECORDING indicator is a peer of the
 * LIVE one rather than a footnote beside it. The state that must never happen (streaming with no
 * recording) is called out in its own panic-coloured panel, because "the backup silently didn't
 * start" is exactly the failure that only becomes visible when it is far too late to fix.
 *
 * ## 2. `partial` is rendered honestly, and prominently
 *
 * OBS streaming and recording while YouTube never transitioned is the likeliest real failure, and
 * it is neither "live" nor "failed". Collapsing it either way lies to the operator in opposite
 * directions: "live" tells them the congregation at home can see the service when they cannot;
 * "failed" tells them to start over when doing so would push a second stream. So it gets the
 * loudest panel on the screen, says both true things in one sentence each, and offers a retry that
 * only finishes the missing steps.
 *
 * ## 3. Nothing here can wedge the broadcast
 *
 * There is no control on this panel that stops a stream or a recording as a *reaction* to an
 * error — only END does that, and only after a deliberate hold. Every failure path ends in words
 * plus a retry, never in an automatic stop. `reattached` gets its own notice, including the fact
 * that the elapsed clock comes from OBS rather than from when the button was pressed, because an
 * operator who mis-reads that number will mis-time the whole service.
 *
 * ## Colour is never the only signal
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §9.5, and a dark booth. Every indicator carries a word and
 * an icon as well as a tint, and a `role="status"` line states the same thing in a sentence so a
 * screen-reader user learns of a change made outside this screen.
 */

import clsx from 'clsx'
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleStop,
  Disc,
  FileVideo,
  MinusCircle,
  Radio,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { GoLiveState, GoLiveStepStatus, ObsOutputState, StepState } from '@shared/golive'
import { endRequiresHold } from '@shared/golive'

import { HoldButton } from '../components/HoldButton'
import {
  droppedFrameRatio,
  elapsedMs,
  formatElapsed,
  isRecordingMissing,
  recordingElapsedMs,
  runningStep,
  useGoLiveStore,
} from '../store/goLiveStore'
import { useObsStore } from '../store/obsStore'
import { useYouTubeStore } from '../store/youtubeStore'

/**
 * A one-second clock, running only while something is actually running.
 *
 * Not `Date.now()` read during render: React may not re-render for minutes on an idle console, and
 * an elapsed-time readout that freezes mid-service is worse than none at all.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(id)
    }
  }, [active])

  return now
}

/** What the stream indicator is saying. `not-public` is the `partial` phase, spelled out. */
type StreamIndicator = 'live' | 'not-public' | 'off'
/** What the recording indicator is saying. Derived from OBS, never from the phase. */
type RecordIndicator = 'recording' | 'paused' | 'off'

function streamIndicatorFor(state: GoLiveState): StreamIndicator {
  if (!state.obs.streaming) return 'off'
  return state.phase === 'partial' ? 'not-public' : 'live'
}

function recordIndicatorFor(obs: ObsOutputState): RecordIndicator {
  if (!obs.recording) return 'off'
  return obs.recordingPaused ? 'paused' : 'recording'
}

const STREAM_TONE: Record<StreamIndicator, string> = {
  live: 'text-live',
  'not-public': 'text-accent-2',
  off: 'text-text-muted',
}

const RECORD_TONE: Record<RecordIndicator, string> = {
  recording: 'text-live',
  paused: 'text-accent-2',
  off: 'text-text-muted',
}

const STEP_ICON: Record<StepState, LucideIcon> = {
  pending: CircleDashed,
  running: CircleDot,
  done: CircleCheck,
  failed: CircleAlert,
  skipped: MinusCircle,
}

const STEP_TONE: Record<StepState, string> = {
  pending: 'text-text-muted',
  running: 'text-accent-2',
  done: 'text-live',
  failed: 'text-panic',
  skipped: 'text-text-muted',
}

export function GoLivePanel(): React.JSX.Element {
  const { t } = useTranslation()

  const state = useGoLiveStore((store) => store.state)
  const bridgeAvailable = useGoLiveStore((store) => store.bridgeAvailable)
  const starting = useGoLiveStore((store) => store.starting)
  const ending = useGoLiveStore((store) => store.ending)
  const lastError = useGoLiveStore((store) => store.lastError)
  const hydrate = useGoLiveStore((store) => store.hydrate)
  const subscribe = useGoLiveStore((store) => store.subscribe)
  const start = useGoLiveStore((store) => store.start)
  const end = useGoLiveStore((store) => store.end)

  const obsState = useObsStore((store) => store.status.state)
  const hydrateObs = useObsStore((store) => store.hydrate)
  const subscribeObs = useObsStore((store) => store.subscribe)

  const youtubeAuth = useYouTubeStore((store) => store.status.auth.state)
  const youtubeHydrated = useYouTubeStore((store) => store.hydrated)
  const hydrateYouTube = useYouTubeStore((store) => store.hydrate)
  const subscribeYouTube = useYouTubeStore((store) => store.subscribe)

  useEffect(() => {
    // Subscribe BEFORE hydrating, so a state pushed while the initial read is in flight — very
    // much including a re-attach — is not dropped on the floor.
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  useEffect(() => {
    // The panel owns its own view of the OBS connection rather than trusting a sibling screen to
    // have hydrated it: sections unmount when the operator switches tabs.
    const unsubscribe = subscribeObs()
    void hydrateObs()
    return unsubscribe
  }, [hydrateObs, subscribeObs])

  useEffect(() => {
    const unsubscribe = subscribeYouTube()
    void hydrateYouTube()
    return unsubscribe
  }, [hydrateYouTube, subscribeYouTube])

  const { phase, obs, reattached } = state
  const now = useTickingNow(obs.streaming || obs.recording)
  const streamMs = elapsedMs(state, now)
  const recordMs = recordingElapsedMs(obs)
  const stream = streamIndicatorFor(state)
  const record = recordIndicatorFor(obs)
  const inFlight = starting || phase === 'starting'

  const obsConnected = obsState === 'connected'

  /** Why GO LIVE is switched off, or `null` when it is usable. Always stated, never implied. */
  const disabledReason: string | null = !bridgeAvailable
    ? t('goLive.disabled.bridge')
    : !obsConnected
      ? t('goLive.disabled.obs')
      : inFlight
        ? t('goLive.disabled.starting')
        : phase === 'live'
          ? t('goLive.disabled.live')
          : phase === 'partial'
            ? t('goLive.disabled.partial')
            : phase === 'ending' || ending
              ? t('goLive.disabled.ending')
              : null

  const reasonId = useId()
  const goLiveDisabled = disabledReason !== null

  // `endRequiresHold` is the contract's own answer to "is there anything to end?", and END is a
  // HoldButton unconditionally — it is never downgraded to a tap, whatever the phase.
  const canEnd = bridgeAvailable && !ending && endRequiresHold(state)

  const handleStart = (): void => {
    void start()
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('goLive.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('goLive.subtitle')}</p>
      </header>

      {bridgeAvailable ? null : (
        <Panel tone="panic" title={t('goLive.bridgeUnavailable.title')}>
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.bridgeUnavailable.body')}</p>
        </Panel>
      )}

      <StatusBanner
        stream={stream}
        record={record}
        streamMs={streamMs}
        recordMs={recordMs}
        reattached={reattached}
      />

      {reattached ? (
        <Panel tone="warning" title={t('goLive.reattached.title')}>
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.reattached.body')}</p>
          <p className="max-w-3xl text-sm text-text-muted">
            {t('goLive.reattached.elapsedNote')}
          </p>
        </Panel>
      ) : null}

      {isRecordingMissing(obs) ? (
        <Panel tone="panic" title={t('goLive.recordingMissing.title')} alert>
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.recordingMissing.body')}</p>
        </Panel>
      ) : null}

      {phase === 'partial' ? (
        <Panel tone="panic" title={t('goLive.partial.title')} alert>
          <p className="max-w-3xl text-sm text-text">{t('goLive.partial.body')}</p>
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.partial.stillRunning')}</p>
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.partial.notHappening')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!bridgeAvailable || inFlight}
              onClick={handleStart}
              className={clsx(
                'inline-flex min-h-touch-lg items-center justify-center gap-2 rounded-glass px-6',
                'border border-accent-hover bg-accent text-base font-semibold text-text',
                'hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2',
                'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted',
              )}
            >
              <RotateCcw aria-hidden="true" className="h-5 w-5 shrink-0" />
              <span>{t('goLive.partial.retry')}</span>
            </button>
          </div>
          <p className="max-w-3xl text-xs text-text-muted">{t('goLive.partial.retryHint')}</p>
          <p className="max-w-3xl text-xs text-text-muted">{t('goLive.partial.manual')}</p>
        </Panel>
      ) : null}

      {phase === 'failed' ? (
        <Panel tone="panic" title={t('goLive.failed.title')} alert>
          <p className="max-w-3xl text-sm text-text">{t('goLive.failed.body')}</p>
        </Panel>
      ) : null}

      {youtubeHydrated && youtubeAuth === 'not-configured' ? <YouTubeNotConfigured /> : null}

      <section
        aria-labelledby={`${reasonId}-heading`}
        className="rounded-glass-lg border border-border bg-surface p-5"
      >
        <h2 id={`${reasonId}-heading`} className="font-semibold text-text">
          {t('goLive.button.goLive')}
        </h2>

        <div className="mt-3 flex flex-col gap-3">
          {/* The biggest control in the app. 72px+ of target, full width, its own words — a
              mis-hit here costs a service, and FITTS-1 puts the floor for the highest-stakes
              control at 64px. */}
          <button
            type="button"
            data-testid="go-live-button"
            disabled={goLiveDisabled}
            aria-describedby={goLiveDisabled ? reasonId : undefined}
            onClick={handleStart}
            className={clsx(
              'flex min-h-touch-xl w-full items-center justify-center gap-3 rounded-glass px-6 py-4',
              'border-2 border-accent-hover bg-accent text-2xl font-bold uppercase tracking-wide text-text',
              'transition-colors duration-150 ease-out hover:bg-accent-hover',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted disabled:opacity-70',
            )}
          >
            <Radio aria-hidden="true" className="h-8 w-8 shrink-0" />
            <span>{inFlight ? t('goLive.button.starting') : t('goLive.button.goLive')}</span>
          </button>

          {disabledReason === null ? (
            <p className="max-w-3xl text-sm text-text-muted">{t('goLive.button.hint')}</p>
          ) : (
            // The reason is the button's accessible description, so it is announced with the
            // control rather than sitting nearby as decoration.
            <p
              id={reasonId}
              data-testid="go-live-disabled-reason"
              className="flex max-w-3xl items-start gap-1.5 text-sm text-text-muted"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-2" />
              <span>{disabledReason}</span>
            </p>
          )}
        </div>
      </section>

      {/* Shown from the moment a sequence begins and kept afterwards: when a step fails, the
          operator needs to read WHICH one, not watch a spinner disappear. */}
      {phase === 'idle' ? null : <StepList state={state} />}

      <RecordingFile obs={obs} />

      <HealthReadout obs={obs} />

      <section
        aria-labelledby={`${reasonId}-end`}
        // Deliberately its own bordered block, well down the page from GO LIVE (FITTS-3).
        className="mt-2 rounded-glass-lg border border-panic/50 bg-surface p-5"
      >
        <h2 id={`${reasonId}-end`} className="font-semibold text-panic">
          {t('goLive.end.title')}
        </h2>
        <div className="mt-3 flex flex-col gap-3">
          <p className="max-w-3xl text-sm text-text-muted">{t('goLive.end.description')}</p>
          <HoldButton
            label={t('goLive.end.label')}
            icon={CircleStop}
            disabled={!canEnd}
            onHoldComplete={() => {
              void end()
            }}
            className="w-full"
          />
          {canEnd ? null : (
            <p className="max-w-3xl text-sm text-text-muted">{t('goLive.end.nothingToEnd')}</p>
          )}
        </div>
      </section>

      <Panel tone="neutral" title={t('goLive.quota.title')}>
        <p className="max-w-3xl text-sm text-text-muted">{t('goLive.quota.body')}</p>
      </Panel>

      {lastError === null ? null : (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t('goLive.lastError')}: {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------------------------- */

type PanelTone = 'neutral' | 'panic' | 'warning'

const PANEL_BORDER: Record<PanelTone, string> = {
  neutral: 'border-border',
  panic: 'border-panic/60',
  warning: 'border-accent-2/60',
}

const PANEL_HEADING: Record<PanelTone, string> = {
  neutral: 'text-text',
  panic: 'text-panic',
  warning: 'text-accent-2',
}

/** A titled region. `aria-labelledby` so the heading read and the name announced cannot drift. */
function Panel({
  tone,
  title,
  alert = false,
  children,
}: {
  tone: PanelTone
  title: string
  /** Announce the panel the moment it appears. Reserved for states that interrupt a service. */
  alert?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      {...(alert ? { role: 'alert' as const } : {})}
      className={clsx('rounded-glass-lg border bg-surface p-5', PANEL_BORDER[tone])}
    >
      <h2 id={headingId} className={clsx('font-semibold', PANEL_HEADING[tone])}>
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

/**
 * The two big lights.
 *
 * Two separate tiles, not one combined "status": streaming and recording are independent facts and
 * the operator has to be able to read either without inferring it from the other.
 */
function StatusBanner({
  stream,
  record,
  streamMs,
  recordMs,
  reattached,
}: {
  stream: StreamIndicator
  record: RecordIndicator
  streamMs: number | null
  recordMs: number | null
  reattached: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const headingId = useId()

  const streamText =
    stream === 'live'
      ? t('goLive.indicator.live')
      : stream === 'not-public'
        ? t('goLive.indicator.streamingNotPublic')
        : t('goLive.indicator.notLive')

  const recordText =
    record === 'recording'
      ? t('goLive.indicator.recording')
      : record === 'paused'
        ? t('goLive.indicator.recordingPaused')
        : t('goLive.indicator.notRecording')

  return (
    <section
      aria-labelledby={headingId}
      data-testid="go-live-status"
      className="rounded-glass-lg border border-border bg-surface p-5"
    >
      <h2 id={headingId} className="font-semibold text-text">
        {t('goLive.indicator.regionLabel')}
      </h2>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div
          data-testid="live-indicator"
          data-stream-state={stream}
          className={clsx(
            'flex flex-col gap-2 rounded-glass border-2 bg-surface-2 p-4',
            stream === 'off' ? 'border-border' : 'border-current',
            STREAM_TONE[stream],
          )}
        >
          <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-muted">
            <Radio aria-hidden="true" className={clsx('h-4 w-4 shrink-0', STREAM_TONE[stream])} />
            {t('goLive.indicator.streamLabel')}
          </span>
          <span className={clsx('text-3xl font-bold uppercase leading-none', STREAM_TONE[stream])}>
            {streamText}
          </span>
          <span className="text-sm text-text-muted">
            {t('goLive.indicator.elapsedLabel')}:{' '}
            <span data-testid="live-elapsed" className="font-mono text-base text-text">
              {streamMs === null ? t('goLive.indicator.elapsedUnknown') : formatElapsed(streamMs)}
            </span>
          </span>
          {reattached ? (
            <span className="text-xs text-accent-2">{t('goLive.reattached.elapsedNote')}</span>
          ) : null}
        </div>

        <div
          data-testid="recording-indicator"
          data-record-state={record}
          className={clsx(
            'flex flex-col gap-2 rounded-glass border-2 bg-surface-2 p-4',
            record === 'off' ? 'border-border' : 'border-current',
            RECORD_TONE[record],
          )}
        >
          <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-muted">
            <Disc aria-hidden="true" className={clsx('h-4 w-4 shrink-0', RECORD_TONE[record])} />
            {t('goLive.indicator.recordLabel')}
          </span>
          <span className={clsx('text-3xl font-bold uppercase leading-none', RECORD_TONE[record])}>
            {recordText}
          </span>
          <span className="text-sm text-text-muted">
            {t('goLive.indicator.elapsedLabel')}:{' '}
            <span data-testid="record-elapsed" className="font-mono text-base text-text">
              {recordMs === null ? t('goLive.indicator.elapsedUnknown') : formatElapsed(recordMs)}
            </span>
          </span>
        </div>
      </div>

      {/* The same two facts as a sentence, so a state change made outside this screen — or inside
          OBS — is announced rather than only painted. */}
      <p role="status" className="sr-only">
        {t('goLive.indicator.announcement', { stream: streamText, recording: recordText })}
      </p>
    </section>
  )
}

/** The per-step readout. Never a spinner: a failure has to name the step that failed. */
function StepList({ state }: { state: GoLiveState }): React.JSX.Element {
  const { t } = useTranslation()
  const headingId = useId()
  const active = runningStep(state)

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-glass-lg border border-border bg-surface p-5"
    >
      <h2 id={headingId} className="font-semibold text-text">
        {t('goLive.steps.title')}
      </h2>

      <ol
        aria-label={t('goLive.steps.listLabel')}
        className="mt-3 flex flex-col gap-2 text-sm"
      >
        {state.steps.map((step) => (
          <StepRow key={step.step} step={step} />
        ))}
      </ol>

      <p role="status" className="mt-3 text-sm text-text-muted">
        {active === null
          ? ''
          : t('goLive.steps.announcement', { step: t(`goLive.steps.name.${active}`) })}
      </p>
      <p className="mt-1 max-w-3xl text-xs text-text-muted">{t('goLive.steps.recordNote')}</p>
    </section>
  )
}

function StepRow({ step }: { step: GoLiveStepStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = STEP_ICON[step.state]

  return (
    <li
      data-step={step.step}
      data-step-state={step.state}
      className={clsx(
        'flex items-start gap-3 rounded-glass border bg-surface-2 p-3',
        step.state === 'failed' ? 'border-panic/60' : 'border-border',
      )}
    >
      <Icon aria-hidden="true" className={clsx('mt-0.5 h-4 w-4 shrink-0', STEP_TONE[step.state])} />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-text">{t(`goLive.steps.name.${step.step}`)}</span>
        {step.message === null ? null : (
          <span className="select-text text-xs text-text-muted">{step.message}</span>
        )}
      </span>
      {/* The state is a word, not a colour. */}
      <span className={clsx('text-xs font-semibold uppercase tracking-wide', STEP_TONE[step.state])}>
        {t(`goLive.steps.state.${step.state}`)}
      </span>
    </li>
  )
}

/** Where the backup is. The first thing an operator goes looking for once the room has emptied. */
function RecordingFile({ obs }: { obs: ObsOutputState }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Panel tone="neutral" title={t('goLive.recordingFile.title')}>
      {obs.recordingPath === null ? (
        <p className="max-w-3xl text-sm text-text-muted">{t('goLive.recordingFile.none')}</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="flex items-center gap-1.5 text-text-muted">
            <FileVideo aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {t('goLive.recordingFile.pathLabel')}
          </dt>
          <dd
            data-testid="recording-path"
            className="select-text break-all font-mono text-text"
          >
            {obs.recordingPath}
          </dd>
        </dl>
      )}
      <p className="max-w-3xl text-xs text-text-muted">{t('goLive.recordingFile.note')}</p>
    </Panel>
  )
}

/** Dropped frames and OBS's own reconnect flag. */
function HealthReadout({ obs }: { obs: ObsOutputState }): React.JSX.Element {
  const { t } = useTranslation()
  const ratio = droppedFrameRatio(obs)

  const dropped =
    ratio === null || obs.skippedFrames === null || obs.totalFrames === null
      ? t('goLive.health.droppedUnknown')
      : t('goLive.health.dropped', {
          skipped: obs.skippedFrames,
          total: obs.totalFrames,
          percent: (ratio * 100).toFixed(1),
        })

  return (
    <Panel tone={obs.streamReconnecting ? 'warning' : 'neutral'} title={t('goLive.health.title')}>
      {obs.streamReconnecting ? (
        <div className="flex items-start gap-2 rounded-glass border border-accent-2/60 bg-surface-2 p-3">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-accent-2" />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-accent-2">
              {t('goLive.health.reconnectingTitle')}
            </span>
            <span className="max-w-3xl text-sm text-text-muted">
              {t('goLive.health.reconnectingBody')}
            </span>
          </span>
        </div>
      ) : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="flex items-center gap-1.5 text-text-muted">
          <Activity aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {t('goLive.health.droppedLabel')}
        </dt>
        <dd data-testid="dropped-frames" className="select-text text-text">
          {dropped}
        </dd>
      </dl>

      <p className="max-w-3xl text-xs text-text-muted">{t('goLive.health.bitrateNote')}</p>
    </Panel>
  )
}

/**
 * The state this machine is genuinely in.
 *
 * Written as two explicit lists rather than one hedged paragraph, because "GO LIVE still works but
 * publishes nothing" is precisely the sentence an operator will skim past on a Sunday morning and
 * then be surprised by. What happens and what does not happen are separated so neither can be read
 * as the other.
 */
function YouTubeNotConfigured(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Panel tone="warning" title={t('goLive.youtubeNotConfigured.title')}>
      <p className="max-w-3xl text-sm text-text">{t('goLive.youtubeNotConfigured.body')}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-glass border border-border bg-surface-2 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-live">
            <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {t('goLive.youtubeNotConfigured.willLabel')}
          </p>
          <ul className="ms-4 flex list-disc flex-col gap-1 text-sm text-text-muted">
            <li>{t('goLive.youtubeNotConfigured.will1')}</li>
            <li>{t('goLive.youtubeNotConfigured.will2')}</li>
          </ul>
        </div>

        <div className="flex flex-col gap-2 rounded-glass border border-border bg-surface-2 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-panic">
            <MinusCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {t('goLive.youtubeNotConfigured.willNotLabel')}
          </p>
          <ul className="ms-4 flex list-disc flex-col gap-1 text-sm text-text-muted">
            <li>{t('goLive.youtubeNotConfigured.willNot1')}</li>
            <li>{t('goLive.youtubeNotConfigured.willNot2')}</li>
          </ul>
        </div>
      </div>

      <p className="max-w-3xl text-sm text-text-muted">{t('goLive.youtubeNotConfigured.where')}</p>
    </Panel>
  )
}

export default GoLivePanel
