/**
 * The connection light.
 *
 * This is the single most-glanced-at element in the app, so it is deliberately large and
 * deliberately redundant. Three independent channels carry the same information:
 *
 *   1. **Colour** — green / indigo / red / grey.
 *   2. **A text label** — "Connected", "Password rejected", …
 *   3. **A distinct icon per state** — no two states share a glyph.
 *
 * Colour is never the sole signal. That is both an accessibility requirement (WCAG 1.4.1, and
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §9.5 records the tone-dot-plus-text pattern as the
 * compliant one v2 settled on) *and* a booth requirement: the operator reads this from across a
 * dark room, at an angle, on a screen dimmed for the room. Shape and text survive that; hue does
 * not always.
 *
 * `reconnecting` additionally shows the attempt number and a live countdown to the next retry,
 * because "reconnecting…" with no further detail is the exact indicator v2's notes describe as
 * burying the real problem. Knowing it is on attempt 14 with 30 s between tries tells the
 * operator to go look at the OBS machine.
 *
 * Announcements: a single polite live region carries the state label and its explanation. The
 * ticking countdown is `aria-hidden` — announcing "29… 28… 27…" to a screen reader user during a
 * service would be actively hostile.
 */

import clsx from 'clsx'
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  LoaderCircle,
  RefreshCw,
  Settings,
  ShieldAlert,
  Unplug,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ObsConnectionState, ObsStatus } from '@shared/obs'

/** Visual + semantic descriptor for one connection state. */
interface StateStyle {
  readonly icon: LucideIcon
  /** Stable machine name for the glyph, exposed as `data-obs-icon` so tests can assert distinctness. */
  readonly iconName: string
  readonly tone: string
  readonly ring: string
  readonly spin: boolean
}

/**
 * Every `ObsConnectionState` mapped exhaustively. The `Record` type — not a partial map with a
 * fallback — is what makes a future state addition a compile error rather than a silently grey
 * light in production.
 */
const STATE_STYLES: Record<ObsConnectionState, StateStyle> = {
  'not-configured': {
    icon: Settings,
    iconName: 'settings',
    tone: 'text-text-muted',
    ring: 'border-border',
    spin: false,
  },
  idle: {
    icon: CirclePause,
    iconName: 'circle-pause',
    tone: 'text-text-muted',
    ring: 'border-border',
    spin: false,
  },
  connecting: {
    icon: LoaderCircle,
    iconName: 'loader-circle',
    tone: 'text-accent-2',
    ring: 'border-accent/60',
    spin: true,
  },
  connected: {
    icon: CircleCheck,
    iconName: 'circle-check',
    tone: 'text-live',
    ring: 'border-live/60',
    spin: false,
  },
  reconnecting: {
    icon: RefreshCw,
    iconName: 'refresh-cw',
    tone: 'text-accent-2',
    ring: 'border-accent/60',
    spin: true,
  },
  disconnected: {
    icon: Unplug,
    iconName: 'unplug',
    tone: 'text-panic',
    ring: 'border-panic/50',
    spin: false,
  },
  'auth-failed': {
    icon: ShieldAlert,
    iconName: 'shield-alert',
    tone: 'text-panic',
    ring: 'border-panic/70',
    spin: false,
  },
}

/** i18n keys, held as literals so a missing translation is a grep away rather than a runtime key. */
const STATE_LABEL_KEYS: Record<ObsConnectionState, string> = {
  'not-configured': 'status.state.not-configured',
  idle: 'status.state.idle',
  connecting: 'status.state.connecting',
  connected: 'status.state.connected',
  reconnecting: 'status.state.reconnecting',
  disconnected: 'status.state.disconnected',
  'auth-failed': 'status.state.auth-failed',
}

const STATE_DETAIL_KEYS: Record<ObsConnectionState, string> = {
  'not-configured': 'status.detail.not-configured',
  idle: 'status.detail.idle',
  connecting: 'status.detail.connecting',
  connected: 'status.detail.connected',
  reconnecting: 'status.detail.reconnecting',
  disconnected: 'status.detail.disconnected',
  'auth-failed': 'status.detail.auth-failed',
}

export interface StatusIndicatorProps {
  readonly status: ObsStatus
  /** `sm` is the subsystem strip in the title bar; `lg` is the Connection screen's big light. */
  readonly size?: 'sm' | 'lg'
}

/**
 * Seconds remaining until the next retry, recomputed on a timer.
 *
 * The store only ever holds what the main process observed, so the countdown has to be derived
 * locally from `since + nextRetryInMs`. The interval is only ever installed while a retry is
 * actually scheduled — an idle screen runs no timer.
 */
function useRetryCountdown(status: ObsStatus): number | null {
  const { since, nextRetryInMs } = status
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (nextRetryInMs === null) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 500)
    return () => {
      window.clearInterval(id)
    }
  }, [since, nextRetryInMs])

  if (nextRetryInMs === null) return null
  return Math.max(0, Math.ceil((since + nextRetryInMs - now) / 1000))
}

export function StatusIndicator({ status, size = 'lg' }: StatusIndicatorProps): React.JSX.Element {
  const { t } = useTranslation()
  const style = STATE_STYLES[status.state]
  const Icon = style.icon
  const countdown = useRetryCountdown(status)

  const label = t(STATE_LABEL_KEYS[status.state])
  const detail = t(STATE_DETAIL_KEYS[status.state])
  const isRetrying = status.state === 'reconnecting'

  const large = size === 'lg'

  return (
    <section
      aria-label={t('status.regionLabel')}
      data-obs-state={status.state}
      data-obs-icon={style.iconName}
      className={clsx(
        'flex items-start gap-4 rounded-glass-lg border bg-surface',
        large ? 'p-5' : 'p-3',
        style.ring,
      )}
    >
      <Icon
        aria-hidden="true"
        className={clsx(
          'shrink-0',
          style.tone,
          large ? 'h-12 w-12' : 'h-6 w-6',
          // `animate-spin` is collapsed to a single frame by the prefers-reduced-motion guard in
          // styles/index.css; the icon shape and the text still carry the meaning.
          style.spin ? 'animate-spin [animation-duration:1.6s]' : '',
        )}
      />

      <div className="min-w-0 flex-1">
        <p className={clsx('font-semibold leading-tight', style.tone, large ? 'text-2xl' : 'text-sm')}>
          {label}
        </p>

        <p className={clsx('mt-1 text-text-muted', large ? 'text-sm' : 'text-xs')}>{detail}</p>

        {isRetrying ? (
          <p
            // Aria-hidden on purpose: the numbers change twice a second. The live region below
            // announces the state change once, which is the part that carries meaning.
            aria-hidden="true"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-text-muted"
          >
            <span>{t('status.attempt', { count: status.attempt })}</span>
            <span>
              {countdown === null || countdown <= 0
                ? t('status.retryNow')
                : t('status.retryIn', { seconds: countdown })}
            </span>
          </p>
        ) : null}

        {status.lastError !== null ? (
          <p className={clsx('mt-2 flex items-start gap-1.5 text-xs', 'text-text-muted')}>
            <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
            <span className="select-text">
              {t(`errors.code.${status.lastError.code}`)} — {status.lastError.message}
            </span>
          </p>
        ) : null}
      </div>

      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {t('status.announcement', { label, detail })}
      </span>
    </section>
  )
}
