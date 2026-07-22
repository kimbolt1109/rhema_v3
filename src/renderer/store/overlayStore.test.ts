import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { overlayPageUrl } from '@shared/net'
import { emptyOverlayState } from '@shared/overlay'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  installMockVergerApi,
  mockOverlayServerInfo,
  mockOverlayState,
} from '../test/mockVergerApi'
import {
  OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE,
  anyLayerVisible,
  resetOverlayStore,
  useOverlayStore,
} from './overlayStore'

describe('overlayStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetOverlayStore()
  })

  it('settles into a clearly-flagged not-running state instead of throwing', async () => {
    await useOverlayStore.getState().hydrate()

    const store = useOverlayStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.serverInfo.running).toBe(false)
    expect(store.serverInfo.clients).toBe(0)
    expect(store.serverInfo.lastError).toBe(OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE)
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.state).toEqual(emptyOverlayState())
  })

  it('still reports the loopback URL the server would bind, so OBS can be pre-configured', () => {
    // Never string-built in a component: the panel reads this field, and this field comes from
    // `@shared/net`, the single source of truth for the port and address.
    expect(useOverlayStore.getState().serverInfo.pageUrl).toBe(overlayPageUrl())
    expect(useOverlayStore.getState().serverInfo.pageUrl).toContain('127.0.0.1')
  })

  it('returns an Err from send() rather than dereferencing undefined', async () => {
    const result = await useOverlayStore
      .getState()
      .send({ channel: 'command', name: 'clearAll', payload: {} })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(useOverlayStore.getState().sending).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = useOverlayStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(useOverlayStore.getState().bridgeAvailable).toBe(false)
  })
})

describe('overlayStore with a bridge', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetOverlayStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates the snapshot and the server info from the main process', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState())
    installed.mock.responses.overlayGetServerInfo = ok(mockOverlayServerInfo({ clients: 2 }))

    await useOverlayStore.getState().hydrate()

    const store = useOverlayStore.getState()
    expect(store.bridgeAvailable).toBe(true)
    expect(store.hydrated).toBe(true)
    expect(store.state.lowerThird.visible).toBe(true)
    expect(store.state.revision).toBe(4)
    expect(store.serverInfo.running).toBe(true)
    expect(store.serverInfo.clients).toBe(2)
    expect(store.serverInfo.pageUrl).toBe(overlayPageUrl())
  })

  it('applies a pushed snapshot — resync is the only case, not a special case', () => {
    const unsubscribe = useOverlayStore.getState().subscribe()

    installed.mock.emit(IpcEvent.overlayState, mockOverlayState({ revision: 11 }))
    expect(useOverlayStore.getState().state.revision).toBe(11)

    // A whole snapshot replaces the whole state, so an overlay that reconnected and forced a
    // rebroadcast can never leave a stale layer behind.
    installed.mock.emit(IpcEvent.overlayState, emptyOverlayState())
    expect(useOverlayStore.getState().state.lowerThird.visible).toBe(false)

    installed.mock.emit(IpcEvent.overlayServerInfo, mockOverlayServerInfo({ clients: 0 }))
    expect(useOverlayStore.getState().serverInfo.clients).toBe(0)

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.overlayState)).toBe(0)
    expect(installed.mock.listenerCount(IpcEvent.overlayServerInfo)).toBe(0)
  })

  it('forwards the exact command and adopts the returned snapshot', async () => {
    const command = {
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: '홍길동', line2: '찬양 인도', template: 'boxed' },
    } as const

    const result = await useOverlayStore.getState().send(command)

    expect(installed.mock.calls.overlaySend).toEqual([command])
    expect(result.ok).toBe(true)
    const store = useOverlayStore.getState()
    expect(store.state.lowerThird).toEqual({
      visible: true,
      line1: '홍길동',
      line2: '찬양 인도',
      template: 'boxed',
    })
    expect(store.sending).toBe(false)
  })

  it('leaves the mirrored state untouched when a command is refused', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState())
    await useOverlayStore.getState().hydrate()

    installed.mock.responses.overlaySend = err(ErrorCode.NOT_CONNECTED, 'overlay server is down')
    const result = await useOverlayStore
      .getState()
      .send({ channel: 'command', name: 'lowerThird.hide', payload: {} })

    expect(result.ok).toBe(false)
    const store = useOverlayStore.getState()
    // The server owns the state. A refused command has not moved it, so the store must not
    // invent a hidden lower third the operator would then trust.
    expect(store.state.lowerThird.visible).toBe(true)
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(store.sending).toBe(false)
  })

  it('converts a rejected bridge promise into an Err instead of propagating it', async () => {
    window.verger = {
      ...installed.mock.api,
      overlay: {
        ...installed.mock.api.overlay,
        send: () => Promise.reject(new Error('bridge exploded')),
      },
    }

    const result = await useOverlayStore
      .getState()
      .send({ channel: 'command', name: 'clearAll', payload: {} })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL)
      expect(result.error.message).toBe('bridge exploded')
    }
  })

  it('records a failed server-info read rather than claiming the server is up', async () => {
    installed.mock.responses.overlayGetServerInfo = err(ErrorCode.INTERNAL, 'port 7320 in use')

    await useOverlayStore.getState().hydrate()

    const store = useOverlayStore.getState()
    expect(store.serverInfo.running).toBe(false)
    expect(store.serverInfo.lastError).toBe('port 7320 in use')
    expect(store.hydrated).toBe(true)
  })
})

describe('anyLayerVisible', () => {
  it('is false for the blank overlay', () => {
    expect(anyLayerVisible(emptyOverlayState())).toBe(false)
  })

  it('is true when any single layer is up', () => {
    const base = emptyOverlayState()
    expect(anyLayerVisible({ ...base, lowerThird: { ...base.lowerThird, visible: true } })).toBe(
      true,
    )
    expect(anyLayerVisible({ ...base, scripture: { ...base.scripture, visible: true } })).toBe(true)
    expect(anyLayerVisible({ ...base, slide: { ...base.slide, visible: true } })).toBe(true)
  })
})
