/**
 * The live transcript.
 *
 * Four properties this screen exists to hold, in the order they matter during a service:
 *
 * 1. **A dead recogniser never blocks the operator.** `failed` and `not-configured` both print, in
 *    plain words, that Verger is running manual and that nothing else is affected. There is no
 *    spinner, no modal, and no control anywhere else in the app that waits on this one (Standing
 *    Rule 1).
 * 2. **`degraded` is not `failed`.** When the fallback provider is carrying the transcript the
 *    banner names *which* provider is running and *why* the preferred one stopped. Collapsing the
 *    two states would hide a fallback the operator needs to know about — the transcript is still
 *    arriving, just slower and less accurate.
 * 3. **Drafts look like drafts.** A `tiny`-model draft or a mid-utterance partial is still being
 *    revised and will be replaced in place. It carries a visible badge and a distinct treatment, so
 *    the operator is never misled into acting on a line that is about to change. Colour is never
 *    the only signal.
 * 4. **Auto-scroll yields to the operator.** The list follows the newest line, but the moment the
 *    operator scrolls up — to re-read something the preacher said thirty seconds ago — following
 *    stops and a button offers to resume. Fighting an operator's scroll position mid-service is
 *    one of the most infuriating things a live tool can do.
 *
 * ## Capture lives here
 *
 * Only the renderer has `getUserMedia`, so this panel owns the microphone (`../audio/micCapture`)
 * and pushes PCM to the main process. It is injected through {@link TranscriptPanelProps.createCapture}
 * so jsdom tests drive the whole loop without a device. The microphone is released on stop **and**
 * on unmount: a recording indicator still burning after the service is alarming and a real privacy
 * problem.
 *
 * ## Why the transcript is not an ARIA live region
 *
 * Partials arrive several times a second and each one replaces the last. A polite live region would
 * turn that into an unusable torrent for a screen-reader user. The list is a labelled, focusable,
 * keyboard-scrollable region instead, and the *status* — which is what actually changes meaning —
 * is announced.
 */

import clsx from 'clsx'
import { ArrowDown, CircleAlert, Mic, MicOff, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AsrState, TranscriptSegment } from '@shared/asr'
import type { AppError, Result } from '@shared/result'

import type { MicCapture } from '../audio/micCapture'
import { createBrowserMicCapture } from '../audio/micCapture'
import { Button } from '../components/Button'
import { isRunningManual, useAsrStore } from '../store/asrStore'

/**
 * How close to the bottom still counts as "following".
 *
 * Not zero: sub-pixel layout, a trailing margin and a mid-flight smooth scroll all leave a few
 * pixels of slack, and a threshold of zero would drop out of follow mode on its own.
 */
export const AUTO_SCROLL_THRESHOLD_PX = 24

/** The three numbers a scroll container reports. Extracted so the rule below is testable. */
export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** Whether the view is at (or within {@link AUTO_SCROLL_THRESHOLD_PX} of) the newest line. */
export function isPinnedToBottom(
  metrics: ScrollMetrics,
  threshold: number = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distance <= threshold
}

/**
 * Whether a segment is still being revised.
 *
 * Both a fast-tier draft and an ordinary non-final partial qualify: either will be **replaced** by
 * a later result carrying the same id, so neither is something to act on yet.
 */
export function isSettling(segment: TranscriptSegment): boolean {
  return !segment.isFinal || segment.isDraft
}

/** Tint per state. Reinforcement only — every one of these also has words next to it. */
const STATE_TONES: Record<AsrState, string> = {
  'not-configured': 'text-text-muted',
  idle: 'text-text-muted',
  starting: 'text-accent-2',
  listening: 'text-live',
  // Amber, not green and not red: working, but not the way it should be.
  degraded: 'text-accent-2',
  failed: 'text-panic',
}

export interface TranscriptPanelProps {
  /**
   * How to obtain a microphone capture.
   *
   * Injected so tests exercise start/stop/push without `getUserMedia`. The default reads the real
   * browser and returns an `Err` in any runtime that has no audio, which is why nothing here
   * throws under jsdom.
   */
  readonly createCapture?: () => Result<MicCapture>
}

export function TranscriptPanel({
  createCapture = createBrowserMicCapture,
}: TranscriptPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()

  const status = useAsrStore((store) => store.status)
  const settings = useAsrStore((store) => store.settings)
  const segments = useAsrStore((store) => store.segments)
  const busy = useAsrStore((store) => store.busy)
  const capturing = useAsrStore((store) => store.capturing)
  const bridgeAvailable = useAsrStore((store) => store.bridgeAvailable)
  const lastError = useAsrStore((store) => store.lastError)
  const hydrate = useAsrStore((store) => store.hydrate)
  const subscribe = useAsrStore((store) => store.subscribe)
  const startAsr = useAsrStore((store) => store.start)
  const stopAsr = useAsrStore((store) => store.stop)
  const pushAudio = useAsrStore((store) => store.pushAudio)
  const setCapturing = useAsrStore((store) => store.setCapturing)
  const clearTranscript = useAsrStore((store) => store.clearTranscript)

  const captureRef = useRef<MicCapture | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [captureError, setCaptureError] = useState<AppError | null>(null)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  // Release the device when the panel goes away. The operator switching tabs mid-service must not
  // leave the microphone open, and neither must a crash-and-remount.
  useEffect(() => {
    return () => {
      const capture = captureRef.current
      captureRef.current = null
      if (capture !== null) void capture.stop()
    }
  }, [])

  const scrollToNewest = useCallback((): void => {
    const node = listRef.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
  }, [])

  useEffect(() => {
    if (!following) return
    scrollToNewest()
  }, [segments, following, scrollToNewest])

  const handleScroll = (): void => {
    const node = listRef.current
    if (node === null) return
    setFollowing(
      isPinnedToBottom({
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }),
    )
  }

  const handleStart = async (): Promise<void> => {
    setCaptureError(null)

    // Ask the main process first. Opening the microphone before there is anywhere to send the audio
    // would light the recording indicator for nothing.
    const started = await startAsr()
    if (!started.ok) return

    const created = createCapture()
    if (!created.ok) {
      setCaptureError(created.error)
      return
    }

    const capture = created.value
    const session = await capture.start({
      deviceId: settings.deviceId,
      onChunk: (chunk) => {
        // Fire-and-forget: a chunk that fails to land must not stall the audio callback, and a
        // per-chunk error banner ten times a second would strobe. A genuinely broken session
        // surfaces as the status going `failed`.
        void pushAudio(chunk)
      },
    })
    if (!session.ok) {
      setCaptureError(session.error)
      await stopAsr()
      return
    }

    captureRef.current = capture
    setCapturing(true)
  }

  const handleStop = async (): Promise<void> => {
    const capture = captureRef.current
    captureRef.current = null
    // Microphone first, always: whatever the main process says about the session, the device gets
    // released.
    if (capture !== null) await capture.stop()
    setCapturing(false)
    await stopAsr()
  }

  const providerName =
    status.provider === null ? t('asr.provider.none') : t(`asr.provider.${status.provider}`)
  const running = status.state === 'listening' || status.state === 'degraded'
  const manual = isRunningManual(status)

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 p-6">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold text-text">{t('asr.panel.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('asr.panel.subtitle')}</p>
      </header>

      {/* The health readout. `role="status"` so a state change is announced once, unlike the
          transcript itself which changes several times a second. */}
      <section
        role="status"
        aria-label={t('asr.panel.statusLabel')}
        data-asr-state={status.state}
        className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 rounded-glass-lg border border-border bg-surface px-4 py-3"
      >
        <Readout label={t('asr.panel.healthLabel')}>
          <span className={clsx('font-semibold', STATE_TONES[status.state])}>
            {t(`asr.state.${status.state}`)}
          </span>
        </Readout>
        <Readout label={t('asr.panel.providerLabel')}>
          <span data-testid="asr-provider" className="text-text">
            {providerName}
          </span>
        </Readout>
        <Readout label={t('asr.panel.latencyLabel')}>
          <span data-testid="asr-latency" className="font-mono text-text">
            {status.latencyMs === null
              ? t('asr.panel.latencyUnknown')
              : t('asr.panel.latencyValue', { ms: status.latencyMs })}
          </span>
        </Readout>
        <Readout label={t('asr.panel.deviceLabel')}>
          <span className="text-text">{status.deviceLabel ?? t('asr.panel.deviceUnknown')}</span>
        </Readout>
        <Readout label={t('asr.panel.micLabel')}>
          <span className={capturing ? 'text-live' : 'text-text-muted'}>
            {capturing ? t('asr.panel.capturing') : t('asr.panel.notCapturing')}
          </span>
        </Readout>
      </section>

      {status.state === 'degraded' ? (
        <Banner tone="warning" title={t('asr.panel.degraded.title', { provider: providerName })}>
          <p>{t('asr.panel.degraded.body')}</p>
          {status.lastError === null ? null : (
            <p className="mt-1 select-text">
              {t('asr.panel.degraded.reason', { reason: status.lastError })}
            </p>
          )}
        </Banner>
      ) : null}

      {manual ? (
        <Banner
          tone={status.state === 'failed' ? 'panic' : 'muted'}
          title={
            status.state === 'failed'
              ? t('asr.panel.failed.title')
              : t('asr.panel.notConfigured.title')
          }
        >
          <p>
            {status.state === 'failed'
              ? t('asr.panel.failed.body')
              : t('asr.panel.notConfigured.body')}
          </p>
          {status.lastError === null ? null : (
            <p className="mt-1 select-text">{status.lastError}</p>
          )}
        </Banner>
      ) : null}

      {!bridgeAvailable ? (
        <Banner tone="muted" title={t('asr.panel.bridgeUnavailable.title')}>
          <p>{t('asr.panel.bridgeUnavailable.body')}</p>
        </Banner>
      ) : null}

      <div
        aria-label={t('asr.panel.controlsLabel')}
        role="group"
        className="flex shrink-0 flex-wrap items-center gap-3"
      >
        {running || capturing ? (
          <Button
            variant="secondary"
            size="lg"
            icon={MicOff}
            disabled={busy}
            onClick={() => {
              void handleStop()
            }}
          >
            {t('asr.panel.stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            icon={Mic}
            disabled={busy || status.state === 'not-configured'}
            onClick={() => {
              void handleStart()
            }}
          >
            {t('asr.panel.start')}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={Trash2}
          disabled={segments.length === 0}
          onClick={clearTranscript}
        >
          {t('asr.panel.clear')}
        </Button>
        {!following ? (
          <Button
            variant="secondary"
            icon={ArrowDown}
            onClick={() => {
              setFollowing(true)
              scrollToNewest()
            }}
          >
            {t('asr.panel.resumeAutoScroll')}
          </Button>
        ) : null}
        <p className="text-xs text-text-muted" data-testid="asr-follow-state">
          {following ? t('asr.panel.autoScrollOn') : t('asr.panel.autoScrollPaused')}
        </p>
      </div>

      <section
        aria-label={t('asr.panel.transcriptLabel')}
        className="flex min-h-0 flex-1 flex-col rounded-glass-lg border border-border bg-surface"
      >
        <div
          ref={listRef}
          data-testid="asr-transcript-scroll"
          onScroll={handleScroll}
          // Focusable so the transcript is scrollable from the keyboard — a scroll container that
          // only a mouse can reach is an accessibility defect, not a style choice.
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {segments.length === 0 ? (
            <div className="flex h-full flex-col items-start justify-center gap-1">
              <p className="text-sm font-medium text-text">{t('asr.panel.empty')}</p>
              <p className="max-w-2xl text-sm text-text-muted">{t('asr.panel.emptyHint')}</p>
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {segments.map((segment) => (
                <SegmentRow key={segment.id} segment={segment} />
              ))}
            </ol>
          )}
        </div>
        <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-text-muted">
          {t('asr.panel.draftHint')}
        </p>
      </section>

      {captureError !== null ? (
        <p role="alert" className="flex shrink-0 items-start gap-1.5 text-xs text-panic">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">
            {t('asr.panel.micUnavailable', { reason: captureError.message })}
          </span>
        </p>
      ) : null}

      {lastError !== null ? (
        <p className="flex shrink-0 items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      ) : null}
    </div>
  )
}

function Readout({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </span>
  )
}

const BANNER_TONES = {
  warning: 'border-accent-2/60',
  panic: 'border-panic/60',
  muted: 'border-border',
} as const

function Banner({
  tone,
  title,
  children,
}: {
  tone: keyof typeof BANNER_TONES
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className={clsx(
        'shrink-0 rounded-glass-lg border bg-surface p-4 text-sm text-text-muted',
        BANNER_TONES[tone],
      )}
    >
      <h2 className="font-semibold text-text">{title}</h2>
      <div className="mt-1 max-w-3xl">{children}</div>
    </section>
  )
}

/**
 * One transcript line.
 *
 * The settling treatment is three-channel: a word ("Draft" / "Settling"), a dashed border, and
 * italic muted text. A regression that removes the badge and leaves only the colour is caught by
 * the test asserting on the badge text, not on a class name.
 */
function SegmentRow({ segment }: { segment: TranscriptSegment }): React.JSX.Element {
  const { t } = useTranslation()
  const settling = isSettling(segment)

  return (
    <li
      data-segment-id={segment.id}
      data-settling={settling ? 'true' : 'false'}
      data-draft={segment.isDraft ? 'true' : 'false'}
      className={clsx(
        'flex flex-col gap-1 rounded-glass px-3 py-2',
        settling
          ? 'border border-dashed border-accent-2/60 bg-surface-2/40'
          : 'border border-transparent bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {settling ? (
          <span className="rounded-glass border border-accent-2/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-2">
            {segment.isDraft ? t('asr.panel.draftBadge') : t('asr.panel.partialBadge')}
          </span>
        ) : null}
        <span className="text-[10px] uppercase tracking-wide text-text-muted">
          {t(`asr.provider.${segment.provider}`)}
        </span>
      </div>
      <p
        className={clsx(
          'select-text text-base leading-snug',
          settling ? 'italic text-text-muted' : 'text-text',
        )}
      >
        {segment.text}
      </p>
    </li>
  )
}

export default TranscriptPanel
