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

import type { AppConfig } from '@shared/config'
import { IPC_CHANNEL_VALUES, IpcChannel, IpcEvent } from '@shared/ipc'
import type { IpcChannelValue } from '@shared/ipc'
import type { OverlayServerInfo } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import { initialObsStatus } from '@shared/obs'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { applyOverlayCommand, emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { ok } from '@shared/result'
import type { Result } from '@shared/result'

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

import {
  OBS_PASSWORD_SECRET_KEY,
  registerIpc,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type ObsClientLike,
  type OverlayServerLike,
  type SecretsStoreLike,
  type WebContentsLike,
  type WindowLike
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

  it('dispose removes every handler and unsubscribes from both subsystems', () => {
    expect(harness.ipc.handlers.size).toBe(IPC_CHANNEL_VALUES.length)

    harness.dispose()

    expect(harness.ipc.handlers.size).toBe(0)
    expect([...harness.ipc.removeCalls].sort()).toEqual([...IPC_CHANNEL_VALUES].sort())
    expect(harness.obs.statusUnsubscribed()).toBe(1)
    expect(harness.obs.sceneListUnsubscribed()).toBe(1)
    expect(harness.overlay.stateUnsubscribed()).toBe(1)
    expect(harness.overlay.infoUnsubscribed()).toBe(1)

    // Idempotent — a second dispose must not double-unsubscribe or re-remove.
    harness.dispose()
    expect(harness.ipc.removeCalls).toHaveLength(IPC_CHANNEL_VALUES.length)
    expect(harness.obs.statusUnsubscribed()).toBe(1)
    expect(harness.overlay.stateUnsubscribed()).toBe(1)
  })

  it('stops fanning events out after dispose', () => {
    harness.dispose()
    harness.obs.emitStatus(initialObsStatus('connected', 6_000))
    harness.overlay.emitState(emptyOverlayState())
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
