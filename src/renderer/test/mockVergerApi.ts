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

import type { ConfigSummary } from '@shared/config'
import { emptyConfiguredMap } from '@shared/config'
import type {
  AppVersions,
  IpcEventPayload,
  IpcEventValue,
  OverlayServerInfo,
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
import type { Result } from '@shared/result'
import { ErrorCode, err, ok } from '@shared/result'

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
  }

  // The fake's own copy of the server-owned overlay state, so `send` can behave like the real
  // server: reduce, then hand back a full snapshot.
  let overlaySnapshot: OverlayState = responses.overlayGetState.ok
    ? responses.overlayGetState.value
    : emptyOverlayState()

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
