/**
 * A fully typed fake of the preload bridge.
 *
 * OBS Studio is not installed on the build machine, and Constraint 7 says every test must pass
 * against a mock with no network and no live OBS. This is that mock. It implements the whole
 * `VergerApi` surface, records every call, lets a test swap any response, and — critically — lets
 * a test *push* an event the way the main process would, so the store's subscription wiring is
 * exercised for real rather than stubbed out.
 *
 * It deliberately does not use `vi.fn()`: the call log is plain arrays, so the same factory works
 * from a non-vitest harness (e.g. a Playwright fixture in Phase 10) without dragging the vitest
 * runtime into the renderer bundle.
 */

import type {
  AsrProviderId,
  AsrSettings,
  AsrStatus,
  AudioInputDevice,
  TranscriptSegment,
} from '@shared/asr'
import { defaultAsrSettings, idleAsrStatus } from '@shared/asr'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import { defaultCameraConfig, findBinding, slotForScene } from '@shared/camera'
import type { ConfigSummary } from '@shared/config'
import { emptyConfiguredMap } from '@shared/config'
import type {
  CueEngineSettings,
  CueEngineState,
  CueSuggestion,
  HotPhrase,
  TrustMode,
} from '@shared/cue'
import { defaultCueEngineSettings, idleCueEngineState } from '@shared/cue'
import type {
  GoLiveState,
  GoLiveStep,
  GoLiveStepStatus,
  ObsOutputState,
  StepState,
} from '@shared/golive'
import {
  GO_LIVE_STEPS,
  emptyObsOutputState,
  idleGoLiveState,
  shouldReattach,
} from '@shared/golive'
import type {
  AppVersions,
  DeckImportProgress,
  DeckImporterStatus,
  IpcEventPayload,
  IpcEventValue,
  OverlayServerInfo,
  PlanState,
  Unsubscribe,
  VergerApi,
} from '@shared/ipc'
import { IpcEvent } from '@shared/ipc'
import type { LogRecord } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { initialObsStatus } from '@shared/obs'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { applyOverlayCommand, emptyOverlayState } from '@shared/overlay'
import type { Cue, ServicePlan } from '@shared/plan'
import { advance as advancePosition, initialPlanPosition, stepBack } from '@shared/plan'
import type { Result } from '@shared/result'
import { ErrorCode, err, ok } from '@shared/result'
import type {
  ResolvedScripture,
  ScriptureReference,
  TranslationSource,
} from '@shared/scripture'
import { CONFIDENCE_EXACT, CONFIDENCE_FUZZY } from '@shared/scripture'
import type {
  Broadcast,
  BroadcastTemplate,
  PersistentStream,
  PreflightIssue,
  YouTubeChannel,
  YouTubeStatus,
} from '@shared/youtube'
import { defaultBroadcastTemplate, expandTitleTemplate } from '@shared/youtube'

/** Every response the fake can return, one per `VergerApi` method. */
export interface MockResponses {
  getStatus: Result<ObsStatus>
  getSceneList: Result<ObsSceneList>
  connect: Result<ObsStatus>
  disconnect: Result<ObsStatus>
  setConfig: Result<ObsStatus>
  configGet: Result<ConfigSummary>
  logWrite: Result<void>
  getVersions: Result<AppVersions>
  overlayGetState: Result<OverlayState>
  /**
   * What `overlay.send` resolves with.
   *
   * `null` — the default — means "behave like the real server": run the shared reducer over the
   * fake's own snapshot and return the result. A test that needs a refusal assigns an `Err` here
   * instead. Nothing in the renderer may reduce overlay state itself, so the reduction has to
   * live on this side of the boundary to be realistic.
   */
  overlaySend: Result<OverlayState> | null
  overlayGetServerInfo: Result<OverlayServerInfo>
  cameraGetConfig: Result<CameraConfig>
  /**
   * What `camera.setConfig` resolves with.
   *
   * `null` — the default — means "behave like the real service": adopt the supplied configuration,
   * re-derive which slot the live scene now belongs to, and hand the configuration back.
   */
  cameraSetConfig: Result<CameraConfig> | null
  cameraGetState: Result<CameraState>
  /**
   * What `camera.select` resolves with.
   *
   * `null` — the default — means "behave like the real service": look the slot up in the fake's own
   * configuration, refuse an unbound slot with `INVALID_ARG`, and otherwise move the program scene.
   * Critically, this path touches **nothing** in the overlay snapshot: the mock enforces the
   * independence guarantee rather than merely not violating it by accident.
   */
  cameraSelect: Result<CameraState> | null
  /**
   * What `youtube.getStatus` resolves with.
   *
   * The default is **not-configured**, because that is the state this app is genuinely in on a
   * machine with no `GOOGLE_CLIENT_ID`. A test that wants a signed-in channel says so explicitly.
   */
  youtubeGetStatus: Result<YouTubeStatus>
  /**
   * What `youtube.signIn` resolves with.
   *
   * `null` — the default — means "behave like the real service": refuse with `NOT_CONFIGURED`
   * when there is no OAuth client, and otherwise settle into `signed-in` on {@link MOCK_YOUTUBE_CHANNEL}.
   * Signing in with no client id genuinely cannot work, and the fake refuses it rather than
   * pretending, so a UI regression that enables the button shows up as a failing assertion.
   */
  youtubeSignIn: Result<YouTubeStatus> | null
  /** `null` — the default — means "behave like the real service": drop back to `signed-out`. */
  youtubeSignOut: Result<YouTubeStatus> | null
  /** `null` — the default — means "behave like the real service": adopt the supplied template. */
  youtubeSetTemplate: Result<YouTubeStatus> | null
  /**
   * `null` — the default — means "behave like the real service": expand the stored template,
   * mint a broadcast, and bind the persistent stream.
   */
  youtubeCreateBroadcast: Result<Broadcast> | null
  /**
   * What `goLive.getState` resolves with.
   *
   * Idle by default: nothing is streaming, nothing is recording, and no step has been attempted.
   * A test that wants a service already in progress — the crash-re-attach case — says so with
   * {@link mockReattachedGoLiveState}.
   */
  goLiveGetState: Result<GoLiveState>
  /**
   * What `goLive.start` resolves with.
   *
   * `null` — the default — means "behave like the real orchestrator": adopt an already-running
   * OBS rather than starting a second stream ({@link shouldReattach}), otherwise run every step
   * and **always** start the local recording alongside the stream. When YouTube is not signed in
   * the two YouTube steps are `skipped` and OBS still streams and records, which is exactly what
   * Standing Rule 3 demands and what this machine will actually do.
   */
  goLiveStart: Result<GoLiveState> | null
  /**
   * What `goLive.end` resolves with.
   *
   * `null` — the default — means "behave like the real orchestrator": stop the stream, stop the
   * recording, fall back to `idle`, and keep the recording path so the operator can still find
   * their backup afterwards.
   */
  goLiveEnd: Result<GoLiveState> | null
  /**
   * What `plan.getState` resolves with.
   *
   * An **empty** plan by default, because that is what a freshly launched Verger genuinely has:
   * no file open, nothing fired. Tests that want an authored order of service say so with
   * {@link mockPlanState}.
   */
  planGetState: Result<PlanState>
  /**
   * `null` — the default — means "behave like the real service": adopt the supplied plan, mark it
   * dirty, and clamp the position so a cue that was deleted out from under the pointer cannot
   * leave the operator pointing past the end of the list.
   */
  planSet: Result<PlanState> | null
  /** `null` — the default — means "behave like the real service": load {@link mockPlanState}. */
  planOpen: Result<PlanState> | null
  /** `null` — the default — means "behave like the real service": clear `dirty`, keep the plan. */
  planSave: Result<PlanState> | null
  /**
   * What `plan.importDeck` resolves with.
   *
   * The default is a **refusal**, because this machine has no PowerPoint converter installed and
   * the honest fake refuses rather than inventing slides. The UI is supposed to make this
   * unreachable by disabling the control; a regression that enables it fails here.
   */
  planImportDeck: Result<PlanState> | null
  /**
   * `null` — the default — means "behave like the real service": move the pointer to the named
   * cue, remember it as `lastFired`, and record it as fired.
   */
  planFireCue: Result<PlanState> | null
  /** `null` — the default — means "behave like the real service": {@link advancePosition}. */
  planAdvance: Result<PlanState> | null
  /** `null` — the default — means "behave like the real service": {@link stepBack}. */
  planBack: Result<PlanState> | null
  /**
   * What `plan.getImporterStatus` resolves with.
   *
   * Unavailable by default — see {@link MOCK_DECK_IMPORTER_UNAVAILABLE}. This is not pessimism,
   * it is this build machine's actual state, and every screen test therefore exercises the
   * degraded path unless it deliberately opts out.
   */
  planGetImporterStatus: Result<DeckImporterStatus>
  /**
   * What `asr.getStatus` resolves with.
   *
   * **Not-configured by default**, because that is this machine's genuine state: `DEEPGRAM_API_KEY`
   * is empty and no key is coming. Standing Rule 5 says an empty key means the subsystem rests in
   * `not-configured` rather than crashing, and making that the fake's default means every screen
   * test exercises the "you are running manual, nothing is blocked" path unless it opts out.
   */
  asrGetStatus: Result<AsrStatus>
  asrGetSettings: Result<AsrSettings>
  /** `null` — the default — means "behave like the real service": adopt the supplied settings. */
  asrSetSettings: Result<AsrSettings> | null
  /**
   * `null` — the default — means "behave like the real service": refuse with `NOT_CONFIGURED` when
   * the subsystem has no usable provider, and otherwise settle into `listening` on the provider the
   * selection mode implies.
   */
  asrStart: Result<AsrStatus> | null
  /** `null` — the default — means "behave like the real service": drop back to the resting state. */
  asrStop: Result<AsrStatus> | null
  asrPushAudio: Result<void>
  asrListDevices: Result<void>
  /**
   * What `cue.getState` resolves with.
   *
   * {@link idleCueEngineState} by default — enabled, **assisting**, nothing pending, not panicked.
   * Assist is the default in the contract and it is the default here too, so a screen test that
   * never mentions the trust dial is still exercising the mode an operator actually runs.
   */
  cueGetState: Result<CueEngineState>
  cueGetSettings: Result<CueEngineSettings>
  /** `null` — the default — means "behave like the real service": adopt the supplied settings. */
  cueSetSettings: Result<CueEngineSettings> | null
  /** `null` — the default — means "behave like the real service": adopt the mode. */
  cueSetMode: Result<CueEngineState> | null
  /**
   * `null` — the default — means "behave like the real service": drop the pending suggestion and
   * record it as fired. Note it does **not** touch the plan snapshot — see the note on the cue
   * snapshot in {@link createMockVergerApi}.
   */
  cueConfirm: Result<CueEngineState> | null
  /** `null` — the default — means "behave like the real service": drop the pending suggestion. */
  cueDismiss: Result<CueEngineState> | null
  /**
   * `null` — the default — means "behave like the real service": set `panicked`, drop the pending
   * suggestion, and touch **nothing** else. The fake owns no stream and no recording precisely so
   * that a panic which reached them would have to be written here to happen at all.
   */
  cuePanic: Result<CueEngineState> | null
  /** `null` — the default — means "behave like the real service": clear `panicked`. */
  cueResume: Result<CueEngineState> | null
  /**
   * What `cue.resolveScripture` resolves with.
   *
   * `null` — the default — means "behave like the real service": hand back
   * {@link MOCK_VERSE_TEXT_PLACEHOLDER} under the requested translation. A test that wants the
   * **unresolved** case — the one the never-auto-show-unless-resolved gate exists for — assigns an
   * `Err` here.
   */
  cueResolveScripture: Result<ResolvedScripture> | null
  cueListTranslations: Result<readonly TranslationSource[]>
}

/** Everything the fake recorded. Assert against this instead of on spies. */
export interface MockCalls {
  readonly getStatus: number[]
  readonly getSceneList: number[]
  readonly connect: ObsConnectionConfig[]
  readonly disconnect: number[]
  readonly setConfig: ObsConnectionConfig[]
  readonly configGet: number[]
  readonly logWrite: LogRecord[]
  readonly getVersions: number[]
  readonly overlayGetState: number[]
  /** Every command the UI sent, in order. The layer-independence assertions read this. */
  readonly overlaySend: OverlayCommand[]
  readonly overlayGetServerInfo: number[]
  readonly cameraGetConfig: number[]
  readonly cameraSetConfig: CameraConfig[]
  readonly cameraGetState: number[]
  /** Every camera switch the UI asked for, in order. The decoupling assertions read this. */
  readonly cameraSelect: CameraSlot[]
  readonly youtubeGetStatus: number[]
  readonly youtubeSignIn: number[]
  readonly youtubeSignOut: number[]
  /** Every template the UI saved, in order. */
  readonly youtubeSetTemplate: BroadcastTemplate[]
  /** Every create-broadcast request, in order. */
  readonly youtubeCreateBroadcast: { scheduledStartTime?: string }[]
  readonly goLiveGetState: number[]
  /** Every GO LIVE press, in order. Length is how many times a stream was asked for. */
  readonly goLiveStart: number[]
  /** Every completed END hold, in order. A short press must never appear here. */
  readonly goLiveEnd: number[]
  readonly planGetState: number[]
  /** Every plan the editor pushed, in order. The reorder/add/delete assertions read this. */
  readonly planSet: ServicePlan[]
  readonly planOpen: { path?: string }[]
  readonly planSave: { path?: string }[]
  readonly planImportDeck: { path?: string }[]
  readonly planFireCue: { cueId: string }[]
  readonly planAdvance: number[]
  readonly planBack: number[]
  readonly planGetImporterStatus: number[]
  readonly asrGetStatus: number[]
  readonly asrGetSettings: number[]
  /** Every settings save, in order. The vocabulary-editor assertions read this. */
  readonly asrSetSettings: AsrSettings[]
  readonly asrStart: number[]
  readonly asrStop: number[]
  /**
   * The **byte length** of every audio chunk pushed, in order — never the audio itself.
   *
   * Keeping only the size is not squeamishness: a fixture that retained microphone samples would
   * be a recording of whatever was said, and Standing Rule 4 keeps that out of the repo. Byte
   * lengths are enough to assert the 100 ms chunking contract.
   */
  readonly asrPushAudio: number[]
  /** Every device list the renderer reported, in order. */
  readonly asrListDevices: (readonly AudioInputDevice[])[]
  readonly cueGetState: number[]
  readonly cueGetSettings: number[]
  /** Every settings save, in order. The hot-phrase editor's assertions read this. */
  readonly cueSetSettings: CueEngineSettings[]
  /** Every trust-dial change, in order. */
  readonly cueSetMode: TrustMode[]
  /** Every accepted suggestion, in order. */
  readonly cueConfirm: { suggestionId: string }[]
  /** Every rejected suggestion, in order. A veto that never arrived is a bug. */
  readonly cueDismiss: { suggestionId: string }[]
  /** Every PANIC. Length is how many times automation was halted; a short press must not appear. */
  readonly cuePanic: number[]
  /** Every RESUME. Automation may never come back without one of these. */
  readonly cueResume: number[]
  /** Every resolution request, in order. Never the verse text — only what was asked for. */
  readonly cueResolveScripture: { reference: ScriptureReference; translation?: string }[]
  readonly cueListTranslations: number[]
}

export interface MockVergerApi {
  /** Assign this to `window.verger`, or pass it around directly. */
  readonly api: VergerApi
  /** Mutable — reassign a field mid-test to change what the next call returns. */
  responses: MockResponses
  readonly calls: MockCalls
  /** Push an event exactly as the main process would. */
  emit<K extends IpcEventValue>(event: K, payload: IpcEventPayload[K]): void
  /** How many live listeners a channel has. Proves an unsubscribe actually unsubscribed. */
  listenerCount(event: IpcEventValue): number
}

/** A fixed, obviously-fake timestamp so snapshots and assertions stay deterministic. */
export const MOCK_NOW = 1_700_000_000_000

export const MOCK_APP_VERSIONS: AppVersions = {
  app: '0.1.0',
  electron: '38.8.6',
  chrome: '140.0.0.0',
  node: '22.20.0',
  v8: '14.0.0',
}

export const MOCK_CONFIG_SUMMARY: ConfigSummary = {
  configured: emptyConfiguredMap(),
  obsConfigured: false,
  googleConfigured: false,
  warnings: [],
}

/** A representative connected status, with the version fields the Connection screen renders. */
export function mockConnectedStatus(overrides: Partial<ObsStatus> = {}): ObsStatus {
  return {
    ...initialObsStatus('connected', MOCK_NOW),
    obsVersion: '30.2.3',
    obsWebSocketVersion: '5.5.4',
    rpcVersion: 1,
    currentProgramScene: 'Wide',
    ...overrides,
  }
}

/** A scene list shaped the way obs-websocket reports one. */
export function mockSceneList(overrides: Partial<ObsSceneList> = {}): ObsSceneList {
  return {
    scenes: [
      { name: 'Wide', index: 0 },
      { name: 'Pulpit', index: 1 },
      { name: 'Welcome loop', index: 2 },
    ],
    currentProgramScene: 'Wide',
    currentPreviewScene: null,
    ...overrides,
  }
}

/**
 * A running overlay server with one browser source attached.
 *
 * `pageUrl` comes from `@shared/net`, never from a string literal here — the whole point of that
 * module is that the URL an operator is told to paste into OBS is derived from the same constants
 * the server binds with, in tests as well as in production.
 */
export function mockOverlayServerInfo(
  overrides: Partial<OverlayServerInfo> = {},
): OverlayServerInfo {
  return {
    running: true,
    host: LOOPBACK_ADDRESS,
    port: OVERLAY_SERVER_PORT,
    pageUrl: overlayPageUrl(),
    clients: 1,
    lastError: null,
    ...overrides,
  }
}

/**
 * An overlay snapshot with a lower-third up.
 *
 * Standing Rule 4: no scripture text is authored here or anywhere else in the repo. Where a test
 * needs a verse body it passes an obvious placeholder.
 */
export function mockOverlayState(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    ...emptyOverlayState(),
    lowerThird: { visible: true, line1: '홍길동', line2: '찬양 인도', template: 'bar' },
    revision: 4,
    ...overrides,
  }
}

/**
 * The scene each camera slot is bound to in the fixtures.
 *
 * Fully mapped on purpose: a *usable* console is the ordinary case, so tests describe it in one
 * word and spell out the exceptional unmapped case explicitly via {@link mockCameraConfig}.
 */
export const MOCK_CAMERA_SCENES: Readonly<Record<CameraSlot, string>> = {
  cam1: 'Cam 1',
  cam2: 'Cam 2',
  wide: 'Wide',
  pulpit: 'Pulpit',
}

/** Transitions a stock OBS install reports. The settings picker is populated from these. */
export const MOCK_TRANSITIONS: readonly string[] = ['Cut', 'Fade', 'Stinger']

/**
 * A camera configuration.
 *
 * `scenes` overrides individual slots — pass `{ pulpit: null }` for the unmapped-button case,
 * which must render as disabled and explain itself rather than firing at a scene that is not there.
 */
export function mockCameraConfig(
  scenes: Partial<Record<CameraSlot, string | null>> = {},
): CameraConfig {
  const base = defaultCameraConfig()
  return {
    bindings: base.bindings.map((binding) => ({
      ...binding,
      sceneName:
        binding.slot in scenes
          ? (scenes[binding.slot] ?? null)
          : MOCK_CAMERA_SCENES[binding.slot],
    })),
  }
}

/** A live camera state: OBS is on CAM 1's scene, with the stock transitions available. */
export function mockCameraState(overrides: Partial<CameraState> = {}): CameraState {
  return {
    currentProgramScene: MOCK_CAMERA_SCENES.cam1,
    activeSlot: 'cam1',
    availableTransitions: MOCK_TRANSITIONS,
    ...overrides,
  }
}

/** Nothing observed yet: no program scene, no active slot, no transitions listed. */
export function emptyCameraState(): CameraState {
  return { currentProgramScene: null, activeSlot: null, availableTransitions: [] }
}

/**
 * The channel the fake signs into.
 *
 * Given a deliberately distinctive title: the "connected as …" readout exists so an operator with
 * three Google accounts can catch the wrong one, and a fixture called "Test Channel" would let a
 * regression that renders the wrong channel slip through unnoticed.
 */
export const MOCK_YOUTUBE_CHANNEL: YouTubeChannel = {
  id: 'UC_mock_channel',
  title: '은혜교회 · Grace Church',
  customUrl: '@grace-church-mock',
}

/** A second channel, for the "you are about to broadcast to the wrong account" case. */
export const MOCK_OTHER_YOUTUBE_CHANNEL: YouTubeChannel = {
  id: 'UC_mock_personal',
  title: 'Hong Gil-dong (personal)',
  customUrl: null,
}

/** The persistent ingest stream. Note there is no key field, here or anywhere else. */
export function mockPersistentStream(overrides: Partial<PersistentStream> = {}): PersistentStream {
  return {
    id: 'mock-persistent-stream',
    title: 'Verger persistent stream',
    ingestAddress: 'rtmp://a.rtmp.youtube.com/live2',
    health: 'noData',
    ...overrides,
  }
}

/** A created-but-not-live broadcast, the state Phase 4 can reach. */
export function mockBroadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: 'mock-broadcast-id',
    title: 'Sunday Service — 2023-11-14',
    privacy: 'unlisted',
    scheduledStartTime: '2023-11-14T01:00:00.000Z',
    lifecycle: 'ready',
    boundStreamId: 'mock-persistent-stream',
    watchUrl: 'https://www.youtube.com/watch?v=mock-broadcast-id',
    ...overrides,
  }
}

/** The CCLI streaming-licence gate from `docs/v2-notes/LEGAL_AND_CONTENT.md`, as an error. */
export const MOCK_PREFLIGHT_CCLI: PreflightIssue = {
  code: 'ccli-streaming-licence',
  message:
    'No CCLI Streaming Licence number has been recorded. Streaming worship music requires one.',
  severity: 'error',
}

/** A missing-metadata warning: shown, but the operator's call. */
export const MOCK_PREFLIGHT_METADATA: PreflightIssue = {
  code: 'song-copyright-metadata',
  message: 'One song in the set list has no author or CCLI song number recorded.',
  severity: 'warning',
}

/**
 * The state this machine is actually in: no `GOOGLE_CLIENT_ID`, no `GOOGLE_CLIENT_SECRET`.
 *
 * It is the fake's default on purpose, so every screen test exercises the degraded path unless it
 * deliberately opts out.
 */
export function mockNotConfiguredYouTubeStatus(
  overrides: Partial<YouTubeStatus> = {},
): YouTubeStatus {
  return {
    auth: { state: 'not-configured', channel: null, lastError: null },
    broadcast: null,
    stream: null,
    template: defaultBroadcastTemplate(),
    preflight: [],
    ...overrides,
  }
}

/** Signed in, with a persistent stream waiting and nothing broadcast yet. */
export function mockSignedInYouTubeStatus(overrides: Partial<YouTubeStatus> = {}): YouTubeStatus {
  return {
    auth: { state: 'signed-in', channel: MOCK_YOUTUBE_CHANNEL, lastError: null },
    broadcast: null,
    stream: mockPersistentStream(),
    template: defaultBroadcastTemplate(),
    preflight: [],
    ...overrides,
  }
}

/**
 * Where OBS is writing the local recording.
 *
 * Obviously a fixture, but shaped like a real OBS filename — the panel prints this verbatim and a
 * regression that mangled the path would be invisible against a placeholder like "path".
 */
export const MOCK_RECORDING_PATH = 'C:\\Verger\\recordings\\2023-11-14 10-00-00.mkv'

/** One hour of service, in milliseconds. The elapsed-time readout is built against this. */
export const MOCK_ELAPSED_MS = 3_600_000

/** Nothing running: the state OBS reports before GO LIVE is pressed. */
export function mockObsOutputState(overrides: Partial<ObsOutputState> = {}): ObsOutputState {
  return { ...emptyObsOutputState(), ...overrides }
}

/**
 * OBS pushing *and* recording.
 *
 * Both flags together, never `streaming` alone, because Standing Rule 3 says the two always start
 * together. A fixture with `streaming: true, recording: false` is a *fault* fixture and tests that
 * want it must say so explicitly.
 */
export function mockStreamingObsOutputState(
  overrides: Partial<ObsOutputState> = {},
): ObsOutputState {
  return mockObsOutputState({
    streaming: true,
    recording: true,
    streamTimecodeMs: MOCK_ELAPSED_MS,
    recordTimecodeMs: MOCK_ELAPSED_MS,
    skippedFrames: 0,
    totalFrames: 216_000,
    recordingPath: MOCK_RECORDING_PATH,
    ...overrides,
  })
}

/** Build the five step statuses, naming only the ones that are not still `pending`. */
export function mockGoLiveSteps(
  states: Partial<Record<GoLiveStep, StepState>> = {},
  messages: Partial<Record<GoLiveStep, string>> = {},
): readonly GoLiveStepStatus[] {
  return GO_LIVE_STEPS.map((step) => ({
    step,
    state: states[step] ?? 'pending',
    message: messages[step] ?? null,
    startedAt: null,
    finishedAt: null,
  }))
}

/** Mid-sequence: every step before `running` has finished, `running` is in flight. */
export function mockStartingGoLiveState(running: GoLiveStep = 'stream'): GoLiveState {
  const index = GO_LIVE_STEPS.indexOf(running)
  const states: Partial<Record<GoLiveStep, StepState>> = {}
  for (const [position, step] of GO_LIVE_STEPS.entries()) {
    states[step] = position < index ? 'done' : position === index ? 'running' : 'pending'
  }
  return {
    ...idleGoLiveState(),
    phase: 'starting',
    steps: mockGoLiveSteps(states),
    obs: mockObsOutputState({
      streaming: index > GO_LIVE_STEPS.indexOf('stream'),
      recording: index > GO_LIVE_STEPS.indexOf('record'),
    }),
  }
}

/** Fully live: every step done, OBS streaming and recording, an hour on the clock. */
export function mockLiveGoLiveState(overrides: Partial<GoLiveState> = {}): GoLiveState {
  return {
    ...idleGoLiveState(),
    phase: 'live',
    steps: mockGoLiveSteps({
      broadcast: 'done',
      stream: 'done',
      record: 'done',
      health: 'done',
      transition: 'done',
    }),
    liveSince: MOCK_NOW - MOCK_ELAPSED_MS,
    obs: mockStreamingObsOutputState(),
    ...overrides,
  }
}

/**
 * The likeliest real failure: OBS is streaming and recording, YouTube never transitioned.
 *
 * Deliberately not collapsed into `live` or `failed`. The congregation's feed is going to disk and
 * to YouTube's ingest, and it is not public — both halves of that are true at once.
 */
export function mockPartialGoLiveState(overrides: Partial<GoLiveState> = {}): GoLiveState {
  return {
    ...mockLiveGoLiveState(),
    phase: 'partial',
    steps: mockGoLiveSteps(
      {
        broadcast: 'done',
        stream: 'done',
        record: 'done',
        health: 'done',
        transition: 'failed',
      },
      { transition: 'YouTube refused the transition to live.' },
    ),
    lastError: 'YouTube refused the transition to live.',
    ...overrides,
  }
}

/**
 * Verger relaunched into a service that was already running.
 *
 * `reattached: true`, and the two YouTube steps are `skipped` rather than `done`: this process
 * never ran them, and claiming otherwise would tell the operator the broadcast is public when
 * nothing here knows that.
 */
export function mockReattachedGoLiveState(overrides: Partial<GoLiveState> = {}): GoLiveState {
  return {
    ...idleGoLiveState(),
    phase: 'live',
    steps: mockGoLiveSteps(
      {
        broadcast: 'skipped',
        stream: 'done',
        record: 'done',
        health: 'done',
        transition: 'skipped',
      },
      { stream: 'Adopted a stream OBS was already running.' },
    ),
    liveSince: MOCK_NOW - MOCK_ELAPSED_MS,
    obs: mockStreamingObsOutputState(),
    reattached: true,
    ...overrides,
  }
}

/** A start that fell over before OBS began pushing. Nothing is streaming, nothing is recording. */
export function mockFailedGoLiveState(overrides: Partial<GoLiveState> = {}): GoLiveState {
  return {
    ...idleGoLiveState(),
    phase: 'failed',
    steps: mockGoLiveSteps(
      { broadcast: 'done', stream: 'failed' },
      { stream: 'OBS refused StartStream.' },
    ),
    lastError: 'OBS refused StartStream.',
    ...overrides,
  }
}

/* ------------------------------------ the service plan ------------------------------------ */

/**
 * One cue, with obviously-fake content.
 *
 * **Standing Rule 4 applies to this file as hard as it applies to the app.** Every fixture label
 * here is a placeholder — "SLIDE 1", "PLACEHOLDER TITLE" — never a hymn line, never a sermon
 * sentence, never verse text. A `scripture` cue carries a reference and nothing else, which is
 * enforced by `src/shared/plan.ts` giving the payload no `text` field at all.
 */
export function mockCue(overrides: Partial<Cue> = {}): Cue {
  return {
    id: 'cue-1',
    type: 'slide',
    label: 'SLIDE 1',
    trigger: { mode: 'manual' },
    payload: { asset: 'slides/slide-001.png', sourceSlide: 1 },
    ...overrides,
  }
}

/**
 * A three-cue order of service.
 *
 * Deliberately mixed-type — a scene, a slide and a scripture reference — so a row-rendering
 * regression that only handles one payload shape cannot pass. Every cue is `manual`, which is
 * both the schema default and the whole point of Phase 6.
 */
export function mockServicePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    schemaVersion: 1,
    service: '2023-11-14 PLACEHOLDER SERVICE',
    defaultMode: 'assist',
    cues: [
      mockCue({
        id: 'cue-welcome',
        type: 'scene',
        label: 'PLACEHOLDER TITLE',
        payload: { scene: 'Welcome loop' },
      }),
      mockCue({ id: 'cue-slide-1', label: 'SLIDE 1', payload: { asset: 'slides/slide-001.png' } }),
      mockCue({
        id: 'cue-reading',
        type: 'scripture',
        label: 'PLACEHOLDER READING',
        // A REFERENCE. There is no field here that could hold the verse, by construction.
        payload: { reference: 'John 3:16' },
      }),
    ],
    assetDir: 'assets',
    ...overrides,
  }
}

/** A loaded plan, saved to disk, with nothing fired yet. */
export function mockPlanState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    plan: mockServicePlan(),
    position: initialPlanPosition(),
    path: 'C:\\Verger\\plans\\2023-11-14.verger.json',
    dirty: false,
    lastFired: null,
    ...overrides,
  }
}

/** Nothing open: an unnamed empty plan, never saved. The launch state. */
export function emptyPlanState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    plan: { schemaVersion: 1, service: '', defaultMode: 'assist', cues: [], assetDir: 'assets' },
    position: initialPlanPosition(),
    path: null,
    dirty: false,
    lastFired: null,
    ...overrides,
  }
}

/**
 * The importer state on this build machine: no converter, and a sentence saying so.
 *
 * LibreOffice is not installed and cannot be installed here (`HUMAN_TASKS.md`), so `available` is
 * false and `detail` carries the operator-facing explanation the UI is required to print verbatim.
 */
export const MOCK_DECK_IMPORTER_UNAVAILABLE: DeckImporterStatus = {
  available: false,
  backend: null,
  executablePath: null,
  detail:
    'No PowerPoint converter was found on this machine. Verger looked for LibreOffice and did not find it.',
}

/** A machine that *does* have LibreOffice, for the enabled-control case. */
export const MOCK_DECK_IMPORTER_AVAILABLE: DeckImporterStatus = {
  available: true,
  backend: 'libreoffice',
  executablePath: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  detail: null,
}

/** One progress tick, mid-conversion. */
export function mockDeckImportProgress(
  overrides: Partial<DeckImportProgress> = {},
): DeckImportProgress {
  return { stage: 'converting', slidesDone: 3, slidesTotal: 12, message: null, ...overrides }
}

/* --------------------------------- speech recognition (ASR) --------------------------------- */

/**
 * The audio inputs a stock booth PC reports.
 *
 * One of them is deliberately unlabelled-in-spirit — a generic USB interface name — because that
 * is what an operator actually sees, and a picker tested only against "Pulpit mic" would hide a
 * regression that renders a device with no useful name.
 */
export const MOCK_AUDIO_INPUTS: readonly AudioInputDevice[] = [
  { deviceId: 'default', label: 'Default — Microphone (USB Audio CODEC)' },
  { deviceId: 'mock-pulpit-mic', label: 'Pulpit mic (Focusrite Scarlett Solo)' },
  { deviceId: 'mock-room-mic', label: 'Room mic' },
]

/**
 * The state this machine is actually in: `DEEPGRAM_API_KEY` is empty and no key is coming.
 *
 * `lastError` carries the explanation the settings screen prints, so the operator is told *which*
 * secret is missing rather than being left to guess.
 */
export function mockNotConfiguredAsrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return {
    ...idleAsrStatus(),
    state: 'not-configured',
    lastError: 'DEEPGRAM_API_KEY is not set and no local model has been downloaded.',
    ...overrides,
  }
}

/** Configured but not started: the resting state once a provider is genuinely available. */
export function mockIdleAsrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return { ...idleAsrStatus(), ...overrides }
}

/** A healthy session on the preferred provider. */
export function mockListeningAsrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return {
    ...idleAsrStatus(),
    state: 'listening',
    provider: 'deepgram',
    latencyMs: 320,
    deviceId: 'mock-pulpit-mic',
    deviceLabel: 'Pulpit mic (Focusrite Scarlett Solo)',
    since: MOCK_NOW,
    ...overrides,
  }
}

/**
 * Cloud died, local took over.
 *
 * The distinction from {@link mockFailedAsrStatus} is the whole reason `degraded` exists: a
 * transcript is still arriving, just from the fallback, and the panel has to name which provider
 * and why. Collapsing the two would hide a fallback the operator should know about.
 */
export function mockDegradedAsrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return {
    ...mockListeningAsrStatus(),
    state: 'degraded',
    provider: 'whisper',
    latencyMs: 1_450,
    lastError: 'Deepgram closed the socket; recognition fell back to the local model.',
    ...overrides,
  }
}

/** No transcript at all. The console keeps working; the operator runs manual. */
export function mockFailedAsrStatus(overrides: Partial<AsrStatus> = {}): AsrStatus {
  return {
    ...idleAsrStatus(),
    state: 'failed',
    lastError: 'No speech provider could be started.',
    ...overrides,
  }
}

/**
 * One transcript fragment.
 *
 * **Standing Rule 4 applies here as hard as anywhere.** The text is invented placeholder wording —
 * never a sermon sentence, never a hymn line, never verse text. It is deliberately banal so that a
 * fixture can never be mistaken for a recording of a real service.
 */
export function mockTranscriptSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    text: 'PLACEHOLDER TRANSCRIPT LINE ONE',
    isFinal: true,
    tsStart: 0,
    tsEnd: 2_000,
    confidence: 0.94,
    provider: 'deepgram',
    isDraft: false,
    ...overrides,
  }
}

/** The fast-tier partial that a final later replaces. Same `id`, `isDraft: true`. */
export function mockDraftSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return mockTranscriptSegment({
    text: 'PLACEHOLDER DRAFT LINE',
    isFinal: false,
    isDraft: true,
    confidence: null,
    provider: 'whisper',
    ...overrides,
  })
}

/** Which provider a selection mode lands on when everything is healthy. */
function providerForMode(settings: AsrSettings): AsrProviderId {
  return settings.mode === 'local' ? 'whisper' : 'deepgram'
}

/* ------------------------------------- the cue engine ------------------------------------- */

/**
 * The stand-in for resolved verse text.
 *
 * **Standing Rule 4 is at its most fragile in this file.** A fixture is exactly where a verse would
 * get committed "just for a test", so the placeholder is deliberately shouty and deliberately not a
 * sentence: nothing here could ever be mistaken for scripture, and a regression that started
 * bundling real text would not look like this.
 */
export const MOCK_VERSE_TEXT_PLACEHOLDER = 'VERSE TEXT PLACEHOLDER'

/**
 * A detected reference in the `exact` band.
 *
 * A REFERENCE and nothing else — there is no field on {@link ScriptureReference} that could hold
 * the verse. `sourceText` is invented placeholder wording, never a sermon sentence.
 */
export function mockScriptureReference(
  overrides: Partial<ScriptureReference> = {},
): ScriptureReference {
  return {
    book: 'John',
    spokenBook: '요한복음',
    chapter: 3,
    verse: 16,
    verseEnd: null,
    confidence: CONFIDENCE_EXACT,
    band: 'exact',
    sourceText: 'PLACEHOLDER TRANSCRIPT LINE MENTIONING A REFERENCE',
    ...overrides,
  }
}

/** A one-edit-away match. Offered, flagged uncertain, never auto-shown. */
export function mockFuzzyScriptureReference(
  overrides: Partial<ScriptureReference> = {},
): ScriptureReference {
  return mockScriptureReference({
    confidence: CONFIDENCE_FUZZY,
    band: 'fuzzy',
    spokenBook: '요한복음',
    ...overrides,
  })
}

/** A reference whose text a provider has supplied. The text is always the placeholder. */
export function mockResolvedScripture(
  overrides: Partial<ResolvedScripture> = {},
): ResolvedScripture {
  return {
    reference: mockScriptureReference(),
    text: MOCK_VERSE_TEXT_PLACEHOLDER,
    translation: 'KJV',
    attribution: 'King James Version (public domain)',
    ...overrides,
  }
}

/**
 * The translations the fake offers.
 *
 * The third entry matters more than the other two: `docs/v2-notes/LEGAL_AND_CONTENT.md` quarantines
 * the Korean KRV because its public-domain status is contested, so it is present-but-`verified:
 * false` here. A picker that offers it is a licensing incident, and a fixture that omitted it
 * entirely would let that regression through untested.
 */
export const MOCK_TRANSLATIONS: readonly TranslationSource[] = [
  {
    code: 'KJV',
    name: 'King James Version',
    language: 'en',
    kind: 'public-domain',
    license: 'Public domain (outside the United Kingdom).',
    attribution: 'King James Version (public domain)',
    verified: true,
  },
  {
    code: 'ESV',
    name: 'English Standard Version',
    language: 'en',
    kind: 'licensed-api',
    license: 'Licensed via the ESV API. Attribution required on every rendering.',
    attribution: 'Scripture quotations are from the ESV® Bible.',
    verified: true,
  },
  {
    code: 'KRV',
    name: '개역한글',
    language: 'ko',
    kind: 'public-domain',
    license: 'Public-domain status CONTESTED. Quarantined pending a legal decision.',
    attribution: null,
    verified: false,
  },
]

/**
 * A plan-follower suggestion: an INTENT to fire a cue, never a fired cue.
 *
 * `canAutoFire` defaults to false, which is the safe default and also the honest one — most
 * suggestions reach the operator needing a confirmation, and a fixture that defaulted the other
 * way would quietly make every test assert the dangerous path.
 */
export function mockCueSuggestion(overrides: Partial<CueSuggestion> = {}): CueSuggestion {
  return {
    id: 'suggestion-1',
    detector: 'plan',
    cueId: 'cue-slide-1',
    reference: null,
    confidence: 0.86,
    why: 'matched "PLACEHOLDER ANCHOR PHRASE"',
    at: MOCK_NOW,
    canAutoFire: false,
    ...overrides,
  }
}

/** A scripture suggestion. Carries the reference; the text is resolved separately, or not at all. */
export function mockScriptureSuggestion(overrides: Partial<CueSuggestion> = {}): CueSuggestion {
  return mockCueSuggestion({
    id: 'suggestion-scripture',
    detector: 'scripture',
    cueId: null,
    reference: mockScriptureReference(),
    confidence: CONFIDENCE_EXACT,
    why: 'heard "PLACEHOLDER PRIMING PHRASE" then a reference',
    ...overrides,
  })
}

/** A hot-phrase suggestion. */
export function mockHotPhraseSuggestion(overrides: Partial<CueSuggestion> = {}): CueSuggestion {
  return mockCueSuggestion({
    id: 'suggestion-hotphrase',
    detector: 'hotphrase',
    cueId: 'cue-welcome',
    confidence: 0.99,
    why: 'heard the hot phrase "PLACEHOLDER HOT PHRASE"',
    ...overrides,
  })
}

/** One configured hot phrase. */
export function mockHotPhrase(overrides: Partial<HotPhrase> = {}): HotPhrase {
  return {
    id: 'phrase-1',
    phrase: 'PLACEHOLDER HOT PHRASE',
    cueId: 'cue-welcome',
    enabled: true,
    ...overrides,
  }
}

/** The engine at rest: assisting, aligned to nothing, nothing pending. */
export function mockCueEngineState(overrides: Partial<CueEngineState> = {}): CueEngineState {
  return { ...idleCueEngineState(), ...overrides }
}

/** The engine with one suggestion awaiting the operator, following a loaded plan. */
export function mockPendingCueEngineState(
  pending: CueSuggestion | null = mockCueSuggestion(),
  overrides: Partial<CueEngineState> = {},
): CueEngineState {
  return mockCueEngineState({ alignment: 'aligned', position: 0, pending, ...overrides })
}

/**
 * Automation halted by the master switch.
 *
 * Note what is **not** in here: nothing about the stream, the recording, or the overlay. PANIC
 * halts the engine and touches none of them, and the shape of this fixture is the first place that
 * has to stay true.
 */
export function mockPanickedCueEngineState(
  overrides: Partial<CueEngineState> = {},
): CueEngineState {
  return mockCueEngineState({ panicked: true, pending: null, ...overrides })
}

function defaultResponses(): MockResponses {
  return {
    getStatus: ok(initialObsStatus('idle', MOCK_NOW)),
    getSceneList: err(ErrorCode.NOT_CONNECTED, 'not connected'),
    connect: ok(mockConnectedStatus()),
    disconnect: ok(initialObsStatus('disconnected', MOCK_NOW)),
    setConfig: ok(initialObsStatus('idle', MOCK_NOW)),
    configGet: ok(MOCK_CONFIG_SUMMARY),
    logWrite: ok(undefined),
    getVersions: ok(MOCK_APP_VERSIONS),
    overlayGetState: ok(emptyOverlayState()),
    overlaySend: null,
    overlayGetServerInfo: ok(mockOverlayServerInfo()),
    cameraGetConfig: ok(mockCameraConfig()),
    cameraSetConfig: null,
    cameraGetState: ok(mockCameraState()),
    cameraSelect: null,
    youtubeGetStatus: ok(mockNotConfiguredYouTubeStatus()),
    youtubeSignIn: null,
    youtubeSignOut: null,
    youtubeSetTemplate: null,
    youtubeCreateBroadcast: null,
    goLiveGetState: ok(idleGoLiveState()),
    goLiveStart: null,
    goLiveEnd: null,
    planGetState: ok(emptyPlanState()),
    planSet: null,
    planOpen: null,
    planSave: null,
    planImportDeck: null,
    planFireCue: null,
    planAdvance: null,
    planBack: null,
    planGetImporterStatus: ok(MOCK_DECK_IMPORTER_UNAVAILABLE),
    asrGetStatus: ok(mockNotConfiguredAsrStatus()),
    asrGetSettings: ok(defaultAsrSettings()),
    asrSetSettings: null,
    asrStart: null,
    asrStop: null,
    asrPushAudio: ok(undefined),
    asrListDevices: ok(undefined),
    cueGetState: ok(idleCueEngineState()),
    cueGetSettings: ok(defaultCueEngineSettings()),
    cueSetSettings: null,
    cueSetMode: null,
    cueConfirm: null,
    cueDismiss: null,
    cuePanic: null,
    cueResume: null,
    cueResolveScripture: null,
    cueListTranslations: ok(MOCK_TRANSLATIONS),
  }
}

type Listener = (payload: never) => void

/**
 * Build a fake bridge.
 *
 * `overrides` replaces individual responses; anything omitted keeps the default. The object is
 * mutable afterwards via `mock.responses.connect = ...`, which is how a test drives a
 * multi-step flow (connect fails, operator fixes the password, connect succeeds).
 */
export function createMockVergerApi(overrides: Partial<MockResponses> = {}): MockVergerApi {
  const responses: MockResponses = { ...defaultResponses(), ...overrides }

  const calls: MockCalls = {
    getStatus: [],
    getSceneList: [],
    connect: [],
    disconnect: [],
    setConfig: [],
    configGet: [],
    logWrite: [],
    getVersions: [],
    overlayGetState: [],
    overlaySend: [],
    overlayGetServerInfo: [],
    cameraGetConfig: [],
    cameraSetConfig: [],
    cameraGetState: [],
    cameraSelect: [],
    youtubeGetStatus: [],
    youtubeSignIn: [],
    youtubeSignOut: [],
    youtubeSetTemplate: [],
    youtubeCreateBroadcast: [],
    goLiveGetState: [],
    goLiveStart: [],
    goLiveEnd: [],
    planGetState: [],
    planSet: [],
    planOpen: [],
    planSave: [],
    planImportDeck: [],
    planFireCue: [],
    planAdvance: [],
    planBack: [],
    planGetImporterStatus: [],
    asrGetStatus: [],
    asrGetSettings: [],
    asrSetSettings: [],
    asrStart: [],
    asrStop: [],
    asrPushAudio: [],
    asrListDevices: [],
    cueGetState: [],
    cueGetSettings: [],
    cueSetSettings: [],
    cueSetMode: [],
    cueConfirm: [],
    cueDismiss: [],
    cuePanic: [],
    cueResume: [],
    cueResolveScripture: [],
    cueListTranslations: [],
  }

  // The fake's own copy of the server-owned overlay state, so `send` can behave like the real
  // server: reduce, then hand back a full snapshot.
  let overlaySnapshot: OverlayState = responses.overlayGetState.ok
    ? responses.overlayGetState.value
    : emptyOverlayState()

  // The camera half of the same idea, and a deliberately separate pair of variables: nothing in
  // the camera methods below may read or write `overlaySnapshot`, and nothing in the overlay
  // methods may read or write these. That is the independence guarantee, enforced by construction.
  let cameraConfig: CameraConfig = responses.cameraGetConfig.ok
    ? responses.cameraGetConfig.value
    : defaultCameraConfig()
  let cameraSnapshot: CameraState = responses.cameraGetState.ok
    ? responses.cameraGetState.value
    : emptyCameraState()

  // And the YouTube half, a third deliberately separate variable. Signing in must not touch the
  // overlay or the cameras, and switching a camera must not touch this.
  let youtubeSnapshot: YouTubeStatus = responses.youtubeGetStatus.ok
    ? responses.youtubeGetStatus.value
    : mockNotConfiguredYouTubeStatus()

  // GO LIVE is the one place the YouTube half and the OBS half genuinely meet, so this snapshot
  // reads `youtubeSnapshot` — and nothing else does the reverse. It never touches `overlaySnapshot`
  // or `cameraSnapshot`: going live must not move a camera or blank a lower third.
  let goLiveSnapshot: GoLiveState = responses.goLiveGetState.ok
    ? responses.goLiveGetState.value
    : idleGoLiveState()

  // A fifth deliberately separate snapshot. Authoring or firing a cue must not move a camera, must
  // not blank an overlay layer, and must not touch the broadcast — Phase 6 drives the plan and
  // nothing else. Nothing in the plan methods below reads any of the four snapshots above.
  let planSnapshot: PlanState = responses.planGetState.ok
    ? responses.planGetState.value
    : emptyPlanState()

  // And a sixth. Speech recognition is an *input*: starting or stopping it must not move a camera,
  // blank an overlay layer, touch the broadcast or fire a cue. Nothing in the ASR methods below
  // reads any of the five snapshots above, and nothing above reads these.
  let asrSnapshot: AsrStatus = responses.asrGetStatus.ok
    ? responses.asrGetStatus.value
    : mockNotConfiguredAsrStatus()
  let asrSettings: AsrSettings = responses.asrGetSettings.ok
    ? responses.asrGetSettings.value
    : defaultAsrSettings()

  // A seventh separate snapshot, and the most consequential separation in the file. The cue engine
  // emits INTENTS; something else applies them. So `cueConfirm` below moves a suggestion out of
  // `pending` and into `recent` and touches **nothing else** — not `planSnapshot`, not
  // `overlaySnapshot`, not `goLiveSnapshot`. A renderer test therefore cannot come to depend on the
  // engine writing authoritative state, because in this fake it demonstrably does not.
  let cueSnapshot: CueEngineState = responses.cueGetState.ok
    ? responses.cueGetState.value
    : idleCueEngineState()
  let cueSettings: CueEngineSettings = responses.cueGetSettings.ok
    ? responses.cueGetSettings.value
    : defaultCueEngineSettings()

  const listeners = new Map<IpcEventValue, Set<Listener>>()

  function on<K extends IpcEventValue>(
    event: K,
    callback: (payload: IpcEventPayload[K]) => void,
  ): Unsubscribe {
    const set = listeners.get(event) ?? new Set<Listener>()
    listeners.set(event, set)
    const listener = callback as Listener
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  const api: VergerApi = {
    obs: {
      getStatus: () => {
        calls.getStatus.push(calls.getStatus.length)
        return Promise.resolve(responses.getStatus)
      },
      getSceneList: () => {
        calls.getSceneList.push(calls.getSceneList.length)
        return Promise.resolve(responses.getSceneList)
      },
      connect: (config) => {
        calls.connect.push(config)
        return Promise.resolve(responses.connect)
      },
      disconnect: () => {
        calls.disconnect.push(calls.disconnect.length)
        return Promise.resolve(responses.disconnect)
      },
      setConfig: (config) => {
        calls.setConfig.push(config)
        return Promise.resolve(responses.setConfig)
      },
      onStatus: (callback) => on(IpcEvent.obsStatus, callback),
      onSceneList: (callback) => on(IpcEvent.obsSceneList, callback),
    },
    overlay: {
      getState: () => {
        calls.overlayGetState.push(calls.overlayGetState.length)
        // Keep the reducible snapshot in step with whatever the test configured, so a test that
        // assigns `responses.overlayGetState` after construction still gets a coherent `send`.
        if (responses.overlayGetState.ok) overlaySnapshot = responses.overlayGetState.value
        return Promise.resolve(responses.overlayGetState)
      },
      send: (command) => {
        calls.overlaySend.push(command)
        const scripted = responses.overlaySend
        if (scripted !== null) return Promise.resolve(scripted)
        overlaySnapshot = applyOverlayCommand(overlaySnapshot, command)
        return Promise.resolve(ok(overlaySnapshot))
      },
      getServerInfo: () => {
        calls.overlayGetServerInfo.push(calls.overlayGetServerInfo.length)
        return Promise.resolve(responses.overlayGetServerInfo)
      },
      onState: (callback) => on(IpcEvent.overlayState, callback),
      onServerInfo: (callback) => on(IpcEvent.overlayServerInfo, callback),
    },
    camera: {
      getConfig: () => {
        calls.cameraGetConfig.push(calls.cameraGetConfig.length)
        if (responses.cameraGetConfig.ok) cameraConfig = responses.cameraGetConfig.value
        return Promise.resolve(responses.cameraGetConfig)
      },
      setConfig: (config) => {
        calls.cameraSetConfig.push(config)
        const scripted = responses.cameraSetConfig
        if (scripted !== null) return Promise.resolve(scripted)
        cameraConfig = config
        // Re-mapping a scene can make the live scene belong to a different button — or to none.
        cameraSnapshot = {
          ...cameraSnapshot,
          activeSlot: slotForScene(config, cameraSnapshot.currentProgramScene),
        }
        return Promise.resolve(ok(config))
      },
      getState: () => {
        calls.cameraGetState.push(calls.cameraGetState.length)
        if (responses.cameraGetState.ok) cameraSnapshot = responses.cameraGetState.value
        return Promise.resolve(responses.cameraGetState)
      },
      select: (slot) => {
        calls.cameraSelect.push(slot)
        const scripted = responses.cameraSelect
        if (scripted !== null) return Promise.resolve(scripted)

        const binding = findBinding(cameraConfig, slot)
        if (binding === null || binding.sceneName === null || binding.sceneName.length === 0) {
          // The UI is supposed to make this unreachable by disabling the button. The fake refuses
          // it anyway, so a regression shows up as a failing assertion rather than as a silent
          // scene switch to nowhere.
          return Promise.resolve(
            err(ErrorCode.INVALID_ARG, `camera slot ${slot} has no scene bound`),
          )
        }

        cameraSnapshot = {
          currentProgramScene: binding.sceneName,
          activeSlot: slot,
          availableTransitions: cameraSnapshot.availableTransitions,
        }
        return Promise.resolve(ok(cameraSnapshot))
      },
      onState: (callback) => on(IpcEvent.cameraState, callback),
    },
    youtube: {
      getStatus: () => {
        calls.youtubeGetStatus.push(calls.youtubeGetStatus.length)
        if (responses.youtubeGetStatus.ok) youtubeSnapshot = responses.youtubeGetStatus.value
        return Promise.resolve(responses.youtubeGetStatus)
      },
      signIn: () => {
        calls.youtubeSignIn.push(calls.youtubeSignIn.length)
        const scripted = responses.youtubeSignIn
        if (scripted !== null) return Promise.resolve(scripted)

        if (youtubeSnapshot.auth.state === 'not-configured') {
          // There is no OAuth client to consent against. The UI is supposed to make this
          // unreachable by disabling the button; the fake refuses it anyway.
          return Promise.resolve(
            err(ErrorCode.NOT_CONFIGURED, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set'),
          )
        }

        youtubeSnapshot = {
          ...youtubeSnapshot,
          auth: { state: 'signed-in', channel: MOCK_YOUTUBE_CHANNEL, lastError: null },
          stream: youtubeSnapshot.stream ?? mockPersistentStream(),
        }
        return Promise.resolve(ok(youtubeSnapshot))
      },
      signOut: () => {
        calls.youtubeSignOut.push(calls.youtubeSignOut.length)
        const scripted = responses.youtubeSignOut
        if (scripted !== null) return Promise.resolve(scripted)

        youtubeSnapshot = {
          ...youtubeSnapshot,
          auth:
            youtubeSnapshot.auth.state === 'not-configured'
              ? youtubeSnapshot.auth
              : { state: 'signed-out', channel: null, lastError: null },
        }
        return Promise.resolve(ok(youtubeSnapshot))
      },
      setTemplate: (template) => {
        calls.youtubeSetTemplate.push(template)
        const scripted = responses.youtubeSetTemplate
        if (scripted !== null) return Promise.resolve(scripted)

        youtubeSnapshot = { ...youtubeSnapshot, template }
        return Promise.resolve(ok(youtubeSnapshot))
      },
      createBroadcast: (options) => {
        calls.youtubeCreateBroadcast.push(options)
        const scripted = responses.youtubeCreateBroadcast
        if (scripted !== null) return Promise.resolve(scripted)

        if (youtubeSnapshot.auth.state !== 'signed-in') {
          return Promise.resolve(err(ErrorCode.NOT_CONFIGURED, 'not signed in to YouTube'))
        }

        const scheduledStartTime = options.scheduledStartTime ?? new Date(MOCK_NOW).toISOString()
        const stream = youtubeSnapshot.stream ?? mockPersistentStream()
        const broadcast = mockBroadcast({
          title: expandTitleTemplate(
            youtubeSnapshot.template.titleTemplate,
            new Date(scheduledStartTime),
          ),
          privacy: youtubeSnapshot.template.privacy,
          scheduledStartTime,
          boundStreamId: stream.id,
        })
        youtubeSnapshot = { ...youtubeSnapshot, broadcast, stream }
        return Promise.resolve(ok(broadcast))
      },
      onStatus: (callback) => on(IpcEvent.youtubeStatus, callback),
    },
    goLive: {
      getState: () => {
        calls.goLiveGetState.push(calls.goLiveGetState.length)
        if (responses.goLiveGetState.ok) goLiveSnapshot = responses.goLiveGetState.value
        return Promise.resolve(responses.goLiveGetState)
      },
      start: () => {
        calls.goLiveStart.push(calls.goLiveStart.length)
        const scripted = responses.goLiveStart
        if (scripted !== null) return Promise.resolve(scripted)

        // Standing Rule 2. OBS already streaming or recording means the app crashed mid-service;
        // starting again would push a second stream and open a second recording file.
        if (shouldReattach(goLiveSnapshot.obs)) {
          goLiveSnapshot = { ...goLiveSnapshot, phase: 'live', reattached: true }
          return Promise.resolve(ok(goLiveSnapshot))
        }

        const youtubeUsable = youtubeSnapshot.auth.state === 'signed-in'
        const youtubeStep: StepState = youtubeUsable ? 'done' : 'skipped'

        goLiveSnapshot = {
          phase: 'live',
          steps: mockGoLiveSteps({
            broadcast: youtubeStep,
            stream: 'done',
            // Standing Rule 3: never conditional, never behind a flag. There is no branch here in
            // which the stream starts and this does not.
            record: 'done',
            health: 'done',
            transition: youtubeStep,
          }),
          liveSince: MOCK_NOW,
          obs: mockStreamingObsOutputState({ streamTimecodeMs: 0, recordTimecodeMs: 0 }),
          lastError: null,
          reattached: false,
        }
        return Promise.resolve(ok(goLiveSnapshot))
      },
      end: () => {
        calls.goLiveEnd.push(calls.goLiveEnd.length)
        const scripted = responses.goLiveEnd
        if (scripted !== null) return Promise.resolve(scripted)

        goLiveSnapshot = {
          ...idleGoLiveState(),
          // The path survives the end of the service: it is the operator's backup and the first
          // thing they go looking for once the congregation has left.
          obs: mockObsOutputState({ recordingPath: goLiveSnapshot.obs.recordingPath }),
        }
        return Promise.resolve(ok(goLiveSnapshot))
      },
      onState: (callback) => on(IpcEvent.goLiveState, callback),
    },
    plan: {
      getState: () => {
        calls.planGetState.push(calls.planGetState.length)
        if (responses.planGetState.ok) planSnapshot = responses.planGetState.value
        return Promise.resolve(responses.planGetState)
      },
      set: (plan) => {
        calls.planSet.push(plan)
        const scripted = responses.planSet
        if (scripted !== null) return Promise.resolve(scripted)

        // The pointer follows the cue it was on **by id**, not by slot number: reordering the cue
        // after the one on screen must not change what is on screen. Deleting the cue the pointer
        // was sitting on clamps instead — an out-of-range pointer would make the next SPACE do
        // nothing at all. Both behaviours are `docs/v2-notes/PLAN_LESSONS.md`'s playlist contract.
        const anchor = planSnapshot.plan.cues[planSnapshot.position.index]
        const followed =
          anchor === undefined ? -1 : plan.cues.findIndex((cue) => cue.id === anchor.id)
        const index =
          planSnapshot.position.index < 0
            ? planSnapshot.position.index
            : followed === -1
              ? Math.min(planSnapshot.position.index, plan.cues.length - 1)
              : followed
        planSnapshot = {
          ...planSnapshot,
          plan,
          position: { index, firedCueIds: planSnapshot.position.firedCueIds },
          dirty: true,
        }
        return Promise.resolve(ok(planSnapshot))
      },
      open: (options) => {
        calls.planOpen.push(options)
        const scripted = responses.planOpen
        if (scripted !== null) return Promise.resolve(scripted)

        planSnapshot = mockPlanState(
          options.path === undefined ? {} : { path: options.path },
        )
        return Promise.resolve(ok(planSnapshot))
      },
      save: (options) => {
        calls.planSave.push(options)
        const scripted = responses.planSave
        if (scripted !== null) return Promise.resolve(scripted)

        planSnapshot = {
          ...planSnapshot,
          path: options.path ?? planSnapshot.path ?? 'C:\\Verger\\plans\\untitled.verger.json',
          dirty: false,
        }
        return Promise.resolve(ok(planSnapshot))
      },
      importDeck: (options) => {
        calls.planImportDeck.push(options)
        const scripted = responses.planImportDeck
        if (scripted !== null) return Promise.resolve(scripted)

        const importer = responses.planGetImporterStatus
        if (!importer.ok || !importer.value.available) {
          // There is genuinely no converter here. The fake refuses rather than fabricating slides,
          // so a UI regression that enables the control shows up as a failing assertion.
          return Promise.resolve(
            err(
              ErrorCode.NOT_CONFIGURED,
              importer.ok
                ? (importer.value.detail ?? 'no deck converter is available')
                : 'no deck converter is available',
            ),
          )
        }

        // One opaque image per slide, and no slide text anywhere: Standing Rule 4 means the
        // importer never reads a deck's words into the model, so neither does its fake.
        const cues: Cue[] = [1, 2].map((slide) => ({
          id: `cue-imported-${String(slide)}`,
          type: 'slide' as const,
          label: `SLIDE ${String(slide)}`,
          trigger: { mode: 'manual' as const },
          payload: { asset: `slides/slide-${String(slide).padStart(3, '0')}.png`, sourceSlide: slide },
        }))
        planSnapshot = {
          ...planSnapshot,
          plan: { ...planSnapshot.plan, cues: [...planSnapshot.plan.cues, ...cues] },
          dirty: true,
        }
        return Promise.resolve(ok(planSnapshot))
      },
      fireCue: (options) => {
        calls.planFireCue.push(options)
        const scripted = responses.planFireCue
        if (scripted !== null) return Promise.resolve(scripted)

        const index = planSnapshot.plan.cues.findIndex((cue) => cue.id === options.cueId)
        const cue = planSnapshot.plan.cues[index]
        if (cue === undefined) {
          return Promise.resolve(err(ErrorCode.NOT_FOUND, `no cue with id ${options.cueId}`))
        }
        planSnapshot = {
          ...planSnapshot,
          position: {
            index,
            firedCueIds: planSnapshot.position.firedCueIds.includes(cue.id)
              ? planSnapshot.position.firedCueIds
              : [...planSnapshot.position.firedCueIds, cue.id],
          },
          lastFired: cue,
        }
        return Promise.resolve(ok(planSnapshot))
      },
      advance: () => {
        calls.planAdvance.push(calls.planAdvance.length)
        const scripted = responses.planAdvance
        if (scripted !== null) return Promise.resolve(scripted)

        const position = advancePosition(planSnapshot.plan, planSnapshot.position)
        planSnapshot = {
          ...planSnapshot,
          position,
          lastFired: planSnapshot.plan.cues[position.index] ?? planSnapshot.lastFired,
        }
        return Promise.resolve(ok(planSnapshot))
      },
      back: () => {
        calls.planBack.push(calls.planBack.length)
        const scripted = responses.planBack
        if (scripted !== null) return Promise.resolve(scripted)

        planSnapshot = { ...planSnapshot, position: stepBack(planSnapshot.position) }
        return Promise.resolve(ok(planSnapshot))
      },
      getImporterStatus: () => {
        calls.planGetImporterStatus.push(calls.planGetImporterStatus.length)
        return Promise.resolve(responses.planGetImporterStatus)
      },
      onState: (callback) => on(IpcEvent.planState, callback),
      onImportProgress: (callback) => on(IpcEvent.planImportProgress, callback),
    },
    asr: {
      getStatus: () => {
        calls.asrGetStatus.push(calls.asrGetStatus.length)
        if (responses.asrGetStatus.ok) asrSnapshot = responses.asrGetStatus.value
        return Promise.resolve(responses.asrGetStatus)
      },
      getSettings: () => {
        calls.asrGetSettings.push(calls.asrGetSettings.length)
        if (responses.asrGetSettings.ok) asrSettings = responses.asrGetSettings.value
        return Promise.resolve(responses.asrGetSettings)
      },
      setSettings: (settings) => {
        calls.asrSetSettings.push(settings)
        const scripted = responses.asrSetSettings
        if (scripted !== null) return Promise.resolve(scripted)

        asrSettings = settings
        // The language is part of the *status* as well as the settings, because the panel prints
        // what is actually being recognised, not what was requested.
        asrSnapshot = { ...asrSnapshot, language: settings.language }
        return Promise.resolve(ok(asrSettings))
      },
      start: () => {
        calls.asrStart.push(calls.asrStart.length)
        const scripted = responses.asrStart
        if (scripted !== null) return Promise.resolve(scripted)

        if (asrSnapshot.state === 'not-configured') {
          // There is genuinely no provider to start. The UI is supposed to make this unreachable
          // by disabling the control; the fake refuses it anyway, so a regression that enables the
          // button shows up as a failing assertion rather than a silently dead microphone.
          return Promise.resolve(
            err(ErrorCode.NOT_CONFIGURED, 'no speech provider is configured'),
          )
        }

        asrSnapshot = {
          ...asrSnapshot,
          state: 'listening',
          provider: providerForMode(asrSettings),
          language: asrSettings.language,
          deviceId: asrSettings.deviceId,
          since: MOCK_NOW,
          lastError: null,
        }
        return Promise.resolve(ok(asrSnapshot))
      },
      stop: () => {
        calls.asrStop.push(calls.asrStop.length)
        const scripted = responses.asrStop
        if (scripted !== null) return Promise.resolve(scripted)

        asrSnapshot =
          asrSnapshot.state === 'not-configured'
            ? asrSnapshot
            : { ...idleAsrStatus(asrSettings.language), lastError: asrSnapshot.lastError }
        return Promise.resolve(ok(asrSnapshot))
      },
      pushAudio: (chunk) => {
        // Only the size is recorded. See `MockCalls.asrPushAudio`: retaining the samples would
        // put a recording of whatever was said into the repo.
        calls.asrPushAudio.push(chunk.byteLength)
        return Promise.resolve(responses.asrPushAudio)
      },
      listDevices: (devices) => {
        calls.asrListDevices.push(devices)
        return Promise.resolve(responses.asrListDevices)
      },
      onStatus: (callback) => on(IpcEvent.asrStatus, callback),
      onTranscript: (callback) => on(IpcEvent.asrTranscript, callback),
    },
    cue: {
      getState: () => {
        calls.cueGetState.push(calls.cueGetState.length)
        if (responses.cueGetState.ok) cueSnapshot = responses.cueGetState.value
        return Promise.resolve(responses.cueGetState)
      },
      getSettings: () => {
        calls.cueGetSettings.push(calls.cueGetSettings.length)
        if (responses.cueGetSettings.ok) cueSettings = responses.cueGetSettings.value
        return Promise.resolve(responses.cueGetSettings)
      },
      setSettings: (settings) => {
        calls.cueSetSettings.push(settings)
        const scripted = responses.cueSetSettings
        if (scripted !== null) return Promise.resolve(scripted)

        cueSettings = settings
        // The mode lives in both the settings and the state, because the operator changes it from
        // the trust dial and the panel prints what is actually in force.
        cueSnapshot = { ...cueSnapshot, mode: settings.mode }
        return Promise.resolve(ok(cueSettings))
      },
      setMode: (options) => {
        calls.cueSetMode.push(options.mode)
        const scripted = responses.cueSetMode
        if (scripted !== null) return Promise.resolve(scripted)

        cueSettings = { ...cueSettings, mode: options.mode }
        // `panicked` is deliberately untouched. Picking a mode is not a resume, and a fake that
        // quietly cleared the flag here would hide exactly the regression that matters.
        cueSnapshot = { ...cueSnapshot, mode: options.mode }
        return Promise.resolve(ok(cueSnapshot))
      },
      confirm: (options) => {
        calls.cueConfirm.push(options)
        const scripted = responses.cueConfirm
        if (scripted !== null) return Promise.resolve(scripted)

        const pending = cueSnapshot.pending
        if (pending === null || pending.id !== options.suggestionId) {
          // Confirming a suggestion that is no longer pending is not a no-op worth hiding: it means
          // the operator's tap raced a re-sync, and the UI must not report that anything fired.
          return Promise.resolve(
            err(ErrorCode.NOT_FOUND, `no pending suggestion with id ${options.suggestionId}`),
          )
        }
        cueSnapshot = {
          ...cueSnapshot,
          pending: null,
          recent: [pending, ...cueSnapshot.recent].slice(0, 10),
        }
        return Promise.resolve(ok(cueSnapshot))
      },
      dismiss: (options) => {
        calls.cueDismiss.push(options)
        const scripted = responses.cueDismiss
        if (scripted !== null) return Promise.resolve(scripted)

        // A veto always succeeds, even against a suggestion that has already gone. "There was
        // nothing to reject" and "your rejection failed" must never be confusable mid-service.
        cueSnapshot = { ...cueSnapshot, pending: null }
        return Promise.resolve(ok(cueSnapshot))
      },
      panic: () => {
        calls.cuePanic.push(calls.cuePanic.length)
        const scripted = responses.cuePanic
        if (scripted !== null) return Promise.resolve(scripted)

        cueSnapshot = { ...cueSnapshot, panicked: true, pending: null }
        return Promise.resolve(ok(cueSnapshot))
      },
      resume: () => {
        calls.cueResume.push(calls.cueResume.length)
        const scripted = responses.cueResume
        if (scripted !== null) return Promise.resolve(scripted)

        cueSnapshot = { ...cueSnapshot, panicked: false }
        return Promise.resolve(ok(cueSnapshot))
      },
      resolveScripture: (options) => {
        calls.cueResolveScripture.push(options)
        const scripted = responses.cueResolveScripture
        if (scripted !== null) return Promise.resolve(scripted)

        return Promise.resolve(
          ok(
            mockResolvedScripture({
              reference: options.reference,
              translation: options.translation ?? cueSettings.translation,
            }),
          ),
        )
      },
      listTranslations: () => {
        calls.cueListTranslations.push(calls.cueListTranslations.length)
        return Promise.resolve(responses.cueListTranslations)
      },
      onState: (callback) => on(IpcEvent.cueState, callback),
      onSuggestion: (callback) => on(IpcEvent.cueSuggestion, callback),
    },
    config: {
      get: () => {
        calls.configGet.push(calls.configGet.length)
        return Promise.resolve(responses.configGet)
      },
    },
    log: {
      write: (record) => {
        calls.logWrite.push(record)
        return Promise.resolve(responses.logWrite)
      },
    },
    app: {
      getVersions: () => {
        calls.getVersions.push(calls.getVersions.length)
        return Promise.resolve(responses.getVersions)
      },
    },
  }

  return {
    api,
    get responses() {
      return responses
    },
    set responses(next: MockResponses) {
      Object.assign(responses, next)
    },
    calls,
    emit<K extends IpcEventValue>(event: K, payload: IpcEventPayload[K]): void {
      const set = listeners.get(event)
      if (set === undefined) return
      for (const listener of [...set]) {
        ;(listener as (value: IpcEventPayload[K]) => void)(payload)
      }
    },
    listenerCount(event: IpcEventValue): number {
      return listeners.get(event)?.size ?? 0
    },
  }
}

export interface InstalledMockVergerApi {
  readonly mock: MockVergerApi
  /** Put `window.verger` back exactly as it was — including deleting it if it was absent. */
  readonly restore: () => void
}

/**
 * Install a fake bridge on `globalThis.window.verger`.
 *
 * Returns a `restore` that reinstates the previous value, so a test file that installs the mock
 * cannot leak it into an unrelated file that is asserting the *absent bridge* behaviour.
 */
export function installMockVergerApi(
  overrides: Partial<MockResponses> = {},
): InstalledMockVergerApi {
  if (typeof window === 'undefined') {
    throw new Error('installMockVergerApi requires a DOM environment (vitest project "renderer").')
  }

  const mock = createMockVergerApi(overrides)
  const had = Object.prototype.hasOwnProperty.call(window, 'verger')
  const previous = window.verger

  window.verger = mock.api

  return {
    mock,
    restore: () => {
      if (had && previous !== undefined) {
        window.verger = previous
      } else {
        delete window.verger
      }
    },
  }
}
