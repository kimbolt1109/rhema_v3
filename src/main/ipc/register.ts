/**
 * Main-process IPC registration — the trusted half of the process bridge.
 *
 * This module owns exactly one `ipcMain.handle` per `IpcChannel` value and the fan-out of
 * OBS and overlay events to every open window. `registerIpc` returns a disposer; calling it
 * removes every handler and every subscription, so a hot reload or a quit cannot leave a
 * second generation of handlers wired to a dead client.
 *
 * ## `safeHandle`
 *
 * Lifted from `docs/v2-notes/PROTOCOL.md` §2.4 — a spec written for Electron that v2 never
 * actually implemented (v2 shipped on Tauri). Every handler, without exception:
 *
 *  1. **Validates the sender.** A destroyed or absent `senderFrame` is a rejection, never a
 *     pass-through (§2.3: an unchecked null here is a straightforward bypass). Sub-frames
 *     are rejected, and the sender must be the `webContents` of a window Verger itself
 *     created.
 *
 *     v2's spec checks for a `rhema://` custom-scheme origin. Verger has no custom scheme —
 *     `src/main/window.ts` loads the renderer from the dev server in development and from
 *     `file://…/out/renderer/index.html` when packaged — so a scheme test would either
 *     reject production or be trivially satisfiable. Window ownership is the stronger check
 *     available here: it is identity, not string prefix, and it composes with the
 *     navigation lockdown already enforced on the window.
 *  2. **Validates its argument.** The renderer is the less-trusted side; every payload is
 *     zod-parsed and a failure returns `Err(INVALID_ARG)` with the issue paths (never the
 *     offending value, which could be a password).
 *  3. **Cannot throw.** The whole body runs in a try/catch that converts any escape into
 *     `Err(INTERNAL)` via `toAppError` and logs it. An exception crossing to the renderer
 *     arrives as an opaque stringified rejection with its type lost — see
 *     `src/shared/result.ts`.
 *
 * ## Standing rules honoured here
 *
 *  - **Rule 2** — nothing in this file imposes state on OBS. `obsConnect`/`obsSetConfig`
 *    dial; everything else reads what the client observed.
 *  - **Rule 5** — a missing config is never fatal. `obsSetConfig` still connects when
 *    `safeStorage` cannot persist the password; it just logs and carries on.
 *  - `configGet` returns the `ConfigSummary` projection *only* — key names and booleans. By
 *    construction it cannot carry a secret value, which is why `AppConfig` never crosses
 *    this boundary.
 *  - **Rule 7 / BLUEPRINT.md §6** — the overlay channels carry *whole state snapshots*, never
 *    show/hide events. `overlaySend` resolves with the resulting `OverlayState` and the
 *    `overlayState` event pushes a full snapshot to every window, which is the same contract
 *    the overlay server holds with the browser source. Resync is not a special case here
 *    either.
 */

import { BrowserWindow, app, ipcMain } from 'electron'
import { z } from 'zod'

import { summarize } from '@main/config/env'
import { getOverlayServer } from '@main/overlay'
import { getSecretsStore } from '@main/secrets/secrets'
import type { AppConfig } from '@shared/config'
import { obsConfigSchema } from '@shared/config'
import { IPC_CHANNEL_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type {
  AppVersions,
  IpcChannelValue,
  IpcEventValue,
  IpcRequest,
  IpcResponse,
  OverlayServerInfo,
  Unsubscribe
} from '@shared/ipc'
import type { LogRecord } from '@shared/log'
import type { Logger } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { overlayCommandSchema } from '@shared/overlay'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Structural seams
//
// Every Electron and OBS type this module touches is described structurally rather than
// imported as a concrete class. Two reasons: the OBS client is authored independently and
// must be free to settle on sync-or-async without breaking this file, and a structural
// surface is what makes the whole module testable with plain objects and no Electron
// runtime (binding constraint: no test may need a live OBS or a live Electron).
// ---------------------------------------------------------------------------

/** The slice of `WebFrameMain` used for sender validation. */
export interface WebFrameLike {
  readonly url?: string
}

/** The slice of `WebContents` used for pushing events and for sender identity. */
export interface WebContentsLike {
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
  readonly mainFrame?: WebFrameLike | null
}

/** The slice of `BrowserWindow` used for event fan-out. */
export interface WindowLike {
  isDestroyed?(): boolean
  readonly webContents: WebContentsLike
}

/** The slice of `IpcMainInvokeEvent` used by `safeHandle`. */
export interface IpcInvokeEventLike {
  readonly senderFrame?: WebFrameLike | null
  readonly sender?: WebContentsLike | null
}

/** The slice of `ipcMain` used here. Injectable so the tests need no Electron runtime. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown
  ): void
  removeHandler(channel: string): void
}

/** A value that may be delivered synchronously or as a promise. */
type Awaitable<T> = T | Promise<T>

/**
 * What a subsystem client method may hand back.
 *
 * Deliberately permissive: the OBS and overlay modules are written by other hands, and whether
 * `getStatus()` returns a bare `ObsStatus` or a `Result<ObsStatus>`, synchronously or not,
 * is their business. `resolveCall` normalises all four shapes.
 */
type ClientCall<T> = Awaitable<T | Result<T>>

/**
 * The minimum this module needs from the OBS client.
 *
 * `onStatus`/`onSceneList` are typed as *possibly* returning an unsubscribe so a client
 * that returns `void` still satisfies the contract; `registerUnsubscribe` only keeps what
 * is actually callable.
 */
export interface ObsClientLike {
  getStatus(): ClientCall<ObsStatus>
  getSceneList(): ClientCall<ObsSceneList>
  connect(config?: ObsConnectionConfig): ClientCall<ObsStatus>
  disconnect(): ClientCall<ObsStatus>
  onStatus(listener: (status: ObsStatus) => void): Unsubscribe | void
  onSceneList(listener: (sceneList: ObsSceneList) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the overlay server (`src/main/overlay`).
 *
 * Structural for the same reason `ObsClientLike` is — but here it also buys something the OBS
 * seam does not need: the overlay server owns a live HTTP + WebSocket listener, and this file
 * must be registrable with no listener at all (unit tests, and the window between app start
 * and the server binding 127.0.0.1).
 *
 * Note what is *absent*: there is no `showLowerThird`, no `hide`, no per-layer method. The
 * only mutation verb is `send(command)`, and the only readback is a full `OverlayState`
 * snapshot. That is the state-based contract of `@shared/overlay` reaching all the way into
 * the IPC layer — an event-shaped API here would let a reloaded browser source come back blank.
 */
export interface OverlayServerLike {
  /** The current snapshot. Authoritative even when the listener is down. */
  getState(): ClientCall<OverlayState>
  /** Apply a command and resolve with the resulting snapshot. */
  send(command: OverlayCommand): ClientCall<OverlayState>
  /** Listener liveness and attached browser-source count. */
  getInfo(): ClientCall<OverlayServerInfo>
  onState(listener: (state: OverlayState) => void): Unsubscribe | void
  onInfo(listener: (info: OverlayServerInfo) => void): Unsubscribe | void
}

/** The slice of `SecretsStore` used by `obsSetConfig`. */
export interface SecretsStoreLike {
  setSecret(key: string, value: string): Result<void>
}

/**
 * Dependencies.
 *
 * `obs`, `config` and `logger` are required because `src/main/index.ts` supplies exactly
 * those three. Everything else is optional with a production default, which is also what
 * keeps `registerIpc({ config, logger, obs })` legal under excess-property checking.
 */
export interface RegisterIpcDeps {
  readonly obs: ObsClientLike
  readonly config: AppConfig
  readonly logger: Logger
  /**
   * The overlay server.
   *
   * Optional, and for a structural reason rather than a stylistic one: `src/main/index.ts`
   * calls `registerIpc({ config, logger, obs })`, and under excess/missing-property checking a
   * required fourth key would simply fail to compile. Defaults to the process-wide singleton
   * from `@main/overlay`; if that cannot be resolved the overlay handlers degrade to
   * `Err(NOT_CONNECTED)` and a not-running `OverlayServerInfo` rather than throwing.
   *
   * Pass `null` to say "there is no overlay server" explicitly and skip the default lookup.
   */
  readonly overlay?: OverlayServerLike | null
  /** Windows to fan events out to, and the set a sender must belong to. */
  readonly getWindows?: () => readonly WindowLike[]
  /** Defaults to Electron's `ipcMain`. */
  readonly ipcMain?: IpcMainLike
  /** Defaults to the process-wide `safeStorage`-backed store. */
  readonly secrets?: SecretsStoreLike
  /** Monotonic-enough clock for the log rate limiter. Injectable for deterministic tests. */
  readonly now?: () => number
  /** App version reported by `appGetVersions`. Defaults to `app.getVersion()`. */
  readonly appVersion?: () => string
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/** Parses a raw IPC argument into the channel's request type, or explains why it cannot. */
type ArgValidator<T> = (raw: unknown) => Result<T>

/**
 * Compact, value-free description of a zod failure.
 *
 * Only issue *paths* and zod's own generic messages are kept. The offending value is never
 * interpolated — the very first channel to fail validation with a real payload is
 * `obsSetConfig`, whose payload contains a password.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.')
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

function zodArg<S extends z.ZodType>(schema: S): ArgValidator<z.output<S>> {
  return (raw) => {
    const parsed = schema.safeParse(raw)
    return parsed.success
      ? ok(parsed.data)
      : err('INVALID_ARG', 'the request payload failed validation', describeIssues(parsed.error))
  }
}

/** Channels that take no argument still validate: anything but `undefined` is a bug. */
const noArg: ArgValidator<void> = zodArg(z.void())

const obsConfigArg: ArgValidator<ObsConnectionConfig> = zodArg(obsConfigSchema)

/**
 * Overlay commands are validated here *as well as* inside the overlay server.
 *
 * Not redundant: this is the process boundary and the server is not. A malformed command must
 * be refused before it can reach the reducer, because the reducer's exhaustive `switch` is
 * written against a `name` union it trusts — and because a command that reaches the server is
 * a command that gets broadcast to every attached browser source.
 */
const overlayCommandArg: ArgValidator<OverlayCommand> = zodArg(overlayCommandSchema)

const logRecordSchema = z.object({
  ts: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  scope: z.string(),
  msg: z.string(),
  data: z.record(z.string(), z.unknown()).optional()
})

/**
 * Rebuilt field by field rather than passed straight through, because
 * `exactOptionalPropertyTypes` refuses `{ data: undefined }` where `LogRecord` declares
 * `data?: LogFields`. Omitting the key is the only assignable form.
 */
const logRecordArg: ArgValidator<LogRecord> = (raw) => {
  const parsed = logRecordSchema.safeParse(raw)
  if (!parsed.success) {
    return err('INVALID_ARG', 'the log record failed validation', describeIssues(parsed.error))
  }
  const { ts, level, scope, msg, data } = parsed.data
  return ok(data === undefined ? { ts, level, scope, msg } : { ts, level, scope, msg, data })
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Token bucket for `logWrite`: 100 records per second, burstable to 100.
 *
 * A renderer stuck in a render loop that logs on every pass would otherwise pin the main
 * process writing to a rolling file — during a live service, on the process that owns the
 * OBS connection. The limiter sheds the excess and returns `Err(RATE_LIMITED)` so the
 * renderer can see that it is the problem, and refills continuously so a burst does not
 * lock logging out for the rest of the service.
 */
const LOG_BUCKET_CAPACITY = 100
const LOG_BUCKET_REFILL_PER_MS = LOG_BUCKET_CAPACITY / 1000

interface TokenBucket {
  take(): boolean
}

function createTokenBucket(capacity: number, refillPerMs: number, now: () => number): TokenBucket {
  let tokens = capacity
  let lastRefill = now()

  return {
    take: () => {
      const at = now()
      const elapsed = Math.max(0, at - lastRefill)
      lastRefill = at
      tokens = Math.min(capacity, tokens + elapsed * refillPerMs)
      if (tokens < 1) return false
      tokens -= 1
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// OBS call normalisation
// ---------------------------------------------------------------------------

function looksLikeResult(value: unknown): value is Result<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok: unknown }).ok === 'boolean'
  )
}

/**
 * Await a subsystem client call and normalise it to a `Result`.
 *
 * A client that already returns `Result<T>` is passed through; one that returns a bare `T`
 * is wrapped. The cast is safe because `looksLikeResult` has ruled out the `Result` branch —
 * TypeScript simply cannot subtract it from the union.
 */
async function resolveCall<T>(call: ClientCall<T>): Promise<Result<T>> {
  const settled = await call
  return looksLikeResult(settled) ? (settled as Result<T>) : ok(settled as T)
}

// ---------------------------------------------------------------------------
// Overlay degradation
// ---------------------------------------------------------------------------

/**
 * What `overlayGetServerInfo` reports when there is no server object at all.
 *
 * Deliberately a successful `Result` carrying `running: false` rather than an `Err`: the
 * Overlay panel's whole job is to render this struct, and an operator who sees
 * `running: false, clients: 0` next to the loopback URL knows exactly what is wrong.
 * `pageUrl` still comes from `@shared/net`, so the URL shown for copy-into-OBS is the same
 * one the server will bind when it does come up (Standing Rule 7 — loopback, never a wildcard).
 */
/**
 * The answer `overlayGetState` / `overlaySend` give when there is no server object at all.
 *
 * `NOT_CONNECTED` rather than `INTERNAL`: an absent overlay server is an expected, recoverable
 * state (Standing Rule 5 — the subsystem reports itself unavailable and the app keeps running),
 * not a bug in Verger.
 */
function overlayUnavailable(): Result<never> {
  return err('NOT_CONNECTED', 'the overlay server is not available')
}

function offlineOverlayInfo(detail: string): OverlayServerInfo {
  return {
    running: false,
    host: LOOPBACK_ADDRESS,
    port: OVERLAY_SERVER_PORT,
    pageUrl: overlayPageUrl(),
    clients: 0,
    lastError: detail
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Key the OBS websocket password is persisted under in the encrypted secrets store. */
export const OBS_PASSWORD_SECRET_KEY = 'obs.password'

/** `IpcResponse[C]` is always `Result<X>`; this recovers the `X`. */
type ResponseValue<C extends IpcChannelValue> =
  IpcResponse[C] extends Result<infer T> ? T : never

/**
 * Register every IPC handler and the OBS event fan-out.
 *
 * @returns a disposer that removes every handler and unsubscribes from the OBS client.
 *          Idempotent: calling it twice is harmless.
 */
export function registerIpc(deps: RegisterIpcDeps): () => void {
  const log = deps.logger.child('ipc')
  const ipc: IpcMainLike = deps.ipcMain ?? ipcMain
  // Wrapped rather than passed by reference so `this` stays bound to `BrowserWindow`.
  const getWindows = deps.getWindows ?? ((): readonly WindowLike[] => BrowserWindow.getAllWindows())
  const now = deps.now ?? Date.now
  const appVersion = deps.appVersion ?? ((): string => app.getVersion())

  const registeredChannels: IpcChannelValue[] = []
  const unsubscribers: Unsubscribe[] = []
  const logBucket = createTokenBucket(LOG_BUCKET_CAPACITY, LOG_BUCKET_REFILL_PER_MS, now)
  let disposed = false

  /**
   * The overlay server, or `null` if there is not one.
   *
   * Resolved once, here, rather than per call: `getOverlayServer()` is a lazy singleton and
   * calling it repeatedly inside a handler would hide a construction failure behind whichever
   * button the operator happened to press. A `null` here is a first-class state — every
   * overlay handler has a defined answer for it.
   */
  const overlay: OverlayServerLike | null = resolveOverlayServer()

  function resolveOverlayServer(): OverlayServerLike | null {
    if (deps.overlay !== undefined) return deps.overlay
    try {
      return getOverlayServer()
    } catch (cause) {
      log.warn('the overlay server is unavailable; overlay IPC will report NOT_CONNECTED', {
        cause
      })
      return null
    }
  }

  // --- sender validation ---------------------------------------------------

  function isTrustedSender(event: IpcInvokeEventLike): boolean {
    const frame = event.senderFrame
    // A destroyed frame reads as null/undefined here. Treat it as a rejection: letting it
    // through is the classic bypass called out in PROTOCOL.md §2.3.
    if (frame === null || frame === undefined) return false

    const sender = event.sender
    if (sender === null || sender === undefined) return false

    // Sub-frames get the preload too. Only the top-level document of an operator window may
    // drive OBS, so anything embedded is refused.
    const mainFrame = sender.mainFrame
    if (mainFrame !== null && mainFrame !== undefined && mainFrame !== frame) return false

    // Identity, not string matching: the sender must be a window this process created.
    return getWindows().some((window) => !isGone(window) && window.webContents === sender)
  }

  // --- safeHandle ----------------------------------------------------------

  function safeHandle<C extends IpcChannelValue>(
    channel: C,
    parseArg: ArgValidator<IpcRequest[C]>,
    handler: (arg: IpcRequest[C], event: IpcInvokeEventLike) => Promise<Result<ResponseValue<C>>>
  ): void {
    ipc.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
      try {
        if (!isTrustedSender(event)) {
          log.warn('rejected an IPC call from an untrusted sender', { channel })
          return err('INVALID_ARG', 'the request did not come from a Verger window')
        }

        const parsed = parseArg(args[0])
        if (!parsed.ok) {
          log.warn('rejected an IPC call with an invalid payload', {
            channel,
            detail: parsed.error.detail
          })
          return parsed
        }

        return await handler(parsed.value, event)
      } catch (cause) {
        // Nothing throws across the boundary. Ever.
        const error = toAppError(cause)
        log.error('an IPC handler threw', { channel, code: error.code, message: error.message })
        return { ok: false, error }
      }
    })
    registeredChannels.push(channel)
  }

  // --- event fan-out -------------------------------------------------------

  function broadcast(event: IpcEventValue, payload: unknown): void {
    if (disposed) return
    for (const window of getWindows()) {
      if (isGone(window)) continue
      const contents = window.webContents
      if (contents.isDestroyed?.() === true) continue
      try {
        contents.send(event, payload)
      } catch (cause) {
        // A window torn down between the liveness check and the send is routine, not an
        // error worth escalating; the next push will simply skip it.
        log.debug('failed to push an event to a window', { event, cause })
      }
    }
  }

  function registerUnsubscribe(value: Unsubscribe | void): void {
    if (typeof value === 'function') unsubscribers.push(value)
  }

  try {
    registerUnsubscribe(
      deps.obs.onStatus((status) => {
        broadcast(IpcEvent.obsStatus, status)
      })
    )
    registerUnsubscribe(
      deps.obs.onSceneList((sceneList) => {
        broadcast(IpcEvent.obsSceneList, sceneList)
      })
    )
  } catch (cause) {
    log.error('failed to subscribe to the OBS client', { cause })
  }

  // The overlay fan-out mirrors the browser-source contract one level up: every window gets a
  // full `OverlayState` snapshot after every mutation, never a show/hide event. A control
  // window that reloads mid-service is then in exactly the position a reloaded browser source
  // is in — one snapshot away from correct.
  if (overlay !== null) {
    try {
      registerUnsubscribe(
        overlay.onState((state) => {
          broadcast(IpcEvent.overlayState, state)
        })
      )
      registerUnsubscribe(
        overlay.onInfo((info) => {
          broadcast(IpcEvent.overlayServerInfo, info)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the overlay server', { cause })
    }
  }

  // --- handlers ------------------------------------------------------------

  safeHandle(IpcChannel.obsGetStatus, noArg, async () => resolveCall(deps.obs.getStatus()))

  safeHandle(IpcChannel.obsGetSceneList, noArg, async () =>
    resolveCall(deps.obs.getSceneList())
  )

  safeHandle(IpcChannel.obsConnect, obsConfigArg, async (config) =>
    resolveCall(deps.obs.connect(config))
  )

  safeHandle(IpcChannel.obsDisconnect, noArg, async () => resolveCall(deps.obs.disconnect()))

  safeHandle(IpcChannel.obsSetConfig, obsConfigArg, async (config) => {
    persistObsPassword(config.password)

    // Drop the current socket before dialling the new endpoint. A failure here is not
    // interesting — "already disconnected" is the common case — so it is swallowed and the
    // connect attempt is what the operator actually sees the result of.
    try {
      await resolveCall(deps.obs.disconnect())
    } catch (cause) {
      log.debug('disconnect before reconfiguring failed; connecting anyway', { cause })
    }

    return resolveCall(deps.obs.connect(config))
  })

  // --- overlay -------------------------------------------------------------

  safeHandle(IpcChannel.overlayGetState, noArg, async () => {
    if (overlay === null) return overlayUnavailable()
    return resolveCall(overlay.getState())
  })

  safeHandle(IpcChannel.overlaySend, overlayCommandArg, async (command) => {
    // `overlayCommandArg` has already run — the server is never handed an unvalidated command.
    if (overlay === null) return overlayUnavailable()

    // A command accepted while nothing is listening would leave the control UI showing a
    // lower-third that no browser source can possibly be rendering. Zero *clients* is fine
    // (the snapshot is waiting for them on reconnect); zero *listener* is not.
    const info = await resolveCall(overlay.getInfo())
    if (info.ok && !info.value.running) {
      return err(
        'NOT_CONNECTED',
        'the overlay server is not running',
        `command=${command.name}${info.value.lastError === null ? '' : `; ${info.value.lastError}`}`
      )
    }

    return resolveCall(overlay.send(command))
  })

  safeHandle(IpcChannel.overlayGetServerInfo, noArg, async () => {
    // Never an `Err`: "the overlay server is down" is information the panel renders, not a
    // failure the panel has to special-case.
    if (overlay === null) return ok(offlineOverlayInfo('the overlay server was never created'))
    const info = await resolveCall(overlay.getInfo())
    return info.ok ? info : ok(offlineOverlayInfo(info.error.message))
  })

  safeHandle(IpcChannel.configGet, noArg, async () => ok(summarize(deps.config)))

  safeHandle(IpcChannel.logWrite, logRecordArg, async (record) => {
    if (!logBucket.take()) {
      return err(
        'RATE_LIMITED',
        'the renderer exceeded 100 log records per second',
        `scope=${record.scope}`
      )
    }
    forwardRendererLog(record)
    return ok(undefined)
  })

  safeHandle(IpcChannel.appGetVersions, noArg, async () => {
    const versions: AppVersions = {
      app: appVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      v8: process.versions.v8
    }
    return ok(versions)
  })

  // --- helpers that close over `log` / `deps` ------------------------------

  /**
   * Best effort, by design (Standing Rule 5). On a machine where `safeStorage` is
   * unavailable — notably Linux's plaintext-equivalent `basic_text` backend, which
   * `src/main/secrets/secrets.ts` deliberately reports as unavailable — the password simply
   * is not persisted and the operator re-enters it next launch. It must never block the
   * connection.
   */
  function persistObsPassword(password: string | null): void {
    if (password === null || password.length === 0) return
    try {
      const store = deps.secrets ?? getSecretsStore()
      const written = store.setSecret(OBS_PASSWORD_SECRET_KEY, password)
      if (!written.ok) {
        log.warn('the OBS password was not persisted; connecting without saving it', {
          code: written.error.code
        })
      }
    } catch (cause) {
      log.warn('the secrets store was unavailable; connecting without saving the password', {
        cause
      })
    }
  }

  function forwardRendererLog(record: LogRecord): void {
    const target = deps.logger.child('renderer').child(record.scope)
    switch (record.level) {
      case 'debug':
        target.debug(record.msg, record.data)
        break
      case 'info':
        target.info(record.msg, record.data)
        break
      case 'warn':
        target.warn(record.msg, record.data)
        break
      case 'error':
        target.error(record.msg, record.data)
        break
    }
  }

  log.debug('registered IPC handlers', {
    channels: registeredChannels.length,
    overlay: overlay === null ? 'unavailable' : 'attached'
  })

  // --- disposal ------------------------------------------------------------

  return () => {
    if (disposed) return
    disposed = true

    for (const channel of registeredChannels) {
      try {
        ipc.removeHandler(channel)
      } catch (cause) {
        log.warn('failed to remove an IPC handler', { channel, cause })
      }
    }
    registeredChannels.length = 0

    // Covers the OBS status/scene-list subscriptions and the overlay state/info ones alike:
    // both were pushed onto `unsubscribers` by `registerUnsubscribe`.
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe()
      } catch (cause) {
        log.warn('failed to unsubscribe from a subsystem client', { cause })
      }
    }
    unsubscribers.length = 0

    log.debug('disposed IPC handlers')
  }
}

/** True when the window is gone. `isDestroyed` is optional on the structural seam. */
function isGone(window: WindowLike): boolean {
  return window.isDestroyed?.() === true
}

/** Re-exported so a test (and a future phase) can assert full channel coverage. */
export { IPC_CHANNEL_VALUES }
