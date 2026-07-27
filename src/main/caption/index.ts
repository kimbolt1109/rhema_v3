/**
 * The caption module's public surface, and the one place the service is wired to the rest of the
 * app.
 *
 * {@link CaptionService} knows nothing about `AsrService` or the overlay server — it holds two
 * local structural seams and is driven in tests by trivial fakes. This file supplies the real ones.
 *
 * ## The singleton is lazy, inert, and SUBSCRIBED
 *
 * Constructing it opens no socket, reads no file and starts no timer. It resolves two sibling
 * singletons (each itself inert) and subscribes to the in-process transcript emitter — because
 * `src/main/cue/index.ts` records what happens when a subsystem is left for a caller to wire: the
 * engine ran in production subscribed to no transcript, a brain with no ears, while every unit test
 * passed. `start()` is therefore called here rather than left to the composition root.
 *
 * Subscribing is not the same as captioning. Captions are OFF by default (Standing Rule 1), so the
 * subscription drops every segment until an operator turns them on, and the caption layer stays
 * blank until then.
 */

import { getAsrService } from '@main/asr'
import { createNullLogger } from '@main/logging/logger'
import { getOverlayServer } from '@main/overlay'
import type { Logger } from '@shared/log'
import type { OverlayCommand } from '@shared/overlay'

import { CaptionService } from './CaptionService'
import type { CaptionAsrLike } from './CaptionService'

export { CaptionService } from './CaptionService'
export type { CaptionAsrLike, CaptionServiceOptions } from './CaptionService'

/*
 * `CaptionRuntimeState`, the text cap, the idle delay and `windowCaptionText` are NOT re-exported
 * here. They live in `@shared/caption` and callers import them from there directly: this barrel is
 * main-process-only, and the renderer — which needs that same state type for its caption controls —
 * must never reach into `@main/*`. Re-exporting them would offer a second import path for a
 * boundary-crossing type, which is how one side ends up on a stale copy.
 */

/** Overrides for {@link getCaptionService}. Every field has a production default. */
export interface GetCaptionServiceOptions {
  /**
   * Where the service's diagnostics go.
   *
   * Defaults to the null logger, because the main process builds its rolling-file logger inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one so a
   * caption that was hidden — and why — is in the service-day log.
   */
  readonly logger?: Logger
  readonly asr?: CaptionAsrLike
  /** Defaults to the process-wide overlay server. */
  readonly send?: (command: OverlayCommand) => void
  readonly now?: () => number
  readonly idleHideMs?: number
}

let singleton: CaptionService | null = null

/**
 * The process-wide caption service.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it.
 */
export function getCaptionService(options: GetCaptionServiceOptions = {}): CaptionService {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()
  const asr = options.asr ?? getAsrService({ logger })
  const send =
    options.send ??
    ((command: OverlayCommand): void => {
      // The server returns a `Result`; a refusal is logged and dropped rather than propagated,
      // because a caption that could not be delivered must never disturb the recogniser feeding it.
      const sent = getOverlayServer({ logger }).send(command)
      if (!sent.ok) {
        logger.warn('the overlay refused a caption command', {
          command: command.name,
          detail: sent.error.message
        })
      }
    })

  const service = new CaptionService({
    asr,
    send,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idleHideMs === undefined ? {} : { idleHideMs: options.idleHideMs })
  })

  const started = service.start()
  if (!started.ok) {
    // A recogniser that cannot be subscribed to leaves a service that captions nothing. That is
    // Standing Rule 1's fallback — the operator runs without captions — not a reason to fail.
    logger.warn('captions could not attach to the transcript', { detail: started.error.message })
  }

  singleton = service
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Disposal releases the transcript subscription and the idle timer. It deliberately leaves the
 * overlay showing whatever it is showing: the service going away is never a reason to change what
 * the congregation can see. The operator's off switch is `setEnabled(false)`.
 */
export function resetCaptionService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
