/**
 * The bottom bar — the only chrome left on the operating surface.
 *
 * **The bar itself is the progress indicator.** A fill sweeps across its full width behind the
 * content, and its width is the cue engine's match confidence for the next cue. That is the number
 * the operator asked for: "how sure is Verger that the next slide is the right one." Everything else
 * on the bar is what genuinely cannot wait for a drawer to open.
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │███████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░  ← fill = confidence     │
 * │ ● LIVE 42:17 · REC · OBS ok      87%  Slide 42 → 43     1 2 3 4  L   END     │
 * └──────────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## The percentage is honest about not knowing
 *
 * `confidence` comes from `CueEngineState.pending`, and there is only a pending suggestion when a
 * detector has actually matched something in the transcript. With no ASR configured, no plan
 * anchors, or simply nothing said yet, there is no number — so the bar shows `—` and an empty fill
 * rather than `0%`. "Nothing to report" and "reported almost no confidence" are different facts, and
 * a bar that renders them identically is the kind of readout an operator learns to ignore.
 *
 * ## Why `NO REC` is on the bar
 *
 * Standing Rule 3: local recording starts whenever streaming starts, never optionally. If OBS is
 * streaming and *not* recording, that is the one failure the operator has to see instantly, because
 * the service is going out unrecorded and no amount of fixing it afterwards gets the audio back.
 * `isRecordingMissing` already names that state; the bar gives it a red pill.
 *
 * ## What is deliberately NOT here
 *
 * No blackout, no freeze, no logo. Their `ActionId`s exist and nothing implements them (see
 * `useServiceActions`), and a button that looks live and does nothing is worse than no button.
 * No trust dial either — changing how much autonomy the engine has mid-service is a drawer decision,
 * not a one-tap one.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import clsx from 'clsx'
import { Settings, Type } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CameraSlot } from '@shared/camera'
import type { GoLivePhase } from '@shared/golive'
import { endRequiresHold } from '@shared/golive'
import type { ObsConnectionState } from '@shared/obs'

import type { CameraButtonModel } from '../store/cameraStore'
import { cameraButtons, useCameraStore } from '../store/cameraStore'
import { useCueStore } from '../store/cueStore'
import { elapsedMs, formatElapsed, isRecordingMissing, useGoLiveStore } from '../store/goLiveStore'
import { useObsStore } from '../store/obsStore'
import { useOverlayStore } from '../store/overlayStore'
import { currentCue, upcomingCue, usePlanStore } from '../store/planStore'
import { HoldButton } from './HoldButton'

/** The bar's own height. 80px, per the brief — tall enough to hit in the dark, short enough to ignore. */
export const BOTTOM_BAR_HEIGHT_CLASS = 'h-20'

/** How the tally light reads. Three states, three colours, and a word beside each. */
export type TallyTone = 'live' | 'transitioning' | 'offline'

/**
 * A 1-second clock.
 *
 * Deliberately not `useHealthClock` (15s): that one is right for ages rounded to the minute and
 * wrong here, because this readout shows *seconds*. An elapsed clock that visibly freezes for
 * fifteen seconds at a time reads as a hung app at exactly the moment the operator is checking
 * whether the service is still going out. Pass `provided` to pin it — every test does.
 */
export function useServiceClock(provided?: number): number {
  const [now, setNow] = useState<number>(() => provided ?? Date.now())

  useEffect(() => {
    if (provided !== undefined) return undefined
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(id)
    }
  }, [provided])

  return provided ?? now
}

/**
 * Confidence as whole percent, clamped.
 *
 * Mirrors `SuggestionPanel.confidencePercent`. Duplicated rather than imported because a shared
 * `components/` module may not depend on a `screens/` one, and one `Math.round` is a cheaper price
 * than that inversion.
 */
export function confidenceToPercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  return Math.min(100, Math.max(0, Math.round(confidence * 100)))
}

/** Which tally state the outputs are in. Streaming wins; then anything mid-transition. */
export function tallyTone(
  phase: GoLivePhase,
  streaming: boolean,
  reconnecting: boolean,
  obs: ObsConnectionState,
): TallyTone {
  if (streaming || phase === 'live' || phase === 'partial') return 'live'
  if (
    reconnecting ||
    phase === 'starting' ||
    phase === 'ending' ||
    obs === 'connecting' ||
    obs === 'reconnecting'
  ) {
    return 'transitioning'
  }
  return 'offline'
}

/** Everything the bar draws. Projected from the stores so the view has no selectors in it. */
export interface BottomBarModel {
  /** Whole percent, or `null` when the engine has nothing pending to be confident about. */
  readonly percent: number | null
  readonly tally: TallyTone
  readonly phase: GoLivePhase
  readonly obsState: ObsConnectionState
  readonly recording: boolean
  /** Streaming without recording — Standing Rule 3's loud failure. */
  readonly recordingMissing: boolean
  /** `h:mm:ss`, or `null` when nothing is live. */
  readonly elapsed: string | null
  readonly nowLabel: string | null
  readonly nextLabel: string | null
  readonly cameras: readonly CameraButtonModel[]
  readonly lowerThirdVisible: boolean
  /** False when no lower-third text has been authored yet, so the toggle has nothing to show. */
  readonly lowerThirdReady: boolean
  readonly canGoLive: boolean
  readonly isLive: boolean
  readonly endNeedsHold: boolean
  readonly busy: boolean
}

/** What the bar can do. One method per control; each is one store action. */
export interface BottomBarActions {
  readonly selectCamera: (slot: CameraSlot) => void
  readonly toggleLowerThird: () => void
  readonly goLive: () => void
  readonly end: () => void
  readonly openSettings: () => void
}

/** Project the stores into a {@link BottomBarModel}. Pure selector reads — no effects, no IPC. */
export function useBottomBarModel(now?: number): BottomBarModel {
  const clock = useServiceClock(now)

  const pending = useCueStore((store) => store.state.pending)
  const obsState = useObsStore((store) => store.status.state)
  const goLive = useGoLiveStore((store) => store.state)
  const starting = useGoLiveStore((store) => store.starting)
  const ending = useGoLiveStore((store) => store.ending)
  const plan = usePlanStore((store) => store.plan)
  const position = usePlanStore((store) => store.position)
  const planBusy = usePlanStore((store) => store.busy)
  const cameraConfig = useCameraStore((store) => store.config)
  const cameraState = useCameraStore((store) => store.state)
  const lowerThird = useOverlayStore((store) => store.state.lowerThird)

  const planState = useMemo(
    () => ({ plan, position, path: null, dirty: false, lastFired: null }),
    [plan, position],
  )

  const nowCue = currentCue(planState)
  const nextCue = upcomingCue(planState)
  const ms = elapsedMs(goLive, clock)

  return {
    percent: pending === null ? null : confidenceToPercent(pending.confidence),
    tally: tallyTone(goLive.phase, goLive.obs.streaming, goLive.obs.streamReconnecting, obsState),
    phase: goLive.phase,
    obsState,
    recording: goLive.obs.recording,
    recordingMissing: isRecordingMissing(goLive.obs),
    elapsed: ms === null ? null : formatElapsed(ms),
    nowLabel: nowCue === null ? null : nowCue.label,
    nextLabel: nextCue === null ? null : nextCue.label,
    // `cameraButtons` answers "is a scene bound to this slot". The bar additionally requires a LIVE
    // OBS, because switching the program scene is an obs-websocket call and there is nothing to call
    // without one — a button that looks pressable and cannot possibly work is worse than a disabled
    // one. The Camera panel in the drawer is where the reason is spelled out in words.
    cameras: cameraButtons(cameraConfig, cameraState).map((camera) => ({
      ...camera,
      usable: camera.usable && obsState === 'connected',
    })),
    lowerThirdVisible: lowerThird.visible,
    lowerThirdReady: lowerThird.line1.trim().length > 0,
    // Deliberately coarse. The full "why can't I go live" explanation lives in the GO LIVE screen
    // in the drawer; the bar only needs to know whether pressing it could possibly work.
    canGoLive: obsState === 'connected' && (goLive.phase === 'idle' || goLive.phase === 'failed'),
    isLive: goLive.phase === 'live' || goLive.phase === 'partial' || goLive.obs.streaming,
    endNeedsHold: endRequiresHold(goLive),
    busy: planBusy || starting || ending,
  }
}

/** Bind the bar's controls to the stores. */
export function useBottomBarActions(openSettings: () => void): BottomBarActions {
  const select = useCameraStore((store) => store.select)
  const send = useOverlayStore((store) => store.send)
  const start = useGoLiveStore((store) => store.start)
  const end = useGoLiveStore((store) => store.end)
  const lowerThird = useOverlayStore((store) => store.state.lowerThird)

  const selectCamera = useCallback(
    (slot: CameraSlot) => {
      void select(slot)
    },
    [select],
  )

  const toggleLowerThird = useCallback(() => {
    if (lowerThird.visible) {
      void send({ channel: 'command', name: 'lowerThird.hide', payload: {} })
      return
    }
    // Re-show whatever the operator last authored in the Overlay panel. The protocol is
    // state-based, so the text survives being hidden — which is exactly what makes this a toggle
    // rather than a one-way dismiss.
    void send({
      channel: 'command',
      name: 'lowerThird.show',
      payload: {
        line1: lowerThird.line1,
        line2: lowerThird.line2,
        template: lowerThird.template,
      },
    })
  }, [send, lowerThird])

  const goLive = useCallback(() => {
    void start()
  }, [start])

  const endService = useCallback(() => {
    void end()
  }, [end])

  return useMemo(
    () => ({ selectCamera, toggleLowerThird, goLive, end: endService, openSettings }),
    [selectCamera, toggleLowerThird, goLive, endService, openSettings],
  )
}

const TALLY_DOT: Record<TallyTone, string> = {
  live: 'bg-tally',
  transitioning: 'bg-warn',
  offline: 'bg-text-muted',
}

const TALLY_TEXT: Record<TallyTone, string> = {
  live: 'text-tally',
  transitioning: 'text-warn',
  offline: 'text-text-muted',
}

export interface BottomBarProps {
  /** Defaults to {@link useBottomBarModel}. A test injects a fixed model. */
  readonly model?: BottomBarModel
  /** Defaults to {@link useBottomBarActions}. A test injects a recording fake. */
  readonly actions?: BottomBarActions
  /** Opens the settings drawer. Also the fallback wiring for the default actions. */
  readonly onOpenSettings?: () => void
  /** Pins the clock. Tests pass this; the app does not. */
  readonly now?: number
}

export function BottomBar({
  model,
  actions,
  onOpenSettings,
  now,
}: BottomBarProps = {}): React.JSX.Element {
  const { t } = useTranslation()

  const noop = useCallback(() => undefined, [])
  const fallbackModel = useBottomBarModel(now)
  const fallbackActions = useBottomBarActions(onOpenSettings ?? noop)
  const m = model ?? fallbackModel
  const a = actions ?? fallbackActions

  const percentLabel = m.percent === null ? '—' : `${String(m.percent)}%`

  return (
    <footer
      aria-label={t('console.bar.label')}
      data-testid="bottom-bar"
      data-tally={m.tally}
      className={clsx(
        'relative isolate flex shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-surface px-4',
        BOTTOM_BAR_HEIGHT_CLASS,
      )}
    >
      {/*
        The bar IS the progress indicator. The fill sits behind everything at -z-10 and is the only
        thing on this surface that animates; 200ms is the brief's ceiling and this is at it.
      */}
      <div
        role="progressbar"
        aria-label={t('console.bar.matchLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(m.percent === null ? {} : { 'aria-valuenow': m.percent })}
        data-testid="bottom-bar-progress"
        data-percent={m.percent === null ? '' : String(m.percent)}
        className="absolute inset-y-0 left-0 -z-10 bg-accent/25 transition-[width] duration-200"
        style={{ width: `${String(m.percent ?? 0)}%` }}
      />

      {/* ---- Left: is it going out, and for how long -------------------------------------- */}
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <span
          aria-hidden="true"
          data-testid="bottom-bar-tally"
          className={clsx('h-3.5 w-3.5 shrink-0 rounded-full', TALLY_DOT[m.tally])}
        />
        <span className={clsx('text-sm font-bold uppercase tracking-wide', TALLY_TEXT[m.tally])}>
          {t(`console.bar.tally.${m.tally}`)}
        </span>
        <span
          data-testid="bottom-bar-elapsed"
          className="font-mono text-sm tabular-nums text-text-muted"
        >
          {m.elapsed ?? '—'}
        </span>
        {m.recordingMissing ? (
          // Standing Rule 3 is being violated right now. Say so, in red, in words.
          <span
            role="alert"
            data-testid="bottom-bar-no-recording"
            className="rounded border border-panic bg-panic/15 px-1.5 py-0.5 text-[11px] font-bold uppercase text-panic"
          >
            {t('console.bar.noRecording')}
          </span>
        ) : m.recording ? (
          <span
            data-testid="bottom-bar-recording"
            className="rounded border border-border px-1.5 py-0.5 text-[11px] font-bold uppercase text-text-muted"
          >
            {t('console.bar.recording')}
          </span>
        ) : null}
        <span data-testid="bottom-bar-obs" className="truncate text-xs text-text-muted">
          {/* The OBS state word is the Connection screen's own copy — one vocabulary, not two. */}
          {t('console.bar.obs', { state: t(`status.state.${m.obsState}`) })}
        </span>
      </div>

      {/* ---- Centre: the number, and what it is about ------------------------------------- */}
      <div className="flex min-w-0 flex-1 items-baseline justify-center gap-3">
        <span className="text-[11px] uppercase tracking-widest text-text-muted">
          {t('console.bar.matchLabel')}
        </span>
        <span
          data-testid="bottom-bar-percent"
          className={clsx(
            'text-4xl font-bold leading-none tabular-nums',
            m.percent === null ? 'text-text-muted' : 'text-text',
          )}
        >
          {percentLabel}
        </span>
        <span data-testid="bottom-bar-context" className="min-w-0 truncate text-sm text-text-muted">
          {m.nowLabel === null
            ? t('console.bar.notStarted')
            : m.nextLabel === null
              ? t('console.bar.lastCue', { now: m.nowLabel })
              : t('console.bar.context', { now: m.nowLabel, next: m.nextLabel })}
        </span>
      </div>

      {/* ---- Right: the only controls that may not wait for a drawer ---------------------- */}
      <div className="flex shrink-0 items-center gap-2">
        {m.cameras.map((camera, index) => (
          <button
            key={camera.slot}
            type="button"
            data-slot={camera.slot}
            data-live={camera.live ? 'true' : 'false'}
            disabled={!camera.usable || m.busy}
            title={camera.label}
            aria-label={t('console.bar.camera', { number: index + 1, label: camera.label })}
            onClick={() => {
              a.selectCamera(camera.slot)
            }}
            className={clsx(
              'flex min-h-touch-lg min-w-touch-lg flex-col items-center justify-center rounded-glass border px-1 transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted disabled:opacity-60',
              camera.live
                ? 'border-tally bg-tally/20 text-text'
                : 'border-border bg-surface-2 text-text hover:border-accent/60',
            )}
          >
            <span className="text-base font-bold leading-none tabular-nums">{index + 1}</span>
            <span className="max-w-[3.25rem] truncate text-[10px] uppercase leading-tight text-text-muted">
              {camera.label}
            </span>
          </button>
        ))}

        <button
          type="button"
          data-testid="bottom-bar-lower-third"
          aria-pressed={m.lowerThirdVisible}
          disabled={m.busy || (!m.lowerThirdVisible && !m.lowerThirdReady)}
          title={
            m.lowerThirdReady ? t('console.bar.lowerThird') : t('console.bar.lowerThirdNotAuthored')
          }
          onClick={a.toggleLowerThird}
          className={clsx(
            'flex min-h-touch-lg min-w-touch-lg items-center justify-center rounded-glass border transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-60',
            m.lowerThirdVisible
              ? 'border-accent bg-accent text-text'
              : 'border-border bg-surface-2 text-text hover:border-accent/60',
          )}
        >
          <Type aria-hidden="true" className="h-5 w-5" />
          <span className="sr-only">{t('console.bar.lowerThird')}</span>
        </button>

        {m.isLive ? (
          m.endNeedsHold ? (
            // Ending a service stops the stream AND the recording. That is high-stakes and gets a
            // hold, not a tap (Standing Rule 6) — `endRequiresHold` decides, not this component.
            <HoldButton
              id="bottom-bar-end"
              label={t('console.bar.end')}
              onHoldComplete={a.end}
              disabled={m.busy}
              className="min-w-[6rem]"
            />
          ) : (
            <button
              type="button"
              id="bottom-bar-end"
              data-testid="bottom-bar-end"
              disabled={m.busy}
              onClick={a.end}
              className="min-h-touch-lg min-w-[6rem] rounded-glass border border-panic bg-panic/20 px-4 font-bold uppercase text-text transition-colors duration-150 hover:bg-panic/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('console.bar.end')}
            </button>
          )
        ) : (
          <button
            type="button"
            data-testid="bottom-bar-go-live"
            disabled={!m.canGoLive || m.busy}
            title={m.canGoLive ? t('console.bar.goLive') : t('console.bar.goLiveBlocked')}
            onClick={a.goLive}
            className="min-h-touch-lg min-w-[6rem] rounded-glass border border-accent-hover bg-accent px-4 font-bold uppercase text-text transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-muted"
          >
            {t('console.bar.goLive')}
          </button>
        )}

        <button
          type="button"
          data-testid="bottom-bar-settings"
          aria-label={t('console.bar.settings')}
          title={t('console.bar.settingsHint')}
          onClick={a.openSettings}
          className="flex min-h-touch-lg min-w-touch-lg items-center justify-center rounded-glass border border-border bg-surface-2 text-text transition-colors duration-150 hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Settings aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
    </footer>
  )
}

export default BottomBar
