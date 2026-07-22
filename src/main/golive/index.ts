/**
 * The GO LIVE module's public surface, and the one place the orchestrator is wired to the real
 * OBS output module, the real YouTube service and the real timers.
 *
 * {@link GoLiveService} itself knows nothing about `ObsClient`, `googleapis` or Electron: it
 * takes four structural seams. This file supplies the production ones, so the service stays
 * testable in a plain Node process with no OBS Studio, no Google account and no network — which
 * is exactly the machine Phase 5 was built on.
 *
 * The singleton is **lazy and inert**. Constructing it opens no socket, sends OBS nothing, spends
 * no YouTube quota and starts no timer: it builds two objects that hold references. The first
 * OBS request happens when `initialize()` reads the output state, and the first `Start*` happens
 * only when an operator presses GO LIVE.
 */

import { createNullLogger } from '@main/logging/logger'
import { getObsClient } from '@main/obs'
import { createObsOutputs } from '@main/obs/outputs'
import { getYouTubeService } from '@main/youtube'
import type { Logger } from '@shared/log'

import { GoLiveService, realGoLiveTimers } from './GoLiveService'
import type { GoLiveOutputs, GoLiveYouTube } from './GoLiveService'

export {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  GoLiveService,
  deriveLiveSince,
  isHealthy,
  realGoLiveTimers
} from './GoLiveService'
export type {
  GoLiveOutputs,
  GoLiveServiceOptions,
  GoLiveTimerHandle,
  GoLiveTimers,
  GoLiveYouTube,
  StartOutputsSummary
} from './GoLiveService'

/** Overrides for {@link getGoLiveService}. Every field has a production default. */
export interface GetGoLiveServiceOptions {
  /**
   * Where the orchestrator's diagnostics go.
   *
   * Defaults to the null logger, because the rolling-file logger is built inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one
   * (`getGoLiveService({ logger })`) so a go-live is reconstructable from the service-day log —
   * which is the only forensic record when something goes wrong at 10:01 on a Sunday.
   */
  readonly logger?: Logger
  /** Injectable for tests; production uses the real OBS outputs module. */
  readonly outputs?: GoLiveOutputs
  /** Injectable for tests; production uses the real YouTube service. */
  readonly youtube?: GoLiveYouTube
  readonly pollIntervalMs?: number
  readonly healthTimeoutMs?: number
}

let singleton: GoLiveService | null = null

/**
 * The process-wide GO LIVE service.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it. Construction
 * performs no OBS request and no network call.
 */
export function getGoLiveService(options: GetGoLiveServiceOptions = {}): GoLiveService {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()

  singleton = new GoLiveService({
    outputs: options.outputs ?? createObsOutputs({ client: getObsClient(), logger }),
    youtube: options.youtube ?? getYouTubeService({ logger }),
    logger,
    timers: realGoLiveTimers,
    now: Date.now,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.healthTimeoutMs === undefined ? {} : { healthTimeoutMs: options.healthTimeoutMs })
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Disposing clears subscribers and timers; it deliberately does NOT stop the stream or the
 * recording. Verger going away is never a reason for OBS to stop (Standing Rule 2).
 */
export function resetGoLiveService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
