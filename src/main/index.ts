/**
 * Verger main-process entry point — app lifecycle only.
 *
 * Responsibilities, in order:
 *  1. Single-instance lock (a second launch focuses the running booth window; two copies
 *     fighting over one OBS connection is a service-day failure mode).
 *  2. Crash capture wired before anything else, so a failure during startup is still
 *     recorded.
 *  3. On `ready`: load config → create the logger → build the OBS client → register IPC →
 *     create the window.
 *  4. Dispose IPC on quit.
 *
 * Standing Rule 2: this process owns *none* of OBS's state. Nothing here connects,
 * commands, or reconciles OBS — the OBS module reads OBS's current state and reports it.
 * If Verger dies, OBS keeps streaming and recording, and the next launch simply
 * re-observes.
 *
 * Standing Rule 5: no missing config is fatal. Every subsystem reports "not configured"
 * and the app still launches.
 */

import { join } from 'node:path'

import { BrowserWindow, app } from 'electron'

import { loadConfigFromDisk, summarize } from '@main/config/env'
import type { AppConfig } from '@main/config/env'
import { createLogger } from '@main/logging/logger'
import type { Logger } from '@main/logging/logger'
import { registerIpc } from '@main/ipc/register'
import { getGoLiveService } from '@main/golive'
import { getCheckpointStore, getHealthService, resetHealthService } from '@main/health'
import { OverlayWatchdog } from '@main/health/overlayWatchdog'
import { getObsClient } from '@main/obs'
import { getOverlayServer } from '@main/overlay'
import { getYouTubeService } from '@main/youtube'
import { createMainWindow } from '@main/window'
import { ErrorCode, err } from '@shared/result'
import type { Result } from '@shared/result'

let logger: Logger | null = null
let disposeIpc: (() => void) | null = null
let mainWindow: BrowserWindow | null = null
let overlayServer: ReturnType<typeof getOverlayServer> | null = null
let disposeServices: (() => void) | null = null

// ---------------------------------------------------------------------------
// Crash capture — installed immediately, before `ready`
// ---------------------------------------------------------------------------

/**
 * Until the real logger exists (it needs `app.getPath('userData')`, which is only valid
 * once Electron has initialised its paths) startup failures still have to land somewhere.
 */
function report(level: 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
  const active = logger
  if (active !== null) {
    if (level === 'error') active.error(message, fields)
    else active.warn(message, fields)
    return
  }
  // Pre-logger fallback: `app.getPath('userData')` is not usable yet, so there is
  // nowhere else for a startup crash to go.
  console.error(`[verger] ${message}`, fields)
}

process.on('uncaughtException', (cause: Error) => {
  report('error', 'uncaught exception in the main process', { cause })
})

process.on('unhandledRejection', (cause: unknown) => {
  report('error', 'unhandled promise rejection in the main process', { cause })
})

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow
    if (window === null) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(onReady, (cause: unknown) => {
    report('error', 'the app failed to become ready', { cause })
  })

  app.on('window-all-closed', () => {
    // Windows/Linux: closing the booth window is quitting. macOS keeps the app alive by
    // platform convention.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && logger !== null) {
      mainWindow = createMainWindow({ logger })
    }
  })

  app.on('will-quit', () => {
    const dispose = disposeIpc
    disposeIpc = null
    if (dispose !== null) {
      try {
        dispose()
      } catch (cause) {
        report('warn', 'failed to dispose IPC handlers on quit', { cause })
      }
    }

    // Release the watchdog timer, the health aggregator's subscriptions and the checkpoint
    // store's. Every one of those is a listener or a timer and nothing else: disposing them
    // stops no output, blanks no overlay and rewinds nothing. Quitting Verger is not a reason
    // for a service to change.
    const disposeAll = disposeServices
    disposeServices = null
    if (disposeAll !== null) {
      try {
        disposeAll()
      } catch (cause) {
        report('warn', 'failed to dispose the health services on quit', { cause })
      }
    }

    // Release port 7320 so the next launch can bind it. Fire-and-forget: `will-quit` does not
    // await, and holding up the quit for a socket close would be worse than a late close.
    const overlay = overlayServer
    overlayServer = null
    if (overlay !== null) {
      void overlay.stop()
    }

    logger?.info('verger is shutting down')
  })
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function onReady(): void {
  const config: AppConfig = loadConfigFromDisk()

  const log = createLogger({
    directory: join(app.getPath('userData'), 'logs'),
    level: app.isPackaged ? 'info' : 'debug',
    mirrorToConsole: !app.isPackaged
  })
  logger = log

  // Key names and booleans only — `summarize` cannot carry a secret value.
  log.info('verger starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    packaged: app.isPackaged,
    config: summarize(config)
  })
  for (const warning of config.warnings) {
    log.warn('configuration warning', { key: warning.key, detail: warning.message })
  }

  const services = composeServices(log)
  disposeServices = services.dispose

  disposeIpc = toDisposer(
    registerIpc({
      config,
      logger: log,
      obs: services.obs,
      overlay: services.overlay,
      youtube: services.youtube,
      goLive: services.goLive,
      health: services.health,
      checkpoints: services.checkpoints,
      overlayReload: services.overlayReload
    })
  )

  mainWindow = createMainWindow({ logger: log })
}

/** Everything `composeServices` builds, wired and already running. */
interface ComposedServices {
  readonly obs: ReturnType<typeof getObsClient>
  readonly overlay: ReturnType<typeof getOverlayServer>
  readonly youtube: ReturnType<typeof getYouTubeService>
  readonly goLive: ReturnType<typeof getGoLiveService>
  readonly health: ReturnType<typeof getHealthService>
  readonly checkpoints: ReturnType<typeof getCheckpointStore>
  readonly overlayReload: OverlayWatchdog
  /** Release the listeners and timers this composition started. Stops no output, ever. */
  readonly dispose: () => void
}

/**
 * Build every long-lived subsystem and — the part that matters — **connect** it.
 *
 * ## Why this function is written out at this length
 *
 * STATUS.md records the same defect in four separate phases, and all four landed in this file or
 * in a file exactly like it:
 *
 *  - Phase 2: the overlay server was constructed and never `start()`ed, so port 7320 was never
 *    bound and OBS's browser source had nothing to load.
 *  - Phase 4: the Google session was never restored at launch, so a perfectly good stored refresh
 *    token read as "signed out" every Sunday.
 *  - Phase 5: the go-live re-attach never ran, so a relaunch mid-service would have pushed a
 *    SECOND stream and started a SECOND recording.
 *  - Phase 8: the cue engine had no transcript source and no scripture detector — a brain with
 *    neither ears nor eyes.
 *
 * Every one of those passed every unit test, because unit tests inject their own fakes. The only
 * thing that catches a component wired to nothing is a file that says out loud what it starts.
 *
 * ## What is STARTED here, and why each one has to be
 *
 *  1. **The OBS client** — observes OBS. It imposes nothing (Standing Rule 2).
 *  2. **The overlay HTTP + WebSocket server** — `start()`, not just `new`. Nothing binds 127.0.0.1
 *     :7320 otherwise and the congregation screen has no overlay layer at all.
 *  3. **The YouTube session refresh** — the OAuth service starts `signed-out` even when a refresh
 *     token IS stored, because its constructor cannot await the secrets store.
 *  4. **The go-live re-attach** — reads OBS's REAL output state and adopts it, issuing no `Start*`
 *     of any kind. This is the "control app crashes" row of BLUEPRINT.md §9.
 *  5. **The health aggregator** — subscribes to all six subsystems as part of construction, so the
 *     dashboard is live before the window exists. Nothing here has to remember to `start()` it.
 *  6. **The checkpoint store** — watches the cue engine for fired cues, so CTRL+D recovery has
 *     something to rewind to.
 *  7. **The overlay watchdog** — `start()`ed, watching for a browser source that has gone away.
 *
 * ## What is deliberately NOT here
 *
 * No `StartStream`, no `StartRecord`, no `StopStream`, no `StopRecord`, no scene change, no
 * overlay command. Launching Verger changes nothing about a service that is already running, and
 * quitting it changes nothing either. That is the whole architecture (Standing Rule 2): if Verger
 * dies mid-service, OBS keeps streaming and recording, and the next launch re-observes.
 *
 * Every step is fire-and-forget where it touches the network or OBS. A subsystem that cannot start
 * degrades visibly and never blocks the app (Standing Rule 5) — the window opens either way, and
 * the operator can still drive OBS by hand.
 */
function composeServices(log: Logger): ComposedServices {
  const obs = getObsClient({ logger: log })

  // The overlay server must be STARTED here, not merely constructed. OBS loads the overlay as
  // a browser source over http://127.0.0.1:7320/overlay, so if nothing binds that port the
  // congregation screen has no overlay layer at all — the whole point of Phase 2. Every unit
  // test passed with this line missing, which is exactly why it is called out.
  const overlay = getOverlayServer({ logger: log })
  overlayServer = overlay
  void overlay.start().then((result) => {
    if (result.ok) {
      log.info('overlay server listening', {
        pageUrl: result.value.pageUrl,
        host: result.value.host,
        port: result.value.port
      })
    } else {
      // Standing Rule 5: a subsystem that cannot start degrades visibly and never blocks the
      // app. The Overlay panel renders this as "server stopped" with the error.
      log.error('overlay server failed to start', {
        code: result.error.code,
        detail: result.error.message
      })
    }
  })

  // Restore the Google session at startup, fire-and-forget.
  //
  // The OAuth service starts in `signed-out` even when a refresh token IS stored, because the
  // constructor cannot await the secrets store. Without this call the Go Live screen would read
  // "signed out" on every launch until something happened to touch the API — the operator would
  // be told to sign in again every Sunday despite a perfectly good stored token.
  //
  // With an empty .env this short-circuits at `not-configured` and makes no network call, so it
  // costs nothing on an unconfigured machine (Standing Rule 5).
  const youtube = getYouTubeService({ logger: log })
  void youtube.refresh().then((result) => {
    if (!result.ok && result.error.code !== ErrorCode.NOT_CONFIGURED) {
      log.warn('could not restore the YouTube session at startup', {
        code: result.error.code,
        detail: result.error.message
      })
    }
  })

  // Re-attach to a service that is ALREADY RUNNING (Standing Rule 2, BLUEPRINT.md §9).
  //
  // If Verger crashed or was restarted mid-service, OBS kept streaming and recording. Launching
  // without this check means the operator presses GO LIVE, Verger sees nothing in progress, and
  // pushes a SECOND stream and starts a SECOND recording — the worst possible outcome during a
  // live, un-repeatable event. `initialize()` reads OBS's real output state and adopts it,
  // issuing no Start* of any kind.
  //
  // Fire-and-forget: OBS may not be connected yet, in which case this reports nothing in
  // progress and the operator starts normally.
  const goLive = getGoLiveService({ logger: log })
  void goLive.initialize().then((result) => {
    if (result.ok && result.value.reattached) {
      log.warn('re-attached to a broadcast already in progress', {
        phase: result.value.phase,
        streaming: result.value.obs.streaming,
        recording: result.value.obs.recording
      })
    }
  })

  // The health aggregator and the checkpoint store (BLUEPRINT.md §9).
  //
  // Both are constructed AFTER the four subsystems above, on purpose: each of those is a lazy
  // singleton, so by the time `getHealthService()` reaches for them they already exist and already
  // hold the real rolling-file logger. Constructing health first would build them with the null
  // logger and nothing on a service day would be written down.
  //
  // Neither needs a `start()` call here — both subscribe as part of construction, because "a
  // caller must remember" is exactly how the four defects above happened.
  const health = getHealthService({ logger: log })
  const checkpoints = getCheckpointStore({ logger: log })

  // The overlay watchdog — the "overlay browser source crashes" row of BLUEPRINT.md §9.
  //
  // It watches the attached browser-source count and surfaces a dropped source as a subsystem
  // light. Its recovery half is wired through `reload` below rather than through the server's
  // optional `reloadClients`, because this build's overlay server has no client-reload channel:
  // its public surface is start/stop/send/getState/getInfo and nothing more. Rather than let the
  // watchdog report a reload that never happened, the seam says so, and the operator gets an
  // actionable remedy instead of a false success. When the overlay server grows a real reload,
  // this is the one line that changes.
  //
  // Note what the watchdog cannot do: it holds only the overlay server and a timer. It has no OBS
  // client, no output verb, and no way to reach the stream or the recording — a watchdog that
  // could take a service off the air while "recovering" would be far worse than a blank overlay.
  const overlayReload = new OverlayWatchdog({
    overlay,
    logger: log,
    reload: (): Result<never> =>
      err(
        ErrorCode.NOT_CONFIGURED,
        'this build has no overlay reload channel',
        'refresh the browser source in OBS — the overlay re-syncs from the cached state on reconnect'
      )
  })
  const watchdogStarted = overlayReload.start()
  if (watchdogStarted.ok) {
    log.info('overlay watchdog started', {
      level: watchdogStarted.value.level,
      detail: watchdogStarted.value.detail
    })
  } else {
    // Standing Rule 5. A watchdog that will not start costs the operator an early warning, not a
    // service: the overlay server, the stream and the recording are all untouched by this.
    log.warn('the overlay watchdog did not start; overlay drops will not be flagged early', {
      code: watchdogStarted.error.code,
      detail: watchdogStarted.error.message
    })
  }

  return {
    obs,
    overlay,
    youtube,
    goLive,
    health,
    checkpoints,
    overlayReload,
    dispose: () => {
      // Listeners and timers only. Not one of these three calls can stop an output — see
      // `resetHealthService` and `OverlayWatchdog.dispose`.
      overlayReload.dispose()
      resetHealthService()
    }
  }
}

/**
 * Accepts whatever the IPC registration returns — a disposer function, an object with a
 * `dispose()` method, or nothing at all — and normalises it to a disposer or `null`.
 */
function toDisposer(value: unknown): (() => void) | null {
  if (typeof value === 'function') {
    return value as () => void
  }
  if (typeof value === 'object' && value !== null) {
    const dispose = (value as { dispose?: unknown }).dispose
    if (typeof dispose === 'function') {
      return () => {
        ;(dispose as () => void).call(value)
      }
    }
  }
  return null
}
