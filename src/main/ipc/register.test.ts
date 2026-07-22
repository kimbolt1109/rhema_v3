/**
 * `registerIpc` contract tests.
 *
 * Everything is driven through injected structural seams — a fake `ipcMain` that is really
 * a `Map<channel, handler>`, fake windows, a fake OBS client and a fake secrets store — so
 * this file needs no Electron runtime, no network, and no OBS Studio (which is not
 * installed on the build machine). `electron` is mocked purely so the module graph resolves;
 * nothing in it is exercised.
 */

import { resolve as resolvePath } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ASR_CHANNELS, ASR_CHUNK_MS, ASR_SAMPLE_RATE, idleAsrStatus } from '@shared/asr'
import type { AsrSettings, AsrStatus, AudioInputDevice, TranscriptSegment } from '@shared/asr'
import { CAMERA_SLOTS, findBinding, isBindingUsable, slotForScene } from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { AppConfig } from '@shared/config'
import { TRUST_MODES, defaultCueEngineSettings, idleCueEngineState } from '@shared/cue'
import type { CueEngineSettings, CueEngineState, CueSuggestion, TrustMode } from '@shared/cue'
import { GO_LIVE_STEPS, emptyObsOutputState, idleGoLiveState } from '@shared/golive'
import type { GoLiveState, GoLiveStepStatus, StepState } from '@shared/golive'
import { SUBSYSTEMS, initialHealth, isServiceStillGoingOut, worstLevel } from '@shared/health'
import type { Checkpoint, HealthSnapshot, SubsystemHealth } from '@shared/health'
import { IPC_CHANNEL_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type { IpcChannelValue } from '@shared/ipc'
import type { DeckImportProgress, DeckImporterStatus, OverlayServerInfo, PlanState } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import { initialObsStatus } from '@shared/obs'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { applyOverlayCommand, emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { initialPlanPosition } from '@shared/plan'
import type { ServicePlan } from '@shared/plan'
import { err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import { CONFIDENCE_EXACT, CONFIDENCE_WEAK } from '@shared/scripture'
import type { ResolvedScripture, ScriptureReference, TranslationSource } from '@shared/scripture'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { Broadcast, BroadcastTemplate, YouTubeStatus } from '@shared/youtube'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/verger-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  /**
   * A dialog that would hang forever if anything reached it.
   *
   * `registerIpc` defaults `deps.dialog` to Electron's real `dialog`, and a modal file picker is
   * the one thing a headless test can never dismiss. Every test below injects its own fake, so
   * these two rejecting stubs are a tripwire: if a future edit ever lets the default through, the
   * test fails loudly instead of timing out with no explanation.
   */
  dialog: {
    showOpenDialog: () => Promise.reject(new Error('no native dialog under vitest')),
    showSaveDialog: () => Promise.reject(new Error('no native dialog under vitest'))
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

/**
 * The real overlay singleton would bind a port and read `app.isPackaged`, neither of which
 * exists here. Making it *throw* is deliberate rather than lazy: `registerIpc` must survive a
 * subsystem that cannot be constructed at all, and the tests below assert exactly what the
 * overlay channels answer in that state.
 */
vi.mock('@main/overlay', () => ({
  getOverlayServer: () => {
    throw new Error('the overlay server singleton is unavailable under vitest')
  }
}))

/**
 * Same treatment as the overlay singleton, and for the same reason: the real camera service
 * reaches an OBS client that does not exist here. Making it throw lets one test assert that
 * `registerIpc` still registers every channel — including the four camera ones — when the
 * subsystem cannot be constructed at all.
 */
vi.mock('@main/camera', () => ({
  getCameraService: () => {
    throw new Error('the camera service singleton is unavailable under vitest')
  }
}))

/**
 * The YouTube singleton is mocked for a stronger reason than the other two.
 *
 * There are no Google credentials on this machine and there never will be, and **no test in this
 * repo may make a network call**. The real `getYouTubeService()` would construct an OAuth client
 * and a `googleapis` handle; making it throw here guarantees that neither is ever built during
 * these tests, and lets one test below assert what the five youtube channels answer when the
 * subsystem could not be constructed at all — which is also exactly what a fresh checkout does.
 */
vi.mock('@main/youtube', () => ({
  getYouTubeService: () => {
    throw new Error('the YouTube service singleton is unavailable under vitest')
  }
}))

/**
 * The go-live singleton, mocked to throw for the strongest reason of the four.
 *
 * The real one drives OBS's `StartStream`/`StartRecord` and YouTube's `liveBroadcasts.transition`.
 * OBS Studio is not installed on this machine and there are no Google credentials, so making the
 * singleton throw guarantees that nothing in this file can reach either — and lets a test below
 * assert exactly what the three go-live channels answer when the orchestrator could not be built
 * at all, which must be "OBS still works by hand", never a crash.
 */
vi.mock('@main/golive', () => ({
  getGoLiveService: () => {
    throw new Error('the go-live service singleton is unavailable under vitest')
  }
}))

/**
 * The plan singleton, mocked to throw like the other four.
 *
 * The real one owns a file handle, a deck importer and a child process, and would happily reach
 * the filesystem. Making it throw keeps every test in this file hermetic and lets one test assert
 * what the nine plan channels answer when the service could not be constructed at all — which
 * must be "the rest of Verger is unaffected", never a crash.
 */
vi.mock('@main/plan', () => ({
  getPlanService: () => {
    throw new Error('the plan service singleton is unavailable under vitest')
  }
}))

/**
 * The ASR singleton, mocked to throw like the other five — and for two reasons at once.
 *
 * The real one opens a Deepgram websocket and spawns a Python child process that loads a
 * faster-whisper model onto the GPU. **No test in this repo may make a network call**, there is no
 * `DEEPGRAM_API_KEY` on this machine and there never will be, and a model load is a multi-second,
 * multi-gigabyte affair that would turn this suite into an integration test.
 *
 * Making it throw also lets the tests below assert what the seven asr channels answer when the
 * recogniser could not be constructed at all — which is the state of every fresh checkout, and
 * which must read as "the service runs manually", never as a crash.
 */
vi.mock('@main/asr', () => ({
  getAsrService: () => {
    throw new Error('the ASR service singleton is unavailable under vitest')
  }
}))

/**
 * The cue-engine singleton, mocked to throw like the other six.
 *
 * The real one attaches to a live transcript feed and can reach a network scripture resolver, and
 * **no test in this repo may make a network call**. Making it throw also lets the tests below
 * assert what the ten cue channels answer when the engine could not be constructed at all — which
 * must read as "automation is off, the service runs by hand", never as a crash, and which must
 * still let `cuePanic` succeed.
 */
vi.mock('@main/cue', () => ({
  getCueEngine: () => {
    throw new Error('the cue engine singleton is unavailable under vitest')
  },
  // Throws like the other singletons. `registerIpc` now DEFAULTS the scripture resolver instead
  // of hard-coding `null` (so `cueResolveScripture` works in production), and it catches a
  // failure here and degrades to no resolver — which is exactly what these tests then assert.
  getScriptureResolver: () => {
    throw new Error('the scripture resolver singleton is unavailable under vitest')
  }
}))

/**
 * The health singleton, mocked to throw like the other seven.
 *
 * The real one watches a live overlay socket, an OBS client and a recogniser, and owns a watchdog
 * timer. None of those exist here. Making it throw also lets a test below assert what the four
 * health channels answer when the monitor could not be constructed at all — which must be "the
 * dashboard is gone, the service is not", never a crash, and never a recovery action that silently
 * claims to have happened.
 */
vi.mock('@main/health', () => ({
  getHealthService: () => {
    throw new Error('the health service singleton is unavailable under vitest')
  },
  getCheckpointStore: () => {
    throw new Error('the checkpoint store singleton is unavailable under vitest')
  }
}))

import {
  OBS_PASSWORD_SECRET_KEY,
  registerIpc,
  type AsrServiceLike,
  type CameraServiceLike,
  type CheckpointStoreLike,
  type CueEngineLike,
  type DialogLike,
  type FilePathProbeLike,
  type GoLiveServiceLike,
  type HealthServiceLike,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type ObsClientLike,
  type OpenDialogResultLike,
  type OverlayReloadLike,
  type OverlayServerLike,
  type PathKind,
  type PlanServiceLike,
  type SaveDialogResultLike,
  type ScriptureResolverLike,
  type SecretsStoreLike,
  type WebContentsLike,
  type WindowLike,
  type YouTubeServiceLike
} from '@main/ipc/register'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (event: IpcInvokeEventLike, ...args: unknown[]) => unknown

interface FakeIpcMain extends IpcMainLike {
  readonly handlers: Map<string, Handler>
  readonly handleCalls: string[]
  readonly removeCalls: string[]
}

function createFakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, Handler>()
  const handleCalls: string[] = []
  const removeCalls: string[] = []
  return {
    handlers,
    handleCalls,
    removeCalls,
    handle(channel, listener) {
      handleCalls.push(channel)
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      removeCalls.push(channel)
      handlers.delete(channel)
    }
  }
}

interface FakeWindow extends WindowLike {
  readonly sent: Array<{ channel: string; payload: unknown }>
  readonly frame: { url: string }
  readonly contents: WebContentsLike
}

function createFakeWindow(url = 'file:///app/out/renderer/index.html'): FakeWindow {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const frame = { url }
  const contents: WebContentsLike = {
    isDestroyed: () => false,
    mainFrame: frame,
    send: (channel, ...args) => {
      sent.push({ channel, payload: args[0] })
    }
  }
  return { sent, frame, contents, isDestroyed: () => false, webContents: contents }
}

/** An invoke event that will pass sender validation for `window`. */
function eventFrom(window: FakeWindow): IpcInvokeEventLike {
  return { senderFrame: window.frame, sender: window.contents }
}

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly data: Record<string, unknown> | undefined
}

/**
 * A logger that keeps what it was told.
 *
 * Only used by the GO LIVE / END audit test. `child()` returns the same recorder so the
 * `deps.logger.child('ipc')` inside `registerIpc` does not swallow the lines.
 */
function createRecordingLogger(lines: LogLine[]): Logger {
  const logger: Logger = {
    debug: (msg, data) => lines.push({ level: 'debug', msg, data }),
    info: (msg, data) => lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => lines.push({ level: 'error', msg, data }),
    child: () => logger
  }
  return logger
}

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger
  }
  return logger
}

interface FakeObsClient extends ObsClientLike {
  emitStatus(status: ObsStatus): void
  emitSceneList(sceneList: ObsSceneList): void
  readonly statusUnsubscribed: () => number
  readonly sceneListUnsubscribed: () => number
  readonly connectCalls: Array<ObsConnectionConfig | undefined>
  readonly disconnectCalls: () => number
  failStatusWith: Error | null
}

const SCENE_LIST: ObsSceneList = {
  scenes: [{ name: 'Wide', index: 0 }],
  currentProgramScene: 'Wide',
  currentPreviewScene: null
}

function createFakeObsClient(): FakeObsClient {
  let statusListener: ((status: ObsStatus) => void) | null = null
  let sceneListListener: ((sceneList: ObsSceneList) => void) | null = null
  let statusUnsubscribes = 0
  let sceneListUnsubscribes = 0
  let disconnects = 0
  const connectCalls: Array<ObsConnectionConfig | undefined> = []

  const client: FakeObsClient = {
    failStatusWith: null,
    connectCalls,
    statusUnsubscribed: () => statusUnsubscribes,
    sceneListUnsubscribed: () => sceneListUnsubscribes,
    disconnectCalls: () => disconnects,

    getStatus: () => {
      if (client.failStatusWith !== null) throw client.failStatusWith
      // Deliberately a bare value, not a Result: the client is free to choose, and
      // `resolveObsCall` normalises.
      return initialObsStatus('connected', 1_000)
    },
    getSceneList: (): Promise<Result<ObsSceneList>> => Promise.resolve(ok(SCENE_LIST)),
    connect: (config) => {
      connectCalls.push(config)
      return Promise.resolve(ok(initialObsStatus('connected', 2_000)))
    },
    disconnect: () => {
      disconnects += 1
      return Promise.resolve(ok(initialObsStatus('idle', 3_000)))
    },
    onStatus: (listener) => {
      statusListener = listener
      return () => {
        statusUnsubscribes += 1
        statusListener = null
      }
    },
    onSceneList: (listener) => {
      sceneListListener = listener
      return () => {
        sceneListUnsubscribes += 1
        sceneListListener = null
      }
    },

    emitStatus: (status) => {
      statusListener?.(status)
    },
    emitSceneList: (sceneList) => {
      sceneListListener?.(sceneList)
    }
  }
  return client
}

interface FakeOverlayServer extends OverlayServerLike {
  emitState(state: OverlayState): void
  emitInfo(info: OverlayServerInfo): void
  /** Every command that actually reached the server. Must stay empty for rejected input. */
  readonly sent: OverlayCommand[]
  readonly stateUnsubscribed: () => number
  readonly infoUnsubscribed: () => number
  /** Flip to `false` to simulate a listener that never came up or has stopped. */
  running: boolean
}

function createFakeOverlayServer(): FakeOverlayServer {
  let stateListener: ((state: OverlayState) => void) | null = null
  let infoListener: ((info: OverlayServerInfo) => void) | null = null
  let stateUnsubscribes = 0
  let infoUnsubscribes = 0
  let state = emptyOverlayState()
  const sent: OverlayCommand[] = []

  const server: FakeOverlayServer = {
    running: true,
    sent,
    stateUnsubscribed: () => stateUnsubscribes,
    infoUnsubscribed: () => infoUnsubscribes,

    getState: () => state,
    send: (command) => {
      sent.push(command)
      // The real server runs the same pure reducer; using it here keeps the test honest
      // about `revision` bumping on every accepted command.
      state = applyOverlayCommand(state, command)
      return ok(state)
    },
    getInfo: (): OverlayServerInfo => ({
      running: server.running,
      host: LOOPBACK_ADDRESS,
      port: OVERLAY_SERVER_PORT,
      pageUrl: overlayPageUrl(),
      clients: server.running ? 1 : 0,
      lastError: server.running ? null : 'EADDRINUSE'
    }),
    onState: (listener) => {
      stateListener = listener
      return () => {
        stateUnsubscribes += 1
        stateListener = null
      }
    },
    onInfo: (listener) => {
      infoListener = listener
      return () => {
        infoUnsubscribes += 1
        infoListener = null
      }
    },

    emitState: (next) => {
      stateListener?.(next)
    },
    emitInfo: (info) => {
      infoListener?.(info)
    }
  }
  return server
}

// ---------------------------------------------------------------------------
// Camera fake (BLUEPRINT.md §6)
// ---------------------------------------------------------------------------

const AVAILABLE_TRANSITIONS: readonly string[] = ['Cut', 'Fade', 'Stinger']

/**
 * Three slots bound, one deliberately not.
 *
 * `pulpit` has no scene on purpose: an unmapped button is the ordinary state of a fresh install,
 * and the contract says it must be refused rather than fired at OBS as a scene that does not
 * exist. The fake enforces that below, so a regression in the IPC layer shows up as a passing
 * call rather than as a comment nobody reads.
 */
const BOUND_CAMERA_CONFIG: CameraConfig = {
  bindings: [
    { slot: 'cam1', label: 'CAM 1', sceneName: 'Cam 1', transition: 'Cut', transitionDurationMs: null },
    { slot: 'cam2', label: 'CAM 2', sceneName: 'Cam 2', transition: 'Fade', transitionDurationMs: 300 },
    { slot: 'wide', label: 'WIDE', sceneName: 'Wide', transition: null, transitionDurationMs: null },
    { slot: 'pulpit', label: 'PULPIT', sceneName: null, transition: null, transitionDurationMs: null }
  ]
}

interface FakeCameraService extends CameraServiceLike {
  emitState(state: CameraState): void
  /** Every slot that actually reached the service. Must stay empty for rejected input. */
  readonly selected: CameraSlot[]
  /** Every config that actually reached the service. Same rule. */
  readonly configWrites: CameraConfig[]
  readonly stateUnsubscribed: () => number
}

function createFakeCameraService(): FakeCameraService {
  let listener: ((state: CameraState) => void) | null = null
  let unsubscribes = 0
  let config: CameraConfig = BOUND_CAMERA_CONFIG
  let programScene: string | null = 'Cam 1'
  const selected: CameraSlot[] = []
  const configWrites: CameraConfig[] = []

  // Built from the shared contract's own `slotForScene`, so `activeSlot` here follows exactly
  // the rule the renderer's live indicator will follow.
  const snapshot = (): CameraState => ({
    currentProgramScene: programScene,
    activeSlot: slotForScene(config, programScene),
    availableTransitions: AVAILABLE_TRANSITIONS
  })

  const service: FakeCameraService = {
    selected,
    configWrites,
    stateUnsubscribed: () => unsubscribes,

    // A bare value, not a Result — the seam normalises either, and mixing the two shapes across
    // the fake's methods is what keeps `resolveCall` honest.
    getConfig: () => config,
    setConfig: (next) => {
      configWrites.push(next)
      config = next
      return ok(config)
    },
    getState: () => snapshot(),
    select: (slot) => {
      selected.push(slot)
      const binding = findBinding(config, slot)
      // `isBindingUsable` is the contract's answer; the two extra clauses are only there to
      // narrow `sceneName` for the compiler, which cannot see through a boolean helper.
      //
      // The code is `NOT_FOUND` here purely so it is distinguishable from the `INVALID_ARG`
      // that `safeHandle`'s validator produces — this file is testing the IPC layer, and the
      // discriminator that actually matters is whether `selected` grew. The real
      // `CameraService` refuses an unmapped slot with its own code; which one it picks is its
      // business, and asserting it here would couple these tests to another module's wording.
      if (binding === null || !isBindingUsable(binding) || binding.sceneName === null) {
        return err('NOT_FOUND', 'that camera button is not mapped to a scene', `slot=${slot}`)
      }
      programScene = binding.sceneName
      const state = snapshot()
      listener?.(state)
      return ok(state)
    },
    onState: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
        listener = null
      }
    },

    emitState: (state) => {
      listener?.(state)
    }
  }
  return service
}

// ---------------------------------------------------------------------------
// YouTube fake (BLUEPRINT.md §5, Part A)
//
// Entirely in-memory. It never constructs an OAuth client, never imports `googleapis` and
// never opens a socket — the point of the structural seam is that these tests can prove the
// IPC contract with zero credentials and zero network, which is the only environment this
// repo will ever be built in.
// ---------------------------------------------------------------------------

const SIGNED_OUT_STATUS: YouTubeStatus = {
  auth: { state: 'signed-out', channel: null, lastError: null },
  broadcast: null,
  stream: null,
  template: defaultBroadcastTemplate(),
  preflight: [
    {
      code: 'ccli-streaming-licence',
      // docs/v2-notes/LEGAL_AND_CONTENT.md — the streaming-licence gate is a legal
      // requirement, and it surfaces as a blocking pre-flight issue rather than as a nag.
      message: 'confirm the CCLI streaming licence covers this service',
      severity: 'error'
    }
  ]
}

/** What the fake reports once signed in. Still no token field anywhere — the type has none. */
const SIGNED_IN_STATUS: YouTubeStatus = {
  auth: {
    state: 'signed-in',
    channel: { id: 'UC_test', title: 'Test Church', customUrl: '@testchurch' },
    lastError: null
  },
  broadcast: null,
  stream: {
    id: 'stream-persistent',
    title: 'Verger persistent stream',
    ingestAddress: 'rtmp://a.rtmp.youtube.com/live2',
    health: 'noData'
  },
  template: defaultBroadcastTemplate(),
  preflight: []
}

const CREATED_BROADCAST: Broadcast = {
  id: 'broadcast-1',
  title: 'Sunday Service — 2026-07-26',
  privacy: 'unlisted',
  scheduledStartTime: '2026-07-26T01:00:00.000Z',
  lifecycle: 'ready',
  boundStreamId: 'stream-persistent',
  watchUrl: 'https://www.youtube.com/watch?v=broadcast-1'
}

interface FakeYouTubeService extends YouTubeServiceLike {
  emitStatus(status: YouTubeStatus): void
  /** Every template that actually reached the service. Must stay empty for rejected input. */
  readonly templateWrites: BroadcastTemplate[]
  /** Every create request that actually reached the service. Same rule. */
  readonly createCalls: Array<{ scheduledStartTime?: string }>
  readonly signInCalls: () => number
  readonly signOutCalls: () => number
  readonly statusUnsubscribed: () => number
}

function createFakeYouTubeService(): FakeYouTubeService {
  let listener: ((status: YouTubeStatus) => void) | null = null
  let unsubscribes = 0
  let signIns = 0
  let signOuts = 0
  let status: YouTubeStatus = SIGNED_OUT_STATUS
  const templateWrites: BroadcastTemplate[] = []
  const createCalls: Array<{ scheduledStartTime?: string }> = []

  const service: FakeYouTubeService = {
    templateWrites,
    createCalls,
    signInCalls: () => signIns,
    signOutCalls: () => signOuts,
    statusUnsubscribed: () => unsubscribes,

    // A bare value rather than a Result, deliberately — `resolveCall` normalises both, and
    // mixing the shapes across this fake's methods is what keeps that honest.
    getStatus: () => status,
    signIn: () => {
      signIns += 1
      status = SIGNED_IN_STATUS
      listener?.(status)
      return ok(status)
    },
    signOut: () => {
      signOuts += 1
      status = SIGNED_OUT_STATUS
      listener?.(status)
      return ok(status)
    },
    setTemplate: (template) => {
      templateWrites.push(template)
      status = { ...status, template }
      return ok(status)
    },
    createBroadcast: (options) => {
      createCalls.push(options)
      return ok(CREATED_BROADCAST)
    },
    onStatus: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
        listener = null
      }
    },

    emitStatus: (next) => {
      listener?.(next)
    }
  }
  return service
}

// ---------------------------------------------------------------------------
// Go live fake (BLUEPRINT.md §5, Part B)
//
// In-memory, like the others, and for the same binding reason twice over: OBS Studio is not
// installed on this machine, so nothing may issue a real `StartStream`, and there are no Google
// credentials, so nothing may attempt a real transition.
//
// The fake enforces Standing Rule 3 on itself — every state it produces from `start()` has
// `recording: true` alongside `streaming: true` — so a regression that let the IPC layer ask for
// a stream without a recording would have to change this file to pass, rather than slip through.
// ---------------------------------------------------------------------------

function stepsAll(state: StepState): readonly GoLiveStepStatus[] {
  return GO_LIVE_STEPS.map((step) => ({
    step,
    state,
    message: null,
    startedAt: 1_000,
    finishedAt: state === 'done' ? 2_000 : null
  }))
}

/** Everything worked: on air publicly, and going to disk. */
const LIVE_GO_LIVE_STATE: GoLiveState = {
  phase: 'live',
  steps: stepsAll('done'),
  liveSince: 1_500,
  obs: {
    ...emptyObsOutputState(),
    streaming: true,
    // Standing Rule 3. Never false in a state that has `streaming: true`.
    recording: true,
    streamTimecodeMs: 30_000,
    recordTimecodeMs: 30_000,
    recordingPath: 'D:/verger/recordings/2026-07-26 10-00-00.mkv'
  },
  lastError: null,
  reattached: false
}

/**
 * The honest description of the most likely real failure.
 *
 * OBS is streaming and recording; YouTube never transitioned. The service is on disk and at
 * YouTube's ingest, but not public. This fixture exists because the IPC layer must carry it
 * through untouched — collapsing it into `live` or `failed` would lie to the operator in
 * opposite directions, and the test below asserts the handler does neither.
 */
const PARTIAL_GO_LIVE_STATE: GoLiveState = {
  phase: 'partial',
  steps: GO_LIVE_STEPS.map((step) =>
    step === 'transition'
      ? {
          step,
          state: 'failed' as StepState,
          message: 'liveBroadcasts.transition was refused',
          startedAt: 1_000,
          finishedAt: 2_000
        }
      : { step, state: 'done' as StepState, message: null, startedAt: 1_000, finishedAt: 2_000 }
  ),
  liveSince: 1_500,
  obs: { ...emptyObsOutputState(), streaming: true, recording: true },
  lastError: 'the YouTube transition failed; OBS is still streaming and recording',
  reattached: false
}

/** What a launch into an already-streaming OBS looks like (Standing Rule 2). */
const REATTACHED_GO_LIVE_STATE: GoLiveState = {
  ...LIVE_GO_LIVE_STATE,
  reattached: true
}

/** After END: nothing running, and the steps reset. */
const ENDED_GO_LIVE_STATE: GoLiveState = idleGoLiveState()

interface FakeGoLiveService extends GoLiveServiceLike {
  emitState(state: GoLiveState): void
  /**
   * The argument list each `start()` actually received.
   *
   * The load-bearing fixture of this phase: it must be `[[]]`, i.e. the IPC layer passed
   * *nothing*. There is therefore no options object on this boundary that could ever have
   * carried a "skip the recording" flag.
   */
  readonly startArgs: unknown[][]
  readonly endArgs: unknown[][]
  readonly stateUnsubscribed: () => number
  /** The state `getState()` reports. Settable so a test can stage a re-attach. */
  current: GoLiveState
  failStartWith: Error | null
  failGetStateWith: Error | null
  /** Flip to make `start()` land in `partial` instead of `live`. */
  transitionFails: boolean
}

function createFakeGoLiveService(): FakeGoLiveService {
  let listener: ((state: GoLiveState) => void) | null = null
  let unsubscribes = 0
  const startArgs: unknown[][] = []
  const endArgs: unknown[][] = []

  const service: FakeGoLiveService = {
    startArgs,
    endArgs,
    stateUnsubscribed: () => unsubscribes,
    current: idleGoLiveState(),
    failStartWith: null,
    failGetStateWith: null,
    transitionFails: false,

    // A bare value rather than a Result, deliberately — `resolveCall` normalises both, and
    // mixing the shapes across this fake's methods is what keeps that honest.
    getState: () => {
      if (service.failGetStateWith !== null) throw service.failGetStateWith
      return service.current
    },
    start: (...args: unknown[]) => {
      startArgs.push(args)
      if (service.failStartWith !== null) throw service.failStartWith
      service.current = service.transitionFails ? PARTIAL_GO_LIVE_STATE : LIVE_GO_LIVE_STATE
      listener?.(service.current)
      return ok(service.current)
    },
    end: (...args: unknown[]) => {
      endArgs.push(args)
      service.current = ENDED_GO_LIVE_STATE
      listener?.(service.current)
      return ok(service.current)
    },
    onState: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
        listener = null
      }
    },

    emitState: (state) => {
      service.current = state
      listener?.(state)
    }
  }
  return service
}

// ---------------------------------------------------------------------------
// Service plan fakes (BLUEPRINT.md §7)
//
// Standing Rule 4 governs every fixture below. The slide cues carry asset *paths*, the labels are
// "SLIDE 1"-style placeholders, and the one scripture cue carries a placeholder reference and no
// text — because `ScripturePayload` has no text field to put any in. Nothing in this file is real
// hymn lyrics, real verse text or a real sermon.
// ---------------------------------------------------------------------------

/** An absolute path built the same way `acceptPath` will resolve it, on any platform. */
function absolutePath(...segments: string[]): string {
  return resolvePath(...segments)
}

const PLAN_PATH = absolutePath('plans', 'sunday.json')
const DECK_PATH = absolutePath('decks', 'sunday.pptx')

const PLACEHOLDER_PLAN: ServicePlan = {
  schemaVersion: 1,
  service: 'PLACEHOLDER SERVICE',
  defaultMode: 'assist',
  cues: [
    {
      id: 'cue-1',
      type: 'slide',
      label: 'SLIDE 1',
      trigger: { mode: 'manual' },
      payload: { asset: 'slides/slide-001.png', sourceSlide: 1 }
    },
    {
      id: 'cue-2',
      type: 'scripture',
      label: 'PLACEHOLDER READING',
      trigger: { mode: 'manual' },
      payload: { reference: 'PLACEHOLDER 1:1' }
    }
  ],
  assetDir: 'assets'
}

const PLAN_STATE: PlanState = {
  plan: PLACEHOLDER_PLAN,
  position: initialPlanPosition(),
  path: null,
  dirty: false,
  lastFired: null
}

/** What the importer reports on this build machine: no converter, and what to install. */
const NO_IMPORTER: DeckImporterStatus = {
  available: false,
  backend: null,
  executablePath: null,
  detail: 'install LibreOffice to enable PowerPoint import'
}

interface FakePlanService extends PlanServiceLike {
  emitState(state: PlanState): void
  emitImportProgress(progress: DeckImportProgress): void
  readonly stateUnsubscribed: () => number
  readonly progressUnsubscribed: () => number
  readonly setCalls: ServicePlan[]
  readonly opened: string[]
  readonly saved: string[]
  readonly imported: string[]
  readonly fired: string[]
  readonly advances: () => number
  readonly backs: () => number
  current: PlanState
}

function createFakePlanService(): FakePlanService {
  let stateListener: ((state: PlanState) => void) | null = null
  let progressListener: ((progress: DeckImportProgress) => void) | null = null
  let stateUnsubscribes = 0
  let progressUnsubscribes = 0
  let advanceCount = 0
  let backCount = 0
  const setCalls: ServicePlan[] = []
  const opened: string[] = []
  const saved: string[] = []
  const imported: string[] = []
  const fired: string[] = []

  const service: FakePlanService = {
    setCalls,
    opened,
    saved,
    imported,
    fired,
    advances: () => advanceCount,
    backs: () => backCount,
    stateUnsubscribed: () => stateUnsubscribes,
    progressUnsubscribed: () => progressUnsubscribes,
    current: PLAN_STATE,

    // A bare value rather than a `Result`, deliberately — `resolveCall` normalises both, and
    // mixing the two shapes across this fake keeps that normalisation honest.
    getState: () => service.current,
    setPlan: (plan) => {
      setCalls.push(plan)
      service.current = { ...service.current, plan, dirty: true }
      return ok(service.current)
    },
    open: (path) => {
      opened.push(path)
      service.current = { ...service.current, path, dirty: false }
      return ok(service.current)
    },
    save: (path) => {
      saved.push(path)
      service.current = { ...service.current, path, dirty: false }
      return ok(service.current)
    },
    importDeck: (path) => {
      imported.push(path)
      return ok(service.current)
    },
    fireCue: (cueId) => {
      fired.push(cueId)
      return ok(service.current)
    },
    advance: () => {
      advanceCount += 1
      return ok(service.current)
    },
    back: () => {
      backCount += 1
      return ok(service.current)
    },
    getImporterStatus: () => ok(NO_IMPORTER),
    onState: (next) => {
      stateListener = next
      return () => {
        stateUnsubscribes += 1
        stateListener = null
      }
    },
    onImportProgress: (next) => {
      progressListener = next
      return () => {
        progressUnsubscribes += 1
        progressListener = null
      }
    },

    emitState: (state) => {
      service.current = state
      stateListener?.(state)
    },
    emitImportProgress: (progress) => {
      progressListener?.(progress)
    }
  }
  return service
}

// ---------------------------------------------------------------------------
// ASR fake (BLUEPRINT.md §4 and §8)
//
// Entirely in-memory, and deliberately so in two directions at once. It opens no websocket and
// spawns no Python, because no test here may reach the network or load a model — and every byte of
// audio it is fed is **synthesised in this file**, because Standing Rule 4 forbids committing
// audio fixtures or transcripts of copyrighted material. The PCM below is arithmetic (silence and
// a sine tone) and the transcript text is invented placeholder wording that nobody has ever said
// from a pulpit.
// ---------------------------------------------------------------------------

/** Bytes one millisecond of the contract's PCM format occupies: 16 kHz x 1ch x 16-bit = 32. */
const PCM_BYTES_PER_MS = 32

/** Samples in `ms` milliseconds of the contract's format. */
function pcmSampleCount(ms: number): number {
  return Math.round((ASR_SAMPLE_RATE * ms) / 1000) * ASR_CHANNELS
}

/**
 * `ms` milliseconds of digital silence.
 *
 * Synthesised, not recorded. It is also the input the local adapter's hallucination filter exists
 * for — Whisper fed silence emits "thank you for watching" — which is why silence rather than
 * noise is the default fixture here.
 */
function pcmSilence(ms: number): ArrayBuffer {
  return new Int16Array(pcmSampleCount(ms)).buffer as ArrayBuffer
}

/** `ms` milliseconds of a pure tone. The only "speech-like" input this repo will ever contain. */
function pcmSineTone(ms: number, hz = 440): ArrayBuffer {
  const samples = pcmSampleCount(ms)
  const pcm = new Int16Array(samples)
  for (let index = 0; index < samples; index += 1) {
    pcm[index] = Math.round(Math.sin((2 * Math.PI * hz * index) / ASR_SAMPLE_RATE) * 8_000)
  }
  return pcm.buffer as ArrayBuffer
}

const LISTENING_ASR_STATUS: AsrStatus = {
  state: 'listening',
  provider: 'deepgram',
  language: 'ko',
  latencyMs: 320,
  deviceId: 'mic-1',
  deviceLabel: 'Pulpit mic',
  lastError: null,
  since: 1_000
}

/**
 * Cloud died, local took over, transcript still arriving.
 *
 * Kept distinct from the failed status below on purpose: `degraded` means "working, but worse" and
 * `failed` means "you are on your own now". Collapsing them would hide a provider fallback the
 * operator has a right to see, and the tests below assert both survive the boundary unflattened.
 */
const DEGRADED_ASR_STATUS: AsrStatus = {
  ...LISTENING_ASR_STATUS,
  state: 'degraded',
  provider: 'whisper',
  latencyMs: 1_400,
  lastError: 'the cloud provider dropped; recognising locally'
}

const FAILED_ASR_STATUS: AsrStatus = {
  ...idleAsrStatus(),
  state: 'failed',
  lastError: 'no provider could be started'
}

/**
 * The draft half of one span of speech, and then its final.
 *
 * Same `id`, and that is the entire draft/final contract: the final REPLACES the draft rather than
 * following it. The text is invented placeholder wording — Standing Rule 4 means no real sermon,
 * hymn or verse text is committed to this repo, and a test asserting fan-out does not need any.
 */
const DRAFT_SEGMENT: TranscriptSegment = {
  id: 'segment-1',
  text: 'PARTIAL TRANSCRIPT PLACEHOLDER',
  isFinal: false,
  tsStart: 0,
  tsEnd: 640,
  confidence: null,
  provider: 'whisper',
  isDraft: true
}

const FINAL_SEGMENT: TranscriptSegment = {
  id: 'segment-1',
  text: 'FINAL TRANSCRIPT PLACEHOLDER',
  isFinal: true,
  tsStart: 0,
  tsEnd: 980,
  confidence: 0.91,
  provider: 'whisper',
  isDraft: false
}

const ASR_SETTINGS: AsrSettings = {
  mode: 'auto',
  language: 'ko',
  deviceId: 'mic-1',
  // Invented placeholder terms. Real keyword boosting would carry a pastor's name and hymn titles;
  // neither belongs in a committed fixture.
  customVocabulary: ['PLACEHOLDER NAME', 'PLACEHOLDER CHURCH'],
  localModel: 'small'
}

const AUDIO_DEVICES: readonly AudioInputDevice[] = [
  { deviceId: 'mic-1', label: 'Pulpit mic' },
  { deviceId: 'mic-2', label: 'Ambient mic' }
]

interface FakeAsrService extends AsrServiceLike {
  emitStatus(status: AsrStatus): void
  emitTranscript(segment: TranscriptSegment): void
  /** Every chunk that actually reached the service. Must stay empty for rejected input. */
  readonly chunks: Uint8Array[]
  /** Every settings object that actually reached the service. Same rule. */
  readonly settingsWrites: AsrSettings[]
  readonly deviceReports: Array<readonly AudioInputDevice[]>
  readonly startCalls: () => number
  readonly stopCalls: () => number
  readonly statusUnsubscribed: () => number
  readonly transcriptUnsubscribed: () => number
}

function createFakeAsrService(): FakeAsrService {
  let statusListener: ((status: AsrStatus) => void) | null = null
  let transcriptListener: ((segment: TranscriptSegment) => void) | null = null
  let statusUnsubscribes = 0
  let transcriptUnsubscribes = 0
  let starts = 0
  let stops = 0
  let settings: AsrSettings = ASR_SETTINGS
  const chunks: Uint8Array[] = []
  const settingsWrites: AsrSettings[] = []
  const deviceReports: Array<readonly AudioInputDevice[]> = []

  const service: FakeAsrService = {
    chunks,
    settingsWrites,
    deviceReports,
    startCalls: () => starts,
    stopCalls: () => stops,
    statusUnsubscribed: () => statusUnsubscribes,
    transcriptUnsubscribed: () => transcriptUnsubscribes,

    // A bare value rather than a Result, like the camera and overlay fakes: mixing the two shapes
    // across the fakes is what keeps `resolveCall` honest.
    getStatus: () => LISTENING_ASR_STATUS,
    getSettings: () => settings,
    setSettings: (next) => {
      settingsWrites.push(next)
      settings = next
      return ok(settings)
    },
    start: () => {
      starts += 1
      return ok(LISTENING_ASR_STATUS)
    },
    stop: () => {
      stops += 1
      return ok(idleAsrStatus())
    },
    pushAudio: (chunk) => {
      chunks.push(chunk)
      return ok(undefined)
    },
    listDevices: (devices) => {
      deviceReports.push(devices)
      return ok(undefined)
    },
    onStatus: (listener) => {
      statusListener = listener
      return () => {
        statusUnsubscribes += 1
        statusListener = null
      }
    },
    onTranscript: (listener) => {
      transcriptListener = listener
      return () => {
        transcriptUnsubscribes += 1
        transcriptListener = null
      }
    },

    emitStatus: (status) => {
      statusListener?.(status)
    },
    emitTranscript: (segment) => {
      transcriptListener?.(segment)
    }
  }
  return service
}

interface FakeDialog extends DialogLike {
  openResult: OpenDialogResultLike
  saveResult: SaveDialogResultLike
  readonly openCalls: Array<{ filters?: { name: string; extensions: string[] }[] }>
  readonly saveCalls: Array<{ filters?: { name: string; extensions: string[] }[] }>
}

function createFakeDialog(): FakeDialog {
  const openCalls: FakeDialog['openCalls'] = []
  const saveCalls: FakeDialog['saveCalls'] = []
  const dialogs: FakeDialog = {
    openResult: { canceled: false, filePaths: [PLAN_PATH] },
    saveResult: { canceled: false, filePath: PLAN_PATH },
    openCalls,
    saveCalls,
    showOpenDialog: (options) => {
      openCalls.push(options)
      return dialogs.openResult
    },
    showSaveDialog: (options) => {
      saveCalls.push(options)
      return dialogs.saveResult
    }
  }
  return dialogs
}

interface FakeFilePaths extends FilePathProbeLike {
  readonly entries: Map<string, PathKind>
}

/** Everything named here is a file; everything else is missing. No disk is touched. */
function createFakeFilePaths(files: readonly string[] = [PLAN_PATH, DECK_PATH]): FakeFilePaths {
  const entries = new Map<string, PathKind>(files.map((file) => [file, 'file'] as const))
  return { entries, kind: (target) => entries.get(target) ?? 'missing' }
}

/**
 * Anything that smells like a credential.
 *
 * Used to assert, structurally rather than by inspection, that nothing crossing the youtube
 * channels carries an OAuth token or an RTMP stream key. `ingestAddress` is deliberately *not*
 * matched: the ingest URL is public and is not a secret on its own — the key that goes with it
 * is, and `PersistentStream` has no field for one.
 */
const CREDENTIAL_KEY_PATTERN = /key|token|secret|password|credential|bearer|refresh/i

/** Every property name appearing anywhere in a JSON-serialisable value. */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into)
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [name, nested] of Object.entries(value)) {
      into.push(name)
      collectKeys(nested, into)
    }
  }
  return into
}

/** Standing Rule 4: no verse text is ever authored in this repo, fixtures included. */
const SCRIPTURE_TEXT_PLACEHOLDER = 'VERSE TEXT PLACEHOLDER'

// ---------------------------------------------------------------------------
// Cue engine fixtures (BLUEPRINT.md §4)
//
// Standing Rule 4 governs every fixture below. A `ScriptureReference` is a *reference* — book,
// chapter, verse — and carries no text at all, which is why one can be written here safely. The
// only "verse text" in this file is `SCRIPTURE_TEXT_PLACEHOLDER`, and every transcript span is an
// invented placeholder rather than anything a real preacher said.
// ---------------------------------------------------------------------------

/** Placeholder transcript spans. Synthetic — no real sermon appears in this repository. */
const PLACEHOLDER_ANCHOR = 'PLACEHOLDER TRANSCRIPT: the first thing I want us to see'
const PLACEHOLDER_SCRIPTURE_SPAN = 'PLACEHOLDER TRANSCRIPT: turn with me to John three sixteen'

const SCRIPTURE_REFERENCE: ScriptureReference = {
  book: 'John',
  spokenBook: 'John',
  chapter: 3,
  verse: 16,
  verseEnd: null,
  confidence: CONFIDENCE_EXACT,
  band: 'exact',
  sourceText: PLACEHOLDER_SCRIPTURE_SPAN
}

/**
 * The resolved text.
 *
 * `text` is the placeholder and nothing else, ever. Real verse text reaches Verger at runtime from
 * a licensed API or a verified public-domain download; it is never authored here, and a fixture is
 * exactly the place a future edit would be tempted to "just paste the verse in".
 */
const RESOLVED_SCRIPTURE: ResolvedScripture = {
  reference: SCRIPTURE_REFERENCE,
  text: SCRIPTURE_TEXT_PLACEHOLDER,
  translation: 'KJV',
  attribution: 'Public domain'
}

/**
 * The translation catalogue.
 *
 * Two entries on purpose. `docs/v2-notes/LEGAL_AND_CONTENT.md` describes a quarantine rule for a
 * translation whose public-domain status is contested — the Korean KRV specifically — and the
 * catalogue is where that fact lives: `verified: false`, so nothing may offer it for selection
 * merely because a file exists.
 */
const TRANSLATIONS: readonly TranslationSource[] = [
  {
    code: 'KJV',
    name: 'King James Version',
    language: 'en',
    kind: 'public-domain',
    license: 'Public domain',
    attribution: null,
    verified: true
  },
  {
    code: 'KRV',
    name: 'Korean Revised Version',
    language: 'ko',
    kind: 'public-domain',
    license: 'contested — quarantined pending verification',
    attribution: null,
    verified: false
  }
]

const PLAN_SUGGESTION: CueSuggestion = {
  id: 'suggestion-plan-1',
  detector: 'plan',
  cueId: 'cue-1',
  reference: null,
  confidence: 0.91,
  why: `matched "${PLACEHOLDER_ANCHOR}"`,
  at: 12_000,
  canAutoFire: true
}

/**
 * A scripture suggestion whose text has not resolved.
 *
 * `canAutoFire: false` is the hard gate from `@shared/scripture` — a confident *reference* says
 * nothing about whether the *text* is in hand, and auto-showing one whose text failed to resolve
 * puts an empty scripture card in front of a congregation.
 */
const SCRIPTURE_SUGGESTION: CueSuggestion = {
  id: 'suggestion-scripture-1',
  detector: 'scripture',
  cueId: null,
  reference: SCRIPTURE_REFERENCE,
  confidence: CONFIDENCE_WEAK,
  why: 'detected a scripture reference',
  at: 13_000,
  canAutoFire: false
}

const CUE_SETTINGS: CueEngineSettings = {
  ...defaultCueEngineSettings(),
  hotPhrases: [
    { id: 'hotphrase-1', phrase: 'PLACEHOLDER HOT PHRASE', cueId: 'cue-3', enabled: true }
  ]
}

const ASSISTING_CUE_STATE: CueEngineState = {
  ...idleCueEngineState(),
  alignment: 'aligned',
  position: 2,
  pending: PLAN_SUGGESTION
}

interface FakeCueEngine extends CueEngineLike {
  emitState(state: CueEngineState): void
  emitSuggestion(suggestion: CueSuggestion): void
  /** Every settings object that actually reached the engine. Must stay empty for rejected input. */
  readonly settingsWrites: CueEngineSettings[]
  readonly modeWrites: TrustMode[]
  readonly confirmed: string[]
  readonly dismissed: string[]
  readonly panicCalls: () => number
  readonly resumeCalls: () => number
  readonly stateUnsubscribed: () => number
  readonly suggestionUnsubscribed: () => number
}

function createFakeCueEngine(): FakeCueEngine {
  let stateListener: ((state: CueEngineState) => void) | null = null
  let suggestionListener: ((suggestion: CueSuggestion) => void) | null = null
  let stateUnsubscribes = 0
  let suggestionUnsubscribes = 0
  let panics = 0
  let resumes = 0
  let settings: CueEngineSettings = defaultCueEngineSettings()
  let state: CueEngineState = ASSISTING_CUE_STATE
  const settingsWrites: CueEngineSettings[] = []
  const modeWrites: TrustMode[] = []
  const confirmed: string[] = []
  const dismissed: string[] = []

  const engine: FakeCueEngine = {
    settingsWrites,
    modeWrites,
    confirmed,
    dismissed,
    panicCalls: () => panics,
    resumeCalls: () => resumes,
    stateUnsubscribed: () => stateUnsubscribes,
    suggestionUnsubscribed: () => suggestionUnsubscribes,

    // A bare value rather than a Result, like the camera, overlay and ASR fakes: mixing the two
    // shapes across the fakes is what keeps `resolveCall` honest.
    getState: () => state,
    getSettings: () => settings,
    setSettings: (next) => {
      settingsWrites.push(next)
      settings = next
      return ok(settings)
    },
    setMode: (mode) => {
      modeWrites.push(mode)
      state = { ...state, mode }
      return ok(state)
    },
    confirm: (suggestionId) => {
      confirmed.push(suggestionId)
      // A stale id must miss rather than fire whatever happens to be pending.
      if (state.pending?.id !== suggestionId) return ok(state)
      state = { ...state, pending: null, recent: [state.pending, ...state.recent] }
      return ok(state)
    },
    dismiss: (suggestionId) => {
      dismissed.push(suggestionId)
      if (state.pending?.id !== suggestionId) return ok(state)
      state = { ...state, pending: null }
      return ok(state)
    },
    panic: () => {
      panics += 1
      state = { ...state, enabled: false, mode: 'manual', pending: null, panicked: true }
      return ok(state)
    },
    resume: () => {
      resumes += 1
      state = { ...state, enabled: true, mode: 'assist', panicked: false }
      return ok(state)
    },
    onState: (listener) => {
      stateListener = listener
      return () => {
        stateUnsubscribes += 1
        stateListener = null
      }
    },
    onSuggestion: (listener) => {
      suggestionListener = listener
      return () => {
        suggestionUnsubscribes += 1
        suggestionListener = null
      }
    },

    emitState: (next) => {
      stateListener?.(next)
    },
    emitSuggestion: (suggestion) => {
      suggestionListener?.(suggestion)
    }
  }
  return engine
}

// ---------------------------------------------------------------------------
// Health (BLUEPRINT.md §9)
// ---------------------------------------------------------------------------

const HEALTH_AT = 1_764_000_000_000

/** Every light green. The state a service should be in. */
function healthySnapshot(at = HEALTH_AT): HealthSnapshot {
  const subsystems: readonly SubsystemHealth[] = SUBSYSTEMS.map((id) => ({
    ...initialHealth(id, at),
    level: 'ok' as const,
    detail: 'ok'
  }))
  return { subsystems, worst: worstLevel(subsystems), at }
}

/**
 * The blueprint's "internet drops mid-stream" row, as a snapshot.
 *
 * `stream` is amber — working, but not as configured, which is what `degraded` is reserved for —
 * and `stillWorks` says the thing that keeps an operator from stopping the service to investigate.
 * `recording` stays green, because the local recording is exactly what does not care that the
 * uplink wobbled.
 */
function reconnectingSnapshot(at = HEALTH_AT): HealthSnapshot {
  const subsystems: readonly SubsystemHealth[] = healthySnapshot(at).subsystems.map((subsystem) =>
    subsystem.id === 'stream'
      ? {
          ...subsystem,
          level: 'degraded' as const,
          detail: 'reconnecting (attempt 3)',
          stillWorks: 'the local recording is unaffected and is still writing to disk'
        }
      : subsystem
  )
  return { subsystems, worst: worstLevel(subsystems), at }
}

const CHECKPOINTS: readonly Checkpoint[] = [
  {
    id: 'cp-2',
    at: HEALTH_AT - 30_000,
    planPosition: 7,
    overlayRevision: 12,
    label: 'after cue "Point 1 — Grace"'
  },
  {
    id: 'cp-1',
    at: HEALTH_AT - 90_000,
    planPosition: 4,
    overlayRevision: 9,
    label: 'after cue "Welcome"'
  }
]

interface FakeHealthService extends HealthServiceLike {
  emitSnapshot(snapshot: HealthSnapshot): void
  readonly snapshotUnsubscribed: () => number
  /** When set, `getSnapshot` throws it — a monitor that has itself broken mid-service. */
  throwWith: Error | null
}

/**
 * A health aggregator that watches nothing.
 *
 * Note what it has no way to do, because {@link HealthServiceLike} has no way to say it: stop a
 * stream, stop a recording, disconnect OBS — or in fact change anything at all. The aggregator
 * observes; the two seams below are the ones that act.
 */
function createFakeHealthService(): FakeHealthService {
  let listener: ((snapshot: HealthSnapshot) => void) | null = null
  let unsubscribes = 0
  let snapshot = healthySnapshot()

  const service: FakeHealthService = {
    throwWith: null,
    snapshotUnsubscribed: () => unsubscribes,
    getSnapshot: () => {
      if (service.throwWith !== null) throw service.throwWith
      return snapshot
    },
    onSnapshot: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
        listener = null
      }
    },
    emitSnapshot: (next) => {
      snapshot = next
      listener?.(next)
    }
  }
  return service
}

interface FakeCheckpointStore extends CheckpointStoreLike {
  readonly restoreCalls: string[]
  /** When set, every method throws it. */
  throwWith: Error | null
}

/**
 * A checkpoint store holding two checkpoints and nothing else.
 *
 * `restore` answers `NOT_FOUND` for an id it does not hold, which is the case the handler has to
 * forward cleanly rather than turn into a crash: an operator whose rewind did not happen is about
 * to act on the assumption that it did.
 *
 * There is no `stopStream` and no `stopRecord` here because {@link CheckpointStoreLike} has no way
 * to name one. The tests below assert that a restore left the go-live service and the OBS client
 * untouched, and the type is what makes that assertion true by construction rather than by this
 * fake's good behaviour.
 */
function createFakeCheckpointStore(): FakeCheckpointStore {
  const restoreCalls: string[] = []

  const store: FakeCheckpointStore = {
    throwWith: null,
    restoreCalls,
    list: () => {
      if (store.throwWith !== null) throw store.throwWith
      return CHECKPOINTS
    },
    restore: (checkpointId: string) => {
      if (store.throwWith !== null) throw store.throwWith
      restoreCalls.push(checkpointId)
      const found = CHECKPOINTS.find((checkpoint) => checkpoint.id === checkpointId)
      if (found === undefined) {
        return err(
          'NOT_FOUND',
          'that checkpoint is no longer retained',
          'nothing was changed; the stream and the recording are unaffected'
        )
      }
      return found
    }
  }
  return store
}

interface FakeOverlayReload extends OverlayReloadLike {
  readonly reloadCalls: () => number
  /** When set, `reloadNow` throws it. */
  throwWith: Error | null
  /** When set, `reloadNow` reports this failure instead of succeeding. */
  failWith: Result<never> | null
}

/** The overlay watchdog's reload channel, with no socket behind it. */
function createFakeOverlayReload(): FakeOverlayReload {
  let reloads = 0

  const channel: FakeOverlayReload = {
    throwWith: null,
    failWith: null,
    reloadCalls: () => reloads,
    reloadNow: () => {
      if (channel.throwWith !== null) throw channel.throwWith
      if (channel.failWith !== null) return channel.failWith
      reloads += 1
      return ok(undefined)
    }
  }
  return channel
}

interface FakeScriptureResolver extends ScriptureResolverLike {
  readonly resolveCalls: Array<{
    reference: ScriptureReference
    translation: string | undefined
  }>
  readonly listCalls: () => number
}

/**
 * A resolver that touches no network and holds no verse text.
 *
 * What it hands back is `SCRIPTURE_TEXT_PLACEHOLDER` — the only "verse text" anywhere in this
 * repository. The real resolver fetches from a licensed API or a verified public-domain file at
 * runtime; nothing here, and nothing in any fixture, ever authors a verse (Standing Rule 4).
 */
function createFakeScriptureResolver(): FakeScriptureResolver {
  let lists = 0
  const resolveCalls: FakeScriptureResolver['resolveCalls'] = []
  return {
    resolveCalls,
    listCalls: () => lists,
    resolve: (reference, translation) => {
      resolveCalls.push({ reference, translation })
      return ok({
        ...RESOLVED_SCRIPTURE,
        reference,
        translation: translation ?? RESOLVED_SCRIPTURE.translation
      })
    },
    // Only the verified entries. The quarantined KRV is in the catalogue and is not offered —
    // absent, never present-and-disabled, so nothing downstream can select it.
    listTranslations: () => {
      lists += 1
      return TRANSLATIONS.filter((entry) => entry.verified)
    }
  }
}

const SHOW_LOWER_THIRD: OverlayCommand = {
  channel: 'command',
  name: 'lowerThird.show',
  payload: { line1: 'Pastor Kim', line2: 'Guest Speaker', template: 'bar' }
}

const CONFIG: AppConfig = {
  obs: { url: 'ws://127.0.0.1:4455', password: 'hunter2' },
  google: null,
  deepgramApiKey: null,
  esvApiKey: null,
  apiBibleKey: null,
  sentryDsn: null,
  configured: {
    OBS_WEBSOCKET_URL: true,
    OBS_WEBSOCKET_PASSWORD: true,
    GOOGLE_CLIENT_ID: false,
    GOOGLE_CLIENT_SECRET: false,
    DEEPGRAM_API_KEY: false,
    ESV_API_KEY: false,
    API_BIBLE_KEY: false,
    SENTRY_DSN: false
  },
  warnings: []
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly ipc: FakeIpcMain
  readonly obs: FakeObsClient
  readonly overlay: FakeOverlayServer
  readonly camera: FakeCameraService
  readonly youtube: FakeYouTubeService
  readonly goLive: FakeGoLiveService
  readonly plan: FakePlanService
  readonly asr: FakeAsrService
  readonly cue: FakeCueEngine
  readonly scripture: FakeScriptureResolver
  readonly health: FakeHealthService
  readonly checkpoints: FakeCheckpointStore
  readonly overlayReload: FakeOverlayReload
  readonly dialog: FakeDialog
  readonly filePaths: FakeFilePaths
  readonly windows: FakeWindow[]
  readonly secrets: SecretsStoreLike & { readonly writes: Array<[string, string]> }
  readonly dispose: () => void
  setNow(value: number): void
  invoke(channel: IpcChannelValue, arg?: unknown, event?: IpcInvokeEventLike): Promise<unknown>
}

function setup(options: { windows?: number } = {}): Harness {
  const ipc = createFakeIpcMain()
  const obs = createFakeObsClient()
  const overlay = createFakeOverlayServer()
  const camera = createFakeCameraService()
  const youtube = createFakeYouTubeService()
  const goLive = createFakeGoLiveService()
  const plan = createFakePlanService()
  const asr = createFakeAsrService()
  const cue = createFakeCueEngine()
  const scripture = createFakeScriptureResolver()
  const health = createFakeHealthService()
  const checkpoints = createFakeCheckpointStore()
  const overlayReload = createFakeOverlayReload()
  const dialog = createFakeDialog()
  const filePaths = createFakeFilePaths()
  const windows: FakeWindow[] = Array.from({ length: options.windows ?? 1 }, () =>
    createFakeWindow()
  )
  const writes: Array<[string, string]> = []
  const secrets: SecretsStoreLike & { readonly writes: Array<[string, string]> } = {
    writes,
    setSecret: (key, value) => {
      writes.push([key, value])
      return ok(undefined)
    }
  }

  let clock = 10_000

  const dispose = registerIpc({
    obs,
    overlay,
    camera,
    youtube,
    goLive,
    plan,
    asr,
    cue,
    scripture,
    health,
    checkpoints,
    overlayReload,
    dialog,
    filePaths,
    config: CONFIG,
    logger: createSilentLogger(),
    ipcMain: ipc,
    getWindows: () => windows,
    secrets,
    now: () => clock,
    appVersion: () => '9.9.9'
  })

  return {
    ipc,
    obs,
    overlay,
    camera,
    youtube,
    goLive,
    plan,
    asr,
    cue,
    scripture,
    health,
    checkpoints,
    overlayReload,
    dialog,
    filePaths,
    windows,
    secrets,
    dispose,
    setNow: (value) => {
      clock = value
    },
    invoke: async (channel, arg, event) => {
      const handler = ipc.handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
      const first = windows[0]
      if (first === undefined) throw new Error('the harness needs at least one window')
      return handler(event ?? eventFrom(first), arg)
    }
  }
}

function expectErr(value: unknown): { code: string; message: string; detail?: string } {
  const result = value as Result<unknown>
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a failed Result')
  return result.error
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerIpc', () => {
  let harness: Harness

  beforeEach(() => {
    harness = setup()
  })

  it('registers exactly one handler for every channel in the registry', () => {
    expect([...harness.ipc.handlers.keys()].sort()).toEqual([...IPC_CHANNEL_VALUES].sort())
    // No channel registered twice — a duplicate `handle` would throw in real Electron.
    expect(harness.ipc.handleCalls).toHaveLength(IPC_CHANNEL_VALUES.length)
    expect(new Set(harness.ipc.handleCalls).size).toBe(IPC_CHANNEL_VALUES.length)

    // Named explicitly as well as covered by the registry sweep above. The sweep passes
    // vacuously if a channel is ever dropped from `IpcChannel`; these three are the ones that
    // put a service on the public internet and take it off again, and a phase that shipped
    // without them would fail silently at the button rather than at the build.
    for (const channel of [
      IpcChannel.goLiveGetState,
      IpcChannel.goLiveStart,
      IpcChannel.goLiveEnd
    ]) {
      expect(harness.ipc.handlers.has(channel)).toBe(true)
    }

    // And the seven Phase 7 asr channels, named for the same reason. `asrPushAudio` in particular
    // is registered through the same `safeHandle` wrapper as everything else despite being the hot
    // path — it is the *validator* that differs, never the sender check or the never-throws
    // guarantee.
    for (const channel of [
      IpcChannel.asrGetStatus,
      IpcChannel.asrGetSettings,
      IpcChannel.asrSetSettings,
      IpcChannel.asrStart,
      IpcChannel.asrStop,
      IpcChannel.asrPushAudio,
      IpcChannel.asrListDevices
    ]) {
      expect(harness.ipc.handlers.has(channel)).toBe(true)
    }

    // And the ten Phase 8 cue channels. Named explicitly for the same reason the go-live three
    // are: the registry sweep above passes vacuously if a channel is ever dropped from
    // `IpcChannel`, and a build that shipped without `cuePanic` in particular would fail at the
    // one button that has to work when everything else already has.
    for (const channel of [
      IpcChannel.cueGetState,
      IpcChannel.cueGetSettings,
      IpcChannel.cueSetSettings,
      IpcChannel.cueSetMode,
      IpcChannel.cueConfirm,
      IpcChannel.cueDismiss,
      IpcChannel.cuePanic,
      IpcChannel.cueResume,
      IpcChannel.cueResolveScripture,
      IpcChannel.cueListTranslations
    ]) {
      expect(harness.ipc.handlers.has(channel)).toBe(true)
    }

    // And the four Phase 9 health channels. Named explicitly for the strongest version of the
    // reason the others are: this phase exists partly because four previous phases shipped a
    // component that was fully unit-tested and connected to NOTHING. A health service with no
    // handler on the boundary would be the fifth, and it would pass every test that injects its
    // own fake.
    for (const channel of [
      IpcChannel.healthGet,
      IpcChannel.healthListCheckpoints,
      IpcChannel.healthRestoreCheckpoint,
      IpcChannel.healthReloadOverlays
    ]) {
      expect(harness.ipc.handlers.has(channel)).toBe(true)
    }

    // There is deliberately no `health:stop-*` channel of any kind, and there never may be. No
    // recovery action may stop the stream or the recording — recovering from a failure must never
    // cost more than the failure did — so a future edit that added one would have to delete this
    // assertion first.
    expect(
      IPC_CHANNEL_VALUES.filter(
        (channel) => channel.startsWith('verger:health:') && /stop|end|disconnect/.test(channel)
      )
    ).toEqual([])

    // There is deliberately no `cue:fire` channel. The engine emits intents; something else
    // applies them, and that separation is what makes an operator's veto instant. A future edit
    // that added one would have to delete this assertion first.
    expect(
      IPC_CHANNEL_VALUES.filter(
        (channel) => channel.startsWith('verger:cue:') && /fire|apply|show/.test(channel)
      )
    ).toEqual([])
  })

  it('returns the value a handler produces', async () => {
    const status = (await harness.invoke(IpcChannel.obsGetStatus)) as Result<ObsStatus>
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.state).toBe('connected')

    const scenes = (await harness.invoke(IpcChannel.obsGetSceneList)) as Result<ObsSceneList>
    expect(scenes.ok).toBe(true)
    if (!scenes.ok) return
    expect(scenes.value.currentProgramScene).toBe('Wide')
  })

  it('converts a throwing handler into Err(INTERNAL) instead of rejecting', async () => {
    harness.obs.failStatusWith = new Error('obs client exploded')

    const settled = await harness
      .invoke(IpcChannel.obsGetStatus)
      .then((value) => ({ rejected: false, value }))
      .catch((cause: unknown) => ({ rejected: true, value: cause }))

    expect(settled.rejected).toBe(false)
    const error = expectErr(settled.value)
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('obs client exploded')
  })

  it('rejects a malformed argument with Err(INVALID_ARG) without calling the client', async () => {
    const error = expectErr(
      await harness.invoke(IpcChannel.obsConnect, { url: 'http://nope', password: null })
    )
    expect(error.code).toBe('INVALID_ARG')
    expect(harness.obs.connectCalls).toHaveLength(0)

    // Wrong type entirely.
    expect(expectErr(await harness.invoke(IpcChannel.obsConnect, 'nope')).code).toBe('INVALID_ARG')
    // A no-argument channel still refuses a payload.
    expect(expectErr(await harness.invoke(IpcChannel.configGet, { evil: true })).code).toBe(
      'INVALID_ARG'
    )
  })

  it('never echoes the offending value in the error detail', async () => {
    const error = expectErr(
      await harness.invoke(IpcChannel.obsSetConfig, { url: 'nope', password: 'hunter2' })
    )
    expect(error.code).toBe('INVALID_ARG')
    expect(JSON.stringify(error)).not.toContain('hunter2')
  })

  it('rejects a call whose sender is not one of our windows', async () => {
    const stranger = createFakeWindow('https://evil.example/')
    const error = expectErr(
      await harness.invoke(IpcChannel.obsGetStatus, undefined, eventFrom(stranger))
    )
    expect(error.code).toBe('INVALID_ARG')
  })

  it('rejects a call whose sender frame is gone', async () => {
    const first = harness.windows[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const error = expectErr(
      await harness.invoke(IpcChannel.obsGetStatus, undefined, {
        senderFrame: null,
        sender: first.contents
      })
    )
    expect(error.code).toBe('INVALID_ARG')
  })

  it('rejects a call from a sub-frame of one of our windows', async () => {
    const first = harness.windows[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const error = expectErr(
      await harness.invoke(IpcChannel.obsGetStatus, undefined, {
        senderFrame: { url: 'https://ads.example/iframe' },
        sender: first.contents
      })
    )
    expect(error.code).toBe('INVALID_ARG')
  })

  it('returns the ConfigSummary projection only — never a value', async () => {
    const result = (await harness.invoke(IpcChannel.configGet)) as Result<unknown>
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialised = JSON.stringify(result.value)
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('ws://127.0.0.1:4455')
    expect(result.value).toMatchObject({ obsConfigured: true, googleConfigured: false })
  })

  it('reports app and runtime versions', async () => {
    const result = (await harness.invoke(IpcChannel.appGetVersions)) as Result<{
      app: string
      node: string
    }>
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.app).toBe('9.9.9')
    expect(result.value.node).toBe(process.versions.node)
  })

  it('persists the OBS password and then reconnects on setConfig', async () => {
    const result = (await harness.invoke(IpcChannel.obsSetConfig, {
      url: 'ws://127.0.0.1:4455',
      password: 'hunter2'
    })) as Result<ObsStatus>

    expect(result.ok).toBe(true)
    expect(harness.secrets.writes).toEqual([[OBS_PASSWORD_SECRET_KEY, 'hunter2']])
    expect(harness.obs.disconnectCalls()).toBe(1)
    expect(harness.obs.connectCalls).toEqual([{ url: 'ws://127.0.0.1:4455', password: 'hunter2' }])
  })

  it('still connects when the secrets store cannot persist the password', async () => {
    const ipc = createFakeIpcMain()
    const obs = createFakeObsClient()
    const window = createFakeWindow()
    registerIpc({
      obs,
      overlay: null,
      config: CONFIG,
      logger: createSilentLogger(),
      ipcMain: ipc,
      getWindows: () => [window],
      secrets: {
        setSecret: () => {
          throw new Error('safeStorage is unavailable')
        }
      }
    })

    const handler = ipc.handlers.get(IpcChannel.obsSetConfig)
    expect(handler).toBeDefined()
    if (handler === undefined) return
    const result = (await handler(eventFrom(window), {
      url: 'ws://127.0.0.1:4455',
      password: 'hunter2'
    })) as Result<ObsStatus>

    expect(result.ok).toBe(true)
    expect(obs.connectCalls).toHaveLength(1)
  })

  it('fans OBS status and scene-list events out to every window', () => {
    const many = setup({ windows: 3 })
    const status = initialObsStatus('reconnecting', 4_000)

    many.obs.emitStatus(status)
    many.obs.emitSceneList(SCENE_LIST)

    for (const window of many.windows) {
      expect(window.sent).toEqual([
        { channel: IpcEvent.obsStatus, payload: status },
        { channel: IpcEvent.obsSceneList, payload: SCENE_LIST }
      ])
    }
  })

  it('skips destroyed windows when fanning out', () => {
    const many = setup({ windows: 2 })
    const dead = many.windows[1]
    expect(dead).toBeDefined()
    if (dead === undefined) return
    Object.assign(dead, { isDestroyed: () => true })

    many.obs.emitStatus(initialObsStatus('connected', 5_000))

    expect(many.windows[0]?.sent).toHaveLength(1)
    expect(dead.sent).toHaveLength(0)
  })

  it('rate-limits logWrite at ~100 records/second and then recovers', async () => {
    const record = { ts: 1, level: 'info' as const, scope: 'renderer:test', msg: 'hello' }

    for (let index = 0; index < 100; index += 1) {
      const result = (await harness.invoke(IpcChannel.logWrite, record)) as Result<void>
      expect(result.ok).toBe(true)
    }

    // The bucket is empty and the clock has not advanced.
    expect(expectErr(await harness.invoke(IpcChannel.logWrite, record)).code).toBe('RATE_LIMITED')

    // A quarter second later a quarter of the bucket is back.
    harness.setNow(10_250)
    const recovered = (await harness.invoke(IpcChannel.logWrite, record)) as Result<void>
    expect(recovered.ok).toBe(true)
  })

  it('validates the log record shape', async () => {
    expect(
      expectErr(await harness.invoke(IpcChannel.logWrite, { ts: 1, level: 'shout', scope: 'x' }))
        .code
    ).toBe('INVALID_ARG')
  })

  it('dispose removes every handler and unsubscribes from every subsystem', () => {
    expect(harness.ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)

    harness.dispose()

    expect(harness.ipc.handlers.size).toBe(0)
    expect([...harness.ipc.removeCalls].sort()).toEqual([...IPC_CHANNEL_VALUES].sort())
    expect(harness.obs.statusUnsubscribed()).toBe(1)
    expect(harness.obs.sceneListUnsubscribed()).toBe(1)
    expect(harness.overlay.stateUnsubscribed()).toBe(1)
    expect(harness.overlay.infoUnsubscribed()).toBe(1)
    // The camera subscription is disposed on exactly the same path — a listener left behind
    // here would keep pushing scene changes into a dead bridge for the rest of the process.
    expect(harness.camera.stateUnsubscribed()).toBe(1)
    // Same for YouTube. Its status subscription is the one most likely to be backed by a poll
    // timer, so a listener surviving dispose would keep pushing at a dead bridge — and would
    // keep talking to Google — for the rest of the process.
    expect(harness.youtube.statusUnsubscribed()).toBe(1)
    // And the go-live one. Its state subscription is backed by a health-poll loop that runs at
    // its fastest precisely while a service is on air, so a listener surviving dispose would keep
    // pushing at dead windows for the rest of the process.
    expect(harness.goLive.stateUnsubscribed()).toBe(1)
    // And both plan subscriptions. The import-progress one in particular is backed by a child
    // process that can outlive the window that started it, so a listener surviving dispose would
    // keep pushing conversion progress at a dead bridge for the rest of the process.
    expect(harness.plan.stateUnsubscribed()).toBe(1)
    expect(harness.plan.progressUnsubscribed()).toBe(1)
    // And both ASR subscriptions. The transcript feed is the highest-frequency push in the app —
    // partials arrive several times a second while anyone is speaking — so a listener surviving
    // dispose would hammer a dead bridge for the rest of the service.
    expect(harness.asr.statusUnsubscribed()).toBe(1)
    expect(harness.asr.transcriptUnsubscribed()).toBe(1)
    // And both cue-engine subscriptions. A suggestion feed surviving dispose would be the worst of
    // the lot: it would keep offering cues into a bridge nobody is holding, which is precisely the
    // "something automated happened that nobody asked for" failure this phase exists to prevent.
    expect(harness.cue.stateUnsubscribed()).toBe(1)
    expect(harness.cue.suggestionUnsubscribed()).toBe(1)
    // And the health snapshot feed. It is backed by a watchdog timer that keeps ticking for as
    // long as the process lives, so a listener surviving dispose would push subsystem snapshots at
    // dead windows for the rest of the service.
    expect(harness.health.snapshotUnsubscribed()).toBe(1)

    // Disposal unsubscribed and did nothing else. It did not end the broadcast, and it did not
    // stop the recording — a hot reload or a window close is not a reason to take a
    // congregation's service off the air.
    expect(harness.goLive.endArgs).toHaveLength(0)
    expect(harness.obs.disconnectCalls()).toBe(0)

    // Idempotent — a second dispose must not double-unsubscribe or re-remove.
    harness.dispose()
    expect(harness.ipc.removeCalls).toHaveLength(IPC_CHANNEL_VALUES.length)
    expect(harness.obs.statusUnsubscribed()).toBe(1)
    expect(harness.overlay.stateUnsubscribed()).toBe(1)
    expect(harness.camera.stateUnsubscribed()).toBe(1)
    expect(harness.youtube.statusUnsubscribed()).toBe(1)
    expect(harness.goLive.stateUnsubscribed()).toBe(1)
    expect(harness.plan.stateUnsubscribed()).toBe(1)
    expect(harness.plan.progressUnsubscribed()).toBe(1)
    expect(harness.asr.statusUnsubscribed()).toBe(1)
    expect(harness.asr.transcriptUnsubscribed()).toBe(1)
    expect(harness.cue.stateUnsubscribed()).toBe(1)
    expect(harness.cue.suggestionUnsubscribed()).toBe(1)
    expect(harness.health.snapshotUnsubscribed()).toBe(1)
  })

  it('stops fanning events out after dispose', () => {
    harness.dispose()
    harness.obs.emitStatus(initialObsStatus('connected', 6_000))
    harness.overlay.emitState(emptyOverlayState())
    harness.camera.emitState({
      currentProgramScene: 'Wide',
      activeSlot: 'wide',
      availableTransitions: AVAILABLE_TRANSITIONS
    })
    harness.youtube.emitStatus(SIGNED_IN_STATUS)
    harness.goLive.emitState(LIVE_GO_LIVE_STATE)
    harness.plan.emitState(PLAN_STATE)
    harness.plan.emitImportProgress({
      stage: 'done',
      slidesDone: 1,
      slidesTotal: 1,
      message: null
    })
    harness.asr.emitStatus(LISTENING_ASR_STATUS)
    harness.asr.emitTranscript(FINAL_SEGMENT)
    harness.cue.emitState(ASSISTING_CUE_STATE)
    harness.cue.emitSuggestion(PLAN_SUGGESTION)
    harness.health.emitSnapshot(reconnectingSnapshot())
    expect(harness.windows[0]?.sent).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Overlay (BLUEPRINT.md §6)
  // -------------------------------------------------------------------------

  describe('overlay channels', () => {
    it('returns the current snapshot from overlayGetState', async () => {
      const result = (await harness.invoke(IpcChannel.overlayGetState)) as Result<OverlayState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(emptyOverlayState())
    })

    it('applies a command and resolves with the resulting full snapshot', async () => {
      const result = (await harness.invoke(
        IpcChannel.overlaySend,
        SHOW_LOWER_THIRD
      )) as Result<OverlayState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.overlay.sent).toEqual([SHOW_LOWER_THIRD])
      // A whole state, not an acknowledgement: this is what makes a reloaded window recover.
      expect(result.value.lowerThird).toEqual({
        visible: true,
        line1: 'Pastor Kim',
        line2: 'Guest Speaker',
        template: 'bar'
      })
      expect(result.value.revision).toBe(1)
      // Layer independence — the other two layers are untouched.
      expect(result.value.scripture).toEqual(emptyOverlayState().scripture)
      expect(result.value.slide).toEqual(emptyOverlayState().slide)
    })

    it('fills in the defaulted command fields before the server sees them', async () => {
      // `line2` and `template` are optional on the wire and defaulted by the zod schema.
      const result = (await harness.invoke(IpcChannel.overlaySend, {
        channel: 'command',
        name: 'lowerThird.show',
        payload: { line1: 'Worship Team' }
      })) as Result<OverlayState>

      expect(result.ok).toBe(true)
      expect(harness.overlay.sent[0]).toEqual({
        channel: 'command',
        name: 'lowerThird.show',
        payload: { line1: 'Worship Team', line2: '', template: 'bar' }
      })
    })

    it('rejects a malformed command with Err(INVALID_ARG) and never reaches the server', async () => {
      // Unknown command name.
      expect(
        expectErr(
          await harness.invoke(IpcChannel.overlaySend, {
            channel: 'command',
            name: 'lowerThird.explode',
            payload: {}
          })
        ).code
      ).toBe('INVALID_ARG')

      // Right name, wrong payload — `reference` is required.
      expect(
        expectErr(
          await harness.invoke(IpcChannel.overlaySend, {
            channel: 'command',
            name: 'scripture.show',
            payload: { text: SCRIPTURE_TEXT_PLACEHOLDER }
          })
        ).code
      ).toBe('INVALID_ARG')

      // Not an object at all.
      expect(expectErr(await harness.invoke(IpcChannel.overlaySend, 'clearAll')).code).toBe(
        'INVALID_ARG'
      )
      // A no-argument overlay channel still refuses a payload.
      expect(expectErr(await harness.invoke(IpcChannel.overlayGetState, { evil: true })).code).toBe(
        'INVALID_ARG'
      )

      expect(harness.overlay.sent).toHaveLength(0)
      // And nothing moved: an unapplied command must leave the state byte-identical.
      const state = (await harness.invoke(IpcChannel.overlayGetState)) as Result<OverlayState>
      expect(state.ok).toBe(true)
      if (!state.ok) return
      expect(state.value.revision).toBe(0)
    })

    it('carries a scripture command through without this repo authoring the text', async () => {
      const result = (await harness.invoke(IpcChannel.overlaySend, {
        channel: 'command',
        name: 'scripture.show',
        payload: {
          reference: 'John 3:16',
          text: SCRIPTURE_TEXT_PLACEHOLDER,
          translation: 'TEST',
          attribution: null
        }
      })) as Result<OverlayState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.scripture.text).toBe(SCRIPTURE_TEXT_PLACEHOLDER)
      expect(result.value.lowerThird.visible).toBe(false)
    })

    it('reports the server info the overlay server hands back', async () => {
      const result = (await harness.invoke(
        IpcChannel.overlayGetServerInfo
      )) as Result<OverlayServerInfo>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toMatchObject({
        running: true,
        host: LOOPBACK_ADDRESS,
        port: OVERLAY_SERVER_PORT,
        pageUrl: overlayPageUrl()
      })
    })

    it('fans overlay state and server info out to every window', () => {
      const many = setup({ windows: 3 })
      const state = applyOverlayCommand(emptyOverlayState(), SHOW_LOWER_THIRD)
      const info = many.overlay.getInfo() as OverlayServerInfo

      many.overlay.emitState(state)
      many.overlay.emitInfo(info)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.overlayState, payload: state },
          { channel: IpcEvent.overlayServerInfo, payload: info }
        ])
      }
    })

    it('refuses a command while the overlay server is not listening', async () => {
      harness.overlay.running = false

      const error = expectErr(await harness.invoke(IpcChannel.overlaySend, SHOW_LOWER_THIRD))
      expect(error.code).toBe('NOT_CONNECTED')
      expect(harness.overlay.sent).toHaveLength(0)

      // Reading state still works — the snapshot is authoritative whether or not anything is
      // listening, and the panel needs it to render what *would* be on screen.
      const state = (await harness.invoke(IpcChannel.overlayGetState)) as Result<OverlayState>
      expect(state.ok).toBe(true)

      // And the info is a successful Result carrying `running: false`, not an Err.
      const info = (await harness.invoke(
        IpcChannel.overlayGetServerInfo
      )) as Result<OverlayServerInfo>
      expect(info.ok).toBe(true)
      if (!info.ok) return
      expect(info.value.running).toBe(false)
      expect(info.value.clients).toBe(0)
    })

    it('degrades to NOT_CONNECTED when there is no overlay server at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), undefined)
      }

      expect(expectErr(await call(IpcChannel.overlayGetState)).code).toBe('NOT_CONNECTED')

      const sendHandler = ipc.handlers.get(IpcChannel.overlaySend)
      expect(sendHandler).toBeDefined()
      if (sendHandler === undefined) return
      expect(expectErr(await sendHandler(eventFrom(window), SHOW_LOWER_THIRD)).code).toBe(
        'NOT_CONNECTED'
      )

      // Server info stays a success carrying `running: false` — the Overlay panel renders it.
      const info = (await call(IpcChannel.overlayGetServerInfo)) as Result<OverlayServerInfo>
      expect(info.ok).toBe(true)
      if (!info.ok) return
      expect(info.value).toMatchObject({
        running: false,
        clients: 0,
        host: LOOPBACK_ADDRESS,
        port: OVERLAY_SERVER_PORT,
        pageUrl: overlayPageUrl()
      })
      expect(info.value.lastError).not.toBeNull()
    })

    it('survives an overlay singleton that cannot be constructed', async () => {
      // `overlay` is omitted entirely, so `registerIpc` falls back to `getOverlayServer()` —
      // which the module mock at the top of this file makes throw.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.overlayGetState)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      expect(expectErr(await handler(eventFrom(window), undefined)).code).toBe('NOT_CONNECTED')

      expect(() => {
        dispose()
      }).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Camera (BLUEPRINT.md §6)
  // -------------------------------------------------------------------------

  describe('camera channels', () => {
    it('returns the binding set and the live state', async () => {
      const config = (await harness.invoke(IpcChannel.cameraGetConfig)) as Result<CameraConfig>
      expect(config.ok).toBe(true)
      if (!config.ok) return
      expect(config.value).toEqual(BOUND_CAMERA_CONFIG)

      const state = (await harness.invoke(IpcChannel.cameraGetState)) as Result<CameraState>
      expect(state.ok).toBe(true)
      if (!state.ok) return
      expect(state.value).toEqual({
        currentProgramScene: 'Cam 1',
        activeSlot: 'cam1',
        availableTransitions: AVAILABLE_TRANSITIONS
      })
    })

    it('switches the program camera and resolves with the new active slot', async () => {
      const result = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'wide'
      })) as Result<CameraState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.camera.selected).toEqual(['wide'])
      expect(result.value.currentProgramScene).toBe('Wide')
      expect(result.value.activeSlot).toBe('wide')
    })

    it('accepts every slot the contract defines', async () => {
      for (const slot of CAMERA_SLOTS) {
        const result = (await harness.invoke(IpcChannel.cameraSelect, { slot })) as Result<unknown>
        // `pulpit` is unbound in the fixture, so the *service* refuses it with NOT_FOUND — but
        // it got that far, which is the point: validation did not eat a legitimate slot.
        if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
      }
      expect(harness.camera.selected).toEqual([...CAMERA_SLOTS])
    })

    it('rejects an unknown slot with Err(INVALID_ARG) and never calls the service', async () => {
      const rejected: unknown[] = [
        { slot: 'cam5' },
        { slot: 'CAM1' },
        { slot: 3 },
        { slot: null },
        {},
        'cam1',
        undefined
      ]

      for (const arg of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.cameraSelect, arg)).code).toBe(
          'INVALID_ARG'
        )
      }

      // The load-bearing assertion. A slot that failed validation must never have reached the
      // service, because the next thing the service does is hand a scene name to OBS.
      expect(harness.camera.selected).toHaveLength(0)

      // And nothing moved: the program scene is still whatever it was.
      const state = (await harness.invoke(IpcChannel.cameraGetState)) as Result<CameraState>
      expect(state.ok).toBe(true)
      if (!state.ok) return
      expect(state.value.activeSlot).toBe('cam1')
    })

    it('rejects a malformed camera config with Err(INVALID_ARG) and never calls the service', async () => {
      const rejected: unknown[] = [
        // Not an object.
        'bindings',
        // `bindings` is not an array.
        { bindings: 'cam1' },
        // A binding missing every field but the slot.
        { bindings: [{ slot: 'cam1' }] },
        // An unknown slot inside an otherwise well-formed binding.
        {
          bindings: [
            {
              slot: 'cam9',
              label: 'CAM 9',
              sceneName: 'Nope',
              transition: null,
              transitionDurationMs: null
            }
          ]
        },
        // An empty label — `z.string().min(1)`; a blank button is unusable in a dark booth.
        {
          bindings: [
            {
              slot: 'cam1',
              label: '',
              sceneName: 'Cam 1',
              transition: null,
              transitionDurationMs: null
            }
          ]
        },
        // A negative transition duration.
        {
          bindings: [
            {
              slot: 'cam1',
              label: 'CAM 1',
              sceneName: 'Cam 1',
              transition: 'Fade',
              transitionDurationMs: -1
            }
          ]
        },
        // More bindings than there are slots.
        {
          bindings: [...BOUND_CAMERA_CONFIG.bindings, ...BOUND_CAMERA_CONFIG.bindings]
        }
      ]

      for (const arg of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.cameraSetConfig, arg)).code).toBe(
          'INVALID_ARG'
        )
      }

      expect(harness.camera.configWrites).toHaveLength(0)

      // The stored config is untouched — a rejected write must not half-apply.
      const config = (await harness.invoke(IpcChannel.cameraGetConfig)) as Result<CameraConfig>
      expect(config.ok).toBe(true)
      if (!config.ok) return
      expect(config.value).toEqual(BOUND_CAMERA_CONFIG)
    })

    it('stores a well-formed config', async () => {
      const next: CameraConfig = {
        bindings: [
          {
            slot: 'pulpit',
            label: 'PULPIT',
            sceneName: 'Pulpit Close',
            transition: 'Fade',
            transitionDurationMs: 250
          }
        ]
      }

      const result = (await harness.invoke(
        IpcChannel.cameraSetConfig,
        next
      )) as Result<CameraConfig>
      expect(result.ok).toBe(true)
      expect(harness.camera.configWrites).toEqual([next])
    })

    it('refuses a slot with no scene bound rather than firing at OBS', async () => {
      // `pulpit` is unmapped in the fixture. The button is disabled in the UI, but the channel
      // must also refuse it — a disabled button is not a security boundary.
      const error = expectErr(await harness.invoke(IpcChannel.cameraSelect, { slot: 'pulpit' }))
      expect(error.code).toBe('NOT_FOUND')

      const state = (await harness.invoke(IpcChannel.cameraGetState)) as Result<CameraState>
      expect(state.ok).toBe(true)
      if (!state.ok) return
      expect(state.value.currentProgramScene).toBe('Cam 1')
    })

    it('fans camera state out to every window', () => {
      const many = setup({ windows: 3 })
      const state: CameraState = {
        // Scene changed inside OBS to something Verger has no button for — `activeSlot` is
        // `null` and the live indicator must show that rather than a stale highlight.
        currentProgramScene: 'Slides',
        activeSlot: null,
        availableTransitions: AVAILABLE_TRANSITIONS
      }

      many.camera.emitState(state)

      for (const window of many.windows) {
        expect(window.sent).toEqual([{ channel: IpcEvent.cameraState, payload: state }])
      }
    })

    it('degrades to NOT_CONNECTED when there is no camera service at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      expect(expectErr(await call(IpcChannel.cameraGetConfig)).code).toBe('NOT_CONNECTED')
      expect(expectErr(await call(IpcChannel.cameraGetState)).code).toBe('NOT_CONNECTED')
      expect(expectErr(await call(IpcChannel.cameraSelect, { slot: 'cam1' })).code).toBe(
        'NOT_CONNECTED'
      )
      expect(expectErr(await call(IpcChannel.cameraSetConfig, BOUND_CAMERA_CONFIG)).code).toBe(
        'NOT_CONNECTED'
      )
    })

    it('survives a camera singleton that cannot be constructed', async () => {
      // `camera` is omitted entirely, so `registerIpc` falls back to `getCameraService()` —
      // which the module mock at the top of this file makes throw.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.cameraGetState)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      expect(expectErr(await handler(eventFrom(window), undefined)).code).toBe('NOT_CONNECTED')

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates a camera service whose subscription returns nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: CameraServiceLike = {
        getConfig: () => BOUND_CAMERA_CONFIG,
        setConfig: (config) => config,
        getState: () => ({
          currentProgramScene: null,
          activeSlot: null,
          availableTransitions: []
        }),
        select: () => ({
          currentProgramScene: 'Cam 1',
          activeSlot: 'cam1',
          availableTransitions: []
        }),
        onState: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // YouTube (BLUEPRINT.md §5, Part A)
  //
  // Every test here runs against the in-memory fake. Nothing constructs an OAuth client,
  // nothing imports `googleapis`, and nothing resolves a hostname — there are no Google
  // credentials on this machine and there never will be, so "works with a mocked client and
  // zero network" is the only definition of working available.
  // -------------------------------------------------------------------------

  describe('youtube channels', () => {
    it('returns the whole Go Live snapshot from youtubeGetStatus', async () => {
      const result = (await harness.invoke(IpcChannel.youtubeGetStatus)) as Result<YouTubeStatus>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(SIGNED_OUT_STATUS)
      // The CCLI streaming-licence gate rides along as a blocking pre-flight issue rather than
      // as something the renderer has to know to ask for separately.
      expect(result.value.preflight).toHaveLength(1)
      expect(result.value.preflight[0]?.severity).toBe('error')
    })

    it('signs in and out, resolving with a status and never with a credential', async () => {
      const signedIn = (await harness.invoke(IpcChannel.youtubeSignIn)) as Result<YouTubeStatus>
      expect(signedIn.ok).toBe(true)
      if (!signedIn.ok) return
      expect(harness.youtube.signInCalls()).toBe(1)
      expect(signedIn.value.auth.state).toBe('signed-in')
      expect(signedIn.value.auth.channel?.title).toBe('Test Church')

      const signedOut = (await harness.invoke(IpcChannel.youtubeSignOut)) as Result<YouTubeStatus>
      expect(signedOut.ok).toBe(true)
      if (!signedOut.ok) return
      expect(harness.youtube.signOutCalls()).toBe(1)
      expect(signedOut.value.auth.state).toBe('signed-out')
    })

    /**
     * The security assertion of this phase, made structurally rather than by eyeball.
     *
     * Two credentials must never cross this boundary: the OAuth refresh token (it lives in
     * `safeStorage`) and the RTMP stream key (it grants anyone the ability to broadcast to the
     * channel, and it lives in OBS's own settings). Rather than assert "the token is absent" —
     * which passes trivially for a payload that never had one — this walks every property name
     * in what actually crossed and refuses anything credential-shaped.
     */
    it('never carries a token or a stream key across any youtube channel', async () => {
      const responses: unknown[] = [
        await harness.invoke(IpcChannel.youtubeSignIn),
        await harness.invoke(IpcChannel.youtubeGetStatus),
        await harness.invoke(IpcChannel.youtubeSetTemplate, defaultBroadcastTemplate()),
        await harness.invoke(IpcChannel.youtubeCreateBroadcast, {}),
        await harness.invoke(IpcChannel.youtubeSignOut)
      ]

      for (const response of responses) {
        for (const name of collectKeys(response)) {
          expect(name).not.toMatch(CREDENTIAL_KEY_PATTERN)
        }
      }

      // The scan is not passing merely because the payloads were empty: the signed-in status
      // did carry the persistent stream, whose public ingest *address* came through intact.
      // What it has no field for — and therefore could not have carried — is the key.
      const signedIn = responses[0] as Result<YouTubeStatus>
      expect(signedIn.ok).toBe(true)
      if (!signedIn.ok) return
      expect(signedIn.value.stream?.ingestAddress).toBe('rtmp://a.rtmp.youtube.com/live2')
      expect(Object.keys(signedIn.value.stream ?? {})).toEqual([
        'id',
        'title',
        'ingestAddress',
        'health'
      ])
    })

    it('never carries a token or a stream key on the youtubeStatus event', () => {
      const many = setup({ windows: 2 })
      many.youtube.emitStatus(SIGNED_IN_STATUS)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.youtubeStatus, payload: SIGNED_IN_STATUS }
        ])
        const payload = window.sent[0]?.payload
        for (const name of collectKeys(payload)) {
          expect(name).not.toMatch(CREDENTIAL_KEY_PATTERN)
        }
      }
    })

    it('fans youtube status changes out to every window', async () => {
      const many = setup({ windows: 3 })

      // Not a synthetic emit: signing in is what actually moves the status, and the fan-out has
      // to follow it without the renderer asking.
      const result = (await (async (): Promise<unknown> => {
        const handler = many.ipc.handlers.get(IpcChannel.youtubeSignIn)
        if (handler === undefined) throw new Error('no youtubeSignIn handler')
        const first = many.windows[0]
        if (first === undefined) throw new Error('the harness needs a window')
        return handler(eventFrom(first), undefined)
      })()) as Result<YouTubeStatus>
      expect(result.ok).toBe(true)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.youtubeStatus, payload: SIGNED_IN_STATUS }
        ])
      }
    })

    it('stores a well-formed template and reports it back on the status', async () => {
      const template: BroadcastTemplate = {
        titleTemplate: 'Sunday Service — {date}',
        description: 'Live from the sanctuary.',
        privacy: 'unlisted',
        thumbnailPath: null,
        timeZone: 'Asia/Seoul'
      }

      const result = (await harness.invoke(
        IpcChannel.youtubeSetTemplate,
        template
      )) as Result<YouTubeStatus>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.youtube.templateWrites).toEqual([template])
      expect(result.value.template).toEqual(template)
    })

    it('rejects a malformed template with Err(INVALID_ARG) and never calls the service', async () => {
      const rejected: unknown[] = [
        // Not an object.
        'Sunday Service',
        undefined,
        // Empty title — a blank broadcast title is unusable and YouTube would refuse it anyway.
        { ...defaultBroadcastTemplate(), titleTemplate: '' },
        // Over the 100-character title bound.
        { ...defaultBroadcastTemplate(), titleTemplate: 'x'.repeat(101) },
        // A privacy value outside the contract's three.
        { ...defaultBroadcastTemplate(), privacy: 'semi-public' },
        // `thumbnailPath` must be a string or null, never a number.
        { ...defaultBroadcastTemplate(), thumbnailPath: 7 },
        // An empty time zone — `{date}` and the scheduled start are both resolved through it.
        { ...defaultBroadcastTemplate(), timeZone: '' },
        // Missing fields entirely.
        { titleTemplate: 'Sunday Service' }
      ]

      for (const arg of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.youtubeSetTemplate, arg)).code).toBe(
          'INVALID_ARG'
        )
      }

      // The load-bearing assertion: a template that failed validation must never have reached
      // the service, because the next thing the service does is send it to Google.
      expect(harness.youtube.templateWrites).toHaveLength(0)

      // And nothing moved — the stored template is still the default.
      const status = (await harness.invoke(IpcChannel.youtubeGetStatus)) as Result<YouTubeStatus>
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.value.template).toEqual(defaultBroadcastTemplate())
    })

    it('creates a broadcast, omitting an absent scheduledStartTime rather than sending undefined', async () => {
      const result = (await harness.invoke(
        IpcChannel.youtubeCreateBroadcast,
        {}
      )) as Result<Broadcast>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(CREATED_BROADCAST)
      // `exactOptionalPropertyTypes`: the key is omitted, not set to `undefined`.
      expect(harness.youtube.createCalls).toEqual([{}])
      expect(Object.hasOwn(harness.youtube.createCalls[0] ?? {}, 'scheduledStartTime')).toBe(false)

      // Part A stops at create-and-bind. The broadcast comes back `ready` with a bound stream,
      // never `live` — the transition is Phase 5's, and nothing on this channel can drive it.
      expect(result.value.lifecycle).toBe('ready')
      expect(result.value.boundStreamId).toBe('stream-persistent')
    })

    it('passes a supplied scheduledStartTime through', async () => {
      const result = (await harness.invoke(IpcChannel.youtubeCreateBroadcast, {
        scheduledStartTime: '2026-07-26T01:00:00.000Z'
      })) as Result<Broadcast>

      expect(result.ok).toBe(true)
      expect(harness.youtube.createCalls).toEqual([
        { scheduledStartTime: '2026-07-26T01:00:00.000Z' }
      ])
    })

    it('rejects a malformed create request with Err(INVALID_ARG) and never calls the service', async () => {
      const rejected: unknown[] = [
        'now',
        undefined,
        { scheduledStartTime: 1_700_000_000 },
        { scheduledStartTime: null },
        { scheduledStartTime: '' },
        { scheduledStartTime: 'x'.repeat(65) }
      ]

      for (const arg of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.youtubeCreateBroadcast, arg)).code).toBe(
          'INVALID_ARG'
        )
      }

      expect(harness.youtube.createCalls).toHaveLength(0)
    })

    it('refuses a payload on the three no-argument youtube channels', async () => {
      for (const channel of [
        IpcChannel.youtubeGetStatus,
        IpcChannel.youtubeSignIn,
        IpcChannel.youtubeSignOut
      ]) {
        expect(expectErr(await harness.invoke(channel, { evil: true })).code).toBe('INVALID_ARG')
      }
      expect(harness.youtube.signInCalls()).toBe(0)
      expect(harness.youtube.signOutCalls()).toBe(0)
    })

    /**
     * The empty-`.env` case, which is the state of every fresh checkout and of this build
     * machine. It must be a `Result` the renderer can render, not a rejection and not a crash.
     */
    it('degrades to NOT_CONFIGURED when there is no YouTube service at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      const settled = [
        await call(IpcChannel.youtubeGetStatus),
        await call(IpcChannel.youtubeSignIn),
        await call(IpcChannel.youtubeSignOut),
        await call(IpcChannel.youtubeSetTemplate, defaultBroadcastTemplate()),
        await call(IpcChannel.youtubeCreateBroadcast, {})
      ]

      for (const response of settled) {
        const error = expectErr(response)
        expect(error.code).toBe('NOT_CONFIGURED')
        // Renderable: the operator is told which two keys are missing, not shown a stack.
        expect(error.message).toContain('YouTube')
        expect(error.detail).toContain('GOOGLE_CLIENT_ID')
      }
    })

    it('survives a YouTube singleton that cannot be constructed', async () => {
      // `youtube` is omitted entirely, so `registerIpc` falls back to `getYouTubeService()` —
      // which the module mock at the top of this file makes throw. No OAuth client is ever
      // built, and no network call is ever attempted.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.youtubeGetStatus)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      expect(expectErr(await handler(eventFrom(window), undefined)).code).toBe('NOT_CONFIGURED')

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates a YouTube service whose subscription returns nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: YouTubeServiceLike = {
        getStatus: () => SIGNED_OUT_STATUS,
        signIn: () => SIGNED_OUT_STATUS,
        signOut: () => SIGNED_OUT_STATUS,
        setTemplate: () => SIGNED_OUT_STATUS,
        createBroadcast: () => CREATED_BROADCAST,
        onStatus: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('converts a throwing YouTube service into Err(INTERNAL) instead of rejecting', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const exploding: YouTubeServiceLike = {
        getStatus: () => {
          throw new Error('the OAuth client exploded')
        },
        signIn: () => SIGNED_OUT_STATUS,
        signOut: () => SIGNED_OUT_STATUS,
        setTemplate: () => SIGNED_OUT_STATUS,
        createBroadcast: () => CREATED_BROADCAST,
        onStatus: () => undefined
      }

      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: exploding,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.youtubeGetStatus)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      const settled = await Promise.resolve(handler(eventFrom(window), undefined))
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      expect(expectErr(settled.value).code).toBe('INTERNAL')
    })

    it('leaves the camera and overlay untouched', async () => {
      const shown = (await harness.invoke(
        IpcChannel.overlaySend,
        SHOW_LOWER_THIRD
      )) as Result<OverlayState>
      expect(shown.ok).toBe(true)

      const selected = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'cam2'
      })) as Result<CameraState>
      expect(selected.ok).toBe(true)

      expect((await harness.invoke(IpcChannel.youtubeSignIn) as Result<unknown>).ok).toBe(true)
      expect(
        ((await harness.invoke(IpcChannel.youtubeCreateBroadcast, {})) as Result<unknown>).ok
      ).toBe(true)

      // Creating a broadcast is the single most side-effect-heavy verb in Part A, and it still
      // did not send an overlay command or move a camera.
      expect(harness.overlay.sent).toEqual([SHOW_LOWER_THIRD])
      expect(harness.camera.selected).toEqual(['cam2'])
    })
  })

  // -------------------------------------------------------------------------
  // Go live (BLUEPRINT.md §5, Part B)
  //
  // Three channels, and between them they carry the three rules this phase exists to enforce:
  // local recording always runs, the app never wedges the broadcast, and a crashed-and-restarted
  // Verger re-attaches instead of starting a second stream. Every test here runs against the
  // in-memory fake — OBS Studio is not installed and there are no Google credentials, so "works
  // against injected mocks with zero network" is the only definition of working available.
  // -------------------------------------------------------------------------

  describe('go live channels', () => {
    it('returns the current snapshot from goLiveGetState', async () => {
      const result = (await harness.invoke(IpcChannel.goLiveGetState)) as Result<GoLiveState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(idleGoLiveState())
      expect(result.value.phase).toBe('idle')
      // Five steps, all pending — the panel renders the checklist before anything has run.
      expect(result.value.steps.map((step) => step.step)).toEqual([...GO_LIVE_STEPS])
    })

    /**
     * Standing Rule 3, asserted twice over.
     *
     * First on the way *in*: `startArgs` proves the IPC layer called `start()` with no arguments
     * at all, so there is no options object on this boundary that could ever have carried a
     * "skip the recording" flag — the rule is enforced by an absence, and the absence is
     * observable. Then on the way *out*: the resulting state has `recording: true` alongside
     * `streaming: true`, because a stream without its local backup is the failure this rule
     * exists to prevent. A service is un-repeatable.
     */
    it('goes live with the local recording running, and passes no options at all', async () => {
      const result = (await harness.invoke(IpcChannel.goLiveStart)) as Result<GoLiveState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.goLive.startArgs).toEqual([[]])
      expect(result.value.phase).toBe('live')
      expect(result.value.obs.streaming).toBe(true)
      expect(result.value.obs.recording).toBe(true)
      // And the operator is told where the backup is going — a recording nobody can find is not
      // a backup.
      expect(result.value.obs.recordingPath).not.toBeNull()
      expect(result.value.steps.every((step) => step.state === 'done')).toBe(true)
    })

    /**
     * `partial` is the most likely real failure and it must survive the boundary intact.
     *
     * OBS is streaming and recording; YouTube did not transition. Collapsing that into `live`
     * would tell the operator the congregation can see it when they cannot; collapsing it into
     * `failed` would tell them the recording is lost when it is not. The IPC layer does neither
     * — it carries the snapshot through untouched.
     */
    it('reports partial honestly rather than collapsing it into live or failed', async () => {
      harness.goLive.transitionFails = true

      const result = (await harness.invoke(IpcChannel.goLiveStart)) as Result<GoLiveState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(PARTIAL_GO_LIVE_STATE)
      expect(result.value.phase).toBe('partial')
      // The whole point: the outputs are still running.
      expect(result.value.obs.streaming).toBe(true)
      expect(result.value.obs.recording).toBe(true)
      expect(result.value.lastError).not.toBeNull()
      // And the failure names the step that broke rather than the whole sequence.
      const transition = result.value.steps.find((step) => step.step === 'transition')
      expect(transition?.state).toBe('failed')
      expect(result.value.steps.filter((step) => step.state === 'done')).toHaveLength(4)
    })

    /**
     * The app must never wedge the broadcast.
     *
     * A `start` that throws becomes `Err(INTERNAL)` — and nothing else happens. No `end` is
     * issued, no OBS disconnect is issued, and there is structurally no other verb this layer
     * could have reached for: `GoLiveServiceLike` has no `stopStream` and no `stopRecord`. OBS
     * keeps streaming and recording, the operator is told plainly, and they decide whether to
     * retry or drive OBS by hand.
     */
    it('converts a throwing go-live service into Err(INTERNAL) and stops nothing', async () => {
      harness.goLive.failStartWith = new Error('the OBS websocket dropped mid-sequence')

      const settled = await harness
        .invoke(IpcChannel.goLiveStart)
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      const error = expectErr(settled.value)
      expect(error.code).toBe('INTERNAL')
      expect(error.message).toBe('the OBS websocket dropped mid-sequence')

      // The load-bearing assertions: the failure cascaded nowhere.
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
      expect(harness.overlay.sent).toHaveLength(0)
      expect(harness.camera.selected).toHaveLength(0)
    })

    it('converts a throwing getState into Err(INTERNAL) instead of rejecting', async () => {
      harness.goLive.failGetStateWith = new Error('the state poller exploded')

      const settled = await harness
        .invoke(IpcChannel.goLiveGetState)
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      expect(expectErr(settled.value).code).toBe('INTERNAL')
    })

    it('ends only when asked, and resolves with the resulting state', async () => {
      const live = (await harness.invoke(IpcChannel.goLiveStart)) as Result<GoLiveState>
      expect(live.ok).toBe(true)

      const ended = (await harness.invoke(IpcChannel.goLiveEnd)) as Result<GoLiveState>
      expect(ended.ok).toBe(true)
      if (!ended.ok) return
      expect(harness.goLive.endArgs).toEqual([[]])
      expect(ended.value.phase).toBe('idle')
      expect(ended.value.obs.streaming).toBe(false)
      expect(ended.value.obs.recording).toBe(false)
    })

    /**
     * Crash re-attach (Standing Rule 2 — OBS owns that state).
     *
     * The service adopts an OBS that is already streaming and reports `reattached: true`. The IPC
     * layer's job is to carry that flag through, because the elapsed timer will not match when
     * the operator pressed the button and the UI has to say so.
     */
    it('carries a re-attached state through with its reattached flag intact', async () => {
      harness.goLive.current = REATTACHED_GO_LIVE_STATE

      const result = (await harness.invoke(IpcChannel.goLiveGetState)) as Result<GoLiveState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.reattached).toBe(true)
      expect(result.value.phase).toBe('live')
      expect(result.value.obs.streaming).toBe(true)
      expect(result.value.obs.recording).toBe(true)
    })

    it('fans go-live state out to every window', () => {
      const many = setup({ windows: 3 })

      many.goLive.emitState(PARTIAL_GO_LIVE_STATE)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.goLiveState, payload: PARTIAL_GO_LIVE_STATE }
        ])
      }
    })

    it('fans the state change a go-live start produces out to every window', async () => {
      const many = setup({ windows: 3 })

      // Not a synthetic emit: pressing GO LIVE is what actually moves the state, and every
      // window has to follow it without asking — including the ones that did not press it.
      const result = (await (async (): Promise<unknown> => {
        const handler = many.ipc.handlers.get(IpcChannel.goLiveStart)
        if (handler === undefined) throw new Error('no goLiveStart handler')
        const first = many.windows[0]
        if (first === undefined) throw new Error('the harness needs a window')
        return handler(eventFrom(first), undefined)
      })()) as Result<GoLiveState>
      expect(result.ok).toBe(true)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.goLiveState, payload: LIVE_GO_LIVE_STATE }
        ])
      }
    })

    it('refuses a payload on all three no-argument go-live channels', async () => {
      for (const channel of [
        IpcChannel.goLiveGetState,
        IpcChannel.goLiveStart,
        IpcChannel.goLiveEnd
      ]) {
        expect(expectErr(await harness.invoke(channel, { evil: true })).code).toBe('INVALID_ARG')
      }

      // The Standing Rule 3 assertion in its sharpest form: a renderer that tries to smuggle a
      // "no recording please" flag alongside GO LIVE is refused at the boundary, and the service
      // is never called at all.
      expect(expectErr(await harness.invoke(IpcChannel.goLiveStart, { record: false })).code).toBe(
        'INVALID_ARG'
      )
      expect(harness.goLive.startArgs).toHaveLength(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
    })

    it('rejects a go-live call whose sender is not one of our windows', async () => {
      const stranger = createFakeWindow('https://evil.example/')
      for (const channel of [IpcChannel.goLiveStart, IpcChannel.goLiveEnd]) {
        expect(
          expectErr(await harness.invoke(channel, undefined, eventFrom(stranger))).code
        ).toBe('INVALID_ARG')
      }
      expect(harness.goLive.startArgs).toHaveLength(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
    })

    /**
     * No orchestrator at all.
     *
     * `NOT_CONNECTED` with a detail that points the operator at OBS. Verger is a convenience over
     * OBS, never a dependency of it — an operator whose GO LIVE button just refused must not be
     * left believing the service cannot happen.
     */
    it('degrades to NOT_CONNECTED when there is no go-live service at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      for (const channel of [
        IpcChannel.goLiveGetState,
        IpcChannel.goLiveStart,
        IpcChannel.goLiveEnd
      ]) {
        const error = expectErr(await call(channel))
        expect(error.code).toBe('NOT_CONNECTED')
        expect(error.detail).toContain('OBS')
      }
    })

    it('survives a go-live singleton that cannot be constructed', async () => {
      // `goLive` is omitted entirely, so `registerIpc` falls back to `getGoLiveService()` —
      // which the module mock at the top of this file makes throw.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.goLiveStart)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      expect(expectErr(await handler(eventFrom(window), undefined)).code).toBe('NOT_CONNECTED')

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates a go-live service whose subscription returns nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: GoLiveServiceLike = {
        getState: () => idleGoLiveState(),
        start: () => LIVE_GO_LIVE_STATE,
        end: () => ENDED_GO_LIVE_STATE,
        onState: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    /**
     * The audit trail.
     *
     * GO LIVE and END are the two most consequential operations in the app: one puts a
     * congregation's service on the public internet, the other takes it off. When someone asks
     * afterwards "when did we go live, and did anybody press END?", the rolling log has to
     * answer — so both are logged at info level, with who asked and when, *before* the attempt.
     * Logging after the fact would lose the press if the sequence hung or the process died.
     */
    it('logs GO LIVE and END at info level with who asked and when', async () => {
      const lines: LogLine[] = []
      const ipc = createFakeIpcMain()
      const window = createFakeWindow('file:///app/out/renderer/index.html')
      const goLive = createFakeGoLiveService()
      const at = 1_764_000_000_000

      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive,
        config: CONFIG,
        logger: createRecordingLogger(lines),
        ipcMain: ipc,
        getWindows: () => [window],
        now: () => at
      })

      const call = async (channel: IpcChannelValue): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), undefined)
      }

      expect(((await call(IpcChannel.goLiveStart)) as Result<unknown>).ok).toBe(true)
      expect(((await call(IpcChannel.goLiveEnd)) as Result<unknown>).ok).toBe(true)

      const info = lines.filter((line) => line.level === 'info')
      const started = info.find((line) => line.msg === 'GO LIVE requested')
      const ended = info.find((line) => line.msg === 'END requested')

      expect(started).toBeDefined()
      expect(ended).toBeDefined()
      for (const line of [started, ended]) {
        expect(line?.data?.who).toBe('file:///app/out/renderer/index.html')
        expect(line?.data?.at).toBe(new Date(at).toISOString())
      }

      // The outcome is logged too, and it names the phase — `partial` in particular is the line
      // somebody will read a week later to find out why the stream was never public.
      const finished = info.find((line) => line.msg === 'GO LIVE finished')
      expect(finished?.data).toMatchObject({ phase: 'live', streaming: true, recording: true })

      // Nothing credential-shaped, and no payload, made it into any line.
      for (const line of lines) {
        for (const name of collectKeys(line.data)) {
          expect(name).not.toMatch(CREDENTIAL_KEY_PATTERN)
        }
      }
    })

    it('leaves the camera and the overlay untouched', async () => {
      const shown = (await harness.invoke(
        IpcChannel.overlaySend,
        SHOW_LOWER_THIRD
      )) as Result<OverlayState>
      expect(shown.ok).toBe(true)

      const selected = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'cam2'
      })) as Result<CameraState>
      expect(selected.ok).toBe(true)

      expect(((await harness.invoke(IpcChannel.goLiveStart)) as Result<unknown>).ok).toBe(true)
      expect(((await harness.invoke(IpcChannel.goLiveEnd)) as Result<unknown>).ok).toBe(true)

      // Going live and ending are the two most side-effect-heavy verbs in the app, and neither
      // manufactured an overlay command or moved a camera behind the operator's back.
      expect(harness.overlay.sent).toEqual([SHOW_LOWER_THIRD])
      expect(harness.camera.selected).toEqual(['cam2'])
    })
  })

  // -------------------------------------------------------------------------
  // Service plan (BLUEPRINT.md §7)
  //
  // The claim these tests defend is that the plan is a *manual* driver first: nine channels, of
  // which `advance`, `back` and `fireCue` are enough to run a whole service with no ASR, no cue
  // engine and no network. The rest defend the two trust boundaries this phase adds — a plan
  // arriving from the renderer, and a file path naming something on disk.
  // -------------------------------------------------------------------------

  describe('plan channels', () => {
    const PLAN_CHANNELS: readonly IpcChannelValue[] = [
      IpcChannel.planGet,
      IpcChannel.planSet,
      IpcChannel.planOpen,
      IpcChannel.planSave,
      IpcChannel.planImportDeck,
      IpcChannel.planFireCue,
      IpcChannel.planAdvance,
      IpcChannel.planBack,
      IpcChannel.planGetImporterStatus
    ]

    it('registers all nine plan channels', () => {
      // Named explicitly as well as covered by the registry sweep above, which passes vacuously
      // if a channel is ever dropped from `IpcChannel`.
      for (const channel of PLAN_CHANNELS) {
        expect(harness.ipc.handlers.has(channel)).toBe(true)
      }
    })

    it('returns the whole snapshot from planGet', async () => {
      const result = (await harness.invoke(IpcChannel.planGet)) as Result<PlanState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(PLAN_STATE)
    })

    it('drives a service manually with advance, back and fireCue', async () => {
      // The whole manual path, and note what none of these calls needed: a transcript, a cue
      // engine, a network, or an argument beyond a cue id.
      expect(((await harness.invoke(IpcChannel.planAdvance)) as Result<unknown>).ok).toBe(true)
      expect(((await harness.invoke(IpcChannel.planAdvance)) as Result<unknown>).ok).toBe(true)
      expect(((await harness.invoke(IpcChannel.planBack)) as Result<unknown>).ok).toBe(true)
      expect(
        (
          (await harness.invoke(IpcChannel.planFireCue, { cueId: 'cue-2' })) as Result<unknown>
        ).ok
      ).toBe(true)

      expect(harness.plan.advances()).toBe(2)
      expect(harness.plan.backs()).toBe(1)
      expect(harness.plan.fired).toEqual(['cue-2'])
    })

    it('refuses a payload on the three no-argument plan channels', async () => {
      for (const channel of [
        IpcChannel.planGet,
        IpcChannel.planAdvance,
        IpcChannel.planBack,
        IpcChannel.planGetImporterStatus
      ]) {
        expect(expectErr(await harness.invoke(channel, { evil: true })).code).toBe('INVALID_ARG')
      }
      expect(harness.plan.advances()).toBe(0)
      expect(harness.plan.backs()).toBe(0)
    })

    it('rejects a malformed cue id and never calls the service', async () => {
      for (const arg of [undefined, {}, { cueId: '' }, { cueId: 'x'.repeat(65) }, { cueId: 7 }]) {
        expect(expectErr(await harness.invoke(IpcChannel.planFireCue, arg)).code).toBe(
          'INVALID_ARG'
        )
      }
      expect(harness.plan.fired).toHaveLength(0)
    })

    it('stores a well-formed plan', async () => {
      const result = (await harness.invoke(
        IpcChannel.planSet,
        PLACEHOLDER_PLAN
      )) as Result<PlanState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.plan.setCalls).toHaveLength(1)
      expect(harness.plan.setCalls[0]).toEqual(PLACEHOLDER_PLAN)
      expect(result.value.plan).toEqual(PLACEHOLDER_PLAN)
    })

    /**
     * The required negative case: an invalid plan is refused at the boundary, and the service is
     * never told about it. A half-written plan must not be able to replace the good one the
     * operator is midway through using.
     */
    it('rejects an invalid plan with Err(INVALID_ARG) and never calls the service', async () => {
      const invalid: unknown[] = [
        // Not an object at all.
        'nope',
        undefined,
        // Wrong schema version — this is the field that lets a future format change be detected.
        { ...PLACEHOLDER_PLAN, schemaVersion: 2 },
        // An unknown cue type.
        {
          ...PLACEHOLDER_PLAN,
          cues: [
            {
              id: 'cue-x',
              type: 'launch-missiles',
              label: 'PLACEHOLDER',
              trigger: { mode: 'manual' },
              payload: {}
            }
          ]
        },
        // A payload that does not match its cue type: a slide cue with no asset.
        {
          ...PLACEHOLDER_PLAN,
          cues: [
            {
              id: 'cue-x',
              type: 'slide',
              label: 'SLIDE 1',
              trigger: { mode: 'manual' },
              payload: { reference: 'PLACEHOLDER 1:1' }
            }
          ]
        },
        // A non-manual trigger with nothing to match against — a cue that could never fire.
        {
          ...PLACEHOLDER_PLAN,
          cues: [
            {
              id: 'cue-x',
              type: 'action',
              label: 'PLACEHOLDER',
              trigger: { mode: 'anchor' },
              payload: { action: 'clearAll' }
            }
          ]
        },
        // An unknown service mode.
        { ...PLACEHOLDER_PLAN, defaultMode: 'autopilot' }
      ]

      for (const plan of invalid) {
        expect(expectErr(await harness.invoke(IpcChannel.planSet, plan)).code).toBe('INVALID_ARG')
      }

      expect(harness.plan.setCalls).toHaveLength(0)
    })

    /**
     * Standing Rule 4, enforced at the process boundary rather than trusted upstream.
     *
     * `cueSchema` validates the payload in a `superRefine`, and a refinement hands the *original*
     * object back — so a plain parse would let an extra `text` key ride along on a scripture cue
     * all the way into the saved plan file. `servicePlanArg` rebuilds each payload from its
     * type's own schema instead, and `ScripturePayload` has no third field to copy into.
     *
     * The fixture below is an obvious placeholder, never real verse text.
     */
    it('strips a smuggled text field off a scripture payload rather than persisting it', async () => {
      const smuggled = {
        ...PLACEHOLDER_PLAN,
        cues: [
          {
            id: 'cue-x',
            type: 'scripture',
            label: 'PLACEHOLDER READING',
            trigger: { mode: 'manual' },
            payload: {
              reference: 'PLACEHOLDER 1:1',
              translation: 'KJV',
              text: 'PLACEHOLDER TEXT THAT MUST NOT SURVIVE THE BOUNDARY'
            }
          }
        ]
      }

      const result = (await harness.invoke(IpcChannel.planSet, smuggled)) as Result<PlanState>
      expect(result.ok).toBe(true)

      const stored = harness.plan.setCalls[0]
      expect(stored).toBeDefined()
      if (stored === undefined) return
      const payload = stored.cues[0]?.payload as Record<string, unknown> | undefined
      expect(payload).toEqual({ reference: 'PLACEHOLDER 1:1', translation: 'KJV' })
      expect(payload && 'text' in payload).toBe(false)
      expect(JSON.stringify(stored)).not.toContain('MUST NOT SURVIVE')
    })

    it('drops payload keys no cue type declares, on every cue type', async () => {
      const noisy = {
        ...PLACEHOLDER_PLAN,
        cues: [
          {
            id: 'cue-slide',
            type: 'slide',
            label: 'SLIDE 1',
            trigger: { mode: 'manual' },
            payload: { asset: 'slides/slide-001.png', caption: 'PLACEHOLDER CAPTION' }
          },
          {
            id: 'cue-lower',
            type: 'lowerthird',
            label: 'PLACEHOLDER NAME',
            trigger: { mode: 'manual' },
            payload: { line1: 'PLACEHOLDER ONE', biography: 'PLACEHOLDER BIOGRAPHY' }
          }
        ]
      }

      expect(((await harness.invoke(IpcChannel.planSet, noisy)) as Result<unknown>).ok).toBe(true)
      const stored = harness.plan.setCalls[0]
      expect(stored).toBeDefined()
      if (stored === undefined) return
      expect(stored.cues[0]?.payload).toEqual({ asset: 'slides/slide-001.png' })
      expect(stored.cues[1]?.payload).toEqual({ line1: 'PLACEHOLDER ONE' })
    })

    // --- file dialogs ------------------------------------------------------

    it('opens a plan through the native dialog when no path is supplied', async () => {
      const result = (await harness.invoke(IpcChannel.planOpen, {})) as Result<PlanState>

      expect(result.ok).toBe(true)
      expect(harness.dialog.openCalls).toHaveLength(1)
      // Filtered to the plan extension, so the picker cannot be used as a general file browser.
      expect(harness.dialog.openCalls[0]?.filters).toEqual([
        { name: 'Service plan', extensions: ['json'] }
      ])
      expect(harness.plan.opened).toEqual([PLAN_PATH])
    })

    /**
     * The required cancellation case.
     *
     * An operator opens the picker and changes their mind several times a service. That resolves
     * with the unchanged state and `ok: true` — there is nothing here for the renderer to turn
     * into a red banner, and the service was never called.
     */
    it('treats a cancelled dialog as an ordinary unchanged state, not an error', async () => {
      harness.dialog.openResult = { canceled: true, filePaths: [] }
      harness.dialog.saveResult = { canceled: true }

      for (const channel of [
        IpcChannel.planOpen,
        IpcChannel.planSave,
        IpcChannel.planImportDeck
      ]) {
        const result = (await harness.invoke(channel, {})) as Result<PlanState>
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value).toEqual(PLAN_STATE)
      }

      expect(harness.plan.opened).toHaveLength(0)
      expect(harness.plan.saved).toHaveLength(0)
      expect(harness.plan.imported).toHaveLength(0)
    })

    it('treats an empty dialog answer as a cancellation rather than a path', async () => {
      // Some platforms report a cancelled save as `canceled: false` with an empty path.
      harness.dialog.openResult = { canceled: false, filePaths: [] }
      harness.dialog.saveResult = { canceled: false, filePath: '' }

      expect(((await harness.invoke(IpcChannel.planOpen, {})) as Result<unknown>).ok).toBe(true)
      expect(((await harness.invoke(IpcChannel.planSave, {})) as Result<unknown>).ok).toBe(true)
      expect(harness.plan.opened).toHaveLength(0)
      expect(harness.plan.saved).toHaveLength(0)
    })

    it('appends the plan extension when the save dialog returns a bare name', async () => {
      const bare = absolutePath('plans', 'fresh')
      harness.dialog.saveResult = { canceled: false, filePath: bare }

      const result = (await harness.invoke(IpcChannel.planSave, {})) as Result<PlanState>
      expect(result.ok).toBe(true)
      expect(harness.plan.saved).toEqual([absolutePath('plans', 'fresh.json')])
    })

    it('filters the deck dialog to .pptx', async () => {
      harness.dialog.openResult = { canceled: false, filePaths: [DECK_PATH] }

      const result = (await harness.invoke(IpcChannel.planImportDeck, {})) as Result<PlanState>
      expect(result.ok).toBe(true)
      expect(harness.dialog.openCalls[0]?.filters).toEqual([
        { name: 'PowerPoint deck', extensions: ['pptx'] }
      ])
      expect(harness.plan.imported).toEqual([DECK_PATH])
    })

    it('reports NOT_CONFIGURED rather than hanging when there is no dialog at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const plan = createFakePlanService()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan,
        dialog: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.planOpen)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      const error = expectErr(await handler(eventFrom(window), {}))
      expect(error.code).toBe('NOT_CONFIGURED')
      expect(plan.opened).toHaveLength(0)
    })

    // --- untrusted paths ---------------------------------------------------

    /**
     * A path supplied by the renderer is a request, not an instruction.
     *
     * The renderer is the less-trusted side of this boundary and these three channels name files
     * on disk — a `.pptx` in particular is an arbitrary archive a stranger may have produced. A
     * supplied path is accepted only if it is absolute, carries the expected extension and (for a
     * read) really is a file; nothing else reaches the service.
     */
    it('refuses a renderer-supplied path that is not an absolute file of the right kind', async () => {
      const cases: ReadonlyArray<{ path: string; code: string }> = [
        // Relative, and the classic traversal shape with it.
        { path: 'sunday.json', code: 'INVALID_ARG' },
        { path: '../../secrets/sunday.json', code: 'INVALID_ARG' },
        // Absolute, but the wrong kind of file entirely.
        { path: absolutePath('etc', 'passwd'), code: 'INVALID_ARG' },
        { path: absolutePath('plans', 'sunday.exe'), code: 'INVALID_ARG' },
        // A NUL truncates the path inside libuv, so what gets opened is not what was checked.
        { path: `${PLAN_PATH} .png`, code: 'INVALID_ARG' },
        // Right shape, but there is nothing there.
        { path: absolutePath('plans', 'missing.json'), code: 'NOT_FOUND' }
      ]

      for (const { path, code } of cases) {
        const error = expectErr(await harness.invoke(IpcChannel.planOpen, { path }))
        expect(error.code).toBe(code)
        // The rejected path is never echoed back — paths routinely carry a person's name.
        expect(JSON.stringify(error)).not.toContain('passwd')
      }

      expect(harness.plan.opened).toHaveLength(0)
      // And no dialog was opened either: a supplied path is answered on its own merits.
      expect(harness.dialog.openCalls).toHaveLength(0)
    })

    it('accepts a supplied path that checks out, and normalises it', async () => {
      const result = (await harness.invoke(IpcChannel.planOpen, {
        path: absolutePath('plans', 'unused', '..', 'sunday.json')
      })) as Result<PlanState>

      expect(result.ok).toBe(true)
      expect(harness.plan.opened).toEqual([PLAN_PATH])
      expect(harness.dialog.openCalls).toHaveLength(0)
    })

    it('will not import a plan file as a deck, nor open a deck as a plan', async () => {
      expect(
        expectErr(await harness.invoke(IpcChannel.planImportDeck, { path: PLAN_PATH })).code
      ).toBe('INVALID_ARG')
      expect(
        expectErr(await harness.invoke(IpcChannel.planOpen, { path: DECK_PATH })).code
      ).toBe('INVALID_ARG')

      expect(harness.plan.imported).toHaveLength(0)
      expect(harness.plan.opened).toHaveLength(0)
    })

    it('lets a save name a file that does not exist yet, but not a directory', async () => {
      const fresh = absolutePath('plans', 'next-sunday.json')
      const saved = (await harness.invoke(IpcChannel.planSave, { path: fresh })) as Result<
        PlanState
      >
      expect(saved.ok).toBe(true)
      expect(harness.plan.saved).toEqual([fresh])

      const directory = absolutePath('plans', 'archive.json')
      harness.filePaths.entries.set(directory, 'directory')
      expect(expectErr(await harness.invoke(IpcChannel.planSave, { path: directory })).code).toBe(
        'INVALID_ARG'
      )
      expect(harness.plan.saved).toHaveLength(1)
    })

    it('rejects a malformed path envelope', async () => {
      for (const arg of ['nope', { path: 7 }, { path: '' }, { path: 'x'.repeat(1025) }]) {
        expect(expectErr(await harness.invoke(IpcChannel.planOpen, arg)).code).toBe('INVALID_ARG')
      }
      expect(harness.plan.opened).toHaveLength(0)
    })

    // --- fan-out -----------------------------------------------------------

    it('fans plan state and import progress out to every window', () => {
      const many = setup({ windows: 3 })
      const advanced: PlanState = {
        ...PLAN_STATE,
        position: { index: 0, firedCueIds: ['cue-1'] },
        dirty: true
      }
      const progress: DeckImportProgress = {
        stage: 'converting',
        slidesDone: 3,
        slidesTotal: 12,
        message: null
      }

      many.plan.emitState(advanced)
      many.plan.emitImportProgress(progress)

      for (const window of many.windows) {
        expect(window.sent).toEqual([
          { channel: IpcEvent.planState, payload: advanced },
          { channel: IpcEvent.planImportProgress, payload: progress }
        ])
      }
    })

    it('never carries slide or verse text on the progress feed', () => {
      const many = setup({ windows: 1 })
      many.plan.emitImportProgress({
        stage: 'writing',
        slidesDone: 1,
        slidesTotal: 2,
        message: 'writing slide 1 of 2'
      })

      // Structural, not by inspection: the payload's whole key set is the four `DeckImportProgress`
      // fields, so there is nowhere for slide content to be hiding.
      const pushed = many.windows[0]?.sent[0]?.payload
      expect(collectKeys(pushed).sort()).toEqual([
        'message',
        'slidesDone',
        'slidesTotal',
        'stage'
      ])
    })

    // --- degradation (Standing Rule 5) -------------------------------------

    it('reports an unavailable importer as ordinary information, not a failure', async () => {
      // LibreOffice is not installed on this machine and cannot be. The panel's job is to render
      // this struct and disable the button, so an absent converter is an `Ok`.
      const result = (await harness.invoke(
        IpcChannel.planGetImporterStatus
      )) as Result<DeckImporterStatus>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.available).toBe(false)
      expect(result.value.detail).toContain('LibreOffice')
    })

    it('degrades to NOT_CONNECTED when there is no plan service at all', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      const args: Partial<Record<IpcChannelValue, unknown>> = {
        [IpcChannel.planSet]: PLACEHOLDER_PLAN,
        [IpcChannel.planOpen]: {},
        [IpcChannel.planSave]: {},
        [IpcChannel.planImportDeck]: {},
        [IpcChannel.planFireCue]: { cueId: 'cue-1' }
      }

      for (const channel of PLAN_CHANNELS) {
        const error = expectErr(await call(channel, args[channel]))
        expect(error.code).toBe('NOT_CONNECTED')
        // The operator is told, in the same breath, that the rest of the app still works.
        expect(error.detail).toContain('OBS')
      }
    })

    it('survives a plan singleton that cannot be constructed', async () => {
      // `plan` is omitted entirely, so `registerIpc` falls back to `getPlanService()` — which the
      // module mock at the top of this file makes throw.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.planAdvance)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      expect(expectErr(await handler(eventFrom(window), undefined)).code).toBe('NOT_CONNECTED')

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates a plan service whose subscriptions return nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: PlanServiceLike = {
        getState: () => PLAN_STATE,
        setPlan: () => PLAN_STATE,
        open: () => PLAN_STATE,
        save: () => PLAN_STATE,
        importDeck: () => PLAN_STATE,
        fireCue: () => PLAN_STATE,
        advance: () => PLAN_STATE,
        back: () => PLAN_STATE,
        getImporterStatus: () => NO_IMPORTER,
        onState: () => undefined,
        onImportProgress: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('converts a throwing plan service into Err(INTERNAL) instead of rejecting', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const plan = createFakePlanService()
      Object.assign(plan, {
        advance: () => {
          throw new Error('the plan service exploded')
        }
      })

      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.planAdvance)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      const settled = await Promise.resolve(handler(eventFrom(window), undefined))
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      expect(expectErr(settled.value).code).toBe('INTERNAL')
    })

    it('leaves the camera and the overlay untouched', async () => {
      expect(((await harness.invoke(IpcChannel.planAdvance)) as Result<unknown>).ok).toBe(true)
      expect(
        ((await harness.invoke(IpcChannel.planFireCue, { cueId: 'cue-1' })) as Result<unknown>).ok
      ).toBe(true)

      // Driving the plan through this boundary manufactured no overlay command and moved no
      // camera. Whatever a *cue* does when it fires is the plan service's business, reached
      // through its own seams — this layer stays out of it.
      expect(harness.overlay.sent).toHaveLength(0)
      expect(harness.camera.selected).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // ASR (BLUEPRINT.md §4 and §8)
  //
  // Every byte of audio in this block is synthesised arithmetically and every word of transcript
  // is invented placeholder wording. Standing Rule 4 forbids committing audio fixtures or
  // transcripts of copyrighted material, and none of these tests needs any: what is being proven
  // is that the boundary forwards, bounds and refuses correctly, not that a recogniser works.
  // -------------------------------------------------------------------------

  describe('asr channels', () => {
    it('returns the recogniser status snapshot', async () => {
      const result = (await harness.invoke(IpcChannel.asrGetStatus)) as Result<AsrStatus>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(LISTENING_ASR_STATUS)
    })

    it('returns and replaces settings', async () => {
      const initial = (await harness.invoke(IpcChannel.asrGetSettings)) as Result<AsrSettings>
      expect(initial.ok).toBe(true)
      if (!initial.ok) return
      expect(initial.value).toEqual(ASR_SETTINGS)

      const next: AsrSettings = { ...ASR_SETTINGS, mode: 'local', language: 'en' }
      const saved = (await harness.invoke(IpcChannel.asrSetSettings, next)) as Result<AsrSettings>
      expect(saved.ok).toBe(true)
      expect(harness.asr.settingsWrites).toEqual([next])
    })

    /**
     * Invalid settings are refused *and the service is never called*.
     *
     * The second half is the half that matters. A half-typed vocabulary list arriving mid-service
     * must not be able to replace a working configuration, so the assertion is on
     * `settingsWrites` staying empty rather than only on the returned code.
     */
    it('rejects invalid settings with Err(INVALID_ARG) and never calls the service', async () => {
      const rejected: unknown[] = [
        { ...ASR_SETTINGS, mode: 'psychic' },
        { ...ASR_SETTINGS, language: 'fr' },
        { ...ASR_SETTINGS, localModel: '' },
        { ...ASR_SETTINGS, deviceId: 17 },
        // 501 terms — one past the schema's bound. Keyword-boost lists are forwarded verbatim to
        // the provider, so an unbounded one is a cost and a latency problem during a service.
        { ...ASR_SETTINGS, customVocabulary: Array.from({ length: 501 }, (_, i) => `term-${i}`) },
        'nope',
        undefined
      ]

      for (const payload of rejected) {
        const error = expectErr(await harness.invoke(IpcChannel.asrSetSettings, payload))
        expect(error.code).toBe('INVALID_ARG')
      }

      expect(harness.asr.settingsWrites).toHaveLength(0)
    })

    /**
     * A custom-vocabulary list is the most personal payload on this boundary — it is where the
     * pastor's name and the church's name live — so a validation failure must not echo it back.
     */
    it('never echoes a rejected vocabulary term in the error detail', async () => {
      const error = expectErr(
        await harness.invoke(IpcChannel.asrSetSettings, {
          ...ASR_SETTINGS,
          customVocabulary: [`SENSITIVE-${'x'.repeat(80)}`]
        })
      )
      expect(error.code).toBe('INVALID_ARG')
      expect(JSON.stringify(error)).not.toContain('SENSITIVE')
    })

    it('starts and stops the recogniser', async () => {
      const started = (await harness.invoke(IpcChannel.asrStart)) as Result<AsrStatus>
      expect(started.ok).toBe(true)
      if (!started.ok) return
      expect(started.value.state).toBe('listening')
      expect(harness.asr.startCalls()).toBe(1)

      const stopped = (await harness.invoke(IpcChannel.asrStop)) as Result<AsrStatus>
      expect(stopped.ok).toBe(true)
      if (!stopped.ok) return
      expect(stopped.value.state).toBe('idle')
      expect(harness.asr.stopCalls()).toBe(1)

      // Turning the ears off touched nothing else. It is not allowed to.
      expect(harness.obs.disconnectCalls()).toBe(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
    })

    it('forwards a normal 100 ms PCM chunk straight to the service', async () => {
      const tone = pcmSineTone(ASR_CHUNK_MS)
      expect(tone.byteLength).toBe(ASR_CHUNK_MS * PCM_BYTES_PER_MS)

      const result = (await harness.invoke(IpcChannel.asrPushAudio, tone)) as Result<void>
      expect(result.ok).toBe(true)

      expect(harness.asr.chunks).toHaveLength(1)
      const forwarded = harness.asr.chunks[0]
      // A *view over the same buffer*, not a copy: a bare `ArrayBuffer` is wrapped and handed
      // straight over. Anything this path does per call, it does ten times a second for an hour.
      expect(forwarded?.buffer).toBe(tone)
      expect(forwarded?.byteLength).toBe(tone.byteLength)
      expect(forwarded).toEqual(new Uint8Array(tone))
    })

    /**
     * A `Uint8Array`/`Buffer` is accepted, and only *its own region* is forwarded.
     *
     * `Buffer.from(...)` is routinely a window onto a much larger shared pool; passing the whole
     * backing store on would hand the recogniser bytes belonging to something else entirely.
     */
    it('accepts a typed-array view and copies out only its own region', async () => {
      const pool = new Uint8Array(pcmSilence(1_000))
      pool.fill(7)
      const view = pool.subarray(64, 64 + ASR_CHUNK_MS * PCM_BYTES_PER_MS)

      const result = (await harness.invoke(IpcChannel.asrPushAudio, view)) as Result<void>
      expect(result.ok).toBe(true)

      const forwarded = harness.asr.chunks[0]
      expect(forwarded?.byteLength).toBe(ASR_CHUNK_MS * PCM_BYTES_PER_MS)
      // The forwarded chunk sits on a buffer of exactly its own size — the 32 KB pool did not
      // travel with it, and the recogniser cannot reach back into bytes that were never its own.
      expect(forwarded?.buffer).not.toBe(pool.buffer)
      expect(forwarded?.buffer.byteLength).toBe(ASR_CHUNK_MS * PCM_BYTES_PER_MS)
      expect(forwarded?.byteOffset).toBe(0)
    })

    /**
     * An oversized chunk is refused and never reaches the service.
     *
     * The bound is two seconds of PCM — twenty normal chunks — which leaves room for a capture
     * loop that batches after a GC pause while refusing to let a renderer bug hand the main
     * process an arbitrarily large buffer to hold onto during a service.
     */
    it('rejects an oversized audio chunk without calling the service', async () => {
      const huge = pcmSilence(2_100)
      expect(huge.byteLength).toBeGreaterThan(2_000 * PCM_BYTES_PER_MS)

      const error = expectErr(await harness.invoke(IpcChannel.asrPushAudio, huge))
      expect(error.code).toBe('INVALID_ARG')
      expect(harness.asr.chunks).toHaveLength(0)
    })

    it('rejects an audio chunk that is not a binary buffer, and an empty one', async () => {
      for (const payload of [undefined, null, 'audio', 42, { data: [1, 2, 3] }, [1, 2, 3]]) {
        expect(expectErr(await harness.invoke(IpcChannel.asrPushAudio, payload)).code).toBe(
          'INVALID_ARG'
        )
      }
      expect(expectErr(await harness.invoke(IpcChannel.asrPushAudio, new ArrayBuffer(0))).code).toBe(
        'INVALID_ARG'
      )
      expect(harness.asr.chunks).toHaveLength(0)
    })

    it('refuses audio from a window this process did not create', async () => {
      const stranger = createFakeWindow('https://evil.example/')
      const error = expectErr(
        await harness.invoke(
          IpcChannel.asrPushAudio,
          pcmSilence(ASR_CHUNK_MS),
          eventFrom(stranger)
        )
      )
      expect(error.code).toBe('INVALID_ARG')
      expect(harness.asr.chunks).toHaveLength(0)
    })

    /**
     * The hot path writes nothing to the log.
     *
     * `asrPushAudio` fires every `ASR_CHUNK_MS` — ten times a second, ~36,000 times in an hour —
     * on the process that owns the OBS websocket and the rolling log file. A single `log.debug`
     * per call would be 36,000 lines a service for no diagnostic value, so this test pins the
     * absence: fifty accepted chunks must produce exactly zero log lines.
     */
    it('does not log per accepted audio chunk', async () => {
      const lines: LogLine[] = []
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const asr = createFakeAsrService()

      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr,
        config: CONFIG,
        logger: createRecordingLogger(lines),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.asrPushAudio)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      // Registration itself logs a summary line; only what happens afterwards is under test.
      const before = lines.length

      for (let index = 0; index < 50; index += 1) {
        const result = (await handler(
          eventFrom(window),
          pcmSilence(ASR_CHUNK_MS)
        )) as Result<void>
        expect(result.ok).toBe(true)
      }

      expect(asr.chunks).toHaveLength(50)
      expect(lines).toHaveLength(before)

      // And a *rejected* chunk is still logged, exactly like every other rejected payload — the
      // silence above is about volume, not about hiding a renderer that is sending nonsense.
      expect(expectErr(await handler(eventFrom(window), 'not audio')).code).toBe('INVALID_ARG')
      expect(lines.length).toBeGreaterThan(before)
    })

    /**
     * Audio is not subject to the `logWrite` token bucket.
     *
     * That limiter sheds excess at 100 records/second and answers `RATE_LIMITED`. Applying it to
     * audio would punch silent holes in the transcript that the operator could not see or explain,
     * so 200 chunks — twice the bucket's capacity, more than a service ever sends in two seconds —
     * all arrive.
     */
    it('does not rate-limit audio chunks', async () => {
      for (let index = 0; index < 200; index += 1) {
        const result = (await harness.invoke(
          IpcChannel.asrPushAudio,
          pcmSilence(ASR_CHUNK_MS)
        )) as Result<void>
        expect(result.ok).toBe(true)
      }
      expect(harness.asr.chunks).toHaveLength(200)
    })

    it('forwards the enumerated input devices and bounds the list', async () => {
      const accepted = (await harness.invoke(
        IpcChannel.asrListDevices,
        AUDIO_DEVICES
      )) as Result<void>
      expect(accepted.ok).toBe(true)
      expect(harness.asr.deviceReports).toEqual([AUDIO_DEVICES])

      for (const payload of [
        'nope',
        [{ deviceId: '', label: 'empty id' }],
        [{ deviceId: 'mic-1' }],
        [{ deviceId: 'mic-1', label: 'x'.repeat(301) }],
        Array.from({ length: 65 }, (_, i) => ({ deviceId: `mic-${i}`, label: `Mic ${i}` }))
      ]) {
        expect(expectErr(await harness.invoke(IpcChannel.asrListDevices, payload)).code).toBe(
          'INVALID_ARG'
        )
      }
      expect(harness.asr.deviceReports).toHaveLength(1)
    })

    /**
     * Transcript segments fan out to every open window, unaltered.
     *
     * The draft and the final share one `id` and arrive in that order — that is the whole
     * draft/final contract, and this boundary neither collapses them, reorders them nor drops the
     * `isDraft` flag. A consumer that appended instead of replacing by `id` would render the same
     * span twice; the flags it needs to avoid that must survive the trip.
     */
    it('fans transcript segments out to every window with the draft/final flags intact', () => {
      const two = setup({ windows: 2 })

      two.asr.emitTranscript(DRAFT_SEGMENT)
      two.asr.emitTranscript(FINAL_SEGMENT)

      for (const window of two.windows) {
        const pushed = window.sent.filter((entry) => entry.channel === IpcEvent.asrTranscript)
        expect(pushed.map((entry) => entry.payload)).toEqual([DRAFT_SEGMENT, FINAL_SEGMENT])
      }

      const first = two.windows[0]?.sent.find(
        (entry) => entry.channel === IpcEvent.asrTranscript
      )?.payload as TranscriptSegment | undefined
      expect(first?.id).toBe(FINAL_SEGMENT.id)
      expect(first?.isFinal).toBe(false)
      expect(first?.isDraft).toBe(true)

      two.dispose()
    })

    /**
     * `degraded` and `failed` reach the renderer as themselves.
     *
     * They are different facts. `degraded` means a transcript is still arriving, but from the
     * fallback provider — the operator should know their cloud died even though the words keep
     * coming. `failed` means nothing is arriving at all. Collapsing them into one "bad" state
     * would hide a fallback, so this test pins that the boundary flattens neither, and that the
     * `provider` field says which engine is actually producing the text.
     */
    it('fans status changes out and keeps degraded distinct from failed', () => {
      harness.asr.emitStatus(DEGRADED_ASR_STATUS)
      harness.asr.emitStatus(FAILED_ASR_STATUS)

      const pushed = (harness.windows[0]?.sent ?? []).filter(
        (entry) => entry.channel === IpcEvent.asrStatus
      )
      expect(pushed.map((entry) => entry.payload)).toEqual([
        DEGRADED_ASR_STATUS,
        FAILED_ASR_STATUS
      ])

      const degraded = pushed[0]?.payload as AsrStatus | undefined
      expect(degraded?.state).toBe('degraded')
      // Still producing a transcript, just not from the preferred engine.
      expect(degraded?.provider).toBe('whisper')

      const failed = pushed[1]?.payload as AsrStatus | undefined
      expect(failed?.state).toBe('failed')
      expect(failed?.provider).toBeNull()
    })

    /**
     * No ASR service at all — the ordinary state of a fresh checkout, and of this build machine.
     *
     * `asrGetStatus` still resolves `ok` with a renderable `not-configured` status, because the
     * transcript panel's job is to draw that struct in red rather than to special-case a failure.
     * The other six answer `NOT_CONFIGURED` with a detail that says the service runs manually.
     * Nothing throws, nothing hangs, and nothing else in the app is affected.
     */
    it('degrades to a renderable not-configured status when there is no service', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      const status = (await call(IpcChannel.asrGetStatus)) as Result<AsrStatus>
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.value.state).toBe('not-configured')
      expect(status.value.provider).toBeNull()
      expect(status.value.lastError).not.toBeNull()

      for (const [channel, arg] of [
        [IpcChannel.asrGetSettings, undefined],
        [IpcChannel.asrSetSettings, ASR_SETTINGS],
        [IpcChannel.asrStart, undefined],
        [IpcChannel.asrStop, undefined],
        [IpcChannel.asrPushAudio, pcmSilence(ASR_CHUNK_MS)],
        [IpcChannel.asrListDevices, AUDIO_DEVICES]
      ] as Array<[IpcChannelValue, unknown]>) {
        expect(expectErr(await call(channel, arg)).code).toBe('NOT_CONFIGURED')
      }

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates an ASR service whose subscriptions return nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: AsrServiceLike = {
        getStatus: () => idleAsrStatus(),
        getSettings: () => ASR_SETTINGS,
        setSettings: (settings) => settings,
        start: () => idleAsrStatus(),
        stop: () => idleAsrStatus(),
        pushAudio: () => undefined,
        listDevices: () => undefined,
        onStatus: () => undefined,
        onTranscript: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('converts a throwing ASR service into Err(INTERNAL) instead of rejecting', async () => {
      const asr = createFakeAsrService()
      Object.assign(asr, {
        start: () => {
          throw new Error('the recogniser exploded')
        }
      })

      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.asrStart)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      const settled = await Promise.resolve(handler(eventFrom(window), undefined))
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      expect(expectErr(settled.value).code).toBe('INTERNAL')
    })

    /**
     * Standing Rule 1, at the boundary: the ears cannot touch anything else.
     *
     * Driving the whole ASR surface — start, a second of audio, a settings change, stop — fires no
     * overlay command, moves no camera and does not advance the plan. Whatever a *cue* does when
     * the Phase 8 engine decides to fire one is reached through the plan's own seam; this layer
     * stays out of it, which is what lets a dead recogniser cost the operator nothing.
     */
    it('leaves the plan, the camera and the overlay untouched', async () => {
      expect(((await harness.invoke(IpcChannel.asrStart)) as Result<unknown>).ok).toBe(true)
      for (let index = 0; index < 10; index += 1) {
        await harness.invoke(IpcChannel.asrPushAudio, pcmSineTone(ASR_CHUNK_MS))
      }
      await harness.invoke(IpcChannel.asrSetSettings, { ...ASR_SETTINGS, mode: 'local' })
      expect(((await harness.invoke(IpcChannel.asrStop)) as Result<unknown>).ok).toBe(true)

      expect(harness.overlay.sent).toHaveLength(0)
      expect(harness.camera.selected).toHaveLength(0)
      expect(harness.plan.advances()).toBe(0)
      expect(harness.plan.fired).toHaveLength(0)
      expect(harness.obs.connectCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Cue engine (BLUEPRINT.md §4)
  //
  // The most dangerous component in the product, tested at the boundary where it meets the
  // renderer. Three claims are defended here, and each of them is a thing a wrong automated action
  // mid-service would violate:
  //
  //  1. **The boundary cannot make the engine act.** There is no fire channel. The renderer can
  //     read, tune, accept or reject a *named* suggestion, and switch automation off.
  //  2. **Nothing can force an auto-fire.** The dial is enum-bounded and an invalid payload never
  //     reaches the engine at all.
  //  3. **`cuePanic` always succeeds.** No engine, an `Err` from the engine and a throw out of the
  //     engine all resolve `ok` with a renderable panicked state — an operator hitting the switch
  //     must never meet an error dialog.
  //
  // Standing Rule 4 runs through the whole block: the only verse text anywhere in it is
  // `SCRIPTURE_TEXT_PLACEHOLDER`, and every transcript span is invented.
  // -------------------------------------------------------------------------

  describe('cue channels', () => {
    it('returns the current engine snapshot and settings', async () => {
      const state = (await harness.invoke(IpcChannel.cueGetState)) as Result<CueEngineState>
      expect(state.ok).toBe(true)
      if (!state.ok) return
      expect(state.value).toEqual(ASSISTING_CUE_STATE)
      // `assist` is the default everywhere and the only mode that should be recommended.
      expect(state.value.mode).toBe('assist')
      expect(state.value.panicked).toBe(false)

      const settings = (await harness.invoke(
        IpcChannel.cueGetSettings
      )) as Result<CueEngineSettings>
      expect(settings.ok).toBe(true)
      if (!settings.ok) return
      expect(settings.value).toEqual(defaultCueEngineSettings())
    })

    it('saves valid settings and resolves with what was stored', async () => {
      const saved = (await harness.invoke(
        IpcChannel.cueSetSettings,
        CUE_SETTINGS
      )) as Result<CueEngineSettings>

      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      expect(harness.cue.settingsWrites).toEqual([CUE_SETTINGS])
      expect(saved.value.hotPhrases).toHaveLength(1)
    })

    /**
     * The requirement stated as a test: an invalid settings object is refused **and the engine is
     * never called**.
     *
     * A half-typed settings form must not be able to replace a working configuration mid-service,
     * and an `autoFireThreshold` outside 0..1 in particular would be an engine that auto-fires
     * everything — the exact failure that cannot be undone in front of a congregation.
     */
    it('rejects invalid settings with Err(INVALID_ARG) and never calls the engine', async () => {
      const rejected: unknown[] = [
        undefined,
        null,
        'assist',
        { ...CUE_SETTINGS, mode: 'autopilot' },
        { ...CUE_SETTINGS, autoFireThreshold: 1.5 },
        { ...CUE_SETTINGS, autoFireThreshold: -1 },
        { ...CUE_SETTINGS, scriptureAutoShow: 'yes' },
        { ...CUE_SETTINGS, translation: '' },
        // A hot phrase whose id/cueId/phrase is out of bounds. These are matched against a live
        // transcript for the length of a service, so their size is bounded here.
        { ...CUE_SETTINGS, hotPhrases: [{ id: '', phrase: 'ab', cueId: 'c', enabled: true }] },
        {
          ...CUE_SETTINGS,
          hotPhrases: [{ id: 'h', phrase: 'x'.repeat(121), cueId: 'c', enabled: true }]
        },
        {
          ...CUE_SETTINGS,
          hotPhrases: Array.from({ length: 201 }, (_unused, index) => ({
            id: `h${index}`,
            phrase: 'PLACEHOLDER HOT PHRASE',
            cueId: 'c',
            enabled: true
          }))
        }
      ]

      for (const payload of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.cueSetSettings, payload)).code).toBe(
          'INVALID_ARG'
        )
      }

      expect(harness.cue.settingsWrites).toHaveLength(0)
    })

    it('accepts every trust mode and refuses anything else without calling the engine', async () => {
      for (const mode of TRUST_MODES) {
        const result = (await harness.invoke(IpcChannel.cueSetMode, {
          mode
        })) as Result<CueEngineState>
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.mode).toBe(mode)
      }
      expect(harness.cue.modeWrites).toEqual([...TRUST_MODES])

      for (const payload of [undefined, {}, { mode: 'autopilot' }, { mode: 4 }, 'auto']) {
        expect(expectErr(await harness.invoke(IpcChannel.cueSetMode, payload)).code).toBe(
          'INVALID_ARG'
        )
      }
      // Still only the three legitimate writes: an unknown mode never reached the engine, so the
      // dial was never left in a position nobody can name.
      expect(harness.cue.modeWrites).toEqual([...TRUST_MODES])
    })

    /**
     * A confirm names its suggestion, and a stale one misses.
     *
     * This is "human always wins" at the boundary. `syncToActual` drops the pending suggestion the
     * instant the plan moves by any other means, so a confirm that was already in flight when the
     * operator advanced by hand refers to a suggestion that no longer exists — and must therefore
     * do nothing rather than fire whatever happens to be pending by the time it lands.
     */
    it('confirms and dismisses by id, and a stale id is a no-op', async () => {
      const confirmed = (await harness.invoke(IpcChannel.cueConfirm, {
        suggestionId: PLAN_SUGGESTION.id
      })) as Result<CueEngineState>
      expect(confirmed.ok).toBe(true)
      if (!confirmed.ok) return
      expect(confirmed.value.pending).toBeNull()
      expect(confirmed.value.recent[0]).toEqual(PLAN_SUGGESTION)

      // Nothing is pending now. A second confirm — the stale one — changes nothing at all.
      const stale = (await harness.invoke(IpcChannel.cueConfirm, {
        suggestionId: PLAN_SUGGESTION.id
      })) as Result<CueEngineState>
      expect(stale.ok).toBe(true)
      if (!stale.ok) return
      expect(stale.value.pending).toBeNull()
      expect(stale.value.recent).toHaveLength(1)

      expect(harness.cue.confirmed).toEqual([PLAN_SUGGESTION.id, PLAN_SUGGESTION.id])
    })

    it('requires a suggestion id on confirm and dismiss', async () => {
      for (const channel of [IpcChannel.cueConfirm, IpcChannel.cueDismiss]) {
        for (const payload of [undefined, {}, { suggestionId: '' }, { suggestionId: 7 }]) {
          expect(expectErr(await harness.invoke(channel, payload)).code).toBe('INVALID_ARG')
        }
      }
      expect(harness.cue.confirmed).toHaveLength(0)
      expect(harness.cue.dismissed).toHaveLength(0)
    })

    it('dismisses the pending suggestion without recording it as fired', async () => {
      const dismissed = (await harness.invoke(IpcChannel.cueDismiss, {
        suggestionId: PLAN_SUGGESTION.id
      })) as Result<CueEngineState>
      expect(dismissed.ok).toBe(true)
      if (!dismissed.ok) return
      expect(dismissed.value.pending).toBeNull()
      expect(dismissed.value.recent).toHaveLength(0)
    })

    // --- panic ---------------------------------------------------------------

    it('halts automation on panic and reports a panicked state', async () => {
      const result = (await harness.invoke(IpcChannel.cuePanic)) as Result<CueEngineState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(harness.cue.panicCalls()).toBe(1)
      expect(result.value.panicked).toBe(true)
      expect(result.value.enabled).toBe(false)
      expect(result.value.mode).toBe('manual')
      expect(result.value.pending).toBeNull()

      // And it touched nothing else. Panicking must never take a congregation's stream off the
      // air, move the plan pointer, cut a camera or clear a lower-third.
      expect(harness.obs.disconnectCalls()).toBe(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.plan.advances()).toBe(0)
      expect(harness.plan.fired).toHaveLength(0)
      expect(harness.camera.selected).toHaveLength(0)
      expect(harness.overlay.sent).toHaveLength(0)
    })

    /**
     * The requirement, exactly: **panic succeeds even when the engine throws.**
     *
     * `safeHandle` would ordinarily convert a throw into `Err(INTERNAL)`. For this one channel
     * that is the wrong answer, because an `Err` is what the renderer turns into an error dialog —
     * and an operator hitting the panic switch is already having the worst minute of their
     * service. What comes back instead is a successful, renderable, *panicked* state carrying the
     * reason in `lastError`, which is also what stops the layer above from applying anything.
     */
    it('succeeds on panic even when the engine throws', async () => {
      const cue = createFakeCueEngine()
      Object.assign(cue, {
        panic: () => {
          throw new Error('the cue engine exploded')
        }
      })

      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.cuePanic)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      const settled = await Promise.resolve(handler(eventFrom(window), undefined))
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      const result = settled.value as Result<CueEngineState>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.panicked).toBe(true)
      expect(result.value.enabled).toBe(false)
      expect(result.value.mode).toBe('manual')
      expect(result.value.lastError).toContain('exploded')
    })

    it('succeeds on panic even when the engine returns an error', async () => {
      const cue = createFakeCueEngine()
      Object.assign(cue, {
        panic: () => err('INTERNAL', 'the engine could not halt')
      })

      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.cuePanic)
      if (handler === undefined) throw new Error('no panic handler')
      const result = (await handler(eventFrom(window), undefined)) as Result<CueEngineState>

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.panicked).toBe(true)
      expect(result.value.lastError).toContain('could not halt')
    })

    /**
     * The press is logged before the attempt, at `info`, with a timestamp.
     *
     * The fact worth recording is that the operator pressed it — not the outcome. If the engine
     * then throws, or the process dies a second later, the rolling log still answers "when did they
     * panic?", which is the first question anyone asks afterwards.
     */
    it('logs the panic press at info with a timestamp before attempting anything', async () => {
      const lines: LogLine[] = []
      const cue = createFakeCueEngine()
      Object.assign(cue, {
        panic: () => {
          throw new Error('the cue engine exploded')
        }
      })

      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue,
        config: CONFIG,
        logger: createRecordingLogger(lines),
        ipcMain: ipc,
        getWindows: () => [window],
        now: () => 1_700_000_000_000
      })

      const handler = ipc.handlers.get(IpcChannel.cuePanic)
      if (handler === undefined) throw new Error('no panic handler')
      await handler(eventFrom(window), undefined)

      const requested = lines.find((line) => line.msg.startsWith('PANIC requested'))
      expect(requested?.level).toBe('info')
      expect(requested?.data?.at).toBe(new Date(1_700_000_000_000).toISOString())
      expect(requested?.data?.channel).toBe(IpcChannel.cuePanic)

      // The throw is recorded too — as a log line, not as a failed Result.
      expect(lines.some((line) => line.level === 'error' && line.msg.includes('PANIC'))).toBe(true)
    })

    it('re-engages automation only when the operator asks', async () => {
      await harness.invoke(IpcChannel.cuePanic)
      expect(harness.cue.resumeCalls()).toBe(0)

      const resumed = (await harness.invoke(IpcChannel.cueResume)) as Result<CueEngineState>
      expect(resumed.ok).toBe(true)
      if (!resumed.ok) return
      expect(harness.cue.resumeCalls()).toBe(1)
      expect(resumed.value.panicked).toBe(false)
      expect(resumed.value.mode).toBe('assist')
    })

    // --- scripture (Standing Rule 4) -----------------------------------------

    it('resolves a scripture reference and forwards the requested translation', async () => {
      const resolved = (await harness.invoke(IpcChannel.cueResolveScripture, {
        reference: SCRIPTURE_REFERENCE,
        translation: 'KJV'
      })) as Result<ResolvedScripture>

      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      expect(harness.scripture.resolveCalls).toEqual([
        { reference: SCRIPTURE_REFERENCE, translation: 'KJV' }
      ])
      expect(resolved.value.reference).toEqual(SCRIPTURE_REFERENCE)
      // Standing Rule 4: the only "verse text" anywhere in this repository is the placeholder.
      expect(resolved.value.text).toBe(SCRIPTURE_TEXT_PLACEHOLDER)
    })

    /**
     * An omitted translation is *omitted*, never sent as `undefined`.
     *
     * "Absent" means "use the operator's configured translation", which is also the only place the
     * quarantine rule for an unverified translation can be applied consistently.
     */
    it('omits the translation key when the renderer did not supply one', async () => {
      const resolved = (await harness.invoke(IpcChannel.cueResolveScripture, {
        reference: SCRIPTURE_REFERENCE
      })) as Result<ResolvedScripture>

      expect(resolved.ok).toBe(true)
      expect(harness.scripture.resolveCalls).toHaveLength(1)
      expect(harness.scripture.resolveCalls[0]?.translation).toBeUndefined()
    })

    /**
     * The requirement: **an invalid scripture reference is rejected**, and the resolver never runs.
     *
     * The resolver turns this struct into a request against a licensed API or a public-domain file.
     * A reference the detector could not have produced is either a bug or an attempt to make Verger
     * fetch something arbitrary, so it stops here.
     */
    it('rejects an invalid scripture reference without calling the engine', async () => {
      const rejected: unknown[] = [
        undefined,
        null,
        'John 3:16',
        { reference: null },
        { reference: { ...SCRIPTURE_REFERENCE, chapter: 0 } },
        { reference: { ...SCRIPTURE_REFERENCE, chapter: 151 } },
        { reference: { ...SCRIPTURE_REFERENCE, verse: 0 } },
        { reference: { ...SCRIPTURE_REFERENCE, verse: 201 } },
        { reference: { ...SCRIPTURE_REFERENCE, chapter: 3.5 } },
        { reference: { ...SCRIPTURE_REFERENCE, book: '' } },
        { reference: { ...SCRIPTURE_REFERENCE, band: 'certain' } },
        { reference: { ...SCRIPTURE_REFERENCE, confidence: 2 } },
        { reference: { ...SCRIPTURE_REFERENCE, sourceText: 'x'.repeat(501) } },
        // A reference with the `verse` field missing entirely — nullable, but not optional.
        { reference: { ...SCRIPTURE_REFERENCE, verse: undefined } },
        { reference: SCRIPTURE_REFERENCE, translation: '' },
        { reference: SCRIPTURE_REFERENCE, translation: 'x'.repeat(21) }
      ]

      for (const payload of rejected) {
        expect(expectErr(await harness.invoke(IpcChannel.cueResolveScripture, payload)).code).toBe(
          'INVALID_ARG'
        )
      }

      expect(harness.scripture.resolveCalls).toHaveLength(0)
    })

    it('lists only the translations that may actually be selected', async () => {
      const listed = (await harness.invoke(IpcChannel.cueListTranslations)) as Result<
        readonly TranslationSource[]
      >
      expect(listed.ok).toBe(true)
      if (!listed.ok) return

      // The quarantined Korean KRV is in the catalogue and is not offered: an unverified
      // translation must never be selectable just because a file for it exists.
      expect(listed.value.map((entry) => entry.code)).toEqual(['KJV'])
      expect(listed.value.every((entry) => entry.verified)).toBe(true)
      expect(listed.value.every((entry) => entry.license.length > 0)).toBe(true)

      // And nothing in the catalogue carries verse text — there is no field on `TranslationSource`
      // that could hold any.
      expect(collectKeys(listed.value)).not.toContain('text')
    })

    // --- fan-out -------------------------------------------------------------

    /**
     * The requirement: suggestions fan out to *all* windows.
     *
     * Broadcasting an intent changes nothing anywhere — the engine has not fired and cannot fire
     * from the IPC layer — so every window gets the same offer and the operator answers from
     * whichever one they are looking at.
     */
    it('fans engine state and suggestions out to every window', () => {
      const many = setup({ windows: 3 })
      try {
        many.cue.emitState(ASSISTING_CUE_STATE)
        many.cue.emitSuggestion(PLAN_SUGGESTION)
        many.cue.emitSuggestion(SCRIPTURE_SUGGESTION)

        for (const window of many.windows) {
          expect(window.sent).toEqual([
            { channel: IpcEvent.cueState, payload: ASSISTING_CUE_STATE },
            { channel: IpcEvent.cueSuggestion, payload: PLAN_SUGGESTION },
            { channel: IpcEvent.cueSuggestion, payload: SCRIPTURE_SUGGESTION }
          ])
        }

        // Standing Rule 4 on the event feed: a suggestion carries a REFERENCE, never text.
        const pushed = many.windows[0]?.sent.find(
          (entry) => entry.channel === IpcEvent.cueSuggestion
        )?.payload as CueSuggestion | undefined
        expect(pushed?.reference).toBeNull()
        expect(collectKeys(many.windows[0]?.sent ?? [])).not.toContain('text')

        // And the scripture suggestion whose text has not resolved cannot self-fire, whatever the
        // mode: a confident reference says nothing about whether the text is in hand.
        const scripture = many.windows[0]?.sent[2]?.payload as CueSuggestion | undefined
        expect(scripture?.detector).toBe('scripture')
        expect(scripture?.canAutoFire).toBe(false)
      } finally {
        many.dispose()
      }
    })

    // --- degradation ---------------------------------------------------------

    /**
     * No cue engine at all — and the operator loses nothing that matters.
     *
     * Nine channels answer `NOT_CONFIGURED` with a detail saying the plan still advances on SPACE.
     * The tenth is `cuePanic`, which still succeeds: with no engine there was no automation to
     * halt, and the operator gets exactly the state they asked for rather than a dialog.
     */
    it('degrades to NOT_CONFIGURED with no engine, and panic still succeeds', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      for (const [channel, arg] of [
        [IpcChannel.cueGetState, undefined],
        [IpcChannel.cueGetSettings, undefined],
        [IpcChannel.cueSetSettings, CUE_SETTINGS],
        [IpcChannel.cueSetMode, { mode: 'assist' }],
        [IpcChannel.cueConfirm, { suggestionId: PLAN_SUGGESTION.id }],
        [IpcChannel.cueDismiss, { suggestionId: PLAN_SUGGESTION.id }],
        [IpcChannel.cueResume, undefined],
        [IpcChannel.cueResolveScripture, { reference: SCRIPTURE_REFERENCE }],
        [IpcChannel.cueListTranslations, undefined]
      ] as Array<[IpcChannelValue, unknown]>) {
        expect(expectErr(await call(channel, arg)).code).toBe('NOT_CONFIGURED')
      }

      const panicked = (await call(IpcChannel.cuePanic)) as Result<CueEngineState>
      expect(panicked.ok).toBe(true)
      if (!panicked.ok) return
      expect(panicked.value.panicked).toBe(true)
      expect(panicked.value.enabled).toBe(false)
      expect(panicked.value.mode).toBe('manual')
      expect(panicked.value.lastError).not.toBeNull()

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    /**
     * No scripture resolver — Standing Rule 5, and the ordinary state of a machine with no ESV /
     * API.Bible key and no verified public-domain translation downloaded.
     *
     * The two scripture channels answer `NOT_CONFIGURED` naming the keys. Everything else about the
     * engine keeps working: the plan-follower and hot-phrase detectors need no scripture at all, so
     * the operator loses verse *text* and keeps every other suggestion.
     */
    it('reports NOT_CONFIGURED for the scripture channels when there is no resolver', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: createFakeCueEngine(),
        // No resolver: no ESV / API.Bible key and no verified public-domain translation on disk.
        scripture: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      const resolved = expectErr(
        await call(IpcChannel.cueResolveScripture, { reference: SCRIPTURE_REFERENCE })
      )
      expect(resolved.code).toBe('NOT_CONFIGURED')
      expect(resolved.detail).toContain('ESV_API_KEY')
      expect(expectErr(await call(IpcChannel.cueListTranslations)).code).toBe('NOT_CONFIGURED')

      // The rest of the engine is untouched — including the switch that has to work.
      const state = (await call(IpcChannel.cueGetState)) as Result<CueEngineState>
      expect(state.ok).toBe(true)
      const panicked = (await call(IpcChannel.cuePanic)) as Result<CueEngineState>
      expect(panicked.ok).toBe(true)

      dispose()
    })

    it('tolerates a cue engine whose subscriptions return nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: CueEngineLike = {
        getState: () => idleCueEngineState(),
        getSettings: () => defaultCueEngineSettings(),
        setSettings: (settings) => settings,
        setMode: () => idleCueEngineState(),
        confirm: () => idleCueEngineState(),
        dismiss: () => idleCueEngineState(),
        panic: () => idleCueEngineState(),
        resume: () => idleCueEngineState(),
        onState: () => undefined,
        onSuggestion: () => undefined
      }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: bare,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('converts a throwing cue engine into Err(INTERNAL) on the ordinary channels', async () => {
      const cue = createFakeCueEngine()
      Object.assign(cue, {
        getState: () => {
          throw new Error('the cue engine exploded')
        }
      })

      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const handler = ipc.handlers.get(IpcChannel.cueGetState)
      expect(handler).toBeDefined()
      if (handler === undefined) return

      const settled = await Promise.resolve(handler(eventFrom(window), undefined))
        .then((value) => ({ rejected: false, value }))
        .catch((cause: unknown) => ({ rejected: true, value: cause }))

      expect(settled.rejected).toBe(false)
      expect(expectErr(settled.value).code).toBe('INTERNAL')
    })

    /**
     * Standing Rule 1 at the boundary: driving the whole cue surface changes nothing else.
     *
     * Confirming a suggestion here does not advance the plan, does not fire a cue, does not switch
     * a camera and does not send an overlay command — because this layer cannot. Whatever applies a
     * confirmed suggestion reaches the plan through the same `plan:*` channels an operator's SPACE
     * key uses, which is exactly what makes "a manual move always wins" implementable.
     */
    it('leaves the plan, the camera, the overlay and OBS untouched', async () => {
      await harness.invoke(IpcChannel.cueSetMode, { mode: 'auto' })
      await harness.invoke(IpcChannel.cueSetSettings, CUE_SETTINGS)
      await harness.invoke(IpcChannel.cueConfirm, { suggestionId: PLAN_SUGGESTION.id })
      await harness.invoke(IpcChannel.cueDismiss, { suggestionId: SCRIPTURE_SUGGESTION.id })
      await harness.invoke(IpcChannel.cueResolveScripture, { reference: SCRIPTURE_REFERENCE })
      await harness.invoke(IpcChannel.cuePanic)
      await harness.invoke(IpcChannel.cueResume)

      expect(harness.plan.advances()).toBe(0)
      expect(harness.plan.fired).toHaveLength(0)
      expect(harness.camera.selected).toHaveLength(0)
      expect(harness.overlay.sent).toHaveLength(0)
      expect(harness.obs.connectCalls).toHaveLength(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Independence (BLUEPRINT.md §6 — the whole point of Phase 3)
  //
  // The claim these two tests defend is the one that lets an operator retire the
  // transparent-PowerPoint hack: cameras and overlays are two state machines that never read
  // each other. Asserted here at the IPC boundary, where a careless future handler would be
  // most tempted to "helpfully" clear a lower-third on a camera cut.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Health and recovery (BLUEPRINT.md §9)
  // -------------------------------------------------------------------------

  describe('health channels', () => {
    it('returns the whole dashboard from healthGet, including what still works', async () => {
      harness.health.emitSnapshot(reconnectingSnapshot())

      const result = (await harness.invoke(IpcChannel.healthGet)) as Result<HealthSnapshot>
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const stream = result.value.subsystems.find((subsystem) => subsystem.id === 'stream')
      const recording = result.value.subsystems.find((subsystem) => subsystem.id === 'recording')

      // Amber means "working, but not as configured" — and the string next to it is the one that
      // keeps an operator from stopping a service to investigate.
      expect(stream?.level).toBe('degraded')
      expect(stream?.stillWorks).toContain('recording')
      expect(recording?.level).toBe('ok')
      expect(result.value.worst).toBe('degraded')

      // The only question that matters mid-service, answered from the payload alone.
      expect(isServiceStillGoingOut(result.value)).toBe(true)
    })

    it('lists the retained checkpoints', async () => {
      const result = (await harness.invoke(
        IpcChannel.healthListCheckpoints
      )) as Result<readonly Checkpoint[]>
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.map((checkpoint) => checkpoint.id)).toEqual(['cp-2', 'cp-1'])
      // A checkpoint describes automation and nothing else. There is no field here naming the
      // stream or the recording, so nothing restoring one could ever read as "undo the broadcast".
      expect(Object.keys(result.value[0] ?? {}).sort()).toEqual([
        'at',
        'id',
        'label',
        'overlayRevision',
        'planPosition'
      ])
    })

    /**
     * The case the whole handler exists for.
     *
     * A checkpoint list is bounded (`MAX_CHECKPOINTS`), so an id the operator is looking at can
     * age out between the dialog opening and the button being pressed. That must be an ordinary
     * failed `Result` the UI can render — not a rejected promise, and emphatically not a silent
     * success, because an operator told "restored" when nothing was restored will carry on as
     * though the plan pointer moved.
     */
    it('answers an unknown checkpoint id with a clean Err rather than throwing', async () => {
      const call = harness.invoke(IpcChannel.healthRestoreCheckpoint, {
        checkpointId: 'cp-does-not-exist'
      })
      await expect(call).resolves.toBeDefined()

      const error = expectErr(await call)
      expect(error.code).toBe('NOT_FOUND')
      expect(error.detail).toContain('nothing was changed')

      // The service was asked, and it said no. Nothing else moved.
      expect(harness.checkpoints.restoreCalls).toEqual(['cp-does-not-exist'])
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
      expect(harness.plan.advances()).toBe(0)
    })

    it('restores a known checkpoint without touching the stream or the recording', async () => {
      const result = (await harness.invoke(IpcChannel.healthRestoreCheckpoint, {
        checkpointId: 'cp-1'
      })) as Result<HealthSnapshot>
      expect(result.ok).toBe(true)
      expect(harness.checkpoints.restoreCalls).toEqual(['cp-1'])

      // The rule of this phase, asserted rather than asserted-in-a-comment. A rewind of automation
      // is not a rewind of the broadcast; the broadcast cannot be rewound, and must not be ended
      // in the attempt.
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.goLive.startArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
    })

    it('reloads the overlays without touching the stream or the recording', async () => {
      const result = (await harness.invoke(IpcChannel.healthReloadOverlays)) as Result<HealthSnapshot>
      expect(result.ok).toBe(true)
      expect(harness.overlayReload.reloadCalls()).toBe(1)

      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
    })

    /**
     * A reload that could not happen.
     *
     * The failure is forwarded rather than swallowed, and — the part that matters — the broadcast
     * is untouched on the way past. There is no cleanup branch here that reacts to a failed
     * recovery by stopping something, because there is no verb on any health seam that could.
     */
    it('forwards a refused overlay reload without touching the broadcast', async () => {
      harness.overlayReload.failWith = err(
        'NOT_CONFIGURED',
        'this build has no overlay reload channel',
        'refresh the browser source in OBS'
      )

      const error = expectErr(await harness.invoke(IpcChannel.healthReloadOverlays))
      expect(error.code).toBe('NOT_CONFIGURED')
      expect(error.detail).toContain('OBS')

      expect(harness.overlayReload.reloadCalls()).toBe(0)
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
    })

    it('rejects a malformed checkpoint id without calling the service', async () => {
      for (const bad of [undefined, {}, { checkpointId: '' }, { checkpointId: 'x'.repeat(65) }]) {
        const error = expectErr(await harness.invoke(IpcChannel.healthRestoreCheckpoint, bad))
        expect(error.code).toBe('INVALID_ARG')
      }
      expect(harness.checkpoints.restoreCalls).toHaveLength(0)
    })

    /**
     * A monitor that has itself broken.
     *
     * `healthGet` still answers — the panel an operator stares at during a failure must always
     * have something to draw — while the two *actions* report the failure, because an action that
     * silently claimed to have happened is the worse lie.
     */
    it('survives a health service that throws', async () => {
      harness.health.throwWith = new Error('the aggregator is wedged')
      harness.checkpoints.throwWith = harness.health.throwWith
      harness.overlayReload.throwWith = harness.health.throwWith

      const snapshot = (await harness.invoke(IpcChannel.healthGet)) as Result<HealthSnapshot>
      expect(snapshot.ok).toBe(true)
      if (!snapshot.ok) return
      expect(snapshot.value.subsystems).toHaveLength(SUBSYSTEMS.length)
      expect(snapshot.value.worst).toBe('not-configured')

      // Nothing rejects, on any of the four.
      expect(expectErr(await harness.invoke(IpcChannel.healthListCheckpoints)).code).toBe('INTERNAL')
      expect(
        expectErr(await harness.invoke(IpcChannel.healthRestoreCheckpoint, { checkpointId: 'cp-1' }))
          .code
      ).toBe('INTERNAL')
      expect(expectErr(await harness.invoke(IpcChannel.healthReloadOverlays)).code).toBe('INTERNAL')

      // And the broadcast is exactly where it was.
      expect(harness.goLive.endArgs).toHaveLength(0)
      expect(harness.obs.disconnectCalls()).toBe(0)
    })

    it('fans health snapshots out to every window', () => {
      const many = setup({ windows: 3 })
      try {
        const snapshot = reconnectingSnapshot()
        many.health.emitSnapshot(snapshot)

        for (const window of many.windows) {
          const pushed = window.sent.filter(
            (entry) => entry.channel === IpcEvent.healthSnapshot
          )
          expect(pushed).toHaveLength(1)
          expect(pushed[0]?.payload).toEqual(snapshot)
        }
      } finally {
        many.dispose()
      }
    })

    it('skips destroyed windows when fanning health out', () => {
      const many = setup({ windows: 2 })
      try {
        const dead = many.windows[1]
        expect(dead).toBeDefined()
        if (dead === undefined) return
        Object.assign(dead, { isDestroyed: () => true })

        many.health.emitSnapshot(healthySnapshot())
        expect(many.windows[0]?.sent).toHaveLength(1)
        expect(dead.sent).toHaveLength(0)
      } finally {
        many.dispose()
      }
    })

    /**
     * No health service at all.
     *
     * The dashboard is gone; the service is not. Every light reads `not-configured` — a resting
     * state, deliberately NOT amber, because an amber light that is always on is one an operator
     * learns to ignore — and the two recovery actions say plainly that they did not run.
     */
    it('degrades to a renderable snapshot and refusing actions with no health service', async () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: null,
        health: null,
        checkpoints: null,
        overlayReload: null,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      const snapshot = (await call(IpcChannel.healthGet)) as Result<HealthSnapshot>
      expect(snapshot.ok).toBe(true)
      if (!snapshot.ok) return
      expect(snapshot.value.subsystems.map((subsystem) => subsystem.id)).toEqual([...SUBSYSTEMS])
      expect(snapshot.value.subsystems.every((subsystem) => subsystem.level === 'not-configured')).toBe(
        true
      )
      expect(snapshot.value.worst).toBe('not-configured')

      const checkpoints = (await call(IpcChannel.healthListCheckpoints)) as Result<
        readonly Checkpoint[]
      >
      expect(checkpoints.ok).toBe(true)
      if (checkpoints.ok) expect(checkpoints.value).toEqual([])

      for (const channel of [IpcChannel.healthRestoreCheckpoint, IpcChannel.healthReloadOverlays]) {
        const error = expectErr(
          await call(channel, channel === IpcChannel.healthRestoreCheckpoint ? { checkpointId: 'cp-1' } : undefined)
        )
        expect(error.code).toBe('NOT_CONFIGURED')
        // The detail names what is unaffected, which is the fact that keeps someone calm.
        expect(error.detail).toContain('recording')
      }

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('survives a health singleton that cannot be constructed', async () => {
      // `health` is omitted entirely, so `registerIpc` falls back to `getHealthService()` — which
      // the module mock at the top of this file makes throw.
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      const handler = ipc.handlers.get(IpcChannel.healthGet)
      expect(handler).toBeDefined()
      if (handler === undefined) return
      const snapshot = (await handler(eventFrom(window), undefined)) as Result<HealthSnapshot>
      expect(snapshot.ok).toBe(true)

      expect(() => {
        dispose()
      }).not.toThrow()
    })

    it('tolerates a health service whose subscription returns nothing', () => {
      const ipc = createFakeIpcMain()
      const window = createFakeWindow()
      const bare: HealthServiceLike = {
        getSnapshot: () => healthySnapshot(),
        onSnapshot: () => undefined
      }
      const bareCheckpoints: CheckpointStoreLike = {
        list: () => CHECKPOINTS,
        restore: () => CHECKPOINTS[0] as Checkpoint
      }
      const bareReload: OverlayReloadLike = { reloadNow: () => ok(undefined) }

      const dispose = registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: null,
        health: bare,
        checkpoints: bareCheckpoints,
        overlayReload: bareReload,
        config: CONFIG,
        logger: createSilentLogger(),
        ipcMain: ipc,
        getWindows: () => [window]
      })

      expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
      expect(() => {
        dispose()
      }).not.toThrow()
    })

    /**
     * The audit trail for the two recovery actions.
     *
     * When someone asks afterwards why the plan jumped back three cues in the middle of the
     * sermon, the rolling log is where the answer is — so the press is logged before the attempt,
     * exactly as GO LIVE / END and PANIC are.
     */
    it('logs both recovery actions at info level with who asked and when', async () => {
      const lines: LogLine[] = []
      const ipc = createFakeIpcMain()
      const window = createFakeWindow('file:///app/out/renderer/index.html')
      const at = 1_764_000_000_000

      registerIpc({
        obs: createFakeObsClient(),
        overlay: null,
        camera: null,
        youtube: null,
        goLive: null,
        plan: null,
        asr: null,
        cue: null,
        health: createFakeHealthService(),
        checkpoints: createFakeCheckpointStore(),
        overlayReload: createFakeOverlayReload(),
        config: CONFIG,
        logger: createRecordingLogger(lines),
        ipcMain: ipc,
        getWindows: () => [window],
        now: () => at
      })

      const call = async (channel: IpcChannelValue, arg?: unknown): Promise<unknown> => {
        const handler = ipc.handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(eventFrom(window), arg)
      }

      await call(IpcChannel.healthRestoreCheckpoint, { checkpointId: 'cp-1' })
      await call(IpcChannel.healthReloadOverlays)

      const info = lines.filter((line) => line.level === 'info')
      const restored = info.find((line) => line.msg === 'checkpoint restore requested')
      const reloaded = info.find((line) => line.msg === 'overlay reload requested')
      expect(restored).toBeDefined()
      expect(reloaded).toBeDefined()
      for (const line of [restored, reloaded]) {
        expect(line?.data?.who).toBe('file:///app/out/renderer/index.html')
        expect(line?.data?.at).toBe(new Date(at).toISOString())
      }
    })
  })

  describe('camera and overlay independence', () => {
    it('a camera switch leaves the overlay snapshot byte-identical', async () => {
      const shown = (await harness.invoke(
        IpcChannel.overlaySend,
        SHOW_LOWER_THIRD
      )) as Result<OverlayState>
      expect(shown.ok).toBe(true)
      if (!shown.ok) return

      const cam2 = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'cam2'
      })) as Result<CameraState>
      const wide = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'wide'
      })) as Result<CameraState>
      expect(cam2.ok).toBe(true)
      expect(wide.ok).toBe(true)

      const after = (await harness.invoke(IpcChannel.overlayGetState)) as Result<OverlayState>
      expect(after.ok).toBe(true)
      if (!after.ok) return

      // Byte-identical, `revision` included. A revision bump would mean *something* touched the
      // overlay reducer, even if the visible fields happened to land the same.
      expect(after.value).toEqual(shown.value)
      expect(after.value.lowerThird.visible).toBe(true)
      expect(after.value.revision).toBe(1)

      // And no overlay command was manufactured behind the operator's back.
      expect(harness.overlay.sent).toEqual([SHOW_LOWER_THIRD])
    })

    it('an overlay command leaves the camera state byte-identical', async () => {
      const selected = (await harness.invoke(IpcChannel.cameraSelect, {
        slot: 'cam2'
      })) as Result<CameraState>
      expect(selected.ok).toBe(true)
      if (!selected.ok) return

      for (const command of [
        SHOW_LOWER_THIRD,
        { channel: 'command', name: 'lowerThird.hide', payload: {} },
        { channel: 'command', name: 'clearAll', payload: {} }
      ]) {
        const result = (await harness.invoke(IpcChannel.overlaySend, command)) as Result<unknown>
        expect(result.ok).toBe(true)
      }

      const after = (await harness.invoke(IpcChannel.cameraGetState)) as Result<CameraState>
      expect(after.ok).toBe(true)
      if (!after.ok) return

      expect(after.value).toEqual(selected.value)
      expect(after.value.activeSlot).toBe('cam2')

      // `clearAll` is the most destructive overlay verb there is, and it still did not touch a
      // camera: the service was called exactly once, by the operator, for `cam2`.
      expect(harness.camera.selected).toEqual(['cam2'])
    })
  })

  it('tolerates an OBS client whose subscriptions return nothing', () => {
    const ipc = createFakeIpcMain()
    const window = createFakeWindow()
    const bare: ObsClientLike = {
      getStatus: () => initialObsStatus('idle', 0),
      getSceneList: () => SCENE_LIST,
      connect: () => initialObsStatus('connected', 0),
      disconnect: () => initialObsStatus('idle', 0),
      onStatus: () => undefined,
      onSceneList: () => undefined
    }

    const dispose = registerIpc({
      obs: bare,
      config: CONFIG,
      logger: createSilentLogger(),
      ipcMain: ipc,
      getWindows: () => [window]
    })

    expect(ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
    expect(() => {
      dispose()
    }).not.toThrow()
    expect(ipc.handlers.size).toBe(0)
  })
})
