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

import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { ConfigSummary, ObsConfig } from '@shared/config'
import { IPC_EVENT_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type {
  AppVersions,
  IpcEventValue,
  OverlayServerInfo,
  Unsubscribe,
  VergerApi
} from '@shared/ipc'
import type { LogRecord } from '@shared/log'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import type { Result } from '@shared/result'

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
