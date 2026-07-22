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
 *  - **Standing Rule 4 / BLUEPRINT.md §7 — no copyrighted text crosses this boundary.**
 *    `servicePlanArg` does not pass a parsed plan through; it *rebuilds* every cue payload from
 *    `cuePayloadSchemas`, so fields that no payload type declares — a `text` smuggled onto a
 *    scripture cue, slide text pasted into a slide payload — are dropped at the process boundary
 *    rather than persisted into a plan file. `DeckImportProgress` has no content field either, so
 *    the import feed cannot carry slide text even while a deck is being converted.
 *  - **Standing Rule 1 / BLUEPRINT.md §4 — a dead recogniser never blocks the operator.** The
 *    seven `asr:*` handlers all resolve; an absent ASR service answers `NOT_CONFIGURED` (and a
 *    renderable red status for `asrGetStatus`) and changes nothing else — the plan still advances
 *    on SPACE, the cameras still switch, OBS still streams. `asrPushAudio` is the one channel on
 *    this boundary that is not zod-parsed, not logged per call and not rate-limited: it fires ten
 *    times a second for the length of a service, and the reasoning is written out at
 *    `audioChunkArg`.
 *  - **Standing Rule 1 / BLUEPRINT.md §4 — the cue engine cannot act from here.** The ten `cue:*`
 *    handlers can read the engine, tune it, accept or reject a *named* suggestion, and switch it
 *    off. There is no `cueFire`: the engine emits intents and something else applies them, which is
 *    what makes a veto instant. `cuePanic` is the one handler in this file that never returns an
 *    `Err` — an operator hitting the panic switch must never meet an error dialog — and it halts
 *    automation without touching OBS, the stream, the recording, the overlay or the plan pointer,
 *    because `CueEngineLike` has no verb for any of them.
 *  - **Untrusted file paths are checked before the plan service sees them.** The renderer is the
 *    less-trusted side, and `planOpen`/`planSave`/`planImportDeck` name files on disk. A supplied
 *    path must be absolute, carry the expected extension and (for a read) actually be a file;
 *    with no path at all the *main* process opens the native dialog, because the trusted side is
 *    the side that should be choosing. A cancelled dialog is an ordinary `Ok` carrying the
 *    unchanged state — never an exception, never an error toast.
 *  - **BLUEPRINT.md §9 — no recovery action may ever stop the stream or the recording.** The two
 *    `health:*` action channels rewind *automation* (`healthRestoreCheckpoint`) and ask browser
 *    sources to reload (`healthReloadOverlays`). None of the three health seams —
 *    `HealthServiceLike`, `CheckpointStoreLike`, `OverlayReloadLike` — has a `stopStream`, a
 *    `stopRecord` or a `disconnect`, so neither action can reach an OBS output on any path,
 *    success or failure. Recovering from a failure must never cost more than the failure did.
 */

import { statSync } from 'node:fs'
import { extname, isAbsolute, resolve as resolvePath } from 'node:path'

import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { z } from 'zod'

import { getAsrService } from '@main/asr'
import { getCameraService } from '@main/camera'
import { summarize } from '@main/config/env'
import { getCueEngine, getScriptureResolver } from '@main/cue'
import { getGoLiveService } from '@main/golive'
import { getCheckpointStore, getHealthService } from '@main/health'
import { getOverlayServer } from '@main/overlay'
import { getPlanService } from '@main/plan'
import { getSecretsStore } from '@main/secrets/secrets'
import { getYouTubeService } from '@main/youtube'
import {
  ASR_BITS_PER_SAMPLE,
  ASR_CHANNELS,
  ASR_SAMPLE_RATE,
  asrSettingsSchema,
  idleAsrStatus
} from '@shared/asr'
import type { AsrSettings, AsrStatus, AudioInputDevice, TranscriptSegment } from '@shared/asr'
import { CAMERA_SLOTS, cameraConfigSchema } from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { AppConfig } from '@shared/config'
import { obsConfigSchema } from '@shared/config'
import { TRUST_MODES, cueEngineSettingsSchema, idleCueEngineState } from '@shared/cue'
import type { CueEngineSettings, CueEngineState, CueSuggestion, TrustMode } from '@shared/cue'
import type { GoLiveState } from '@shared/golive'
import { SUBSYSTEMS, initialHealth, worstLevel } from '@shared/health'
import type { Checkpoint, HealthSnapshot, SubsystemHealth } from '@shared/health'
import { IPC_CHANNEL_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type {
  AppVersions,
  DeckImportProgress,
  DeckImporterStatus,
  IpcChannelValue,
  IpcEventValue,
  IpcRequest,
  IpcResponse,
  OverlayServerInfo,
  PlanState,
  Unsubscribe
} from '@shared/ipc'
import type { LogRecord } from '@shared/log'
import type { Logger } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { overlayCommandSchema } from '@shared/overlay'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { cuePayloadSchemas, servicePlanSchema } from '@shared/plan'
import type { Cue, CueOptions, CuePayload, CueTrigger, CueType, ServicePlan } from '@shared/plan'
import { err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'
import { scriptureReferenceSchema } from '@shared/scripture'
import type { ResolvedScripture, ScriptureReference, TranslationSource } from '@shared/scripture'
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

/**
 * The minimum this module needs from the plan service (`src/main/plan`).
 *
 * The Service Plan is BLUEPRINT.md §7, and this seam is deliberately shaped around the **manual**
 * driver rather than around the automation that Phase 8 will layer on top:
 *
 *  - `advance()` and `back()` take no argument and `fireCue()` takes only an id, so an operator
 *    holding SPACE can drive an entire service through three methods with no ASR, no cue engine
 *    and no network. That path is the fallback everything else degrades to, so it is the path
 *    this boundary is built for.
 *  - Every verb resolves with a whole `PlanState` — plan, position, file path, dirty flag and the
 *    last-fired cue — for the same reason the overlay and go-live seams do: a boolean cannot say
 *    "the plan advanced but the asset was missing", and a control window that reloads mid-service
 *    must recover from one snapshot.
 *  - `open`/`save`/`importDeck` take a path that has **already been chosen and validated** by the
 *    handlers below. The service is never handed a raw renderer string, and it is never asked to
 *    open a dialog: dialogs belong to the process that owns the windows.
 *
 * Note what the seam cannot express: there is no method that returns slide *text*. A deck import
 * yields slide cues whose payloads name image assets, and `DeckImportProgress` carries a stage and
 * two counters. Standing Rule 4 holds here because no type crossing this boundary has a field for
 * slide or verse content.
 */
export interface PlanServiceLike {
  /** The current snapshot. Cheap and never fails — the panel renders this on every change. */
  getState(): ClientCall<PlanState>
  /** Replace the authored plan wholesale (the editor's save path). */
  setPlan(plan: ServicePlan): ClientCall<PlanState>
  /** Load a plan from an absolute, already-validated path. */
  open(path: string): ClientCall<PlanState>
  /** Write the plan to an absolute, already-validated path. */
  save(path: string): ClientCall<PlanState>
  /** Convert a .pptx at an absolute, already-validated path into one slide cue per slide. */
  importDeck(path: string): ClientCall<PlanState>
  /** Fire one cue by id. The operator's out-of-order override. */
  fireCue(cueId: string): ClientCall<PlanState>
  /** Fire the next cue. The SPACE key. */
  advance(): ClientCall<PlanState>
  /** Step back one cue. The one-tap undo for a mis-fire. */
  back(): ClientCall<PlanState>
  /** Whether a deck converter exists on this machine, and what to install if not. */
  getImporterStatus(): ClientCall<DeckImporterStatus>
  onState(listener: (state: PlanState) => void): Unsubscribe | void
  onImportProgress(listener: (progress: DeckImportProgress) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the ASR service (`src/main/asr`).
 *
 * Structural for the strongest reason of any seam in this file: the concrete service owns a
 * Deepgram websocket *and* a Python child process running faster-whisper on a GPU. **No test in
 * this repo may make a network call**, there is no `DEEPGRAM_API_KEY` on this machine, and a
 * local model load is a multi-second, multi-gigabyte affair. Nine methods against a plain object
 * instead, and the whole IPC contract is provable with zero network and zero audio.
 *
 * Read the shape as three separate claims:
 *
 *  - **Audio flows renderer -> main, and only that way.** `pushAudio` takes a chunk; nothing here
 *    returns one, and `TranscriptSegment` has no field that could carry a sample. Capture lives in
 *    the renderer because only the renderer has `getUserMedia` — Electron's main process has no
 *    microphone without a native module — so `listDevices` is the renderer *reporting* what it
 *    enumerated rather than the main process asking.
 *  - **`pushAudio` is the hot path and is shaped like one.** It fires every `ASR_CHUNK_MS`, ten
 *    times a second for the length of a service. It takes a bare `ArrayBuffer`, it resolves with
 *    `void`, and the handler below neither zod-parses it nor logs it. See `audioChunkArg`.
 *  - **`onStatus` and `onTranscript` are separate feeds because they degrade separately.** A
 *    `degraded` status (the local adapter took over from a dead Deepgram) still has transcript
 *    flowing; a `failed` one does not. Collapsing them would hide a fallback the operator needs to
 *    see, so the status feed keeps pushing whether or not segments are arriving.
 *
 * Note what the seam cannot express: there is no `getAudio`, no `getBuffer`, no transcript
 * history. This layer forwards one segment at a time and keeps nothing.
 */
export interface AsrServiceLike {
  /** The whole status light in one struct — state, provider, latency, device, error. Never throws. */
  getStatus(): ClientCall<AsrStatus>
  getSettings(): ClientCall<AsrSettings>
  /** Persist operator settings (provider mode, language, device, custom vocabulary, model). */
  setSettings(settings: AsrSettings): ClientCall<AsrSettings>
  /** Begin recognising. Resolves with the resulting status, including a failed one. */
  start(): ClientCall<AsrStatus>
  /** Stop recognising. Never touches OBS, the stream or the recording. */
  stop(): ClientCall<AsrStatus>
  /**
   * One PCM chunk, 16 kHz mono s16le. Called ~10x/second while a service is running.
   *
   * A `Uint8Array` rather than an `ArrayBuffer` because that is what the recogniser actually
   * wants — both providers write bytes to a socket or a stdin pipe — and wrapping a validated
   * buffer in a view is free, where copying it would not be.
   */
  pushAudio(chunk: Uint8Array): ClientCall<void>
  /** The inputs the renderer enumerated, so the settings panel can list them. */
  listDevices(devices: readonly AudioInputDevice[]): ClientCall<void>
  onStatus(listener: (status: AsrStatus) => void): Unsubscribe | void
  onTranscript(listener: (segment: TranscriptSegment) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the cue engine (`src/main/cue`).
 *
 * BLUEPRINT.md §4. This is the most dangerous seam in the file, and its shape is where several of
 * the phase's safety rules stop being prose:
 *
 *  - **There is no `fire`, no `apply`, no `show`.** The engine produces `CueSuggestion`s — an
 *    *intent* — and something else applies them. The only verbs reachable from the process
 *    boundary are `confirm` and `dismiss`, and both name a specific `suggestionId`. That id is
 *    what makes a veto instant: `syncToActual` (in `@shared/cue`) drops the pending suggestion the
 *    moment the plan moves by any other means, so a confirm that was already in flight when the
 *    operator advanced by hand names a suggestion that no longer exists and does nothing. The
 *    operator taking over manually does not race a suggestion formed a second ago; they win by
 *    construction.
 *  - **Nothing here can make automation more dangerous than the mode allows.** `setMode` is the
 *    entire dial. A cue's own `confirmAlways`, a below-threshold confidence and an unresolved
 *    verse each BLOCK an auto-fire (`shouldAutoFire`, `canAutoShow`); there is no verb on this
 *    seam that compels one, and adding one would mean widening this interface first.
 *  - **`panic()` takes no argument and `resume()` is separate.** Panic halts automation and
 *    nothing else — the seam has no OBS verb, no output verb and no overlay verb, so it is
 *    structurally incapable of touching the stream or the recording. Automation coming back on its
 *    own would be exactly the surprise the switch exists to prevent, so re-engaging is a distinct,
 *    explicitly operator-initiated call.
 *  - **`resolveScripture` returns text; nothing in this repository authors it.** Standing Rule 4.
 *    The detectors emit `ScriptureReference`s, which have no text field at all; a
 *    `ResolvedScripture` is produced at runtime by a licensed API or a verified public-domain
 *    source, and `listTranslations` is how the UI learns which of those are actually selectable —
 *    a translation whose public-domain status is unconfirmed reports `verified: false` and must
 *    never be offered.
 *
 * Structural, like every other seam here, and for the usual binding reason: the concrete engine
 * consumes a live transcript and may reach a network resolver, and no test in this repo may do
 * either. The whole IPC contract is provable against a plain object.
 */
export interface CueEngineLike {
  /** The whole engine in one struct — mode, alignment, position, pending, recent, panicked. */
  getState(): ClientCall<CueEngineState>
  getSettings(): ClientCall<CueEngineSettings>
  /**
   * Persist operator settings — the trust mode, the hot phrases, the thresholds, the translation.
   *
   * Already validated and length-bounded by the time it arrives; see `cueSettingsArg`.
   */
  setSettings(settings: CueEngineSettings): ClientCall<CueEngineSettings>
  /** The trust dial. Resolves with the resulting state so the UI never guesses at the mode. */
  setMode(mode: TrustMode): ClientCall<CueEngineState>
  /** Accept a specific pending suggestion. A stale id is a no-op, not a mis-fire. */
  confirm(suggestionId: string): ClientCall<CueEngineState>
  /** Reject a specific pending suggestion. */
  dismiss(suggestionId: string): ClientCall<CueEngineState>
  /** Halt all automation. Never touches OBS, the stream, the recording or the overlay. */
  panic(): ClientCall<CueEngineState>
  /** Re-engage automation after a panic. Operator-initiated only, always. */
  resume(): ClientCall<CueEngineState>
  onState(listener: (state: CueEngineState) => void): Unsubscribe | void
  onSuggestion(listener: (suggestion: CueSuggestion) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the scripture resolver (`src/main/cue/ScriptureResolver`).
 *
 * A *separate* seam from `CueEngineLike`, and separate on purpose rather than by accident. The
 * engine resolves verse text as an internal step of firing a scripture cue — that is its own
 * business, behind its own private method. What the two `cue:*` scripture channels need is
 * something different: an on-demand lookup the operator drives (they tapped a detected reference
 * and want to see it before deciding) and the catalogue of what this machine may legally offer.
 * Wiring those through the engine would mean widening the engine's public surface for the benefit
 * of a panel, and the panel does not need the engine at all.
 *
 * The split also means the two degrade independently, which is the behaviour Standing Rule 5 asks
 * for: an engine with no resolver still follows the plan and still fires hot phrases, and a
 * resolver with no engine still answers "what does John 3:16 say?" for a manual operator.
 *
 * Note what crosses in each direction. In: a `ScriptureReference` — a type with no text field. Out:
 * a `ResolvedScripture` the resolver obtained **at runtime** from a licensed API or a verified
 * public-domain download. Standing Rule 4 holds because no verse text is authored in this
 * repository, and `listTranslations` is where the quarantine rule lives — a translation whose
 * public-domain status is contested (the Korean KRV) is absent from that list rather than present
 * and disabled, so nothing downstream can select it.
 */
export interface ScriptureResolverLike {
  resolve(reference: ScriptureReference, translation?: string): ClientCall<ResolvedScripture>
  /** What this machine may actually offer. Quarantined translations are absent, not disabled. */
  listTranslations(): ClientCall<readonly TranslationSource[]>
}

/**
 * The minimum this module needs from the health aggregator (`src/main/health`).
 *
 * BLUEPRINT.md §9. Two methods, and note that **neither of them changes anything**. The aggregator
 * observes; it has no verb that acts, which is why the two recovery channels below reach two
 * *different* seams to do their work and come back here only to read the result.
 *
 *  - **`getSnapshot` is the whole dashboard in one struct.** One strip of lights read across a dark
 *    room, with `worst` rolled up so the operator can answer "is anything wrong?" without parsing
 *    seven of them.
 *  - **`onSnapshot` is a push feed, not a poll.** A subsystem degrades on its own schedule — an
 *    RTMP link drops mid-sermon, Deepgram stops answering and the local recogniser takes over —
 *    and every one of those has to light up without anybody pressing anything.
 *
 * Structural, like every other seam here, and for the binding reason: the concrete aggregator
 * watches a real overlay socket, a real OBS client and a real recogniser, none of which exist on
 * the build machine. Every failure below is simulated against a plain object.
 */
export interface HealthServiceLike {
  /** The whole dashboard in one struct. Cheap, and never throws. */
  getSnapshot(): ClientCall<HealthSnapshot>
  onSnapshot(listener: (snapshot: HealthSnapshot) => void): Unsubscribe | void
}

/**
 * The minimum this module needs from the checkpoint store (`src/main/health/checkpoints`).
 *
 * A *separate* seam from `HealthServiceLike`, and separate for the same reason the scripture
 * resolver is separate from the cue engine: recording and rewinding automation is a different job
 * from observing it, and the aggregator deliberately has no verb that changes anything. They also
 * degrade independently — a dashboard with no checkpoint store still lights up, and a store with
 * no dashboard still rewinds.
 *
 * Read the shape as the phase's central rule expressed as a type. There is no `stopStream`, no
 * `stopRecord`, no `disconnect` and no `restart`: `restore` moves the plan pointer back and
 * nothing else, and `Checkpoint` has no field naming the stream or the recording, so there is
 * nothing on this boundary that could describe undoing a broadcast. A broadcast cannot be undone —
 * the congregation saw it — which is exactly why a recovery path must not try.
 */
export interface CheckpointStoreLike {
  /** The retained checkpoints, newest first. Bounded by `MAX_CHECKPOINTS`. */
  list(): ClientCall<readonly Checkpoint[]>
  /**
   * Rewind AUTOMATION state to a checkpoint. Never touches the stream or the recording.
   *
   * An id that names no retained checkpoint is an ordinary `Err`, not a throw and not a silent
   * no-op: an operator who asked to rewind and got nothing must be told, because they are about to
   * act on the assumption that it happened.
   */
  restore(checkpointId: string): ClientCall<Checkpoint>
}

/**
 * The minimum this module needs to force attached overlay browser sources to reload.
 *
 * In production this is the overlay watchdog constructed in `src/main/index.ts`. It is a third
 * seam rather than a method on either of the two above because it is the only recovery verb that
 * reaches *out* of the process, and because the watchdog's primary duty — making a dropped browser
 * source visible — must keep working on a machine where no reload channel is wired at all.
 *
 * A reload is the safe half of the "overlay browser source crashes" row in BLUEPRINT.md §9: the
 * server holds the authoritative `OverlayState`, so a source that reconnects is sent the current
 * snapshot and comes back showing exactly what it was showing. It asks a *page inside OBS* to
 * reload; it does not ask OBS to do anything, and it cannot interrupt an encoder that is
 * mid-stream.
 */
export interface OverlayReloadLike {
  /** Ask every attached overlay page to reload and re-sync from the cached snapshot. */
  reloadNow(): ClientCall<unknown>
}

/** The slice of Electron's `OpenDialogReturnValue` used here. */
export interface OpenDialogResultLike {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

/** The slice of Electron's `SaveDialogReturnValue` used here. */
export interface SaveDialogResultLike {
  readonly canceled: boolean
  readonly filePath?: string
}

/**
 * The slice of Electron's `dialog` module used by the three path-bearing plan channels.
 *
 * Structural for the usual reason — no test in this repo may need an Electron runtime, and a
 * modal dialog is the one thing a headless test can never dismiss — but also because it makes the
 * *cancelled* branch trivially reachable in a test, and cancelling is the common case rather than
 * the exceptional one. An operator who opens the file picker and changes their mind must get a
 * plain unchanged state back, not an error toast in the middle of a service.
 *
 * Option fields are the subset Verger sets, typed loosely enough that Electron's real `dialog`
 * satisfies this interface without a cast.
 */
export interface DialogLike {
  showOpenDialog(options: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
    properties?: 'openFile'[]
  }): Awaitable<OpenDialogResultLike>
  showSaveDialog(options: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
  }): Awaitable<SaveDialogResultLike>
}

/** What is at a path right now. `missing` also covers "we could not tell". */
export type PathKind = 'file' | 'directory' | 'missing'

/**
 * The filesystem probe used to check a path before the plan service sees it.
 *
 * A path is the one argument on this boundary that names something *outside* the process, so it
 * gets checked against the real filesystem rather than only against a regex. Injectable so the
 * tests can prove the acceptance rules — absolute, right extension, really a file — without
 * writing to disk.
 */
export interface FilePathProbeLike {
  /** Never throws. A permission error, a broken symlink and an absent file all read `missing`. */
  kind(path: string): PathKind
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
  /**
   * The Service Plan service (BLUEPRINT.md §7).
   *
   * Optional for exactly the reason the other four are: `src/main/index.ts` calls
   * `registerIpc({ config, logger, obs, overlay, youtube, goLive })` and a required eighth key
   * would fail to compile. Defaults to the process-wide singleton from `@main/plan`; if that
   * cannot be resolved the nine plan handlers degrade to `Err(NOT_CONNECTED)` and the rest of
   * Verger is untouched — cameras still switch, overlays still fire, OBS still streams
   * (Standing Rule 5).
   *
   * Pass `null` to say "there is no plan service" explicitly and skip the default lookup.
   */
  readonly plan?: PlanServiceLike | null
  /**
   * The ASR service (BLUEPRINT.md §4 and §8).
   *
   * Optional for exactly the reason the other five are: `src/main/index.ts` calls
   * `registerIpc({ config, logger, obs, overlay, youtube, goLive, plan })` and a required ninth
   * key would fail to compile. Defaults to the process-wide singleton from `@main/asr`.
   *
   * A `null` here is the *ordinary* state rather than an exceptional one. There is no
   * `DEEPGRAM_API_KEY` on a fresh checkout and there may be no usable GPU, so the seven asr
   * handlers each have a defined answer and the rest of Verger is untouched: cameras still switch,
   * overlays still fire, the plan still advances on SPACE, OBS still streams. A dead recogniser
   * must never block the operator — it goes red and the service runs manual (Standing Rules 1
   * and 5).
   *
   * Pass `null` to say "there is no ASR service" explicitly and skip the default lookup.
   */
  readonly asr?: AsrServiceLike | null
  /**
   * The cue engine (BLUEPRINT.md §4).
   *
   * Optional for exactly the reason the other six are: `src/main/index.ts` calls
   * `registerIpc({ config, logger, obs, overlay, youtube, goLive, plan })` and a required tenth key
   * would fail to compile. Defaults to the process-wide singleton from `@main/cue`.
   *
   * A `null` here is the *ordinary* state rather than an exceptional one, and it costs the operator
   * nothing that matters. The engine is an assistant: with no engine at all the plan still advances
   * on SPACE, `planFireCue` still fires a cue by hand, the cameras still switch, the overlays still
   * fire and OBS still streams. Standing Rule 1 — the manual path is the one everything degrades
   * to, and nothing in this block sits between a keypress and a cue.
   *
   * Pass `null` to say "there is no cue engine" explicitly and skip the default lookup.
   */
  readonly cue?: CueEngineLike | null
  /**
   * The scripture resolver behind `cueResolveScripture` and `cueListTranslations`.
   *
   * Optional and defaulting to **absent** rather than to a singleton lookup, because resolution is
   * the one cue capability that genuinely may not exist on a given machine: with no `ESV_API_KEY`,
   * no `API_BIBLE_KEY` and no verified public-domain translation downloaded there is nothing to
   * resolve against. The two channels then answer `NOT_CONFIGURED` naming the keys, and every other
   * part of the engine is untouched — the plan-follower and the hot-phrase detector need no
   * scripture at all, and a detected reference is still offered for the operator to confirm.
   *
   * Kept separate from `cue` so the two degrade independently. See {@link ScriptureResolverLike}.
   */
  readonly scripture?: ScriptureResolverLike | null
  /**
   * The subsystem health service (BLUEPRINT.md §9).
   *
   * Optional for exactly the reason the other seven are: `src/main/index.ts` composes its deps
   * object explicitly and a required key would fail to compile for every caller that predates it.
   * Defaults to the process-wide singleton from `@main/health`.
   *
   * A `null` here costs the operator the *dashboard*, not the service. Every subsystem still runs,
   * still reports its own status on its own channel, and OBS still streams and records; what is
   * lost is the single glanceable roll-up and the two recovery actions. So `healthGet` still
   * answers with a renderable snapshot (every light at `not-configured`, saying so), and the two
   * recovery channels report `NOT_CONFIGURED` rather than pretending to have acted — an operator
   * told "restored" when nothing was restored is worse off than one told nothing happened.
   *
   * Pass `null` to say "there is no health service" explicitly and skip the default lookup.
   */
  readonly health?: HealthServiceLike | null
  /**
   * The checkpoint store behind `healthListCheckpoints` and `healthRestoreCheckpoint`.
   *
   * Optional, defaulting to the process-wide singleton from `@main/health`. Kept separate from
   * `health` so the two degrade independently: a dashboard with no store still lights up, and a
   * store with no dashboard still rewinds. With neither, the plan still advances on SPACE and the
   * one-tap BACK is still there — a checkpoint is a convenience over that, not a replacement for
   * it.
   *
   * Pass `null` to say "there is no checkpoint store" explicitly and skip the default lookup.
   */
  readonly checkpoints?: CheckpointStoreLike | null
  /**
   * The overlay reload channel behind `healthReloadOverlays` — in production, the watchdog.
   *
   * Defaults to **absent** rather than to a singleton lookup, because the watchdog is constructed
   * in the composition root (`src/main/index.ts`) where the overlay server it watches already
   * exists. With none attached the channel reports `NOT_CONFIGURED`; the operator's fallback is
   * OBS's own "Refresh cache of current page" on the browser source, and the overlay's state-based
   * contract means that recovers just as well.
   */
  readonly overlayReload?: OverlayReloadLike | null
  /** Windows to fan events out to, and the set a sender must belong to. */
  readonly getWindows?: () => readonly WindowLike[]
  /** Defaults to Electron's `ipcMain`. */
  readonly ipcMain?: IpcMainLike
  /**
   * The native file dialogs used by `planOpen` / `planSave` / `planImportDeck`.
   *
   * Defaults to Electron's `dialog`. Pass `null` to say there is no dialog at all — the three
   * channels then require an explicit path and report `NOT_CONFIGURED` without one, rather than
   * hanging on a modal that will never appear.
   */
  readonly dialog?: DialogLike | null
  /** Defaults to a `node:fs` probe. Injectable so path acceptance is testable without disk. */
  readonly filePaths?: FilePathProbeLike
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
// Plan argument validation (BLUEPRINT.md §7)
// ---------------------------------------------------------------------------

/**
 * Rebuild one cue payload from the type-specific schema's *output*.
 *
 * This function is the Standing Rule 4 enforcement point on the IPC boundary, and it has to
 * exist as written rather than as a straight `servicePlanSchema.parse`. `cueSchema` types
 * `payload` as `z.record(z.string(), z.unknown())` and checks it against `cuePayloadSchemas` in a
 * `superRefine` — a refinement *validates* and hands the original object back, so unknown keys
 * survive a plain parse. A hand-edited or maliciously-authored plan carrying
 * `payload.text` on a scripture cue would therefore pass validation and reach the service with
 * the verse text still attached.
 *
 * Rebuilding field by field from `cuePayloadSchemas[type]`'s parsed output makes that
 * unrepresentable: `ScripturePayload` has `reference` and `translation` and no third field, so
 * there is nothing here to copy verse text into. A plan carrying scripture text does not fail
 * validation — it simply arrives without it.
 *
 * The field-by-field rebuild is also what satisfies `exactOptionalPropertyTypes`: zod emits
 * `sourceSlide?: number | undefined`, which is not assignable to `SlidePayload`'s
 * `sourceSlide?: number`. Omitting the key is the only assignable form, and it is also the form
 * that round-trips cleanly through `JSON.stringify`.
 *
 * @returns the rebuilt payload, or `null` when it does not match its cue type.
 */
function rebuildCuePayload(type: CueType, raw: Record<string, unknown>): CuePayload | null {
  switch (type) {
    case 'scene': {
      const parsed = cuePayloadSchemas.scene.safeParse(raw)
      return parsed.success ? { scene: parsed.data.scene } : null
    }
    case 'slide': {
      const parsed = cuePayloadSchemas.slide.safeParse(raw)
      if (!parsed.success) return null
      const { asset, sourceSlide } = parsed.data
      return sourceSlide === undefined ? { asset } : { asset, sourceSlide }
    }
    case 'media': {
      const parsed = cuePayloadSchemas.media.safeParse(raw)
      if (!parsed.success) return null
      const { asset, obsInputName } = parsed.data
      return obsInputName === undefined ? { asset } : { asset, obsInputName }
    }
    case 'scripture': {
      const parsed = cuePayloadSchemas.scripture.safeParse(raw)
      if (!parsed.success) return null
      // A reference and a translation code. There is deliberately no third field to copy — see
      // the note above, and `ScripturePayload` in `@shared/plan`.
      const { reference, translation } = parsed.data
      return translation === undefined ? { reference } : { reference, translation }
    }
    case 'lowerthird': {
      const parsed = cuePayloadSchemas.lowerthird.safeParse(raw)
      if (!parsed.success) return null
      const { line1, line2, template } = parsed.data
      const rebuilt: { line1: string; line2?: string; template?: string } = { line1 }
      if (line2 !== undefined) rebuilt.line2 = line2
      if (template !== undefined) rebuilt.template = template
      return rebuilt
    }
    case 'action': {
      const parsed = cuePayloadSchemas.action.safeParse(raw)
      return parsed.success ? { action: parsed.data.action } : null
    }
  }
}

/** Rebuild one cue. `null` when its payload does not match its type. */
function rebuildCue(raw: z.output<typeof servicePlanSchema>['cues'][number]): Cue | null {
  const payload = rebuildCuePayload(raw.type, raw.payload)
  if (payload === null) return null

  const trigger: CueTrigger =
    raw.trigger.text === undefined
      ? { mode: raw.trigger.mode }
      : { mode: raw.trigger.mode, text: raw.trigger.text }

  const cue: {
    id: string
    type: CueType
    label: string
    trigger: CueTrigger
    payload: CuePayload
    options?: CueOptions
    note?: string
  } = { id: raw.id, type: raw.type, label: raw.label, trigger, payload }

  if (raw.options !== undefined) {
    const options: { autoFireThreshold?: number; confirmAlways?: boolean } = {}
    if (raw.options.autoFireThreshold !== undefined) {
      options.autoFireThreshold = raw.options.autoFireThreshold
    }
    if (raw.options.confirmAlways !== undefined) options.confirmAlways = raw.options.confirmAlways
    cue.options = options
  }
  if (raw.note !== undefined) cue.note = raw.note

  return cue
}

/**
 * `planSet`'s payload: a whole authored plan.
 *
 * Validated at the process boundary as well as inside the plan service, for the same reason
 * `overlayCommandArg` is: this is the trust boundary and the service is not. A plan reaching the
 * service is a plan that gets written to disk and driven at a congregation, so it is parsed with
 * `servicePlanSchema` and then *rebuilt* rather than passed through — see `rebuildCuePayload`.
 */
const servicePlanArg: ArgValidator<ServicePlan> = (raw) => {
  const parsed = servicePlanSchema.safeParse(raw)
  if (!parsed.success) {
    return err('INVALID_ARG', 'the service plan failed validation', describeIssues(parsed.error))
  }

  const cues: Cue[] = []
  for (const rawCue of parsed.data.cues) {
    const cue = rebuildCue(rawCue)
    // Unreachable in practice — `cueSchema`'s superRefine has already matched every payload to
    // its type — but a `null` here must never silently drop a cue out of a service order.
    if (cue === null) {
      return err(
        'INVALID_ARG',
        'the service plan failed validation',
        `cues.${cues.length}.payload: does not match cue type "${rawCue.type}"`
      )
    }
    cues.push(cue)
  }

  return ok({
    schemaVersion: 1,
    service: parsed.data.service,
    defaultMode: parsed.data.defaultMode,
    cues,
    assetDir: parsed.data.assetDir
  })
}

/**
 * `planFireCue`'s envelope.
 *
 * Bounded at 64 characters to match `cueSchema`'s own `id` bound: an id that could not appear in
 * a valid plan is refused here rather than turned into a fruitless lookup in the service.
 */
const fireCueArg: ArgValidator<{ cueId: string }> = zodArg(
  z.object({ cueId: z.string().min(1).max(64) })
)

const optionalPathSchema = z
  .object({ path: z.string().min(1).max(1024).optional() })
  .optional()

/**
 * The envelope for `planOpen` / `planSave` / `planImportDeck`.
 *
 * The path is *optional* and omitting it is the normal case — the handler then opens a native
 * dialog. Rebuilt rather than passed through, so `{ path: undefined }` never reaches a request
 * type declaring `path?: string` under `exactOptionalPropertyTypes`, and so "the renderer sent no
 * path" and "the renderer sent an undefined path" collapse into the same, single branch.
 */
const optionalPathArg: ArgValidator<{ path?: string }> = (raw) => {
  const parsed = optionalPathSchema.safeParse(raw)
  if (!parsed.success) {
    return err('INVALID_ARG', 'the request payload failed validation', describeIssues(parsed.error))
  }
  const path = parsed.data?.path
  return ok(path === undefined ? {} : { path })
}

// ---------------------------------------------------------------------------
// ASR argument validation (BLUEPRINT.md §4 and §8)
// ---------------------------------------------------------------------------

/**
 * Operator ASR settings, validated at the process boundary as well as inside the service.
 *
 * `asrSettingsSchema` bounds `customVocabulary` at 500 entries of 80 characters, which is the
 * field that matters here: keyword-boost terms are forwarded verbatim to Deepgram and used to
 * build the local decoder's prompt, so an unbounded list is both a cost and a latency problem in
 * the middle of a service. An invalid settings object is `Err(INVALID_ARG)` and the service is
 * never called at all — a half-typed vocabulary must not be able to replace a working one.
 */
const asrSettingsArg: ArgValidator<AsrSettings> = zodArg(asrSettingsSchema)

/**
 * The device list the renderer enumerated.
 *
 * Bounded rather than trusted: `label` is a string the *operating system* produced from whatever
 * a USB device claimed its name was, and it ends up rendered in the settings panel. 64 devices is
 * already absurd for a church PC; 300 characters is a generous bound on a device name.
 */
const audioDevicesArg: ArgValidator<readonly AudioInputDevice[]> = zodArg(
  z
    .array(
      z.object({
        deviceId: z.string().min(1).max(300),
        label: z.string().max(300)
      })
    )
    .max(64)
)

/** Bytes of PCM per millisecond at the contract's format: 16 kHz x 1 channel x 16 bits = 32. */
const ASR_BYTES_PER_MS = (ASR_SAMPLE_RATE * ASR_CHANNELS * ASR_BITS_PER_SAMPLE) / 8 / 1000

/**
 * The largest audio chunk this boundary will accept: two seconds of PCM.
 *
 * A normal chunk is `ASR_CHUNK_MS` (100 ms) — 3,200 bytes. Twenty times that leaves room for a
 * capture loop that batches a few chunks after a garbage-collection pause without letting a
 * renderer bug (or a compromised one) hand the main process an arbitrarily large buffer to hold.
 */
const MAX_AUDIO_CHUNK_BYTES = ASR_BYTES_PER_MS * 2_000

/**
 * `asrPushAudio`'s argument — and the one validator in this file that is deliberately **not** zod.
 *
 * Every other channel on this boundary is a user action: a button, a dialog, a settings save. They
 * happen a few times a minute and their payloads are small structured objects, so parsing them
 * with zod costs nothing measurable and buys a precise, field-level rejection.
 *
 * This channel is not that. It fires every `ASR_CHUNK_MS` — ten times a second, for the entire
 * length of a service, on the process that also owns the OBS websocket and the overlay server.
 * Handing a 3 KB binary blob to a schema validator ten times a second is pure waste: there are no
 * fields to check, no optional keys to normalise and no shape to describe. What actually needs
 * proving about a chunk is exactly two things — that it *is* a binary buffer, and that it is not
 * absurdly large — and both are a `typeof` and a comparison.
 *
 * The same reasoning is why the handler below does not log per call and is not subject to the
 * `logWrite` token bucket. A per-call log line at 10 Hz would write ~36,000 lines to the rolling
 * file during a one-hour service, and a rate limiter on the *audio* path would silently drop
 * speech — the transcript would develop holes and the operator would have no idea why. Back-
 * pressure belongs in the recogniser, which knows what it can keep up with; this layer's job is to
 * hand the bytes over and get out of the way.
 *
 * A `Uint8Array`/`Buffer` is accepted as well as a bare `ArrayBuffer` because structured clone and
 * the renderer's own capture code can produce either, and the view's region is copied out rather
 * than its whole backing store passed on — a view onto a 1 MB pool must not smuggle the pool.
 */
const audioChunkArg: ArgValidator<ArrayBuffer> = (raw) => {
  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength === 0) {
      return err('INVALID_ARG', 'the audio chunk is empty')
    }
    if (raw.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      return err(
        'INVALID_ARG',
        'the audio chunk is too large',
        `max ${MAX_AUDIO_CHUNK_BYTES} bytes`
      )
    }
    return ok(raw)
  }

  if (ArrayBuffer.isView(raw)) {
    if (raw.byteLength === 0) {
      return err('INVALID_ARG', 'the audio chunk is empty')
    }
    if (raw.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      return err(
        'INVALID_ARG',
        'the audio chunk is too large',
        `max ${MAX_AUDIO_CHUNK_BYTES} bytes`
      )
    }
    // Copy the view's own region only. `Buffer.from(...)` in particular is frequently a window
    // onto a much larger shared pool, and passing `raw.buffer` straight through would hand the
    // recogniser bytes that belong to someone else.
    return ok(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
  }

  // No `detail`: the offending value here is raw microphone audio, and this file's rule is that a
  // validation failure never echoes what caused it.
  return err('INVALID_ARG', 'the audio chunk is not a binary buffer')
}

// ---------------------------------------------------------------------------
// Cue engine argument validation (BLUEPRINT.md §4)
// ---------------------------------------------------------------------------

/**
 * Operator cue-engine settings, validated at the process boundary as well as inside the engine.
 *
 * `cueEngineSettingsSchema` is doing more work here than a shape check. Two of its bounds are
 * safety properties rather than hygiene:
 *
 *  - **`hotPhrases` is capped at 200 entries of 2..120 characters.** Those phrases are matched
 *    against a live transcript continuously, for the length of a service, on the process that also
 *    holds the OBS websocket. They are matched *literally* and case-insensitively by the engine —
 *    they are never compiled into a pattern — so there is no user-supplied quantifier to nest and
 *    no catastrophic-backtracking surface to defend. The bound is what stops the linear scan from
 *    becoming quadratic in operator-supplied data anyway.
 *  - **`autoFireThreshold` is clamped to 0..1.** A threshold outside that range would compare
 *    against confidences that can never reach it (harmless) or that always do (an engine that
 *    auto-fires everything). The second is the failure that cannot be undone in front of a
 *    congregation, so it is refused here rather than normalised somewhere downstream.
 *
 * An invalid settings object is `Err(INVALID_ARG)` and the engine is **never called at all** — a
 * half-typed settings form must not be able to replace a working configuration mid-service.
 */
const cueSettingsArg: ArgValidator<CueEngineSettings> = zodArg(cueEngineSettingsSchema)

/**
 * `cueSetMode`'s envelope — the trust dial.
 *
 * `z.enum(TRUST_MODES)` is the load-bearing part, for the same reason `z.enum(CAMERA_SLOTS)` is on
 * `cameraSelect`: the renderer cannot invent a fourth mode, and an unknown one is
 * `Err(INVALID_ARG)` with the engine never called. A mode string that fell through to the engine
 * and failed an exhaustive `switch` there would leave the dial in an undefined position, which on
 * this particular dial means "nobody can say whether the next suggestion fires itself".
 */
const cueModeArg: ArgValidator<{ mode: TrustMode }> = zodArg(
  z.object({ mode: z.enum(TRUST_MODES) })
)

/**
 * The envelope for `cueConfirm` / `cueDismiss`.
 *
 * The id is *required* — there is deliberately no "confirm whatever is pending" form. A bare
 * confirm would be a race the operator loses: the engine drops its pending suggestion the instant
 * the plan moves by any other means (`syncToActual`), so a confirm formed against the old
 * suggestion must be able to *miss*. Naming the id is what lets it miss instead of firing whatever
 * happens to be pending by the time it arrives.
 *
 * Bounded at 64 characters to match `cueSchema`'s own id bound in `@shared/plan`.
 */
const suggestionIdArg: ArgValidator<{ suggestionId: string }> = zodArg(
  z.object({ suggestionId: z.string().min(1).max(64) })
)

/**
 * `healthRestoreCheckpoint`'s envelope.
 *
 * Bounded at 64 characters to match the id bounds used everywhere else on this boundary. The id
 * is *required* and there is deliberately no "restore the latest" form: a rewind the operator did
 * not name is a rewind they cannot predict, and the whole point of CTRL+D recovery
 * (`docs/v2-notes/SHORTCUTS_AND_A11Y.md`) is that it lands somewhere the operator chose.
 *
 * An id that parses but names no retained checkpoint is *not* rejected here — that is the health
 * service's answer to give, because it is the only thing that knows what it retained.
 */
const checkpointIdArg: ArgValidator<{ checkpointId: string }> = zodArg(
  z.object({ checkpointId: z.string().min(1).max(64) })
)

const resolveScriptureSchema = z.object({
  reference: scriptureReferenceSchema,
  translation: z.string().min(1).max(20).optional()
})

/**
 * `cueResolveScripture`'s envelope.
 *
 * The reference is parsed with `scriptureReferenceSchema` — the same schema the detector's output
 * is described by — so a chapter of 0, a verse of 900 or a `band` outside the three named ones is
 * refused here and the resolver is never called. That matters more than it looks: the resolver
 * turns this struct into a request against a licensed API or a public-domain file, and a reference
 * the detector could not have produced is either a bug or an attempt to make Verger fetch
 * something arbitrary.
 *
 * Rebuilt field by field rather than passed through, for the reason `logRecordArg` is:
 * `exactOptionalPropertyTypes` refuses `{ translation: undefined }` where the request type declares
 * `translation?: string`. Omitting the key is the only assignable form — and it is the form the
 * engine wants, since "absent" means "use the operator's configured translation" rather than
 * "resolve against `undefined`".
 *
 * Note what this validator does *not* do and could not do: there is no verse text on the way in.
 * `ScriptureReference` has no text field, so nothing crossing this boundary in this direction can
 * carry scripture content (Standing Rule 4).
 */
const resolveScriptureArg: ArgValidator<{
  reference: ScriptureReference
  translation?: string
}> = (raw) => {
  const parsed = resolveScriptureSchema.safeParse(raw)
  if (!parsed.success) {
    return err('INVALID_ARG', 'the scripture reference failed validation', describeIssues(parsed.error))
  }
  const { reference, translation } = parsed.data
  return ok(translation === undefined ? { reference } : { reference, translation })
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

/**
 * The answer every plan channel gives when there is no plan service object at all.
 *
 * `NOT_CONNECTED` with a detail that tells the operator the rest of the app still works. A plan
 * service that failed to construct costs the operator their authored cue list — it does not cost
 * them the service. Cameras still switch, lower-thirds still fire, and slides can still be driven
 * from OBS by hand (Standing Rule 5).
 */
function planUnavailable(): Result<never> {
  return err(
    'NOT_CONNECTED',
    'the service plan is not available',
    'cameras, overlays and OBS are unaffected; drive slides from OBS directly'
  )
}

/**
 * What `asrGetStatus` reports when there is no ASR service object at all.
 *
 * A successful `Result` carrying `state: 'not-configured'` rather than an `Err`, for the same
 * reason `overlayGetServerInfo` returns an offline info struct: the transcript panel's whole job
 * is to render this struct, and an operator who sees a red `not-configured` light next to
 * "DEEPGRAM_API_KEY" knows exactly what is wrong. An `Err` here would leave the panel with nothing
 * to draw.
 *
 * `not-configured`, not `failed`. The two are different facts — "there is no recogniser here" is
 * something you fix in settings, "the recogniser died" is something you fix during the service —
 * and `AsrState` keeps them apart deliberately.
 */
function unavailableAsrStatus(detail: string): AsrStatus {
  return { ...idleAsrStatus(), state: 'not-configured', lastError: detail }
}

/**
 * The answer the other six asr channels give when there is no service object at all.
 *
 * `NOT_CONFIGURED`, not `INTERNAL`, and the `detail` is the part that matters: an operator whose
 * transcript never appeared must be told in the same breath that nothing else is affected. ASR is
 * an *assist*; the plan advances on SPACE with no recogniser attached, the cameras switch and the
 * overlays fire. A dead ASR provider must never block the operator (Standing Rules 1 and 5).
 */
function asrUnavailable(): Result<never> {
  return err(
    'NOT_CONFIGURED',
    'speech recognition is not available',
    'set DEEPGRAM_API_KEY in .env or configure the local model; the service runs manually meanwhile'
  )
}

/**
 * The answer the nine non-panic cue channels give when there is no engine object at all.
 *
 * `NOT_CONFIGURED`, not `INTERNAL`, and the `detail` is the whole point: an operator whose
 * suggestion panel is empty must be told, in the same breath, that nothing they actually need has
 * gone. The cue engine is an *assistant*. With no engine at all the plan still advances on SPACE,
 * a cue still fires by hand, the cameras still switch and OBS still streams — which is Standing
 * Rule 1 stated as a fallback rather than as an aspiration.
 *
 * `cuePanic` deliberately does **not** use this. See its handler.
 */
function cueUnavailable(): Result<never> {
  return err(
    'NOT_CONFIGURED',
    'the cue engine is not available',
    'automation is off; the plan still advances on SPACE and cues still fire by hand'
  )
}

/**
 * The answer the two scripture channels give when the engine has no resolver attached.
 *
 * `NOT_CONFIGURED`, and the detail names the two keys, exactly as `youtubeUnavailable` does. With
 * no licensed key and no verified public-domain translation on disk there is nothing to resolve
 * against — that is a configuration fact, not a failure — and the rest of the cue engine is
 * unaffected: the plan-follower and hot-phrase detectors need no scripture at all, and detected
 * references are still offered for the operator to confirm.
 */
function scriptureResolutionUnavailable(): Result<never> {
  return err(
    'NOT_CONFIGURED',
    'scripture resolution is not available',
    'set ESV_API_KEY or API_BIBLE_KEY in .env, or download a verified public-domain translation'
  )
}

/**
 * What `healthGet` reports when there is no health service object at all.
 *
 * A successful `Result` rather than an `Err`, for the same reason `overlayGetServerInfo` and
 * `asrGetStatus` return renderable structs: the dashboard's entire job is to draw this value, and
 * an `Err` would leave the one panel an operator looks at during a failure with nothing to draw.
 *
 * Every light reads `not-configured`, which is the honest answer — Verger does not know how those
 * subsystems are doing, because the thing that watches them was never created. It is deliberately
 * **not** `degraded`: amber means "working, but not as configured", and an amber light that is
 * always on is an amber light an operator learns to ignore (see `@shared/health`).
 */
function unavailableHealthSnapshot(at: number, detail: string): HealthSnapshot {
  const subsystems: readonly SubsystemHealth[] = SUBSYSTEMS.map((id) => ({
    ...initialHealth(id, at),
    detail
  }))
  return { subsystems, worst: worstLevel(subsystems), at }
}

/**
 * The answer the two *recovery* channels give when there is no health service object at all.
 *
 * These two are `Err` where `healthGet` is `Ok`, and the asymmetry is the point. A read that
 * degrades can still say something true. An *action* that degrades must not: an operator told
 * "restored" when nothing was restored, or "overlays reloaded" when no reload was sent, will stop
 * looking for the real problem — during a service, with a congregation watching.
 *
 * The `detail` says what is unaffected, because that is the fact that keeps someone calm.
 */
function healthActionUnavailable(what: string): Result<never> {
  return err(
    'NOT_CONFIGURED',
    `${what} is not available`,
    'the health monitor was never created; the stream, the recording and every other subsystem are unaffected'
  )
}

/**
 * The state `cuePanic` reports when it could not get one from the engine.
 *
 * Deliberately a *successful* `Result`. An operator hitting the panic switch must never see an
 * error dialog — the switch exists for the moment when something has already gone wrong in front
 * of a congregation, and an app that answers a panic with a modal has failed at the one job the
 * button has.
 *
 * The struct is not cosmetic either. The engine never writes authoritative state: suggestions are
 * applied by the layer above, and that layer refuses to apply anything while the state it is
 * holding says `panicked: true` / `enabled: false` / `mode: 'manual'`. So a panic that could not
 * reach the engine still halts application at the boundary the operator can see, and `lastError`
 * carries the reason so the UI can say "automation is off; the engine did not confirm" rather than
 * pretending everything is fine.
 */
function panickedCueState(detail: string): CueEngineState {
  return {
    ...idleCueEngineState(),
    enabled: false,
    mode: 'manual',
    pending: null,
    panicked: true,
    lastError: detail
  }
}

// ---------------------------------------------------------------------------
// Plan file paths
//
// A path is the only argument on this boundary that names something outside the process, and
// `planOpen` / `planImportDeck` hand it to code that reads the file. A .pptx in particular is an
// arbitrary file a stranger may have produced. Two separate defences apply, and this is the first
// of them: a path is accepted here only if it is absolute, carries the expected extension, and
// really is a file. The second lives in the importer, which parses in a bounded child process.
//
// `..` needs no special handling: `path.resolve` collapses it, and the collapsed result still has
// to pass the extension and stat checks. There is no allow-listed root to escape from — the
// operator is expected to be able to open a plan from anywhere on their own machine — so the
// property being defended is "this is a real file of the right kind", not "this is inside a jail".
// ---------------------------------------------------------------------------

/** Extensions `planOpen` / `planSave` accept. Service plans are plain JSON on disk. */
const PLAN_FILE_EXTENSIONS: readonly string[] = ['.json']

/** Extensions `planImportDeck` accepts. */
const DECK_FILE_EXTENSIONS: readonly string[] = ['.pptx']

/** The real filesystem. Every failure mode — missing, unreadable, broken link — reads `missing`. */
const nodeFilePathProbe: FilePathProbeLike = {
  kind: (target) => {
    try {
      const stats = statSync(target)
      if (stats.isDirectory()) return 'directory'
      return stats.isFile() ? 'file' : 'missing'
    } catch {
      return 'missing'
    }
  }
}

/** How a chosen path will be used, which decides whether it has to exist yet. */
type PathUse = 'read' | 'write'

/**
 * Accept a path, or explain why not.
 *
 * The error `detail` names the *expected* extensions and never the rejected path. Paths are not
 * secrets, but they routinely contain a person's name, and this file's rule is that a validation
 * failure never echoes the value that caused it.
 */
function acceptPath(
  candidate: string,
  extensions: readonly string[],
  use: PathUse,
  probe: FilePathProbeLike
): Result<string> {
  const expected = extensions.join(', ')

  // A NUL truncates the path inside libuv, so what gets opened is not what was checked.
  if (candidate.includes('\0')) {
    return err('INVALID_ARG', 'the file path is not usable', 'the path contains a NUL byte')
  }
  if (!isAbsolute(candidate)) {
    return err('INVALID_ARG', 'the file path is not usable', 'the path must be absolute')
  }

  const resolved = resolvePath(candidate)
  if (!extensions.includes(extname(resolved).toLowerCase())) {
    return err('INVALID_ARG', 'the file path is not usable', `expected one of: ${expected}`)
  }

  const kind = probe.kind(resolved)
  if (use === 'read') {
    // `NOT_FOUND` rather than `INVALID_ARG`: the request was well-formed and the file simply is
    // not there. The renderer renders those two differently — one is "pick another file", the
    // other is "this build has a bug".
    if (kind !== 'file') {
      return err('NOT_FOUND', 'the file does not exist', `expected one of: ${expected}`)
    }
    return ok(resolved)
  }

  // Writing: the file need not exist yet, but a directory sitting on the target path would make
  // the write fail deep inside the service instead of here.
  if (kind === 'directory') {
    return err('INVALID_ARG', 'the file path is not usable', 'the path is a directory')
  }
  return ok(resolved)
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

  /**
   * The Service Plan service, or `null` if there is not one. Resolved once, like the other four.
   *
   * Separate from every other lookup, so a plan service that fails to construct leaves the
   * cameras, the overlay and the go-live orchestrator fully working — and vice versa. That
   * independence is the difference between "we lost the cue list" and "we lost the service".
   */
  const plan: PlanServiceLike | null = resolvePlanService()

  function resolvePlanService(): PlanServiceLike | null {
    if (deps.plan !== undefined) return deps.plan
    try {
      return getPlanService()
    } catch (cause) {
      log.warn('the plan service is unavailable; plan IPC will report NOT_CONNECTED', { cause })
      return null
    }
  }

  /**
   * The ASR service, or `null` if there is not one. Resolved once, like the other five.
   *
   * Separate from every other lookup, and this separation is the one that carries Standing Rule 1.
   * A recogniser that cannot be constructed — no Deepgram key, no usable GPU, a Python sidecar
   * that will not start — leaves the plan, the cameras, the overlay and the go-live orchestrator
   * completely untouched. The operator loses a suggestion engine, not a service.
   */
  const asr: AsrServiceLike | null = resolveAsrService()

  function resolveAsrService(): AsrServiceLike | null {
    if (deps.asr !== undefined) return deps.asr
    try {
      return getAsrService()
    } catch (cause) {
      log.warn('the ASR service is unavailable; asr IPC will report NOT_CONFIGURED', { cause })
      return null
    }
  }

  /**
   * The cue engine, or `null` if there is not one. Resolved once, like the other six.
   *
   * Separate from every other lookup, and this separation carries Standing Rule 1 the same way the
   * ASR one does — more so, in fact, because this is the subsystem that would otherwise be *acting*
   * on the operator's behalf. An engine that cannot be constructed leaves the plan pointer, the
   * cameras, the overlay, the go-live orchestrator and OBS completely untouched. The operator loses
   * a set of suggestions, not a service.
   *
   * Note also what is not wired: the engine is not handed the plan service, the overlay server or
   * the camera service by this file. It gets no privileged path to any of them. Whatever applies a
   * confirmed suggestion does so through the same `plan:*` channels an operator's SPACE key uses,
   * which is what makes "a manual move always wins" implementable rather than aspirational.
   */
  const cue: CueEngineLike | null = resolveCueEngine()

  function resolveCueEngine(): CueEngineLike | null {
    if (deps.cue !== undefined) return deps.cue
    try {
      // The transcript source is handed over here rather than looked up inside `@main/cue`,
      // because this file has already resolved the ASR service and a second `getAsrService()`
      // would perform the settings-file read a second time. With no recogniser we pass none, and
      // the engine is simply idle — which is the correct state for a machine with no microphone
      // (Standing Rule 1).
      //
      // The adapter exists only because this file's `AsrServiceLike.onTranscript` is typed as
      // *possibly* returning an unsubscribe (so a client returning `void` still satisfies it),
      // while the engine wants one it can definitely call on dispose.
      const transcripts = asr
      return getCueEngine({
        logger: deps.logger,
        ...(transcripts === null
          ? {}
          : {
              asr: {
                onTranscript: (listener: (segment: TranscriptSegment) => void): Unsubscribe => {
                  const unsubscribe = transcripts.onTranscript(listener)
                  return typeof unsubscribe === 'function'
                    ? unsubscribe
                    : (): void => {
                        // The client kept no handle, so there is nothing to release.
                      }
                }
              }
            })
      })
    } catch (cause) {
      log.warn('the cue engine is unavailable; cue IPC will report NOT_CONFIGURED', { cause })
      return null
    }
  }

  /**
   * The scripture resolver, or `null`. No singleton lookup — see the dep's doc comment.
   *
   * A `null` here is an ordinary configuration state, not a failure, and it is scoped to exactly
   * two channels. Nothing else in the cue block reads it.
   */
  // Defaulted, not left null. Passing `null` here meant `cueResolveScripture` answered
  // NOT_CONFIGURED even with ESV_API_KEY present — a detected reference was offered with no text
  // and nothing said why. The resolver reports its own not-configured state honestly, so wiring it
  // unconditionally is strictly better than a hard-coded null. Pass `deps.scripture: null`
  // explicitly to disable it.
  const scripture: ScriptureResolverLike | null = resolveScriptureResolver()

  function resolveScriptureResolver(): ScriptureResolverLike | null {
    if (deps.scripture !== undefined) return deps.scripture
    try {
      return getScriptureResolver({ logger: deps.logger })
    } catch (cause) {
      // Same degradation as the cue engine: an unavailable resolver scopes to exactly two
      // channels, which then answer NOT_CONFIGURED. It must never stop IPC registration — the
      // other 51 channels have nothing to do with scripture.
      log.warn('the scripture resolver is unavailable; verse text will not resolve', { cause })
      return null
    }
  }

  /**
   * The health service, or `null` if there is not one. Resolved once, like the other six.
   *
   * Separate from every other lookup, and separate for a reason peculiar to this one: the health
   * service *watches* the other subsystems, so a failure inside it must not be able to take any of
   * them down with it. A `null` here costs the operator the dashboard and the two recovery
   * actions; the overlay server keeps serving, the plan keeps advancing on SPACE, and OBS keeps
   * streaming and recording exactly as it was (Standing Rule 5).
   *
   * Note also which direction the dependency runs. Nothing else in this file reads `health`, and
   * `health` is handed no other subsystem by this file — the monitor observes through its own
   * seams, so no handler here can end up routed through it.
   */
  const health: HealthServiceLike | null = resolveHealthService()

  function resolveHealthService(): HealthServiceLike | null {
    if (deps.health !== undefined) return deps.health
    try {
      return getHealthService()
    } catch (cause) {
      log.warn('the health service is unavailable; health IPC will report NOT_CONFIGURED', {
        cause
      })
      return null
    }
  }

  /**
   * The checkpoint store, or `null`. Resolved once and separately from the aggregator.
   *
   * Separate because the two jobs are different — one observes, one rewinds — and because a
   * failure in either must leave the other working. Neither is handed the other by this file.
   */
  const checkpoints: CheckpointStoreLike | null = resolveCheckpointStore()

  function resolveCheckpointStore(): CheckpointStoreLike | null {
    if (deps.checkpoints !== undefined) return deps.checkpoints
    try {
      return getCheckpointStore()
    } catch (cause) {
      log.warn('the checkpoint store is unavailable; recovery IPC will report NOT_CONFIGURED', {
        cause
      })
      return null
    }
  }

  /**
   * The overlay reload channel. No singleton lookup — the watchdog is built in the composition
   * root, where the overlay server it watches already exists.
   */
  const overlayReload: OverlayReloadLike | null = deps.overlayReload ?? null

  /** Native file dialogs. `null` means "no dialog here" — the plan channels then need a path. */
  const dialogs: DialogLike | null = deps.dialog === undefined ? (dialog ?? null) : deps.dialog

  const filePaths: FilePathProbeLike = deps.filePaths ?? nodeFilePathProbe

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

  // The plan fan-out. `PlanState` is a whole snapshot — the authored plan, the position, the file
  // path, the dirty flag and the last-fired cue — pushed on every change, so a second window (or a
  // control window that reloaded mid-service) is always one snapshot away from correct rather than
  // replaying a delta log.
  //
  // The import-progress feed is separate because it is *not* state: converting a deck can take
  // minutes and the window must not look frozen while it does. `DeckImportProgress` carries a
  // stage, two counters and a message — and no slide content, because imported slides are opaque
  // images (Standing Rule 4) and there is no field on this event that could carry their text.
  if (plan !== null) {
    try {
      registerUnsubscribe(
        plan.onState((state) => {
          broadcast(IpcEvent.planState, state)
        })
      )
      registerUnsubscribe(
        plan.onImportProgress((progress) => {
          broadcast(IpcEvent.planImportProgress, progress)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the plan service', { cause })
    }
  }

  // The ASR fan-out. Two feeds, and they are separate because they degrade separately.
  //
  // `asrStatus` is a whole `AsrStatus` snapshot — state, which provider is actually producing the
  // transcript, median latency, the captured device and the last error — pushed on every change.
  // `degraded` (Deepgram died and the local adapter took over) and `failed` (nothing is arriving)
  // are deliberately distinct states, and this is the channel that tells them apart for the
  // operator: one means "working, but worse", the other means "you are on your own now".
  //
  // `asrTranscript` carries one `TranscriptSegment` at a time, forwarded exactly as the service
  // emitted it. The draft/final contract rides on the payload rather than on the channel: many
  // `isFinal: false` segments share one stable `id` and each REPLACES the previous, then exactly
  // one `isFinal: true` supersedes them all — and the local two-tier scheduler's fast draft
  // (`isDraft: true`) is replaced by the small model's final the same way. This layer keeps no
  // history and reorders nothing; a consumer that appended instead of replacing would flicker
  // gibberish, which is why the rule lives in `@shared/asr` where every consumer can read it.
  if (asr !== null) {
    try {
      registerUnsubscribe(
        asr.onStatus((status) => {
          broadcast(IpcEvent.asrStatus, status)
        })
      )
      registerUnsubscribe(
        asr.onTranscript((segment) => {
          broadcast(IpcEvent.asrTranscript, segment)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the ASR service', { cause })
    }
  }

  // The cue-engine fan-out. Two feeds, and they are separate for a reason that is not symmetry.
  //
  // `cueState` is a whole `CueEngineState` snapshot — mode, alignment, position, the pending
  // suggestion, the recent ones, `panicked` and `lastError` — pushed on every change. It is what a
  // reloaded control window recovers from, and it is what the layer above consults before applying
  // anything: an `enabled: false` / `panicked: true` snapshot is a refusal to act, not just a
  // greyed-out badge.
  //
  // `cueSuggestion` carries one `CueSuggestion` at a time and exists because the "Y / N" prompt is
  // latency-sensitive in a way a state snapshot is not — the operator is deciding in the two or
  // three seconds before the moment passes. The payload is an INTENT and nothing else: a detector,
  // a cue id or a reference, a confidence, a reason, and `canAutoFire`. Broadcasting it changes
  // nothing anywhere; the engine has not fired and cannot fire from this file.
  //
  // Note what the suggestion payload cannot carry: `CueSuggestion.reference` is a
  // `ScriptureReference`, which has no text field. No verse text crosses this event, ever
  // (Standing Rule 4) — text is fetched separately, on demand, through `cueResolveScripture`.
  if (cue !== null) {
    try {
      registerUnsubscribe(
        cue.onState((state) => {
          broadcast(IpcEvent.cueState, state)
        })
      )
      registerUnsubscribe(
        cue.onSuggestion((suggestion) => {
          broadcast(IpcEvent.cueSuggestion, suggestion)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the cue engine', { cause })
    }
  }

  // The health fan-out (BLUEPRINT.md §9). One feed, carrying the whole dashboard.
  //
  // This subscription is the difference between a dashboard and a form. A subsystem degrades on its
  // own schedule — an RTMP link drops mid-sermon, Deepgram stops answering and the local recogniser
  // takes over, the last browser source disconnects — and every one of those has to light up
  // without anybody pressing anything. A panel that only learned about failures when the operator
  // asked would be dark at exactly the moment it is needed.
  //
  // `HealthSnapshot` is pushed whole rather than as a per-subsystem delta, for the same reason the
  // overlay and go-live feeds are: a control window that reloads mid-service is then one snapshot
  // away from correct, and the `worst` roll-up can never disagree with the lights it rolls up.
  if (health !== null) {
    try {
      registerUnsubscribe(
        health.onSnapshot((snapshot) => {
          broadcast(IpcEvent.healthSnapshot, snapshot)
        })
      )
    } catch (cause) {
      log.error('failed to subscribe to the health service', { cause })
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

  // --- service plan (BLUEPRINT.md §7) --------------------------------------
  //
  // Nine channels, and the thing to notice about them is how ordinary they are. `planAdvance`
  // takes no argument, `planBack` takes no argument, `planFireCue` takes an id: an operator
  // holding SPACE drives an entire service through this block with no ASR, no cue engine and no
  // network attached. Phase 8's plan-follower will move the same pointer through the same three
  // channels rather than acquiring a private path of its own, which is what makes "a manual move
  // always wins" (Standing Rule 1) an implementable claim.
  //
  // The three path-bearing channels are the trust-sensitive ones. A `.pptx` is an arbitrary file
  // a stranger may have produced — zip bombs, `../../etc/passwd` in the entry names, ten-thousand
  // slide decks are all real — so the path is accepted only after `acceptPath` has checked it,
  // and the parsing itself happens behind the plan service's own sandbox. This layer's job is to
  // make sure the service is never handed a raw renderer string.
  //
  // And a cancelled dialog is a *normal outcome*. Opening a file picker and changing your mind is
  // something an operator does several times a service; it resolves with the unchanged state and
  // `ok: true`, so the renderer has nothing to turn into an error toast.

  /** A chosen path, or `null` when the operator cancelled the dialog. */
  type ChosenPath = string | null

  interface PathChoice {
    /** What the renderer asked for, if anything. Untrusted. */
    readonly supplied: string | undefined
    readonly use: PathUse
    readonly extensions: readonly string[]
    readonly title: string
    readonly filterName: string
  }

  /** `plan.dialog.save` with no extension typed in gets the plan extension appended. */
  function withDefaultExtension(target: string, extensions: readonly string[]): string {
    const fallback = extensions[0]
    if (fallback === undefined || extname(target) !== '') return target
    return `${target}${fallback}`
  }

  /**
   * Decide which file to act on.
   *
   * A path supplied by the renderer is validated; an absent one opens the native dialog, whose
   * result is validated too. Validating the dialog's answer as well is not paranoia about the
   * OS — it is what makes "the file must exist and end in `.pptx`" one rule with one
   * implementation rather than two that drift.
   */
  async function choosePath(choice: PathChoice): Promise<Result<ChosenPath>> {
    if (choice.supplied !== undefined) {
      return acceptPath(choice.supplied, choice.extensions, choice.use, filePaths)
    }

    if (dialogs === null) {
      return err(
        'NOT_CONFIGURED',
        'no native file dialog is available',
        'supply an explicit file path instead'
      )
    }

    const filters = [
      {
        name: choice.filterName,
        extensions: choice.extensions.map((extension) => extension.replace(/^\./, ''))
      }
    ]

    if (choice.use === 'read') {
      const picked = await dialogs.showOpenDialog({
        title: choice.title,
        filters,
        properties: ['openFile']
      })
      const first = picked.filePaths[0]
      if (picked.canceled || first === undefined) return ok(null)
      return acceptPath(first, choice.extensions, choice.use, filePaths)
    }

    const target = await dialogs.showSaveDialog({ title: choice.title, filters })
    if (target.canceled || target.filePath === undefined || target.filePath.length === 0) {
      return ok(null)
    }
    return acceptPath(
      withDefaultExtension(target.filePath, choice.extensions),
      choice.extensions,
      choice.use,
      filePaths
    )
  }

  /**
   * What a cancelled dialog resolves with: the plan exactly as it was, and `ok: true`.
   *
   * Never an `Err`. Backing out of a file picker is not a failure, and a service plan the
   * operator did not change must not arrive at the renderer wearing an error code that some
   * component turns into a red banner mid-service.
   */
  async function unchangedPlan(service: PlanServiceLike, what: string): Promise<Result<PlanState>> {
    log.debug('a plan file dialog was cancelled; nothing changed', { what })
    return resolveCall(service.getState())
  }

  safeHandle(IpcChannel.planGet, noArg, async () => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.getState())
  })

  /**
   * Replace the authored plan.
   *
   * `servicePlanArg` has already parsed *and rebuilt* the plan, so what reaches the service is a
   * plan whose every cue payload was reconstructed from its type's own schema. An invalid plan is
   * `Err(INVALID_ARG)` and the service is never called at all — a half-written plan must not be
   * able to replace a good one that the operator is midway through using.
   */
  safeHandle(IpcChannel.planSet, servicePlanArg, async (next) => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.setPlan(next))
  })

  safeHandle(IpcChannel.planOpen, optionalPathArg, async ({ path }) => {
    if (plan === null) return planUnavailable()
    const chosen = await choosePath({
      supplied: path,
      use: 'read',
      extensions: PLAN_FILE_EXTENSIONS,
      title: 'Open a service plan',
      filterName: 'Service plan'
    })
    if (!chosen.ok) return chosen
    if (chosen.value === null) return unchangedPlan(plan, 'open')
    return resolveCall(plan.open(chosen.value))
  })

  safeHandle(IpcChannel.planSave, optionalPathArg, async ({ path }) => {
    if (plan === null) return planUnavailable()
    const chosen = await choosePath({
      supplied: path,
      use: 'write',
      extensions: PLAN_FILE_EXTENSIONS,
      title: 'Save the service plan',
      filterName: 'Service plan'
    })
    if (!chosen.ok) return chosen
    if (chosen.value === null) return unchangedPlan(plan, 'save')
    return resolveCall(plan.save(chosen.value))
  })

  /**
   * Import a PowerPoint deck as one slide cue per slide.
   *
   * The file is untrusted in the strongest sense on this boundary — a `.pptx` is a ZIP an
   * arbitrary stranger produced, and the failure modes (zip bombs, `..` in entry names, ten
   * thousand slides) are ordinary rather than exotic. Two things follow, and only the first is
   * this file's job: the path is accepted only after `acceptPath` has proven it is an absolute,
   * existing `.pptx`, and the archive itself is parsed behind the plan service's bounded
   * importer, never here.
   *
   * On a machine with no converter — this build machine has none — the importer reports
   * `available: false` through `planGetImporterStatus` and the UI disables the button with an
   * explanation. That is Standing Rule 5, and it is why this handler does not pre-check anything:
   * an import attempted anyway returns the importer's own explanation rather than a generic
   * refusal invented here.
   */
  safeHandle(IpcChannel.planImportDeck, optionalPathArg, async ({ path }) => {
    if (plan === null) return planUnavailable()
    const chosen = await choosePath({
      supplied: path,
      use: 'read',
      extensions: DECK_FILE_EXTENSIONS,
      title: 'Import a PowerPoint deck',
      filterName: 'PowerPoint deck'
    })
    if (!chosen.ok) return chosen
    if (chosen.value === null) return unchangedPlan(plan, 'import-deck')
    return resolveCall(plan.importDeck(chosen.value))
  })

  safeHandle(IpcChannel.planFireCue, fireCueArg, async ({ cueId }) => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.fireCue(cueId))
  })

  safeHandle(IpcChannel.planAdvance, noArg, async () => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.advance())
  })

  safeHandle(IpcChannel.planBack, noArg, async () => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.back())
  })

  safeHandle(IpcChannel.planGetImporterStatus, noArg, async () => {
    if (plan === null) return planUnavailable()
    return resolveCall(plan.getImporterStatus())
  })

  // --- asr (BLUEPRINT.md §4 and §8) ----------------------------------------
  //
  // Seven channels, six of which are ordinary control verbs and one of which is unlike anything
  // else on this boundary. `asrPushAudio` fires every `ASR_CHUNK_MS` — ten times a second, for the
  // whole length of a service — while this same process is holding the OBS websocket open and
  // serving the overlay. It is therefore the one channel that is not zod-parsed (see
  // `audioChunkArg`), not logged per call, and not rate-limited:
  //
  //  - **Not zod-parsed**, because there is nothing structured to parse. A 3 KB binary blob has no
  //    fields; what needs proving is that it is a buffer and that it is not absurdly large, which
  //    is a `typeof` and a comparison rather than a schema walk at 10 Hz.
  //  - **Not logged per call**, because ~36,000 lines an hour into the rolling file — on the
  //    process that owns the broadcast — buys nothing. A rejected chunk is logged by `safeHandle`
  //    exactly as any other rejected payload, so a renderer sending nonsense is still visible.
  //  - **Not rate-limited.** The `logWrite` token bucket sheds excess and returns
  //    `Err(RATE_LIMITED)`; doing that to audio would silently punch holes in the transcript and
  //    the operator would have no way to know why. Back-pressure belongs in the recogniser, which
  //    is the only component that knows what it can keep up with.
  //
  // Sender validation still applies to every one of the seven, audio included: `safeHandle` runs
  // its window-identity check before the validator, so a chunk from anything but a Verger window
  // is refused before it is even measured.
  //
  // And the whole block is subordinate to Standing Rule 1. Nothing here can block the operator:
  // every handler resolves, an absent service is a defined answer rather than a hang, and no
  // failure path in this section touches OBS, the plan pointer, the cameras or the overlay.

  /**
   * The status light.
   *
   * Never an `Err`, even with no service at all — see `unavailableAsrStatus`. The transcript
   * panel renders this struct, and "there is no recogniser" is information it draws in red rather
   * than a failure it has to special-case.
   */
  safeHandle(IpcChannel.asrGetStatus, noArg, async () => {
    if (asr === null) {
      return ok(unavailableAsrStatus('the ASR service was never created'))
    }
    const status = await resolveCall(asr.getStatus())
    return status.ok ? status : ok(unavailableAsrStatus(status.error.message))
  })

  safeHandle(IpcChannel.asrGetSettings, noArg, async () => {
    if (asr === null) return asrUnavailable()
    return resolveCall(asr.getSettings())
  })

  /**
   * Save operator settings — provider mode, language, device, custom vocabulary, local model.
   *
   * `asrSettingsArg` has already run, so the service is never handed an unvalidated vocabulary
   * list. An invalid payload is `Err(INVALID_ARG)` and the service is not called at all: a
   * half-typed settings form must not be able to replace a working configuration mid-service.
   */
  safeHandle(IpcChannel.asrSetSettings, asrSettingsArg, async (settings) => {
    if (asr === null) return asrUnavailable()
    return resolveCall(asr.setSettings(settings))
  })

  safeHandle(IpcChannel.asrStart, noArg, async () => {
    if (asr === null) return asrUnavailable()
    return resolveCall(asr.start())
  })

  /**
   * Stop recognising.
   *
   * Stops the recogniser and nothing else. There is no OBS call here, no output touched and no
   * plan pointer moved — turning the ears off must never be able to affect the broadcast.
   */
  safeHandle(IpcChannel.asrStop, noArg, async () => {
    if (asr === null) return asrUnavailable()
    return resolveCall(asr.stop())
  })

  /**
   * One PCM chunk from the renderer's capture. The hot path — see the block comment above.
   *
   * Deliberately three lines. Anything added here runs ten times a second for an hour.
   */
  safeHandle(IpcChannel.asrPushAudio, audioChunkArg, async (chunk) => {
    if (asr === null) return asrUnavailable()
    // A view, not a copy. The bytes were already isolated by `audioChunkArg`.
    return resolveCall(asr.pushAudio(new Uint8Array(chunk)))
  })

  /**
   * The inputs the renderer enumerated.
   *
   * Device enumeration lives in the renderer for the same reason capture does — `getUserMedia` and
   * `enumerateDevices` are renderer APIs, and Electron's main process has no microphone without a
   * native module — so this channel is the renderer *reporting* rather than the main process
   * asking. The list is bounded and length-checked before the service sees it: a device `label` is
   * a string an arbitrary USB device chose for itself.
   */
  safeHandle(IpcChannel.asrListDevices, audioDevicesArg, async (devices) => {
    if (asr === null) return asrUnavailable()
    return resolveCall(asr.listDevices(devices))
  })

  // --- cue engine (BLUEPRINT.md §4) ----------------------------------------
  //
  // Ten channels, and the single most important thing about them is what is *missing*: there is no
  // `cueFire`. The engine emits `CueSuggestion`s — intents — and something else applies them. This
  // boundary can read the engine, tune it, accept or reject a named suggestion, and switch it off.
  // It cannot make it act, and no future edit can teach it to without widening `CueEngineLike`
  // first.
  //
  // Three properties are enforced here rather than trusted:
  //
  //  1. **Nothing can force an auto-fire.** `cueSetMode` is the entire dial and it is enum-bounded.
  //     A cue's `confirmAlways`, a below-threshold confidence and an unresolved verse each *block*
  //     an auto-fire (`shouldAutoFire` / `canAutoShow` in `@shared/cue` and `@shared/scripture`);
  //     no argument on this boundary compels one. A cue may always be made safer than the service
  //     default, never more dangerous.
  //  2. **A confirm names its suggestion.** There is no "confirm whatever is pending" form, because
  //     that would be a race the operator loses. `syncToActual` drops the pending suggestion the
  //     instant the plan moves by any other means, so an in-flight confirm must be able to *miss* —
  //     and it does, because the id it carries no longer matches anything.
  //  3. **A dead engine costs nothing that matters.** Nine of the ten channels answer
  //     `NOT_CONFIGURED` with no engine and the tenth still succeeds. The plan advances on SPACE,
  //     `planFireCue` fires by hand, the cameras switch, OBS streams. Standing Rule 1.
  //
  // And Standing Rule 4 runs through the whole block: the two scripture-shaped channels traffic in
  // `ScriptureReference` on the way in — a type with no text field — and text comes back only from
  // `cueResolveScripture`, resolved at runtime by a licensed API or a verified public-domain
  // source. Nothing in this file, this repository or any fixture in it authors a verse.

  safeHandle(IpcChannel.cueGetState, noArg, async () => {
    if (cue === null) return cueUnavailable()
    return resolveCall(cue.getState())
  })

  safeHandle(IpcChannel.cueGetSettings, noArg, async () => {
    if (cue === null) return cueUnavailable()
    return resolveCall(cue.getSettings())
  })

  /**
   * Save operator settings — trust mode, hot phrases, thresholds, translation.
   *
   * `cueSettingsArg` has already run, so the engine is never handed an unbounded hot-phrase list or
   * an out-of-range threshold. An invalid payload is `Err(INVALID_ARG)` and the engine is not
   * called at all: a half-typed settings form must not be able to replace a working configuration
   * in the middle of a service, and an `autoFireThreshold` of `-1` reaching the engine would be an
   * engine that auto-fires everything.
   */
  safeHandle(IpcChannel.cueSetSettings, cueSettingsArg, async (settings) => {
    if (cue === null) return cueUnavailable()
    return resolveCall(cue.setSettings(settings))
  })

  /**
   * The trust dial.
   *
   * Note that this handler does not interpret the mode, does not compare it to the current one and
   * does not refuse `auto`. Whether `auto` is even reachable while `panicked` is the engine's
   * decision — it holds the panic flag, and a second copy of that rule here is how the two drift
   * apart. What this layer guarantees is narrower and checkable: the engine only ever receives one
   * of the three named modes.
   */
  safeHandle(IpcChannel.cueSetMode, cueModeArg, async ({ mode }) => {
    if (cue === null) return cueUnavailable()
    log.info('the cue trust mode was changed', { mode, at: new Date(now()).toISOString() })
    return resolveCall(cue.setMode(mode))
  })

  safeHandle(IpcChannel.cueConfirm, suggestionIdArg, async ({ suggestionId }) => {
    if (cue === null) return cueUnavailable()
    return resolveCall(cue.confirm(suggestionId))
  })

  safeHandle(IpcChannel.cueDismiss, suggestionIdArg, async ({ suggestionId }) => {
    if (cue === null) return cueUnavailable()
    return resolveCall(cue.dismiss(suggestionId))
  })

  /**
   * PANIC — the master switch, and the most important handler in this file.
   *
   * Everything about it is shaped by one requirement: **an operator hitting panic must never see an
   * error.** The button exists for the moment when something has already gone wrong in front of a
   * congregation. An app that answers it with a modal, a rejection or a red toast has failed at the
   * only job the switch has.
   *
   * So, in order:
   *
   *  1. **The press is logged at `info`, with a timestamp, before anything is attempted.** The fact
   *     worth recording is that the operator pressed it — not the outcome. If the engine then
   *     throws, or the process dies half a second later, the rolling log still answers "when did
   *     they panic?", which is the first question anyone asks afterwards.
   *  2. **Every failure path returns `ok`.** An absent engine, an `Err` from the engine and an
   *     exception out of the engine all resolve with a renderable `CueEngineState` carrying
   *     `panicked: true`, `enabled: false`, `mode: 'manual'` and a `lastError` explaining what
   *     happened. That is not a cosmetic lie: the engine never writes authoritative state, so the
   *     layer that applies suggestions is the layer holding this snapshot, and a snapshot that says
   *     `panicked` is a refusal to apply anything. A panic that could not reach the engine still
   *     stops cues at the boundary the operator can see, and the UI can show both PANIC and the
   *     reason.
   *  3. **The `try/catch` is here rather than only in `safeHandle`.** `safeHandle` converts a throw
   *     into `Err(INTERNAL)` — correct for every other channel and wrong for this one, because
   *     `Err` is exactly what must not come back. This catch runs first and converts the throw into
   *     a successful, panicked state instead.
   *
   * And note what panic does *not* do. It stops automation and nothing else: no OBS call, no output
   * touched, no plan pointer moved, no overlay cleared. `CueEngineLike` has no verb for any of
   * those, so it is not a discipline this body observes — it is a thing this body cannot do.
   * Panicking mid-service must never take a congregation's stream off the air.
   */
  safeHandle(IpcChannel.cuePanic, noArg, async (_arg, event) => {
    const at = new Date(now()).toISOString()
    log.info('PANIC requested — halting all cue automation', {
      channel: IpcChannel.cuePanic,
      who: describeSender(event),
      at
    })

    if (cue === null) {
      // Not an error: with no engine there was no automation to halt, and the operator gets the
      // state they asked for.
      log.warn('PANIC recorded with no cue engine attached; automation was already off', { at })
      return ok(panickedCueState('the cue engine was never created; automation was already off'))
    }

    try {
      const result = await resolveCall(cue.panic())
      if (!result.ok) {
        log.error('PANIC was recorded but the engine reported a failure', {
          at,
          code: result.error.code,
          message: result.error.message
        })
        return ok(panickedCueState(result.error.message))
      }

      if (!result.value.panicked) {
        // Reported rather than overwritten. The engine's own state is what actually governs
        // whether it keeps suggesting; a snapshot forced to `panicked: true` here would tell the
        // operator automation had stopped while the engine carried on, which is the worse of the
        // two lies. Loud in the log instead.
        log.error('PANIC returned a state that does not report panicked; the engine may still run', {
          at,
          mode: result.value.mode
        })
      } else {
        log.info('PANIC applied; all cue automation is halted', { at, mode: result.value.mode })
      }
      return result
    } catch (cause) {
      const error = toAppError(cause)
      log.error('PANIC was recorded but the engine threw; reporting automation as halted', {
        at,
        code: error.code,
        message: error.message
      })
      return ok(panickedCueState(error.message))
    }
  })

  /**
   * Re-engage automation after a panic.
   *
   * Deliberately a separate, explicit call, and deliberately *not* forgiving in the way `cuePanic`
   * is. Panic must always succeed; resume has no such requirement, and an operator whose resume
   * failed is in a strictly safer position than one whose panic did — automation stays off. So this
   * one is an ordinary handler: `NOT_CONFIGURED` with no engine, whatever the engine says
   * otherwise. Nothing anywhere in this file calls it on the operator's behalf.
   */
  safeHandle(IpcChannel.cueResume, noArg, async (_arg, event) => {
    if (cue === null) return cueUnavailable()
    log.info('cue automation resume requested', {
      channel: IpcChannel.cueResume,
      who: describeSender(event),
      at: new Date(now()).toISOString()
    })
    return resolveCall(cue.resume())
  })

  /**
   * Fetch the text for a detected reference.
   *
   * Standing Rule 4 in one handler. What crosses on the way in is a `ScriptureReference` — book,
   * chapter, verse, confidence, band — a type with no text field, validated against the same schema
   * the detector's output is described by. What comes back is a `ResolvedScripture` the engine
   * obtained *at runtime* from a licensed API or a verified public-domain translation. No verse text
   * is authored in this repository, committed to it, or present in any fixture that exercises this
   * channel.
   *
   * The translation is optional and, when absent, the key is omitted rather than sent as
   * `undefined`: the engine then uses the operator's configured translation, which is also the only
   * place the "unverified translations are never selectable" rule can be enforced consistently.
   */
  safeHandle(IpcChannel.cueResolveScripture, resolveScriptureArg, async (options) => {
    if (scripture === null) return scriptureResolutionUnavailable()
    return resolveCall(
      options.translation === undefined
        ? scripture.resolve(options.reference)
        : scripture.resolve(options.reference, options.translation)
    )
  })

  /**
   * The translations that may actually be selected.
   *
   * The engine is the only thing that can answer this, because the quarantine rule in
   * `docs/v2-notes/LEGAL_AND_CONTENT.md` is about provenance rather than about files: a translation
   * whose public-domain status is unconfirmed — the Korean KRV specifically — reports
   * `verified: false` and must not be offered just because a file for it exists on disk. This layer
   * forwards the catalogue and adds nothing to it.
   */
  safeHandle(IpcChannel.cueListTranslations, noArg, async () => {
    if (scripture === null) return scriptureResolutionUnavailable()
    return resolveCall(scripture.listTranslations())
  })

  // --- health and recovery (BLUEPRINT.md §9) -------------------------------
  //
  // Four channels over three seams: the aggregator observes, the checkpoint store rewinds, the
  // watchdog reloads. The single most important thing about the block is what the two actions
  // cannot do.
  //
  // No health seam here has a `stopStream`, a `stopRecord`, a `disconnect` or a `restart`, so
  // neither `healthRestoreCheckpoint` nor `healthReloadOverlays` can reach an OBS output — not on
  // its success path, and not on any error path, because there is no verb here to reach it with.
  // That is the rule of this phase expressed as a type: **no recovery action may ever stop the
  // stream or the recording.** A restore rewinds *automation* — the plan pointer and the overlay
  // revision — and a reload asks browser sources to come back and re-sync from the cached snapshot.
  // The broadcast carries on through both.
  //
  // Both actions are logged at `info` with who asked and when, *before* the attempt, exactly as
  // GO LIVE / END and PANIC are. When someone asks afterwards why the plan jumped back three cues,
  // the rolling log is where the answer is.

  /**
   * The dashboard.
   *
   * Never an `Err` — see `unavailableHealthSnapshot`. An operator looking at this panel is already
   * dealing with something going wrong; the panel refusing to draw would make Verger part of the
   * problem. So all three failure paths — no service, an `Err` from the service, an exception out
   * of it — resolve with a renderable snapshot whose every light says what happened.
   *
   * The `try/catch` is here rather than only in `safeHandle` for the same reason `cuePanic` has
   * one: `safeHandle` converts a throw into `Err(INTERNAL)`, which is right for every channel
   * except the two that must always answer.
   */
  safeHandle(IpcChannel.healthGet, noArg, async () => currentHealth())

  /**
   * The retained automation checkpoints.
   *
   * An empty list with no service, rather than an `Err`: "there is nothing to restore" is a true
   * and renderable answer, and the recovery dialog's job is to list what it has.
   */
  safeHandle(IpcChannel.healthListCheckpoints, noArg, async () => {
    if (checkpoints === null) return ok([] as readonly Checkpoint[])
    return resolveCall(checkpoints.list())
  })

  /**
   * CTRL+D recovery — rewind automation to a named checkpoint.
   *
   * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` describes this as the safe rewind after a wrong turn. It
   * is a rewind of *automation* and of nothing else: `Checkpoint` carries a plan position, an
   * overlay revision and a label, and has no field naming the stream or the recording, so there is
   * nothing in the payload that could describe undoing a broadcast. The broadcast cannot be undone
   * anyway — the congregation saw it — which is precisely why this must not try.
   *
   * An unknown id comes back as an ordinary `Err` from the store and is forwarded as-is. It is
   * not a throw, not a crash and not a silent success: an operator whose rewind did not happen has
   * to know it did not happen, because they are about to act on the assumption that it did.
   *
   * The rewind and the dashboard read are two different objects — the store acts, the aggregator
   * observes — so the response is composed here rather than delegated: restore, then report the
   * *resulting* dashboard, which is what the panel that called this is about to redraw.
   */
  safeHandle(IpcChannel.healthRestoreCheckpoint, checkpointIdArg, async ({ checkpointId }, event) => {
    log.info('checkpoint restore requested', {
      channel: IpcChannel.healthRestoreCheckpoint,
      checkpointId,
      who: describeSender(event),
      at: new Date(now()).toISOString()
    })

    if (checkpoints === null) return healthActionUnavailable('checkpoint recovery')

    const restored = await resolveCall(checkpoints.restore(checkpointId))
    if (!restored.ok) {
      log.warn('the checkpoint restore did not happen; nothing was changed', {
        checkpointId,
        code: restored.error.code,
        message: restored.error.message
      })
      return restored
    }

    log.info('automation was rewound to a checkpoint', {
      checkpointId,
      planPosition: restored.value.planPosition,
      // Said out loud in the log because it is the property that matters and the one a reader
      // will want confirmed a week later.
      note: 'automation only; the stream and the recording were not touched'
    })
    return currentHealth()
  })

  /**
   * Force every attached overlay browser source to reload and re-sync.
   *
   * The blueprint's "overlay browser source crashes" row. A reload is the *safe* half of that
   * recovery: the server holds the authoritative `OverlayState`, so a source that reconnects is
   * sent the current snapshot and comes back showing exactly what it was showing — which is why
   * the overlay contract has been state-based rather than event-based since Phase 2.
   *
   * It touches OBS not at all. The browser source is a page inside OBS; asking it to reload does
   * not ask OBS to do anything, and cannot interrupt an encoder that is mid-stream.
   */
  safeHandle(IpcChannel.healthReloadOverlays, noArg, async (_arg, event) => {
    log.info('overlay reload requested', {
      channel: IpcChannel.healthReloadOverlays,
      who: describeSender(event),
      at: new Date(now()).toISOString()
    })

    if (overlayReload === null) return healthActionUnavailable('the overlay reload')

    const result = await resolveCall(overlayReload.reloadNow())
    if (!result.ok) {
      log.warn('the overlay reload did not happen; the stream and recording are unaffected', {
        code: result.error.code,
        message: result.error.message,
        detail: 'refresh the browser source from OBS if the overlay stays blank'
      })
      return result
    }
    return currentHealth()
  })

  /**
   * The dashboard as it stands right now, for a recovery action to answer with.
   *
   * Never an `Err`, and that is the whole reason it exists as a helper. `healthGet` must always
   * have something for the panel to draw — an operator reading this strip of lights is already
   * dealing with something going wrong, and a panel that refuses to render would make Verger part
   * of the problem. A recovery action must not turn a *successful* rewind into a failed one on the
   * way back either, just because the aggregator that reports on it is itself unavailable.
   *
   * All three failure paths — no aggregator, an `Err` from it, an exception out of it — resolve
   * with a renderable snapshot whose every light says what happened. The `try/catch` is here
   * rather than only in `safeHandle` for the same reason `cuePanic` has its own: `safeHandle`
   * converts a throw into `Err(INTERNAL)`, which is right for every channel except the ones that
   * must always answer.
   */
  async function currentHealth(): Promise<Result<HealthSnapshot>> {
    if (health === null) {
      return ok(unavailableHealthSnapshot(now(), 'the health monitor is unavailable'))
    }
    try {
      const snapshot = await resolveCall(health.getSnapshot())
      if (snapshot.ok) return snapshot
      log.warn('the health monitor could not report; showing every light as unknown', {
        code: snapshot.error.code,
        message: snapshot.error.message
      })
      return ok(unavailableHealthSnapshot(now(), snapshot.error.message))
    } catch (cause) {
      const error = toAppError(cause)
      log.error('the health monitor threw while reporting; showing every light as unknown', {
        code: error.code,
        message: error.message
      })
      return ok(unavailableHealthSnapshot(now(), error.message))
    }
  }

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
    goLive: goLive === null ? 'unavailable' : 'attached',
    plan: plan === null ? 'unavailable' : 'attached',
    asr: asr === null ? 'unavailable' : 'attached',
    cue: cue === null ? 'unavailable' : 'attached',
    scripture: scripture === null ? 'unavailable' : 'attached',
    health: health === null ? 'unavailable' : 'attached',
    checkpoints: checkpoints === null ? 'unavailable' : 'attached',
    overlayReload: overlayReload === null ? 'unavailable' : 'attached'
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
    // state one, the YouTube status one, the go-live state one, the plan state/import-progress
    // pair, the ASR status/transcript pair, the cue state/suggestion pair and the health snapshot
    // one alike: all of them
    // were pushed
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
