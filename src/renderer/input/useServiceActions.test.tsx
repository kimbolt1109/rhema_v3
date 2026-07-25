/**
 * The guard against the shipped-shortcuts bug coming back.
 *
 * `ActionDispatcher` was always the extension point and `useKeyboardActions` always turned keys
 * into dispatches — but until `useServiceActions` landed, **nobody registered the handlers**. On the
 * shipped app only `Y` and `N` did anything: SPACE did not advance, `1`–`4` did not switch cameras,
 * SPACE-hold did not PANIC, while `portable/RUNBOOK.md` listed all of them as working. The operator
 * would have found out at 11:02 on a Sunday.
 *
 * So the load-bearing assertions here are of two kinds, and both are negative-ish:
 *
 * 1. **Presence.** Every action in `IMPLEMENTED_ACTIONS` has a handler after mount, driven by
 *    iterating the exported array so a future addition cannot be forgotten. And every id in the
 *    `ActionId` vocabulary is classified — implemented, or on the deliberately-unimplemented list —
 *    so a newly invented action cannot slip through unwired *and* unlisted.
 * 2. **Exact reach.** Each handler must touch the one subsystem it names and nothing else. Those
 *    are asserted against the mock bridge's whole call log (`recordedCalls`), not against a single
 *    array, because "BACK also re-fired the cue" and "dismissing the lower third also blanked the
 *    scripture layer" are absences, and an absence is invisible unless something looks for it.
 *
 * The sharpest one is `ai.disable` vs `ai.panic`: ESC-hold puts the trust dial in `manual` and must
 * NOT call `panic()`. Making the gentle control the violent one is the exact v2 regression this
 * whole input layer exists to prevent (`docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6).
 *
 * ## Fixtures
 *
 * Standing Rule 4: every fixture comes from `mockVergerApi.ts` and is an obvious placeholder. The
 * pending suggestion carries an id and a `why`, never verse text; a scripture cue would carry a
 * reference and nothing else.
 */

import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionId } from '@shared/actions'
import { CAMERA_SLOTS } from '@shared/camera'
import type { LogFields } from '@shared/log'

import { resetCameraStore } from '../store/cameraStore'
import { resetCueStore, useCueStore } from '../store/cueStore'
import { resetOverlayStore } from '../store/overlayStore'
import { resetPlanStore } from '../store/planStore'
import type { InstalledMockVergerApi, MockVergerApi } from '../test/mockVergerApi'
import {
  installMockVergerApi,
  mockCueSuggestion,
  mockPendingCueEngineState,
} from '../test/mockVergerApi'
import type { ActionDispatcher } from './ActionDispatcher'
import { createActionDispatcher } from './ActionDispatcher'
import {
  IMPLEMENTED_ACTIONS,
  isImplementedAction,
  toCameraSlot,
  useServiceActions,
} from './useServiceActions'

type LogFn = (message: string, fields?: LogFields) => void

/**
 * The three actions that are deliberately NOT wired.
 *
 * There is no blackout, slate or freeze anywhere in the main process, and faking one would be worse
 * than the gap: `App.tsx` filters the keymap through {@link isImplementedAction} precisely so that
 * `B`-hold keeps its browser default instead of being swallowed into silence. If you are here
 * because you just implemented blackout, move it to `IMPLEMENTED_ACTIONS` and this test will tell
 * you what else to update.
 */
const DELIBERATELY_UNIMPLEMENTED = [ActionId.black, ActionId.logo, ActionId.freeze] as const

/** Nothing but the hook: this file is about registration and reach, not about any screen. */
function Harness({ dispatcher }: { dispatcher: ActionDispatcher }): null {
  useServiceActions({ dispatcher })
  return null
}

interface Mounted {
  readonly dispatcher: ActionDispatcher
  readonly logger: { warn: ReturnType<typeof vi.fn<LogFn>>; error: ReturnType<typeof vi.fn<LogFn>> }
  readonly unmount: () => void
}

function mount(): Mounted {
  const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() }
  const dispatcher = createActionDispatcher({ logger })
  const { unmount } = render(<Harness dispatcher={dispatcher} />)
  return { dispatcher, logger, unmount }
}

/**
 * Fire one action the way the keyboard would, and let the store's round trip settle.
 *
 * The handlers are synchronous and the store actions are not, so the dispatch is wrapped in `act`
 * with a drained microtask queue — otherwise the bridge call would be asserted before it happened.
 */
async function dispatch(
  dispatcher: ActionDispatcher,
  action: ActionId,
  param?: string,
): Promise<void> {
  await act(async () => {
    dispatcher.dispatch(action, param, 'keyboard')
    await Promise.resolve()
  })
}

/**
 * Which bridge methods were called at all, by name.
 *
 * This is how the "touches nothing else" claims are asserted: a handler that reached a second
 * subsystem shows up as an extra entry here, whereas asserting only on its own call array would
 * never notice.
 */
function recordedCalls(mock: MockVergerApi): string[] {
  return Object.entries(mock.calls)
    .filter(([, log]) => log.length > 0)
    .map(([name]) => name)
}

describe('useServiceActions', () => {
  let installed: InstalledMockVergerApi
  let mock: MockVergerApi

  beforeEach(() => {
    // Install before resetting: every store recomputes `bridgeAvailable` from `window.verger`.
    installed = installMockVergerApi()
    mock = installed.mock
    resetPlanStore()
    resetCueStore()
    resetCameraStore()
    resetOverlayStore()
  })

  afterEach(() => {
    installed.restore()
  })

  describe('registration', () => {
    it('has a handler for every action it claims to implement', () => {
      const { dispatcher } = mount()

      // Nothing was registered before the hook mounted — that was the whole bug.
      expect(IMPLEMENTED_ACTIONS.length).toBeGreaterThan(0)
      for (const action of IMPLEMENTED_ACTIONS) {
        expect(dispatcher.hasHandler(action), action).toBe(true)
        expect(isImplementedAction(action), action).toBe(true)
      }
    })

    it('wires the whole documented keymap: advance, back, cameras, overlays, suggestions, panic', () => {
      const { dispatcher } = mount()

      // Spelled out rather than derived, so a deletion from `IMPLEMENTED_ACTIONS` is a failure here
      // instead of a silently shorter loop above.
      expect(
        [
          ActionId.advance,
          ActionId.back,
          ActionId.cameraSelect,
          ActionId.lowerThirdDismiss,
          ActionId.clearAll,
          ActionId.confirm,
          ActionId.dismiss,
          ActionId.panic,
          ActionId.disableAi,
        ].every((action) => dispatcher.hasHandler(action)),
      ).toBe(true)
    })

    it('leaves black, logo and freeze unhandled on purpose, so the keys are not swallowed', async () => {
      const { dispatcher } = mount()

      for (const action of DELIBERATELY_UNIMPLEMENTED) {
        expect(dispatcher.hasHandler(action), action).toBe(false)
        expect(isImplementedAction(action), action).toBe(false)
      }

      // And dispatching them reaches nothing at all: no half-implemented scene switch, no overlay
      // command that happens to look like a blackout.
      for (const action of DELIBERATELY_UNIMPLEMENTED) {
        await dispatch(dispatcher, action)
      }
      expect(recordedCalls(mock)).toEqual([])
    })

    it('classifies every action in the vocabulary as implemented or deliberately not', () => {
      mount()

      // A partition, asserted as one. Invent a new `ActionId` and this fails until you have either
      // wired it up or written down that you chose not to.
      expect([...IMPLEMENTED_ACTIONS, ...DELIBERATELY_UNIMPLEMENTED].sort()).toEqual(
        Object.values(ActionId).sort(),
      )
    })
  })

  describe('the plan: advance and back', () => {
    it('advances the plan over the bridge', async () => {
      const { dispatcher, logger } = mount()

      await dispatch(dispatcher, ActionId.advance)

      await waitFor(() => {
        expect(mock.calls.planAdvance).toHaveLength(1)
      })
      // Advancing is an advance, not a fire-by-id and not a step back.
      expect(recordedCalls(mock)).toEqual(['planAdvance'])
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('steps back over the bridge and never re-fires the cue', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.back)

      await waitFor(() => {
        expect(mock.calls.planBack).toHaveLength(1)
      })
      // The assertion this pairs with `PlanRunner.test.tsx`: an undo that re-shows the slide you
      // were removing is not an undo.
      expect(mock.calls.planFireCue).toEqual([])
      expect(mock.calls.planAdvance).toEqual([])
      expect(recordedCalls(mock)).toEqual(['planBack'])
    })

    it('records the keyboard as the source', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.advance)

      expect(dispatcher.lastAction()?.action).toBe(ActionId.advance)
      expect(dispatcher.lastAction()?.source).toBe('keyboard')
    })
  })

  describe('cameras', () => {
    it('selects the slot named in the action param', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.cameraSelect, 'wide')

      await waitFor(() => {
        expect(mock.calls.cameraSelect).toEqual(['wide'])
      })
      // A camera switch touches the camera layer and nothing else (BLUEPRINT.md §6).
      expect(recordedCalls(mock)).toEqual(['cameraSelect'])
    })

    it('does nothing at all for a param that is not a slot', async () => {
      const { dispatcher, logger } = mount()

      // A remapped binding, a hand-edited keymap or a future pedal profile can all carry this.
      await dispatch(dispatcher, ActionId.cameraSelect, 'nope')

      expect(mock.calls.cameraSelect).toEqual([])
      expect(recordedCalls(mock)).toEqual([])
      // A no-op, not a contained crash: an `undefined` scene switch must never be attempted.
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('does nothing at all when the binding carries no param', async () => {
      const { dispatcher, logger } = mount()

      await dispatch(dispatcher, ActionId.cameraSelect)

      expect(mock.calls.cameraSelect).toEqual([])
      expect(recordedCalls(mock)).toEqual([])
      expect(logger.error).not.toHaveBeenCalled()
    })
  })

  describe('overlays', () => {
    it('hides the lower third and touches no other layer', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.lowerThirdDismiss)

      await waitFor(() => {
        expect(mock.calls.overlaySend).toHaveLength(1)
      })
      // Exactly one command, exactly this one: not `clearAll`, not a scripture or slide hide.
      expect(mock.calls.overlaySend).toEqual([
        { channel: 'command', name: 'lowerThird.hide', payload: {} },
      ])
      expect(recordedCalls(mock)).toEqual(['overlaySend'])
    })

    it('sends clearAll for the destructive hold', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.clearAll)

      await waitFor(() => {
        expect(mock.calls.overlaySend).toEqual([
          { channel: 'command', name: 'clearAll', payload: {} },
        ])
      })
      // Clearing the overlays never reaches the cameras or the plan: the congregation's screen and
      // the program feed are separate layers.
      expect(recordedCalls(mock)).toEqual(['overlaySend'])
    })
  })

  describe('the pending suggestion', () => {
    /** Put something on the table for Y/N to act on. */
    function seedPending(id: string): void {
      useCueStore.setState({
        state: mockPendingCueEngineState(mockCueSuggestion({ id })),
      })
    }

    it('confirms the pending suggestion through the cue engine', async () => {
      const { dispatcher } = mount()
      seedPending('suggestion-under-test')

      await dispatch(dispatcher, ActionId.confirm)

      await waitFor(() => {
        expect(mock.calls.cueConfirm).toEqual([{ suggestionId: 'suggestion-under-test' }])
      })
      // The engine emits an intent and something else applies it: confirming must not itself fire
      // the cue over the plan channel.
      expect(mock.calls.cueDismiss).toEqual([])
      expect(recordedCalls(mock)).toEqual(['cueConfirm'])
    })

    it('dismisses the pending suggestion through the cue engine', async () => {
      const { dispatcher } = mount()
      seedPending('suggestion-under-test')

      await dispatch(dispatcher, ActionId.dismiss)

      await waitFor(() => {
        expect(mock.calls.cueDismiss).toEqual([{ suggestionId: 'suggestion-under-test' }])
      })
      expect(mock.calls.cueConfirm).toEqual([])
      // A veto is a veto: it must not have been escalated into a panic.
      expect(mock.calls.cuePanic).toEqual([])
      expect(recordedCalls(mock)).toEqual(['cueDismiss'])
    })
  })

  describe('PANIC and hand-back-control are different things', () => {
    it('panics through the engine, and touches neither the stream nor the screen', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.panic)

      await waitFor(() => {
        expect(mock.calls.cuePanic).toHaveLength(1)
      })
      // A panicking operator must never take the broadcast down: no goLive.end, no overlay clear,
      // no camera move.
      expect(recordedCalls(mock)).toEqual(['cuePanic'])
      expect(mock.calls.cueSetMode).toEqual([])
    })

    it('disables the AI by dialling the trust mode to manual, and never panics', async () => {
      const { dispatcher } = mount()

      await dispatch(dispatcher, ActionId.disableAi)

      await waitFor(() => {
        expect(mock.calls.cueSetMode).toEqual(['manual'])
      })
      // The v2 regression, in one assertion: the gentle control must not be the violent one.
      expect(mock.calls.cuePanic).toEqual([])
      expect(recordedCalls(mock)).toEqual(['cueSetMode'])
    })
  })

  describe('teardown', () => {
    it('removes every handler on unmount', async () => {
      const { dispatcher, unmount } = mount()

      unmount()

      for (const action of IMPLEMENTED_ACTIONS) {
        expect(dispatcher.hasHandler(action), action).toBe(false)
      }

      // And nothing lands: a PANIC timer firing into a dead tree is a spectacular way to lose a
      // service.
      await dispatch(dispatcher, ActionId.advance)
      await dispatch(dispatcher, ActionId.panic)
      expect(recordedCalls(mock)).toEqual([])
    })
  })
})

describe('toCameraSlot', () => {
  it('accepts every real slot', () => {
    for (const slot of CAMERA_SLOTS) {
      expect(toCameraSlot(slot), slot).toBe(slot)
    }
  })

  it('rejects a param that is not a slot, and no param at all', () => {
    // Both cases have to be `null` rather than passed through: an unrecognised binding is a no-op,
    // never an `undefined` scene switch.
    expect(toCameraSlot('nope')).toBeNull()
    expect(toCameraSlot('cam3')).toBeNull()
    expect(toCameraSlot('')).toBeNull()
    expect(toCameraSlot(undefined)).toBeNull()
  })
})
