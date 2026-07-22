/**
 * `CameraService` behaviour, driven entirely against a hand-written OBS double.
 *
 * No OBS Studio, no socket, no filesystem. The machine running these tests does not have OBS
 * installed, and that is the point: the camera buttons are what an operator reaches for when a
 * service is already live, so their behaviour has to be provable on a laptop.
 *
 * The first describe block is the load-bearing one. BLUEPRINT.md §6 promises that switching
 * cameras does not touch the lower-third; these tests are that promise, asserted two ways —
 * structurally (the module cannot reach the overlay, because it does not import it) and
 * behaviourally (a `select()` puts nothing on the wire but scene and transition requests).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { CameraService } from '@main/camera/CameraService'
import type { CameraObsClientLike } from '@main/camera/CameraService'
import { createNullLogger } from '@main/logging/logger'
import { CAMERA_SLOTS, defaultCameraConfig } from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { ObsSceneList, ObsStatus } from '@shared/obs'
import { ErrorCode, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'

// The camera service must be constructible with no Electron runtime; `index.ts` is the only
// file in the module that touches `app`, and only from inside a lazy seam.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(ELECTRON_USER_DATA, name)
  }
}))

const ELECTRON_USER_DATA = mkdtempSync(join(tmpdir(), 'verger-camera-'))

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly type: string
  readonly data: Record<string, unknown> | undefined
}

const DEFAULT_TRANSITIONS = {
  currentSceneTransitionName: 'Fade',
  transitions: [
    { transitionName: 'Cut', transitionKind: 'cut_transition' },
    { transitionName: 'Fade', transitionKind: 'fade_transition' }
  ]
}

function statusWith(patch: Partial<ObsStatus> = {}): ObsStatus {
  return {
    state: 'connected',
    since: 0,
    attempt: 0,
    nextRetryInMs: null,
    obsVersion: '30.1.2',
    obsWebSocketVersion: '5.4.2',
    rpcVersion: 1,
    currentProgramScene: null,
    lastError: null,
    ...patch
  }
}

/** A minimal, fully typed `CameraObsClientLike`. Records every request, in order. */
class MockObs implements CameraObsClientLike {
  readonly requests: RecordedRequest[] = []
  readonly responses = new Map<string, unknown>([['GetSceneTransitionList', DEFAULT_TRANSITIONS]])
  readonly failures = new Map<string, AppError>()
  /** Request names that make `call()` throw, proving the service never propagates one. */
  readonly throwing = new Set<string>()

  status: ObsStatus = statusWith()
  sceneList: ObsSceneList = {
    scenes: [
      { name: 'Camera 1', index: 0 },
      { name: 'Camera 2', index: 1 },
      { name: 'Pulpit', index: 2 }
    ],
    currentProgramScene: null,
    currentPreviewScene: null
  }

  private readonly statusSubscribers = new Set<(status: ObsStatus) => void>()
  private readonly sceneListSubscribers = new Set<(list: ObsSceneList) => void>()

  async call(
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Result<unknown>> {
    this.requests.push({ type: requestType, data: requestData })
    if (this.throwing.has(requestType)) throw new Error(`${requestType} exploded`)

    const failure = this.failures.get(requestType)
    if (failure !== undefined) return { ok: false, error: failure }
    return ok(this.responses.get(requestType) ?? {})
  }

  async getSceneList(): Promise<Result<ObsSceneList>> {
    this.requests.push({ type: 'GetSceneList', data: undefined })
    return ok(this.sceneList)
  }

  getStatus(): ObsStatus {
    return this.status
  }

  onStatus(callback: (status: ObsStatus) => void): () => void {
    this.statusSubscribers.add(callback)
    return () => {
      this.statusSubscribers.delete(callback)
    }
  }

  onSceneList(callback: (list: ObsSceneList) => void): () => void {
    this.sceneListSubscribers.add(callback)
    return () => {
      this.sceneListSubscribers.delete(callback)
    }
  }

  /** Every request name that reached the wire, in order. */
  names(): string[] {
    return this.requests.map((request) => request.type)
  }

  clear(): void {
    this.requests.length = 0
  }

  /** Simulate OBS moving — a hotkey, the OBS UI, or another client. */
  emitProgramScene(sceneName: string | null): void {
    this.status = { ...this.status, currentProgramScene: sceneName }
    this.sceneList = { ...this.sceneList, currentProgramScene: sceneName }
    for (const subscriber of [...this.sceneListSubscribers]) subscriber(this.sceneList)
  }

  emitStatus(patch: Partial<ObsStatus>): void {
    this.status = { ...this.status, ...patch }
    // Real OBS reports one truth: keep the scene list the double hands back consistent with the
    // status, or the service's re-interrogation on connect would read a contradiction.
    if (patch.currentProgramScene !== undefined) {
      this.sceneList = { ...this.sceneList, currentProgramScene: patch.currentProgramScene }
    }
    for (const subscriber of [...this.statusSubscribers]) subscriber(this.status)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MAPPED: CameraConfig = {
  bindings: [
    {
      slot: 'cam1',
      label: 'CAM 1',
      sceneName: 'Camera 1',
      transition: null,
      transitionDurationMs: null
    },
    {
      slot: 'cam2',
      label: 'CAM 2',
      sceneName: 'Camera 2',
      transition: 'Fade',
      transitionDurationMs: 300
    },
    { slot: 'wide', label: 'WIDE', sceneName: null, transition: null, transitionDurationMs: null },
    {
      slot: 'pulpit',
      label: 'PULPIT',
      sceneName: 'Pulpit',
      transition: 'Cut',
      transitionDurationMs: null
    }
  ]
}

interface HarnessOptions {
  readonly config?: CameraConfig
  readonly connected?: boolean
  readonly programScene?: string | null
  readonly persist?: (config: CameraConfig) => Result<void>
  readonly load?: () => Result<CameraConfig | null>
}

interface Harness {
  readonly service: CameraService
  readonly obs: MockObs
  readonly states: CameraState[]
}

/** Drain the microtask queue so the constructor's OBS refresh settles before assertions. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const obs = new MockObs()
  const connected = options.connected ?? true
  obs.status = statusWith({
    state: connected ? 'connected' : 'disconnected',
    currentProgramScene: options.programScene ?? null
  })
  obs.sceneList = { ...obs.sceneList, currentProgramScene: options.programScene ?? null }

  const config = options.config ?? MAPPED
  const service = new CameraService({
    obs,
    logger: createNullLogger(),
    load: options.load ?? (() => ok(config)),
    ...(options.persist === undefined ? {} : { persist: options.persist })
  })

  const states: CameraState[] = []
  service.onState((state) => states.push(state))

  await flush()
  return { service, obs, states }
}

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL('./CameraService.ts', import.meta.url)),
  'utf8'
)
const INDEX_SOURCE = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

afterAll(() => {
  rmSync(ELECTRON_USER_DATA, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The independence guarantee — BLUEPRINT.md §6
// ---------------------------------------------------------------------------

describe('CameraService — a camera switch is camera work ONLY', () => {
  it('issues exactly one scene request and nothing else', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    harness.obs.clear()

    const result = await harness.service.select('cam1')

    expect(result.ok).toBe(true)
    // The complete list of what a camera switch put on the wire.
    expect(harness.obs.names()).toEqual(['SetCurrentProgramScene'])
    expect(harness.obs.requests[0]?.data).toEqual({ sceneName: 'Camera 1' })
  })

  it('never issues a request that touches any other layer', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    harness.obs.clear()

    await harness.service.select('cam1')
    await harness.service.select('cam2')
    await harness.service.select('pulpit')

    for (const name of harness.obs.names()) {
      // Scene and transition requests only: nothing that could show, hide, move or restyle an
      // overlay, a browser source, a media source or a filter.
      expect(name).toMatch(/^SetCurrent(ProgramScene|SceneTransition|SceneTransitionDuration)$/)
    }
    expect(harness.obs.names().filter((name) => /overlay|lower|browser|source|filter/i.test(name)))
      .toEqual([])
  })

  it('cannot reach the overlay at all: it imports no overlay module', () => {
    // The strongest form of the guarantee. A camera switch cannot disturb a lower-third because
    // this module has no way to address one — and re-introducing that ability means adding an
    // import, which fails here.
    expect(SERVICE_SOURCE).not.toMatch(/from\s+['"][^'"]*overlay/i)
    expect(SERVICE_SOURCE).not.toMatch(/require\(\s*['"][^'"]*overlay/i)
    expect(SERVICE_SOURCE).not.toMatch(/import\(\s*['"][^'"]*overlay/i)
    expect(INDEX_SOURCE).not.toMatch(/from\s+['"][^'"]*overlay/i)
    expect(INDEX_SOURCE).not.toMatch(/require\(\s*['"][^'"]*overlay/i)
  })

  it('exposes no overlay verb on its public surface', () => {
    const surface = Object.getOwnPropertyNames(CameraService.prototype)

    expect(surface.filter((name) => /overlay|lower|third|slide|scripture/i.test(name))).toEqual([])
    expect(surface).toEqual(
      expect.arrayContaining(['getConfig', 'setConfig', 'getState', 'select', 'onState', 'dispose'])
    )
  })

  it('reports camera state that says nothing about any other layer', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })

    const state = harness.service.getState()

    expect(state.ok).toBe(true)
    if (state.ok) {
      expect(Object.keys(state.value).sort()).toEqual([
        'activeSlot',
        'availableTransitions',
        'currentProgramScene'
      ])
    }
  })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('CameraService — select refuses before it dials', () => {
  it('rejects an unmapped slot and issues NO OBS request', async () => {
    const harness = await createHarness()
    harness.obs.clear()

    const result = await harness.service.select('wide')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
      expect(result.error.message).toContain('WIDE')
      expect(result.error.detail).toContain('camera settings')
    }
    // The whole point: an unmapped button never asks OBS for a scene that does not exist.
    expect(harness.obs.names()).toEqual([])
  })

  it('rejects a slot that is not in the configuration at all', async () => {
    const harness = await createHarness({ config: { bindings: [] } })
    harness.obs.clear()

    const result = await harness.service.select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(harness.obs.names()).toEqual([])
  })

  it('rejects a bogus slot arriving from outside without touching OBS', async () => {
    const harness = await createHarness()
    harness.obs.clear()

    const result = await harness.service.select('cam9' as CameraSlot)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(harness.obs.names()).toEqual([])
  })

  it('returns NOT_CONNECTED when OBS is down, and issues NO request', async () => {
    const harness = await createHarness({ connected: false })
    harness.obs.clear()

    const result = await harness.service.select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
      expect(result.error.message).toContain('CAM 1')
    }
    expect(harness.obs.names()).toEqual([])
  })

  it('propagates an OBS-side failure of the scene switch', async () => {
    const harness = await createHarness()
    harness.obs.failures.set('SetCurrentProgramScene', {
      code: ErrorCode.OBS_ERROR,
      message: 'ResourceNotFound'
    })
    harness.obs.clear()

    const result = await harness.service.select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.OBS_ERROR)
    // A failed switch does not pretend the camera moved.
    expect(harness.service.getState()).toEqual(ok(expect.objectContaining({ activeSlot: null })))
  })

  it('converts a thrown OBS error into a Result rather than propagating it', async () => {
    const harness = await createHarness()
    harness.obs.throwing.add('SetCurrentProgramScene')

    const result = await harness.service.select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.OBS_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe('CameraService — transitions', () => {
  it('sets the transition, then the duration, then the scene — in that order', async () => {
    const harness = await createHarness()
    harness.obs.clear()

    const result = await harness.service.select('cam2')

    expect(result.ok).toBe(true)
    expect(harness.obs.names()).toEqual([
      'SetCurrentSceneTransition',
      'SetCurrentSceneTransitionDuration',
      'SetCurrentProgramScene'
    ])
    expect(harness.obs.requests[0]?.data).toEqual({ transitionName: 'Fade' })
    expect(harness.obs.requests[1]?.data).toEqual({ transitionDuration: 300 })
    expect(harness.obs.requests[2]?.data).toEqual({ sceneName: 'Camera 2' })
  })

  it('omits the duration when the binding does not name one', async () => {
    const harness = await createHarness()
    harness.obs.clear()

    await harness.service.select('pulpit')

    expect(harness.obs.names()).toEqual(['SetCurrentSceneTransition', 'SetCurrentProgramScene'])
  })

  it('switches anyway when the transition cannot be set', async () => {
    const harness = await createHarness()
    harness.obs.failures.set('SetCurrentSceneTransition', {
      code: ErrorCode.OBS_ERROR,
      message: 'no such transition'
    })
    harness.obs.clear()

    const result = await harness.service.select('cam2')

    // The operator pressed CAM 2 and gets CAM 2, even with the wrong wipe.
    expect(result.ok).toBe(true)
    expect(harness.obs.names()).toEqual(['SetCurrentSceneTransition', 'SetCurrentProgramScene'])
    if (result.ok) expect(result.value.activeSlot).toBe('cam2')
  })

  it('reads the available transitions from OBS once connected', async () => {
    const harness = await createHarness()

    const state = harness.service.getState()

    expect(state.ok).toBe(true)
    if (state.ok) expect(state.value.availableTransitions).toEqual(['Cut', 'Fade'])
    expect(harness.obs.names()).toContain('GetSceneTransitionList')
  })

  it('reports an empty transition list while OBS is disconnected, and fills it on connect', async () => {
    const harness = await createHarness({ connected: false })

    expect(harness.service.getState()).toEqual(ok(expect.objectContaining({
      availableTransitions: []
    })))
    // Not one request was issued while disconnected.
    expect(harness.obs.names()).toEqual([])

    harness.obs.emitStatus({ state: 'connected', currentProgramScene: 'Camera 1' })
    await flush()

    const state = harness.service.getState()
    if (state.ok) {
      expect(state.value.availableTransitions).toEqual(['Cut', 'Fade'])
      expect(state.value.activeSlot).toBe('cam1')
    }
  })

  it('never fails because the transition list could not be read', async () => {
    const obs = new MockObs()
    obs.failures.set('GetSceneTransitionList', {
      code: ErrorCode.OBS_ERROR,
      message: 'unsupported'
    })
    obs.status = statusWith({ currentProgramScene: 'Camera 1' })
    obs.sceneList = { ...obs.sceneList, currentProgramScene: 'Camera 1' }

    const service = new CameraService({
      obs,
      logger: createNullLogger(),
      load: () => ok(MAPPED)
    })
    await flush()

    const state = service.getState()
    expect(state.ok).toBe(true)
    if (state.ok) {
      expect(state.value.availableTransitions).toEqual([])
      expect(state.value.activeSlot).toBe('cam1')
    }
    // And switching still works.
    expect((await service.select('cam1')).ok).toBe(true)
    service.dispose()
  })
})

// ---------------------------------------------------------------------------
// OBS is the source of truth
// ---------------------------------------------------------------------------

describe('CameraService — OBS is the source of truth', () => {
  it('follows a scene switched inside OBS and updates activeSlot', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    expect(harness.service.getState()).toEqual(ok(expect.objectContaining({ activeSlot: 'cam1' })))

    harness.obs.emitProgramScene('Pulpit')

    const state = harness.service.getState()
    if (state.ok) {
      expect(state.value.currentProgramScene).toBe('Pulpit')
      expect(state.value.activeSlot).toBe('pulpit')
    }
    expect(harness.states.at(-1)?.activeSlot).toBe('pulpit')
  })

  it('does NOT correct OBS when the scene changes underneath it', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    harness.obs.clear()

    harness.obs.emitProgramScene('Pulpit')
    await flush()

    // Reflecting OBS is a read-only act: no request was issued in response.
    expect(harness.obs.names()).toEqual([])
  })

  it('reports activeSlot null when the live scene is not bound to any button', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })

    harness.obs.emitProgramScene('Announcements Loop')

    const state = harness.service.getState()
    if (state.ok) {
      expect(state.value.currentProgramScene).toBe('Announcements Loop')
      // No button lights up, and Verger does not switch OBS back.
      expect(state.value.activeSlot).toBeNull()
    }
  })

  it('reports activeSlot null when OBS reports no program scene at all', async () => {
    const harness = await createHarness({ programScene: null, connected: false })

    expect(harness.service.getState()).toEqual(
      ok({ currentProgramScene: null, activeSlot: null, availableTransitions: [] })
    )
  })

  it('re-interrogates OBS on reconnect rather than trusting its own memory', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })

    harness.obs.emitStatus({ state: 'reconnecting' })
    harness.obs.sceneList = { ...harness.obs.sceneList, currentProgramScene: 'Pulpit' }
    harness.obs.clear()
    harness.obs.emitStatus({ state: 'connected', currentProgramScene: 'Pulpit' })
    await flush()

    expect(harness.obs.names()).toEqual(['GetSceneList', 'GetSceneTransitionList'])
    expect(harness.service.getState()).toEqual(
      ok(expect.objectContaining({ activeSlot: 'pulpit' }))
    )
  })
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('CameraService — configuration', () => {
  it('starts from the four default buttons when nothing is saved', async () => {
    const harness = await createHarness({ load: () => ok(null) })

    const config = harness.service.getConfig()

    expect(config).toEqual(ok(defaultCameraConfig()))
    if (config.ok) {
      expect(config.value.bindings.map((binding) => binding.slot)).toEqual([...CAMERA_SLOTS])
      expect(config.value.bindings.every((binding) => binding.sceneName === null)).toBe(true)
    }
  })

  it('falls back to the defaults when the saved configuration is unreadable', async () => {
    const harness = await createHarness({
      load: () => {
        throw new Error('EACCES')
      }
    })

    expect(harness.service.getConfig()).toEqual(ok(defaultCameraConfig()))
  })

  it('falls back to the defaults when the saved configuration is invalid', async () => {
    const harness = await createHarness({
      load: () => ok({ bindings: [{ slot: 'nope' }] } as unknown as CameraConfig)
    })

    expect(harness.service.getConfig()).toEqual(ok(defaultCameraConfig()))
  })

  it('rejects an invalid configuration and keeps the previous one', async () => {
    const harness = await createHarness()

    const result = harness.service.setConfig({
      bindings: [
        {
          slot: 'cam1',
          label: '',
          sceneName: 'Camera 1',
          transition: null,
          transitionDurationMs: null
        }
      ]
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
      expect(result.error.detail).toContain('label')
    }
    expect(harness.service.getConfig()).toEqual(ok(MAPPED))
  })

  it('rejects a configuration with more bindings than there are buttons', async () => {
    const harness = await createHarness()
    const tooMany: CameraConfig = { bindings: [...MAPPED.bindings, ...MAPPED.bindings] }

    const result = harness.service.setConfig(tooMany)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
  })

  it('re-derives activeSlot when a binding is re-pointed, with no OBS request', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    harness.obs.clear()

    const rebound: CameraConfig = {
      bindings: MAPPED.bindings.map((binding) =>
        binding.slot === 'cam1' ? { ...binding, sceneName: 'Pulpit' } : binding
      )
    }
    const result = harness.service.setConfig(rebound)

    expect(result.ok).toBe(true)
    // 'Camera 1' is live but now belongs to no button.
    expect(harness.service.getState()).toEqual(ok(expect.objectContaining({ activeSlot: null })))
    expect(harness.obs.names()).toEqual([])
  })

  it('round-trips the configuration through the persistence seams', async () => {
    let stored: CameraConfig | null = null

    const first = await createHarness({
      load: () => ok(stored),
      persist: (config) => {
        stored = config
        return ok(undefined)
      }
    })
    expect(first.service.getConfig()).toEqual(ok(defaultCameraConfig()))

    const written = first.service.setConfig(MAPPED)
    expect(written).toEqual(ok(MAPPED))
    expect(stored).toEqual(MAPPED)
    first.service.dispose()

    // A fresh service — as after an app restart — sees exactly what was saved.
    const second = await createHarness({ load: () => ok(stored) })
    expect(second.service.getConfig()).toEqual(ok(MAPPED))
    expect((await second.service.select('cam2')).ok).toBe(true)
  })

  it('keeps the mapping live for the session when it cannot be saved', async () => {
    const harness = await createHarness({
      load: () => ok(null),
      persist: () => ({ ok: false, error: { code: ErrorCode.IO_ERROR, message: 'disk full' } })
    })

    const result = harness.service.setConfig(MAPPED)

    // Reported, so the operator knows it will not survive a restart...
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.IO_ERROR)
    // ...but the buttons work for the rest of the service.
    expect(harness.service.getConfig()).toEqual(ok(MAPPED))
    expect((await harness.service.select('cam1')).ok).toBe(true)
  })

  it('survives a persistence seam that throws', async () => {
    const harness = await createHarness({
      load: () => ok(null),
      persist: () => {
        throw new Error('EROFS')
      }
    })

    const result = harness.service.setConfig(MAPPED)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.IO_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

describe('CameraService — subscribers', () => {
  it('notifies on a switch, and not on a no-op re-select', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    const before = harness.states.length

    await harness.service.select('pulpit')
    await harness.service.select('pulpit')

    expect(harness.states.length).toBe(before + 1)
    expect(harness.states.at(-1)?.activeSlot).toBe('pulpit')
  })

  it('stops delivering after unsubscribe', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    const seen: CameraState[] = []
    const unsubscribe = harness.service.onState((state) => seen.push(state))

    unsubscribe()
    harness.obs.emitProgramScene('Pulpit')

    expect(seen).toEqual([])
  })

  it('isolates a throwing subscriber from the rest', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })
    const seen: CameraState[] = []
    harness.service.onState(() => {
      throw new Error('a renderer bridge blew up')
    })
    harness.service.onState((state) => seen.push(state))

    harness.obs.emitProgramScene('Pulpit')

    expect(seen.at(-1)?.activeSlot).toBe('pulpit')
  })

  it('delivers nothing after dispose, and detaches from OBS', async () => {
    const harness = await createHarness({ programScene: 'Camera 1' })

    expect(harness.service.dispose()).toEqual(ok(undefined))
    harness.service.dispose()
    const before = harness.states.length
    harness.obs.emitProgramScene('Pulpit')
    harness.obs.emitStatus({ state: 'disconnected' })

    expect(harness.states.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

describe('getCameraService', () => {
  afterEach(async () => {
    const camera = await import('@main/camera')
    camera.resetCameraService()
    const obs = await import('@main/obs')
    await obs.resetObsClient()
  })

  it('is callable with no arguments, is a singleton, and starts on the defaults', async () => {
    // `src/main/ipc/register.ts` calls it exactly this way.
    const module = await import('@main/camera')

    const service = module.getCameraService()
    const again = module.getCameraService()

    expect(again).toBe(service)
    expect(service.getConfig()).toEqual(ok(defaultCameraConfig()))
    expect(service.getState()).toEqual(
      ok({ currentProgramScene: null, activeSlot: null, availableTransitions: [] })
    )
  })

  it('round-trips the configuration through a real file under userData', async () => {
    const module = await import('@main/camera')
    const filePath = join(ELECTRON_USER_DATA, 'camera-roundtrip.json')

    expect(module.readCameraConfigFile(filePath)).toEqual(ok(null))
    expect(module.writeCameraConfigFile(filePath, MAPPED)).toEqual(ok(undefined))
    expect(module.readCameraConfigFile(filePath)).toEqual(
      ok(expect.objectContaining({ bindings: MAPPED.bindings }))
    )

    rmSync(filePath, { force: true })
  })

  it('reports a corrupt configuration file rather than throwing', async () => {
    const module = await import('@main/camera')
    const filePath = join(ELECTRON_USER_DATA, 'camera-corrupt.json')
    module.writeCameraConfigFile(filePath, MAPPED)
    // Simulate a truncated write.
    writeFileSync(filePath, '{ "version": 1, "bindings": [', 'utf8')

    const result = module.readCameraConfigFile(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.IO_ERROR)

    rmSync(filePath, { force: true })
  })

  it('refuses an unmapped button on a fresh profile, before OBS is consulted', async () => {
    const module = await import('@main/camera')

    const result = await module.getCameraService().select('cam1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
  })
})
