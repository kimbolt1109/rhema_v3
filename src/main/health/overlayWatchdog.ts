/**
 * The overlay watchdog — the thing that notices the congregation screen lost its overlay.
 *
 * BLUEPRINT.md §9, row 4: *"Overlay browser source crashes → watchdog reloads it; overlay
 * re-syncs state on reconnect."* The re-sync half already exists and is unconditional
 * (`OverlayServer` sends a full snapshot the instant a socket opens). This file is the other
 * half: **noticing**.
 *
 * ## Why noticing is the hard part
 *
 * An OBS Browser Source that crashes does so silently. OBS does not tell anyone, the operator is
 * looking at the congregation, and the first symptom is a service where the lower-third simply
 * never appears again. The only signal available on this side is the attached-client count on the
 * overlay bus, so that count is what this watches.
 *
 * ## The grace period is the whole design
 *
 * A scene change in OBS can destroy and re-create a browser source within a few hundred
 * milliseconds. A watchdog that shouted on every one of those would shout ten times a service,
 * and by the third Sunday the operator would have learned to ignore it — at which point the
 * watchdog is worse than not having one, because it is *believed* to be watching. So a drop only
 * becomes a report if the source is still missing {@link DEFAULT_OVERLAY_GRACE_MS} later, and a
 * source that comes back inside the window is a `debug` line and nothing else.
 *
 * ## What "recovery" can and cannot be
 *
 *  - **Some clients left.** They are told to reload (via {@link OverlayWatchdogTarget.reloadClients}),
 *    and each one that reloads gets the current state back on connect. This is real recovery.
 *  - **No clients left.** There is nobody to tell. Nothing in this process can reach into OBS and
 *    refresh a browser source, so the only correct behaviour is to become **loud**: `down`, an
 *    error in the log naming the exact remedy (in OBS, right-click the Overlays source → Refresh),
 *    and a `stillWorks` line saying the service itself is unaffected. A watchdog that fails
 *    quietly here would let a service run for forty minutes with no lower-thirds.
 *
 * ## Two things this never does
 *
 *  1. **It never clears or rewrites overlay state.** The state cache is precisely what makes a
 *     reloaded browser source come back correct; blanking it as part of "recovery" would turn a
 *     recoverable glitch into a blank congregation screen. The {@link OverlayWatchdogTarget} seam
 *     deliberately exposes no way to send a command, so this is structural rather than careful.
 *  2. **It never touches the stream or the recording.** Not on a drop, not on a reload, not on
 *     shutdown. The overlay layer is independent of the broadcast, which is the entire reason the
 *     overlay is a separate layer at all.
 *
 * Fully injected — overlay seam, timers, clock, logger — so every path is driven in tests with no
 * OBS, no browser and no real timers.
 */

import { initialHealth } from '@shared/health'
import type { HealthLevel, SubsystemHealth } from '@shared/health'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a missing overlay source has to stay missing before it is reported.
 *
 * Six seconds. An OBS scene change re-creates a browser source in well under one; a genuinely
 * crashed source never comes back at all. The cost of the delay is six seconds of an operator not
 * knowing; the cost of removing it is a watchdog nobody believes.
 */
export const DEFAULT_OVERLAY_GRACE_MS = 6_000

/** `stillWorks` for a partial loss: something is still rendering the overlay. */
export const OVERLAY_STILL_WORKS_PARTIAL =
  'the remaining overlay source is still rendering, and the stream and the local recording are untouched'

/** `stillWorks` for a total loss: the service is fine, the overlay layer is not. */
export const OVERLAY_STILL_WORKS_NONE =
  'the stream and the local recording are untouched — the congregation screen still has the camera, just no overlay on top of it'

/** The exact remedy, in the words an operator uses. Repeated in the log and in the health detail. */
export const OVERLAY_OPERATOR_REMEDY =
  'in OBS, right-click the "Overlays" browser source and choose Refresh'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of {@link import('../overlay/OverlayServer').OverlayServerInfo} the watchdog reads.
 *
 * Two fields, so the real server satisfies it structurally and a test double is three lines.
 */
export interface OverlayWatchdogInfo {
  /** Whether the overlay HTTP/WebSocket listener is bound. */
  readonly running: boolean
  /** How many overlay pages (OBS browser sources) are attached right now. */
  readonly clients: number
}

/**
 * The overlay server, as far as the watchdog is concerned.
 *
 * Note what is absent: there is **no `send`**. The watchdog structurally cannot issue an overlay
 * command, so "the watchdog blanked the overlay" is not a bug that can be written here.
 *
 * `OverlayServer` satisfies this as-is apart from the optional {@link reloadClients}, which the
 * health service supplies when it wires the watchdog up.
 */
export interface OverlayWatchdogTarget {
  /** Live server status. Must not throw; the watchdog wraps it anyway. */
  getInfo(): OverlayWatchdogInfo
  /** Subscribe to status changes — this is how a client attach/detach arrives. */
  onInfo(callback: (info: OverlayWatchdogInfo) => void): Unsubscribe
  /**
   * The cached overlay state.
   *
   * Read-only, and read for exactly one reason: to report the revision a reloading browser source
   * will be re-synced to. The watchdog never writes it.
   */
  getState(): { readonly revision: number }
  /**
   * Ask every still-attached overlay page to reload itself.
   *
   * Optional, because the watchdog's primary duty — making the failure visible — must work even
   * when no recovery channel is wired. An implementation MUST NOT clear or alter the state cache:
   * a reloading page re-syncs from it, and an implementation that blanked it first would reload
   * every overlay into a blank screen.
   */
  reloadClients?(): Result<unknown> | Promise<Result<unknown>>
}

/** An opaque timer handle. `Timeout` in Node, `number` in a browser — the watchdog does not care. */
export type OverlayWatchdogTimerHandle = unknown

/** The timer surface, injected so the grace period is deterministic in tests. */
export interface OverlayWatchdogTimers {
  setTimeout(handler: () => void, ms: number): OverlayWatchdogTimerHandle
  clearTimeout(handle: OverlayWatchdogTimerHandle): void
}

/** The real timers. Unref'd: a watchdog must never by itself keep the process alive. */
export const realOverlayWatchdogTimers: OverlayWatchdogTimers = {
  setTimeout: (handler, ms) => {
    const handle = setTimeout(handler, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** Constructor dependencies. Only `overlay` and `logger` are required. */
export interface OverlayWatchdogOptions {
  readonly overlay: OverlayWatchdogTarget
  readonly logger: Logger
  /** Epoch-milliseconds clock. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Timer seam. Defaults to {@link realOverlayWatchdogTimers}. */
  readonly timers?: OverlayWatchdogTimers
  /** Grace period. Defaults to {@link DEFAULT_OVERLAY_GRACE_MS}. Floored at 0. */
  readonly graceMs?: number
  /**
   * The reload channel, supplied as a plain function.
   *
   * Exists so the composition root can wire recovery without wrapping the overlay server in an
   * adapter: `new OverlayWatchdog({ overlay: overlayServer, reload: overlayReload, logger })`.
   * Takes precedence over {@link OverlayWatchdogTarget.reloadClients}. Same rule applies — it must
   * not clear or alter the overlay state cache.
   */
  readonly reload?: () => Result<unknown> | Promise<Result<unknown>>
}

// ---------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------

export class OverlayWatchdog {
  private readonly overlay: OverlayWatchdogTarget
  private readonly log: Logger
  private readonly now: () => number
  private readonly timers: OverlayWatchdogTimers
  private readonly graceMs: number
  private readonly reload: (() => Result<unknown> | Promise<Result<unknown>>) | null

  private health: SubsystemHealth

  /**
   * The most overlay pages seen attached at once, and therefore how many *should* be attached.
   *
   * Learned rather than configured: the operator may run one browser source or three (programme
   * plus a stage display), and nobody is going to type that into a settings panel before a
   * service. Reset deliberately by {@link acknowledge}.
   */
  private expected = 0

  private graceHandle: OverlayWatchdogTimerHandle | null = null
  private droppedAt: number | null = null

  private unsubscribe: Unsubscribe | null = null
  private watching = false
  private disposed = false

  private readonly subscribers = new Set<(health: SubsystemHealth) => void>()

  constructor(options: OverlayWatchdogOptions) {
    this.overlay = options.overlay
    this.log = options.logger.child('overlay-watchdog')
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realOverlayWatchdogTimers
    this.graceMs = Math.max(0, options.graceMs ?? DEFAULT_OVERLAY_GRACE_MS)
    this.reload = options.reload ?? null
    this.health = initialHealth('overlay', this.now())
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the overlay server and evaluate it once, immediately.
   *
   * Idempotent. A server that cannot be subscribed to is reported rather than thrown: a watchdog
   * that fails to attach must say so, because silence from a watchdog reads as "all is well".
   */
  start(): Result<SubsystemHealth> {
    if (this.disposed) return this.disposedError()
    if (this.watching) return ok(this.health)

    try {
      this.unsubscribe = this.overlay.onInfo((info) => {
        this.observe(info)
      })
    } catch (cause) {
      const error = toAppError(cause, ErrorCode.INTERNAL)
      this.log.error('could not subscribe to the overlay server; the watchdog is not watching', {
        message: error.message
      })
      this.setHealth(
        'down',
        'the overlay watchdog could not attach to the overlay server',
        OVERLAY_STILL_WORKS_NONE
      )
      return { ok: false, error }
    }

    this.watching = true
    this.observe(this.readInfo())
    this.log.info('overlay watchdog started', { graceMs: this.graceMs })
    return ok(this.health)
  }

  /**
   * Stop watching. Releases the subscription and any pending grace timer.
   *
   * Stops nothing else: not the overlay server, not the stream, not the recording, and it does not
   * touch the overlay state.
   */
  dispose(): void {
    this.disposed = true
    this.watching = false
    this.cancelGrace()
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    if (unsubscribe !== null) {
      try {
        unsubscribe()
      } catch {
        /* a failing unsubscribe must not fail a shutdown */
      }
    }
    this.subscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The overlay light, exactly as the dashboard should render it. */
  getHealth(): SubsystemHealth {
    return this.health
  }

  /** How many overlay pages the watchdog believes ought to be attached. */
  getExpectedClients(): number {
    return this.expected
  }

  /** Subscribe to health changes. Published only when the level, detail or `stillWorks` moved. */
  onHealth(callback: (health: SubsystemHealth) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Adopt the current client count as the expected one.
   *
   * The escape hatch from a permanent amber light. An operator who deliberately removed a second
   * browser source would otherwise be told "1 of 2 attached" for the rest of the service, and a
   * light that is always amber is a light that gets ignored — which is the failure mode
   * `@shared/health` exists to prevent.
   */
  acknowledge(): Result<SubsystemHealth> {
    if (this.disposed) return this.disposedError()

    const info = this.readInfo()
    this.cancelGrace()
    this.droppedAt = null
    this.expected = info.clients
    this.log.info('the operator acknowledged the current overlay client count', {
      clients: info.clients
    })
    this.evaluate(info, false)
    return ok(this.health)
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Tell every attached overlay page to reload, on the operator's say-so.
   *
   * This is what the `healthReloadOverlays` IPC channel performs. With nothing attached it fails
   * with the remedy in the message rather than pretending to have done something — there is
   * genuinely nothing in this process that can refresh a browser source OBS has lost.
   *
   * Never clears state, never stops an output.
   */
  async reloadNow(): Promise<Result<SubsystemHealth>> {
    if (this.disposed) return this.disposedError()

    const info = this.readInfo()
    if (!info.running) {
      return err(ErrorCode.NOT_CONNECTED, 'the overlay server is not listening')
    }
    if (info.clients === 0) {
      return err(
        ErrorCode.NOT_CONNECTED,
        'no overlay browser source is attached, so there is nothing to reload',
        OVERLAY_OPERATOR_REMEDY
      )
    }

    const reloaded = await this.recover('the operator asked for an overlay reload')
    if (!reloaded.ok) return reloaded
    return ok(this.health)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** `getInfo()` with the boundary wrapped. A server that throws is a server that is not up. */
  private readInfo(): OverlayWatchdogInfo {
    try {
      const info = this.overlay.getInfo()
      if (info === null || typeof info !== 'object') return { running: false, clients: 0 }
      return info
    } catch (cause) {
      this.log.warn('the overlay server threw while reporting its status', {
        message: toAppError(cause, ErrorCode.INTERNAL).message
      })
      return { running: false, clients: 0 }
    }
  }

  /** The cached overlay revision, for reporting only. Never written. */
  private readRevision(): number | null {
    try {
      return this.overlay.getState().revision
    } catch {
      return null
    }
  }

  /** One status update from the overlay server. */
  private observe(info: OverlayWatchdogInfo): void {
    if (this.disposed) return
    this.evaluate(info, true)
  }

  /**
   * Decide what this status means.
   *
   * `allowGrace` is false only when the caller has already waited (the grace timer firing) or has
   * explicitly re-baselined ({@link acknowledge}).
   */
  private evaluate(info: OverlayWatchdogInfo, allowGrace: boolean): void {
    if (!info.running) {
      this.cancelGrace()
      this.setHealth(
        'down',
        'the overlay server is not listening, so no browser source can attach',
        OVERLAY_STILL_WORKS_NONE
      )
      return
    }

    if (info.clients > this.expected) this.expected = info.clients

    // Nothing has ever attached. On a machine where OBS is not set up yet this is the resting
    // state, not a fault — `not-configured`, never amber (see `@shared/health`).
    if (this.expected === 0) {
      this.cancelGrace()
      this.setHealth('not-configured', 'no overlay browser source has connected yet', null)
      return
    }

    if (info.clients >= this.expected) {
      if (this.graceHandle !== null) {
        this.log.debug('an overlay source came back inside the grace period; no alarm raised', {
          clients: info.clients,
          graceMs: this.graceMs
        })
      }
      this.cancelGrace()
      this.droppedAt = null
      this.setHealth('ok', describeAttached(info.clients), null)
      return
    }

    // Fewer sources than we have seen: something dropped.
    //
    // Once the shortfall has been surfaced, later changes are reported immediately — the operator
    // is already looking at a red or amber light, so there is nothing left to protect them from —
    // but recovery is NOT re-attempted on every status change, which would be a reload storm.
    const alreadySurfaced = this.health.level === 'degraded' || this.health.level === 'down'
    if (alreadySurfaced || !allowGrace) {
      this.surface(info, !alreadySurfaced)
      return
    }

    if (this.graceHandle !== null) return

    this.droppedAt = this.now()
    this.log.info('an overlay source dropped; waiting out the grace period before reporting it', {
      clients: info.clients,
      expected: this.expected,
      graceMs: this.graceMs
    })
    this.armGrace()
  }

  private armGrace(): void {
    this.cancelGrace()
    if (this.graceMs === 0) {
      this.onGraceExpired()
      return
    }
    try {
      this.graceHandle = this.timers.setTimeout(() => {
        this.graceHandle = null
        this.onGraceExpired()
      }, this.graceMs)
    } catch (cause) {
      // A watchdog that cannot arm its own timer must fail LOUD, not silently stop watching.
      this.log.warn('could not arm the overlay grace timer; reporting the drop immediately', {
        message: toAppError(cause, ErrorCode.INTERNAL).message
      })
      this.graceHandle = null
      this.onGraceExpired()
    }
  }

  private cancelGrace(): void {
    const handle = this.graceHandle
    this.graceHandle = null
    if (handle === null) return
    try {
      this.timers.clearTimeout(handle)
    } catch {
      /* a failing clear must not fail an evaluation */
    }
  }

  /** The grace period elapsed. Re-read rather than trust the status that started the clock. */
  private onGraceExpired(): void {
    if (this.disposed) return
    this.evaluate(this.readInfo(), false)
  }

  /**
   * Report a confirmed shortfall — and attempt recovery when there is anyone left to talk to.
   *
   * The health is set BEFORE the reload is attempted, so the operator sees the problem even if the
   * recovery hangs or fails.
   */
  private surface(info: OverlayWatchdogInfo, attemptRecovery: boolean): void {
    const missingForMs = this.droppedAt === null ? null : Math.max(0, this.now() - this.droppedAt)
    const revision = this.readRevision()

    if (info.clients === 0) {
      this.setHealth(
        'down',
        `no overlay browser source is attached — ${OVERLAY_OPERATOR_REMEDY}`,
        OVERLAY_STILL_WORKS_NONE
      )
      this.log.error(
        `THE OVERLAY IS GONE from the congregation screen — ${OVERLAY_OPERATOR_REMEDY}. The stream and the local recording are unaffected.`,
        { expected: this.expected, missingForMs, revision }
      )
      return
    }

    this.setHealth(
      'degraded',
      `${String(info.clients)} of ${String(this.expected)} overlay sources attached`,
      OVERLAY_STILL_WORKS_PARTIAL
    )
    this.log.warn('an overlay browser source is missing', {
      clients: info.clients,
      expected: this.expected,
      missingForMs,
      revision
    })
    if (attemptRecovery) {
      void this.recover('an overlay browser source dropped')
    }
  }

  /**
   * Ask the still-attached pages to reload.
   *
   * A reloading page re-syncs from the server's state cache on connect, which is why nothing here
   * touches that cache. With no reload seam wired this is a no-op success: the health report has
   * already done the important half of the job.
   */
  private async recover(reason: string): Promise<Result<void>> {
    const injected = this.reload
    const onTarget = this.overlay.reloadClients
    if (injected === null && onTarget === undefined) {
      this.log.info('no overlay reload seam is wired; reporting only', { reason })
      return ok(undefined)
    }

    const revisionBefore = this.readRevision()
    try {
      const outcome =
        injected !== null ? await injected() : await onTarget?.call(this.overlay)
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, 'the overlay reload did not return a Result')
      }
      if (!outcome.ok) {
        this.log.warn('the overlay reload was refused', {
          reason,
          message: outcome.error.message
        })
        return { ok: false, error: outcome.error }
      }
      this.log.info('asked the attached overlay sources to reload', {
        reason,
        // The revision must be identical afterwards: a reload re-syncs FROM the cache.
        revision: revisionBefore
      })
      return ok(undefined)
    } catch (cause) {
      const error = toAppError(cause, ErrorCode.INTERNAL)
      this.log.warn('the overlay reload threw', { reason, message: error.message })
      return { ok: false, error }
    }
  }

  /** Update the light, keeping `since` pinned to when this LEVEL was entered. */
  private setHealth(level: HealthLevel, detail: string, stillWorks: string | null): void {
    const previous = this.health
    if (
      previous.level === level &&
      previous.detail === detail &&
      previous.stillWorks === stillWorks
    ) {
      return
    }

    this.health = {
      id: 'overlay',
      level,
      detail,
      stillWorks,
      since: previous.level === level ? previous.since : this.now()
    }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.health
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('an overlay health subscriber threw', {
          message: toAppError(cause, ErrorCode.INTERNAL).message
        })
      }
    }
  }

  private disposedError(): Result<SubsystemHealth> {
    return err(ErrorCode.INTERNAL, 'the overlay watchdog has been disposed')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `ok` detail line, in the words the operator needs: how many are attached. */
function describeAttached(clients: number): string {
  return clients === 1
    ? '1 overlay browser source attached'
    : `${String(clients)} overlay browser sources attached`
}
