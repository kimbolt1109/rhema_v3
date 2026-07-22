/**
 * Main-process IPC registration — the trusted half of the process bridge.
 *
 * This module owns exactly one `ipcMain.handle` per `IpcChannel` value and the fan-out of
 * OBS, overlay, camera, YouTube and go-live events to every open window. `registerIpc` returns a
 * disposer; calling it removes every handler and every subscription, so a hot reload or a quit
 * cannot leave a second generation of handlers wired to a dead client. Disposing removes
 * listeners and nothing else — it never stops a stream or a recording.
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
 *  - **BLUEPRINT.md §6 — cameras and overlays are independent.** The `camera:*` handlers and the
 *    `overlay:*` handlers share no dependency, no payload type and no state object: `select`
 *    reaches only `CameraServiceLike`, `send` reaches only `OverlayServerLike`, and neither seam
 *    can name the other's types. Switching cameras therefore cannot disturb a lower-third, and
 *    showing a lower-third cannot disturb the camera — asserted in `register.test.ts` rather
 *    than asserted in this comment.
 *  - **BLUEPRINT.md §5 — no credential crosses this boundary.** The five `youtube:*` handlers
 *    return `YouTubeStatus` and `Broadcast`, and neither type has a field for an OAuth token or
 *    for the RTMP stream key. The key in particular is a credential that grants anyone the
 *    ability to broadcast to the channel: it lives in OBS's own settings, it is absent from
 *    `PersistentStream` by design, and no handler here can produce one. Nothing in this file logs
 *    an authorization code or a token either — the OAuth exchange happens entirely inside
 *    `src/main/youtube`, behind the `YouTubeServiceLike` seam.
 *  - **Standing Rule 3 / BLUEPRINT.md §5 Part B — local recording always runs.** `goLiveStart`
 *    takes no argument and `GoLiveServiceLike.start()` takes no argument, so there is no field
 *    anywhere on this boundary that could ask for a stream without a recording. The rule is
 *    enforced by an absence, which is the only kind of enforcement a later edit cannot forget.
 *  - **The app must never wedge the broadcast.** No handler and no disposal path in this file
 *    stops an OBS output. `goLiveEnd` is the only thing here that ends anything, and it runs
 *    only when the operator invokes it.
 */

import { BrowserWindow, app, ipcMain } from 'electron'
import { z } from 'zod'

import { getCameraService } from '@main/camera'
import { summarize } from '@main/config/env'
import { getGoLiveService } from '@main/golive'
import { getOverlayServer } from '@main/overlay'
import { getSecretsStore } from '@main/secrets/secrets'
import { getYouTubeService } from '@main/youtube'
import { CAMERA_SLOTS, cameraConfigSchema } from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { AppConfig } from '@shared/config'
import { obsConfigSchema } from '@shared/config'
import type { GoLiveState } from '@shared/golive'
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
import { broadcastTemplateSchema, createBroadcastSchema } from '@shared/youtube'
import type { Broadcast, BroadcastTemplate, YouTubeStatus } from '@shared/youtube'

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

/**
 * The minimum this module needs from the camera service (`src/main/camera`).
 *
 * Structural, and deliberately *narrow*: five methods, all of which speak only in `CameraConfig`
 * and `CameraState`. There is no overlay verb here and no overlay type in any signature, which
 * is the independence guarantee of BLUEPRINT.md §6 expressed as a type rather than as a comment.
 * A future edit that made `select()` able to touch a lower-third would have to widen this
 * interface first — and the tests below assert that a camera call leaves the overlay server
 * untouched, so widening it silently is not possible either.
 *
 * Note what this seam does *not* do: it does not check whether a slot is bound to a scene.
 * The service owns the config, so the service is the only place that can answer that; the IPC
 * layer would have to keep a second copy to duplicate the check, and a second copy is how the
 * two drift apart.
 */
export interface CameraServiceLike {
  getConfig(): ClientCall<CameraConfig>
  /** Persist a new binding set and resolve with what was actually stored. */
  setConfig(config: CameraConfig): ClientCall<CameraConfig>
  getState(): ClientCall<CameraState>
  /** Switch the program camera. Resolves with the resulting state. */
  select(slot: CameraSlot): ClientCall<CameraState>
  onState(listener: (state: CameraState) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the YouTube service (`src/main/youtube`).
 *
 * Structural, like every other seam here, and for one extra reason: **no test in this repo may
 * touch the network**, and there are no Google credentials on the build machine. A concrete
 * import would drag `googleapis` and an OAuth client into every test that so much as registers
 * an IPC handler. Six methods against plain objects instead.
 *
 * Read the *return* types as the security contract:
 *
 *  - Everything auth-shaped resolves with `YouTubeStatus`, which contains `YouTubeAuthStatus`
 *    (state, channel, lastError) and nothing else. There is no field on it for an access token,
 *    a refresh token or an authorization code, so no handler below can return one by accident.
 *  - `YouTubeStatus.stream` is a `PersistentStream`, whose type deliberately has **no stream-key
 *    field**. The RTMP key is a credential — it grants anyone the ability to broadcast to the
 *    channel — and it stays in OBS's own settings. Widening this seam to carry one would mean
 *    editing `@shared/youtube` first, which is the point.
 *
 * Note also what is absent from the verbs: no `startStream`, no `transition`, no `goLive`. Part A
 * of BLUEPRINT.md §5 is sign-in plus create-and-bind; the orchestration is Phase 5's, and a seam
 * that cannot name those operations cannot accidentally acquire them here.
 */
export interface YouTubeServiceLike {
  /** The whole Go Live screen in one struct, including the pre-flight issues. Never throws. */
  getStatus(): ClientCall<YouTubeStatus>
  /** Run (or re-run) the loopback OAuth consent flow. Resolves with the resulting status. */
  signIn(): ClientCall<YouTubeStatus>
  /** Forget the stored refresh token. */
  signOut(): ClientCall<YouTubeStatus>
  /** Persist the weekly template and resolve with the resulting status. */
  setTemplate(template: BroadcastTemplate): ClientCall<YouTubeStatus>
  /** Create the weekly broadcast and bind the persistent stream. */
  createBroadcast(options: { scheduledStartTime?: string }): ClientCall<Broadcast>
  onStatus(listener: (status: YouTubeStatus) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the go-live service (`src/main/golive`).
 *
 * Four methods, and this seam is where BLUEPRINT.md §5 Part B's three rules become types rather
 * than intentions:
 *
 *  1. **`start()` takes no argument.** Standing Rule 3 says local recording always runs whenever
 *     streaming does — it is the backup when the internet wobbles mid-service, and a service is
 *     un-repeatable. The enforcement is the *absence of a parameter*: there is no options object
 *     to carry a `record: false`, so no handler below can pass one, and no renderer can ask for
 *     one. Widening this signature is the only way to break that, which is the point.
 *  2. **There is no `stopStream`, no `stopRecord`, no per-step verb.** The IPC layer can ask to
 *     go live and ask to end, and nothing else. It therefore *cannot* react to a failed step by
 *     stopping the outputs that are still working — the app must never wedge the broadcast as a
 *     consequence of its own error, and a seam that cannot name "stop the recording" cannot do
 *     it by accident in a future edit.
 *  3. **Everything resolves with a whole `GoLiveState`.** Per-step progress, the `partial` phase
 *     (OBS streaming and recording, YouTube not transitioned — the most likely real failure),
 *     `reattached` after a crash re-attach, and `lastError` all ride on one snapshot. There is no
 *     boolean return anywhere here, because a boolean cannot say "we are on air locally but not
 *     publicly", and collapsing that into success or failure lies to the operator in opposite
 *     directions.
 *
 * Structural, like every other seam in this file, and for the usual binding reason: OBS Studio is
 * not installed on the build machine and there are no Google credentials, so the entire go-live
 * contract is proven here against a plain object with zero network.
 */
export interface GoLiveServiceLike {
  /** The current snapshot, including a re-attached one after a mid-service restart. */
  getState(): ClientCall<GoLiveState>
  /**
   * Run the whole GO LIVE sequence. Recording starts with the stream, always.
   *
   * Takes no argument on purpose — see rule 1 above.
   */
  start(): ClientCall<GoLiveState>
  /** End the broadcast, stop the stream and stop the recording. Operator-initiated only. */
  end(): ClientCall<GoLiveState>
  onState(listener: (state: GoLiveState) => void): Unsubscribe | void
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
  /**
   * The camera service.
   *
   * Optional for exactly the reason `overlay` is: `src/main/index.ts` calls
   * `registerIpc({ config, logger, obs, overlay })` and a required fifth key would fail to
   * compile. Defaults to the process-wide singleton from `@main/camera`; if that cannot be
   * resolved the four camera handlers degrade to `Err(NOT_CONNECTED)` rather than throwing.
   *
   * Pass `null` to say "there is no camera service" explicitly and skip the default lookup.
   */
  readonly camera?: CameraServiceLike | null
  /**
   * The YouTube service.
   *
   * Optional for the same compile-time reason `overlay` and `camera` are: `src/main/index.ts`
   * calls `registerIpc({ config, logger, obs, overlay })` and a required sixth key would fail to
   * compile. Defaults to the process-wide singleton from `@main/youtube`; if that cannot be
   * resolved — no Google credentials in `.env` is the *ordinary* case, not an exceptional one —
   * the five youtube handlers degrade to `Err(NOT_CONFIGURED)` rather than throwing.
   *
   * Pass `null` to say "there is no YouTube service" explicitly and skip the default lookup.
   */
  readonly youtube?: YouTubeServiceLike | null
  /**
   * The GO LIVE orchestrator (BLUEPRINT.md §5, Part B).
   *
   * Optional for exactly the reason the other three are: `src/main/index.ts` calls
   * `registerIpc({ config, logger, obs, overlay, youtube })` and a required seventh key would
   * fail to compile. Defaults to the process-wide singleton from `@main/golive`; if that cannot
   * be resolved the three go-live handlers degrade to `Err(NOT_CONNECTED)` rather than throwing —
   * and, critically, an absent orchestrator changes nothing about OBS. A Verger whose go-live
   * service failed to construct is still a working camera switcher and overlay controller, and
   * the operator still has OBS's own Start Streaming / Start Recording buttons (Standing Rule 5).
   *
   * Pass `null` to say "there is no go-live service" explicitly and skip the default lookup.
   */
  readonly goLive?: GoLiveServiceLike | null
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

/**
 * The camera binding set, validated at the process boundary as well as inside the service.
 *
 * Same argument as `overlayCommandArg`: this is the trust boundary and the service is not. A
 * `sceneName` of the wrong type reaching the service would eventually reach OBS's
 * `SetCurrentProgramScene`, and `cameraConfigSchema` is what stops it here.
 */
const cameraConfigArg: ArgValidator<CameraConfig> = zodArg(cameraConfigSchema)

/**
 * `cameraSelect`'s envelope.
 *
 * `z.enum(CAMERA_SLOTS)` is the load-bearing part: the renderer cannot ask for a fifth camera,
 * and it cannot smuggle an arbitrary string toward OBS by way of the slot field. An unknown
 * slot is `Err(INVALID_ARG)` and the service is never called at all.
 */
const cameraSelectArg: ArgValidator<{ slot: CameraSlot }> = zodArg(
  z.object({ slot: z.enum(CAMERA_SLOTS) })
)

/**
 * The weekly broadcast template, validated at the process boundary.
 *
 * `titleTemplate` reaches YouTube's `snippet.title` and `thumbnailPath` reaches the filesystem,
 * so both are length-bounded here before the service ever sees them — a 10 MB "title" pasted into
 * the field is refused by this line, not by a 400 from Google in the middle of a service.
 */
const broadcastTemplateArg: ArgValidator<BroadcastTemplate> = zodArg(broadcastTemplateSchema)

/**
 * `youtubeCreateBroadcast`'s envelope.
 *
 * Rebuilt field by field rather than passed straight through, for the same reason
 * `logRecordArg` is: `exactOptionalPropertyTypes` refuses `{ scheduledStartTime: undefined }`
 * where the request type declares `scheduledStartTime?: string`. Omitting the key is the only
 * assignable form — and it is also the form the service wants, since "absent" means
 * "schedule it for the default time" rather than "schedule it for `undefined`".
 */
const createBroadcastArg: ArgValidator<{ scheduledStartTime?: string }> = (raw) => {
  const parsed = createBroadcastSchema.safeParse(raw)
  if (!parsed.success) {
    return err('INVALID_ARG', 'the request payload failed validation', describeIssues(parsed.error))
  }
  const { scheduledStartTime } = parsed.data
  return ok(scheduledStartTime === undefined ? {} : { scheduledStartTime })
}

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

/**
 * The answer every camera channel gives when there is no camera service object at all.
 *
 * `NOT_CONNECTED`, not `INTERNAL`, for the same reason the overlay uses it: a camera service
 * that could not be constructed is a recoverable subsystem state (Standing Rule 5), and the
 * camera panel's job is to show the buttons as unavailable and say why — not to crash.
 */
function cameraUnavailable(): Result<never> {
  return err('NOT_CONNECTED', 'the camera service is not available')
}

/**
 * The answer every youtube channel gives when there is no YouTube service object at all.
 *
 * `NOT_CONFIGURED`, not `NOT_CONNECTED` and certainly not `INTERNAL`. On a machine with no
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — which is the state of every fresh checkout, and of
 * the build machine — there is nothing to connect *to* and nothing broken. The Go Live screen's
 * job is to render "YouTube is not configured" with the two key names, and Standing Rule 5 says
 * the rest of the app carries on regardless: cameras still switch, overlays still fire, OBS still
 * streams by hand.
 */
function youtubeUnavailable(): Result<never> {
  return err(
    'NOT_CONFIGURED',
    'YouTube is not configured',
    'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart Verger'
  )
}

/**
 * The answer every go-live channel gives when there is no orchestrator object at all.
 *
 * `NOT_CONNECTED`, and the `detail` is the part that matters: an operator whose GO LIVE button
 * just refused needs to be told, in the same breath, that OBS still works by hand. Verger is a
 * convenience over OBS, never a dependency of it — a Verger that cannot orchestrate must not
 * leave the operator believing the service cannot happen.
 *
 * Note what this does *not* do: it does not touch OBS. An unavailable orchestrator stops nothing
 * that is already running.
 */
function goLiveUnavailable(): Result<never> {
  return err(
    'NOT_CONNECTED',
    'the go-live service is not available',
    'start streaming and recording from OBS directly; Verger will re-attach when it recovers'
  )
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

  /**
   * The camera service, or `null` if there is not one. Resolved once, like the overlay server.
   *
   * These are two separate objects resolved by two separate lookups, and neither is passed to
   * the other. A camera service that fails to construct leaves the overlay channels fully
   * working, and vice versa — which is what lets an operator keep firing lower-thirds through a
   * service where OBS never came up.
   */
  const camera: CameraServiceLike | null = resolveCameraService()

  function resolveCameraService(): CameraServiceLike | null {
    if (deps.camera !== undefined) return deps.camera
    try {
      return getCameraService()
    } catch (cause) {
      log.warn('the camera service is unavailable; camera IPC will report NOT_CONNECTED', {
        cause
      })
      return null
    }
  }

  /**
   * The YouTube service, or `null` if there is not one. Resolved once, like the other two.
   *
   * A `null` here is the *expected* state on a machine with no Google credentials, so the lookup
   * failing is logged at debug-adjacent severity and the five youtube handlers each have a
   * defined answer. Nothing about it touches OBS, the overlay or the cameras: a Verger with no
   * YouTube at all is a fully working camera switcher and overlay controller.
   */
  const youtube: YouTubeServiceLike | null = resolveYouTubeService()

  function resolveYouTubeService(): YouTubeServiceLike | null {
    if (deps.youtube !== undefined) return deps.youtube
    try {
      return getYouTubeService()
    } catch (cause) {
      log.warn('the YouTube service is unavailable; youtube IPC will report NOT_CONFIGURED', {
        cause
      })
      return null
    }
  }

  /**
   * The go-live orchestrator, or `null` if there is not one. Resolved once, like the other three.
   *
   * Resolved *separately* from the OBS client, and that separation is load-bearing: if this
   * lookup fails, `deps.obs` is untouched and OBS carries on doing whatever it was doing. The
   * orchestrator is a thing that presses OBS's buttons for the operator, not a thing OBS depends
   * on, and a `null` here must never read as "the broadcast is off".
   */
  const goLive: GoLiveServiceLike | null = resolveGoLiveService()

  function resolveGoLiveService(): GoLiveServiceLike | null {
    if (deps.goLive !== undefined) return deps.goLive
    try {
      return getGoLiveService()
    } catch (cause) {
      log.warn('the go-live service is unavailable; go-live IPC will report NOT_CONNECTED', {
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

  // The camera fan-out is a *separate* subscription pushing a *separate* payload type on a
  // *separate* channel. Nothing here reads or writes overlay state, so a scene change — whether
  // Verger asked for it or the operator hit a hotkey inside OBS — moves `activeSlot` and
  // literally nothing else. That is the independence guarantee, wired.
  if (camera !== null) {
    try {
      registerUnsubscribe(
        camera.onState((state) => {
          broadcast(IpcEvent.cameraState, state)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the camera service', { cause })
    }
  }

  // The YouTube fan-out. `YouTubeStatus` is a whole snapshot — auth, broadcast, stream, template
  // and the pre-flight issues — pushed on every change, so a control window that reloads
  // mid-service recovers with one `getStatus()` exactly as the overlay and camera panels do.
  //
  // What is pushed here is precisely what `getStatus()` returns, and that type has no field for a
  // token or a stream key. The event carries no credential because there is no credential in the
  // type to carry.
  if (youtube !== null) {
    try {
      registerUnsubscribe(
        youtube.onStatus((status) => {
          broadcast(IpcEvent.youtubeStatus, status)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the YouTube service', { cause })
    }
  }

  // The go-live fan-out. `GoLiveState` is a whole snapshot — phase, all five step statuses, the
  // observed OBS output state, `liveSince`, `lastError` and `reattached` — pushed on every
  // change, so the LIVE indicator follows the sequence step by step without polling and a control
  // window that reloads mid-service recovers with one `getState()`.
  //
  // This subscription is also how a *re-attach* reaches the UI: when Verger launches into an OBS
  // that is already streaming, the service adopts that state and pushes it here with
  // `reattached: true`, and the operator sees "already live" rather than an idle button that
  // would start a second stream (Standing Rule 2 — OBS owns that state).
  if (goLive !== null) {
    try {
      registerUnsubscribe(
        goLive.onState((state) => {
          broadcast(IpcEvent.goLiveState, state)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the go-live service', { cause })
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

  // --- camera (BLUEPRINT.md §6) --------------------------------------------

  safeHandle(IpcChannel.cameraGetConfig, noArg, async () => {
    if (camera === null) return cameraUnavailable()
    return resolveCall(camera.getConfig())
  })

  safeHandle(IpcChannel.cameraSetConfig, cameraConfigArg, async (config) => {
    if (camera === null) return cameraUnavailable()
    return resolveCall(camera.setConfig(config))
  })

  safeHandle(IpcChannel.cameraGetState, noArg, async () => {
    if (camera === null) return cameraUnavailable()
    return resolveCall(camera.getState())
  })

  /**
   * The one-tap camera switch.
   *
   * Three lines, and every one of them matters. `cameraSelectArg` has already rejected any slot
   * outside `CAMERA_SLOTS`, so the service is only ever handed one of four known ids. Whether
   * that slot is *bound* to a scene is the service's call — it holds the config, and firing
   * `SetCurrentProgramScene` for a scene that does not exist is the failure this contract's
   * `isBindingUsable()` exists to prevent.
   *
   * And note the absence: no overlay lookup, no `overlay.send`, no clearing of anything. A
   * camera switch resolves with a `CameraState` and leaves every overlay layer exactly where the
   * operator put it.
   */
  safeHandle(IpcChannel.cameraSelect, cameraSelectArg, async ({ slot }) => {
    if (camera === null) return cameraUnavailable()
    return resolveCall(camera.select(slot))
  })

  // --- youtube (BLUEPRINT.md §5, Part A) -----------------------------------
  //
  // Five channels, and between them they can return exactly two shapes: `YouTubeStatus` and
  // `Broadcast`. Neither has a token field and neither has a stream-key field, which is the
  // security property of this whole block — it is enforced by `@shared/youtube` and by the
  // `YouTubeServiceLike` seam above, not by care taken in these bodies.
  //
  // Nothing here logs a payload. `signIn` in particular never sees the OAuth code (that stays
  // inside the service's loopback handler) and never returns a token, so there is nothing for a
  // future `log.debug('signed in', { result })` to leak — but there is also no such line.

  safeHandle(IpcChannel.youtubeGetStatus, noArg, async () => {
    if (youtube === null) return youtubeUnavailable()
    return resolveCall(youtube.getStatus())
  })

  /**
   * Sign in.
   *
   * The whole loopback OAuth dance — ephemeral port on 127.0.0.1, `state` parameter, consent in
   * the system browser — lives in the service. This handler's entire job is to start it and hand
   * back the resulting status, because the trust boundary is here and the credential handling is
   * not. A user who cancels the consent screen gets `auth.state: 'auth-error'` with a message,
   * not an exception.
   */
  safeHandle(IpcChannel.youtubeSignIn, noArg, async () => {
    if (youtube === null) return youtubeUnavailable()
    return resolveCall(youtube.signIn())
  })

  safeHandle(IpcChannel.youtubeSignOut, noArg, async () => {
    if (youtube === null) return youtubeUnavailable()
    return resolveCall(youtube.signOut())
  })

  safeHandle(IpcChannel.youtubeSetTemplate, broadcastTemplateArg, async (template) => {
    if (youtube === null) return youtubeUnavailable()
    return resolveCall(youtube.setTemplate(template))
  })

  /**
   * Create the weekly broadcast and bind the persistent stream.
   *
   * Note the boundary this handler does *not* cross: it creates and binds, and stops. No
   * `StartStream`, no `StartRecord`, no transition to live — that orchestration is Phase 5's, and
   * the seam above cannot even name those verbs.
   *
   * `scheduledStartTime` is optional and, when absent, the key is omitted rather than sent as
   * `undefined`; the service picks the default from the template's time zone.
   */
  safeHandle(IpcChannel.youtubeCreateBroadcast, createBroadcastArg, async (options) => {
    if (youtube === null) return youtubeUnavailable()
    return resolveCall(youtube.createBroadcast(options))
  })

  // --- go live (BLUEPRINT.md §5, Part B) -----------------------------------
  //
  // Three channels, none of which takes an argument, and that is the whole enforcement of
  // Standing Rule 3 at this boundary: `goLiveStart` has no payload, so there is no field a
  // renderer could set to skip the local recording, and `noArg` refuses anything sent anyway.
  // The seam it calls has no recording verb either. Local recording is not a default here that
  // something could override — it is unreachable from this process boundary.
  //
  // `goLiveStart` and `goLiveEnd` are the two most consequential operations in the app: one puts
  // a congregation's service on the public internet, the other takes it off. Both are logged at
  // info level with who asked and when, *before* anything is attempted, so the rolling log
  // answers "when did we go live, and did the button actually get pressed?" even if the sequence
  // then failed or the process died mid-way. The request log is written even when the service is
  // unavailable — the operator pressing the button is the fact worth recording, not the outcome.
  //
  // Neither handler ever reacts to a failure by stopping anything. There is no `catch` here that
  // calls `stop`, no cleanup path, no rollback. If `start` returns an error, OBS is very probably
  // still streaming and recording and that is *correct*: the operator is told plainly and decides
  // for themselves whether to retry or drive OBS by hand. Verger must never wedge the broadcast
  // as a reaction to its own error.

  safeHandle(IpcChannel.goLiveGetState, noArg, async () => {
    if (goLive === null) return goLiveUnavailable()
    return resolveCall(goLive.getState())
  })

  /**
   * GO LIVE.
   *
   * Everything the sequence actually does — create/bind the broadcast, `StartStream`,
   * `StartRecord`, poll health, transition to `live` — lives in the service. This handler starts
   * it, logs that it was started, and reports what came back.
   *
   * The recording is not mentioned in this body because there is nothing here that could choose
   * about it. It is not conditional, it is not a parameter and it is not a step this layer can
   * skip; `start()` takes no argument and the seam has no `startRecord`. That is Standing Rule 3
   * expressed as the shape of a function rather than as a comment somebody has to obey.
   */
  safeHandle(IpcChannel.goLiveStart, noArg, async (_arg, event) => {
    log.info('GO LIVE requested', {
      channel: IpcChannel.goLiveStart,
      who: describeSender(event),
      at: new Date(now()).toISOString()
    })

    if (goLive === null) {
      log.warn('GO LIVE could not run: the go-live service is unavailable', {
        detail: 'the operator can still start streaming and recording from OBS directly'
      })
      return goLiveUnavailable()
    }

    const result = await resolveCall(goLive.start())
    logGoLiveOutcome('GO LIVE', result)
    return result
  })

  /**
   * END.
   *
   * Only ever operator-initiated. Nothing else in this process calls it: no timer, no health
   * check, no error path anywhere in this file ends a broadcast. Ending a service by accident is
   * unrecoverable — the congregation saw it end — which is why the renderer gates this behind a
   * held button (`endRequiresHold` in `@shared/golive`) and why the audit line below is written
   * before the attempt rather than after it.
   */
  safeHandle(IpcChannel.goLiveEnd, noArg, async (_arg, event) => {
    log.info('END requested', {
      channel: IpcChannel.goLiveEnd,
      who: describeSender(event),
      at: new Date(now()).toISOString()
    })

    if (goLive === null) {
      log.warn('END could not run: the go-live service is unavailable', {
        detail: 'the operator can still stop streaming and recording from OBS directly'
      })
      return goLiveUnavailable()
    }

    const result = await resolveCall(goLive.end())
    logGoLiveOutcome('END', result)
    return result
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

  /**
   * The "who" half of the GO LIVE / END audit line.
   *
   * Verger is a one-operator app, so "who" is really "which window", and the top-level frame URL
   * is the only identity this structural seam has. It is a `file://` or dev-server URL — the
   * sender has already been proven to be a window this process created — so there is nothing
   * sensitive in it, and having it in the log distinguishes an operator press from anything that
   * somehow got through by another route.
   */
  function describeSender(event: IpcInvokeEventLike): string {
    return event.senderFrame?.url ?? 'unknown-window'
  }

  /**
   * The outcome half.
   *
   * Logs the resulting phase on success — `partial` in particular, which means OBS is streaming
   * and recording but YouTube never transitioned, and is the single most valuable line in the
   * log when someone asks afterwards why the stream was not public. A failure is logged at
   * `error` and is *only* a log: nothing here stops an output.
   */
  function logGoLiveOutcome(what: string, result: Result<GoLiveState>): void {
    if (result.ok) {
      log.info(`${what} finished`, {
        phase: result.value.phase,
        streaming: result.value.obs.streaming,
        recording: result.value.obs.recording,
        reattached: result.value.reattached
      })
      return
    }
    log.error(`${what} failed; OBS was left exactly as it was`, {
      code: result.error.code,
      message: result.error.message
    })
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
    overlay: overlay === null ? 'unavailable' : 'attached',
    camera: camera === null ? 'unavailable' : 'attached',
    youtube: youtube === null ? 'unavailable' : 'attached',
    goLive: goLive === null ? 'unavailable' : 'attached'
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

    // Covers the OBS status/scene-list subscriptions, the overlay state/info ones, the camera
    // state one, the YouTube status one and the go-live state one alike: all of them were pushed
    // onto `unsubscribers` by `registerUnsubscribe`, so no subsystem is left holding a listener
    // into a disposed bridge — a YouTube poll that outlived the bridge would keep pushing at dead
    // windows for the rest of the process, and the go-live poller is a health loop that runs at
    // its fastest precisely while a service is on air.
    //
    // Unsubscribing is all this does. It does not stop the stream, it does not stop the
    // recording, and it must never learn to: a hot reload or a window close is not a reason to
    // take a congregation's service off the air.
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
