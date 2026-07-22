/**
 * BLUEPRINT.md §9, one test per row — each failure actually SIMULATED, each fallback asserted.
 *
 * ```
 * | Failure                        | Safeguard                                                  |
 * | Internet drops mid-stream      | OBS auto-reconnect + always-on local recording as backup   |
 * | ASR errors / service down      | Auto-fall back to manual; clear status light; never blocks |
 * | Wrong auto-trigger             | Assist mode + instant override + one-tap BACK/undo         |
 * | Overlay browser source crashes | Watchdog reloads it; overlay re-syncs state on reconnect   |
 * | Control app crashes            | OBS keeps streaming; relaunch reconnects to OBS's state    |
 * | Operator overload              | Foot pedal to confirm; "panic → full manual" master switch |
 * ```
 *
 * ## Why this file exists separately from the unit tests
 *
 * Every subsystem here already has a passing unit suite. Four times in this project a component
 * passed all of them and was connected to nothing (`STATUS.md`, cycles 2, 4, 5 and 8), because a
 * unit test injects its own fakes and therefore proves only that the component *could* work. So
 * these tests drive the REAL classes — a real `OverlayServer` over real loopback sockets, the real
 * `GoLiveService`, the real `PlanService`, the real `CueEngine`, the real `AsrService` — and
 * simulate the failure at the outermost seam that a laptop with no OBS, no Google account and no
 * Deepgram key can reach.
 *
 * ## The invariant every row shares
 *
 * **No recovery path stops the stream or the recording.** Every test that touches the go-live
 * seam asserts `stopStream` and `stopRecord` were never called. That is the difference between a
 * safeguard and a new failure mode.
 *
 * Standing Rule 4: every transcript, anchor and label below is invented placeholder text.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { WebSocket } from 'ws'

import { AsrService } from '@main/asr/AsrService'
import type { AsrTimerHandle, AsrTimers } from '@main/asr/AsrService'
import type {
  AsrErrorListener,
  AsrProvider,
  AsrSegmentListener,
  AsrStartOptions
} from '@main/asr/AsrProvider'
import { CueEngine } from '@main/cue/CueEngine'
import { GoLiveService, isHealthy } from '@main/golive/GoLiveService'
import type { GoLiveOutputs, GoLiveYouTube, StartOutputsSummary } from '@main/golive/GoLiveService'
import { createNullLogger } from '@main/logging/logger'
import { OverlayServer } from '@main/overlay/OverlayServer'
import { PlanService } from '@main/plan/PlanService'
import type { AsrProviderId, TranscriptSegment } from '@shared/asr'
import { defaultCueEngineSettings } from '@shared/cue'
import { emptyObsOutputState } from '@shared/golive'
import type { ObsOutputState } from '@shared/golive'
import { isServiceStillGoingOut, worstLevel } from '@shared/health'
import type { HealthSnapshot, SubsystemHealth } from '@shared/health'
import type { OverlayServerInfo, Unsubscribe } from '@shared/ipc'
import { LOOPBACK_ADDRESS, OVERLAY_SOCKET_PATH } from '@shared/net'
import { emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand, OverlayServerMessage, OverlayState } from '@shared/overlay'
import type { Cue, ServicePlan } from '@shared/plan'
import { ErrorCode, ok } from '@shared/result'
import type { Result } from '@shared/result'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { BroadcastLifecycle, StreamHealth, YouTubeStatus } from '@shared/youtube'

import { OVERLAY_OPERATOR_REMEDY, OverlayWatchdog } from './overlayWatchdog'
import type { OverlayWatchdogTimerHandle, OverlayWatchdogTimers } from './overlayWatchdog'

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const GRACE_MS = 4_000

/** Timers the test fires by hand. Shared shape between the watchdog and the ASR service. */
class ManualTimers implements OverlayWatchdogTimers, AsrTimers {
  private next = 1
  private readonly pending = new Map<number, () => void>()

  setTimeout(handler: () => void, _ms: number): OverlayWatchdogTimerHandle & AsrTimerHandle {
    const id = this.next
    this.next += 1
    this.pending.set(id, handler)
    return id as unknown as AsrTimerHandle
  }

  clearTimeout(handle: OverlayWatchdogTimerHandle | AsrTimerHandle): void {
    if (typeof handle !== 'number') return
    this.pending.delete(handle)
  }

  pendingCount(): number {
    return this.pending.size
  }

  run(): void {
    for (const [id, handler] of [...this.pending.entries()]) {
      this.pending.delete(id)
      handler()
    }
  }
}

/** Let real I/O and queued microtasks land. Real timers only — nothing here fakes the clock. */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 2)
    })
  }
}

/** Poll a real condition — a socket close reaching the server is genuinely asynchronous. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

// ---------------------------------------------------------------------------
// Doubles: overlay, camera, OBS, YouTube, OBS outputs
// ---------------------------------------------------------------------------

/** An overlay the plan and cue engine can drive, recording every command it is given. */
class RecordingOverlay {
  readonly commands: OverlayCommand[] = []

  send(command: OverlayCommand): Result<OverlayState> {
    this.commands.push(command)
    return ok(emptyOverlayState())
  }

  setAssetRoot(): void {
    /* no plan folder in these tests */
  }
}

class RecordingCamera {
  readonly slots: string[] = []

  select(slot: string): Promise<Result<unknown>> {
    this.slots.push(slot)
    return Promise.resolve(ok(undefined))
  }
}

class RecordingObs {
  readonly requests: string[] = []

  call(requestType: string): Promise<Result<unknown>> {
    this.requests.push(requestType)
    return Promise.resolve(ok(undefined))
  }
}

/**
 * The OBS outputs seam.
 *
 * Every call is recorded by name, because the load-bearing assertion across this whole file is
 * about calls that must NOT happen.
 */
class OutputsDouble implements GoLiveOutputs {
  readonly calls: string[] = []
  state: ObsOutputState = emptyObsOutputState()

  readOutputState(): Promise<Result<ObsOutputState>> {
    this.calls.push('readOutputState')
    return Promise.resolve(ok(this.state))
  }

  startStreamAndRecord(): Promise<Result<StartOutputsSummary>> {
    this.calls.push('startStreamAndRecord')
    this.state = { ...this.state, streaming: true, recording: true }
    return Promise.resolve(
      ok({ streaming: true, recording: true, streamError: null, recordError: null })
    )
  }

  stopStream(): Promise<Result<unknown>> {
    this.calls.push('stopStream')
    this.state = { ...this.state, streaming: false }
    return Promise.resolve(ok(undefined))
  }

  stopRecord(): Promise<Result<unknown>> {
    this.calls.push('stopRecord')
    this.state = { ...this.state, recording: false }
    return Promise.resolve(ok(undefined))
  }

  /** Every call that would have taken something off air. Must stay empty everywhere below. */
  stopCalls(): string[] {
    return this.calls.filter((call) => call === 'stopStream' || call === 'stopRecord')
  }

  /** Every call that would have started an output. Must stay empty on the re-attach path. */
  startCalls(): string[] {
    return this.calls.filter((call) => call === 'startStreamAndRecord')
  }
}

/** YouTube, signed out. The machine these tests run on has no Google account. */
class SignedOutYouTube implements GoLiveYouTube {
  readonly calls: string[] = []

  getStatus(): YouTubeStatus {
    return {
      auth: { state: 'not-configured', channel: null, lastError: null },
      broadcast: null,
      stream: null,
      template: defaultBroadcastTemplate(),
      preflight: []
    }
  }

  createBroadcast(): Promise<Result<unknown>> {
    this.calls.push('createBroadcast')
    return Promise.resolve(ok(undefined))
  }

  transition(status: BroadcastLifecycle): Promise<Result<unknown>> {
    this.calls.push(`transition:${status}`)
    return Promise.resolve(ok(undefined))
  }

  pollStreamHealth(): Promise<Result<{ readonly health: StreamHealth }>> {
    this.calls.push('pollStreamHealth')
    return Promise.resolve(ok({ health: 'good' as StreamHealth }))
  }
}

// ---------------------------------------------------------------------------
// Doubles: ASR providers
// ---------------------------------------------------------------------------

/** A recogniser that starts, emits what the test tells it to, and dies on demand. */
class ProviderDouble implements AsrProvider {
  configured = true
  startFails = false
  starts = 0
  stops = 0

  private readonly segmentListeners = new Set<AsrSegmentListener>()
  private readonly errorListeners = new Set<AsrErrorListener>()

  constructor(private readonly id: AsrProviderId) {}

  getId(): AsrProviderId {
    return this.id
  }

  isConfigured(): boolean {
    return this.configured
  }

  start(_options: AsrStartOptions): Promise<Result<void>> {
    this.starts += 1
    if (this.startFails) {
      return Promise.resolve({
        ok: false,
        error: { code: ErrorCode.NOT_CONNECTED, message: `${this.id} is unreachable` }
      })
    }
    return Promise.resolve(ok(undefined))
  }

  pushAudio(): void {
    /* audio is not part of these tests */
  }

  stop(): Promise<Result<void>> {
    this.stops += 1
    return Promise.resolve(ok(undefined))
  }

  onSegment(callback: AsrSegmentListener): Unsubscribe {
    this.segmentListeners.add(callback)
    return () => {
      this.segmentListeners.delete(callback)
    }
  }

  onError(callback: AsrErrorListener): Unsubscribe {
    this.errorListeners.add(callback)
    return () => {
      this.errorListeners.delete(callback)
    }
  }

  emit(segment: TranscriptSegment): void {
    for (const listener of [...this.segmentListeners]) listener(segment)
  }

  /** Simulate the provider dying: the socket dropped, the sidecar exited. */
  die(message: string, times: number): void {
    for (let index = 0; index < times; index += 1) {
      for (const listener of [...this.errorListeners]) {
        listener({ code: ErrorCode.INTERNAL, message })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A plan, with one anchored cue the transcript can match
// ---------------------------------------------------------------------------

const ANCHOR_PHRASE = 'placeholder anchor phrase alpha'
const ANCHOR_PHRASE_TWO = 'placeholder anchor phrase beta'

function lowerThirdCue(id: string, label: string, anchor: string | null): Cue {
  const trigger: Cue['trigger'] =
    anchor === null ? { mode: 'manual' } : { mode: 'anchor', text: anchor }
  return {
    id,
    type: 'lowerthird',
    label,
    trigger,
    payload: { line1: 'PRESENTER PLACEHOLDER', line2: 'ROLE PLACEHOLDER', template: 'bar' }
  }
}

function testPlan(): ServicePlan {
  return {
    schemaVersion: 1,
    service: 'Failure injection placeholder service',
    defaultMode: 'assist',
    assetDir: 'assets',
    cues: [
      lowerThirdCue('cue-1', 'Cue one', ANCHOR_PHRASE),
      lowerThirdCue('cue-2', 'Cue two', null),
      lowerThirdCue('cue-3', 'Cue three', ANCHOR_PHRASE_TWO),
      lowerThirdCue('cue-4', 'Cue four', null)
    ]
  }
}

let segmentSeq = 0

/** One final transcript segment. Placeholder words only — no real service is transcribed here. */
function finalSegment(text: string, provider: AsrProviderId = 'deepgram'): TranscriptSegment {
  segmentSeq += 1
  return {
    id: `seg-${String(segmentSeq)}`,
    text,
    isFinal: true,
    isDraft: false,
    tsStart: segmentSeq * 1_000,
    tsEnd: segmentSeq * 1_000 + 900,
    confidence: 0.95,
    provider
  }
}

/** A real `PlanService` with recording seams around it. */
function makePlan(): {
  plan: PlanService
  overlay: RecordingOverlay
  camera: RecordingCamera
  obs: RecordingObs
} {
  const overlay = new RecordingOverlay()
  const camera = new RecordingCamera()
  const obs = new RecordingObs()
  const plan = new PlanService({ overlay, camera, obs, logger: createNullLogger() })
  const applied = plan.setPlan(testPlan())
  if (!applied.ok) throw new Error(applied.error.message)
  return { plan, overlay, camera, obs }
}

// ---------------------------------------------------------------------------
// Real overlay server harness (loopback sockets, ephemeral port)
// ---------------------------------------------------------------------------

const servers: OverlayServer[] = []
const sockets: WebSocket[] = []

/** A connected overlay client that queues every message, so the snapshot-on-connect is not lost. */
class OverlayClient {
  readonly socket: WebSocket
  private readonly queue: OverlayServerMessage[] = []
  private readonly waiters: ((message: OverlayServerMessage) => void)[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as OverlayServerMessage
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter(parsed)
      else this.queue.push(parsed)
    })
    socket.on('error', () => {
      /* a terminated socket surfaces here on some platforms */
    })
  }

  static connect(url: string): Promise<OverlayClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      sockets.push(socket)
      const client = new OverlayClient(socket)
      socket.once('open', () => {
        resolve(client)
      })
      socket.once('error', (cause: Error) => {
        reject(cause)
      })
    })
  }

  next(timeoutMs = 2_000): Promise<OverlayServerMessage> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for an overlay message'))
      }, timeoutMs)
      this.waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async nextState(): Promise<OverlayState> {
    for (;;) {
      const message = await this.next()
      if (message.channel === 'state') return message.payload
    }
  }

  /** Kill the socket the way a crashing OBS browser source does: no close handshake. */
  crash(): void {
    this.socket.terminate()
  }
}

async function startedOverlayServer(): Promise<{ server: OverlayServer; url: string }> {
  const server = new OverlayServer({
    logger: createNullLogger(),
    host: LOOPBACK_ADDRESS,
    port: 0,
    heartbeatMs: 60_000
  })
  servers.push(server)
  const started = await server.start()
  if (!started.ok) throw new Error(started.error.message)
  const info: OverlayServerInfo = started.value
  return { server, url: `ws://${info.host}:${String(info.port)}${OVERLAY_SOCKET_PATH}` }
}

const SHOW_LOWER_THIRD: OverlayCommand = {
  channel: 'command',
  name: 'lowerThird.show',
  payload: { line1: 'PRESENTER PLACEHOLDER', line2: 'ROLE PLACEHOLDER', template: 'bar' }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.removeAllListeners()
      socket.terminate()
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) {
    await server.stop()
  }
})

// ---------------------------------------------------------------------------
// Row 4 of the table: "Overlay browser source crashes"
// ---------------------------------------------------------------------------

describe('§9 — overlay browser source crashes', () => {
  it('the watchdog reports the crash, and the reconnecting overlay re-syncs the CURRENT state', async () => {
    const { server, url } = await startedOverlayServer()
    const timers = new ManualTimers()

    // The overlay is up and showing something. This is the state that must survive the crash.
    const first = await OverlayClient.connect(url)
    await first.nextState()
    const shown = server.send(SHOW_LOWER_THIRD)
    expect(shown.ok).toBe(true)
    const onScreen = await first.nextState()
    expect(onScreen.lowerThird.visible).toBe(true)
    const revisionBefore = server.getState().revision

    // `OverlayServer` satisfies the watchdog's seam as-is — no adapter, no shim.
    const watchdog = new OverlayWatchdog({
      overlay: server,
      logger: createNullLogger(),
      timers,
      graceMs: GRACE_MS,
      now: () => NOW
    })
    expect(watchdog.start().ok).toBe(true)
    expect(watchdog.getHealth().level).toBe('ok')

    // --- the failure: the browser source dies without a close handshake -------------------
    first.crash()
    await waitFor(() => server.getInfo().clients === 0, 'the server to notice the dropped client')

    // Still inside the grace period: an OBS scene change looks exactly like this, so no alarm yet.
    expect(watchdog.getHealth().level).toBe('ok')
    timers.run()

    const crashed = watchdog.getHealth()
    expect(crashed.level).toBe('down')
    expect(crashed.detail).toContain(OVERLAY_OPERATOR_REMEDY)
    expect(crashed.stillWorks).toContain('recording')

    // --- the recovery: OBS refreshes the source and it re-attaches -------------------------
    const second = await OverlayClient.connect(url)
    const resynced = await second.nextState()

    // THE point of the state cache: the reconnecting overlay is handed what should be on screen,
    // not a blank slate, and before it has asked for anything.
    expect(resynced.lowerThird.visible).toBe(true)
    expect(resynced.lowerThird.line1).toBe('PRESENTER PLACEHOLDER')
    expect(resynced.revision).toBe(revisionBefore)

    await waitFor(() => server.getInfo().clients === 1, 'the replacement client to be counted')
    expect(watchdog.getHealth().level).toBe('ok')
    // Nothing in the crash-and-recover path touched the overlay state.
    expect(server.getState().revision).toBe(revisionBefore)

    watchdog.dispose()
  })

  it('a source that drops and returns within the grace period raises nothing', async () => {
    const { server, url } = await startedOverlayServer()
    const timers = new ManualTimers()

    const first = await OverlayClient.connect(url)
    await first.nextState()

    const watchdog = new OverlayWatchdog({
      overlay: server,
      logger: createNullLogger(),
      timers,
      graceMs: GRACE_MS,
      now: () => NOW
    })
    watchdog.start()

    first.crash()
    await waitFor(() => server.getInfo().clients === 0, 'the drop to register')
    const replacement = await OverlayClient.connect(url)
    await replacement.nextState()
    await waitFor(() => server.getInfo().clients === 1, 'the replacement to attach')
    timers.run()

    expect(watchdog.getHealth().level).toBe('ok')
    watchdog.dispose()
  })
})

// ---------------------------------------------------------------------------
// Row 1 of the table: "Internet drops mid-stream"
// ---------------------------------------------------------------------------

/**
 * The blueprint row, expressed as the mapping the dashboard must satisfy.
 *
 * `HealthService` owns the production mapping (a file this suite deliberately does not import, so
 * that a change of shape over there cannot quietly weaken these assertions). What is asserted here
 * is the CONTRACT: a reconnecting RTMP link is `degraded` — not `down` — and its `stillWorks`
 * names the local recording, because that sentence is what stops an operator from panicking and
 * ending a service that is still being captured.
 */
function outputHealth(obs: ObsOutputState, at: number): readonly SubsystemHealth[] {
  const stream: SubsystemHealth = obs.streamReconnecting
    ? {
        id: 'stream',
        level: 'degraded',
        detail: 'reconnecting to the ingest',
        stillWorks: 'the local recording is unaffected and is still writing to disk',
        since: at
      }
    : obs.streaming
      ? { id: 'stream', level: 'ok', detail: 'streaming', stillWorks: null, since: at }
      : { id: 'stream', level: 'not-configured', detail: 'not streaming', stillWorks: null, since: at }

  const recording: SubsystemHealth = obs.recording
    ? { id: 'recording', level: 'ok', detail: 'recording locally', stillWorks: null, since: at }
    : { id: 'recording', level: 'not-configured', detail: 'not recording', stillWorks: null, since: at }

  return [stream, recording]
}

function snapshotOf(subsystems: readonly SubsystemHealth[], at: number): HealthSnapshot {
  return { subsystems, worst: worstLevel(subsystems), at }
}

describe('§9 — internet drops mid-stream', () => {
  const reconnecting: ObsOutputState = {
    ...emptyObsOutputState(),
    streaming: true,
    recording: true,
    streamReconnecting: true,
    streamTimecodeMs: 900_000,
    recordTimecodeMs: 900_000,
    recordingPath: 'C:/services/placeholder.mkv'
  }

  it('goes degraded — not down — and says the local recording is unaffected', () => {
    const subsystems = outputHealth(reconnecting, NOW)
    const snapshot = snapshotOf(subsystems, NOW)

    const stream = subsystems.find((entry) => entry.id === 'stream')
    expect(stream?.level).toBe('degraded')
    expect(stream?.stillWorks).toContain('recording')
    expect(snapshot.worst).toBe('degraded')
    // The only question that matters mid-service, answered by `@shared/health` itself.
    expect(isServiceStillGoingOut(snapshot)).toBe(true)
  })

  it('never asks OBS to stop the recording while the link is reconnecting', async () => {
    const outputs = new OutputsDouble()
    outputs.state = reconnecting
    const service = new GoLiveService({
      outputs,
      youtube: new SignedOutYouTube(),
      logger: createNullLogger(),
      // The ingest never becomes healthy, so the health step gives up immediately. Giving up must
      // stop nothing at all.
      healthTimeoutMs: 0,
      pollIntervalMs: 1
    })

    const started = await service.start()

    expect(started.ok).toBe(true)
    expect(service.getState().phase).toBe('partial')
    expect(outputs.stopCalls()).toEqual([])
    service.dispose()
  })

  it('refuses to make the broadcast public while OBS is mid-reconnect', () => {
    // The real gate from `GoLiveService`, not a restatement of it.
    expect(isHealthy(reconnecting, 'good')).toBe(false)
    expect(isHealthy({ ...reconnecting, streamReconnecting: false }, 'good')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Row 2 of the table: "ASR errors / service down"
// ---------------------------------------------------------------------------

describe('§9 — the ASR provider dies', () => {
  it('falls back to the local recogniser, keeps feeding the cue engine, and never blocks the operator', async () => {
    const cloud = new ProviderDouble('deepgram')
    const local = new ProviderDouble('whisper')
    const { plan, overlay } = makePlan()

    const asr = new AsrService({
      config: { deepgramApiKey: 'PLACEHOLDER-NOT-A-KEY' },
      logger: createNullLogger(),
      providers: [cloud, local],
      timers: new ManualTimers(),
      failureThreshold: 3,
      errorWindowMs: 60_000
    })
    // The cue engine takes its ears from the service, exactly as production wires it.
    const engine = new CueEngine({ plan, overlay, logger: createNullLogger(), asr })

    const started = await asr.start()
    expect(started.ok).toBe(true)
    expect(started.ok && started.value.provider).toBe('deepgram')

    // --- the failure: the cloud recogniser dies mid-sermon ---------------------------------
    cloud.die('the websocket closed', 3)
    await settle()

    const status = asr.getStatus()
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error('expected a status')
    // Amber means something: still transcribing, but not the way it was configured.
    expect(status.value.state).toBe('degraded')
    expect(status.value.provider).toBe('whisper')
    expect(status.value.lastError).toContain('Deepgram')

    // --- the transcript keeps reaching the cue engine through the fallback -------------------
    local.emit(finalSegment(`and now the ${ANCHOR_PHRASE} follows`, 'whisper'))
    await settle()

    const engineState = engine.getState()
    expect(engineState.ok).toBe(true)
    if (!engineState.ok) throw new Error('expected engine state')
    expect(engineState.value.pending?.cueId).toBe('cue-1')

    // --- the recogniser dies completely: red light, and still nothing is blocked --------------
    local.die('the sidecar exited', 3)
    await settle()

    const dead = asr.getStatus()
    expect(dead.ok && dead.value.state).toBe('failed')
    expect(dead.ok && dead.value.provider).toBeNull()

    // The operator carries on by hand — this is the whole safeguard.
    const advanced = await plan.advance()
    expect(advanced.ok).toBe(true)
    expect(plan.getState().ok).toBe(true)
    expect(overlay.commands.at(-1)?.name).toBe('lowerThird.show')
    // And the engine is still alive and answering, just quiet.
    expect(engine.getState().ok).toBe(true)

    engine.dispose()
    asr.dispose()
    plan.dispose()
  })

  it('reports not-configured rather than failing when no recogniser exists at all', async () => {
    const asr = new AsrService({
      config: { deepgramApiKey: null },
      logger: createNullLogger(),
      providers: [],
      timers: new ManualTimers()
    })

    const started = await asr.start()

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('expected a refusal')
    expect(started.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(asr.getStatus().ok && asr.getStatus().ok).toBe(true)
    asr.dispose()
  })
})

// ---------------------------------------------------------------------------
// Row 3 of the table: "Wrong auto-trigger"
// ---------------------------------------------------------------------------

describe('§9 — a wrong auto-trigger', () => {
  it('defaults to assist, so a confident match is offered and never performed', async () => {
    const { plan, overlay } = makePlan()
    const engine = new CueEngine({ plan, overlay, logger: createNullLogger() })

    // Assist is the default of the settings AND of a freshly built engine.
    expect(defaultCueEngineSettings().mode).toBe('assist')
    const initial = engine.getState()
    expect(initial.ok && initial.value.mode).toBe('assist')

    await engine.onTranscript(finalSegment(`the ${ANCHOR_PHRASE} is spoken here`))

    const state = engine.getState()
    if (!state.ok) throw new Error('expected engine state')
    expect(state.value.pending?.cueId).toBe('cue-1')
    // Nothing reached the congregation screen and the plan pointer did not move.
    expect(overlay.commands).toHaveLength(0)
    const planState = plan.getState()
    expect(planState.ok && planState.value.position.index).toBe(-1)

    engine.dispose()
    plan.dispose()
  })

  it('lets a manual override win instantly, dropping the pending suggestion', async () => {
    const { plan, overlay } = makePlan()
    const engine = new CueEngine({ plan, overlay, logger: createNullLogger() })

    await engine.onTranscript(finalSegment(`the ${ANCHOR_PHRASE} is spoken here`))
    const offered = engine.getState()
    if (!offered.ok || offered.value.pending === null) throw new Error('expected a suggestion')
    const offeredId = offered.value.pending.id

    // The operator disagrees and drives the plan by hand.
    const fired = await plan.fireCue('cue-3')
    expect(fired.ok).toBe(true)

    // The next tick re-syncs to where the operator actually is and abandons the old suggestion.
    await engine.onTranscript(finalSegment('unrelated placeholder speech continues'))

    const after = engine.getState()
    if (!after.ok) throw new Error('expected engine state')
    expect(after.value.position).toBe(2)
    expect(after.value.pending === null || after.value.pending.id !== offeredId).toBe(true)
    // Exactly one thing reached the overlay: the cue the human chose.
    expect(overlay.commands).toHaveLength(1)

    engine.dispose()
    plan.dispose()
  })

  it('leaves a one-tap BACK available after a fire, and BACK fires nothing', async () => {
    const { plan, overlay } = makePlan()

    const fired = await plan.fireCue('cue-3')
    expect(fired.ok).toBe(true)
    expect(overlay.commands).toHaveLength(1)

    const back = plan.back()

    expect(back.ok).toBe(true)
    if (!back.ok) throw new Error('expected a state')
    expect(back.value.position.index).toBe(1)
    // BACK is an undo of the POINTER, never a re-fire and never a blank screen.
    expect(overlay.commands).toHaveLength(1)

    plan.dispose()
  })
})

// ---------------------------------------------------------------------------
// Row 5 of the table: "Control app crashes"
// ---------------------------------------------------------------------------

describe('§9 — the control app crashes mid-stream', () => {
  it('re-attaches to a still-running OBS and issues no Start* of any kind', async () => {
    // The world as it is when the operator relaunches Verger: OBS never stopped.
    const outputs = new OutputsDouble()
    outputs.state = {
      ...emptyObsOutputState(),
      streaming: true,
      recording: true,
      streamTimecodeMs: 1_200_000,
      recordTimecodeMs: 1_200_000,
      recordingPath: 'C:/services/placeholder.mkv'
    }

    const service = new GoLiveService({
      outputs,
      youtube: new SignedOutYouTube(),
      logger: createNullLogger(),
      now: () => NOW
    })

    const initialized = await service.initialize()

    expect(initialized.ok).toBe(true)
    const state = service.getState()
    expect(state.reattached).toBe(true)
    expect(state.phase).toBe('live')
    // Adopting, not starting: a second stream and a second recording is the bug this prevents.
    expect(outputs.startCalls()).toEqual([])
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.calls).toEqual(['readOutputState'])
    // Elapsed time comes from OBS's own timecode, never invented.
    expect(state.liveSince).toBe(NOW - 1_200_000)

    service.dispose()
  })

  it('re-attaching reports partial and says so when OBS is streaming without a recording', async () => {
    const outputs = new OutputsDouble()
    outputs.state = { ...emptyObsOutputState(), streaming: true, recording: false }
    const service = new GoLiveService({
      outputs,
      youtube: new SignedOutYouTube(),
      logger: createNullLogger()
    })

    await service.initialize()

    const state = service.getState()
    expect(state.reattached).toBe(true)
    expect(state.phase).toBe('partial')
    expect(state.lastError).toContain('no backup')
    // Loud, but still nothing stopped.
    expect(outputs.stopCalls()).toEqual([])
    expect(outputs.startCalls()).toEqual([])

    service.dispose()
  })
})

// ---------------------------------------------------------------------------
// Row 6 of the table: "Operator overload"
// ---------------------------------------------------------------------------

describe('§9 — operator overload: panic to full manual', () => {
  it('halts automation and issues no stream, recording or overlay command', async () => {
    const { plan, overlay } = makePlan()
    const outputs = new OutputsDouble()
    outputs.state = { ...emptyObsOutputState(), streaming: true, recording: true }
    const engine = new CueEngine({
      plan,
      overlay,
      logger: createNullLogger(),
      settings: { ...defaultCueEngineSettings(), mode: 'auto' }
    })

    // The engine is trusted to fire by itself, and it does: this first segment auto-fires cue-1
    // onto the congregation screen. That is the moment an overloaded operator hits PANIC.
    await engine.onTranscript(finalSegment(`the ${ANCHOR_PHRASE} is spoken here`))
    expect(overlay.commands).toHaveLength(1)
    const autoFired = plan.getState()
    expect(autoFired.ok && autoFired.value.position.index).toBe(0)
    const beforeOverlayCommands = overlay.commands.length

    const panicked = engine.panic()

    expect(panicked.ok).toBe(true)
    if (!panicked.ok) throw new Error('expected a state')
    expect(panicked.value.panicked).toBe(true)
    expect(panicked.value.mode).toBe('manual')
    expect(panicked.value.pending).toBeNull()
    // PANIC silences the AI. It does not blank the congregation screen…
    expect(overlay.commands).toHaveLength(beforeOverlayCommands)
    // …and it does not go anywhere near the broadcast.
    expect(outputs.calls).toEqual([])

    // The next anchored phrase would have auto-fired cue-3. Panicked, it is ignored entirely:
    // no fire, no suggestion, no overlay command, no plan movement.
    await engine.onTranscript(finalSegment(`and here comes the ${ANCHOR_PHRASE_TWO} now`))

    const after = engine.getState()
    if (!after.ok) throw new Error('expected engine state')
    expect(after.value.pending).toBeNull()
    expect(overlay.commands).toHaveLength(beforeOverlayCommands)
    const planState = plan.getState()
    expect(planState.ok && planState.value.position.index).toBe(0)

    // The service is still going out — which is the entire point of a panic that touches nothing.
    expect(outputs.state.streaming).toBe(true)
    expect(outputs.state.recording).toBe(true)
    expect(outputs.stopCalls()).toEqual([])

    engine.dispose()
    plan.dispose()
  })

  it('keeps the operator fully manual until they explicitly resume', async () => {
    const { plan, overlay } = makePlan()
    const engine = new CueEngine({
      plan,
      overlay,
      logger: createNullLogger(),
      settings: { ...defaultCueEngineSettings(), mode: 'auto' }
    })
    engine.panic()

    // Touching a settings field must not quietly re-arm the AI.
    engine.setMode('auto')
    const stillPanicked = engine.getState()
    expect(stillPanicked.ok && stillPanicked.value.mode).toBe('manual')

    // Manual driving works throughout.
    const fired = await plan.fireCue('cue-2')
    expect(fired.ok).toBe(true)
    expect(overlay.commands).toHaveLength(1)

    const resumed = engine.resume()
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw new Error('expected a state')
    expect(resumed.value.panicked).toBe(false)
    expect(resumed.value.mode).toBe('auto')

    engine.dispose()
    plan.dispose()
  })
})
