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

/**
 * The lamp, seated in the panel.
 *
 * `offline` is an UNLIT lamp — a dark well with a hairline rim — rather than a grey-filled dot. A
 * filled grey circle reads as "a lamp that is lit, in grey", which is not a state this system has.
 */
const TALLY_LAMP: Record<TallyTone, string> = {
  live: 'bg-tally shadow-lamp',
  transitioning: 'bg-warn shadow-lamp',
  offline: 'bg-surface-2 ring-1 ring-border',
}

/**
 * The state word's FORM, not its colour.
 *
 * This replaces a text-colour map, and the change is the whole point of the theme: saturated colour
 * is never a text colour here, so the word is always bone or muted-bone and the three states are
 * told apart by form — bare beside a lit lamp and a red edge rail (on air), boxed in an amber
 * hairline (standby), or plain muted beside an unlit lamp (off air). That is readable in pure
 * monochrome, which is what "colour is never the only channel" actually requires.
 */
const TALLY_WORD: Record<TallyTone, string> = {
  live: 'text-micro uppercase text-text',
  transitioning:
    'flex h-6 items-center rounded-chip border border-warn px-2 text-micro uppercase text-text',
  offline: 'text-micro uppercase text-text-muted',
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

  return (
    <footer
      aria-label={t('console.bar.label')}
      data-testid="bottom-bar"
      data-tally={m.tally}
      className={clsx(
        // Five columns with 1px milled grooves between them, and a two-row baseline inside each.
        // Column 1 is fixed at 320px for a reason: with a flex row, the 34px percentage drifted
        // sideways every time the OBS state word changed length.
        'relative isolate grid shrink-0 grid-cols-[20rem_1px_minmax(0,1fr)_1px_auto] items-stretch',
        'overflow-hidden border-t border-border-strong bg-surface shadow-lift',
        BOTTOM_BAR_HEIGHT_CLASS,
      )}
    >
      {/*
        The bar IS the gauge, in three layers behind the content.

        The fill is OPAQUE graphite rather than a tinted accent wash, and that is a bug fix: a 25%
        translucent fill composited over whatever sat behind it and dropped the ON AIR word to
        2.75:1. Opaque means every contrast figure on this bar is exact.
      */}
      <div
        role="progressbar"
        aria-label={t('console.bar.matchLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(m.percent === null ? {} : { 'aria-valuenow': m.percent })}
        data-testid="bottom-bar-progress"
        data-percent={m.percent === null ? '' : String(m.percent)}
        className="absolute inset-y-0 left-0 -z-20 bg-meter transition-[width] duration-200 ease-instrument"
        style={{ width: `${String(m.percent ?? 0)}%` }}
      >
        {/* The needle is the actual reading — a position, legible at two feet. Absent when there is
            no value, so an empty scale reads "no reading" rather than "a reading of zero". */}
        {m.percent === null ? null : (
          <span aria-hidden="true" className="absolute inset-y-0 right-0 w-[2px] bg-accent" />
        )}
      </div>

      {/* The scale. Always painted, and behind the fill, so the gauge is visibly a gauge even at 0. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10">
        <span className="absolute left-1/4 top-0 h-[6px] w-px bg-border-strong" />
        <span className="absolute left-1/2 top-0 h-[10px] w-px bg-border-strong" />
        <span className="absolute left-3/4 top-0 h-[6px] w-px bg-border-strong" />
      </div>

      {/* ---- Zone 1: is it going out, and for how long ------------------------------------ */}
      <div className="relative grid grid-rows-[14px_34px] content-center gap-y-1 px-4">
        {/* A filled saturated field at the panel's extreme edge = a state of the system. */}
        {m.tally === 'live' ? (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-tally" />
        ) : null}

        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            data-testid="bottom-bar-tally"
            className={clsx('h-3 w-3 shrink-0 rounded-full', TALLY_LAMP[m.tally])}
          />
          <span className={TALLY_WORD[m.tally]}>{t(`console.bar.tally.${m.tally}`)}</span>

          {m.recordingMissing ? (
            // Standing Rule 3 is being violated right now. Word + border + tint + dot + alert role,
            // and the word itself stays bone so it is 12.55:1 rather than red-on-red.
            <span
              role="alert"
              data-testid="bottom-bar-no-recording"
              className="flex h-6 items-center gap-1.5 rounded-chip border border-panic bg-panic/12 px-2 text-micro uppercase text-text"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-panic" />
              {t('console.bar.noRecording')}
            </span>
          ) : m.recording ? (
            <span
              data-testid="bottom-bar-recording"
              className="flex h-6 items-center gap-1.5 rounded-chip border border-border px-2 text-micro uppercase text-text-muted"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text-muted" />
              {t('console.bar.recording')}
            </span>
          ) : null}
        </div>

        <div className="flex items-baseline gap-3">
          {/*
            The clock is a DISPLAY, not a label: sunk into the panel, and opaque so the gauge fill
            sliding underneath can never change its contrast.

            The well appears only when there is a time to show. An empty recessed display reads as
            broken hardware — a dark box with a dash in it — whereas a bare dash reads as "not
            started yet", which is what it means.
          */}
          <span
            data-testid="bottom-bar-elapsed"
            className={clsx(
              'font-num text-readout tabular-nums',
              m.elapsed === null
                ? 'text-text-muted'
                : 'rounded-chip bg-background px-2 py-px text-text shadow-recess',
            )}
          >
            {m.elapsed ?? '—'}
          </span>
          <span aria-hidden="true" className="h-[14px] w-px self-center bg-border-strong" />
          <span data-testid="bottom-bar-obs" className="truncate text-meta text-text-muted">
            {/* The OBS state word is the Connection screen's own copy — one vocabulary, not two. */}
            {t('console.bar.obs', { state: t(`status.state.${m.obsState}`) })}
          </span>
        </div>
      </div>

      <span aria-hidden="true" className="bg-border-strong" />

      {/* ---- Zone 2: the number, and what it is about ------------------------------------- */}
      <div className="grid min-w-0 grid-rows-[14px_34px] content-center gap-y-1 px-4">
        {/* Wording never changes between states, so the label cannot flicker as the value arrives. */}
        <span className="text-micro uppercase text-text-muted">{t('console.bar.matchLabel')}</span>

        <div className="flex min-w-0 items-baseline gap-2">
          {/*
            Left-aligned in a fixed-width right-aligned box. Tabular figures plus `w-[3.6ch]` means
            7%, 42% and 100% occupy identical pixels — the old `justify-center` threw away the
            tabular-nums that was already correctly applied.
          */}
          <span
            data-testid="bottom-bar-percent"
            className="flex shrink-0 items-baseline font-num text-metric tabular-nums"
          >
            <span
              className={clsx(
                'w-[3.6ch] text-right',
                m.percent === null ? 'text-text-muted' : 'text-text',
              )}
            >
              {m.percent === null ? '—' : String(m.percent)}
            </span>
            {m.percent === null ? null : (
              <span className="text-label text-text-muted">%</span>
            )}
          </span>
          <span aria-hidden="true" className="h-[22px] w-px shrink-0 self-center bg-border-strong" />
          <span
            data-testid="bottom-bar-context"
            className="min-w-0 truncate text-body text-text-muted"
          >
            {m.nowLabel === null
              ? t('console.bar.notStarted')
              : m.nextLabel === null
                ? t('console.bar.lastCue', { now: m.nowLabel })
                : t('console.bar.context', { now: m.nowLabel, next: m.nextLabel })}
          </span>
        </div>
      </div>

      <span aria-hidden="true" className="bg-border-strong" />

      {/* ---- Zone 3: the only controls that may not wait for a drawer --------------------- */}
      <div className="flex shrink-0 items-center gap-2 px-4">
        {m.cameras.map((camera, index) => (
          <button
            key={camera.slot}
            type="button"
            data-slot={camera.slot}
            data-live={camera.live ? 'true' : 'false'}
            aria-pressed={camera.live}
            disabled={!camera.usable || m.busy}
            title={camera.label}
            aria-label={t('console.bar.camera', { number: index + 1, label: camera.label })}
            onClick={() => {
              a.selectCamera(camera.slot)
            }}
            className={clsx(
              'relative flex min-h-touch-lg min-w-touch-lg flex-col items-center justify-center gap-px overflow-hidden rounded-control border shadow-edge',
              'transition-colors duration-[120ms] ease-instrument',
              'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-dim disabled:shadow-none',
              camera.live
                ? 'border-tally bg-tally/[0.18] text-text'
                : 'border-border bg-surface-2 text-text hover:border-accent-hover hover:bg-surface-3',
            )}
          >
            <span className="font-num text-label tabular-nums leading-none">{index + 1}</span>
            {/*
              `PGM` rather than the old 10px truncated scene name, which was unreadable in a booth at
              any contrast — the scene name lives in `title` and `aria-label`, where it already was.
              The word is what makes "on air" legible without seeing the red at all.
            */}
            {camera.live ? <span className="text-micro leading-none">PGM</span> : null}
            {camera.live ? (
              <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-tally" />
            ) : null}
          </button>
        ))}

        <span aria-hidden="true" className="h-10 w-px shrink-0 bg-border-strong" />

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
            'relative flex min-h-touch-lg min-w-touch-lg flex-col items-center justify-center gap-px overflow-hidden rounded-control border shadow-edge',
            'transition-colors duration-[120ms] ease-instrument',
            'disabled:cursor-not-allowed disabled:text-text-dim disabled:shadow-none',
            // Chalk, not a state colour: an overlay being up is a CONTROL state, not an output state.
            m.lowerThirdVisible
              ? 'border-accent bg-accent/10 text-text'
              : 'border-border bg-surface-2 text-text-muted hover:border-accent-hover hover:bg-surface-3',
          )}
        >
          <Type aria-hidden="true" className="h-[18px] w-[18px]" />
          {/* Never glyph-only. */}
          <span className="text-micro leading-none">L3</span>
          <span className="sr-only">{t('console.bar.lowerThird')}</span>
          {m.lowerThirdVisible ? (
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-accent" />
          ) : null}
        </button>

        {/* FITTS-3: END is physically separated from the camera cluster it must never be mistaken for. */}
        <span aria-hidden="true" className="h-10 w-px shrink-0 bg-border-strong" />

        {m.isLive ? (
          m.endNeedsHold ? (
            // Ending a service stops the stream AND the recording. That is high-stakes and gets a
            // hold, not a tap (Standing Rule 6) — `endRequiresHold` decides, not this component.
            <HoldButton
              id="bottom-bar-end"
              label={t('console.bar.end')}
              onHoldComplete={a.end}
              disabled={m.busy}
              sizeClass="min-h-touch-lg w-28"
            />
          ) : (
            <button
              type="button"
              id="bottom-bar-end"
              data-testid="bottom-bar-end"
              disabled={m.busy}
              onClick={a.end}
              // Outline and tint only, NEVER a filled field — so it can never be confused with a
              // live camera cap or the tally rail.
              className="min-h-touch-lg w-28 rounded-panel border-2 border-panic bg-panic/12 text-label uppercase tracking-[0.08em] text-text transition-colors duration-[120ms] ease-instrument hover:bg-panic/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-dim"
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
            // The WORD is bone; green is the border, the tint and the rail. Colour absent entirely
            // when it is blocked, because "not ready" should not look like a ready control.
            className="relative min-h-touch-lg w-28 overflow-hidden rounded-panel border border-live bg-live/10 text-label uppercase tracking-[0.08em] text-text shadow-edge transition-colors duration-[120ms] ease-instrument hover:bg-surface-3 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-dim disabled:shadow-none"
          >
            {t('console.bar.goLive')}
            {m.canGoLive && !m.busy ? (
              <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-live" />
            ) : null}
          </button>
        )}

        {/* The least important key on the panel, and it looks it. */}
        <button
          type="button"
          data-testid="bottom-bar-settings"
          aria-label={t('console.bar.settings')}
          title={t('console.bar.settingsHint')}
          onClick={a.openSettings}
          className="flex min-h-touch min-w-touch items-center justify-center rounded-control border border-border text-text-muted transition-colors duration-[120ms] ease-instrument hover:border-accent-hover hover:text-text"
        >
          <Settings aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
    </footer>
  )
}

export default BottomBar
