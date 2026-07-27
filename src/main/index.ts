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

import { dirname, join } from 'node:path'

import { BrowserWindow, app } from 'electron'

import { loadConfigFromDisk, summarize } from '@main/config/env'
import type { AppConfig } from '@main/config/env'
import { loadPortableConfig, resolveConfiguredPlanPath } from '@main/config/portable'
import type { PortableConfigResult } from '@main/config/portable'
import { createLogger } from '@main/logging/logger'
import type { Logger } from '@main/logging/logger'
import { registerIpc } from '@main/ipc/register'
import { getGoLiveService } from '@main/golive'
import { getCheckpointStore, getHealthService, resetHealthService } from '@main/health'
import { OverlayWatchdog } from '@main/health/overlayWatchdog'
import { getObsClient } from '@main/obs'
import { isObsPortListening, readObsWebsocketConfig } from '@main/obs/localConfig'
import { getOverlayServer } from '@main/overlay'
import { getPlanService } from '@main/plan'
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

/** What discovery did, for one honest log line and for the connect decision below. */
interface DiscoveredObs {
  readonly outcome: 'filled' | 'already-configured' | 'server-disabled' | 'unavailable'
  readonly detail: string
  /** Present only when OBS's server is switched on, so a caller knows dialling is worthwhile. */
  readonly reachable: boolean
  /** OBS's port when known, so the launch path can probe it before arming a reconnect loop. */
  readonly port: number | null
}

/**
 * Supply missing OBS settings from OBS's own config file. Mutates `env` in place, secrets included.
 *
 * Exported nowhere and deliberately small: it decides precedence and nothing else, so the rule
 * "the operator's explicit value always wins" is readable in one screen.
 */
function applyDiscoveredObsSettings(env: NodeJS.ProcessEnv): DiscoveredObs {
  const url = env['OBS_WEBSOCKET_URL']
  const password = env['OBS_WEBSOCKET_PASSWORD']
  // A URL AND a non-empty password is a complete hand-configuration; leave it entirely alone.
  const alreadyComplete =
    url !== undefined && url.length > 0 && password !== undefined && password.length > 0
  if (alreadyComplete) {
    return {
      outcome: 'already-configured',
      detail: 'config.json or .env already names an OBS URL and password; discovery skipped',
      reachable: true,
      // Unknown by design: the operator's URL may point at another machine entirely, so there is no
      // local port to probe. The launch connect is skipped and they press Connect, exactly as before.
      port: null,
    }
  }

  const found = readObsWebsocketConfig()
  if (!found.ok) {
    return { outcome: 'unavailable', detail: found.error.message, reachable: false, port: null }
  }

  const obs = found.value
  if (url === undefined || url.length === 0) {
    // Just the port. `normalizeObsUrl` in `env.ts` turns a bare port into `ws://127.0.0.1:<port>` —
    // reusing that rather than assembling a URL here means discovery and a hand-pasted OBS "Port"
    // box travel through exactly the same tested path.
    env['OBS_WEBSOCKET_URL'] = String(obs.port)
  }
  // Only when OBS actually wants one. Writing a stale password from OBS's file while OBS has auth
  // switched off would turn a working no-auth setup into a rejected handshake.
  if ((password === undefined || password.length === 0) && obs.authRequired) {
    env['OBS_WEBSOCKET_PASSWORD'] = obs.password
  }

  if (!obs.serverEnabled) {
    return {
      outcome: 'server-disabled',
      detail:
        'OBS’s WebSocket server is switched OFF in OBS (Tools → WebSocket Server Settings). Settings were read, but nothing is listening.',
      reachable: false,
      port: obs.port,
    }
  }

  return {
    outcome: 'filled',
    detail: `read from OBS’s own settings at ${obs.sourcePath}`,
    reachable: true,
    port: obs.port,
  }
}

function onReady(): void {
  // Resolve the operator's external config.json (next to the launcher) FIRST, so its OBS values are
  // in the environment before dotenv runs and before anything reads config. In a dev run this is
  // inert — it manages no file and applies no overrides, so the `.env` flow is byte-for-byte the
  // same. See src/main/config/portable.ts.
  const portable = loadPortableConfig({
    isPackaged: app.isPackaged,
    exeDir: dirname(app.getPath('exe'))
  })
  for (const [key, value] of Object.entries(portable.envOverrides)) {
    // config.json is the source of truth for OBS in a portable build. Setting it here — before
    // dotenv runs — means a stray .env cannot override it, because dotenv never overwrites a
    // variable that is already set.
    process.env[key] = value
  }

  // Fill any GAP in the OBS settings from OBS's own obs-websocket config file, before anything reads
  // config. This is the step that removes the "type the password twice" procedure: OBS already knows
  // its port and password, so asking the operator to copy them into config.json and then again into
  // the Connection screen was three chances to typo one string on a Sunday morning.
  //
  // Precedence is deliberate: whatever the operator set explicitly WINS, and discovery only supplies
  // what is missing. An empty password means "not configured" under Standing Rule 5, which is exactly
  // the case worth filling. A wrong guess here would be worse than the friction it removes.
  const discovered = applyDiscoveredObsSettings(process.env)

  const config: AppConfig =
    portable.envFilePath !== null
      ? loadConfigFromDisk({ envFilePath: portable.envFilePath })
      : loadConfigFromDisk()

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

  // Where the config came from — safe fields only. NEVER log `portable.envOverrides`: it carries the
  // OBS password.
  log.info('portable config resolved', {
    source: portable.source,
    managed: portable.managed,
    configPath: portable.configPath,
    overlayPort: portable.overlayPort,
    asrEngine: portable.asrEngine
  })
  for (const warning of portable.warnings) {
    log.warn('portable config warning', { detail: warning })
  }
  for (const warning of config.warnings) {
    log.warn('configuration warning', { key: warning.key, detail: warning.message })
  }

  // Key names and outcomes only. `detail` carries a file path and a reason, never a secret.
  log.info('obs settings discovery', {
    outcome: discovered.outcome,
    detail: discovered.detail,
    obsConfigured: config.obs !== null
  })

  const services = composeServices(log, portable)
  disposeServices = services.dispose

  // Connect to OBS at launch, rather than waiting for the operator to press a button.
  //
  // Safe by construction (Standing Rule 2): `ObsClient.connect` writes NOTHING to OBS — no `Set*`,
  // no `Start*`, no `Stop*` — it asks the version and the scene list and then observes. So this can
  // never impose state on an OBS that is already mid-service; it only starts watching one. That is
  // also why it is right to do here rather than in the renderer: observing OBS should not depend on
  // a window being open, and on relaunch after a crash this is what re-attaches to a live stream.
  //
  // Skipped when OBS says its own server is off, because dialling a closed port produces a timeout
  // that reads like a network fault instead of "switch the server on in OBS".
  if (config.obs !== null && discovered.reachable && discovered.port !== null) {
    const obsConfig = { url: config.obs.url, password: config.obs.password }
    void isObsPortListening(discovered.port)
      .then(async (listening) => {
        if (!listening) {
          // Quiet on purpose. Dialling here would arm the reconnect backoff and paint a permanent
          // amber tally reading "OBS went away" about an OBS that was never there. The operator
          // presses Connect when OBS is up, and that path still retries properly.
          log.info('OBS is not listening yet; leaving the connection for the operator', {
            port: discovered.port
          })
          return
        }
        const result = await services.obs.connect(obsConfig)
        if (result.ok) {
          log.info('connected to OBS at launch, using OBS’s own settings', { url: obsConfig.url })
          return
        }
        // Something IS listening and refused us — a wrong password is the likely cause, and that is
        // worth a warning because the operator has to act on it.
        log.warn('OBS is listening but refused the connection', {
          code: result.error.code,
          detail: result.error.message
        })
      })
      .catch((cause: unknown) => {
        log.warn('the launch-time OBS connect threw, which it is contracted not to', { cause })
      })
  }

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
function composeServices(log: Logger, portable: PortableConfigResult): ComposedServices {
  const obs = getObsClient({ logger: log })

  // The overlay server must be STARTED here, not merely constructed. OBS loads the overlay as
  // a browser source over http://127.0.0.1:7320/overlay, so if nothing binds that port the
  // congregation screen has no overlay layer at all — the whole point of Phase 2. Every unit
  // test passed with this line missing, which is exactly why it is called out.
  const overlay = getOverlayServer({
    logger: log,
    // An operator can move the overlay off 7320 in config.json (a port clash on a strange PC). The
    // Overlay panel reads the *actual* bound port from getInfo(), so the URL it shows an operator to
    // paste into OBS always matches. Dev leaves this unset and keeps the 7320 default.
    ...(portable.managed ? { port: portable.overlayPort } : {})
  })
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

  // Open the service plan named in config.json, if there is one.
  //
  // `assets.plan` has been in the config schema since the portable build landed and nothing read it,
  // which made it a promise the file was not keeping — `RUNBOOK.md` told the operator config.json
  // selects the plan, and it did not. It matters more now than it did: after the UI redesign the
  // slide grid IS the console, so a launch with no plan open shows "No service plan is open." across
  // the whole window. An operator arriving at a church PC should double-click START.bat and see
  // their deck, not go hunting through a file dialog in a dark booth.
  //
  // Deliberately AFTER health and the checkpoint store are constructed, so the subscribers that care
  // about plan state exist before the plan moves.
  //
  // A relative path resolves against the folder `config.json` itself lives in — which is the folder
  // the USB stick was copied to, whatever drive letter it got. Standing Rule 5: a missing or
  // malformed plan warns and leaves the console empty; it never blocks startup.
  const planPath = resolveConfiguredPlanPath(portable.config.assets.plan, portable.configDir)
  if (planPath !== null) {
    const opened = getPlanService({ logger: log }).open(planPath)
    if (opened.ok) {
      log.info('opened the service plan named in config.json', {
        path: planPath,
        cues: opened.value.plan.cues.length
      })
    } else {
      log.warn('could not open the service plan named in config.json', {
        path: planPath,
        code: opened.error.code,
        detail: opened.error.message
      })
    }
  }

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
