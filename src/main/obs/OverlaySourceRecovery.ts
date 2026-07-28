/**
 * Refresh an OBS browser source that is showing a dead overlay page.
 *
 * ## The failure this exists for
 *
 * A browser source loads its URL when OBS creates it — at OBS startup. `START.bat` starts the
 * bundled OBS *before* Verger, because Verger reads OBS's settings at launch and wants them
 * present. So the overlay server is not listening when the page loads, the request is refused,
 * and the source sits on an error page forever: `restart_when_active` is deliberately **off**, so
 * that a camera cut does not re-animate every layer, which also means a scene change will never
 * reload it. The same thing happens whenever the operator had OBS open before starting Verger.
 *
 * The result is the worst shape a fault can take. OBS reports connected. Verger reports connected.
 * The operator sees two green lights and nothing reaches the congregation screen. Measured with
 * `netstat`: no `obs-browser-page` connection to the overlay port existed at all, and one forced
 * `refreshnocache` produced two established sockets immediately.
 *
 * `overlayWatchdog` does not catch this one. Its alarm is a *drop* — it needs a client to have
 * attached and then gone. Here nothing ever attaches, so `expected` stays 0 and it correctly
 * reports `not-configured` rather than crying wolf on a machine where OBS is not set up. That is
 * the right call for the watchdog and the reason this is a separate object.
 *
 * ## Why this is safe to do automatically
 *
 * The refresh fires only when **all** of these hold:
 *
 *   1. the overlay server is listening — otherwise a refresh would just re-load a refused page;
 *   2. it has **zero** attached clients — a healthy overlay is never touched, which is what keeps
 *      this from re-animating a lower-third mid-service;
 *   3. the state has held still for {@link DEFAULT_RECOVERY_GRACE_MS} — a scene change destroys and
 *      re-creates a source in well under a second, and refreshing into that race would be noise;
 *   4. OBS is reachable — `call` returns `NOT_CONNECTED` and we simply wait, rather than treating a
 *      closed OBS as a failure worth escalating.
 *
 * And it only ever refreshes a browser source whose URL points at **our own overlay port**. A
 * browser source showing a countdown, a chat widget or anything else in the same scene is not ours
 * to reload.
 *
 * ## What it never does
 *
 * It issues no `Set*`, starts and stops no output, and never touches the overlay state cache — a
 * refreshed page re-syncs from that cache on connect, which is the whole reason it works. Standing
 * Rule 2 holds: the only OBS mutation is pressing the same button an operator would press.
 */

import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long the overlay must sit at zero clients before a refresh is attempted.
 *
 * Four seconds. Long enough that an OBS scene change re-creating a source is never mistaken for a
 * dead page; short enough that a service starting up is fixed before anyone is on camera.
 */
export const DEFAULT_RECOVERY_GRACE_MS = 4_000

/**
 * How long to wait before trying again after a refresh that did not bring a client back.
 *
 * Thirty seconds. If the first refresh did not work, the cause is usually structural — no browser
 * source in this scene collection, or a URL pointing somewhere else — and hammering
 * `refreshnocache` every four seconds would put a visible flicker on the congregation screen for
 * the whole service.
 */
export const DEFAULT_RECOVERY_COOLDOWN_MS = 30_000

/** OBS's identifier for a browser source. Stable across OBS 28–32 on Windows. */
export const OBS_BROWSER_INPUT_KIND = 'browser_source'

/** The properties button OBS itself labels "Refresh cache of current page". */
export const OBS_REFRESH_BUTTON = 'refreshnocache'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The slice of `ObsClient` this needs: one request verb that cannot throw. */
export interface OverlayRecoveryObs {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Result<unknown>>
}

/** The slice of `OverlayServer` this needs — the watchdog's two fields, plus the bound port. */
export interface OverlayRecoveryInfo {
  readonly running: boolean
  readonly clients: number
  /**
   * The port actually bound, when the server reports it.
   *
   * Preferred over the configured {@link OverlaySourceRecoveryOptions.overlayPort}: if 7320 was
   * taken and the server fell back, the browser source we must match is the one naming the port
   * OBS was actually given, not the one we asked for.
   */
  readonly port?: number
}

/** The overlay server, as far as this is concerned. Note there is no `send`. */
export interface OverlayRecoveryTarget {
  getInfo(): OverlayRecoveryInfo
  onInfo(callback: (info: OverlayRecoveryInfo) => void): Unsubscribe
}

/** Timer seam, so the grace and cooldown are deterministic in tests. */
export interface OverlayRecoveryTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realOverlayRecoveryTimers: OverlayRecoveryTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

export interface OverlaySourceRecoveryOptions {
  readonly obs: OverlayRecoveryObs
  readonly overlay: OverlayRecoveryTarget
  /** The port the overlay server is bound to. Only sources whose URL names it are refreshed. */
  readonly overlayPort: number
  readonly logger: Logger
  readonly timers?: OverlayRecoveryTimers
  readonly now?: () => number
  readonly graceMs?: number
  readonly cooldownMs?: number
}

// ---------------------------------------------------------------------------
// Shapes returned by OBS, narrowed defensively
// ---------------------------------------------------------------------------

function inputNamesOfKind(payload: unknown, kind: string): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const inputs = (payload as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs)) return []
  const names: string[] = []
  for (const entry of inputs) {
    if (entry === null || typeof entry !== 'object') continue
    const { inputName, inputKind } = entry as { inputName?: unknown; inputKind?: unknown }
    if (typeof inputName === 'string' && inputKind === kind) names.push(inputName)
  }
  return names
}

function urlOfSettings(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const settings = (payload as { inputSettings?: unknown }).inputSettings
  if (settings === null || typeof settings !== 'object') return ''
  const url = (settings as { url?: unknown }).url
  return typeof url === 'string' ? url : ''
}

// ---------------------------------------------------------------------------
// The recovery
// ---------------------------------------------------------------------------

export class OverlaySourceRecovery {
  private readonly obs: OverlayRecoveryObs
  private readonly overlay: OverlayRecoveryTarget
  private readonly overlayPort: number
  private readonly log: Logger
  private readonly timers: OverlayRecoveryTimers
  private readonly now: () => number
  private readonly graceMs: number
  private readonly cooldownMs: number

  private unsubscribe: Unsubscribe | null = null
  private graceHandle: unknown = null
  private lastAttemptAt: number | null = null
  private inFlight = false
  private disposed = false

  constructor(options: OverlaySourceRecoveryOptions) {
    this.obs = options.obs
    this.overlay = options.overlay
    this.overlayPort = options.overlayPort
    this.log = options.logger
    this.timers = options.timers ?? realOverlayRecoveryTimers
    this.now = options.now ?? ((): number => Date.now())
    this.graceMs = Math.max(0, options.graceMs ?? DEFAULT_RECOVERY_GRACE_MS)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS)
  }

  /** Begin watching. Idempotent. */
  start(): Result<void> {
    if (this.disposed) return err(ErrorCode.INTERNAL, 'the overlay source recovery was disposed')
    if (this.unsubscribe !== null) return ok(undefined)

    try {
      this.unsubscribe = this.overlay.onInfo((info) => {
        this.observe(info)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to the overlay server; automatic refresh is off', { cause })
      return err(ErrorCode.INTERNAL, 'could not subscribe to the overlay server')
    }

    this.observe(this.readInfo())
    this.log.info('overlay source auto-refresh armed', {
      overlayPort: this.overlayPort,
      graceMs: this.graceMs
    })
    return ok(undefined)
  }

  dispose(): void {
    this.disposed = true
    this.cancelGrace()
    const off = this.unsubscribe
    this.unsubscribe = null
    if (off !== null) {
      try {
        off()
      } catch {
        // Unsubscribing must never be the thing that breaks shutdown.
      }
    }
  }

  private readInfo(): OverlayRecoveryInfo {
    try {
      return this.overlay.getInfo()
    } catch {
      return { running: false, clients: 0 }
    }
  }

  private observe(info: OverlayRecoveryInfo): void {
    if (this.disposed) return

    // A client is attached: the overlay is alive. Cancel anything pending and forget the cooldown,
    // so a genuine crash later gets an immediate first attempt rather than inheriting a stale one.
    if (!info.running || info.clients > 0) {
      this.cancelGrace()
      if (info.clients > 0) this.lastAttemptAt = null
      return
    }

    if (this.graceHandle !== null || this.inFlight) return

    this.graceHandle = this.timers.setTimeout(() => {
      this.graceHandle = null
      void this.attempt()
    }, this.graceMs)
  }

  private cancelGrace(): void {
    if (this.graceHandle === null) return
    this.timers.clearTimeout(this.graceHandle)
    this.graceHandle = null
  }

  /**
   * Refresh every browser source pointing at our overlay port.
   *
   * Exposed so the composition root, a future IPC handler, or a test can drive it directly. Returns
   * how many sources were refreshed — zero is a legitimate answer meaning "OBS has no source of
   * ours", not an error.
   */
  async refreshNow(): Promise<Result<number>> {
    if (this.disposed) return err(ErrorCode.INTERNAL, 'the overlay source recovery was disposed')

    const list = await this.obs.call('GetInputList')
    if (!list.ok) return err(list.error.code, list.error.message)

    const names = inputNamesOfKind(list.value, OBS_BROWSER_INPUT_KIND)
    if (names.length === 0) return ok(0)

    // Match on the port rather than the whole URL: the overlay is reachable as 127.0.0.1 or
    // localhost, with or without a trailing path, and a source the operator retyped by hand is
    // still ours if it names our port.
    const marker = `:${String(this.readInfo().port ?? this.overlayPort)}`
    let refreshed = 0

    for (const inputName of names) {
      const settings = await this.obs.call('GetInputSettings', { inputName })
      if (!settings.ok) continue
      if (!urlOfSettings(settings.value).includes(marker)) continue

      const pressed = await this.obs.call('PressInputPropertiesButton', {
        inputName,
        propertyName: OBS_REFRESH_BUTTON
      })
      if (pressed.ok) {
        refreshed += 1
        this.log.info('refreshed a stale overlay browser source in OBS', { inputName })
      } else {
        this.log.warn('could not refresh an overlay browser source', {
          inputName,
          detail: pressed.error.message
        })
      }
    }

    return ok(refreshed)
  }

  private async attempt(): Promise<void> {
    if (this.disposed || this.inFlight) return

    const info = this.readInfo()
    if (!info.running || info.clients > 0) return

    const last = this.lastAttemptAt
    if (last !== null && this.now() - last < this.cooldownMs) {
      // Still dark, but too soon to press again. Re-arm rather than returning: nothing else will
      // wake us if the overlay simply stays at zero clients and the server emits no further info,
      // and going silent here would mean one failed refresh disables recovery for the service.
      this.observe(info)
      return
    }

    this.inFlight = true
    try {
      const outcome = await this.refreshNow()
      if (!outcome.ok) {
        // NOT_CONNECTED is the ordinary case of OBS simply not being up yet. Not a fault, and not
        // worth a warning every four seconds on a machine with no OBS at all.
        if (outcome.error.code !== ErrorCode.NOT_CONNECTED) {
          this.log.warn('the overlay source refresh failed', { detail: outcome.error.message })
        }
        return
      }
      this.lastAttemptAt = this.now()
      if (outcome.value === 0) {
        this.log.info('no OBS browser source points at the overlay; nothing to refresh', {
          overlayPort: this.overlayPort
        })
      }
    } catch (cause) {
      this.log.warn('the overlay source refresh threw, which it is contracted not to', { cause })
    } finally {
      this.inFlight = false
      // Re-arm if we are still dark, so a refresh that did not take is retried after the cooldown.
      this.observe(this.readInfo())
    }
  }
}
