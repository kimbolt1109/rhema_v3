/**
 * One light on the subsystem strip.
 *
 * ## Three independent channels, always
 *
 * An operator reads this from across a dark booth, at an angle, on a screen dimmed for the room,
 * quite possibly while something is going wrong. Colour alone does not survive that — and about one
 * man in twelve cannot use it at all (WCAG 1.4.1). So every light carries the same information
 * three ways:
 *
 *   1. **A text label** — "Down", "Working, not as set up", "Not set up".
 *   2. **A distinct icon per level** — no two `HealthLevel`s share a glyph. Asserted by test via
 *      `data-health-icon`, not merely intended.
 *   3. **Colour** — last, and never on its own.
 *
 * Plus an accessible name that states subsystem, level and detail in one sentence, so a screen
 * reader user gets the whole light in one stop rather than three.
 *
 * ## Amber means something
 *
 * `not-configured` is deliberately styled as a *resting* state — muted, a minus glyph, no alarm —
 * and never shares an appearance with `degraded`. A console whose speech light sat permanently
 * amber because nobody bought a Deepgram key would teach its operator to ignore amber, and the one
 * Sunday amber meant "the cloud recogniser died and we are on the local model" they would not look.
 *
 * ## How long it has been like this
 *
 * `degraded` and `down` show their age. "Reconnecting" is a different problem after four minutes
 * than after four seconds, and a light that never says which is the indicator `docs/v2-notes`
 * records as burying the real fault.
 */

import clsx from 'clsx'
import { CircleCheck, CircleMinus, CircleX, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { HealthLevel, SubsystemHealth } from '@shared/health'

import { describeElapsed } from '../store/healthStore'

/** Visual + semantic descriptor for one health level. */
interface LevelStyle {
  readonly icon: LucideIcon
  /** Stable glyph name, exposed as `data-health-icon` so a test can assert distinctness. */
  readonly iconName: string
  readonly tone: string
  readonly border: string
}

/**
 * Every {@link HealthLevel} mapped exhaustively.
 *
 * A `Record` rather than a partial map with a fallback: adding a level later must be a compile
 * error, not a silently grey light in a booth at 10:58 on a Sunday.
 */
const LEVEL_STYLES: Record<HealthLevel, LevelStyle> = {
  ok: {
    icon: CircleCheck,
    iconName: 'circle-check',
    tone: 'text-live',
    border: 'border-live/60',
  },
  'not-configured': {
    icon: CircleMinus,
    iconName: 'circle-minus',
    tone: 'text-text-muted',
    border: 'border-border',
  },
  degraded: {
    icon: TriangleAlert,
    iconName: 'triangle-alert',
    tone: 'text-accent-2',
    border: 'border-accent/60',
  },
  down: {
    icon: CircleX,
    iconName: 'circle-x',
    tone: 'text-panic',
    border: 'border-panic/70',
  },
}

/** i18n keys, held as literals so a missing translation is a grep away rather than a runtime key. */
const LEVEL_LABEL_KEYS: Record<HealthLevel, string> = {
  ok: 'health.level.ok',
  'not-configured': 'health.level.not-configured',
  degraded: 'health.level.degraded',
  down: 'health.level.down',
}

/** Whether a level is worth putting an age on. A resting state has no interesting duration. */
export function showsDuration(level: HealthLevel): boolean {
  return level === 'degraded' || level === 'down'
}

/**
 * A coarse shared clock for the "…for 4m" readouts.
 *
 * Fifteen seconds, not one: the number is read at a glance and rounded to the minute above sixty
 * seconds anyway, so a per-second re-render of the whole strip would burn a booth PC's frame budget
 * for no operator benefit. Pass an explicit `now` to pin it — every test does.
 */
export function useHealthClock(provided?: number): number {
  const [now, setNow] = useState<number>(() => provided ?? Date.now())

  useEffect(() => {
    if (provided !== undefined) return undefined
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 15_000)
    return () => {
      window.clearInterval(id)
    }
  }, [provided])

  return provided ?? now
}

export interface SubsystemLightProps {
  readonly subsystem: SubsystemHealth
  /** `sm` is the always-visible strip; `lg` is the full dashboard. */
  readonly size?: 'sm' | 'lg'
  /** Pin the clock. Omit in the app; every test passes one so durations are deterministic. */
  readonly now?: number
}

export function SubsystemLight({
  subsystem,
  size = 'sm',
  now,
}: SubsystemLightProps): React.JSX.Element {
  const { t } = useTranslation()
  const clock = useHealthClock(now)

  const style = LEVEL_STYLES[subsystem.level]
  const Icon = style.icon
  const large = size === 'lg'

  const name = t(`health.subsystem.${subsystem.id}`)
  const levelLabel = t(LEVEL_LABEL_KEYS[subsystem.level])
  const timed = showsDuration(subsystem.level)

  const elapsed = describeElapsed(subsystem.since, clock)
  const duration = t(elapsed.key, { value: elapsed.value })

  // One sentence, not three stops. The detail is part of the name because a screen reader user
  // hunting the strip for the broken one should not have to enter each light to find out.
  const accessibleName = timed
    ? t('health.light.accessibleNameTimed', {
        subsystem: name,
        level: levelLabel,
        duration,
        detail: subsystem.detail,
      })
    : t('health.light.accessibleName', {
        subsystem: name,
        level: levelLabel,
        detail: subsystem.detail,
      })

  return (
    <div
      // `group` rather than `region`: seven landmarks in one strip would make the landmark rotor
      // useless, and this is a labelled cluster, not a section of the page.
      role="group"
      aria-label={accessibleName}
      data-subsystem={subsystem.id}
      data-health-level={subsystem.level}
      data-health-icon={style.iconName}
      className={clsx(
        'flex items-center gap-2 rounded-glass border bg-surface-2',
        large ? 'min-h-touch-lg gap-3 px-4 py-2' : 'min-h-touch px-3 py-1.5',
        style.border,
      )}
    >
      <Icon
        aria-hidden="true"
        className={clsx('shrink-0', style.tone, large ? 'h-7 w-7' : 'h-5 w-5')}
      />
      <div className="min-w-0">
        <p
          className={clsx(
            'font-semibold uppercase leading-tight tracking-wide text-text',
            large ? 'text-sm' : 'text-xs',
          )}
        >
          {name}
        </p>
        {/* The words carry the meaning; the tint only reinforces them. */}
        <p className={clsx('leading-tight', style.tone, large ? 'text-base' : 'text-xs')}>
          <span data-testid={`health-level-${subsystem.id}`}>{levelLabel}</span>
          {timed ? (
            <span className="whitespace-nowrap"> · {t('health.forDuration', { duration })}</span>
          ) : null}
        </p>
        {large ? (
          <p className="mt-0.5 truncate text-xs text-text-muted">{subsystem.detail}</p>
        ) : null}
      </div>
    </div>
  )
}
