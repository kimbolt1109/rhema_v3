/**
 * `ObsClient` behaviour, driven entirely against a hand-written socket double.
 *
 * No network, no `ws`, no OBS Studio — the machine running these tests does not have OBS
 * installed, and that is the point: the reconnect state machine is the part of Verger most
 * likely to misbehave at 10:58 on a Sunday, so it has to be provable on a laptop.
 *
 * Everything is injected: the socket factory, the timers (recorded *and* delegated to Vitest's
 * fake timers, so both the delay sequence and "did a timer survive?" are observable), the clock
 * and the jitter source. Assertions are behavioural — the observable status, the emitted events,
 * the requests that reached the wire — rather than "a mock was called".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNullLogger } from '@main/logging/logger'
import { ObsClient } from '@main/obs/ObsClient'
import type { OBSWebSocketLike, ObsEventListener, ObsTimers } from '@main/obs/ObsClient'
import { DEFAULT_RECONNECT_POLICY } from '@shared/obs'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus, ReconnectPolicy } from '@shared/obs'
import { ErrorCode } from '@shared/result'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Shaped like `obs-websocket-js`'s `OBSWebSocketError`: an `Error` carrying a numeric `code`. */
class MockObsWebSocketError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'OBSWebSocketError'
    this.code = code
  }
}

const DEFAULT_VERSION = {
  obsVersion: '30.1.2',
  obsWebSocketVersion: '5.4.2',
  rpcVersion: 1,
  availableRequests: [],
  supportedImageFormats: [],
  platform: 'windows',
  platformDescription: 'Windows 11'
}

const DEFAULT_SCENE_LIST = {
  currentProgramSceneName: 'Camera 1',
  currentPreviewSceneName: null,
  scenes: [
    { sceneName: 'Camera 1', sceneIndex: 1, sceneUuid: 'uuid-1' },
    { sceneName: 'Welcome', sceneIndex: 0, sceneUuid: 'uuid-0' }
  ]
}

/**
 * A minimal, fully typed `OBSWebSocketLike`.
 *
 * Simulates a successful identify, an auth rejection, an abrupt close, a request that never
 * settles, a request that errors, and arbitrary emitted OBS events.
 */
class MockObsSocket implements OBSWebSocketLike {
  /** Every request name that reached the wire, in order. */
  readonly requests: string[] = []
  readonly hanging = new Set<string>()
  readonly responses = new Map<string, unknown>([
    ['GetVersion', DEFAULT_VERSION],
    ['GetSceneList', DEFAULT_SCENE_LIST]
  ])
  readonly failures = new Map<string, unknown>()

  connectCount = 0
  disconnectCount = 0
  connected = false
  lastUrl: string | null = null
  lastPassword: string | undefined = undefined

  /** When non-null, `connect()` rejects with this instead of identifying. */
  connectRejection: unknown = null

  private readonly listeners = new Map<string, Set<ObsEventListener>>()

  async connect(url: string, password?: string): Promise<unknown> {
    this.connectCount += 1
    this.lastUrl = url
    this.lastPassword = password

    if (this.connectRejection !== null) throw this.connectRejection

    this.connected = true
    return { obsWebSocketVersion: '5.4.2', rpcVersion: 1, negotiatedRpcVersion: 1 }
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1
    const wasConnected = this.connected
    this.connected = false
    // The real library emits `ConnectionClosed` for a deliberate close too — a client that
    // treated that as an unexpected drop would reconnect straight after being told to stop.
    if (wasConnected) this.emit('ConnectionClosed', new MockObsWebSocketError(1000, ''))
  }

  async call(requestType: string, _requestData?: Record<string, unknown>): Promise<unknown> {
    this.requests.push(requestType)

    if (this.hanging.has(requestType)) return new Promise<never>(() => {})

    const failure = this.failures.get(requestType)
    if (failure !== undefined) throw failure

    if (!this.responses.has(requestType)) {
      throw new MockObsWebSocketError(204, `unsupported request ${requestType}`)
    }
    return this.responses.get(requestType)
  }

  on(event: string, listener: ObsEventListener): void {
    const set = this.listeners.get(event) ?? new Set<ObsEventListener>()
    set.add(listener)
    this.listeners.set(event, set)
  }

  off(event: string, listener: ObsEventListener): void {
    this.listeners.get(event)?.delete(listener)
  }

  /** Number of listeners currently attached — proves the client unbinds on teardown. */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
  }

  /** Simulate an abrupt close from OBS's side. */
  closeWith(code: number, reason: string): void {
    this.connected = false
    this.emit('ConnectionClosed', new MockObsWebSocketError(code, reason))
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly policy?: ReconnectPolicy
  readonly random?: () => number
  readonly callTimeoutMs?: number
}

interface Harness {
  readonly client: ObsClient
  /** Every socket the client has built, in order. */
  readonly sockets: MockObsSocket[]
  /** Every delay the client asked a timer for, in order. */
  readonly delays: number[]
  /** Configure (or sabotage) each socket at construction time. */
  setSocketSetup(setup: (socket: MockObsSocket) => void): void
}

const CALL_TIMEOUT_MS = 5_000

function createHarness(options: HarnessOptions = {}): Harness {
  const sockets: MockObsSocket[] = []
  const delays: number[] = []
  let setup: (socket: MockObsSocket) => void = () => {}

  const timers: ObsTimers = {
    setTimeout: (handler, delayMs) => {
      delays.push(delayMs)
      return setTimeout(handler, delayMs)
    },
    clearTimeout: (handle) => {
      clearTimeout(handle)
    }
  }

  const client = new ObsClient({
    createSocket: () => {
      const socket = new MockObsSocket()
      setup(socket)
      sockets.push(socket)
      return socket
    },
    timers,
    now: () => Date.now(),
    logger: createNullLogger(),
    policy: options.policy ?? DEFAULT_RECONNECT_POLICY,
    random: options.random ?? (() => 0.5),
    callTimeoutMs: options.callTimeoutMs ?? CALL_TIMEOUT_MS
  })

  return {
    client,
    sockets,
    delays,
    setSocketSetup: (next) => {
      setup = next
    }
  }
}

const CONFIG: ObsConnectionConfig = { url: 'ws://127.0.0.1:4455', password: 'hunter2' }

/** Drain the microtask queue so an async dial settles before assertions. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

/** Advance fake time and let every promise chain it woke up settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

function rejectConnect(harness: Harness, error: unknown): void {
  harness.setSocketSetup((socket) => {
    socket.connectRejection = error
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ObsClient — connecting', () => {
  it('starts inert: not-configured, no socket, no timer', () => {
    const harness = createHarness()

    expect(harness.client.getStatus().state).toBe('not-configured')
    expect(harness.sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reaches connected, resets the attempt counter and reports OBS versions', async () => {
    const harness = createHarness()
    const states: string[] = []
    harness.client.onStatus((status) => states.push(status.state))

    const result = await harness.client.connect(CONFIG)

    expect(result.ok).toBe(true)
    const status = harness.client.getStatus()
    expect(status.state).toBe('connected')
    expect(status.attempt).toBe(0)
    expect(status.nextRetryInMs).toBeNull()
    expect(status.lastError).toBeNull()
    expect(status.obsVersion).toBe('30.1.2')
    expect(status.obsWebSocketVersion).toBe('5.4.2')
    expect(status.rpcVersion).toBe(1)
    expect(status.currentProgramScene).toBe('Camera 1')
    expect(states).toEqual(['connecting', 'connected'])
    // Both request deadlines were cleared on success.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fetches the scene list and pushes it to subscribers', async () => {
    const harness = createHarness()
    const published: ObsSceneList[] = []
    harness.client.onSceneList((list) => published.push(list))

    await harness.client.connect(CONFIG)

    expect(published).toHaveLength(1)
    expect(published[0]).toEqual({
      scenes: [
        { name: 'Camera 1', index: 1 },
        { name: 'Welcome', index: 0 }
      ],
      currentProgramScene: 'Camera 1',
      currentPreviewScene: null
    })
    expect(harness.client.getCachedSceneList()).toEqual(published[0])
  })

  it('issues NO Set*/Start*/Stop* requests on connect — it reads OBS state, it never imposes it', async () => {
    const harness = createHarness()

    await harness.client.connect(CONFIG)
    const socket = harness.sockets[0]
    expect(socket).toBeDefined()

    // Standing Rule 2, asserted on the wire. Phase 5 widened the write allowlist with the four
    // output requests, so connecting must be re-proven never to touch them: launching Verger
    // while a service is running may not start a stream, start a recording, or stop either.
    expect(socket?.requests).toEqual(['GetVersion', 'GetSceneList'])
    expect(socket?.requests.filter((name) => name.startsWith('Set'))).toEqual([])
    expect(socket?.requests.filter((name) => name.startsWith('Start'))).toEqual([])
    expect(socket?.requests.filter((name) => name.startsWith('Stop'))).toEqual([])
    expect(socket?.requests.every((name) => name.startsWith('Get'))).toBe(true)
  })

  it('still issues no Set*/Start*/Stop* requests while observing scene changes', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    const socket = harness.sockets[0]

    socket?.emit('CurrentProgramSceneChanged', { sceneName: 'Welcome' })
    await harness.client.getSceneList()
    await harness.client.getVersion()

    expect(socket?.requests.filter((name) => !name.startsWith('Get'))).toEqual([])
  })

  it('issues no output requests when a reconnect re-establishes the socket', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    // OBS goes away mid-service and comes back. Standing Rule 2: the app RE-ATTACHES to whatever
    // OBS is doing; it must not push a second stream or start a second recording on reconnect.
    harness.sockets[0]?.emit('ConnectionClosed', new MockObsWebSocketError(1006, 'gone'))
    await advance(DEFAULT_RECONNECT_POLICY.baseDelayMs * 4)

    for (const socket of harness.sockets) {
      expect(socket.requests.every((name) => name.startsWith('Get'))).toBe(true)
    }
  })

  it('passes the password through, and omits it entirely when authentication is disabled', async () => {
    const withPassword = createHarness()
    await withPassword.client.connect(CONFIG)
    expect(withPassword.sockets[0]?.lastUrl).toBe('ws://127.0.0.1:4455')
    expect(withPassword.sockets[0]?.lastPassword).toBe('hunter2')

    const withoutPassword = createHarness()
    await withoutPassword.client.connect({ url: 'ws://127.0.0.1:4455', password: null })
    expect(withoutPassword.sockets[0]?.lastPassword).toBeUndefined()
  })

  it('replaces an existing connection rather than stacking one on top', async () => {
    const harness = createHarness()

    await harness.client.connect(CONFIG)
    await harness.client.connect(CONFIG)

    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[0]?.disconnectCount).toBe(1)
    expect(harness.sockets[0]?.listenerCount()).toBe(0)
    expect(harness.client.getStatus().state).toBe('connected')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ObsClient — not configured', () => {
  it('never dials and never throws when the URL is empty', async () => {
    const harness = createHarness()

    const result = await harness.client.connect({ url: '', password: null })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(harness.client.getStatus().state).toBe('not-configured')
    expect(harness.sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats a whitespace-only URL as absent', async () => {
    const harness = createHarness()

    const result = await harness.client.connect({ url: '   ', password: 'hunter2' })

    expect(result.ok).toBe(false)
    expect(harness.client.getStatus().state).toBe('not-configured')
    expect(harness.sockets).toHaveLength(0)
  })

  it('stays not-configured after a disconnect, rather than claiming to be disconnected', async () => {
    const harness = createHarness()
    await harness.client.connect({ url: '', password: null })

    await harness.client.disconnect()

    expect(harness.client.getStatus().state).toBe('not-configured')
  })
})

describe('ObsClient — authentication failure is terminal', () => {
  it('lands on auth-failed with zero retries when the handshake is rejected', async () => {
    const harness = createHarness()
    rejectConnect(harness, new MockObsWebSocketError(4009, 'Authentication failed.'))

    const result = await harness.client.connect(CONFIG)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.OBS_ERROR)

    const status = harness.client.getStatus()
    expect(status.state).toBe('auth-failed')
    expect(status.nextRetryInMs).toBeNull()
    expect(status.lastError?.detail).toBe('obs-websocket code 4009')
    expect(vi.getTimerCount()).toBe(0)

    // Five minutes of wall clock must produce exactly zero further attempts.
    await advance(300_000)
    expect(harness.sockets).toHaveLength(1)
    expect(harness.client.getStatus().state).toBe('auth-failed')
  })

  it('lands on auth-failed when OBS closes an established socket with 4009', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    harness.sockets[0]?.closeWith(4009, 'Authentication failed.')

    expect(harness.client.getStatus().state).toBe('auth-failed')
    expect(vi.getTimerCount()).toBe(0)

    await advance(120_000)
    expect(harness.sockets).toHaveLength(1)
  })

  it('does NOT treat an ordinary close code as an auth failure', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    harness.sockets[0]?.closeWith(1006, 'connection lost')

    expect(harness.client.getStatus().state).toBe('reconnecting')
  })
})

describe('ObsClient — reconnection', () => {
  it('enters reconnecting on an unexpected close and recovers on the next attempt', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    harness.sockets[0]?.closeWith(1006, 'connection lost')

    const dropped = harness.client.getStatus()
    expect(dropped.state).toBe('reconnecting')
    expect(dropped.attempt).toBe(1)
    expect(dropped.nextRetryInMs).toBe(500)
    expect(dropped.lastError?.code).toBe(ErrorCode.OBS_ERROR)

    await advance(500)

    expect(harness.sockets).toHaveLength(2)
    const recovered = harness.client.getStatus()
    expect(recovered.state).toBe('connected')
    expect(recovered.attempt).toBe(0)
    expect(recovered.nextRetryInMs).toBeNull()
    expect(recovered.lastError).toBeNull()
  })

  it('produces the full exponential backoff sequence and saturates at the 30s cap', async () => {
    const harness = createHarness({ random: () => 0.5 })
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))

    await harness.client.connect(CONFIG)

    const observed: (number | null)[] = [harness.client.getStatus().nextRetryInMs]
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect(harness.client.getStatus().state).toBe('reconnecting')
      await advance(harness.client.getStatus().nextRetryInMs ?? 0)
      observed.push(harness.client.getStatus().nextRetryInMs)
    }

    expect(observed).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000])
    // The client asked the injected timer for exactly those delays and nothing else.
    expect(harness.delays).toEqual(observed)
    expect(harness.sockets).toHaveLength(10)
    expect(harness.client.getStatus().attempt).toBe(10)
    expect(harness.client.getStatus().state).toBe('reconnecting')
  })

  it('never exceeds the cap even with maximum positive jitter', async () => {
    const harness = createHarness({ random: () => 0.999_999 })
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))

    await harness.client.connect(CONFIG)
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await advance(harness.client.getStatus().nextRetryInMs ?? 0)
    }

    expect(harness.delays).toHaveLength(12)
    for (const delay of harness.delays) {
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(DEFAULT_RECONNECT_POLICY.maxDelayMs)
    }
    expect(harness.delays.at(-1)).toBe(DEFAULT_RECONNECT_POLICY.maxDelayMs)
  })

  it('retries indefinitely — thirty minutes of downtime never gives up', async () => {
    const harness = createHarness()
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))

    await harness.client.connect(CONFIG)
    for (let attempt = 0; attempt < 70; attempt += 1) {
      await advance(harness.client.getStatus().nextRetryInMs ?? 0)
    }

    expect(harness.client.getStatus().state).toBe('reconnecting')
    expect(harness.client.getStatus().attempt).toBe(71)
    expect(harness.sockets.length).toBe(71)
  })

  it('stops at maxAttempts when a policy sets one', async () => {
    const policy: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, maxAttempts: 2 }
    const harness = createHarness({ policy })
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))

    await harness.client.connect(CONFIG)
    await advance(harness.client.getStatus().nextRetryInMs ?? 0)
    await advance(harness.client.getStatus().nextRetryInMs ?? 0)

    expect(harness.client.getStatus().state).toBe('disconnected')
    expect(harness.client.getStatus().nextRetryInMs).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never throws when the socket factory itself fails', async () => {
    const harness = createHarness()
    harness.setSocketSetup(() => {
      throw new Error('the websocket implementation is missing')
    })

    const result = await harness.client.connect(CONFIG)

    expect(result.ok).toBe(false)
    expect(harness.client.getStatus().state).toBe('reconnecting')
    expect(harness.client.getStatus().nextRetryInMs).toBe(500)
  })

  it('ignores events and closes from a superseded socket', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    const stale = harness.sockets[0]
    await harness.client.connect(CONFIG)

    stale?.emit('CurrentProgramSceneChanged', { sceneName: 'Ghost' })
    stale?.closeWith(1006, 'stale socket dying')

    expect(harness.client.getStatus().currentProgramScene).toBe('Camera 1')
    expect(harness.client.getStatus().state).toBe('connected')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ObsClient — disconnecting', () => {
  it('cancels the pending reconnect timer, lands on disconnected and schedules nothing', async () => {
    const harness = createHarness()
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))

    await harness.client.connect(CONFIG)
    expect(harness.client.getStatus().state).toBe('reconnecting')
    expect(vi.getTimerCount()).toBe(1)

    const result = await harness.client.disconnect()

    expect(result.ok).toBe(true)
    const status = harness.client.getStatus()
    expect(status.state).toBe('disconnected')
    expect(status.attempt).toBe(0)
    expect(status.nextRetryInMs).toBeNull()

    // No timer survived, and no timer fires later.
    expect(vi.getTimerCount()).toBe(0)
    const socketsAtDisconnect = harness.sockets.length
    await advance(600_000)
    expect(harness.sockets).toHaveLength(socketsAtDisconnect)
    expect(harness.client.getStatus().state).toBe('disconnected')
  })

  it('closes a live socket, unbinds its listeners and does not reconnect', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    const socket = harness.sockets[0]

    await harness.client.disconnect()

    expect(socket?.disconnectCount).toBe(1)
    expect(socket?.listenerCount()).toBe(0)
    expect(harness.client.getStatus().state).toBe('disconnected')

    await advance(600_000)
    expect(harness.sockets).toHaveLength(1)
    expect(harness.client.getStatus().state).toBe('disconnected')
  })

  it('leaves nothing pending after dispose', async () => {
    const harness = createHarness()
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))
    await harness.client.connect(CONFIG)

    await harness.client.dispose()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('reconnects cleanly after an explicit disconnect', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    await harness.client.disconnect()

    const result = await harness.client.connect(CONFIG)

    expect(result.ok).toBe(true)
    expect(harness.client.getStatus().state).toBe('connected')
    expect(harness.sockets).toHaveLength(2)
  })
})

describe('ObsClient — requests', () => {
  it('returns NOT_CONNECTED rather than throwing or hanging when there is no connection', async () => {
    const harness = createHarness()

    const scenes = await harness.client.getSceneList()
    const version = await harness.client.getVersion()

    expect(scenes.ok).toBe(false)
    if (!scenes.ok) expect(scenes.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(version.ok).toBe(false)
    if (!version.ok) expect(version.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(harness.sockets).toHaveLength(0)
  })

  it('returns NOT_CONNECTED while reconnecting', async () => {
    const harness = createHarness()
    rejectConnect(harness, new MockObsWebSocketError(1006, 'ECONNREFUSED'))
    await harness.client.connect(CONFIG)

    const scenes = await harness.client.getSceneList()

    expect(scenes.ok).toBe(false)
    if (!scenes.ok) expect(scenes.error.code).toBe(ErrorCode.NOT_CONNECTED)
  })

  it('bounds a call that never settles with a TIMEOUT and stays connected', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    harness.sockets[0]?.hanging.add('GetSceneList')

    const pending = harness.client.getSceneList()
    await advance(CALL_TIMEOUT_MS)
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.TIMEOUT)
      expect(result.error.detail).toBe('5000ms')
    }
    // A slow request is not a dropped connection: no reconnect was scheduled.
    expect(harness.client.getStatus().state).toBe('connected')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an OBS-side request failure as OBS_ERROR', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    harness.sockets[0]?.failures.set(
      'GetSceneList',
      new MockObsWebSocketError(604, 'ResourceNotFound')
    )

    const result = await harness.client.getSceneList()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.OBS_ERROR)
      expect(result.error.detail).toBe('obs-websocket code 604')
    }
  })

  it('still reaches connected when the version read fails, with null versions', async () => {
    const harness = createHarness()
    harness.setSocketSetup((socket) => {
      socket.failures.set('GetVersion', new MockObsWebSocketError(500, 'nope'))
    })

    await harness.client.connect(CONFIG)

    const status = harness.client.getStatus()
    expect(status.state).toBe('connected')
    expect(status.obsVersion).toBeNull()
    expect(status.currentProgramScene).toBe('Camera 1')
  })

  it('returns a fresh scene list on demand', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    harness.sockets[0]?.responses.set('GetSceneList', {
      currentProgramSceneName: 'Welcome',
      currentPreviewSceneName: 'Camera 1',
      scenes: [{ sceneName: 'Welcome', sceneIndex: 0 }]
    })

    const result = await harness.client.getSceneList()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.currentProgramScene).toBe('Welcome')
      expect(result.value.currentPreviewScene).toBe('Camera 1')
      expect(result.value.scenes).toEqual([{ name: 'Welcome', index: 0 }])
    }
    expect(harness.client.getStatus().currentProgramScene).toBe('Welcome')
  })

  it('reports the OBS version triple', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    const result = await harness.client.getVersion()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        obsVersion: '30.1.2',
        obsWebSocketVersion: '5.4.2',
        rpcVersion: 1
      })
    }
  })
})

describe('ObsClient — OBS events', () => {
  it('tracks CurrentProgramSceneChanged in both the status and the scene list', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    const statuses: ObsStatus[] = []
    const lists: ObsSceneList[] = []
    harness.client.onStatus((status) => statuses.push(status))
    harness.client.onSceneList((list) => lists.push(list))

    harness.sockets[0]?.emit('CurrentProgramSceneChanged', {
      sceneName: 'Welcome',
      sceneUuid: 'uuid-0'
    })

    expect(harness.client.getStatus().currentProgramScene).toBe('Welcome')
    expect(statuses.at(-1)?.currentProgramScene).toBe('Welcome')
    expect(lists.at(-1)?.currentProgramScene).toBe('Welcome')
    // The scene inventory itself is untouched by a program-scene change.
    expect(lists.at(-1)?.scenes).toHaveLength(2)
  })

  it('tracks SceneListChanged, preserving the current program scene', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    const lists: ObsSceneList[] = []
    harness.client.onSceneList((list) => lists.push(list))

    harness.sockets[0]?.emit('SceneListChanged', {
      scenes: [
        { sceneName: 'Camera 2', sceneIndex: 2 },
        { sceneName: 'Camera 1', sceneIndex: 1 },
        { sceneName: 'Welcome', sceneIndex: 0 }
      ]
    })

    expect(lists).toHaveLength(1)
    expect(lists[0]?.scenes.map((scene) => scene.name)).toEqual(['Camera 2', 'Camera 1', 'Welcome'])
    expect(lists[0]?.currentProgramScene).toBe('Camera 1')
    expect(harness.client.getCachedSceneList()?.scenes).toHaveLength(3)
  })

  it('tracks CurrentPreviewSceneChanged without disturbing the program scene', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    harness.sockets[0]?.emit('CurrentPreviewSceneChanged', { sceneName: 'Welcome' })

    expect(harness.client.getCachedSceneList()?.currentPreviewScene).toBe('Welcome')
    expect(harness.client.getStatus().currentProgramScene).toBe('Camera 1')
  })

  it('ignores malformed event payloads instead of corrupting cached state', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    const socket = harness.sockets[0]

    socket?.emit('CurrentProgramSceneChanged', undefined)
    socket?.emit('CurrentProgramSceneChanged', { sceneName: 42 })
    socket?.emit('SceneListChanged', { scenes: 'not-an-array' })
    socket?.emit('ConnectionError', new MockObsWebSocketError(-1, 'socket error'))

    expect(harness.client.getStatus().currentProgramScene).toBe('Camera 1')
    expect(harness.client.getStatus().state).toBe('connected')
  })

  it('falls back to array position when OBS omits sceneIndex', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    harness.sockets[0]?.emit('SceneListChanged', {
      scenes: [{ sceneName: 'A' }, { notAScene: true }, { sceneName: 'B' }]
    })

    expect(harness.client.getCachedSceneList()?.scenes).toEqual([
      { name: 'A', index: 0 },
      { name: 'B', index: 2 }
    ])
  })
})

describe('ObsClient — raw OBS event subscriptions', () => {
  it('delivers a subscribed OBS event to the subscriber', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    const seen: unknown[] = []
    harness.client.onObsEvent('StreamStateChanged', (payload) => {
      seen.push(payload)
    })

    harness.sockets[0]?.emit('StreamStateChanged', { outputActive: true })

    expect(seen).toEqual([{ outputActive: true }])
  })

  it('binds an event subscribed AFTER the connection is already up', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    // Subscribing late must not wait for the next reconnect to start working.
    const seen: unknown[] = []
    harness.client.onObsEvent('RecordFileChanged', (payload) => {
      seen.push(payload)
    })

    harness.sockets[0]?.emit('RecordFileChanged', { newOutputPath: 'C:/services/backup.mkv' })

    expect(seen).toEqual([{ newOutputPath: 'C:/services/backup.mkv' }])
  })

  it('unsubscribing stops delivery, and one throwing subscriber does not starve the others', async () => {
    const harness = createHarness()
    await harness.client.connect(CONFIG)

    const good: unknown[] = []
    harness.client.onObsEvent('StreamStateChanged', () => {
      throw new Error('a subscriber blew up mid-service')
    })
    const unsubscribe = harness.client.onObsEvent('StreamStateChanged', (payload) => {
      good.push(payload)
    })

    harness.sockets[0]?.emit('StreamStateChanged', { outputActive: true })
    expect(good).toHaveLength(1)

    unsubscribe()
    harness.sockets[0]?.emit('StreamStateChanged', { outputActive: false })
    expect(good).toHaveLength(1)
  })

  it('subscribing to raw events grants no ability to WRITE to OBS', async () => {
    // onObsEvent is observation only. The write guard is what gates commands, and it must be
    // completely unaffected by having subscribed to something.
    const harness = createHarness()
    await harness.client.connect(CONFIG)
    harness.client.onObsEvent('StreamStateChanged', () => {})

    const refused = await harness.client.call('SetSceneItemEnabled', { sceneItemEnabled: false })

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe(ErrorCode.INVALID_ARG)
  })
})

describe('ObsClient — the write allowlist', () => {
  /**
   * Every non-`Get` request Verger legitimately needs: Phase 3's camera buttons and Phase 5's
   * output control. Nothing may be added here without a matching entry in the source list, and
   * the equality assertion below is what makes that true rather than aspirational.
   */
  const ALLOWED = [
    'SetCurrentProgramScene',
    'SetCurrentSceneTransition',
    'SetCurrentSceneTransitionDuration',
    'StartStream',
    'StopStream',
    'StartRecord',
    'StopRecord'
  ] as const

  /** A representative slice of what must stay refused: OBS surgery of every flavour. */
  const REFUSED = [
    'SetSceneItemEnabled',
    'RemoveScene',
    'SetProfileParameter',
    'CreateInput',
    'SetVideoSettings',
    'TriggerHotkeyByName',
    'SetCurrentSceneCollection',
    'StartOutput',
    'StopVirtualCam',
    'PauseRecord'
  ] as const

  async function connected(): Promise<Harness> {
    const harness = createHarness()
    harness.setSocketSetup((socket) => {
      for (const name of ALLOWED) socket.responses.set(name, {})
      for (const name of REFUSED) socket.responses.set(name, {})
    })
    await harness.client.connect(CONFIG)
    return harness
  }

  it('permits each allowlisted write, and it reaches the socket', async () => {
    const harness = await connected()
    const socket = harness.sockets[0]

    const results = [
      await harness.client.call('SetCurrentProgramScene', { sceneName: 'Camera 2' }),
      await harness.client.call('SetCurrentSceneTransition', { transitionName: 'Fade' }),
      await harness.client.call('SetCurrentSceneTransitionDuration', { transitionDuration: 300 }),
      // Phase 5 — the four output requests GO LIVE / END need.
      await harness.client.call('StartStream'),
      await harness.client.call('StopStream'),
      await harness.client.call('StartRecord'),
      await harness.client.call('StopRecord')
    ]

    for (const result of results) expect(result.ok).toBe(true)
    expect(socket?.requests).toEqual(['GetVersion', 'GetSceneList', ...ALLOWED])
  })

  it('still REFUSES every other write, and none of them reaches the socket', async () => {
    const harness = await connected()
    const socket = harness.sockets[0]
    const before = [...(socket?.requests ?? [])]

    for (const requestType of REFUSED) {
      const result = await harness.client.call(requestType, { enabled: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
        expect(result.error.message).toContain(requestType)
        expect(result.error.message).toContain('never imposes it')
      }
    }

    // Not one of them was written to the wire.
    expect(socket?.requests).toEqual(before)
    expect(harness.client.getStatus().state).toBe('connected')
  })

  it('refuses a request that merely looks allowlisted', async () => {
    const harness = await connected()

    const nearMiss = await harness.client.call('SetCurrentProgramSceneCollection')
    const casing = await harness.client.call('setCurrentProgramScene')

    expect(nearMiss.ok).toBe(false)
    expect(casing.ok).toBe(false)
    expect(harness.sockets[0]?.requests).toEqual(['GetVersion', 'GetSceneList'])
  })

  it('reports NOT_CONNECTED for an allowlisted write while OBS is down', async () => {
    const harness = createHarness()

    const result = await harness.client.call('SetCurrentProgramScene', { sceneName: 'Camera 2' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(harness.sockets).toHaveLength(0)
  })

  it('surfaces an OBS-side rejection of an allowlisted write as OBS_ERROR', async () => {
    const harness = await connected()
    harness.sockets[0]?.failures.set(
      'SetCurrentProgramScene',
      new MockObsWebSocketError(600, 'ResourceNotFound')
    )

    const result = await harness.client.call('SetCurrentProgramScene', { sceneName: 'Ghost' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.OBS_ERROR)
    // A refused scene switch is not a dropped connection.
    expect(harness.client.getStatus().state).toBe('connected')
  })

  it('exposes the allowlist as exactly those seven names and no others', async () => {
    const { ALLOWED_WRITE_REQUESTS, isAllowedRequest, isReadOnlyRequest } = await import(
      '@main/obs/ObsClient'
    )

    expect([...ALLOWED_WRITE_REQUESTS]).toEqual([...ALLOWED])
    expect(ALLOWED_WRITE_REQUESTS).toHaveLength(7)
    for (const name of ALLOWED) {
      expect(isAllowedRequest(name)).toBe(true)
      expect(isReadOnlyRequest(name)).toBe(false)
    }
    for (const name of REFUSED) expect(isAllowedRequest(name)).toBe(false)
    expect(isAllowedRequest('GetSceneTransitionList')).toBe(true)
  })

  it('refuses every OTHER Start*/Stop* — only the four output requests are allowlisted', async () => {
    const { isAllowedRequest } = await import('@main/obs/ObsClient')

    // Phase 5 widened the list by exactly four names. Everything adjacent stays out.
    for (const name of [
      'StartVirtualCam',
      'StopVirtualCam',
      'StartReplayBuffer',
      'StopReplayBuffer',
      'StartOutput',
      'StopOutput',
      'PauseRecord',
      'ResumeRecord',
      'ToggleStream',
      'ToggleRecord'
    ]) {
      expect(isAllowedRequest(name)).toBe(false)
    }
  })
})

describe('getObsClient', () => {
  it('is callable with no arguments, is a singleton, and dials nothing on construction', async () => {
    // `src/main/index.ts` calls this exactly this way, before any window exists.
    const module = await import('@main/obs')

    const client = module.getObsClient()
    const again = module.getObsClient()

    expect(again).toBe(client)
    expect(client.getStatus().state).toBe('not-configured')
    expect(client.getCachedSceneList()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    await module.resetObsClient()
  })

  it('adapts a real obs-websocket-js instance onto the OBSWebSocketLike seam', async () => {
    const { createObsSocket } = await import('@main/obs')

    const socket: OBSWebSocketLike = createObsSocket()

    expect(typeof socket.connect).toBe('function')
    expect(typeof socket.disconnect).toBe('function')
    expect(typeof socket.call).toBe('function')
    expect(typeof socket.on).toBe('function')
    expect(typeof socket.off).toBe('function')

    // Binding and unbinding must not throw, and must not open anything.
    const listener: ObsEventListener = () => {}
    socket.on('ConnectionClosed', listener)
    socket.off('ConnectionClosed', listener)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ObsClient — subscribers', () => {
  it('stops delivering after unsubscribe', async () => {
    const harness = createHarness()
    const seen: string[] = []
    const unsubscribe = harness.client.onStatus((status) => seen.push(status.state))

    unsubscribe()
    await harness.client.connect(CONFIG)

    expect(seen).toEqual([])
    expect(harness.client.getStatus().state).toBe('connected')
  })

  it('isolates a throwing subscriber from the rest', async () => {
    const harness = createHarness()
    const seen: string[] = []
    harness.client.onStatus(() => {
      throw new Error('a renderer bridge blew up')
    })
    harness.client.onStatus((status) => seen.push(status.state))

    const result = await harness.client.connect(CONFIG)

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['connecting', 'connected'])
  })
})
