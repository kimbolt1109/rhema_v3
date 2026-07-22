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
import { getObsClient } from '@main/obs'
import { getOverlayServer } from '@main/overlay'
import { createMainWindow } from '@main/window'

let logger: Logger | null = null
let disposeIpc: (() => void) | null = null
let mainWindow: BrowserWindow | null = null
let overlayServer: ReturnType<typeof getOverlayServer> | null = null

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

  disposeIpc = toDisposer(registerIpc({ config, logger: log, obs, overlay }))

  mainWindow = createMainWindow({ logger: log })
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
