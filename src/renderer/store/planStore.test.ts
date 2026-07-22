/**
 * The plan store's contract.
 *
 * Five properties carry Phase 6:
 *
 *  - **Everything works with no bridge.** Every action returns an `Err` and the store settles into
 *    an empty plan rather than dereferencing `undefined`.
 *  - **Local edits are optimistic and then authoritative.** The list moves immediately, the whole
 *    plan is pushed through `plan.set`, and a refusal puts the *previous* plan back rather than
 *    leaving a half-applied edit on screen.
 *  - **The pointer follows the cue by id, not by slot.** Reordering the cue after the one that is
 *    on screen must not change what is on screen — `PLAN_LESSONS.md` records this as one of v2's
 *    load-bearing playlist behaviours.
 *  - **A missing deck converter is refused locally, without a round trip.** No converter means
 *    there is nothing to try, and the store says so in the same words the UI prints.
 *  - **Every cue defaults to `manual`, and a `scripture` payload has no text field.** Standing
 *    Rule 4 is asserted here, not just documented.
 *
 * Nothing here touches the network, OBS, or a real .pptx: the whole surface runs against
 * `createMockVergerApi`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { CUE_TYPES, cuePayloadSchemas, cueSchema } from '@shared/plan'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_DECK_IMPORTER_AVAILABLE,
  MOCK_DECK_IMPORTER_UNAVAILABLE,
  installMockVergerApi,
  mockCue,
  mockDeckImportProgress,
  mockPlanState,
  mockServicePlan,
} from '../test/mockVergerApi'
import {
  PLAN_BRIDGE_UNAVAILABLE_MESSAGE,
  createCue,
  defaultPayloadFor,
  moveCue,
  repositionAfterEdit,
  resetPlanStore,
  usePlanStore,
} from './planStore'

/* ------------------------------------ the pure helpers ------------------------------------ */

describe('plan helpers', () => {
  it('gives every cue type a payload the schema already accepts', () => {
    for (const type of CUE_TYPES) {
      const payload = defaultPayloadFor(type)
      expect(cuePayloadSchemas[type].safeParse(payload).success).toBe(true)
    }
  })

  it('never offers a scripture cue anywhere to put verse text — Standing Rule 4', () => {
    const payload = defaultPayloadFor('scripture')
    expect(Object.keys({ ...payload })).toEqual(['reference'])

    // And a hand-edited file that smuggles verse text in loses it: the payload schema knows only
    // `reference` and `translation`, so anything else is stripped rather than carried.
    const smuggled = cuePayloadSchemas.scripture.parse({
      reference: 'John 3:16',
      text: 'PLACEHOLDER VERSE TEXT',
    })
    expect(Object.keys(smuggled)).toEqual(['reference'])
  })

  it('creates every cue on a manual trigger, with a unique id', () => {
    const first = createCue('slide', 'SLIDE 1')
    const second = createCue('slide', 'SLIDE 2')

    expect(first.trigger).toEqual({ mode: 'manual' })
    expect(first.id).not.toBe(second.id)
    expect(cueSchema.safeParse(first).success).toBe(true)
  })

  it('moves a cue, and clamps rather than throwing on a bad index', () => {
    const cues = [mockCue({ id: 'a' }), mockCue({ id: 'b' }), mockCue({ id: 'c' })]

    expect(moveCue(cues, 0, 2).map((cue) => cue.id)).toEqual(['b', 'c', 'a'])
    expect(moveCue(cues, 2, 0).map((cue) => cue.id)).toEqual(['c', 'a', 'b'])
    expect(moveCue(cues, 1, 1)).toBe(cues)
    expect(moveCue(cues, 9, 0)).toBe(cues)
    expect(moveCue(cues, 0, 99).map((cue) => cue.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps the pointer on the same cue across a reorder, by id', () => {
    const before = [mockCue({ id: 'a' }), mockCue({ id: 'b' }), mockCue({ id: 'c' })]
    const after = moveCue(before, 2, 0)

    // The pointer was on 'b' (index 1). After moving 'c' to the top, 'b' is index 2.
    const moved = repositionAfterEdit({ index: 1, firedCueIds: ['a', 'b'] }, before, after)
    expect(moved).toEqual({ index: 2, firedCueIds: ['a', 'b'] })
  })

  it('clamps the pointer when the cue it was on is deleted', () => {
    const before = [mockCue({ id: 'a' }), mockCue({ id: 'b' })]
    const after = [mockCue({ id: 'a' })]

    expect(repositionAfterEdit({ index: 1, firedCueIds: [] }, before, after)).toEqual({
      index: 0,
      firedCueIds: [],
    })
  })
})

/* -------------------------------------- with no bridge -------------------------------------- */

describe('planStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetPlanStore()
  })

  it('settles into an empty plan instead of throwing', async () => {
    await usePlanStore.getState().hydrate()

    const store = usePlanStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.plan.cues).toEqual([])
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.lastError?.message).toBe(PLAN_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from every action rather than dereferencing undefined', async () => {
    const store = usePlanStore.getState()
    const results = await Promise.all([
      store.setPlan(mockServicePlan()),
      store.open(),
      store.save(),
      store.fireCue('cue-welcome'),
      store.advance(),
      store.back(),
      store.addCue(mockCue({ id: 'new' })),
      store.removeCue('cue-welcome'),
      store.reorderCues(0, 1),
    ])

    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    }
    expect(usePlanStore.getState().busy).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = usePlanStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(usePlanStore.getState().bridgeAvailable).toBe(false)
  })
})

/* --------------------------------------- with a bridge --------------------------------------- */

describe('planStore', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ planGetState: ok(mockPlanState()) })
    resetPlanStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates the plan and the importer status in one pass', async () => {
    await usePlanStore.getState().hydrate()

    const store = usePlanStore.getState()
    expect(store.hydrated).toBe(true)
    expect(store.plan.cues.map((cue) => cue.id)).toEqual([
      'cue-welcome',
      'cue-slide-1',
      'cue-reading',
    ])
    expect(store.dirty).toBe(false)
    expect(store.importer).toEqual(MOCK_DECK_IMPORTER_UNAVAILABLE)
    expect(installed.mock.calls.planGetImporterStatus).toHaveLength(1)
  })

  it('adopts a pushed plan state', async () => {
    const unsubscribe = usePlanStore.getState().subscribe()
    await usePlanStore.getState().hydrate()

    installed.mock.emit(IpcEvent.planState, mockPlanState({ dirty: true, path: null }))

    expect(usePlanStore.getState().dirty).toBe(true)
    expect(usePlanStore.getState().path).toBeNull()
    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.planState)).toBe(0)
  })

  it('appends a cue locally and pushes the whole plan', async () => {
    await usePlanStore.getState().hydrate()
    const cue = createCue('lowerthird', 'PLACEHOLDER TITLE')

    const result = await usePlanStore.getState().addCue(cue)

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.planSet).toHaveLength(1)
    expect(installed.mock.calls.planSet[0]?.cues.map((entry) => entry.id)).toEqual([
      'cue-welcome',
      'cue-slide-1',
      'cue-reading',
      cue.id,
    ])
    expect(usePlanStore.getState().dirty).toBe(true)
  })

  it('replaces one cue and leaves the rest untouched', async () => {
    await usePlanStore.getState().hydrate()
    const next = mockCue({ id: 'cue-slide-1', label: 'SLIDE 2' })

    await usePlanStore.getState().updateCue('cue-slide-1', next)

    const pushed = installed.mock.calls.planSet[0]
    expect(pushed?.cues[1]).toEqual(next)
    expect(pushed?.cues[0]?.label).toBe('PLACEHOLDER TITLE')
  })

  it('removes a cue', async () => {
    await usePlanStore.getState().hydrate()

    await usePlanStore.getState().removeCue('cue-slide-1')

    expect(installed.mock.calls.planSet[0]?.cues.map((cue) => cue.id)).toEqual([
      'cue-welcome',
      'cue-reading',
    ])
    expect(usePlanStore.getState().plan.cues).toHaveLength(2)
  })

  it('reorders, and keeps the pointer on the cue that is on screen', async () => {
    installed.mock.responses.planGetState = ok(
      mockPlanState({ position: { index: 1, firedCueIds: ['cue-welcome', 'cue-slide-1'] } }),
    )
    await usePlanStore.getState().hydrate()

    // Move the last cue to the top. The pointer was on 'cue-slide-1'; it must still be.
    await usePlanStore.getState().reorderCues(2, 0)

    expect(installed.mock.calls.planSet[0]?.cues.map((cue) => cue.id)).toEqual([
      'cue-reading',
      'cue-welcome',
      'cue-slide-1',
    ])
    expect(usePlanStore.getState().plan.cues[usePlanStore.getState().position.index]?.id).toBe(
      'cue-slide-1',
    )
  })

  it('puts the previous plan back when the main process refuses an edit', async () => {
    await usePlanStore.getState().hydrate()
    const before = usePlanStore.getState().plan
    installed.mock.responses.planSet = err(ErrorCode.INVALID_ARG, 'plan rejected')

    const result = await usePlanStore.getState().removeCue('cue-slide-1')

    expect(result.ok).toBe(false)
    // Not half-applied: the cue is back, and the failure is explained rather than swallowed.
    expect(usePlanStore.getState().plan).toEqual(before)
    expect(usePlanStore.getState().lastError?.message).toBe('plan rejected')
  })

  it('fires a cue, advances and steps back without touching any other subsystem', async () => {
    await usePlanStore.getState().hydrate()

    await usePlanStore.getState().fireCue('cue-slide-1')
    expect(usePlanStore.getState().lastFired?.id).toBe('cue-slide-1')
    expect(usePlanStore.getState().position.index).toBe(1)

    await usePlanStore.getState().advance()
    expect(usePlanStore.getState().position.index).toBe(2)

    await usePlanStore.getState().back()
    expect(usePlanStore.getState().position.index).toBe(1)

    // Driving the plan must not move a camera, blank an overlay layer, or touch the broadcast.
    expect(installed.mock.calls.cameraSelect).toEqual([])
    expect(installed.mock.calls.overlaySend).toEqual([])
    expect(installed.mock.calls.goLiveStart).toEqual([])
  })

  it('saves and clears the dirty flag', async () => {
    await usePlanStore.getState().hydrate()
    await usePlanStore.getState().addCue(createCue('slide', 'SLIDE 4'))
    expect(usePlanStore.getState().dirty).toBe(true)

    await usePlanStore.getState().save()

    expect(installed.mock.calls.planSave).toEqual([{}])
    expect(usePlanStore.getState().dirty).toBe(false)
  })

  it('refuses an import with no converter, without a round trip', async () => {
    await usePlanStore.getState().hydrate()

    const result = await usePlanStore.getState().importDeck()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
      // The refusal carries the backend's own words, so the store and the UI cannot disagree.
      expect(result.error.message).toBe(MOCK_DECK_IMPORTER_UNAVAILABLE.detail)
    }
    expect(installed.mock.calls.planImportDeck).toEqual([])
  })

  it('imports one opaque slide cue per slide when a converter exists', async () => {
    installed.mock.responses.planGetImporterStatus = ok(MOCK_DECK_IMPORTER_AVAILABLE)
    await usePlanStore.getState().hydrate()

    const result = await usePlanStore.getState().importDeck({ path: 'C:\\decks\\deck.pptx' })

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.planImportDeck).toEqual([{ path: 'C:\\decks\\deck.pptx' }])
    const cues = usePlanStore.getState().plan.cues
    expect(cues).toHaveLength(5)
    // Slides are images and nothing else: no field anywhere holds a word from the deck.
    for (const cue of cues.slice(3)) {
      expect(cue.type).toBe('slide')
      expect(Object.keys({ ...cue.payload }).sort()).toEqual(['asset', 'sourceSlide'])
    }
    expect(usePlanStore.getState().importing).toBe(false)
  })

  it('tracks import progress and stops reporting work at a terminal stage', async () => {
    const unsubscribe = usePlanStore.getState().subscribe()
    await usePlanStore.getState().hydrate()

    installed.mock.emit(IpcEvent.planImportProgress, mockDeckImportProgress())
    expect(usePlanStore.getState().importProgress?.slidesDone).toBe(3)
    expect(usePlanStore.getState().importing).toBe(true)

    installed.mock.emit(
      IpcEvent.planImportProgress,
      mockDeckImportProgress({ stage: 'done', slidesDone: 12 }),
    )
    expect(usePlanStore.getState().importing).toBe(false)

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.planImportProgress)).toBe(0)
  })

  it('keeps the mirrored plan when a save is refused', async () => {
    await usePlanStore.getState().hydrate()
    const before = usePlanStore.getState().plan
    installed.mock.responses.planSave = err(ErrorCode.IO_ERROR, 'disk is full')

    const result = await usePlanStore.getState().save()

    expect(result.ok).toBe(false)
    // A refused save has not un-authored anything.
    expect(usePlanStore.getState().plan).toEqual(before)
    expect(usePlanStore.getState().lastError?.code).toBe(ErrorCode.IO_ERROR)
  })
})
