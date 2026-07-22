/**
 * The OBS connection — Verger's link to the engine that actually keeps the service on air.
 *
 * Standing Rule 2 is the whole design brief: **OBS is the resilient engine; Verger is a
 * convenience layer.** Concretely, in this file that means:
 *
 *  - **The client reads freely and writes only from an allowlist.** Every `Get*` request is
 *    permitted; every other request is refused by a hard structural guard
 *    ({@link isAllowedRequest}) unless it appears, by name, in {@link ALLOWED_WRITE_REQUESTS} —
 *    currently the three requests a camera button needs (Phase 3) and the four output requests
 *    GO LIVE / END need (Phase 5), and nothing else. So a future edit cannot quietly turn this
 *    into something that imposes state on OBS: it would have to add a line to that list and
 *    justify it. `SetSceneItemEnabled`, `RemoveScene`, `SetProfileParameter`, `CreateInput` and
 *    every other mutating request stay refused. On connect the client still asks OBS only what
 *    version it is and what scenes it has — the connect routine writes nothing at all: no
 *    `Set*`, no `Start*`, no `Stop*`.
 *  - **Nothing throws.** Every public method returns a {@link Result}; every callback and every
 *    socket interaction is wrapped. A crash in here must never take the booth UI down, and an
 *    exception can never cross the IPC boundary (see `src/shared/result.ts`).
 *  - **Absent config is a resting state, not a failure** (Standing Rule 5). An empty URL puts the
 *    client in `not-configured` and it never dials.
 *  - **Reconnection is endless, except when it cannot possibly work.** An unexpected close backs
 *    off exponentially and retries forever; a rejected password (`auth-failed`) is terminal, with
 *    zero retries, because retrying a wrong password burns OBS connection slots and buries the
 *    real problem under a scrolling "reconnecting…" indicator.
 *
 * Every dependency is injected — the socket factory, the timers, the clock, the logger, the
 * reconnect policy and the jitter source — so the whole reconnect state machine is driven
 * deterministically in `ObsClient.test.ts` with no network, no OBS and no real time.
 */

import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { DEFAULT_RECONNECT_POLICY, computeBackoffDelay, initialObsStatus } from '@shared/obs'
import type {
  ObsConnectionConfig,
  ObsConnectionState,
  ObsScene,
  ObsSceneList,
  ObsStatus,
  ReconnectPolicy
} from '@shared/obs'
import { ErrorCode, err, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'

// ---------------------------------------------------------------------------
// The socket seam
// ---------------------------------------------------------------------------

/** A listener attached to an obs-websocket event. Payload shape varies per event. */
export type ObsEventListener = (payload?: unknown) => void

/**
 * The minimal structural slice of `obs-websocket-js`'s `OBSWebSocket` that this client uses.
 *
 * Declared here rather than importing the concrete class so that (a) the test double is a
 * twenty-line hand-written class with no library, no `ws`, and no network, and (b) the library
 * version is pinned at exactly one place — `src/main/obs/index.ts`, which adapts the real class
 * onto this interface.
 *
 * Mirrors obs-websocket-js 5.0.8: `connect(url, password)` resolves once the Identify handshake
 * completes and rejects with an `OBSWebSocketError` carrying the WebSocket close `code`;
 * `call(requestType, requestData)` resolves with `responseData`.
 */
export interface OBSWebSocketLike {
  connect(url: string, password?: string): Promise<unknown>
  disconnect(): Promise<void>
  call(requestType: string, requestData?: Record<string, unknown>): Promise<unknown>
  on(event: string, listener: ObsEventListener): void
  off(event: string, listener: ObsEventListener): void
}

/** Opaque handle returned by {@link ObsTimers.setTimeout}. */
export type ObsTimerHandle = ReturnType<typeof setTimeout> | number

/** The timer surface, injected so reconnection can be driven by fake timers in tests. */
export interface ObsTimers {
  setTimeout(handler: () => void, delayMs: number): ObsTimerHandle
  clearTimeout(handle: ObsTimerHandle): void
}

/** The real timers. Injected explicitly by `getObsClient()`; never reached for in a test. */
export const realTimers: ObsTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * obs-websocket's `WebSocketCloseCode.AuthenticationFailed`.
 *
 * obs-websocket-js surfaces the WebSocket close code verbatim as `OBSWebSocketError.code`, so a
 * rejected password is identified by this number — never by matching on a message string, which
 * is localised, reworded between releases, and empty when the socket closes without a reason.
 */
export const OBS_CLOSE_CODE_AUTHENTICATION_FAILED = 4009

/**
 * Deadline for a single OBS request.
 *
 * A live service must never hang on us: if OBS stops answering, the operator needs a bounded
 * failure and a red light within a couple of seconds, not a spinner that never resolves.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 5_000

/** OBS version information, as reported by `GetVersion`. Purely observed. */
export interface ObsVersionInfo {
  readonly obsVersion: string | null
  readonly obsWebSocketVersion: string | null
  readonly rpcVersion: number | null
}

/** Constructor dependencies. All of the first four are mandatory — see the module docblock. */
export interface ObsClientOptions {
  /** Builds a fresh socket for each dial. A socket is never reused after it closes. */
  readonly createSocket: () => OBSWebSocketLike
  readonly timers: ObsTimers
  /** Epoch-milliseconds clock. */
  readonly now: () => number
  readonly logger: Logger
  readonly policy?: ReconnectPolicy
  /** Jitter source in `[0, 1)`; same contract as `Math.random`. */
  readonly random?: () => number
  readonly callTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ObsClient {
  private readonly createSocket: () => OBSWebSocketLike
  private readonly timers: ObsTimers
  private readonly now: () => number
  private readonly log: Logger
  private readonly policy: ReconnectPolicy
  private readonly random: () => number
  private readonly callTimeoutMs: number

  private status: ObsStatus
  private sceneList: ObsSceneList | null = null
  private config: ObsConnectionConfig | null = null

  private socket: OBSWebSocketLike | null = null
  private detach: (() => void) | null = null

  /** The socket currently bound, so a late `onObsEvent` can attach to it immediately. */
  private attachedSocket: OBSWebSocketLike | null = null
  private retryHandle: ObsTimerHandle | null = null

  /**
   * Incremented on every dial and on every explicit disconnect. An async dial that finishes
   * after its generation has been superseded discards its socket instead of installing it —
   * which is what makes `disconnect()` mid-handshake safe.
   */
  private generation = 0

  /** True between `disconnect()` and the next `connect()`: suppresses the reconnect loop. */
  private closing = false

  private readonly statusSubscribers = new Set<(status: ObsStatus) => void>()
  private readonly sceneListSubscribers = new Set<(sceneList: ObsSceneList) => void>()

  /**
   * Raw obs-websocket event subscriptions, keyed by event name.
   *
   * Kept on the CLIENT rather than on the socket because the socket is replaced on every
   * reconnect. A subscriber registered once must keep working across a disconnect — otherwise
   * `StreamStateChanged` would go quiet exactly when OBS drops and comes back, which is the one
   * moment the operator most needs to be told.
   */
  private readonly eventSubscribers = new Map<string, Set<(payload?: unknown) => void>>()

  constructor(options: ObsClientOptions) {
    this.createSocket = options.createSocket
    this.timers = options.timers
    this.now = options.now
    this.log = options.logger.child('obs')
    this.policy = options.policy ?? DEFAULT_RECONNECT_POLICY
    this.random = options.random ?? Math.random
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    // Nothing is configured until `connect()` is called, and construction never dials.
    this.status = initialObsStatus('not-configured', this.now())
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The current connection status. Always a complete, serialisable snapshot. */
  getStatus(): ObsStatus {
    return this.status
  }

  /** The last scene list OBS reported, or `null` if it has never reported one. */
  getCachedSceneList(): ObsSceneList | null {
    return this.sceneList
  }

  /** Subscribe to status changes. The callback is never called with a throw propagating out. */
  onStatus(callback: (status: ObsStatus) => void): Unsubscribe {
    this.statusSubscribers.add(callback)
    return () => {
      this.statusSubscribers.delete(callback)
    }
  }

  /** Subscribe to scene-list changes. */
  onSceneList(callback: (sceneList: ObsSceneList) => void): Unsubscribe {
    this.sceneListSubscribers.add(callback)
    return () => {
      this.sceneListSubscribers.delete(callback)
    }
  }

  /**
   * Subscribe to a raw obs-websocket event by name.
   *
   * READ-ONLY: this observes what OBS announces and grants no ability to command it. The write
   * guard ({@link isAllowedRequest}) is untouched and still gates every outgoing request.
   *
   * Used by `src/main/obs/outputs.ts` for `StreamStateChanged` / `RecordStateChanged` /
   * `RecordFileChanged`, so the GO LIVE panel reflects a stream started, stopped or dropped
   * **inside OBS** rather than only what Verger itself did — Standing Rule 2 again.
   *
   * The subscription lives on the client, so it survives reconnects: register once and keep
   * receiving events across as many dropped sockets as the service throws at you.
   */
  onObsEvent(event: string, listener: (payload?: unknown) => void): Unsubscribe {
    let listeners = this.eventSubscribers.get(event)
    if (listeners === undefined) {
      listeners = new Set()
      this.eventSubscribers.set(event, listeners)
      // A socket may already be attached; bind this newly-interesting event to it now.
      this.bindExtraEvent(event)
    }
    listeners.add(listener)

    return () => {
      const current = this.eventSubscribers.get(event)
      current?.delete(listener)
    }
  }

  /**
   * Deliver a raw OBS event to its subscribers.
   *
   * A throwing subscriber is caught and logged: one bad listener must not stop the others, and
   * must never surface as an unhandled rejection in the main process mid-service.
   */
  private fanoutObsEvent(event: string, payload?: unknown): void {
    const listeners = this.eventSubscribers.get(event)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (cause) {
        this.log.warn('an OBS event subscriber threw', { event, cause })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect (or reconnect) using `config`.
   *
   * An empty or whitespace-only URL is not an error condition in the crash sense: the client
   * lands in `not-configured`, never dials, and reports `NOT_CONFIGURED` so the UI can explain
   * how to fix it (Standing Rule 5).
   */
  async connect(config: ObsConnectionConfig): Promise<Result<ObsStatus>> {
    const url = readConfigUrl(config)
    const password = readConfigPassword(config)

    await this.teardown()
    this.closing = false

    if (url === '') {
      this.config = null
      this.sceneList = null
      this.setStatus({
        state: 'not-configured',
        attempt: 0,
        nextRetryInMs: null,
        lastError: null,
        obsVersion: null,
        obsWebSocketVersion: null,
        rpcVersion: null,
        currentProgramScene: null
      })
      this.log.info('OBS is not configured; the client will not dial')
      return err(
        ErrorCode.NOT_CONFIGURED,
        'no OBS websocket URL is configured',
        'set OBS_WEBSOCKET_URL in .env'
      )
    }

    this.config = { url, password }
    // An operator-initiated connect starts the backoff sequence from scratch.
    this.status = { ...this.status, attempt: 0, nextRetryInMs: null }
    return this.dial()
  }

  /**
   * Disconnect deliberately.
   *
   * Cancels any pending reconnect timer, abandons any in-flight handshake, and schedules
   * nothing further — the client stays down until `connect()` is called again.
   */
  async disconnect(): Promise<Result<ObsStatus>> {
    this.closing = true
    await this.teardown()

    const state: ObsConnectionState = this.config === null ? 'not-configured' : 'disconnected'
    this.setStatus({
      state,
      attempt: 0,
      nextRetryInMs: null,
      lastError: null,
      obsVersion: null,
      obsWebSocketVersion: null,
      rpcVersion: null
    })
    this.log.info('disconnected from OBS by request')
    return ok(this.status)
  }

  /**
   * Release every resource. Called on app quit; leaves no timer and no subscriber behind.
   */
  async dispose(): Promise<void> {
    this.closing = true
    await this.teardown()
    this.statusSubscribers.clear()
    this.sceneListSubscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Ask OBS for its scene list. Updates the cache and notifies subscribers on success. */
  async getSceneList(): Promise<Result<ObsSceneList>> {
    const socket = this.connectedSocket()
    if (socket === null) return notConnected('scene list')

    const response = await this.request(socket, 'GetSceneList')
    if (!response.ok) return response

    const sceneList = toSceneList(response.value)
    this.publishSceneList(sceneList)
    return ok(sceneList)
  }

  /** Ask OBS for its version triple. */
  async getVersion(): Promise<Result<ObsVersionInfo>> {
    const socket = this.connectedSocket()
    if (socket === null) return notConnected('version')

    const response = await this.request(socket, 'GetVersion')
    if (!response.ok) return response
    return ok(toVersionInfo(response.value))
  }

  // -------------------------------------------------------------------------
  // The general request seam
  // -------------------------------------------------------------------------

  /**
   * Issue one arbitrary OBS request.
   *
   * Subject to exactly the same guard as everything else in this class: any `Get*`, plus the
   * enumerated {@link ALLOWED_WRITE_REQUESTS}. Anything else is refused with `INVALID_ARG`
   * before it reaches the socket, so exposing this method does not widen what Verger can do to
   * OBS — it only lets another module (Phase 3's camera service) use the authority this class
   * already has.
   *
   * Returns `NOT_CONNECTED` rather than throwing or queueing when OBS is down: a camera button
   * pressed while OBS is closed must fail visibly and immediately, not silently later.
   */
  async call(
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Result<unknown>> {
    const socket = this.connectedSocket()
    if (socket === null) {
      return err(
        ErrorCode.NOT_CONNECTED,
        `cannot send "${requestType}" to OBS while disconnected`,
        this.status.state
      )
    }
    return this.request(socket, requestType, requestData)
  }

  // -------------------------------------------------------------------------
  // Dialling
  // -------------------------------------------------------------------------

  private async dial(): Promise<Result<ObsStatus>> {
    const config = this.config
    if (config === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'no OBS websocket URL is configured')
    }

    const generation = ++this.generation
    this.setStatus({ state: 'connecting', nextRetryInMs: null })

    let socket: OBSWebSocketLike
    try {
      socket = this.createSocket()
    } catch (cause) {
      return this.failDial(cause, generation)
    }

    try {
      await socket.connect(config.url, config.password === null ? undefined : config.password)
    } catch (cause) {
      await closeQuietly(socket)
      return this.failDial(cause, generation)
    }

    if (generation !== this.generation) {
      // A `disconnect()` or a newer `connect()` landed while the handshake was in flight.
      await closeQuietly(socket)
      return err(ErrorCode.NOT_CONNECTED, 'the OBS connection attempt was superseded')
    }

    this.socket = socket
    this.attachListeners(socket, generation)

    // Standing Rule 2: reads only. `GetVersion` and `GetSceneList` are the entire connect
    // routine — the client observes OBS, it never configures it.
    const version = await this.request(socket, 'GetVersion')
    const scenes = await this.request(socket, 'GetSceneList')

    if (generation !== this.generation) {
      return err(ErrorCode.NOT_CONNECTED, 'the OBS connection attempt was superseded')
    }

    const versionInfo = version.ok ? toVersionInfo(version.value) : EMPTY_VERSION
    const sceneList = scenes.ok ? toSceneList(scenes.value) : null

    this.setStatus({
      state: 'connected',
      attempt: 0,
      nextRetryInMs: null,
      lastError: null,
      obsVersion: versionInfo.obsVersion,
      obsWebSocketVersion: versionInfo.obsWebSocketVersion,
      rpcVersion: versionInfo.rpcVersion,
      currentProgramScene: sceneList?.currentProgramScene ?? this.status.currentProgramScene
    })
    this.log.info('connected to OBS', {
      obsVersion: versionInfo.obsVersion,
      obsWebSocketVersion: versionInfo.obsWebSocketVersion
    })

    if (sceneList !== null) this.publishSceneList(sceneList)
    return ok(this.status)
  }

  /** Turn a failed dial into either the terminal `auth-failed` state or a scheduled retry. */
  private failDial(cause: unknown, generation: number): Result<ObsStatus> {
    if (generation !== this.generation) {
      return err(ErrorCode.NOT_CONNECTED, 'the OBS connection attempt was superseded')
    }

    const error = describeCause(cause, 'the OBS connection failed')

    if (isAuthenticationFailure(cause)) {
      this.enterAuthFailed(error)
      return { ok: false, error }
    }
    if (this.closing) {
      return { ok: false, error }
    }

    this.log.warn('the OBS connection attempt failed', {
      message: error.message,
      detail: error.detail
    })
    this.scheduleReconnect(error)
    return { ok: false, error }
  }

  /**
   * Terminal. Zero retries: a rejected password cannot succeed on the tenth attempt either, and
   * the operator is far better served by being told plainly.
   */
  private enterAuthFailed(error: AppError): void {
    this.clearRetry()
    this.setStatus({ state: 'auth-failed', nextRetryInMs: null, lastError: error })
    this.log.error('OBS rejected the password; not retrying', { detail: error.detail })
  }

  private scheduleReconnect(error: AppError): void {
    const attempt = this.status.attempt
    const maxAttempts = this.policy.maxAttempts

    if (maxAttempts !== null && attempt >= maxAttempts) {
      this.setStatus({ state: 'disconnected', nextRetryInMs: null, lastError: error })
      this.log.error('giving up on OBS after the configured attempt limit', { attempt })
      return
    }

    const delayMs = computeBackoffDelay(attempt, this.policy, this.random)
    this.setStatus({
      state: 'reconnecting',
      attempt: attempt + 1,
      nextRetryInMs: delayMs,
      lastError: error
    })

    this.clearRetry()
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null
      try {
        void this.dial()
      } catch (cause) {
        // `dial()` is written not to throw synchronously; this is belt-and-braces so a timer
        // callback can never surface an unhandled exception in the main process.
        this.log.error('the OBS reconnect attempt threw', { cause })
      }
    }, delayMs)
  }

  // -------------------------------------------------------------------------
  // Socket events
  // -------------------------------------------------------------------------

  private attachListeners(socket: OBSWebSocketLike, generation: number): void {
    const onClosed = (payload?: unknown): void => {
      this.handleConnectionClosed(socket, generation, payload)
    }
    const onError = (payload?: unknown): void => {
      // obs-websocket-js always follows `ConnectionError` with a `ConnectionClosed`, so this is
      // purely diagnostic — reconnection is driven from the close.
      this.log.warn('the OBS socket reported an error', {
        message: describeCause(payload, 'the OBS socket errored').message
      })
    }
    const onProgramSceneChanged = (payload?: unknown): void => {
      this.handleProgramSceneChanged(socket, payload)
    }
    const onPreviewSceneChanged = (payload?: unknown): void => {
      this.handlePreviewSceneChanged(socket, payload)
    }
    const onSceneListChanged = (payload?: unknown): void => {
      this.handleSceneListChanged(socket, payload)
    }

    const bindings: readonly (readonly [string, ObsEventListener])[] = [
      ['ConnectionClosed', onClosed],
      ['ConnectionError', onError],
      ['CurrentProgramSceneChanged', onProgramSceneChanged],
      ['CurrentPreviewSceneChanged', onPreviewSceneChanged],
      ['SceneListChanged', onSceneListChanged]
    ]

    // Every event any caller has subscribed to via `onObsEvent`, bound onto THIS socket. The
    // set is rebuilt on each attach, which is what makes those subscriptions survive reconnects.
    const extra: (readonly [string, ObsEventListener])[] = []
    for (const event of this.eventSubscribers.keys()) {
      extra.push([event, (payload?: unknown) => this.fanoutObsEvent(event, payload)])
    }

    const allBindings = [...bindings, ...extra]

    for (const [event, listener] of allBindings) {
      try {
        socket.on(event, listener)
      } catch (cause) {
        this.log.warn('failed to subscribe to an OBS event', { event, cause })
      }
    }

    this.attachedSocket = socket

    this.detach = () => {
      this.attachedSocket = null
      for (const [event, listener] of allBindings) {
        try {
          socket.off(event, listener)
        } catch {
          /* the socket is already gone — nothing to unbind */
        }
      }
    }
  }

  /**
   * Bind a newly-subscribed event onto the socket that is already attached, if any.
   *
   * Without this, calling `onObsEvent` after the client connected would receive nothing until
   * the next reconnect — a silent, confusing gap.
   */
  private bindExtraEvent(event: string): void {
    const socket = this.attachedSocket
    if (socket === null) return
    try {
      socket.on(event, (payload?: unknown) => this.fanoutObsEvent(event, payload))
    } catch (cause) {
      this.log.warn('failed to subscribe to an OBS event', { event, cause })
    }
  }

  private handleConnectionClosed(
    socket: OBSWebSocketLike,
    generation: number,
    payload?: unknown
  ): void {
    if (generation !== this.generation || this.socket !== socket) return

    this.runDetach()
    this.socket = null

    if (this.closing) return

    const error = describeCause(payload, 'the OBS connection closed')
    if (isAuthenticationFailure(payload)) {
      this.enterAuthFailed(error)
      return
    }

    this.log.warn('the OBS connection closed unexpectedly', {
      message: error.message,
      detail: error.detail
    })
    this.scheduleReconnect(error)
  }

  private handleProgramSceneChanged(socket: OBSWebSocketLike, payload?: unknown): void {
    if (this.socket !== socket) return
    const sceneName = readString(payload, 'sceneName')
    if (sceneName === null) return

    const previous = this.sceneList
    this.publishSceneList({
      scenes: previous?.scenes ?? [],
      currentProgramScene: sceneName,
      currentPreviewScene: previous?.currentPreviewScene ?? null
    })
  }

  private handlePreviewSceneChanged(socket: OBSWebSocketLike, payload?: unknown): void {
    if (this.socket !== socket) return
    const sceneName = readString(payload, 'sceneName')
    if (sceneName === null) return

    const previous = this.sceneList
    this.publishSceneList({
      scenes: previous?.scenes ?? [],
      currentProgramScene: previous?.currentProgramScene ?? null,
      currentPreviewScene: sceneName
    })
  }

  private handleSceneListChanged(socket: OBSWebSocketLike, payload?: unknown): void {
    if (this.socket !== socket) return
    const previous = this.sceneList
    this.publishSceneList({
      scenes: parseScenes(readUnknown(payload, 'scenes')),
      currentProgramScene: previous?.currentProgramScene ?? null,
      currentPreviewScene: previous?.currentPreviewScene ?? null
    })
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private connectedSocket(): OBSWebSocketLike | null {
    if (this.status.state !== 'connected') return null
    return this.socket
  }

  /**
   * Issue one OBS request, bounded by {@link callTimeoutMs}.
   *
   * Refuses anything that is neither a read nor an explicitly allowlisted write (Standing
   * Rule 2). This is a structural guarantee, not a convention: no code path in this class can
   * send OBS a request that is not on {@link ALLOWED_WRITE_REQUESTS} or prefixed `Get`.
   */
  private async request(
    socket: OBSWebSocketLike,
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Result<unknown>> {
    if (!isAllowedRequest(requestType)) {
      this.log.error('refused a non-read OBS request', { requestType })
      return err(
        ErrorCode.INVALID_ARG,
        `refusing to send "${requestType}" — Verger reads OBS state, it never imposes it`
      )
    }

    let pending: Promise<unknown>
    try {
      pending = socket.call(requestType, requestData)
    } catch (cause) {
      return { ok: false, error: describeCause(cause, `the OBS request "${requestType}" failed`) }
    }

    return this.withDeadline(pending, requestType)
  }

  /**
   * Resolve `pending`, or give up after the deadline.
   *
   * A hung OBS must produce a bounded `TIMEOUT`, never a promise that never settles: the whole
   * point of the connection light is that the operator learns within seconds.
   */
  private withDeadline(pending: Promise<unknown>, label: string): Promise<Result<unknown>> {
    return new Promise<Result<unknown>>((resolve) => {
      let settled = false

      const handle = this.timers.setTimeout(() => {
        if (settled) return
        settled = true
        resolve(err(ErrorCode.TIMEOUT, `the OBS request "${label}" timed out`, `${this.callTimeoutMs}ms`))
      }, this.callTimeoutMs)

      pending.then(
        (value) => {
          if (settled) return
          settled = true
          this.timers.clearTimeout(handle)
          resolve(ok(value))
        },
        (cause: unknown) => {
          if (settled) return
          settled = true
          this.timers.clearTimeout(handle)
          resolve({ ok: false, error: describeCause(cause, `the OBS request "${label}" failed`) })
        }
      )
    })
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  /** Tears the live connection down without deciding what state to land in. */
  private async teardown(): Promise<void> {
    this.generation += 1
    this.clearRetry()
    this.runDetach()

    const socket = this.socket
    this.socket = null
    if (socket !== null) await closeQuietly(socket)
  }

  private clearRetry(): void {
    const handle = this.retryHandle
    this.retryHandle = null
    if (handle === null) return
    try {
      this.timers.clearTimeout(handle)
    } catch {
      /* a fake or already-fired timer — nothing to cancel */
    }
  }

  private runDetach(): void {
    const detach = this.detach
    this.detach = null
    if (detach === null) return
    try {
      detach()
    } catch {
      /* best effort */
    }
  }

  private setStatus(patch: ObsStatusPatch): void {
    const previous = this.status
    const state = patch.state ?? previous.state

    this.status = {
      state,
      since: state === previous.state ? previous.since : this.now(),
      attempt: patch.attempt ?? previous.attempt,
      nextRetryInMs:
        patch.nextRetryInMs === undefined ? previous.nextRetryInMs : patch.nextRetryInMs,
      obsVersion: patch.obsVersion === undefined ? previous.obsVersion : patch.obsVersion,
      obsWebSocketVersion:
        patch.obsWebSocketVersion === undefined
          ? previous.obsWebSocketVersion
          : patch.obsWebSocketVersion,
      rpcVersion: patch.rpcVersion === undefined ? previous.rpcVersion : patch.rpcVersion,
      currentProgramScene:
        patch.currentProgramScene === undefined
          ? previous.currentProgramScene
          : patch.currentProgramScene,
      lastError: patch.lastError === undefined ? previous.lastError : patch.lastError
    }

    const snapshot = this.status
    for (const subscriber of [...this.statusSubscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('an OBS status subscriber threw', { cause })
      }
    }
  }

  private publishSceneList(sceneList: ObsSceneList): void {
    this.sceneList = sceneList

    if (sceneList.currentProgramScene !== this.status.currentProgramScene) {
      this.setStatus({ currentProgramScene: sceneList.currentProgramScene })
    }

    for (const subscriber of [...this.sceneListSubscribers]) {
      try {
        subscriber(sceneList)
      } catch (cause) {
        this.log.warn('an OBS scene-list subscriber threw', { cause })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A partial status update. `since` is derived, never supplied. */
type ObsStatusPatch = {
  readonly [K in keyof Omit<ObsStatus, 'since'>]?: ObsStatus[K]
}

const EMPTY_VERSION: ObsVersionInfo = {
  obsVersion: null,
  obsWebSocketVersion: null,
  rpcVersion: null
}

function notConnected(what: string): Result<never> {
  return err(ErrorCode.NOT_CONNECTED, `cannot read the OBS ${what} while disconnected`)
}

/**
 * The read side of the guard: every `Get*` request is permitted.
 *
 * Deliberately a whitelist by prefix rather than a blacklist of `Set*`, so `StartStream`,
 * `CreateInput`, `TriggerHotkeyByName` and every other mutating request fall outside it by
 * default rather than by enumeration.
 */
export function isReadOnlyRequest(requestType: string): boolean {
  return requestType.startsWith('Get')
}

/**
 * The write side of the guard: the ONLY non-`Get*` requests Verger may ever send OBS.
 *
 * Standing Rule 2 still holds — Verger reads OBS's state and does not impose it. These seven are
 * the narrow, enumerated exception, and every one of them fires only because the operator
 * physically pressed a button (a camera, or GO LIVE / END); nothing in Verger sends them on its
 * own initiative, and in particular no failure path anywhere in the app sends a `Stop*`.
 *
 * Adding an entry here is a deliberate act, reviewed on its own merits, and every entry names
 * the phase that needs it. What is NOT here is the point of the list: `SetSceneItemEnabled`,
 * `RemoveScene`, `CreateInput`, `SetProfileParameter`, `SetVideoSettings`,
 * `TriggerHotkeyByName` and the rest of the obs-websocket surface stay refused, so Verger can
 * never rearrange the operator's OBS — which is exactly the guarantee that makes it safe to leave
 * OBS running when this app crashes.
 */
export const ALLOWED_WRITE_REQUESTS: readonly string[] = [
  // Phase 3 — camera switching. The CAM 1 / CAM 2 / WIDE / PULPIT buttons are this request.
  'SetCurrentProgramScene',
  // Phase 3 — per-button transitions. Selects a transition the operator already configured in
  // OBS by NAME; Verger never defines or edits a transition.
  'SetCurrentSceneTransition',
  // Phase 3 — per-button transitions. The duration, in milliseconds, of the above.
  'SetCurrentSceneTransitionDuration',
  // Phase 5 — GO LIVE. Pushes RTMP to YouTube's ingest. The one request that puts the service on
  // air, sent only when the operator presses GO LIVE.
  'StartStream',
  // Phase 5 — END. Sent ONLY from the operator's held END confirmation; never as Verger's
  // reaction to one of its own errors, which is what keeps a bug in this app from taking a live
  // service off air.
  'StopStream',
  // Phase 5 — GO LIVE, Standing Rule 3. The always-on local recording is the backup for when the
  // internet wobbles mid-service, and a service is un-repeatable. It starts with the stream,
  // every time, and there is no setting that disables it.
  'StartRecord',
  // Phase 5 — END. Same operator-only rule as `StopStream`: the backup file is closed when the
  // operator ends the service, and at no other moment.
  'StopRecord'
]

/**
 * Whether a request may reach the socket at all: a read, or an allowlisted write.
 *
 * The single gate every request in this class passes through.
 */
export function isAllowedRequest(requestType: string): boolean {
  return isReadOnlyRequest(requestType) || ALLOWED_WRITE_REQUESTS.includes(requestType)
}

/** obs-websocket-js reports a rejected password as close code 4009 on the error's `code`. */
export function isAuthenticationFailure(cause: unknown): boolean {
  return readErrorCode(cause) === OBS_CLOSE_CODE_AUTHENTICATION_FAILED
}

function readErrorCode(cause: unknown): number | null {
  if (typeof cause !== 'object' || cause === null) return null
  const code = (cause as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

function describeCause(cause: unknown, fallback: string): AppError {
  const code = readErrorCode(cause)
  const raw = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause)
  const message = raw.trim() === '' ? fallback : raw

  if (code === null) return { code: ErrorCode.OBS_ERROR, message }
  return { code: ErrorCode.OBS_ERROR, message, detail: `obs-websocket code ${code}` }
}

async function closeQuietly(socket: OBSWebSocketLike): Promise<void> {
  try {
    await socket.disconnect()
  } catch {
    // Closing a socket that is already gone is normal, and a failure here must never surface.
  }
}

function readConfigUrl(config: ObsConnectionConfig): string {
  if (typeof config !== 'object' || config === null) return ''
  const url: unknown = config.url
  return typeof url === 'string' ? url.trim() : ''
}

function readConfigPassword(config: ObsConnectionConfig): string | null {
  if (typeof config !== 'object' || config === null) return null
  const password: unknown = config.password
  return typeof password === 'string' ? password : null
}

function readUnknown(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readString(source: unknown, key: string): string | null {
  const value = readUnknown(source, key)
  return typeof value === 'string' ? value : null
}

function readNumber(source: unknown, key: string): number | null {
  const value = readUnknown(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Map OBS's scene array onto {@link ObsScene}.
 *
 * OBS's own ordering is preserved exactly — Verger never reorders what OBS reports (the scene
 * list the operator sees in the app must match the one in OBS, or the buttons lie).
 */
export function parseScenes(value: unknown): readonly ObsScene[] {
  if (!Array.isArray(value)) return []
  const list: readonly unknown[] = value

  const scenes: ObsScene[] = []
  for (let position = 0; position < list.length; position += 1) {
    const entry = list[position]
    const name = readString(entry, 'sceneName')
    if (name === null) continue
    scenes.push({ name, index: readNumber(entry, 'sceneIndex') ?? position })
  }
  return scenes
}

/** Map a `GetSceneList` response onto {@link ObsSceneList}. */
export function toSceneList(response: unknown): ObsSceneList {
  return {
    scenes: parseScenes(readUnknown(response, 'scenes')),
    currentProgramScene: readString(response, 'currentProgramSceneName'),
    currentPreviewScene: readString(response, 'currentPreviewSceneName')
  }
}

/** Map a `GetVersion` response onto {@link ObsVersionInfo}. */
export function toVersionInfo(response: unknown): ObsVersionInfo {
  return {
    obsVersion: readString(response, 'obsVersion'),
    obsWebSocketVersion: readString(response, 'obsWebSocketVersion'),
    rpcVersion: readNumber(response, 'rpcVersion')
  }
}
