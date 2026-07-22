/**
 * The OBS module's public surface, and the one place where the real `obs-websocket-js` is
 * touched.
 *
 * `ObsClient` itself knows nothing about the library: it talks to {@link OBSWebSocketLike}, an
 * interface this file adapts the concrete class onto. That keeps the library version pinned to a
 * single import, and keeps the test suite free of `ws`, msgpack and the network.
 *
 * The singleton is **lazy and inert**: constructing it opens no socket and starts no timer.
 * Dialling is initiated by the IPC layer (or by the renderer), never as a side effect of import —
 * Standing Rule 2 again: OBS is the engine, and Verger attaches to it on request.
 */

import OBSWebSocket from 'obs-websocket-js'

import { createNullLogger } from '@main/logging/logger'
import type { Logger } from '@shared/log'
import type { ReconnectPolicy } from '@shared/obs'

import { ObsClient, realTimers } from './ObsClient'
import type { ObsEventListener, OBSWebSocketLike, ObsTimers } from './ObsClient'

export {
  DEFAULT_CALL_TIMEOUT_MS,
  OBS_CLOSE_CODE_AUTHENTICATION_FAILED,
  ObsClient,
  isAuthenticationFailure,
  isReadOnlyRequest,
  parseScenes,
  realTimers,
  toSceneList,
  toVersionInfo
} from './ObsClient'
export type {
  OBSWebSocketLike,
  ObsClientOptions,
  ObsEventListener,
  ObsTimerHandle,
  ObsTimers,
  ObsVersionInfo
} from './ObsClient'

/**
 * Adapt a real `OBSWebSocket` onto {@link OBSWebSocketLike}.
 *
 * The casts are confined to this function. `obs-websocket-js` types `call` and `on`/`off` against
 * generated unions of every request and event name; `ObsClient` deliberately works in plain
 * strings so its request whitelist (`Get*` only) is enforceable at runtime rather than by a type
 * the library owns.
 */
export function createObsSocket(): OBSWebSocketLike {
  const socket = new OBSWebSocket()

  const untyped = socket as unknown as {
    call(requestType: string, requestData?: Record<string, unknown>): Promise<unknown>
    on(event: string, listener: ObsEventListener): unknown
    off(event: string, listener: ObsEventListener): unknown
  }

  return {
    connect: (url, password) => socket.connect(url, password),
    disconnect: () => socket.disconnect(),
    call: (requestType, requestData) => untyped.call(requestType, requestData),
    on: (event, listener) => {
      untyped.on(event, listener)
    },
    off: (event, listener) => {
      untyped.off(event, listener)
    }
  }
}

/** Overrides for {@link getObsClient}. Every field has a production default. */
export interface GetObsClientOptions {
  readonly createSocket?: () => OBSWebSocketLike
  readonly timers?: ObsTimers
  readonly now?: () => number
  /**
   * Where the client's diagnostics go.
   *
   * Defaults to the null logger because the main process builds its rolling-file logger inside
   * `app.whenReady()` and there is no module-level singleton to reach for; pass the real one
   * (`getObsClient({ logger })`) to route OBS diagnostics into the service-day log file.
   */
  readonly logger?: Logger
  readonly policy?: ReconnectPolicy
  readonly random?: () => number
  readonly callTimeoutMs?: number
}

let singleton: ObsClient | null = null

/**
 * The process-wide OBS client.
 *
 * Callable with no arguments — that is exactly how `src/main/index.ts` wires it. Construction
 * neither dials nor schedules anything.
 */
export function getObsClient(options: GetObsClientOptions = {}): ObsClient {
  if (singleton !== null) return singleton

  singleton = new ObsClient({
    createSocket: options.createSocket ?? createObsSocket,
    timers: options.timers ?? realTimers,
    now: options.now ?? Date.now,
    logger: options.logger ?? createNullLogger(),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs })
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Exists for tests and for a clean app shutdown; production code should hold the instance rather
 * than reset it mid-service.
 */
export async function resetObsClient(): Promise<void> {
  const existing = singleton
  singleton = null
  if (existing !== null) await existing.dispose()
}
