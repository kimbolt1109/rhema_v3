/**
 * The renderer's mirror of subsystem health, plus the two recovery actions.
 *
 * `src/shared/health.ts` is the contract; this store holds the last {@link HealthSnapshot} the main
 * process reported and the checkpoint list, and it exposes exactly two recovery calls.
 *
 * ## What this store may and may not do
 *
 * 1. **It never invents health.** A subsystem's level is only ever what the main process said it
 *    was. There is no local optimism here — a store that guessed "probably fine" would produce the
 *    single most expensive lie the console can tell, and the whole point of the strip is that an
 *    amber light means something.
 * 2. **Neither recovery action can stop the broadcast.** {@link HealthStoreState.reloadOverlays}
 *    reloads browser sources and {@link HealthStoreState.restoreCheckpoint} rewinds *automation*.
 *    Neither has any way to reach OBS's stream or recording: there is no `goLive` call anywhere in
 *    this file, and adding one would be the bug BLUEPRINT.md §9 exists to prevent.
 * 3. **A missing bridge is a resting state, not a crash.** Under vitest, or if the preload never
 *    loaded, `window.verger` is absent; every method degrades to a refusal and the snapshot stays
 *    at its all-`not-configured` resting value.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { Checkpoint, HealthSnapshot, SubsystemHealth } from '@shared/health'
import { HEALTH_SEVERITY, SUBSYSTEMS, initialHealth, worstLevel } from '@shared/health'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case.
 *
 * The operator sees the localised `health.bridgeUnavailable` copy instead; this string is for the
 * log file and for assertions.
 */
export const HEALTH_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; subsystem health cannot be read.'

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: HEALTH_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, HEALTH_BRIDGE_UNAVAILABLE_MESSAGE)
}

async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    // Nothing throws across the boundary. A preload that rejected — or that was torn down
    // mid-call — becomes a Result the dashboard can render, never an unhandled rejection.
    return { ok: false, error: toAppError(cause) }
  }
}

/* ------------------------------ pure helpers, unit-testable ------------------------------ */

/**
 * The resting snapshot: every subsystem `not-configured`, nothing claimed.
 *
 * Deliberately not "everything ok". A console that starts green and only goes amber when told
 * would show a full row of healthy lights during the seconds before the first snapshot arrives —
 * exactly when an operator is most likely to glance at it.
 */
export function restingHealthSnapshot(now: number): HealthSnapshot {
  const subsystems = SUBSYSTEMS.map((id) => initialHealth(id, now))
  return { subsystems, worst: worstLevel(subsystems), at: now }
}

/**
 * The subsystems an operator has to do something about, worst first.
 *
 * `not-configured` is excluded on purpose — it is a resting state, and listing it here would fill
 * the "needs attention" panel on a machine where nothing is wrong.
 */
export function subsystemsNeedingAttention(
  snapshot: HealthSnapshot,
): readonly SubsystemHealth[] {
  return snapshot.subsystems
    .filter((subsystem) => subsystem.level === 'degraded' || subsystem.level === 'down')
    .slice()
    .sort((left, right) => HEALTH_SEVERITY[right.level] - HEALTH_SEVERITY[left.level])
}

/** Look one subsystem up. Returns `null` rather than throwing on an unknown id. */
export function findSubsystem(
  snapshot: HealthSnapshot,
  id: SubsystemHealth['id'],
): SubsystemHealth | null {
  return snapshot.subsystems.find((subsystem) => subsystem.id === id) ?? null
}

/** How the compact readouts describe an elapsed time. Pure, so the tests are not clock-dependent. */
export interface ElapsedDescription {
  /** i18n key for the unit, e.g. `health.duration.minutes`. */
  readonly key: string
  /** Whole units elapsed, already clamped at zero. */
  readonly value: number
}

/**
 * How long a subsystem has been in its current state.
 *
 * Clamped at zero because a main process clock that is a few milliseconds ahead of the renderer's
 * must read as "just now", never as a negative duration.
 */
export function describeElapsed(since: number, now: number): ElapsedDescription {
  const seconds = Math.floor(Math.max(0, now - since) / 1000)
  if (seconds < 60) return { key: 'health.duration.seconds', value: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { key: 'health.duration.minutes', value: minutes }
  return { key: 'health.duration.hours', value: Math.floor(minutes / 60) }
}

/* ---------------------------------------- the store ---------------------------------------- */

export interface HealthStoreState {
  /** The last snapshot the main process reported. Never locally invented. */
  readonly snapshot: HealthSnapshot
  /** Newest first, as the main process orders them. Capped at `MAX_CHECKPOINTS` upstream. */
  readonly checkpoints: readonly Checkpoint[]
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link HealthStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a recovery round trip is in flight. */
  readonly busy: boolean
  readonly lastError: AppError | null

  hydrate: () => Promise<void>
  /** Wire the push channel. Returns an unsubscribe — call it on unmount. */
  subscribe: () => Unsubscribe
  /**
   * Rewind automation to a checkpoint.
   *
   * Automation only. This cannot stop the stream or the recording, and the UI says so in words
   * before the operator commits to the hold.
   */
  restoreCheckpoint: (checkpointId: string) => Promise<Result<HealthSnapshot>>
  /** Force every attached overlay browser source to reload and re-sync from the state cache. */
  reloadOverlays: () => Promise<Result<HealthSnapshot>>
}

const noop: Unsubscribe = () => undefined

function initialState(): Omit<
  HealthStoreState,
  'hydrate' | 'subscribe' | 'restoreCheckpoint' | 'reloadOverlays'
> {
  return {
    snapshot: restingHealthSnapshot(Date.now()),
    checkpoints: [],
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    busy: false,
    lastError: null,
  }
}

export const useHealthStore = create<HealthStoreState>()((set) => {
  /** Run one recovery call, adopting its snapshot and never blanking the mirror on refusal. */
  const run = async (
    operation: (api: VergerApi) => Promise<Result<HealthSnapshot>>,
  ): Promise<Result<HealthSnapshot>> => {
    set({ busy: true })
    const result = await callBridge(operation)
    if (result.ok) {
      set({ snapshot: result.value, busy: false, lastError: null })
    } else {
      // The mirrored snapshot is kept exactly as it was. A refused recovery is not evidence that
      // anything about the subsystems changed, and blanking the lights here would turn a failed
      // button press into a dashboard that looks like a catastrophe.
      set({ busy: false, lastError: result.error })
    }
    return result
  }

  return {
    ...initialState(),

    hydrate: async () => {
      const api = getVergerApi()
      if (api === undefined) {
        set({
          ...initialState(),
          bridgeAvailable: false,
          hydrated: true,
          lastError: bridgeUnavailableError(),
        })
        return
      }

      set({ bridgeAvailable: true })

      const [snapshot, checkpoints] = await Promise.all([
        callBridge((bridge) => bridge.health.get()),
        callBridge((bridge) => bridge.health.listCheckpoints()),
      ])

      if (snapshot.ok) set({ snapshot: snapshot.value })
      if (checkpoints.ok) set({ checkpoints: checkpoints.value })

      const failure = !snapshot.ok ? snapshot.error : !checkpoints.ok ? checkpoints.error : null
      set({ hydrated: true, lastError: failure })
    },

    subscribe: () => {
      const api = getVergerApi()
      if (api === undefined) {
        set({ bridgeAvailable: false })
        return noop
      }
      return api.health.onSnapshot((snapshot) => {
        set({ snapshot })
      })
    },

    restoreCheckpoint: async (checkpointId) =>
      // No local optimism, in either direction. A rewind that failed must not look like it worked,
      // and one that worked is reported by the snapshot the main process hands back.
      run((bridge) => bridge.health.restoreCheckpoint({ checkpointId })),

    reloadOverlays: async () => run((bridge) => bridge.health.reloadOverlays()),
  }
})

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `down` light from one test silently breaks the next.
 */
export function resetHealthStore(): void {
  useHealthStore.setState(initialState())
}
