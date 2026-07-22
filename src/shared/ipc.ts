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
import type { GoLiveState } from './golive'
import type { AsrSettings, AsrStatus, AudioInputDevice, TranscriptSegment } from './asr'
import type { Cue, PlanPosition, ServicePlan } from './plan'
import type { CueEngineSettings, CueEngineState, CueSuggestion } from './cue'
import type { Checkpoint, HealthSnapshot } from './health'
import type { ResolvedScripture, ScriptureReference, TranslationSource } from './scripture'
import type { Broadcast, BroadcastTemplate, YouTubeStatus } from './youtube'
import type { Result } from './result'

/**
 * Live status of the overlay HTTP + WebSocket server.
 *
 * `clients` is the number of attached browser sources. An operator seeing `0` while a service
 * is running knows immediately that OBS's Overlays source has died — which is exactly the
 * failure BLUEPRINT.md §9 says must be visible rather than silent.
 */
/** Whether a PowerPoint deck can be converted on this machine. */
export interface DeckImporterStatus {
  /** False when no converter was found — import is disabled and the UI explains why. */
  readonly available: boolean
  /** Which backend was found, e.g. `libreoffice` or `embedded-media`. */
  readonly backend: string | null
  /** Resolved converter path, for the settings readout. */
  readonly executablePath: string | null
  /** Operator-facing explanation when unavailable. */
  readonly detail: string | null
}

/** Progress while converting a deck; decks can take a while and the UI must not look frozen. */
export interface DeckImportProgress {
  readonly stage: 'reading' | 'converting' | 'writing' | 'done' | 'failed'
  readonly slidesDone: number
  readonly slidesTotal: number | null
  readonly message: string | null
}

/** The loaded plan plus where the operator is in it. */
export interface PlanState {
  readonly plan: ServicePlan
  readonly position: PlanPosition
  /** Absolute path the plan was loaded from / will save to, or null when never saved. */
  readonly path: string | null
  readonly dirty: boolean
  /** The cue most recently fired, for the "now showing" readout. */
  readonly lastFired: Cue | null
}

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
  youtubeGetStatus: 'verger:youtube:get-status',
  youtubeSignIn: 'verger:youtube:sign-in',
  youtubeSignOut: 'verger:youtube:sign-out',
  youtubeSetTemplate: 'verger:youtube:set-template',
  youtubeCreateBroadcast: 'verger:youtube:create-broadcast',
  goLiveGetState: 'verger:golive:get-state',
  goLiveStart: 'verger:golive:start',
  goLiveEnd: 'verger:golive:end',
  planGet: 'verger:plan:get',
  planSet: 'verger:plan:set',
  planOpen: 'verger:plan:open',
  planSave: 'verger:plan:save',
  planImportDeck: 'verger:plan:import-deck',
  planFireCue: 'verger:plan:fire-cue',
  planAdvance: 'verger:plan:advance',
  planBack: 'verger:plan:back',
  planGetImporterStatus: 'verger:plan:get-importer-status',
  asrGetStatus: 'verger:asr:get-status',
  asrGetSettings: 'verger:asr:get-settings',
  asrSetSettings: 'verger:asr:set-settings',
  asrStart: 'verger:asr:start',
  asrStop: 'verger:asr:stop',
  asrPushAudio: 'verger:asr:push-audio',
  asrListDevices: 'verger:asr:list-devices',
  cueGetState: 'verger:cue:get-state',
  cueGetSettings: 'verger:cue:get-settings',
  cueSetSettings: 'verger:cue:set-settings',
  cueSetMode: 'verger:cue:set-mode',
  cueConfirm: 'verger:cue:confirm',
  cueDismiss: 'verger:cue:dismiss',
  cuePanic: 'verger:cue:panic',
  cueResume: 'verger:cue:resume',
  cueResolveScripture: 'verger:cue:resolve-scripture',
  cueListTranslations: 'verger:cue:list-translations',
  healthGet: 'verger:health:get',
  healthListCheckpoints: 'verger:health:list-checkpoints',
  healthRestoreCheckpoint: 'verger:health:restore-checkpoint',
  healthReloadOverlays: 'verger:health:reload-overlays',
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
  youtubeStatus: 'verger:youtube:status',
  goLiveState: 'verger:golive:state',
  planState: 'verger:plan:state',
  planImportProgress: 'verger:plan:import-progress',
  asrStatus: 'verger:asr:status',
  asrTranscript: 'verger:asr:transcript',
  cueState: 'verger:cue:state',
  cueSuggestion: 'verger:cue:suggestion',
  healthSnapshot: 'verger:health:snapshot',
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
  [IpcChannel.youtubeGetStatus]: void
  [IpcChannel.youtubeSignIn]: void
  [IpcChannel.youtubeSignOut]: void
  [IpcChannel.youtubeSetTemplate]: BroadcastTemplate
  [IpcChannel.youtubeCreateBroadcast]: { scheduledStartTime?: string }
  [IpcChannel.goLiveGetState]: void
  [IpcChannel.goLiveStart]: void
  [IpcChannel.goLiveEnd]: void
  [IpcChannel.planGet]: void
  [IpcChannel.planSet]: ServicePlan
  [IpcChannel.planOpen]: { path?: string }
  [IpcChannel.planSave]: { path?: string }
  [IpcChannel.planImportDeck]: { path?: string }
  [IpcChannel.planFireCue]: { cueId: string }
  [IpcChannel.planAdvance]: void
  [IpcChannel.planBack]: void
  [IpcChannel.planGetImporterStatus]: void
  [IpcChannel.asrGetStatus]: void
  [IpcChannel.asrGetSettings]: void
  [IpcChannel.asrSetSettings]: AsrSettings
  [IpcChannel.asrStart]: void
  [IpcChannel.asrStop]: void
  /** One PCM chunk from the renderer's capture. 16 kHz mono s16le. */
  [IpcChannel.asrPushAudio]: ArrayBuffer
  [IpcChannel.asrListDevices]: readonly AudioInputDevice[]
  [IpcChannel.cueGetState]: void
  [IpcChannel.cueGetSettings]: void
  [IpcChannel.cueSetSettings]: CueEngineSettings
  [IpcChannel.cueSetMode]: { mode: CueEngineSettings['mode'] }
  [IpcChannel.cueConfirm]: { suggestionId: string }
  [IpcChannel.cueDismiss]: { suggestionId: string }
  [IpcChannel.cuePanic]: void
  [IpcChannel.cueResume]: void
  [IpcChannel.cueResolveScripture]: { reference: ScriptureReference; translation?: string }
  [IpcChannel.cueListTranslations]: void
  [IpcChannel.healthGet]: void
  [IpcChannel.healthListCheckpoints]: void
  [IpcChannel.healthRestoreCheckpoint]: { checkpointId: string }
  [IpcChannel.healthReloadOverlays]: void
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
  [IpcChannel.youtubeGetStatus]: Result<YouTubeStatus>
  [IpcChannel.youtubeSignIn]: Result<YouTubeStatus>
  [IpcChannel.youtubeSignOut]: Result<YouTubeStatus>
  [IpcChannel.youtubeSetTemplate]: Result<YouTubeStatus>
  [IpcChannel.youtubeCreateBroadcast]: Result<Broadcast>
  [IpcChannel.goLiveGetState]: Result<GoLiveState>
  [IpcChannel.goLiveStart]: Result<GoLiveState>
  [IpcChannel.goLiveEnd]: Result<GoLiveState>
  [IpcChannel.planGet]: Result<PlanState>
  [IpcChannel.planSet]: Result<PlanState>
  [IpcChannel.planOpen]: Result<PlanState>
  [IpcChannel.planSave]: Result<PlanState>
  [IpcChannel.planImportDeck]: Result<PlanState>
  [IpcChannel.planFireCue]: Result<PlanState>
  [IpcChannel.planAdvance]: Result<PlanState>
  [IpcChannel.planBack]: Result<PlanState>
  [IpcChannel.planGetImporterStatus]: Result<DeckImporterStatus>
  [IpcChannel.asrGetStatus]: Result<AsrStatus>
  [IpcChannel.asrGetSettings]: Result<AsrSettings>
  [IpcChannel.asrSetSettings]: Result<AsrSettings>
  [IpcChannel.asrStart]: Result<AsrStatus>
  [IpcChannel.asrStop]: Result<AsrStatus>
  [IpcChannel.asrPushAudio]: Result<void>
  [IpcChannel.asrListDevices]: Result<void>
  [IpcChannel.cueGetState]: Result<CueEngineState>
  [IpcChannel.cueGetSettings]: Result<CueEngineSettings>
  [IpcChannel.cueSetSettings]: Result<CueEngineSettings>
  [IpcChannel.cueSetMode]: Result<CueEngineState>
  [IpcChannel.cueConfirm]: Result<CueEngineState>
  [IpcChannel.cueDismiss]: Result<CueEngineState>
  [IpcChannel.cuePanic]: Result<CueEngineState>
  [IpcChannel.cueResume]: Result<CueEngineState>
  [IpcChannel.cueResolveScripture]: Result<ResolvedScripture>
  [IpcChannel.cueListTranslations]: Result<readonly TranslationSource[]>
  [IpcChannel.healthGet]: Result<HealthSnapshot>
  [IpcChannel.healthListCheckpoints]: Result<readonly Checkpoint[]>
  [IpcChannel.healthRestoreCheckpoint]: Result<HealthSnapshot>
  [IpcChannel.healthReloadOverlays]: Result<HealthSnapshot>
}

/** The payload pushed on each event channel. */
export interface IpcEventPayload {
  [IpcEvent.obsStatus]: ObsStatus
  [IpcEvent.obsSceneList]: ObsSceneList
  [IpcEvent.logRecord]: LogRecord
  [IpcEvent.overlayState]: OverlayState
  [IpcEvent.overlayServerInfo]: OverlayServerInfo
  [IpcEvent.cameraState]: CameraState
  [IpcEvent.youtubeStatus]: YouTubeStatus
  [IpcEvent.goLiveState]: GoLiveState
  [IpcEvent.planState]: PlanState
  [IpcEvent.planImportProgress]: DeckImportProgress
  [IpcEvent.asrStatus]: AsrStatus
  [IpcEvent.asrTranscript]: TranscriptSegment
  [IpcEvent.cueState]: CueEngineState
  [IpcEvent.cueSuggestion]: CueSuggestion
  [IpcEvent.healthSnapshot]: HealthSnapshot
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
  readonly youtube: {
    getStatus(): Promise<Result<YouTubeStatus>>
    /** Runs the loopback OAuth consent flow. Silent on later launches. */
    signIn(): Promise<Result<YouTubeStatus>>
    /** Forgets the stored refresh token. */
    signOut(): Promise<Result<YouTubeStatus>>
    setTemplate(template: BroadcastTemplate): Promise<Result<YouTubeStatus>>
    /** Creates the weekly broadcast and binds the persistent stream. */
    createBroadcast(options: { scheduledStartTime?: string }): Promise<Result<Broadcast>>
    onStatus(callback: (status: YouTubeStatus) => void): Unsubscribe
  }
  readonly goLive: {
    getState(): Promise<Result<GoLiveState>>
    /** Runs the full GO LIVE sequence. Recording always starts with the stream. */
    start(): Promise<Result<GoLiveState>>
    /** Ends the broadcast, stops the stream and stops the recording. */
    end(): Promise<Result<GoLiveState>>
    onState(callback: (state: GoLiveState) => void): Unsubscribe
  }
  readonly plan: {
    getState(): Promise<Result<PlanState>>
    set(plan: ServicePlan): Promise<Result<PlanState>>
    open(options: { path?: string }): Promise<Result<PlanState>>
    save(options: { path?: string }): Promise<Result<PlanState>>
    /** Convert a .pptx into one slide cue per slide. */
    importDeck(options: { path?: string }): Promise<Result<PlanState>>
    fireCue(options: { cueId: string }): Promise<Result<PlanState>>
    advance(): Promise<Result<PlanState>>
    back(): Promise<Result<PlanState>>
    getImporterStatus(): Promise<Result<DeckImporterStatus>>
    onState(callback: (state: PlanState) => void): Unsubscribe
    onImportProgress(callback: (progress: DeckImportProgress) => void): Unsubscribe
  }
  readonly asr: {
    getStatus(): Promise<Result<AsrStatus>>
    getSettings(): Promise<Result<AsrSettings>>
    setSettings(settings: AsrSettings): Promise<Result<AsrSettings>>
    start(): Promise<Result<AsrStatus>>
    stop(): Promise<Result<AsrStatus>>
    /**
     * Hand one PCM chunk to the recogniser.
     *
     * Capture lives in the RENDERER: only it has `getUserMedia`. The main process has no
     * microphone access in Electron without a native module, so audio flows renderer -> main,
     * not the other way round.
     */
    pushAudio(chunk: ArrayBuffer): Promise<Result<void>>
    /** Report the devices the renderer enumerated, so settings can list them. */
    listDevices(devices: readonly AudioInputDevice[]): Promise<Result<void>>
    onStatus(callback: (status: AsrStatus) => void): Unsubscribe
    onTranscript(callback: (segment: TranscriptSegment) => void): Unsubscribe
  }
  readonly cue: {
    getState(): Promise<Result<CueEngineState>>
    getSettings(): Promise<Result<CueEngineSettings>>
    setSettings(settings: CueEngineSettings): Promise<Result<CueEngineSettings>>
    /** The trust dial. */
    setMode(options: { mode: CueEngineSettings['mode'] }): Promise<Result<CueEngineState>>
    /** Accept the pending suggestion (Y / pedal). */
    confirm(options: { suggestionId: string }): Promise<Result<CueEngineState>>
    /** Reject it (N). */
    dismiss(options: { suggestionId: string }): Promise<Result<CueEngineState>>
    /** Master switch: halt all automation. Never touches the stream or the recording. */
    panic(): Promise<Result<CueEngineState>>
    /** Re-engage automation after a panic. Deliberately explicit — never automatic. */
    resume(): Promise<Result<CueEngineState>>
    resolveScripture(options: {
      reference: ScriptureReference
      translation?: string
    }): Promise<Result<ResolvedScripture>>
    listTranslations(): Promise<Result<readonly TranslationSource[]>>
    onState(callback: (state: CueEngineState) => void): Unsubscribe
    onSuggestion(callback: (suggestion: CueSuggestion) => void): Unsubscribe
  }
  readonly health: {
    get(): Promise<Result<HealthSnapshot>>
    listCheckpoints(): Promise<Result<readonly Checkpoint[]>>
    /** Rewind AUTOMATION state only. Never touches the stream or the recording. */
    restoreCheckpoint(options: { checkpointId: string }): Promise<Result<HealthSnapshot>>
    /** Force every attached overlay browser source to reload and re-sync. */
    reloadOverlays(): Promise<Result<HealthSnapshot>>
    onSnapshot(callback: (snapshot: HealthSnapshot) => void): Unsubscribe
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
