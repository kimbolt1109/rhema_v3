/**
 * The operator BrowserWindow.
 *
 * Security posture (CLAUDE.md architecture invariants + PROTOCOL.md §2.5):
 *  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. All privileged
 *    work happens in the main process behind the typed preload bridge.
 *  - The preload is resolved to `out/preload/index.cjs` — CommonJS with an explicit
 *    `.cjs` extension, because `package.json` is `"type": "module"` and Electron only
 *    loads an ESM preload when `sandbox: false`, which we are not doing.
 *  - Navigation is locked down: `window.open` is denied unconditionally, and any attempt
 *    to navigate away from the app's own origin is blocked. `http(s)` targets are handed
 *    to the OS browser via `shell.openExternal` instead.
 *
 * Booth theme: the window paints `#0a0a0f` before the renderer has a frame, so a launch
 * in a dark room never flashes white at the operator.
 */

import { fileURLToPath } from 'node:url'

import { BrowserWindow, shell } from 'electron'

import type { Logger } from '@main/logging/logger'
import { createNullLogger } from '@main/logging/logger'

/** Booth background — matches the Tailwind `background` token. */
export const WINDOW_BACKGROUND_COLOR = '#0a0a0f'

export const WINDOW_DEFAULT_WIDTH = 1440
export const WINDOW_DEFAULT_HEIGHT = 900
export const WINDOW_MIN_WIDTH = 1024
export const WINDOW_MIN_HEIGHT = 700

/**
 * `out/preload/index.cjs`, resolved relative to the bundled main entry at
 * `out/main/index.js`. Pinned by `electron.vite.config.ts`; changing one without the
 * other breaks the bridge.
 */
export const PRELOAD_PATH = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))

/** `out/renderer/index.html` — the production renderer entry. */
export const RENDERER_HTML_PATH = fileURLToPath(new URL('../renderer/index.html', import.meta.url))

/** Directory prefix used as the app origin in production (`file:///…/out/renderer/`). */
const RENDERER_DIR_URL = new URL('../renderer/', import.meta.url).href

export interface CreateMainWindowOptions {
  readonly logger?: Logger
}

/**
 * The dev server URL exported by electron-vite, or `null` in a packaged build.
 */
function devServerUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  return url === undefined || url.length === 0 ? null : url
}

/** Prefix that navigation is permitted to stay inside. */
function appOriginPrefix(): string {
  return devServerUrl() ?? RENDERER_DIR_URL
}

function isInternalNavigation(target: string): boolean {
  return target.startsWith(appOriginPrefix())
}

function isExternalWebLink(target: string): boolean {
  try {
    const protocol = new URL(target).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function createMainWindow(options: CreateMainWindowOptions = {}): BrowserWindow {
  const log = (options.logger ?? createNullLogger()).child('window')

  const window = new BrowserWindow({
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    // Do not show a half-painted window to an operator mid-service.
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // --- Navigation hardening ------------------------------------------------

  // Nothing may open a new Electron window. External web links go to the OS browser,
  // which is sandboxed away from this process entirely.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebLink(url)) {
      void shell.openExternal(url).catch((cause: unknown) => {
        log.warn('failed to open an external link', { url, cause })
      })
    } else {
      log.warn('blocked a window.open to a non-web target', { url })
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isInternalNavigation(url)) return
    event.preventDefault()
    if (isExternalWebLink(url)) {
      void shell.openExternal(url).catch((cause: unknown) => {
        log.warn('failed to open an external link', { url, cause })
      })
    } else {
      log.warn('blocked navigation away from the app origin', { url })
    }
  })

  // --- Content -------------------------------------------------------------

  const devUrl = devServerUrl()
  if (devUrl !== null) {
    void window.loadURL(devUrl).catch((cause: unknown) => {
      log.error('failed to load the dev renderer', { url: devUrl, cause })
    })
  } else {
    void window.loadFile(RENDERER_HTML_PATH).catch((cause: unknown) => {
      log.error('failed to load the renderer bundle', { file: RENDERER_HTML_PATH, cause })
    })
  }

  return window
}
