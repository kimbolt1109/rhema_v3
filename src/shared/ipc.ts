/**
 * The typed IPC surface — the single contract between main, preload and renderer.
 *
 * Design rules, taken from `docs/v2-notes/PROTOCOL.md` and its record of how rhema_v2's
 * equivalent drifted:
 *
 * 1. **One channel registry.** Channel strings appear here and nowhere else. The preload maps
 *    typed methods onto them; the renderer never sees a channel string and so cannot invoke an
 *    arbitrary one.
 * 2. **`verger:<domain>:<action>` casing, everywhere.** v2 mixed `PascalCase` events with
 *    `colon:lower` ones in a single stream and paid for it; the mined notes settle on this form.
 * 3. **Every response is a `Result<T>`.** Handlers never throw across the boundary — see
 *    `src/shared/result.ts` for why.
 * 4. **Request/response types are keyed by channel**, so `invoke` is checked at both ends and a
 *    handler that returns the wrong shape fails to compile.
 */

import type { ConfigSummary, ObsConfig } from './config'
import type { LogRecord } from './log'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from './obs'
import type { CameraConfig, CameraSlot, CameraState } from './camera'
import type { OverlayCommand, OverlayState } from './overlay'
import type { Result } from './result'

/**
 * Live status of the overlay HTTP + WebSocket server.
 *
 * `clients` is the number of attached browser sources. An operator seeing `0` while a service
 * is running knows immediately that OBS's Overlays source has died — which is exactly the
 * failure BLUEPRINT.md §9 says must be visible rather than silent.
 */
export interface OverlayServerInfo {
  readonly running: boolean
  readonly host: string
  readonly port: number
  /** The URL to paste into an OBS Browser Source. */
  readonly pageUrl: string
  readonly clients: number
  readonly lastError: string | null
}

/**
 * Renderer -> main request channels.
 *
 * Phase 1 only. Later phases add `overlay:*` (2), `camera:*` (3), `youtube:*` (4-5),
 * `plan:*` (6), `asr:*` (7) and `cue:*` (8) — append, never renumber.
 */
export const IpcChannel = {
  obsGetStatus: 'verger:obs:get-status',
  obsGetSceneList: 'verger:obs:get-scene-list',
  obsConnect: 'verger:obs:connect',
  obsDisconnect: 'verger:obs:disconnect',
  obsSetConfig: 'verger:obs:set-config',
  configGet: 'verger:config:get',
  logWrite: 'verger:log:write',
  appGetVersions: 'verger:app:get-versions',
  overlayGetState: 'verger:overlay:get-state',
  overlaySend: 'verger:overlay:send',
  overlayGetServerInfo: 'verger:overlay:get-server-info',
  cameraGetConfig: 'verger:camera:get-config',
  cameraSetConfig: 'verger:camera:set-config',
  cameraGetState: 'verger:camera:get-state',
  cameraSelect: 'verger:camera:select',
} as const

/** Union of every request channel string. */
export type IpcChannelValue = (typeof IpcChannel)[keyof typeof IpcChannel]

/**
 * Main -> renderer push channels.
 *
 * These are fire-and-forget: the main process pushes to every open window and does not wait.
 */
export const IpcEvent = {
  obsStatus: 'verger:obs:status',
  obsSceneList: 'verger:obs:scene-list',
  logRecord: 'verger:log:record',
  overlayState: 'verger:overlay:state',
  overlayServerInfo: 'verger:overlay:server-info',
  cameraState: 'verger:camera:state',
} as const

/** Union of every event channel string. */
export type IpcEventValue = (typeof IpcEvent)[keyof typeof IpcEvent]

/** Runtime membership set, so the preload can reject an unknown event subscription. */
export const IPC_EVENT_VALUES: readonly IpcEventValue[] = Object.values(IpcEvent)

/** Runtime membership set, so `registerIpc` can assert full coverage in a test. */
export const IPC_CHANNEL_VALUES: readonly IpcChannelValue[] = Object.values(IpcChannel)

/** Runtime/version information, for the About panel and for bug reports. */
export interface AppVersions {
  readonly app: string
  readonly electron: string
  readonly chrome: string
  readonly node: string
  readonly v8: string
}

/**
 * The argument type for each request channel.
 *
 * `void` means the channel takes no argument.
 */
export interface IpcRequest {
  [IpcChannel.obsGetStatus]: void
  [IpcChannel.obsGetSceneList]: void
  [IpcChannel.obsConnect]: ObsConnectionConfig
  [IpcChannel.obsDisconnect]: void
  [IpcChannel.obsSetConfig]: ObsConfig
  [IpcChannel.configGet]: void
  [IpcChannel.logWrite]: LogRecord
  [IpcChannel.appGetVersions]: void
  [IpcChannel.overlayGetState]: void
  [IpcChannel.overlaySend]: OverlayCommand
  [IpcChannel.overlayGetServerInfo]: void
  [IpcChannel.cameraGetConfig]: void
  [IpcChannel.cameraSetConfig]: CameraConfig
  [IpcChannel.cameraGetState]: void
  [IpcChannel.cameraSelect]: { slot: CameraSlot }
}

/** The resolved type for each request channel. Always wrapped in {@link Result}. */
export interface IpcResponse {
  [IpcChannel.obsGetStatus]: Result<ObsStatus>
  [IpcChannel.obsGetSceneList]: Result<ObsSceneList>
  [IpcChannel.obsConnect]: Result<ObsStatus>
  [IpcChannel.obsDisconnect]: Result<ObsStatus>
  [IpcChannel.obsSetConfig]: Result<ObsStatus>
  [IpcChannel.configGet]: Result<ConfigSummary>
  [IpcChannel.logWrite]: Result<void>
  [IpcChannel.appGetVersions]: Result<AppVersions>
  [IpcChannel.overlayGetState]: Result<OverlayState>
  [IpcChannel.overlaySend]: Result<OverlayState>
  [IpcChannel.overlayGetServerInfo]: Result<OverlayServerInfo>
  [IpcChannel.cameraGetConfig]: Result<CameraConfig>
  [IpcChannel.cameraSetConfig]: Result<CameraConfig>
  [IpcChannel.cameraGetState]: Result<CameraState>
  [IpcChannel.cameraSelect]: Result<CameraState>
}

/** The payload pushed on each event channel. */
export interface IpcEventPayload {
  [IpcEvent.obsStatus]: ObsStatus
  [IpcEvent.obsSceneList]: ObsSceneList
  [IpcEvent.logRecord]: LogRecord
  [IpcEvent.overlayState]: OverlayState
  [IpcEvent.overlayServerInfo]: OverlayServerInfo
  [IpcEvent.cameraState]: CameraState
}

/** Removes a previously registered listener. Always call it on teardown — leaks are real. */
export type Unsubscribe = () => void

/**
 * The API exposed on `window.verger` by the preload.
 *
 * Grouped by domain rather than flat, so later phases can add `overlay`, `youtube`, `asr` and
 * `cue` groups without the surface becoming a wall of forty methods.
 *
 * Note there is no generic `invoke`: the renderer must not be able to reach an arbitrary
 * channel, only these named operations.
 */
export interface VergerApi {
  readonly obs: {
    getStatus(): Promise<Result<ObsStatus>>
    getSceneList(): Promise<Result<ObsSceneList>>
    connect(config: ObsConnectionConfig): Promise<Result<ObsStatus>>
    disconnect(): Promise<Result<ObsStatus>>
    setConfig(config: ObsConfig): Promise<Result<ObsStatus>>
    /** Subscribe to connection-state changes. Returns an unsubscribe function. */
    onStatus(callback: (status: ObsStatus) => void): Unsubscribe
    /** Subscribe to scene-list changes. Returns an unsubscribe function. */
    onSceneList(callback: (sceneList: ObsSceneList) => void): Unsubscribe
  }
  readonly overlay: {
    getState(): Promise<Result<OverlayState>>
    /** Send a command; resolves with the resulting state. */
    send(command: OverlayCommand): Promise<Result<OverlayState>>
    getServerInfo(): Promise<Result<OverlayServerInfo>>
    /** Subscribe to overlay state changes. Returns an unsubscribe function. */
    onState(callback: (state: OverlayState) => void): Unsubscribe
    /** Subscribe to server up/down and client-count changes. */
    onServerInfo(callback: (info: OverlayServerInfo) => void): Unsubscribe
  }
  readonly camera: {
    getConfig(): Promise<Result<CameraConfig>>
    setConfig(config: CameraConfig): Promise<Result<CameraConfig>>
    getState(): Promise<Result<CameraState>>
    /** Switch the program camera. Resolves with the resulting camera state. */
    select(slot: CameraSlot): Promise<Result<CameraState>>
    /** Subscribe to camera state changes, including scene switches made inside OBS. */
    onState(callback: (state: CameraState) => void): Unsubscribe
  }
  readonly config: {
    /** The renderer-safe projection only — never the values. */
    get(): Promise<Result<ConfigSummary>>
  }
  readonly log: {
    /** Forward a renderer log record into the main rolling file. Rate-limited. */
    write(record: LogRecord): Promise<Result<void>>
  }
  readonly app: {
    getVersions(): Promise<Result<AppVersions>>
  }
}

declare global {
  interface Window {
    /**
     * Injected by the preload via `contextBridge`.
     *
     * Typed as possibly-undefined on purpose: under vitest/jsdom, or if the preload fails to
     * load, this is absent. Every consumer must degrade rather than throw — see
     * `src/renderer/store/obsStore.ts`.
     */
    verger?: VergerApi
  }
}
