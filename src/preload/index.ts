/**
 * The preload bridge — the ONLY thing the renderer may reach the main process through.
 *
 * Runtime constraints, all load-bearing:
 *
 *  - This file is bundled to **CommonJS** at `out/preload/index.cjs` and runs with
 *    `sandbox: true` (see `src/main/window.ts`). A sandboxed preload may use
 *    `contextBridge` and `ipcRenderer` and nothing else — no `node:fs`, no `node:path`,
 *    no `process` poking. Adding a Node import here breaks the window at load time, not
 *    at build time, so it will only be discovered on a service day.
 *  - `@shared/ipc` is safe to import because it is types plus two frozen string maps: it
 *    pulls in no runtime dependency (its `config`/`log`/`obs`/`result` imports are all
 *    `import type` and erase to nothing).
 *
 * Security posture (docs/v2-notes/PROTOCOL.md §2.3 and §2.5):
 *
 *  - **No raw channel string and no `ipcRenderer` handle crosses the bridge.** The renderer
 *    gets named, typed methods only, so it is structurally unable to invoke an arbitrary
 *    channel. v2's blueprint marks exposing `ipcRenderer` itself as a critical defect; the
 *    grouped `VergerApi` shape in `@shared/ipc` exists precisely so this file never needs a
 *    generic `invoke`.
 *  - **The `IpcRendererEvent` is stripped before the callback runs.** That object carries a
 *    `sender` handle; forwarding it would hand the renderer back the very capability the
 *    bridge exists to withhold. Subscribers receive the payload and nothing else.
 *  - **Event names are checked against `IPC_EVENT_VALUES` at runtime**, so a main process
 *    that starts pushing on an unlisted channel cannot make this file register a listener
 *    for it.
 *
 * Nothing here throws: every method returns a `Promise<Result<T>>` produced by the main
 * process, and every `on*` returns an unsubscribe that is safe to call more than once.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type { AsrSettings, AsrStatus, AudioInputDevice, TranscriptSegment } from '@shared/asr'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { ConfigSummary, ObsConfig } from '@shared/config'
import type { GoLiveState } from '@shared/golive'
import { IPC_EVENT_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type {
  AppVersions,
  DeckImportProgress,
  DeckImporterStatus,
  IpcEventValue,
  OverlayServerInfo,
  PlanState,
  Unsubscribe,
  VergerApi
} from '@shared/ipc'
import type { LogRecord } from '@shared/log'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import type { ServicePlan } from '@shared/plan'
import type { Result } from '@shared/result'
import type { Broadcast, BroadcastTemplate, YouTubeStatus } from '@shared/youtube'

/** A listener that has already had the Electron event object removed. */
type PayloadListener = (event: IpcRendererEvent, payload: unknown) => void

/**
 * Register a listener for one main -> renderer push channel.
 *
 * The `event` name is validated against the runtime membership set before anything is
 * registered: an unknown name yields a no-op subscription rather than a live listener on an
 * unaudited channel. The returned unsubscribe removes *this* listener specifically (
 * `removeListener`, never `removeAllListeners`) so two components subscribing to the same
 * channel cannot silently unsubscribe each other.
 */
function subscribe<T>(event: IpcEventValue, callback: (payload: T) => void): Unsubscribe {
  if (!IPC_EVENT_VALUES.includes(event)) {
    return () => {
      // Nothing was registered, so nothing to remove.
    }
  }

  // The Electron event is bound to `_event` and deliberately dropped: it exposes a
  // `sender` handle that must never reach renderer code.
  const listener: PayloadListener = (_event, payload) => {
    callback(payload as T)
  }

  ipcRenderer.on(event, listener)

  let removed = false
  return () => {
    if (removed) return
    removed = true
    ipcRenderer.removeListener(event, listener)
  }
}

const api: VergerApi = {
  obs: {
    getStatus: (): Promise<Result<ObsStatus>> => ipcRenderer.invoke(IpcChannel.obsGetStatus),
    getSceneList: (): Promise<Result<ObsSceneList>> =>
      ipcRenderer.invoke(IpcChannel.obsGetSceneList),
    connect: (config: ObsConnectionConfig): Promise<Result<ObsStatus>> =>
      ipcRenderer.invoke(IpcChannel.obsConnect, config),
    disconnect: (): Promise<Result<ObsStatus>> => ipcRenderer.invoke(IpcChannel.obsDisconnect),
    setConfig: (config: ObsConfig): Promise<Result<ObsStatus>> =>
      ipcRenderer.invoke(IpcChannel.obsSetConfig, config),
    onStatus: (callback: (status: ObsStatus) => void): Unsubscribe =>
      subscribe<ObsStatus>(IpcEvent.obsStatus, callback),
    onSceneList: (callback: (sceneList: ObsSceneList) => void): Unsubscribe =>
      subscribe<ObsSceneList>(IpcEvent.obsSceneList, callback)
  },

  /**
   * The overlay layer (BLUEPRINT.md §6).
   *
   * `send` resolves with the *resulting* `OverlayState`, and `onState` delivers a full
   * snapshot after every mutation — never a show/hide event. The renderer therefore never
   * accumulates overlay state of its own; it renders whatever the last snapshot said, which is
   * the same contract the overlay page itself lives under. A control window that reloads
   * mid-service recovers by calling `getState()` once, exactly as a reloaded browser source
   * recovers from the snapshot the server pushes on connect.
   */
  overlay: {
    getState: (): Promise<Result<OverlayState>> => ipcRenderer.invoke(IpcChannel.overlayGetState),
    send: (command: OverlayCommand): Promise<Result<OverlayState>> =>
      ipcRenderer.invoke(IpcChannel.overlaySend, command),
    getServerInfo: (): Promise<Result<OverlayServerInfo>> =>
      ipcRenderer.invoke(IpcChannel.overlayGetServerInfo),
    onState: (callback: (state: OverlayState) => void): Unsubscribe =>
      subscribe<OverlayState>(IpcEvent.overlayState, callback),
    onServerInfo: (callback: (info: OverlayServerInfo) => void): Unsubscribe =>
      subscribe<OverlayServerInfo>(IpcEvent.overlayServerInfo, callback)
  },

  /**
   * The camera layer (BLUEPRINT.md §6).
   *
   * Note what this group does *not* contain: any overlay verb. `select` moves the program
   * scene and resolves with a `CameraState`, whose three fields describe cameras and nothing
   * else. There is structurally no way for a camera call made here to disturb a lower-third,
   * and no way for an `overlay.send` above to disturb the camera — the two groups share no
   * channel, no payload type and no state object. That independence is the whole point of the
   * phase, and it is enforced by the shape of this file rather than by convention.
   *
   * `onState` also fires for scene changes made *inside OBS* or by an OBS hotkey, so the live
   * indicator reflects reality rather than only what Verger last asked for (Standing Rule 2).
   */
  camera: {
    getConfig: (): Promise<Result<CameraConfig>> => ipcRenderer.invoke(IpcChannel.cameraGetConfig),
    setConfig: (config: CameraConfig): Promise<Result<CameraConfig>> =>
      ipcRenderer.invoke(IpcChannel.cameraSetConfig, config),
    getState: (): Promise<Result<CameraState>> => ipcRenderer.invoke(IpcChannel.cameraGetState),
    // The slot is wrapped into `{ slot }` here rather than sent bare, because the main-side
    // validator zod-parses an object. Keeping the renderer-facing signature a plain
    // `CameraSlot` means a caller cannot accidentally send a differently-shaped envelope.
    select: (slot: CameraSlot): Promise<Result<CameraState>> =>
      ipcRenderer.invoke(IpcChannel.cameraSelect, { slot }),
    onState: (callback: (state: CameraState) => void): Unsubscribe =>
      subscribe<CameraState>(IpcEvent.cameraState, callback)
  },

  /**
   * The YouTube Live layer (BLUEPRINT.md §5).
   *
   * Two absences here are load-bearing, not oversights:
   *
   *  - **No stream key.** `YouTubeStatus` carries a `PersistentStream` whose type has no key
   *    field at all, so there is no method here that could return one and no payload shape that
   *    could smuggle one. The RTMP key is a credential that grants anyone the ability to
   *    broadcast to the channel; it lives in OBS's own settings and never crosses this bridge.
   *  - **No token.** `signIn()` resolves with a `YouTubeStatus`, not with a credential. The
   *    OAuth refresh token is written to the main process's `safeStorage` store and is not
   *    nameable from renderer code.
   *
   * `not-configured` (no Google client id/secret in `.env`) is a perfectly ordinary resolved
   * value rather than a rejection: `getStatus()` succeeds, `auth.state` says `not-configured`,
   * and the Go Live screen disables itself and explains why (Standing Rule 5).
   */
  youtube: {
    getStatus: (): Promise<Result<YouTubeStatus>> =>
      ipcRenderer.invoke(IpcChannel.youtubeGetStatus),
    signIn: (): Promise<Result<YouTubeStatus>> => ipcRenderer.invoke(IpcChannel.youtubeSignIn),
    signOut: (): Promise<Result<YouTubeStatus>> => ipcRenderer.invoke(IpcChannel.youtubeSignOut),
    setTemplate: (template: BroadcastTemplate): Promise<Result<YouTubeStatus>> =>
      ipcRenderer.invoke(IpcChannel.youtubeSetTemplate, template),
    createBroadcast: (options: { scheduledStartTime?: string }): Promise<Result<Broadcast>> =>
      ipcRenderer.invoke(IpcChannel.youtubeCreateBroadcast, options),
    onStatus: (callback: (status: YouTubeStatus) => void): Unsubscribe =>
      subscribe<YouTubeStatus>(IpcEvent.youtubeStatus, callback)
  },

  /**
   * GO LIVE / END orchestration (BLUEPRINT.md §5, Part B).
   *
   * Four methods, and the important thing about them is what the renderer *cannot* express:
   *
   *  - **`start()` takes no argument.** There is no options object, so there is no
   *    `{ record: false }` to pass. Standing Rule 3 — whenever streaming starts, OBS local
   *    recording starts too, because the internet wobbles and a service is un-repeatable —
   *    is enforced here by the absence of a parameter, not by a default value some future
   *    caller could override. Widening this signature would mean editing `@shared/ipc` first.
   *  - **There is no `stopRecording`, no `stopStream`, no per-step verb.** The renderer can ask
   *    to go live and ask to end, and that is the whole surface. It cannot half-tear-down a
   *    service, and it cannot react to a failed step by stopping the parts that are working.
   *
   * `start()` and `end()` resolve with a `GoLiveState`, not with a boolean, and `onState`
   * pushes the same whole snapshot on every change — including per-step progress while the
   * sequence runs and the `partial` phase (OBS streaming and recording, YouTube not
   * transitioned) that is the most likely real failure. A control window that reloads
   * mid-service recovers with one `getState()`, exactly as the overlay and camera panels do.
   *
   * Nothing here rejects. A go-live that fails resolves with `Err(...)` *and* leaves OBS
   * streaming and recording — the app must never wedge the broadcast as a reaction to its own
   * error, so there is no path from a failed promise here to a stopped output.
   */
  goLive: {
    getState: (): Promise<Result<GoLiveState>> => ipcRenderer.invoke(IpcChannel.goLiveGetState),
    start: (): Promise<Result<GoLiveState>> => ipcRenderer.invoke(IpcChannel.goLiveStart),
    end: (): Promise<Result<GoLiveState>> => ipcRenderer.invoke(IpcChannel.goLiveEnd),
    onState: (callback: (state: GoLiveState) => void): Unsubscribe =>
      subscribe<GoLiveState>(IpcEvent.goLiveState, callback)
  },

  /**
   * The Service Plan (BLUEPRINT.md §7).
   *
   * Read this group as the **manual** slide/media driver first and the automation seam second.
   * `advance()` and `back()` take no argument and `fireCue` takes only an id: an operator holding
   * SPACE can drive an entire service through these three methods with no ASR, no cue engine and
   * no network. Phase 8's plan-follower will move the same pointer through the same channels —
   * it gets no privileged path of its own, which is what makes "a manual move always wins"
   * implementable rather than aspirational.
   *
   * Three shapes here are load-bearing:
   *
   *  - **Every method resolves with a whole `PlanState`** — plan, position, path, dirty flag and
   *    the last-fired cue in one snapshot. A control window that reloads mid-service recovers
   *    with one `getState()`, exactly as the overlay, camera and go-live panels do, and `onState`
   *    pushes the same snapshot after every change rather than a per-cue delta.
   *  - **`open`, `save` and `importDeck` take an *optional* path.** Omitting it is the normal
   *    case: the main process opens the native file dialog, because a renderer that could only
   *    act on paths it already knew would have no way to reach a file the operator has not
   *    previously named. A cancelled dialog resolves with the unchanged state and `ok: true` —
   *    backing out of a file picker is not an error and must never raise a toast.
   *  - **A path sent from here is a *request*, not an instruction.** The renderer is the
   *    less-trusted side; `src/main/ipc/register.ts` validates any supplied path (absolute,
   *    expected extension, really a file) before the plan service is allowed to touch it.
   *
   * `onImportProgress` exists because converting a deck is slow enough that a frozen-looking
   * window is a real failure mode. It is a progress feed only — `DeckImportProgress` carries a
   * stage, two counters and a message, and has no field for slide content. Imported slides are
   * opaque images end to end (Standing Rule 4); no slide text crosses this bridge because there
   * is no type here that could carry it.
   */
  plan: {
    getState: (): Promise<Result<PlanState>> => ipcRenderer.invoke(IpcChannel.planGet),
    set: (plan: ServicePlan): Promise<Result<PlanState>> =>
      ipcRenderer.invoke(IpcChannel.planSet, plan),
    open: (options: { path?: string }): Promise<Result<PlanState>> =>
      ipcRenderer.invoke(IpcChannel.planOpen, options),
    save: (options: { path?: string }): Promise<Result<PlanState>> =>
      ipcRenderer.invoke(IpcChannel.planSave, options),
    importDeck: (options: { path?: string }): Promise<Result<PlanState>> =>
      ipcRenderer.invoke(IpcChannel.planImportDeck, options),
    fireCue: (options: { cueId: string }): Promise<Result<PlanState>> =>
      ipcRenderer.invoke(IpcChannel.planFireCue, options),
    advance: (): Promise<Result<PlanState>> => ipcRenderer.invoke(IpcChannel.planAdvance),
    back: (): Promise<Result<PlanState>> => ipcRenderer.invoke(IpcChannel.planBack),
    getImporterStatus: (): Promise<Result<DeckImporterStatus>> =>
      ipcRenderer.invoke(IpcChannel.planGetImporterStatus),
    onState: (callback: (state: PlanState) => void): Unsubscribe =>
      subscribe<PlanState>(IpcEvent.planState, callback),
    onImportProgress: (callback: (progress: DeckImportProgress) => void): Unsubscribe =>
      subscribe<DeckImportProgress>(IpcEvent.planImportProgress, callback)
  },

  /**
   * The ears (BLUEPRINT.md §4 and §8).
   *
   * This is the one group whose data flows *upward*. Everywhere else the renderer asks and the
   * main process answers; here the renderer is the source, because **only the renderer has
   * `getUserMedia`**. Electron's main process has no microphone without a native module, so
   * capture, resampling to 16 kHz mono s16le and device enumeration all happen in renderer code
   * and arrive here as `pushAudio` and `listDevices`. (The Phase 7 build prompt says "mic capture
   * in the main process"; that is not achievable in Electron without native code, and this is the
   * deviation.)
   *
   * Three shapes are load-bearing:
   *
   *  - **`pushAudio` is the hot path.** It fires every `ASR_CHUNK_MS` — ten times a second, for
   *    the length of a service — so it carries a bare `ArrayBuffer` and nothing else. There is no
   *    envelope object to allocate per chunk and no timestamp field to keep in sync; the main side
   *    checks the buffer's *shape and size* rather than zod-parsing three kilobytes of binary ten
   *    times a second. It still resolves with a `Result<void>` like everything else, so a dead
   *    recogniser is a value the capture loop can read rather than a rejection it has to catch.
   *  - **Audio only ever goes one way.** There is no method here that returns audio, and
   *    `TranscriptSegment` has no field that could carry a sample. Raw audio reaches the main
   *    process, is recognised, and is gone.
   *  - **`onTranscript` delivers the draft/final contract unchanged.** A span of speech arrives as
   *    many `isFinal: false` segments sharing one stable `id`, each *replacing* the previous, then
   *    exactly one `isFinal: true` that supersedes them all — and the local adapter's fast draft
   *    model works the same way (`isDraft: true`, later replaced by the small model's final).
   *    Consumers key on `id` and replace; appending before `isFinal` is what makes a transcript
   *    flicker gibberish.
   *
   * `not-configured` (no `DEEPGRAM_API_KEY`, no local model) is an ordinary resolved value, not a
   * rejection: `getStatus()` succeeds, the panel goes red, and the operator drives the service by
   * hand exactly as before (Standing Rule 1 and Standing Rule 5). Nothing in this group can block
   * the operator, because nothing in it is on the path between a keypress and a cue.
   */
  asr: {
    getStatus: (): Promise<Result<AsrStatus>> => ipcRenderer.invoke(IpcChannel.asrGetStatus),
    getSettings: (): Promise<Result<AsrSettings>> => ipcRenderer.invoke(IpcChannel.asrGetSettings),
    setSettings: (settings: AsrSettings): Promise<Result<AsrSettings>> =>
      ipcRenderer.invoke(IpcChannel.asrSetSettings, settings),
    start: (): Promise<Result<AsrStatus>> => ipcRenderer.invoke(IpcChannel.asrStart),
    stop: (): Promise<Result<AsrStatus>> => ipcRenderer.invoke(IpcChannel.asrStop),
    pushAudio: (chunk: ArrayBuffer): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannel.asrPushAudio, chunk),
    listDevices: (devices: readonly AudioInputDevice[]): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannel.asrListDevices, devices),
    onStatus: (callback: (status: AsrStatus) => void): Unsubscribe =>
      subscribe<AsrStatus>(IpcEvent.asrStatus, callback),
    onTranscript: (callback: (segment: TranscriptSegment) => void): Unsubscribe =>
      subscribe<TranscriptSegment>(IpcEvent.asrTranscript, callback)
  },

  config: {
    get: (): Promise<Result<ConfigSummary>> => ipcRenderer.invoke(IpcChannel.configGet)
  },

  log: {
    write: (record: LogRecord): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannel.logWrite, record)
  },

  app: {
    getVersions: (): Promise<Result<AppVersions>> => ipcRenderer.invoke(IpcChannel.appGetVersions)
  }
}

// `contextIsolation` is always on (`src/main/window.ts`), so this is the only supported
// path. The try/catch exists so a bridge failure is reported rather than swallowed into a
// blank window — the renderer already treats `window.verger` as optional and degrades.
try {
  contextBridge.exposeInMainWorld('verger', api)
} catch (cause) {
  console.error('[verger] failed to expose the preload bridge', cause)
}
