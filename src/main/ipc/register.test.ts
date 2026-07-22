/**
 * `registerIpc` contract tests.
 *
 * Everything is driven through injected structural seams — a fake `ipcMain` that is really
 * a `Map<channel, handler>`, fake windows, a fake OBS client and a fake secrets store — so
 * this file needs no Electron runtime, no network, and no OBS Studio (which is not
 * installed on the build machine). `electron` is mocked purely so the module graph resolves;
 * nothing in it is exercised.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CAMERA_SLOTS, findBinding, isBindingUsable, slotForScene } from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { AppConfig } from '@shared/config'
import { GO_LIVE_STEPS, emptyObsOutputState, idleGoLiveState } from '@shared/golive'
import type { GoLiveState, GoLiveStepStatus, StepState } from '@shared/golive'
import { IPC_CHANNEL_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type { IpcChannelValue } from '@shared/ipc'
import type { OverlayServerInfo } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import { initialObsStatus } from '@shared/obs'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { applyOverlayCommand, emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { Broadcast, BroadcastTemplate, YouTubeStatus } from '@shared/youtube'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/verger-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
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

import {
  OBS_PASSWORD_SECRET_KEY,
  registerIpc,
  type CameraServiceLike,
  type GoLiveServiceLike,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type ObsClientLike,
  type OverlayServerLike,
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

  it('dispose removes every handler and unsubscribes from all five subsystems', () => {
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
  // Independence (BLUEPRINT.md §6 — the whole point of Phase 3)
  //
  // The claim these two tests defend is the one that lets an operator retire the
  // transparent-PowerPoint hack: cameras and overlays are two state machines that never read
  // each other. Asserted here at the IPC boundary, where a careless future handler would be
  // most tempted to "helpfully" clear a lower-third on a camera cut.
  // -------------------------------------------------------------------------

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
