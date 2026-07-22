/**
 * The wiring test — the one test in this repository whose job is to fail when a subsystem is
 * BUILT but CONNECTED TO NOTHING.
 *
 * ## Why this file exists
 *
 * Four times during this build a component was written, fully unit-tested, merged green, and
 * wired to nothing at all:
 *
 *  1. **Phase 2 — the overlay server was never started.** `getOverlayServer()` was constructed
 *     and `start()` was never called, so port 7320 was never bound. OBS's Browser Source pointed
 *     at a URL that refused the connection: the congregation screen had no overlay layer at all.
 *  2. **Phase 4 — the Google session was never restored.** `OAuthService` deliberately begins
 *     signed-out (its constructor cannot await the secrets store) and nothing ever called
 *     `restore()`/`refresh()`, so a perfectly good stored refresh token still read "signed out"
 *     every single launch.
 *  3. **Phase 5 — the go-live re-attach never ran.** `GoLiveService.initialize()` was never
 *     called, so a relaunch mid-service would see an idle button, and GO LIVE would push a SECOND
 *     stream and start a SECOND recording during a live, un-repeatable event.
 *  4. **Phase 8 — the cue engine had neither ears nor eyes.** `getCueEngine()` defaulted `plan`
 *     and `overlay` but not `asr`, and nobody passed a scripture detector. The engine ran
 *     subscribed to no transcript, holding no detector, silently suggesting nothing.
 *
 * **Every one of those passed every unit test.** That is not a coincidence and not carelessness:
 * a unit test injects its own fakes, so by construction it cannot observe whether the *real*
 * composition root ever connects the real objects. The four bugs live in the gap between "the
 * component works" and "the app uses the component", and only a test over the real composition
 * root can stand in that gap.
 *
 * ## What this file does differently
 *
 * It mocks exactly ONE module — `electron` — and nothing else. Every other object comes from its
 * production factory with production defaults. `src/main/ipc/register.test.ts` mocks
 * `@main/overlay`, `@main/camera`, `@main/youtube`, `@main/golive`, `@main/plan`, `@main/asr` and
 * `@main/cue` so it can prove the *degraded* contracts; this file mocks none of them so it can
 * prove the *wired* one. The two are complementary, and neither replaces the other.
 *
 * ## Binding constraints this file respects
 *
 *  - **No Electron runtime.** `electron` is mocked with just enough surface (`app.getPath`,
 *    `app.getVersion`, `app.isPackaged`, `ipcMain.handle`/`removeHandler`,
 *    `BrowserWindow.getAllWindows`, `safeStorage`, `shell`, `dialog`) and `userData` points at a
 *    per-run temp directory, so nothing this file writes lands in a developer's real profile.
 *  - **No OBS Studio, no Google credentials, no Deepgram key, no network.** Every production
 *    factory here is lazy and inert by design; the assertions below are what keeps them that way.
 *  - **Nothing destructive.** No test here starts a stream, starts a recording, stops either, or
 *    presses panic. See `SKIPPED_CHANNELS` for the exact list and the reason for each.
 *  - **Parallel-safe.** The overlay server binds port 0, never 7320, so this file can run
 *    alongside a developer's running app.
 *
 * ## Adding a subsystem
 *
 * See `docs/WIRING.md`. In short: add its factory to `PRODUCTION_FACTORIES`, add its channels to
 * `PROBED_CHANNELS` or `SKIPPED_CHANNELS` (the coverage assertion refuses to let you forget), and
 * — if it must be *started* rather than merely constructed — add an assertion that it starts.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import type { AsrProviderId, TranscriptSegment } from '@shared/asr'
import { defaultAsrSettings } from '@shared/asr'
import { CAMERA_SLOTS, defaultCameraConfig } from '@shared/camera'
import { defaultCueEngineSettings } from '@shared/cue'
import type { CueSuggestion } from '@shared/cue'
import { emptyObsOutputState } from '@shared/golive'
import type { ObsOutputState } from '@shared/golive'
import { IPC_CHANNEL_VALUES, IpcChannel } from '@shared/ipc'
import type { IpcChannelValue, Unsubscribe } from '@shared/ipc'
import { OVERLAY_SERVER_PORT } from '@shared/net'
import { emptyServicePlan } from '@shared/plan'
import { ErrorCode, ok } from '@shared/result'
import type { Result } from '@shared/result'
import type { ScriptureReference } from '@shared/scripture'
import { defaultBroadcastTemplate } from '@shared/youtube'

// ---------------------------------------------------------------------------
// The Electron mock — the ONLY module this file mocks
// ---------------------------------------------------------------------------

/**
 * State the `electron` mock needs, created before the mock factory runs.
 *
 * `vi.hoisted` is the only way to share a value with a `vi.mock` factory: mock factories are
 * hoisted above the imports, so they cannot close over an ordinary module-level binding.
 *
 * `userData` is computed from the environment rather than from `node:os` because this callback
 * runs before any import is evaluated. Everything a production factory persists —
 * `camera.json`, `asr.json`, `youtube-template.json`, the secrets file — lands under it, so a
 * run of this file cannot touch a developer's real Verger profile.
 */
const harness = vi.hoisted(() => {
  const temporaryRoot =
    process.env['TEMP'] ?? process.env['TMP'] ?? process.env['TMPDIR'] ?? '/tmp'
  const userData = `${temporaryRoot}/verger-wiring-${process.pid}-${Date.now()}`

  /** Every `ipcMain.handle` call lands here. This map IS the assertion surface for coverage. */
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  /** What `BrowserWindow.getAllWindows()` returns. `registerIpc` validates senders against it. */
  const windows: unknown[] = []

  return { userData, handlers, windows }
})

vi.mock('electron', () => ({
  app: {
    getPath: (): string => harness.userData,
    getAppPath: (): string => harness.userData,
    getVersion: (): string => '0.0.0-wiring-test',
    isPackaged: false,
    whenReady: (): Promise<void> => Promise.resolve(),
    on: (): void => undefined,
    quit: (): void => undefined,
    requestSingleInstanceLock: (): boolean => true
  },
  BrowserWindow: {
    getAllWindows: (): unknown[] => harness.windows
  },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => {
      harness.handlers.set(channel, listener)
    },
    removeHandler: (channel: string): void => {
      harness.handlers.delete(channel)
    }
  },
  /**
   * A dialog that always cancels.
   *
   * `planOpen` / `planSave` / `planImportDeck` open a native picker when given no path, and a
   * modal is the one thing a headless test can never dismiss. Cancelling is also the branch that
   * matters most: an operator who changes their mind mid-service must get a plain unchanged state
   * back, never an error toast.
   */
  dialog: {
    showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: (): Promise<{ canceled: boolean }> => Promise.resolve({ canceled: true })
  },
  /** Reports unavailable, which is the Standing Rule 5 path: the password simply is not saved. */
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (): Buffer => Buffer.from(''),
    decryptString: (): string => ''
  },
  shell: {
    openExternal: (): Promise<void> => Promise.resolve()
  }
}))

// ---------------------------------------------------------------------------
// Production imports — every one of these is the real thing
// ---------------------------------------------------------------------------

import { getAsrService, resetAsrService } from '@main/asr'
import type { AsrProvider, AsrStartOptions } from '@main/asr'
import { getCameraService, resetCameraService } from '@main/camera'
import { loadConfigFromDisk } from '@main/config/env'
import { getCueEngine, resetCueEngine } from '@main/cue'
import { getGoLiveService, resetGoLiveService } from '@main/golive'
import type { GoLiveOutputs, StartOutputsSummary } from '@main/golive'
import { getCheckpointStore, getHealthService, resetHealthService } from '@main/health'
import { registerIpc } from '@main/ipc/register'
import { createNullLogger } from '@main/logging/logger'
import { getObsClient, resetObsClient } from '@main/obs'
import { getOverlayServer, resetOverlayServer, resolveOverlayStaticDir } from '@main/overlay'
import { getPlanService, resetPlanService } from '@main/plan'
import { getYouTubeService, resetYouTubeService } from '@main/youtube'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `<repo>/src/main/`. */
const MAIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/** `<repo>/`. */
const REPO_ROOT = resolvePath(MAIN_DIR, '..', '..')

/**
 * Where the *shipped* main bundle lives: `out/main/index.js`.
 *
 * The overlay static directory is resolved relative to the running bundle, and under vitest the
 * "running bundle" is the TypeScript source. Handing the resolver the production module directory
 * is what makes the check below prove something about the app rather than about vitest.
 */
const PRODUCTION_MAIN_DIR = resolvePath(REPO_ROOT, 'out', 'main')

// ---------------------------------------------------------------------------
// Channel classification
// ---------------------------------------------------------------------------

/** A channel this file invokes for real, with a valid argument. */
interface ChannelProbe {
  readonly channel: IpcChannelValue
  readonly arg: unknown
}

/** A channel this file deliberately does not invoke, and why. */
interface SkippedChannel {
  readonly channel: IpcChannelValue
  readonly why: string
}

const SAMPLE_REFERENCE: ScriptureReference = {
  book: 'John',
  spokenBook: 'John',
  chapter: 3,
  verse: 16,
  verseEnd: null,
  confidence: 0.9,
  band: 'exact',
  sourceText: 'John 3:16'
}

/**
 * Every channel that is safe to invoke on an unconfigured machine.
 *
 * "Safe" means: no output is started or stopped, no browser is opened, no socket is dialled, no
 * child process is spawned, and nothing is written outside the temp `userData` directory.
 */
const PROBED_CHANNELS: readonly ChannelProbe[] = [
  { channel: IpcChannel.obsGetStatus, arg: undefined },
  { channel: IpcChannel.obsGetSceneList, arg: undefined },
  { channel: IpcChannel.obsDisconnect, arg: undefined },
  { channel: IpcChannel.configGet, arg: undefined },
  {
    channel: IpcChannel.logWrite,
    arg: { ts: Date.now(), level: 'info', scope: 'wiring', msg: 'wiring probe' }
  },
  { channel: IpcChannel.appGetVersions, arg: undefined },
  { channel: IpcChannel.overlayGetState, arg: undefined },
  { channel: IpcChannel.overlaySend, arg: { channel: 'command', name: 'clearAll', payload: {} } },
  { channel: IpcChannel.overlayGetServerInfo, arg: undefined },
  { channel: IpcChannel.cameraGetConfig, arg: undefined },
  { channel: IpcChannel.cameraSetConfig, arg: defaultCameraConfig() },
  { channel: IpcChannel.cameraGetState, arg: undefined },
  { channel: IpcChannel.cameraSelect, arg: { slot: CAMERA_SLOTS[0] } },
  { channel: IpcChannel.youtubeGetStatus, arg: undefined },
  { channel: IpcChannel.youtubeSignOut, arg: undefined },
  { channel: IpcChannel.youtubeSetTemplate, arg: defaultBroadcastTemplate() },
  { channel: IpcChannel.youtubeCreateBroadcast, arg: {} },
  { channel: IpcChannel.goLiveGetState, arg: undefined },
  { channel: IpcChannel.planGet, arg: undefined },
  { channel: IpcChannel.planSet, arg: emptyServicePlan('wiring probe') },
  { channel: IpcChannel.planOpen, arg: {} },
  { channel: IpcChannel.planSave, arg: {} },
  { channel: IpcChannel.planImportDeck, arg: {} },
  { channel: IpcChannel.planFireCue, arg: { cueId: 'no-such-cue' } },
  { channel: IpcChannel.planAdvance, arg: undefined },
  { channel: IpcChannel.planBack, arg: undefined },
  { channel: IpcChannel.planGetImporterStatus, arg: undefined },
  { channel: IpcChannel.asrGetStatus, arg: undefined },
  { channel: IpcChannel.asrGetSettings, arg: undefined },
  { channel: IpcChannel.asrSetSettings, arg: defaultAsrSettings() },
  { channel: IpcChannel.asrStop, arg: undefined },
  { channel: IpcChannel.asrPushAudio, arg: new ArrayBuffer(3_200) },
  { channel: IpcChannel.asrListDevices, arg: [] },
  { channel: IpcChannel.cueGetState, arg: undefined },
  { channel: IpcChannel.cueGetSettings, arg: undefined },
  { channel: IpcChannel.cueSetSettings, arg: defaultCueEngineSettings() },
  { channel: IpcChannel.cueSetMode, arg: { mode: 'assist' } },
  { channel: IpcChannel.cueConfirm, arg: { suggestionId: 'no-such-suggestion' } },
  { channel: IpcChannel.cueDismiss, arg: { suggestionId: 'no-such-suggestion' } },
  { channel: IpcChannel.cueResume, arg: undefined },
  { channel: IpcChannel.cueResolveScripture, arg: { reference: SAMPLE_REFERENCE } },
  { channel: IpcChannel.cueListTranslations, arg: undefined },
  { channel: IpcChannel.healthGet, arg: undefined },
  { channel: IpcChannel.healthListCheckpoints, arg: undefined },
  { channel: IpcChannel.healthRestoreCheckpoint, arg: { checkpointId: 'no-such-checkpoint' } },
  { channel: IpcChannel.healthReloadOverlays, arg: undefined }
]

/**
 * Channels this file registers but never invokes.
 *
 * Each entry is a promise about consequences, not an admission of weak coverage: the contract of
 * every one of these is proved in its own module's tests against injected seams. What must not
 * happen is this file causing a real one.
 */
const SKIPPED_CHANNELS: readonly SkippedChannel[] = [
  {
    channel: IpcChannel.goLiveStart,
    why: 'destructive: runs the whole GO LIVE sequence — it would push a stream and start a recording'
  },
  {
    channel: IpcChannel.goLiveEnd,
    why: 'destructive: ends the broadcast and stops the stream and the recording'
  },
  {
    channel: IpcChannel.cuePanic,
    why: 'the master automation kill switch; asserted in the cue tests, never pressed here'
  },
  {
    channel: IpcChannel.obsConnect,
    why: 'dials a real websocket and arms the reconnect backoff; OBS Studio is not installed'
  },
  {
    channel: IpcChannel.obsSetConfig,
    why: 'persists an OBS password into the real secrets store and then dials'
  },
  {
    channel: IpcChannel.youtubeSignIn,
    why: 'runs the loopback OAuth consent flow: binds a callback port and opens a browser'
  },
  {
    channel: IpcChannel.asrStart,
    why: 'starts a recogniser: opens a Deepgram websocket or spawns the Python faster-whisper sidecar'
  }
]

// ---------------------------------------------------------------------------
// Production factory manifest
// ---------------------------------------------------------------------------

/**
 * Every production singleton factory, and its reset.
 *
 * The point of the manifest is not that these calls *work* today — it is that a future edit that
 * makes any of them require a mandatory argument breaks a test rather than breaking startup.
 * `src/main/index.ts` and `src/main/ipc/register.ts` both call these with no argument (or with
 * only a logger), so a factory that quietly grows a required parameter is a crash at
 * `app.whenReady()` and nowhere else.
 */
const PRODUCTION_FACTORIES: readonly { readonly name: string; readonly build: () => unknown }[] = [
  { name: 'getObsClient', build: () => getObsClient() },
  { name: 'getOverlayServer', build: () => getOverlayServer() },
  { name: 'getCameraService', build: () => getCameraService() },
  { name: 'getYouTubeService', build: () => getYouTubeService() },
  { name: 'getGoLiveService', build: () => getGoLiveService() },
  { name: 'getPlanService', build: () => getPlanService() },
  { name: 'getAsrService', build: () => getAsrService() },
  { name: 'getCueEngine', build: () => getCueEngine() },
  { name: 'getHealthService', build: () => getHealthService() },
  { name: 'getCheckpointStore', build: () => getCheckpointStore() }
]

/**
 * The structural seams `registerIpc` calls, and the production factory that must satisfy each.
 *
 * `registerIpc` describes its dependencies structurally so it can be unit-tested against plain
 * objects — which is right, and which is also precisely why a production object can drift out of
 * conformance without anything failing to compile: the *interface* is satisfied by the fake in
 * `register.test.ts`, and nothing checks the real one. This table is that check.
 */
const SEAM_CONFORMANCE: readonly {
  readonly seam: string
  readonly factory: string
  readonly build: () => unknown
  readonly methods: readonly string[]
}[] = [
  {
    seam: 'HealthServiceLike',
    factory: 'getHealthService',
    build: () => getHealthService(),
    methods: ['getSnapshot', 'onSnapshot']
  },
  {
    seam: 'CheckpointStoreLike',
    factory: 'getCheckpointStore',
    build: () => getCheckpointStore(),
    methods: ['list', 'restore']
  }
]

/**
 * What `src/main/index.ts` must do, and the bug that proves why.
 *
 * These are checked against the composition root's SOURCE rather than by importing it: that module
 * takes the single-instance lock, installs process-level crash handlers and creates a
 * `BrowserWindow` at import time, so importing it under vitest would be neither safe nor
 * meaningful. A source-level guard is crude, and it is still the only thing standing between this
 * repository and a fifth "built, tested, connected to nothing".
 *
 * If a rename breaks one of these, that rename is exactly the moment to re-read the wiring.
 */
const COMPOSITION_ROOT_DUTIES: readonly {
  readonly what: string
  readonly pattern: RegExp
  readonly why: string
}[] = [
  {
    what: 'starts the overlay server',
    pattern: /overlay\.start\s*\(/,
    why: 'Phase 2: the server was constructed and never started, so port 7320 was never bound and the OBS browser source had nothing to load'
  },
  {
    what: 'restores the Google session',
    pattern: /youtube\.(refresh|restore)\s*\(/,
    why: 'Phase 4: OAuthService starts signed-out because its constructor cannot await the secrets store, so a valid stored token read "signed out" every launch'
  },
  {
    what: 're-attaches to a running broadcast',
    pattern: /goLive\.initialize\s*\(/,
    why: 'Phase 5: without it, a relaunch mid-service leaves GO LIVE looking idle — and pressing it pushes a SECOND stream and starts a SECOND recording'
  },
  {
    what: 'passes an overlay reload channel to registerIpc',
    pattern: /overlayReload\s*:/,
    why: 'Phase 9: `overlayReload` is the one registerIpc dependency that defaults to ABSENT rather than to a singleton, because the watchdog is built here where the overlay server already exists. Unpassed, healthReloadOverlays answers NOT_CONFIGURED forever and the watchdog is wired to nothing'
  }
]

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** A `senderFrame` that looks like the top-level document of a real Verger window. */
const senderFrame = { url: 'file:///verger/out/renderer/index.html' }

/** The `webContents` of the window `registerIpc` will validate senders against. */
const senderContents = {
  mainFrame: senderFrame,
  isDestroyed: (): boolean => false,
  send: (): void => undefined
}

/** What Electron would hand a handler as its first argument. */
const invokeEvent = { senderFrame, sender: senderContents }

/** Invoke a registered handler exactly as `ipcMain` would. */
async function invoke(channel: IpcChannelValue, arg: unknown): Promise<Result<unknown>> {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`no handler is registered for "${channel}"`)
  }
  return (await handler(invokeEvent, arg)) as Result<unknown>
}

/** Register IPC with production defaults: only the three required deps are supplied. */
function registerWithProductionDefaults(): () => void {
  const dispose = registerIpc({
    config: loadConfigFromDisk(),
    logger: createNullLogger(),
    obs: getObsClient()
  })
  return typeof dispose === 'function' ? dispose : (): void => undefined
}

/** One HTTP GET, with a deadline, so a wedged server fails the test instead of hanging it. */
function fetchOnce(
  url: string
): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        const location = response.headers.location
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          location: typeof location === 'string' ? location : null
        })
      })
    })
    request.setTimeout(5_000, () => {
      request.destroy(new Error(`GET ${url} timed out`))
    })
    request.on('error', reject)
  })
}

/**
 * GET, following redirects the way an OBS Browser Source does.
 *
 * `node:http` does not follow redirects and Chromium does, so a bare `fetchOnce` would report a
 * failure the congregation would never see. `express.static` mounted at `/overlay` answers the
 * un-slashed mount path with a `301` to `/overlay/`; see the note on the test below.
 */
async function fetchPage(
  url: string,
  maxRedirects = 3
): Promise<{ status: number; body: string; hops: number }> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchOnce(current)
    const redirecting = response.status >= 300 && response.status < 400
    if (!redirecting || response.location === null) {
      return { status: response.status, body: response.body, hops: hop }
    }
    current = new URL(response.location, current).toString()
  }
  throw new Error(`GET ${url} exceeded ${maxRedirects} redirects`)
}

/** Poll a predicate on the microtask/timer queue until it holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * A recogniser that emits whatever the test hands it.
 *
 * The seam is the *provider*, not the wiring: everything between this object and the cue engine —
 * `AsrService`'s failover policy, its hallucination filter, its transcript fan-out,
 * `getCueEngine()`'s default `asr` resolution and its default scripture detector — is the real
 * production code. That is what makes the Phase 8 assertion below mean something.
 */
class FakeProvider implements AsrProvider {
  private readonly segmentListeners = new Set<(segment: TranscriptSegment) => void>()

  getId(): AsrProviderId {
    return 'whisper'
  }

  isConfigured(): boolean {
    return true
  }

  start(_options: AsrStartOptions): Promise<Result<void>> {
    return Promise.resolve(ok(undefined))
  }

  pushAudio(_chunk: Uint8Array): void {
    // Nothing to do: this provider is driven by `emit`, not by audio.
  }

  stop(): Promise<Result<void>> {
    return Promise.resolve(ok(undefined))
  }

  onSegment(callback: (segment: TranscriptSegment) => void): Unsubscribe {
    this.segmentListeners.add(callback)
    return () => {
      this.segmentListeners.delete(callback)
    }
  }

  onError(): Unsubscribe {
    return () => undefined
  }

  emit(segment: TranscriptSegment): void {
    for (const listener of [...this.segmentListeners]) listener(segment)
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let disposeIpc: (() => void) | null = null

/** Drop every process-wide singleton, so test order can never mask a wiring failure. */
async function resetAllSingletons(): Promise<void> {
  // Health first: it subscribes to every other subsystem, so it must let go before they do.
  resetHealthService()
  resetCueEngine()
  resetPlanService()
  resetGoLiveService()
  resetYouTubeService()
  resetCameraService()
  resetAsrService()
  await resetOverlayServer()
  await resetObsClient()
}

beforeEach(async () => {
  mkdirSync(harness.userData, { recursive: true })
  harness.handlers.clear()
  harness.windows.length = 0
  harness.windows.push({ webContents: senderContents, isDestroyed: (): boolean => false })
  await resetAllSingletons()
})

afterEach(async () => {
  const dispose = disposeIpc
  disposeIpc = null
  if (dispose !== null) dispose()
  await resetAllSingletons()
})

// ---------------------------------------------------------------------------
// 1. Every channel has a handler, with production defaults
// ---------------------------------------------------------------------------

describe('the composition root', () => {
  it('registers a handler for every channel in IPC_CHANNEL_VALUES with production defaults', () => {
    // No overlay, camera, youtube, goLive, plan, asr or cue is passed. Every one of them must be
    // resolved by `registerIpc` itself, from the same singletons the running app uses. This is the
    // single highest-value assertion in the file: it proves the DEFAULT wiring resolves for every
    // subsystem, which is exactly the thing every unit test in this repo is blind to.
    disposeIpc = registerWithProductionDefaults()

    const missing = IPC_CHANNEL_VALUES.filter((channel) => !harness.handlers.has(channel))
    expect(
      missing,
      `these channels are declared in @shared/ipc but no handler was registered: ${missing.join(', ')}`
    ).toEqual([])

    const declared = new Set<string>(IPC_CHANNEL_VALUES)
    const extra = [...harness.handlers.keys()].filter((channel) => !declared.has(channel))
    expect(extra, `handlers registered for undeclared channels: ${extra.join(', ')}`).toEqual([])
  })

  it('classifies every declared channel as either probed or deliberately skipped', () => {
    // A new channel added to `@shared/ipc` must be consciously placed in one list or the other.
    // Without this, a channel could be added, registered, and never invoked by anything — which is
    // the same class of bug this file exists to catch, one level up.
    const covered = new Set<string>([
      ...PROBED_CHANNELS.map((probe) => probe.channel),
      ...SKIPPED_CHANNELS.map((skipped) => skipped.channel)
    ])
    const unclassified = IPC_CHANNEL_VALUES.filter((channel) => !covered.has(channel))
    expect(
      unclassified,
      `add these to PROBED_CHANNELS or SKIPPED_CHANNELS: ${unclassified.join(', ')}`
    ).toEqual([])
    expect(covered.size).toBe(IPC_CHANNEL_VALUES.length)
  })

  it('disposes cleanly, removing every handler it registered', () => {
    const dispose = registerWithProductionDefaults()
    expect(harness.handlers.size).toBe(IPC_CHANNEL_VALUES.length)
    dispose()
    expect(harness.handlers.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Unconfigured is a designed state, never an internal error
// ---------------------------------------------------------------------------

describe('an unconfigured machine', () => {
  it('never answers Err(INTERNAL) on any channel that is safe to invoke', async () => {
    // No OBS Studio, no Google credentials, no Deepgram key, no plan file. That is a FRESH
    // CHECKOUT and it is also a real church PC on the Saturday before anything is set up. Every
    // channel must have a designed answer for it — `NOT_CONFIGURED`, `NOT_CONNECTED`, `NOT_FOUND`
    // or a plain `Ok` — because `INTERNAL` is the code that means "we did not think about this",
    // and an operator cannot act on it.
    disposeIpc = registerWithProductionDefaults()

    const internal: string[] = []
    for (const probe of PROBED_CHANNELS) {
      const result = await invoke(probe.channel, probe.arg)
      expect(result, `${probe.channel} did not return a Result`).toHaveProperty('ok')
      if (!result.ok && result.error.code === ErrorCode.INTERNAL) {
        internal.push(`${probe.channel}: ${result.error.message}`)
      }
    }

    expect(
      internal,
      `these channels returned Err(INTERNAL) on an unconfigured machine:\n${internal.join('\n')}`
    ).toEqual([])
  }, 60_000)

  it('answers every probed channel rather than throwing across the boundary', async () => {
    disposeIpc = registerWithProductionDefaults()

    for (const probe of PROBED_CHANNELS) {
      // `invoke` would reject if the handler threw; `safeHandle` guarantees it cannot.
      const result = await invoke(probe.channel, probe.arg)
      expect(typeof result.ok, `${probe.channel} returned a non-Result`).toBe('boolean')
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 3. The overlay server actually binds and serves (the Phase 2 regression)
// ---------------------------------------------------------------------------

describe('the overlay server', () => {
  it('resolves a production static directory that really contains the overlay page', () => {
    // The Phase 2 bug was that nothing ever bound the port. The near-miss version of the same bug
    // is binding a port and serving a directory with no page in it — the browser source loads, and
    // shows a 404 to the congregation. Both are asserted, in that order.
    const staticDir = resolveOverlayStaticDir({
      isPackaged: false,
      resourcesPath: '',
      moduleDir: PRODUCTION_MAIN_DIR
    })
    expect(
      existsSync(join(staticDir, 'overlay.html')),
      `the resolved overlay static directory (${staticDir}) has no overlay.html`
    ).toBe(true)
  })

  it('binds through its production factory and serves getInfo().pageUrl with HTTP 200', async () => {
    const staticDir = resolveOverlayStaticDir({
      isPackaged: false,
      resourcesPath: '',
      moduleDir: PRODUCTION_MAIN_DIR
    })

    // Port 0, never 7320: this test must be able to run while a developer's Verger is running.
    const server = getOverlayServer({ port: 0, staticDir })
    const started = await server.start()
    expect(started.ok, started.ok ? '' : started.error.message).toBe(true)

    const info = server.getInfo()
    expect(info.running).toBe(true)
    expect(info.port).toBeGreaterThan(0)
    expect(info.port, 'the test must not bind the production port').not.toBe(OVERLAY_SERVER_PORT)

    // `pageUrl` is the exact string `docs/OBS_SETUP.md` and the Overlay panel tell the operator to
    // paste into an OBS Browser Source, so what it must satisfy is what Chromium does with it.
    //
    // Note what this actually observes: `express.static` is mounted at `/overlay`, and a request
    // for the un-slashed mount path answers `301 -> /overlay/` before serving `overlay.html`. A
    // Browser Source follows that transparently, so the overlay does reach the congregation
    // screen — but the first response on the documented URL is a redirect, not the page, and one
    // extra round trip on every browser-source reload is worth knowing about. That is asserted
    // rather than hidden: at most one hop, and the page at the end of it.
    const direct = await fetchOnce(info.pageUrl)
    expect(
      [200, 301, 302, 307, 308],
      `${info.pageUrl} answered ${direct.status}; a Browser Source would show nothing`
    ).toContain(direct.status)

    const page = await fetchPage(info.pageUrl)
    expect(
      page.status,
      `${info.pageUrl} must serve the overlay page — this is the exact URL operators paste into an OBS Browser Source`
    ).toBe(200)
    expect(page.hops, 'the overlay page took more than one redirect to reach').toBeLessThanOrEqual(
      1
    )
    expect(page.body.toLowerCase()).toContain('<html')
  }, 20_000)

  it('reports a running listener to the overlay IPC channels once started', async () => {
    const staticDir = resolveOverlayStaticDir({
      isPackaged: false,
      resourcesPath: '',
      moduleDir: PRODUCTION_MAIN_DIR
    })
    const server = getOverlayServer({ port: 0, staticDir })
    await server.start()

    // The IPC layer must be reading the SAME singleton the app started, not a second instance.
    disposeIpc = registerWithProductionDefaults()
    const result = await invoke(IpcChannel.overlayGetServerInfo, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const info = result.value as { running: boolean; port: number }
      expect(info.running, 'overlayGetServerInfo reported a stopped server after start()').toBe(
        true
      )
      expect(info.port).toBe(server.getInfo().port)
    }
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 4. The cue engine has ears and eyes (the Phase 8 regression)
// ---------------------------------------------------------------------------

describe('the cue engine built with no arguments', () => {
  it('reaches the ASR service for transcripts and holds a scripture detector', async () => {
    // The Phase 8 bug in one sentence: `getCueEngine()` defaulted `plan` and `overlay` but not
    // `asr`, and no scripture detector was ever passed — so the engine was subscribed to nothing
    // and could see nothing, while every engine unit test passed because each one injects a fake
    // transcript source and a fake detector and calls `onTranscript()` by hand.
    //
    // This test injects a fake at the PROVIDER seam instead — the only place a real recogniser
    // would otherwise open a socket or spawn Python — and leaves every layer above it real. A
    // segment therefore travels: provider -> AsrService.handleSegment -> transcript fan-out ->
    // whatever `getCueEngine()` subscribed to -> the engine's real scripture detector -> a
    // suggestion. If either default is ever dropped again, nothing arrives and this fails.
    const provider = new FakeProvider()
    const asr = getAsrService({ providers: [provider] })

    // No arguments. Exactly how `src/main/ipc/register.ts` builds it in production.
    const engine = getCueEngine()

    const suggestions: CueSuggestion[] = []
    const unsubscribe = engine.onSuggestion((suggestion) => {
      suggestions.push(suggestion)
    })

    const started = await asr.start()
    expect(started.ok, started.ok ? '' : started.error.message).toBe(true)

    provider.emit({
      id: 'wiring-span-1',
      text: 'please turn with me to John 3:16',
      isFinal: true,
      tsStart: 0,
      tsEnd: 2_000,
      confidence: 0.95,
      provider: 'whisper',
      isDraft: false
    })

    const arrived = await waitFor(() => suggestions.length > 0)
    unsubscribe()

    expect(
      arrived,
      'no suggestion reached the engine — getCueEngine() has no transcript source or no scripture detector'
    ).toBe(true)

    const first = suggestions[0]
    expect(first).toBeDefined()
    expect(first?.detector, 'the suggestion did not come from the scripture detector').toBe(
      'scripture'
    )
    expect(first?.reference?.book).toBe('John')
    expect(first?.reference?.chapter).toBe(3)
    expect(first?.reference?.verse).toBe(16)

    // Standing Rule 1: a suggestion is an INTENT. In `assist` mode nothing may fire itself.
    const state = engine.getState()
    expect(state.ok).toBe(true)
    if (state.ok) {
      expect(state.value.pending?.id).toBe(first?.id)
      expect(state.value.recent).toEqual([])
    }
  }, 20_000)

  it('is subscribed to the ASR singleton the IPC layer resolves, not a second instance', async () => {
    const provider = new FakeProvider()
    const first = getAsrService({ providers: [provider] })
    // The second call must return the same object; a factory that rebuilt would give the engine a
    // transcript source nobody else ever pushes to.
    expect(getAsrService()).toBe(first)
    expect(getCueEngine()).toBe(getCueEngine())
  })
})

// ---------------------------------------------------------------------------
// 5. GoLiveService re-attaches rather than starting fresh (the Phase 5 regression)
// ---------------------------------------------------------------------------

describe('the go-live service at startup', () => {
  it('adopts an OBS that is already streaming instead of starting a second one', async () => {
    // The Phase 5 bug: `initialize()` existed, was tested, and was never called. Its failure mode
    // is the worst one this app has — a relaunch mid-service, an operator pressing GO LIVE, and a
    // SECOND stream plus a SECOND recording during an un-repeatable event.
    let startCalls = 0
    let stopCalls = 0

    const running: ObsOutputState = {
      ...emptyObsOutputState(),
      streaming: true,
      recording: true,
      streamTimecodeMs: 12 * 60 * 1_000,
      recordTimecodeMs: 12 * 60 * 1_000,
      recordingPath: 'C:/verger/recordings/service.mkv'
    }

    const outputs: GoLiveOutputs = {
      readOutputState: () => Promise.resolve(ok(running)),
      startStreamAndRecord: () => {
        startCalls += 1
        return Promise.resolve(
          ok({ streaming: true, recording: true } as unknown as StartOutputsSummary)
        )
      },
      stopStream: () => {
        stopCalls += 1
        return Promise.resolve(ok(undefined))
      },
      stopRecord: () => {
        stopCalls += 1
        return Promise.resolve(ok(undefined))
      }
    }

    const service = getGoLiveService({ outputs })
    const result = await service.initialize()

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return

    expect(result.value.reattached, 'initialize() did not re-attach to a running OBS').toBe(true)
    expect(result.value.phase).toBe('live')
    expect(result.value.obs.streaming).toBe(true)
    expect(result.value.obs.recording).toBe(true)

    // The whole point: re-attaching issues no Start* and no Stop* of any kind.
    expect(startCalls, 'a re-attach started a SECOND stream and recording').toBe(0)
    expect(stopCalls, 'a re-attach stopped an output — no recovery action may ever do that').toBe(0)
  })

  it('reports nothing in progress when OBS is idle, without touching any output', async () => {
    let startCalls = 0
    let stopCalls = 0

    const outputs: GoLiveOutputs = {
      readOutputState: () => Promise.resolve(ok(emptyObsOutputState())),
      startStreamAndRecord: () => {
        startCalls += 1
        return Promise.resolve(
          ok({ streaming: true, recording: true } as unknown as StartOutputsSummary)
        )
      },
      stopStream: () => {
        stopCalls += 1
        return Promise.resolve(ok(undefined))
      },
      stopRecord: () => {
        stopCalls += 1
        return Promise.resolve(ok(undefined))
      }
    }

    const result = await getGoLiveService({ outputs }).initialize()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.reattached).toBe(false)
    expect(startCalls).toBe(0)
    expect(stopCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. The production factory manifest
// ---------------------------------------------------------------------------

describe('the production factory manifest', () => {
  it.each(PRODUCTION_FACTORIES.map((factory) => [factory.name, factory] as const))(
    '%s is zero-arg callable and returns an object',
    (name, factory) => {
      const built: unknown = factory.build()
      expect(built, `${name}() returned nothing`).toBeDefined()
      expect(built).not.toBeNull()
      expect(typeof built, `${name}() must return an object`).toBe('object')
    }
  )

  it.each(SEAM_CONFORMANCE.map((entry) => [`${entry.factory} -> ${entry.seam}`, entry] as const))(
    '%s: the production object really implements the seam registerIpc calls',
    (_label, entry) => {
      // A structural seam is satisfied at compile time by whatever `register.test.ts` injects, so
      // nothing checks that the PRODUCTION object still has the methods. When it does not, the
      // failure is `Err(INTERNAL)` at runtime — on, in this case, the recovery controls an operator
      // reaches for only when something has already gone wrong.
      const built = entry.build() as Record<string, unknown>
      const missing = entry.methods.filter((method) => typeof built[method] !== 'function')
      expect(
        missing,
        `${entry.factory}() does not implement ${entry.seam}; missing: ${missing.join(', ')}`
      ).toEqual([])
    }
  )

  it.each(COMPOSITION_ROOT_DUTIES.map((duty) => [duty.what, duty] as const))(
    'src/main/index.ts %s',
    (_what, duty) => {
      const source = readFileSync(resolvePath(MAIN_DIR, 'index.ts'), 'utf8')
      expect(
        duty.pattern.test(source),
        `src/main/index.ts no longer ${duty.what}.\n\n${duty.why}\n\nA subsystem that is constructed but never connected passes every unit test in this repository. That is the bug this file exists to catch — see docs/WIRING.md.`
      ).toBe(true)
    }
  )

  it('builds every factory in one process without any of them dialling, spawning or binding', () => {
    // Construction must be inert. `src/main/index.ts` builds these inside `app.whenReady()` before
    // a window exists; a factory that opened a socket or spawned a child process as a side effect
    // of construction would make startup fail on a machine with no OBS and no GPU — which is every
    // machine this repo has been built on.
    for (const factory of PRODUCTION_FACTORIES) {
      expect(() => factory.build(), `${factory.name}() threw during construction`).not.toThrow()
    }

    // The overlay server in particular is constructed here and must NOT be listening: binding as a
    // side effect of an import is how two Verger instances fight over port 7320.
    expect(getOverlayServer().getInfo().running).toBe(false)
  })
})
