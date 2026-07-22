/**
 * The overlay server — one HTTP listener that serves the overlay page AND carries the overlay
 * WebSocket bus.
 *
 * ## Why this exists at all (BLUEPRINT.md §6)
 *
 * An OBS scene in Verger is `camera source(s) + a persistent "Overlays" browser source on top`.
 * The lower-third is its own LAYER, not a slide. Because the overlay is a separate layer,
 * switching cameras never touches it, and showing a lower-third never touches the camera. This
 * file is the thing that layer talks to.
 *
 * ## The central design rule: state-based, not event-based
 *
 * An OBS browser source can be reloaded, hidden, or crash mid-service, and the operator will not
 * notice until the congregation does. So:
 *
 *  - the SERVER owns {@link OverlayState};
 *  - every mutation broadcasts a FULL snapshot to every attached client;
 *  - a snapshot is sent **immediately on connect**, before the client asks for anything.
 *
 * A crashed overlay reloads, receives the snapshot, and re-renders exactly what should be on
 * screen. Resync is not a special case — it is the only case. There is deliberately no
 * show/hide event stream anywhere in this file.
 *
 * ## Posture
 *
 *  - **Loopback-first** (Standing Rule 7). `127.0.0.1` by default; `0.0.0.0` is refused outright
 *    by {@link isAllowedBindAddress}; LAN exposure means the operator typed a concrete IP.
 *  - **Nothing throws across a boundary.** Every public method returns a {@link Result}.
 *  - **Everything inbound is validated** with zod, and a single bad frame produces an error
 *    reply — never a thrown exception and never a dropped connection. A browser source that
 *    sends one malformed message during a service must not lose its overlay.
 *  - **A missing static directory is a warning, not a boot failure.** The control app must come
 *    up even if the overlay assets did not ship, because the operator still needs OBS control.
 *  - **Fully injectable** (logger, host, port, static dir, clock, heartbeat), so the tests bind
 *    port 0 and run in parallel without fighting over 7320.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'

import type { OverlayServerInfo, Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import {
  LOOPBACK_ADDRESS,
  OVERLAY_ASSET_PATH,
  OVERLAY_PAGE_PATH,
  OVERLAY_SERVER_PORT,
  OVERLAY_SOCKET_PATH,
  isAllowedBindAddress,
  overlayPageUrl
} from '@shared/net'
import { applyOverlayCommand, emptyOverlayState, overlayClientMessageSchema, overlayCommandSchema } from '@shared/overlay'
import type { OverlayCommand, OverlayServerMessage, OverlayState } from '@shared/overlay'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Largest inbound frame this server will look at, in bytes.
 *
 * Overlay -> server traffic is three tiny messages (`hello`, `applied`, `pong`); 64 KiB is
 * already three orders of magnitude more than any of them needs. Anything bigger is either a
 * bug or someone probing the port, and is answered with an error rather than parsed.
 */
export const MAX_INBOUND_FRAME_BYTES = 64 * 1024

/**
 * The hard `ws`-level payload ceiling.
 *
 * Deliberately larger than {@link MAX_INBOUND_FRAME_BYTES}: the application-level check replies
 * with a protocol error and keeps the socket, which is the behaviour we want for a browser
 * source. `ws`'s own `maxPayload` kills the connection instead, so it sits well above as a
 * memory backstop for genuinely abusive frames.
 */
export const HARD_MAX_PAYLOAD_BYTES = 1024 * 1024

/** How often the server probes each attached overlay. */
export const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Consecutive unanswered pings before a client is terminated.
 *
 * A dead browser source that stays in `clients` is worse than no browser source at all: the UI
 * would report "1 overlay attached" while the congregation screen is blank. Two misses and it
 * goes, so the count the operator sees is true.
 */
export const MAX_MISSED_PONGS = 2

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OverlayServerOptions {
  readonly logger: Logger
  /** Bind address. Default {@link LOOPBACK_ADDRESS}. Validated by {@link isAllowedBindAddress}. */
  readonly host?: string
  /** Bind port. Default {@link OVERLAY_SERVER_PORT}. Pass `0` for an ephemeral port. */
  readonly port?: number
  /** Directory of overlay page assets, served at {@link OVERLAY_PAGE_PATH}. */
  readonly staticDir?: string
  /** Epoch-milliseconds clock, injected so ping timestamps are deterministic in tests. */
  readonly now?: () => number
  /** Heartbeat interval. Default {@link DEFAULT_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number
}

/** Per-connection bookkeeping. Not part of the wire protocol. */
interface ClientRecord {
  readonly id: number
  missedPongs: number
  appliedRevision: number
  page: string
}

// ---------------------------------------------------------------------------
// Static directory resolution
// ---------------------------------------------------------------------------

/** Inputs for {@link resolveOverlayStaticDir}. Injected so this is testable without Electron. */
export interface ResolveOverlayStaticDirOptions {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean
  /** `process.resourcesPath`. Ignored in dev. */
  readonly resourcesPath: string
  /** Directory the running main bundle lives in (`out/main` in both dev and production). */
  readonly moduleDir: string
  /** Existence probe. Injected for tests. */
  readonly exists?: (path: string) => boolean
}

/**
 * Work out where the overlay page assets are.
 *
 * The main bundle runs from `out/main/index.js` in dev and from inside the asar when packaged,
 * so there is no single correct answer — the candidates are probed in order and the first one
 * that exists wins. If none exists the first candidate is returned anyway: `start()` will serve
 * a directory that 404s and log a loud warning, which is far better than refusing to boot the
 * control app over a missing asset.
 */
export function resolveOverlayStaticDir(options: ResolveOverlayStaticDirOptions): string {
  const exists = options.exists ?? existsSync
  const candidates = options.isPackaged
    ? [
        join(options.resourcesPath, 'overlay'),
        join(options.moduleDir, '..', 'overlay'),
        join(options.resourcesPath, 'app.asar.unpacked', 'out', 'overlay')
      ]
    : [
        join(options.moduleDir, '..', '..', 'src', 'overlay'),
        join(options.moduleDir, '..', 'overlay')
      ]

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  // Non-empty by construction; the `??` only satisfies `noUncheckedIndexedAccess`.
  return candidates[0] ?? join(options.moduleDir, '..', 'overlay')
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

/** How long `stop()` waits for a graceful close before giving up and moving on. */
const SHUTDOWN_DEADLINE_MS = 2_000

/**
 * Run a callback-style close and resolve when it completes — or when the deadline expires.
 *
 * Shutdown must be bounded. A socket that never reports closed is not a reason to hang the app
 * (or a test run) forever; the process is going away regardless.
 */
function withDeadline(operation: (done: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, SHUTDOWN_DEADLINE_MS)
    timer.unref?.()
    try {
      operation(finish)
    } catch {
      finish()
    }
  })
}

function frameByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  if (data instanceof ArrayBuffer) return data.byteLength
  return data.byteLength
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class OverlayServer {
  private readonly logger: Logger
  private readonly host: string
  private readonly requestedPort: number
  private readonly staticDir: string
  private readonly now: () => number
  private readonly heartbeatMs: number

  /**
   * Root of the current Service Plan's asset folder, served at {@link OVERLAY_ASSET_PATH}.
   *
   * `null` until a plan is opened. Set at runtime rather than at construction because it moves
   * with whichever plan the operator has open — see {@link setAssetRoot}.
   */
  private assetRoot: string | null = null

  private state: OverlayState = emptyOverlayState()

  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

  private readonly clients = new Map<WebSocket, ClientRecord>()
  private nextClientId = 1

  private boundPort = 0
  private running = false
  private lastError: string | null = null
  private starting: Promise<Result<OverlayServerInfo>> | null = null

  private readonly stateListeners = new Set<(state: OverlayState) => void>()
  private readonly infoListeners = new Set<(info: OverlayServerInfo) => void>()

  constructor(options: OverlayServerOptions) {
    this.logger = options.logger.child('overlay-server')
    this.host = options.host ?? LOOPBACK_ADDRESS
    this.requestedPort = options.port ?? OVERLAY_SERVER_PORT
    this.staticDir = options.staticDir ?? ''
    this.now = options.now ?? Date.now
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Bind the listener and attach the WebSocket upgrade handler.
   *
   * Idempotent: calling it while running (or while a concurrent start is in flight) resolves
   * with the existing info rather than binding twice.
   */
  async start(): Promise<Result<OverlayServerInfo>> {
    if (this.running) return ok(this.getInfo())
    if (this.starting !== null) return this.starting

    const attempt = this.startOnce()
    this.starting = attempt
    try {
      return await attempt
    } finally {
      this.starting = null
    }
  }

  private async startOnce(): Promise<Result<OverlayServerInfo>> {
    if (!isAllowedBindAddress(this.host)) {
      const message = `refusing to bind overlay server to '${this.host}' — loopback or a concrete LAN IPv4 only`
      this.lastError = message
      this.logger.error(message)
      this.emitInfo()
      return err(ErrorCode.INVALID_ARG, message)
    }

    if (this.staticDir === '' || !existsSync(this.staticDir)) {
      this.logger.warn('overlay static directory not found — the overlay page will 404', {
        staticDir: this.staticDir
      })
    } else {
      this.logger.info('serving overlay assets', { staticDir: this.staticDir, path: OVERLAY_PAGE_PATH })
    }

    let httpServer: HttpServer | null = null
    let wss: WebSocketServer | null = null

    try {
      const app = express()

      app.get('/', (_request, response) => {
        response.redirect(OVERLAY_PAGE_PATH)
      })

      // The current Service Plan's asset folder — imported slide images and media.
      //
      // These MUST be served over HTTP. The overlay page is loaded from `http://127.0.0.1:7320`,
      // and Chromium (including an OBS Browser Source) refuses to load `file:` subresources from
      // an `http:` document; the page's CSP is also `img-src 'self' data:`. A slide referenced as
      // a `file:` URL simply never appears on the congregation screen, and does so silently.
      //
      // The root is set at runtime by the plan service (`setAssetRoot`), because it moves with
      // whichever plan is open. It is resolved per-request so opening a different plan takes
      // effect immediately with no server restart.
      app.use(OVERLAY_ASSET_PATH, (request, response, next) => {
        const root = this.assetRoot
        if (root === null) {
          response.status(404).type('text/plain').send('no service plan is open')
          return
        }
        express.static(root, {
          index: false,
          etag: false,
          lastModified: false,
          cacheControl: false,
          // `express.static` already refuses to serve outside its root and rejects encoded `..`,
          // and `dotfiles: 'deny'` keeps anything hidden in the plan folder unreachable.
          dotfiles: 'deny',
          setHeaders: (assetResponse) => {
            assetResponse.setHeader('Cache-Control', 'no-store')
          }
        })(request, response, next)
      })

      // A browser source must never render a stale overlay after an asset edit, so nothing here
      // is cacheable. The files are a few KiB served over loopback; there is nothing to save.
      app.use(
        OVERLAY_PAGE_PATH,
        express.static(this.staticDir === '' ? join(process.cwd(), 'overlay-missing') : this.staticDir, {
          // The page file is `overlay.html`, not `index.html`. With the default index list a
          // request for the directory (`/overlay/`) finds no index and 404s — which meant the
          // exact URL we tell operators to paste into OBS returned nothing and the overlay was
          // blank in a live service. Both names are accepted so the descriptive filename can
          // stay while a conventional `index.html` would also work.
          index: ['overlay.html', 'index.html'],
          etag: false,
          lastModified: false,
          cacheControl: false,
          setHeaders: (response) => {
            response.setHeader('Cache-Control', 'no-store')
          }
        })
      )

      httpServer = createServer(app)
      wss = new WebSocketServer({ noServer: true, maxPayload: HARD_MAX_PAYLOAD_BYTES })

      const server = httpServer
      const sockets = wss

      // `noServer: true` + an explicit upgrade handler, so exactly one path can become a
      // WebSocket. Anything else is a 400 and a destroyed socket — the overlay bus is not a
      // general-purpose tunnel into the main process.
      server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = this.upgradePathname(request)
        if (pathname !== OVERLAY_SOCKET_PATH) {
          this.logger.warn('rejected websocket upgrade on unexpected path', { pathname })
          try {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          } catch {
            /* the peer is already gone; nothing to report */
          }
          socket.destroy()
          return
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          sockets.emit('connection', client, request)
        })
      })

      sockets.on('connection', (client: WebSocket, request: IncomingMessage) => {
        this.acceptClient(client, request)
      })

      sockets.on('error', (cause: Error) => {
        this.lastError = cause.message
        this.logger.error('websocket server error', { error: cause.message })
        this.emitInfo()
      })

      // An HTTP-level error after a successful bind must not take the process down.
      server.on('error', (cause: Error) => {
        this.lastError = cause.message
        this.logger.error('overlay http server error', { error: cause.message })
        this.emitInfo()
      })

      await this.listen(server)

      this.httpServer = server
      this.wss = sockets
      this.boundPort = this.readBoundPort(server)
      this.running = true
      this.lastError = null
      this.startHeartbeat()

      const info = this.getInfo()
      this.logger.info('overlay server listening', {
        host: info.host,
        port: info.port,
        pageUrl: info.pageUrl
      })
      this.emitInfo()
      return ok(info)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const message = `overlay server could not bind ${this.host}:${this.requestedPort} (${detail})`
      this.lastError = message
      this.logger.error(message)

      // Tear down whatever half-built listener we have, so a failed start leaves no handle.
      try {
        wss?.close()
      } catch {
        /* already closed */
      }
      try {
        httpServer?.close()
      } catch {
        /* never bound */
      }
      this.emitInfo()
      return err(ErrorCode.IO_ERROR, message, detail)
    }
  }

  /** Close every socket, the WebSocket server and the listener. Safe to call when stopped. */
  async stop(): Promise<Result<void>> {
    try {
      this.stopHeartbeat()

      for (const client of [...this.clients.keys()]) {
        this.disposeClient(client)
      }
      this.clients.clear()

      const sockets = this.wss
      this.wss = null
      if (sockets !== null) {
        await withDeadline((done) => {
          sockets.close(done)
        })
      }

      const server = this.httpServer
      this.httpServer = null
      if (server !== null) {
        // Keep-alive HTTP connections would otherwise hold `close()` open indefinitely — a
        // browser source that has fetched the page keeps its socket warm.
        server.closeAllConnections?.()
        await withDeadline((done) => {
          server.close(() => {
            done()
          })
        })
      }

      const wasRunning = this.running
      this.running = false
      this.boundPort = 0
      if (wasRunning) this.logger.info('overlay server stopped')
      this.emitInfo()
      return ok(undefined)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.running = false
      this.lastError = detail
      this.logger.error('overlay server failed to stop cleanly', { error: detail })
      this.emitInfo()
      return err(ErrorCode.INTERNAL, 'overlay server failed to stop cleanly', detail)
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The authoritative overlay state. The overlay page is a pure function of this. */
  getState(): OverlayState {
    return this.state
  }

  /**
   * Point the `/assets` route at the open plan's asset folder.
   *
   * Called by the plan service whenever a plan is opened or saved. Takes effect immediately —
   * the route resolves the root per request, so no restart is needed and an operator switching
   * plans mid-setup does not have to think about it.
   *
   * Pass `null` when no plan is open; requests then 404 rather than serving a stale folder from
   * a previous service.
   */
  setAssetRoot(root: string | null): void {
    this.assetRoot = root
    this.logger.debug('overlay asset root changed', { assetRoot: root })
  }

  /** The directory currently served at `/assets`, or `null` when no plan is open. */
  getAssetRoot(): string | null {
    return this.assetRoot
  }

  /**
   * Apply a command and broadcast the resulting FULL snapshot.
   *
   * Validation happens first and an invalid command leaves the state byte-identical — a
   * malformed command from the UI must never half-apply during a service.
   */
  send(command: OverlayCommand): Result<OverlayState> {
    const parsed = overlayCommandSchema.safeParse(command)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      this.logger.warn('rejected invalid overlay command', { detail })
      return err(ErrorCode.INVALID_ARG, 'invalid overlay command', detail)
    }

    this.state = applyOverlayCommand(this.state, parsed.data)
    this.logger.debug('overlay command applied', {
      name: parsed.data.name,
      revision: this.state.revision
    })

    this.broadcastState()
    this.notifyState()
    return ok(this.state)
  }

  /** Live status for the renderer's Overlay panel. */
  getInfo(): OverlayServerInfo {
    return {
      running: this.running,
      host: this.host,
      port: this.boundPort,
      pageUrl: overlayPageUrl(this.host, this.boundPort),
      clients: this.clients.size,
      lastError: this.lastError
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function — always call it. */
  onState(callback: (state: OverlayState) => void): Unsubscribe {
    this.stateListeners.add(callback)
    return () => {
      this.stateListeners.delete(callback)
    }
  }

  /** Subscribe to server up/down and client-count changes. */
  onInfo(callback: (info: OverlayServerInfo) => void): Unsubscribe {
    this.infoListeners.add(callback)
    return () => {
      this.infoListeners.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  private acceptClient(client: WebSocket, request: IncomingMessage): void {
    const record: ClientRecord = {
      id: this.nextClientId,
      missedPongs: 0,
      appliedRevision: -1,
      page: ''
    }
    this.nextClientId += 1
    this.clients.set(client, record)

    this.logger.info('overlay attached', {
      clientId: record.id,
      remote: request.socket.remoteAddress ?? 'unknown',
      clients: this.clients.size
    })

    // THE watchdog-resilience requirement: the full snapshot goes out immediately, before the
    // client has said anything at all. A browser source that just crashed and reloaded gets
    // back exactly what should be on screen.
    this.sendTo(client, { channel: 'state', payload: this.state })
    this.emitInfo()

    client.on('message', (data: RawData, isBinary: boolean) => {
      this.handleFrame(client, record, data, isBinary)
    })

    client.on('close', () => {
      if (this.clients.delete(client)) {
        this.logger.info('overlay detached', { clientId: record.id, clients: this.clients.size })
        this.emitInfo()
      }
    })

    client.on('error', (cause: Error) => {
      this.logger.warn('overlay socket error', { clientId: record.id, error: cause.message })
    })
  }

  /**
   * Handle one inbound frame.
   *
   * Nothing in here can throw and nothing in here disconnects the client. A single bad frame
   * during a service is answered and forgotten — losing the overlay over it would be a far worse
   * outcome than ignoring garbage.
   */
  private handleFrame(
    client: WebSocket,
    record: ClientRecord,
    data: RawData,
    isBinary: boolean
  ): void {
    try {
      const size = frameByteLength(data)
      if (size > MAX_INBOUND_FRAME_BYTES) {
        this.logger.warn('rejected oversized overlay frame', { clientId: record.id, size })
        this.replyError(
          client,
          `frame of ${size} bytes exceeds the ${MAX_INBOUND_FRAME_BYTES} byte limit`
        )
        return
      }

      if (isBinary) {
        this.replyError(client, 'binary frames are not part of the overlay protocol')
        return
      }

      let raw: unknown
      try {
        raw = JSON.parse(frameText(data))
      } catch {
        this.replyError(client, 'frame is not valid JSON')
        return
      }

      const parsed = overlayClientMessageSchema.safeParse(raw)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
        this.replyError(client, `frame failed validation: ${detail}`)
        return
      }

      switch (parsed.data.channel) {
        case 'hello':
          record.page = parsed.data.payload.page
          record.missedPongs = 0
          this.logger.info('overlay said hello', {
            clientId: record.id,
            page: parsed.data.payload.page,
            userAgent: parsed.data.payload.userAgent
          })
          break
        case 'applied':
          record.appliedRevision = parsed.data.payload.revision
          record.missedPongs = 0
          break
        case 'pong':
          record.missedPongs = 0
          break
        default: {
          // Exhaustiveness: a new inbound channel must be handled here to compile.
          const unreachable: never = parsed.data
          void unreachable
          break
        }
      }
    } catch (cause) {
      // Belt and braces. A parser bug must not become an unhandled exception in the main process.
      this.logger.error('overlay frame handler threw', {
        clientId: record.id,
        error: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  /**
   * Drop a client immediately.
   *
   * Deliberately does NOT `removeAllListeners()` on the socket: `ws` attaches its own `close`
   * listener to keep `WebSocketServer.clients` accurate, and stripping it leaves the server
   * believing a terminated socket is still attached — at which point `wss.close()` waits forever
   * for a client that will never report in, and shutdown hangs.
   */
  private disposeClient(client: WebSocket): void {
    this.clients.delete(client)
    try {
      client.terminate()
    } catch {
      /* already gone */
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const handle = setInterval(() => {
      this.pulse()
    }, this.heartbeatMs)
    // The heartbeat must not by itself keep the Node event loop (or a vitest run) alive.
    handle.unref?.()
    this.heartbeat = handle
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private pulse(): void {
    let dropped = 0
    for (const [client, record] of [...this.clients.entries()]) {
      if (record.missedPongs >= MAX_MISSED_PONGS) {
        this.logger.warn('terminating unresponsive overlay', {
          clientId: record.id,
          missedPongs: record.missedPongs
        })
        this.disposeClient(client)
        dropped += 1
        continue
      }
      record.missedPongs += 1
      this.sendTo(client, { channel: 'ping', payload: { ts: this.now() } })
    }
    if (dropped > 0) this.emitInfo()
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private listen(server: HttpServer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        server.removeListener('listening', onListening)
        reject(cause)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.requestedPort, this.host)
    })
  }

  private readBoundPort(server: HttpServer): number {
    const address = server.address()
    if (address !== null && typeof address === 'object') return address.port
    return this.requestedPort
  }

  private upgradePathname(request: IncomingMessage): string {
    const target = request.url ?? ''
    const questionMark = target.indexOf('?')
    return questionMark === -1 ? target : target.slice(0, questionMark)
  }

  private broadcastState(): void {
    const message: OverlayServerMessage = { channel: 'state', payload: this.state }
    for (const client of this.clients.keys()) {
      this.sendTo(client, message)
    }
  }

  private replyError(client: WebSocket, message: string): void {
    this.sendTo(client, {
      channel: 'error',
      payload: { code: ErrorCode.INVALID_ARG, message }
    })
  }

  private sendTo(client: WebSocket, message: OverlayServerMessage): void {
    if (client.readyState !== WebSocket.OPEN) return
    try {
      client.send(JSON.stringify(message))
    } catch (cause) {
      this.logger.warn('failed to write to overlay socket', {
        error: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  private notifyState(): void {
    const snapshot = this.state
    for (const listener of [...this.stateListeners]) {
      try {
        listener(snapshot)
      } catch (cause) {
        this.logger.error('overlay state listener threw', {
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }
    }
  }

  private emitInfo(): void {
    const info = this.getInfo()
    for (const listener of [...this.infoListeners]) {
      try {
        listener(info)
      } catch (cause) {
        this.logger.error('overlay info listener threw', {
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }
    }
  }
}
