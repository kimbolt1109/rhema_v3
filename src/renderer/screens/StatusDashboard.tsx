/**
 * The status dashboard — what the operator looks at when something goes wrong.
 *
 * ## The one question, first and biggest
 *
 * Mid-service, an operator who notices a red light has exactly one question, and it is not "which
 * subsystem is unhealthy". It is **"is the service still going out?"** So that is the first thing
 * on the screen, in words, at the largest type size in the app.
 *
 * It is answered with {@link isServiceStillGoingOut}, which asks only about the stream and the
 * recording. A red OBS light does **not** make the answer "no": Standing Rule 2 says OBS is the
 * resilient engine and this app is a convenience layer, so losing obs-websocket costs Verger its
 * remote control and costs the congregation nothing. A dashboard that shouted "OBS DOWN" in that
 * moment would send somebody to stop a service that was going out perfectly well — which is a far
 * more expensive failure than the one it was reporting.
 *
 * ## `stillWorks` is the point
 *
 * Every degraded or down subsystem prints its `detail` *and* its `stillWorks`. "Stream reconnecting
 * — the local recording is unaffected" is the difference between an operator staying calm and an
 * operator stopping the service to investigate. The reassurance is not a nicety attached to the
 * error; it is the reason the error is safe to show at all.
 *
 * ## Recovery actions, and what they cannot do
 *
 * Two actions, and **neither can stop the stream or the recording**:
 *
 *  - **Reload overlays** — a one-tap version of the watchdog, for when OBS's browser source has
 *    gone stale. The overlay server re-sends its cached per-layer state on reconnect.
 *  - **Restore a checkpoint** — the CTRL+D rewind from `docs/v2-notes/SHORTCUTS_AND_A11Y.md`. It
 *    rewinds *automation* and nothing else, and it is behind a {@link HoldButton} (Standing Rule 6)
 *    with that non-effect stated in words next to it. An operator will not press a recovery button
 *    mid-service unless the screen tells them plainly what it will not touch.
 *
 * Two variants: {@link StatusStrip} is the always-visible row in the app shell,
 * {@link StatusDashboard} is the full view.
 */

import clsx from 'clsx'
import { History, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Checkpoint, SubsystemHealth } from '@shared/health'
import { isServiceStillGoingOut } from '@shared/health'

import { HoldButton } from '../components/HoldButton'
import { Button } from '../components/Button'
import { SubsystemLight, useHealthClock } from '../components/SubsystemLight'
import { subsystemsNeedingAttention, useHealthStore } from '../store/healthStore'

export interface StatusViewProps {
  /** Pin the clock for the "…for 4m" readouts. Omit in the app; every test passes one. */
  readonly now?: number
}

/**
 * The answer, in plain words.
 *
 * Deliberately styled off `goingOut` alone and never off the worst-of roll-up. The two disagree
 * exactly when it matters most — OBS down, stream fine — and the roll-up is the wrong one to trust
 * in that moment.
 */
function ServiceAnswer({ goingOut, compact }: { goingOut: boolean; compact: boolean }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      data-testid={compact ? 'service-answer-compact' : 'service-answer'}
      data-going-out={goingOut ? 'true' : 'false'}
      className={clsx(
        'rounded-glass border bg-surface-2',
        compact ? 'flex items-center gap-2 px-3 py-1.5' : 'px-5 py-4',
        goingOut ? 'border-live/60' : 'border-panic/70',
      )}
    >
      <p
        className={clsx(
          'text-text-muted',
          compact ? 'text-xs' : 'text-sm font-medium uppercase tracking-wide',
        )}
      >
        {t('health.serviceQuestion')}
      </p>
      <p
        className={clsx(
          'font-bold leading-tight',
          goingOut ? 'text-live' : 'text-panic',
          compact ? 'text-sm' : 'mt-1 text-3xl',
        )}
      >
        {goingOut ? t('health.serviceYes') : t('health.serviceNo')}
      </p>
      {compact ? null : (
        <p className="mt-2 max-w-prose text-sm text-text-muted">
          {goingOut ? t('health.serviceYesDetail') : t('health.serviceNoDetail')}
        </p>
      )}
    </div>
  )
}

/**
 * The always-visible row in the app shell.
 *
 * Carries the answer as well as the lights, because the strip is the only part of the dashboard an
 * operator is guaranteed to be looking at when a light changes.
 */
export function StatusStrip({ now }: StatusViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const snapshot = useHealthStore((state) => state.snapshot)
  const clock = useHealthClock(now)
  const goingOut = isServiceStillGoingOut(snapshot)

  return (
    <div
      data-testid="status-strip"
      data-health-worst={snapshot.worst}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2"
    >
      <ServiceAnswer goingOut={goingOut} compact />
      <ul aria-label={t('app.subsystemsLabel')} className="flex flex-wrap items-center gap-2">
        {snapshot.subsystems.map((subsystem) => (
          <li key={subsystem.id}>
            <SubsystemLight subsystem={subsystem} now={clock} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One problem card: what is wrong, and — the part that matters — what still works regardless. */
function ProblemCard({
  subsystem,
  now,
}: {
  subsystem: SubsystemHealth
  now: number
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <li
      data-testid={`health-problem-${subsystem.id}`}
      className="flex flex-col gap-2 rounded-glass border border-border bg-surface p-3"
    >
      <SubsystemLight subsystem={subsystem} size="lg" now={now} />
      {subsystem.stillWorks === null ? null : (
        <p
          data-testid={`health-still-works-${subsystem.id}`}
          className="max-w-prose rounded-glass border border-live/50 bg-surface-2 px-3 py-2 text-sm text-text"
        >
          {t('health.stillWorks', { text: subsystem.stillWorks })}
        </p>
      )}
    </li>
  )
}

/** The checkpoint picker. Newest first, because the newest is what a bad cue wants undone. */
function CheckpointChoice({
  checkpoint,
  selected,
  onSelect,
}: {
  checkpoint: Checkpoint
  selected: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <label
      data-testid={`checkpoint-${checkpoint.id}`}
      data-selected={selected ? 'true' : 'false'}
      className={clsx(
        'flex min-h-touch cursor-pointer items-center gap-3 rounded-glass border px-3 py-2',
        selected ? 'border-accent bg-surface-2' : 'border-border bg-surface',
      )}
    >
      <input
        type="radio"
        name="verger-checkpoint"
        value={checkpoint.id}
        checked={selected}
        onChange={() => {
          onSelect(checkpoint.id)
        }}
        className="h-5 w-5 shrink-0 accent-[rgb(var(--color-accent))]"
      />
      <span className="min-w-0">
        <span className="block truncate text-sm text-text">{checkpoint.label}</span>
        <span className="block text-xs text-text-muted">
          {t('health.checkpoint.position', { position: checkpoint.planPosition + 1 })}
        </span>
      </span>
    </label>
  )
}

export function StatusDashboard({ now }: StatusViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const snapshot = useHealthStore((state) => state.snapshot)
  const checkpoints = useHealthStore((state) => state.checkpoints)
  const busy = useHealthStore((state) => state.busy)
  const bridgeAvailable = useHealthStore((state) => state.bridgeAvailable)
  const lastError = useHealthStore((state) => state.lastError)
  const restoreCheckpoint = useHealthStore((state) => state.restoreCheckpoint)
  const reloadOverlays = useHealthStore((state) => state.reloadOverlays)

  const clock = useHealthClock(now)
  const goingOut = isServiceStillGoingOut(snapshot)
  const attention = subsystemsNeedingAttention(snapshot)

  const [chosen, setChosen] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const fallback = checkpoints[0]
  const selectedId = chosen ?? (fallback === undefined ? null : fallback.id)
  const selected = checkpoints.find((entry) => entry.id === selectedId) ?? null

  const handleReload = (): void => {
    void reloadOverlays().then((result) => {
      setAnnouncement(
        result.ok ? t('health.recovery.reloadDone') : t('health.recovery.reloadFailed'),
      )
    })
  }

  const handleRestore = (): void => {
    if (selected === null) return
    void restoreCheckpoint(selected.id).then((result) => {
      setAnnouncement(
        result.ok
          ? t('health.recovery.restoreDone', { label: selected.label })
          : t('health.recovery.restoreFailed'),
      )
    })
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-2xl font-semibold text-text">{t('health.title')}</h1>

      <ServiceAnswer goingOut={goingOut} compact={false} />

      <section aria-label={t('health.lightsLabel')} data-health-worst={snapshot.worst}>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('health.lightsLabel')}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {snapshot.subsystems.map((subsystem) => (
            <li key={subsystem.id}>
              <SubsystemLight subsystem={subsystem} size="lg" now={clock} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t('health.attentionLabel')} data-testid="health-attention">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('health.attentionLabel')}
        </h2>
        {attention.length === 0 ? (
          <p className="text-sm text-text-muted">{t('health.attentionNone')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {attention.map((subsystem) => (
              <ProblemCard key={subsystem.id} subsystem={subsystem} now={clock} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('health.recovery.label')} className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('health.recovery.label')}
        </h2>

        {/* Said once, up front, and again on the hold button itself. Nothing on this panel can
            interrupt the broadcast, and an operator who does not know that will not touch it. */}
        <p
          data-testid="recovery-no-broadcast-impact"
          className="max-w-prose rounded-glass border border-live/50 bg-surface-2 px-3 py-2 text-sm text-text"
        >
          {t('health.recovery.noBroadcastImpact')}
        </p>

        <div className="flex flex-col gap-2">
          <Button
            icon={RefreshCw}
            variant="secondary"
            size="lg"
            disabled={busy || !bridgeAvailable}
            id="reload-overlays"
            onClick={handleReload}
          >
            {t('health.recovery.reloadOverlays')}
          </Button>
          <p className="max-w-prose text-xs text-text-muted">
            {t('health.recovery.reloadOverlaysDetail')}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2 rounded-glass border border-border p-3">
          <legend className="px-1 text-sm font-semibold text-text">
            {t('health.checkpoint.legend')}
          </legend>
          <p className="max-w-prose text-xs text-text-muted">{t('health.checkpoint.detail')}</p>

          {checkpoints.length === 0 ? (
            <p data-testid="checkpoints-empty" className="text-sm text-text-muted">
              {t('health.checkpoint.none')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {checkpoints.map((checkpoint) => (
                <CheckpointChoice
                  key={checkpoint.id}
                  checkpoint={checkpoint}
                  selected={checkpoint.id === selectedId}
                  onSelect={setChosen}
                />
              ))}
            </div>
          )}

          {/* A hold, never a tap (Standing Rule 6). The label states the non-effects, because the
              accessible name of this control is the last thing read before it fires. */}
          <HoldButton
            label={t('health.checkpoint.restore')}
            onHoldComplete={handleRestore}
            disabled={selected === null || busy || !bridgeAvailable}
            icon={History}
            className="self-start"
          />
          <p
            data-testid="checkpoint-non-effects"
            className="max-w-prose text-xs text-text-muted"
          >
            {t('health.checkpoint.nonEffects')}
          </p>
        </fieldset>

        {bridgeAvailable ? null : (
          <p data-testid="health-bridge-unavailable" className="text-sm text-text-muted">
            {t('health.bridgeUnavailable')}
          </p>
        )}
        {lastError === null ? null : (
          <p data-testid="health-error" className="select-text text-sm text-panic">
            {lastError.message}
          </p>
        )}
      </section>

      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}
