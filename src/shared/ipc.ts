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
import type { Result } from './result'

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
}

/** The payload pushed on each event channel. */
export interface IpcEventPayload {
  [IpcEvent.obsStatus]: ObsStatus
  [IpcEvent.obsSceneList]: ObsSceneList
  [IpcEvent.logRecord]: LogRecord
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
