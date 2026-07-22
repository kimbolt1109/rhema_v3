/**
 * `PlanService` behaviour — the manual slide driver every later automation degrades to.
 *
 * The whole suite runs against hand-written doubles: no overlay server, no OBS Studio, no camera,
 * no disk. That is the requirement rather than a convenience — Phase 6 has to be provably usable
 * with nothing installed, because "the operator presses SPACE and the next slide appears" is the
 * fallback Phases 7 and 8 fail back to.
 *
 * Four promises are asserted here:
 *
 *  1. **Every cue type routes to exactly one subsystem**, and a scripture cue carries a REFERENCE
 *     with an empty text (Standing Rule 4).
 *  2. **Media cues are refused while `TriggerMediaInputAction` is off the OBS write allowlist**,
 *     with an error that says so — and start working, untouched, if a reviewed change ever adds
 *     it. The allowlist itself is asserted directly, so this test fails loudly if someone widens
 *     it without meaning to.
 *  3. **`advance` clamps at the end and `back` does not re-fire.**
 *  4. **`dirty` tracks edits and clears only on a successful save.**
 *
 * Every fixture uses obvious placeholders. No hymn lyrics, no verse text, no real sermon.
 */

import { describe, expect, it, vi } from 'vitest'

import { createNullLogger } from '@main/logging/logger'
import { ALLOWED_WRITE_REQUESTS, isAllowedRequest } from '@main/obs/ObsClient'
import { MEDIA_TRIGGER_REQUEST, PlanService } from '@main/plan/PlanService'
import type {
  PlanCameraLike,
  PlanFileAccess,
  PlanObsLike,
  PlanOverlayLike
} from '@main/plan/PlanService'
import type { LoadedPlan } from '@main/plan/planFile'
import type { PlanState } from '@shared/ipc'
import { emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand } from '@shared/overlay'
import type { Cue, ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_PATH = 'C:/verger-test/plans/sunday.json'

function cue(overrides: Partial<Cue> & Pick<Cue, 'id' | 'type' | 'payload'>): Cue {
  return {
    label: `PLACEHOLDER CUE ${overrides.id}`,
    trigger: { mode: 'manual' },
    ...overrides
  }
}

const SLIDE_CUE = cue({ id: 'c-slide', type: 'slide', payload: { asset: 'slides/slide-1.png' } })
const LOWER_THIRD_CUE = cue({
  id: 'c-lower',
  type: 'lowerthird',
  payload: { line1: 'PLACEHOLDER NAME', line2: 'PLACEHOLDER ROLE', template: 'boxed' }
})
const SCRIPTURE_CUE = cue({
  id: 'c-scripture',
  type: 'scripture',
  payload: { reference: 'PLACEHOLDER 1:1', translation: 'KJV' }
})
const CAMERA_SCENE_CUE = cue({ id: 'c-cam', type: 'scene', payload: { scene: 'pulpit' } })
const OBS_SCENE_CUE = cue({
  id: 'c-scene',
  type: 'scene',
  payload: { scene: 'PLACEHOLDER SCENE' }
})
const MEDIA_CUE = cue({
  id: 'c-media',
  type: 'media',
  payload: { asset: 'media/clip.mp4', obsInputName: 'PLACEHOLDER INPUT' }
})
const CLEAR_CUE = cue({ id: 'c-clear', type: 'action', payload: { action: 'clearAll' } })

function planOf(cues: readonly Cue[]): ServicePlan {
  return {
    schemaVersion: 1,
    service: 'PLACEHOLDER SERVICE',
    defaultMode: 'assist',
    cues,
    assetDir: 'assets'
  }
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: PlanService
  readonly overlay: { commands: OverlayCommand[]; fail: boolean }
  readonly camera: { slots: string[]; fail: boolean }
  readonly obs: { calls: { type: string; data?: Record<string, unknown> }[]; fail: boolean }
  readonly files: {
    saved: { path: string; plan: ServicePlan }[]
    loadResult: Result<LoadedPlan>
    saveResult: Result<string> | null
    assetResult: Result<string> | null
  }
  readonly states: PlanState[]
}

function createHarness(
  options: { readonly allowMedia?: boolean; readonly withFiles?: boolean } = {}
): Harness {
  const overlay = { commands: [] as OverlayCommand[], fail: false }
  const camera = { slots: [] as string[], fail: false }
  const obs = { calls: [] as { type: string; data?: Record<string, unknown> }[], fail: false }
  const files = {
    saved: [] as { path: string; plan: ServicePlan }[],
    loadResult: ok({ plan: planOf([SLIDE_CUE]), path: PLAN_PATH }) as Result<LoadedPlan>,
    saveResult: null as Result<string> | null,
    assetResult: null as Result<string> | null
  }
  const states: PlanState[] = []

  const overlaySeam: PlanOverlayLike = {
    send: (command) => {
      if (overlay.fail) return err(ErrorCode.INVALID_ARG, 'the overlay refused this')
      overlay.commands.push(command)
      return ok(emptyOverlayState())
    }
  }

  const cameraSeam: PlanCameraLike = {
    select: async (slot) => {
      if (camera.fail) return err(ErrorCode.NOT_CONNECTED, 'OBS is closed')
      camera.slots.push(slot)
      return ok({})
    }
  }

  const obsSeam: PlanObsLike = {
    call: async (type, data) => {
      if (obs.fail) return err(ErrorCode.NOT_CONNECTED, 'OBS is closed')
      obs.calls.push(data === undefined ? { type } : { type, data })
      return ok({})
    }
  }

  const fileSeam: PlanFileAccess = {
    load: () => files.loadResult,
    save: (path, plan) => {
      files.saved.push({ path, plan })
      return files.saveResult ?? ok(path)
    },
    assetUrl: (_planPath, _plan, asset) => files.assetResult ?? ok(`file:///assets/${asset}`)
  }

  const service = new PlanService({
    overlay: overlaySeam,
    camera: cameraSeam,
    obs: obsSeam,
    logger: createNullLogger(),
    now: () => 1_700_000_000_000,
    ...(options.withFiles === false ? {} : { files: fileSeam }),
    ...(options.allowMedia === true ? { isObsRequestAllowed: () => true } : {})
  })
  service.onState((state) => states.push(state))

  return { service, overlay, camera, obs, files, states }
}

/** Load a plan through the file seam so the service has a path (slides need one). */
function loadPlan(harness: Harness, cues: readonly Cue[]): void {
  harness.files.loadResult = ok({ plan: planOf(cues), path: PLAN_PATH })
  const opened = harness.service.open(PLAN_PATH)
  expect(opened.ok).toBe(true)
}

function stateOf(harness: Harness): PlanState {
  const state = harness.service.getState()
  if (!state.ok) throw new Error('getState failed')
  return state.value
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('firing cues', () => {
  it('shows a slide on the overlay with the resolved asset URL', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])

    const fired = await harness.service.fireCue('c-slide')
    expect(fired.ok).toBe(true)
    expect(harness.overlay.commands).toEqual([
      { channel: 'command', name: 'slide.show', payload: { src: 'file:///assets/slides/slide-1.png' } }
    ])
    // Layer independence: a slide cue touches nothing but the overlay.
    expect(harness.camera.slots).toEqual([])
    expect(harness.obs.calls).toEqual([])
  })

  it('refuses a slide whose asset escapes the plan folder, and fires nothing', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    harness.files.assetResult = err(ErrorCode.INVALID_ARG, 'the asset path must stay inside the plan folder')

    const fired = await harness.service.fireCue('c-slide')
    expect(fired.ok).toBe(false)
    expect(harness.overlay.commands).toEqual([])
  })

  it('shows a lower third, coercing an unknown template rather than refusing the cue', async () => {
    const harness = createHarness()
    const odd = cue({
      id: 'c-odd',
      type: 'lowerthird',
      payload: { line1: 'PLACEHOLDER NAME', template: 'NOT A TEMPLATE' }
    })
    loadPlan(harness, [LOWER_THIRD_CUE, odd])

    await harness.service.fireCue('c-lower')
    await harness.service.fireCue('c-odd')

    expect(harness.overlay.commands[0]).toEqual({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 'PLACEHOLDER NAME', line2: 'PLACEHOLDER ROLE', template: 'boxed' }
    })
    expect(harness.overlay.commands[1]).toEqual({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 'PLACEHOLDER NAME', line2: '', template: 'bar' }
    })
  })

  it('fires scripture with the reference and an EMPTY text (Standing Rule 4)', async () => {
    const harness = createHarness()
    loadPlan(harness, [SCRIPTURE_CUE])

    await harness.service.fireCue('c-scripture')

    expect(harness.overlay.commands).toEqual([
      {
        channel: 'command',
        name: 'scripture.show',
        payload: { reference: 'PLACEHOLDER 1:1', text: '', translation: 'KJV', attribution: null }
      }
    ])
  })

  it('routes a camera-slot scene through the camera service', async () => {
    const harness = createHarness()
    loadPlan(harness, [CAMERA_SCENE_CUE])

    const fired = await harness.service.fireCue('c-cam')
    expect(fired.ok).toBe(true)
    expect(harness.camera.slots).toEqual(['pulpit'])
    expect(harness.obs.calls).toEqual([])
    // Standing Rule / BLUEPRINT §6: a camera switch does not touch the overlay.
    expect(harness.overlay.commands).toEqual([])
  })

  it('routes any other scene name straight to OBS', async () => {
    const harness = createHarness()
    loadPlan(harness, [OBS_SCENE_CUE])

    await harness.service.fireCue('c-scene')

    expect(harness.obs.calls).toEqual([
      { type: 'SetCurrentProgramScene', data: { sceneName: 'PLACEHOLDER SCENE' } }
    ])
    expect(harness.camera.slots).toEqual([])
  })

  it('maps an action cue onto the matching overlay command', async () => {
    const harness = createHarness()
    loadPlan(harness, [CLEAR_CUE])

    await harness.service.fireCue('c-clear')

    expect(harness.overlay.commands).toEqual([
      { channel: 'command', name: 'clearAll', payload: {} }
    ])
  })

  it('reports an action Verger does not know instead of silently doing nothing', async () => {
    const harness = createHarness()
    loadPlan(harness, [cue({ id: 'c-x', type: 'action', payload: { action: 'launchRockets' } })])

    const fired = await harness.service.fireCue('c-x')
    expect(fired.ok).toBe(false)
    if (fired.ok) return
    expect(fired.error.code).toBe(ErrorCode.NOT_FOUND)
    expect(fired.error.message).toContain('launchRockets')
    expect(harness.overlay.commands).toEqual([])
  })

  it('reports NOT_FOUND for a cue id that is not in the plan', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])

    const fired = await harness.service.fireCue('nope')
    expect(fired.ok).toBe(false)
    if (fired.ok) return
    expect(fired.error.code).toBe(ErrorCode.NOT_FOUND)
    // A cue that does not exist moves nothing.
    expect(stateOf(harness).position.index).toBe(-1)
  })

  it('moves the pointer on even when the cue failed, but does not claim it is showing', async () => {
    const harness = createHarness()
    loadPlan(harness, [OBS_SCENE_CUE, SLIDE_CUE])
    harness.obs.fail = true

    const fired = await harness.service.advance()
    expect(fired.ok).toBe(false)
    const state = stateOf(harness)
    // The operator is not wedged at cue 1 of 2 with a dead OBS...
    expect(state.position.index).toBe(0)
    // ...and the "now showing" readout does not lie about what reached the screen.
    expect(state.lastFired).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The OBS write allowlist
// ---------------------------------------------------------------------------

describe('media cues and the OBS write allowlist', () => {
  it('the allowlist does not contain the media request', () => {
    // If this fails, someone widened `ALLOWED_WRITE_REQUESTS` — which is allowed, but only as a
    // deliberate reviewed change, and this test is the place that notices.
    expect(ALLOWED_WRITE_REQUESTS).not.toContain(MEDIA_TRIGGER_REQUEST)
    expect(isAllowedRequest(MEDIA_TRIGGER_REQUEST)).toBe(false)
  })

  it('refuses a media cue with an error naming the allowlist, and sends OBS nothing', async () => {
    const harness = createHarness()
    loadPlan(harness, [MEDIA_CUE])

    const fired = await harness.service.fireCue('c-media')
    expect(fired.ok).toBe(false)
    if (fired.ok) return
    expect(fired.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(fired.error.message).toContain(MEDIA_TRIGGER_REQUEST)
    expect(fired.error.message).toContain('allowlist')
    expect(fired.error.detail).toContain('ALLOWED_WRITE_REQUESTS')
    expect(harness.obs.calls).toEqual([])
  })

  it('fires the media request unchanged once the guard permits it', async () => {
    const harness = createHarness({ allowMedia: true })
    loadPlan(harness, [MEDIA_CUE])

    const fired = await harness.service.fireCue('c-media')
    expect(fired.ok).toBe(true)
    expect(harness.obs.calls).toEqual([
      {
        type: MEDIA_TRIGGER_REQUEST,
        data: {
          inputName: 'PLACEHOLDER INPUT',
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        }
      }
    ])
  })

  it('reports a media cue that names no OBS input, once the guard permits the request', async () => {
    const harness = createHarness({ allowMedia: true })
    loadPlan(harness, [cue({ id: 'c-m2', type: 'media', payload: { asset: 'media/clip.mp4' } })])

    const fired = await harness.service.fireCue('c-m2')
    expect(fired.ok).toBe(false)
    if (fired.ok) return
    expect(fired.error.message).toContain('no OBS media input')
  })
})

// ---------------------------------------------------------------------------
// Advance / back
// ---------------------------------------------------------------------------

describe('advance and back', () => {
  it('walks the plan one cue at a time', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, SCRIPTURE_CUE, CLEAR_CUE])

    expect(stateOf(harness).position.index).toBe(-1)
    await harness.service.advance()
    expect(stateOf(harness).position.index).toBe(0)
    await harness.service.advance()
    expect(stateOf(harness).position.index).toBe(1)

    expect(harness.overlay.commands.map((command) => command.name)).toEqual([
      'slide.show',
      'scripture.show'
    ])
    expect(stateOf(harness).lastFired?.id).toBe('c-scripture')
  })

  it('clamps at the end of the plan rather than wrapping to the top', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, CLEAR_CUE])

    await harness.service.advance()
    await harness.service.advance()
    const past = await harness.service.advance()

    expect(past.ok).toBe(false)
    if (past.ok) return
    expect(past.error.code).toBe(ErrorCode.NOT_FOUND)
    expect(stateOf(harness).position.index).toBe(1)
    // Nothing extra reached the congregation screen.
    expect(harness.overlay.commands).toHaveLength(2)
  })

  it('steps back WITHOUT re-firing — undo means "I did not mean that"', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, SCRIPTURE_CUE])

    await harness.service.advance()
    await harness.service.advance()
    harness.overlay.commands.length = 0

    const back = harness.service.back()
    expect(back.ok).toBe(true)
    expect(stateOf(harness).position.index).toBe(0)
    // Not one command: back does not re-show, and it does not blank the screen either.
    expect(harness.overlay.commands).toEqual([])
    expect(harness.camera.slots).toEqual([])
    expect(harness.obs.calls).toEqual([])
  })

  it('clamps back at the top of the plan rather than wrapping to the end', () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, SCRIPTURE_CUE])

    harness.service.back()
    harness.service.back()
    expect(stateOf(harness).position.index).toBe(-1)
  })

  it('publishes a state snapshot on every move', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    const before = harness.states.length

    await harness.service.advance()
    harness.service.back()

    expect(harness.states.length).toBe(before + 2)
  })
})

// ---------------------------------------------------------------------------
// Editing, dirty tracking and persistence
// ---------------------------------------------------------------------------

describe('editing and persistence', () => {
  it('marks the plan dirty on an edit and clean on a successful save', () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    expect(stateOf(harness).dirty).toBe(false)

    const set = harness.service.setPlan(planOf([SLIDE_CUE, SCRIPTURE_CUE]))
    expect(set.ok).toBe(true)
    expect(stateOf(harness).dirty).toBe(true)

    const saved = harness.service.save()
    expect(saved.ok).toBe(true)
    expect(stateOf(harness).dirty).toBe(false)
    expect(harness.files.saved[0]?.path).toBe(PLAN_PATH)
  })

  it('leaves the plan dirty when the save failed', () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    harness.service.setPlan(planOf([SLIDE_CUE, SCRIPTURE_CUE]))
    harness.files.saveResult = err(ErrorCode.IO_ERROR, 'disk full')

    const saved = harness.service.save()
    expect(saved.ok).toBe(false)
    expect(stateOf(harness).dirty).toBe(true)
  })

  it('does not mark the plan dirty for driving it', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, SCRIPTURE_CUE])

    await harness.service.advance()
    harness.service.back()

    expect(stateOf(harness).dirty).toBe(false)
  })

  it('refuses an invalid plan and keeps the one already loaded', () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])

    const broken = planOf([
      cue({ id: 'c-bad', type: 'slide', payload: { scene: 'PLACEHOLDER SCENE' } })
    ])
    const set = harness.service.setPlan(broken)

    expect(set.ok).toBe(false)
    if (set.ok) return
    expect(set.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(set.error.detail).toContain('cue 1')
    expect(stateOf(harness).plan.cues[0]?.id).toBe('c-slide')
  })

  it('keeps the pointer meaningful across an edit instead of jumping back to the top', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE, SCRIPTURE_CUE, CLEAR_CUE])
    await harness.service.advance()
    await harness.service.advance()
    expect(stateOf(harness).position.index).toBe(1)

    // The operator edits a label further down the plan mid-service.
    harness.service.setPlan(planOf([SLIDE_CUE, SCRIPTURE_CUE, LOWER_THIRD_CUE]))
    expect(stateOf(harness).position.index).toBe(1)

    // Deleting the tail clamps the pointer rather than leaving it past the end.
    harness.service.setPlan(planOf([SLIDE_CUE]))
    expect(stateOf(harness).position.index).toBe(0)
    expect(stateOf(harness).position.firedCueIds).toEqual(['c-slide'])
  })

  it('keeps the loaded plan when opening a broken file fails', () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    harness.files.loadResult = err(ErrorCode.INVALID_ARG, 'the service plan is not valid')

    const opened = harness.service.open('C:/verger-test/plans/broken.json')
    expect(opened.ok).toBe(false)
    expect(stateOf(harness).plan.cues[0]?.id).toBe('c-slide')
    expect(stateOf(harness).path).toBe(PLAN_PATH)
  })

  it('needs a path before it can save a plan that has never been saved', () => {
    const harness = createHarness()
    const saved = harness.service.save()

    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(saved.error.message).toContain('never been saved')
  })

  it('degrades rather than crashing when no filesystem access was provided', async () => {
    const harness = createHarness({ withFiles: false })
    harness.service.setPlan(planOf([SLIDE_CUE]))

    const opened = harness.service.open(PLAN_PATH)
    const saved = harness.service.save(PLAN_PATH)
    const fired = await harness.service.fireCue('c-slide')

    for (const result of [opened, saved, fired]) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    }
  })

  it('starts from an empty, unsaved, clean plan', () => {
    const harness = createHarness()
    const state = stateOf(harness)

    expect(state.plan.cues).toEqual([])
    expect(state.path).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.lastFired).toBeNull()
    expect(state.position).toEqual({ index: -1, firedCueIds: [] })
  })
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('never lets a throwing seam escape as an exception', async () => {
    const harness = createHarness()
    loadPlan(harness, [OBS_SCENE_CUE])
    harness.obs.calls = []
    const throwing = new PlanService({
      overlay: { send: () => ok(emptyOverlayState()) },
      camera: {
        select: () => {
          throw new Error('camera exploded')
        }
      },
      obs: {
        call: () => {
          throw new Error('obs exploded')
        }
      },
      logger: createNullLogger()
    })
    throwing.setPlan(planOf([CAMERA_SCENE_CUE, OBS_SCENE_CUE]))

    const cameraResult = await throwing.fireCue('c-cam')
    const obsResult = await throwing.fireCue('c-scene')

    expect(cameraResult.ok).toBe(false)
    expect(obsResult.ok).toBe(false)
  })

  it('never lets a throwing subscriber stop the others', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    const good = vi.fn()
    harness.service.onState(() => {
      throw new Error('subscriber exploded')
    })
    harness.service.onState(good)

    await harness.service.advance()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('reports every verb as failed once disposed, and touches nothing', async () => {
    const harness = createHarness()
    loadPlan(harness, [SLIDE_CUE])
    harness.overlay.commands.length = 0
    harness.service.dispose()

    expect((await harness.service.advance()).ok).toBe(false)
    expect((await harness.service.fireCue('c-slide')).ok).toBe(false)
    expect(harness.service.back().ok).toBe(false)
    expect(harness.service.save().ok).toBe(false)
    expect(harness.overlay.commands).toEqual([])
  })

  it('reports the deck importer as unavailable when none is wired', () => {
    const harness = createHarness()
    const status = harness.service.getImporterStatus()

    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.available).toBe(false)
    expect(status.value.detail).toContain('no deck importer')
  })
})
