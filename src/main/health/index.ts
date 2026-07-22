/**
 * The health module's public surface, and the one place the aggregator and the checkpoint store
 * are wired to the real subsystems.
 *
 * Neither {@link HealthService} nor {@link CheckpointStore} knows what an `ObsClient` is: both
 * hold local structural seams and are driven in tests by trivial fakes. This file supplies the
 * production ones.
 *
 * ## Why this file is the one that matters
 *
 * STATUS.md records the same defect four times — Phase 2's overlay server that was never started,
 * Phase 4's session that was never restored, Phase 5's go-live re-attach that never ran, Phase 8's
 * cue engine with no transcript source and no detector. Every one passed every unit test, because
 * unit tests inject their own fakes; every one was a *wiring* file that nobody owned.
 *
 * Two deliberate choices here are the answer to that:
 *
 * 1. **Every seam on both constructors is required.** There is no optional source that can be
 *    silently omitted; leaving one out is a compile error, not an inert light.
 * 2. **`getHealthService()` and `getCheckpointStore()` subscribe as part of construction.** There
 *    is no separate `start()` that a caller must remember, because "a caller must remember" is
 *    precisely how the previous four happened.
 *
 * ## Still inert
 *
 * Construction opens no socket, binds no port, reads no file of its own and starts no timer. It
 * resolves six sibling singletons (each itself lazy) and registers in-process listeners. The first
 * timer is created only when a subsystem's status actually changes and a snapshot needs
 * coalescing.
 *
 * ## The two never-called verbs
 *
 * `CheckpointBroadcastLike` carries `stopStream` and `stopRecord` so that a test can prove restore
 * never touches them. The production implementations below do not merely go unused — they refuse,
 * returning an `Err` without reaching OBS. No recovery action in Verger may stop the stream or the
 * recording, and here that rule is enforced by the wiring rather than by a comment.
 */

import { getAsrService } from '@main/asr'
import { getCueEngine } from '@main/cue'
import { getGoLiveService } from '@main/golive'
import { createNullLogger } from '@main/logging/logger'
import { getObsClient } from '@main/obs'
import { getOverlayServer } from '@main/overlay'
import { getPlanService } from '@main/plan'
import { getYouTubeService } from '@main/youtube'
import type { Logger } from '@shared/log'
import { ErrorCode, err } from '@shared/result'
import type { Result } from '@shared/result'

import { CheckpointStore } from './checkpoints'
import type {
  CheckpointBroadcastLike,
  CheckpointOverlayLike,
  CheckpointPlanLike,
} from './checkpoints'
import { HealthService } from './HealthService'

export {
  DROPPED_FRAME_DEGRADED_RATIO,
  HEALTH_EMIT_INTERVAL_MS,
  HealthService,
  mapAsr,
  mapAutomation,
  mapObs,
  mapOverlay,
  mapRecording,
  mapStream,
  mapYouTube,
  realHealthTimers,
} from './HealthService'
export type {
  HealthAsrLike,
  HealthCueLike,
  HealthGoLiveLike,
  HealthObsLike,
  HealthOverlayLike,
  HealthServiceOptions,
  HealthTimerHandle,
  HealthTimers,
  HealthYouTubeLike,
  SubsystemVerdict,
} from './HealthService'
export { CheckpointStore, MAX_REWIND_STEPS, firedCueLabel } from './checkpoints'
export type {
  CheckpointBroadcastLike,
  CheckpointCueLike,
  CheckpointOverlayLike,
  CheckpointPlanLike,
  CheckpointStoreOptions,
  RecordCheckpointInput,
} from './checkpoints'

/** Overrides for {@link getHealthService} and {@link getCheckpointStore}. */
export interface GetHealthOptions {
  /**
   * Where health diagnostics go.
   *
   * Defaults to the null logger, because the rolling-file logger is built inside `app.whenReady()`
   * and there is no module-level singleton to reach for. Pass the real one so the state of every
   * subsystem at 10:31 on a Sunday is in the service-day log.
   */
  readonly logger?: Logger
}

let healthSingleton: HealthService | null = null
let checkpointSingleton: CheckpointStore | null = null

/**
 * The process-wide health aggregator, already watching every subsystem.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it.
 */
export function getHealthService(options: GetHealthOptions = {}): HealthService {
  if (healthSingleton !== null) return healthSingleton

  const logger = options.logger ?? createNullLogger()

  const service = new HealthService({
    obs: getObsClient({ logger }),
    overlay: getOverlayServer({ logger }),
    asr: getAsrService({ logger }),
    youtube: getYouTubeService({ logger }),
    goLive: getGoLiveService({ logger }),
    cue: getCueEngine({ logger }),
    logger,
  })
  healthSingleton = service

  // Subscribing here rather than leaving a `start()` for a caller to forget: the four shipped
  // wiring defects in STATUS.md were all "someone had to remember", and nobody did.
  service.start()
  return service
}

/**
 * The process-wide checkpoint store, already watching the cue engine for fired cues.
 *
 * Callable with no arguments. The IPC layer reaches checkpoints through this rather than through
 * {@link getHealthService}: recording and rewinding automation is a different job from observing
 * it, and the aggregator deliberately has no verb that changes anything.
 */
export function getCheckpointStore(options: GetHealthOptions = {}): CheckpointStore {
  if (checkpointSingleton !== null) return checkpointSingleton

  const logger = options.logger ?? createNullLogger()
  const plan = getPlanService({ logger })
  const overlay = getOverlayServer({ logger })
  const goLive = getGoLiveService({ logger })

  const planSeam: CheckpointPlanLike = {
    getPosition: () => {
      const state = plan.getState()
      return state.ok ? state.value.position.index : -1
    },
    // The one mutating call a rewind makes. `back()` moves the pointer and fires nothing.
    back: () => plan.back(),
  }

  const overlaySeam: CheckpointOverlayLike = {
    getRevision: () => overlay.getState().revision,
    // Recorded for context only; a rewind never sends this. Wired to the real server so that the
    // "never called" guarantee is about behaviour rather than about a stub that could not work.
    send: (command) => overlay.send(command),
  }

  const broadcastSeam: CheckpointBroadcastLike = {
    isLive: () => {
      const state = goLive.getState()
      return state.obs.streaming || state.obs.recording
    },
    // Deliberately inert. No recovery action may stop the stream or the recording — not panic, not
    // a checkpoint restore, not a watchdog — so the production wiring refuses instead of obeying.
    stopStream: () => Promise.resolve(refuseToStop('stream')),
    stopRecord: () => Promise.resolve(refuseToStop('recording')),
  }

  const store = new CheckpointStore({
    plan: planSeam,
    overlay: overlaySeam,
    cue: getCueEngine({ logger }),
    broadcast: broadcastSeam,
    logger,
  })
  checkpointSingleton = store

  store.start()
  return store
}

/** The refusal returned by the never-called broadcast verbs. */
function refuseToStop(what: string): Result<never> {
  return err(
    ErrorCode.INVALID_ARG,
    `recovery never stops the ${what}`,
    'checkpoint restore, panic and the watchdogs are all automation-only by design',
  )
}

/**
 * Drop both singletons, disposing them first.
 *
 * Disposing releases subscriptions and any pending coalesced emit. It stops nothing, blanks
 * nothing and rewinds nothing: the health module going away is never a reason for the service to
 * change.
 */
export function resetHealthService(): void {
  const health = healthSingleton
  const checkpoints = checkpointSingleton
  healthSingleton = null
  checkpointSingleton = null
  if (health !== null) health.dispose()
  if (checkpoints !== null) checkpoints.dispose()
}
