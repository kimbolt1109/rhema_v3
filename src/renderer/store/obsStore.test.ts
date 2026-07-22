import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { initialObsStatus } from '@shared/obs'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_NOW,
  installMockVergerApi,
  mockConnectedStatus,
  mockSceneList,
} from '../test/mockVergerApi'
import { BRIDGE_UNAVAILABLE_MESSAGE, resetObsStore, useObsStore } from './obsStore'

describe('obsStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetObsStore()
  })

  it('settles into a flagged not-configured state instead of throwing', async () => {
    await useObsStore.getState().hydrate()

    const state = useObsStore.getState()
    expect(state.bridgeAvailable).toBe(false)
    expect(state.status.state).toBe('not-configured')
    expect(state.status.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(state.status.lastError?.message).toBe(BRIDGE_UNAVAILABLE_MESSAGE)
    expect(state.hydrated).toBe(true)
  })

  it('returns an Err from every action rather than dereferencing undefined', async () => {
    const store = useObsStore.getState()

    const connect = await store.connect({ url: 'ws://127.0.0.1:4455', password: null })
    const disconnect = await store.disconnect()
    const setConfig = await store.setConfig({ url: 'ws://127.0.0.1:4455', password: null })

    for (const result of [connect, disconnect, setConfig]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    }
    expect(useObsStore.getState().connecting).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = useObsStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
  })
})

describe('obsStore with a bridge', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetObsStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates status and scene list from the main process', async () => {
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.getSceneList = ok(mockSceneList())

    await useObsStore.getState().hydrate()

    const state = useObsStore.getState()
    expect(state.bridgeAvailable).toBe(true)
    expect(state.status.state).toBe('connected')
    expect(state.status.obsVersion).toBe('30.2.3')
    expect(state.sceneList?.scenes).toHaveLength(3)
  })

  it('treats a NOT_CONNECTED scene list as an absent list, not a failure', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('idle', MOCK_NOW))
    installed.mock.responses.getSceneList = err(ErrorCode.NOT_CONNECTED, 'not connected')

    await useObsStore.getState().hydrate()

    expect(useObsStore.getState().sceneList).toBeNull()
    expect(useObsStore.getState().status.state).toBe('idle')
  })

  it('applies pushed status and scene-list events', () => {
    const unsubscribe = useObsStore.getState().subscribe()

    installed.mock.emit(IpcEvent.obsStatus, mockConnectedStatus())
    expect(useObsStore.getState().status.state).toBe('connected')

    installed.mock.emit(IpcEvent.obsSceneList, mockSceneList())
    expect(useObsStore.getState().sceneList?.currentProgramScene).toBe('Wide')

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.obsStatus)).toBe(0)
    expect(installed.mock.listenerCount(IpcEvent.obsSceneList)).toBe(0)
  })

  it('clears the connecting flag when a pushed status settles', () => {
    const unsubscribe = useObsStore.getState().subscribe()
    useObsStore.setState({ connecting: true })

    installed.mock.emit(IpcEvent.obsStatus, initialObsStatus('connecting', MOCK_NOW))
    expect(useObsStore.getState().connecting).toBe(true)

    installed.mock.emit(IpcEvent.obsStatus, initialObsStatus('auth-failed', MOCK_NOW))
    expect(useObsStore.getState().connecting).toBe(false)

    unsubscribe()
  })

  it('forwards the exact config to the bridge on connect', async () => {
    const config = { url: 'ws://10.0.0.4:4455', password: 'hunter2' }
    await useObsStore.getState().connect(config)

    expect(installed.mock.calls.connect).toEqual([config])
    expect(useObsStore.getState().connecting).toBe(false)
  })

  it('keeps the observed state but records the error when a command is refused', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('idle', MOCK_NOW))
    await useObsStore.getState().hydrate()

    installed.mock.responses.connect = err(ErrorCode.OBS_ERROR, 'obs said no')
    const result = await useObsStore.getState().connect({ url: 'ws://127.0.0.1:4455', password: null })

    expect(result.ok).toBe(false)
    const state = useObsStore.getState()
    // Standing Rule 2: the main process owns state transitions. A refused command has not moved
    // OBS, so the store must not invent a `disconnected`.
    expect(state.status.state).toBe('idle')
    expect(state.status.lastError?.code).toBe(ErrorCode.OBS_ERROR)
    expect(state.connecting).toBe(false)
  })

  it('converts a rejected bridge promise into an Err instead of propagating it', async () => {
    // The IPC contract says handlers never reject; the renderer must not take that on faith.
    window.verger = {
      ...installed.mock.api,
      obs: {
        ...installed.mock.api.obs,
        connect: () => Promise.reject(new Error('bridge exploded')),
      },
    }

    const result = await useObsStore
      .getState()
      .connect({ url: 'ws://127.0.0.1:4455', password: null })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL)
      expect(result.error.message).toBe('bridge exploded')
    }
  })
})
