/**
 * Subsystem health — the glanceable status dashboard.
 *
 * BLUEPRINT.md §9 is a table of failure modes and their safeguards. The rule that unifies them:
 * **every degradation is visible and recoverable, and none of them stops the service.**
 *
 * ## Why a single health model rather than each panel showing its own
 *
 * An operator in a dark booth mid-service has no time to visit five screens. One strip of lights,
 * always visible, each naming a subsystem and its state in words as well as colour. If a light is
 * amber, the operator must be able to tell in one glance whether the service is still going out.
 *
 * ## Amber must mean something
 *
 * `degraded` is reserved for "working, but not the way you configured it" — the cloud recogniser
 * fell back to local, OBS is reconnecting a dropped RTMP link. A subsystem that is simply not
 * configured is NOT amber; it is `not-configured`, which is a resting state. A permanently amber
 * light teaches an operator to ignore amber, which is worse than having no light at all.
 *
 * Node-global free.
 */

/** Every subsystem with its own light. */
export const SUBSYSTEMS = [
  'obs',
  'overlay',
  'asr',
  'youtube',
  'recording',
  'stream',
  'automation',
] as const

/** Union of the subsystem ids. */
export type SubsystemId = (typeof SUBSYSTEMS)[number]

/**
 * A subsystem's state.
 *
 * Ordered by severity for sorting and for the worst-of roll-up.
 */
export type HealthLevel =
  /** Working as configured. */
  | 'ok'
  /** Deliberately unconfigured. A resting state, never an alarm. */
  | 'not-configured'
  /** Working, but not as configured — a fallback is active, or a link is reconnecting. */
  | 'degraded'
  /** Not working. The operator must know, and must be told what still works. */
  | 'down'

/** Severity rank, for the worst-of roll-up. `not-configured` deliberately ranks below `degraded`. */
export const HEALTH_SEVERITY: Readonly<Record<HealthLevel, number>> = {
  ok: 0,
  'not-configured': 1,
  degraded: 2,
  down: 3,
}

/** One light on the strip. */
export interface SubsystemHealth {
  readonly id: SubsystemId
  readonly level: HealthLevel
  /**
   * Short operator-facing state, e.g. `reconnecting (attempt 3)`.
   *
   * Never a stack trace and never a bare error code. This is read across a room, at speed, by
   * someone who is also running a service.
   */
  readonly detail: string
  /**
   * What still works despite this, when the level is `degraded` or `down`.
   *
   * The single most valuable string on the dashboard. "Stream reconnecting — the local recording
   * is unaffected" is the difference between an operator staying calm and an operator stopping
   * the service to investigate.
   */
  readonly stillWorks: string | null
  /** Epoch ms this level was entered, so the UI can show how long it has been like this. */
  readonly since: number
}

/** The whole dashboard. */
export interface HealthSnapshot {
  readonly subsystems: readonly SubsystemHealth[]
  /** Worst level across all subsystems, for the single roll-up indicator. */
  readonly worst: HealthLevel
  readonly at: number
}

/** A subsystem at rest. */
export function initialHealth(id: SubsystemId, now: number): SubsystemHealth {
  return { id, level: 'not-configured', detail: 'not configured', stillWorks: null, since: now }
}

/** The worst level present, for the roll-up light. */
export function worstLevel(subsystems: readonly SubsystemHealth[]): HealthLevel {
  let worst: HealthLevel = 'ok'
  for (const subsystem of subsystems) {
    if (HEALTH_SEVERITY[subsystem.level] > HEALTH_SEVERITY[worst]) worst = subsystem.level
  }
  return worst
}

/**
 * Whether the service is still going out to the congregation.
 *
 * Deliberately narrow: it asks only about `stream` and `recording`. OBS being disconnected from
 * *Verger* does not stop OBS streaming — that is the whole architecture (Standing Rule 2) — so a
 * red OBS light must not make this false. The dashboard uses this to answer the only question
 * that matters mid-service at a glance.
 */
export function isServiceStillGoingOut(snapshot: HealthSnapshot): boolean {
  const relevant = snapshot.subsystems.filter(
    (subsystem) => subsystem.id === 'stream' || subsystem.id === 'recording',
  )
  if (relevant.length === 0) return false
  return relevant.some((subsystem) => subsystem.level === 'ok' || subsystem.level === 'degraded')
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A recoverable snapshot of automation state.
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` describes a CTRL+D checkpoint recovery. The point is a
 * safe rewind of *automation* after a wrong turn — not a rewind of the broadcast, which cannot be
 * undone.
 *
 * What a checkpoint deliberately does NOT contain: anything about the stream or the recording.
 * Restoring one must never stop, start or alter either.
 */
export interface Checkpoint {
  readonly id: string
  readonly at: number
  /** Plan position at the time. */
  readonly planPosition: number
  /** Overlay revision at the time, so the operator can see what was on screen. */
  readonly overlayRevision: number
  /** Human summary, e.g. `after cue "Point 1 — Grace"`. */
  readonly label: string
}

/** How many checkpoints are retained. Enough to undo a bad patch, not a whole service. */
export const MAX_CHECKPOINTS = 20
