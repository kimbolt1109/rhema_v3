import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultCameraConfig } from '@shared/camera'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_CAMERA_SCENES,
  installMockVergerApi,
  mockCameraConfig,
  mockCameraState,
  mockOverlayState,
} from '../test/mockVergerApi'
import {
  CAMERA_BRIDGE_UNAVAILABLE_MESSAGE,
  cameraButtons,
  resetCameraStore,
  useCameraStore,
} from './cameraStore'

describe('cameraStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetCameraStore()
  })

  it('settles into an explicitly flagged unavailable state instead of throwing', async () => {
    await useCameraStore.getState().hydrate()

    const store = useCameraStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.state.activeSlot).toBeNull()
    expect(store.state.currentProgramScene).toBeNull()
    expect(store.config).toEqual(defaultCameraConfig())
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.lastError?.message).toBe(CAMERA_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from select() rather than dereferencing undefined', async () => {
    const result = await useCameraStore.getState().select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(useCameraStore.getState().selecting).toBe(false)
  })

  it('returns an Err from setConfig() rather than dereferencing undefined', async () => {
    const result = await useCameraStore.getState().setConfig(defaultCameraConfig())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(useCameraStore.getState().saving).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = useCameraStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(useCameraStore.getState().bridgeAvailable).toBe(false)
  })
})

describe('cameraStore with a bridge', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCameraStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates the mapping and the observed camera state from the main process', async () => {
    await useCameraStore.getState().hydrate()

    const store = useCameraStore.getState()
    expect(store.bridgeAvailable).toBe(true)
    expect(store.hydrated).toBe(true)
    expect(store.state.activeSlot).toBe('cam1')
    expect(store.state.currentProgramScene).toBe(MOCK_CAMERA_SCENES.cam1)
    expect(store.state.availableTransitions).toContain('Fade')
    expect(store.config.bindings).toHaveLength(4)
  })

  it('keeps the last known mapping when the config read fails, rather than blanking the buttons', async () => {
    installed.mock.responses.cameraGetConfig = err(ErrorCode.IO_ERROR, 'config file unreadable')

    await useCameraStore.getState().hydrate()

    const store = useCameraStore.getState()
    expect(store.config).toEqual(defaultCameraConfig())
    expect(store.lastError?.code).toBe(ErrorCode.IO_ERROR)
    expect(store.hydrated).toBe(true)
  })

  it('forwards the exact slot and adopts the returned state', async () => {
    await useCameraStore.getState().hydrate()

    const result = await useCameraStore.getState().select('pulpit')

    expect(installed.mock.calls.cameraSelect).toEqual(['pulpit'])
    expect(result.ok).toBe(true)
    const store = useCameraStore.getState()
    expect(store.state.activeSlot).toBe('pulpit')
    expect(store.state.currentProgramScene).toBe(MOCK_CAMERA_SCENES.pulpit)
    expect(store.selecting).toBe(false)
  })

  it('sends NOT ONE overlay command when a camera is selected', async () => {
    await useCameraStore.getState().hydrate()
    await useCameraStore.getState().select('wide')
    await useCameraStore.getState().select('cam2')

    // BLUEPRINT.md §6, at the store level: the camera path and the overlay path share no code and
    // no state, so switching cameras cannot disturb what the congregation is reading.
    expect(installed.mock.calls.overlaySend).toEqual([])
    expect(installed.mock.calls.overlayGetState).toEqual([])
  })

  it('leaves the mirrored state untouched when a switch is refused', async () => {
    await useCameraStore.getState().hydrate()
    installed.mock.responses.cameraSelect = err(ErrorCode.NOT_CONNECTED, 'OBS is not connected')

    const result = await useCameraStore.getState().select('wide')

    expect(result.ok).toBe(false)
    const store = useCameraStore.getState()
    // OBS owns the program scene. A refused request has not moved it, so the store must not
    // invent a live camera the operator would then trust.
    expect(store.state.activeSlot).toBe('cam1')
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(store.selecting).toBe(false)
  })

  it('refuses a slot with no scene bound instead of asking OBS for a scene that is not there', async () => {
    installed.mock.responses.cameraGetConfig = ok(mockCameraConfig({ pulpit: null }))
    await useCameraStore.getState().hydrate()

    const result = await useCameraStore.getState().select('pulpit')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(useCameraStore.getState().state.activeSlot).toBe('cam1')
  })

  it('applies a pushed state — a scene switched inside OBS is the ordinary case', () => {
    const unsubscribe = useCameraStore.getState().subscribe()

    installed.mock.emit(IpcEvent.cameraState, mockCameraState({ activeSlot: 'wide' }))
    expect(useCameraStore.getState().state.activeSlot).toBe('wide')

    // The operator switched OBS to a scene no button maps to. Verger must say "none of these",
    // not keep the last button lit.
    installed.mock.emit(
      IpcEvent.cameraState,
      mockCameraState({ currentProgramScene: 'Welcome loop', activeSlot: null }),
    )
    expect(useCameraStore.getState().state.activeSlot).toBeNull()
    expect(useCameraStore.getState().state.currentProgramScene).toBe('Welcome loop')

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.cameraState)).toBe(0)
  })

  it('persists a new mapping and adopts what the main process stored', async () => {
    const next = mockCameraConfig({ pulpit: 'Welcome loop' })

    const result = await useCameraStore.getState().setConfig(next)

    expect(installed.mock.calls.cameraSetConfig).toEqual([next])
    expect(result.ok).toBe(true)
    const store = useCameraStore.getState()
    expect(store.config.bindings.find((b) => b.slot === 'pulpit')?.sceneName).toBe('Welcome loop')
    expect(store.saving).toBe(false)
  })

  it('keeps the previous mapping when a save is refused', async () => {
    await useCameraStore.getState().hydrate()
    installed.mock.responses.cameraSetConfig = err(ErrorCode.IO_ERROR, 'disk full')

    const result = await useCameraStore.getState().setConfig(mockCameraConfig({ cam1: null }))

    expect(result.ok).toBe(false)
    const store = useCameraStore.getState()
    expect(store.config.bindings.find((b) => b.slot === 'cam1')?.sceneName).toBe(
      MOCK_CAMERA_SCENES.cam1,
    )
    expect(store.lastError?.code).toBe(ErrorCode.IO_ERROR)
    expect(store.saving).toBe(false)
  })

  it('converts a rejected bridge promise into an Err instead of propagating it', async () => {
    window.verger = {
      ...installed.mock.api,
      camera: {
        ...installed.mock.api.camera,
        select: () => Promise.reject(new Error('bridge exploded')),
      },
    }

    const result = await useCameraStore.getState().select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL)
      expect(result.error.message).toBe('bridge exploded')
    }
    expect(useCameraStore.getState().selecting).toBe(false)
  })

  it('never reads or writes overlay state, whatever it is asked to do', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState())

    await useCameraStore.getState().hydrate()
    await useCameraStore.getState().select('cam2')
    await useCameraStore.getState().setConfig(mockCameraConfig({ wide: null }))

    expect(installed.mock.calls.overlaySend).toEqual([])
    expect(installed.mock.calls.overlayGetState).toEqual([])
    expect(installed.mock.calls.overlayGetServerInfo).toEqual([])
  })
})

describe('cameraButtons', () => {
  it('always yields four rows in slot order, even from an empty configuration', () => {
    const rows = cameraButtons({ bindings: [] }, mockCameraState())

    expect(rows.map((row) => row.slot)).toEqual(['cam1', 'cam2', 'wide', 'pulpit'])
    expect(rows.every((row) => !row.usable)).toBe(true)
    expect(rows.every((row) => !row.live)).toBe(true)
  })

  it('marks an unbound slot unusable and every bound slot usable', () => {
    const rows = cameraButtons(mockCameraConfig({ pulpit: null }), mockCameraState())

    expect(rows.find((row) => row.slot === 'pulpit')?.usable).toBe(false)
    expect(rows.find((row) => row.slot === 'pulpit')?.sceneName).toBeNull()
    expect(rows.find((row) => row.slot === 'wide')?.usable).toBe(true)
    expect(rows.find((row) => row.slot === 'wide')?.sceneName).toBe(MOCK_CAMERA_SCENES.wide)
  })

  it('lights exactly one button, and none at all when the live scene maps to no button', () => {
    const lit = cameraButtons(mockCameraConfig(), mockCameraState({ activeSlot: 'cam2' }))
    expect(lit.filter((row) => row.live).map((row) => row.slot)).toEqual(['cam2'])

    const unmapped = cameraButtons(
      mockCameraConfig(),
      mockCameraState({ currentProgramScene: 'Welcome loop', activeSlot: null }),
    )
    expect(unmapped.filter((row) => row.live)).toEqual([])
  })
})
