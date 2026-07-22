/**
 * The overlay module's public surface, and the one place Electron is touched.
 *
 * `OverlayServer` itself knows nothing about `app` or `process.resourcesPath` — it takes a
 * static directory as a string. This file works out what that string should be, so the server
 * stays testable in a plain Node process with no Electron runtime.
 *
 * The singleton is **lazy and inert**: constructing it binds no port and starts no timer.
 * `src/main/index.ts` decides when the overlay server starts, exactly as it does for OBS
 * (Standing Rule 2 — Verger attaches to things on request; it does not open listeners as a side
 * effect of an import).
 */

import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import { createNullLogger } from '@main/logging/logger'
import type { Logger } from '@shared/log'

import { OverlayServer, resolveOverlayStaticDir } from './OverlayServer'

export {
  DEFAULT_HEARTBEAT_MS,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_INBOUND_FRAME_BYTES,
  MAX_MISSED_PONGS,
  OverlayServer,
  resolveOverlayStaticDir
} from './OverlayServer'
export type { OverlayServerOptions, ResolveOverlayStaticDirOptions } from './OverlayServer'

/** Directory of the running main bundle — `out/main` in both dev and packaged builds. */
const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Overrides for {@link getOverlayServer}. Every field has a production default. */
export interface GetOverlayServerOptions {
  /**
   * Where the server's diagnostics go.
   *
   * Defaults to the null logger, because the main process builds its rolling-file logger inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one
   * (`getOverlayServer({ logger })`) to route overlay diagnostics into the service-day log.
   */
  readonly logger?: Logger
  readonly host?: string
  readonly port?: number
  readonly staticDir?: string
  readonly now?: () => number
  readonly heartbeatMs?: number
}

let singleton: OverlayServer | null = null

/**
 * The process-wide overlay server.
 *
 * Callable with no arguments. Construction binds nothing — call `start()` when the app is ready.
 */
export function getOverlayServer(options: GetOverlayServerOptions = {}): OverlayServer {
  if (singleton !== null) return singleton

  const staticDir =
    options.staticDir ??
    resolveOverlayStaticDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDir: MODULE_DIR
    })

  singleton = new OverlayServer({
    logger: options.logger ?? createNullLogger(),
    staticDir,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs })
  })
  return singleton
}

/**
 * Drop the singleton, stopping it first.
 *
 * Exists for tests and for a clean app shutdown; production code holds the instance rather than
 * resetting it mid-service.
 */
export async function resetOverlayServer(): Promise<void> {
  const existing = singleton
  singleton = null
  if (existing !== null) await existing.stop()
}
