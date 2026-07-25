/**
 * Where every operator intent finally lands.
 *
 * `ActionDispatcher` has always been the designed extension point — `register(action, handler)` —
 * and `useKeyboardActions` has always turned keys into dispatches. What was missing until now is
 * anybody registering the handlers, and that omission was not academic:
 *
 * > `App.tsx` filtered the operator's keymap down to `confirm` and `dismiss` before handing it to
 * > the keyboard hook, and the only `register` calls in the renderer were `SuggestionPanel`'s two
 * > and `PlanRunner`'s two — the latter on a dispatcher **it created itself**. So on the shipped
 * > app, `Y` and `N` worked and every other documented shortcut did nothing: SPACE did not advance,
 * > `1`–`4` did not switch cameras, SPACE-hold did not PANIC. `portable/RUNBOOK.md` listed them all
 * > as working, which is the worst version of this bug — the operator would have found out at
 * > 11:02 on a Sunday.
 *
 * This hook is the fix, and it is deliberately the ONE place handlers are registered, so "is this
 * key wired?" has a single answer that a test can read.
 *
 * ## What is wired, and what is honestly not
 *
 * {@link IMPLEMENTED_ACTIONS} is the whole list, and `App.tsx` filters the keymap through it. That
 * filter matters: `useKeyboardActions` calls `preventDefault()` for any key it has a binding for, so
 * a key bound to an unimplemented action would swallow the press *and* do nothing — which teaches
 * an operator that the key is broken rather than that the feature is absent.
 *
 * Three actions are **not** implemented, and are not faked:
 *
 * - `output.black`, `output.logo`, `output.freeze` — there is no blackout, slate or freeze anywhere
 *   in the main process. obs-websocket has no "black the program" call; doing it properly means the
 *   operator nominating a scene, which is configuration this app does not have yet. `B`-hold is
 *   therefore an intentional no-op, the Shortcuts screen still lists it, and `RUNBOOK.md` says so
 *   plainly instead of promising it.
 *
 * The brief asked for "`B` — blackout/panic". PANIC is on SPACE-hold, where it already was and where
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` wants it; `B` keeps its destructive-hold gesture so that
 * when blackout does land it cannot arrive as a tap.
 *
 * ## `disableAi` is not `panic`
 *
 * ESC-hold hands control back by putting the trust dial in `manual`: the engine stops suggesting and
 * stops firing, whatever is on screen stays on screen, and the operator can dial autonomy back up
 * when they want it. PANIC is the master switch and latches — `cueStore.panic()` keeps the halt even
 * if its round trip fails. Mapping ESC to `panic` would make the gentle control the violent one,
 * which is exactly the v2 regression this whole input layer exists to prevent.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import { useEffect, useRef } from 'react'

import { ActionId } from '@shared/actions'
import type { CameraSlot } from '@shared/camera'
import { CAMERA_SLOTS } from '@shared/camera'

import { useCameraStore } from '../store/cameraStore'
import { useCueStore } from '../store/cueStore'
import { useOverlayStore } from '../store/overlayStore'
import { usePlanStore } from '../store/planStore'
import type { ActionDispatcher } from './ActionDispatcher'

/**
 * Every action this hook registers a handler for.
 *
 * Anything absent from this list is dispatched to nobody. `App.tsx` filters the operator's keymap
 * through {@link isImplementedAction} so those keys keep their browser default rather than being
 * swallowed into silence.
 */
export const IMPLEMENTED_ACTIONS: readonly ActionId[] = [
  ActionId.advance,
  ActionId.back,
  ActionId.cameraSelect,
  ActionId.lowerThirdDismiss,
  ActionId.clearAll,
  ActionId.confirm,
  ActionId.dismiss,
  ActionId.panic,
  ActionId.disableAi,
]

/** Whether anything will actually happen when this action is dispatched. */
export function isImplementedAction(action: ActionId): boolean {
  return IMPLEMENTED_ACTIONS.includes(action)
}

/**
 * Narrow a binding's `param` to a camera slot.
 *
 * A remapped binding, a hand-edited keymap file or a future pedal profile can all carry a `param`
 * that is not a slot. Returning `null` makes that a no-op instead of an `undefined` scene switch.
 */
export function toCameraSlot(param: string | undefined): CameraSlot | null {
  if (param === undefined) return null
  return (CAMERA_SLOTS as readonly string[]).includes(param) ? (param as CameraSlot) : null
}

export interface ServiceActionsOptions {
  /** The app-wide dispatcher. Handlers are registered on mount and removed on unmount. */
  readonly dispatcher: ActionDispatcher
}

/**
 * Register one handler per implemented action, for the life of the app.
 *
 * The handlers are registered ONCE — keyed on the dispatcher alone — and read the newest store
 * actions through a ref. Re-registering on every render would mean a window, however small, in which
 * SPACE was bound to nothing; and zustand's actions are stable anyway, so the ref costs nothing.
 *
 * Every store action returns a `Result` that is deliberately discarded here. A refusal is already
 * recorded in the owning store's `lastError` and rendered by the surface that cares; there is
 * nothing an input handler could usefully do with it, and `ActionDispatcher` contains throws so a
 * rejected promise can never deafen the keyboard mid-service.
 */
export function useServiceActions({ dispatcher }: ServiceActionsOptions): void {
  const advance = usePlanStore((store) => store.advance)
  const back = usePlanStore((store) => store.back)
  const selectCamera = useCameraStore((store) => store.select)
  const sendOverlay = useOverlayStore((store) => store.send)
  const confirm = useCueStore((store) => store.confirm)
  const dismiss = useCueStore((store) => store.dismiss)
  const panic = useCueStore((store) => store.panic)
  const setMode = useCueStore((store) => store.setMode)

  const latest = useRef({
    advance,
    back,
    selectCamera,
    sendOverlay,
    confirm,
    dismiss,
    panic,
    setMode,
  })
  useEffect(() => {
    latest.current = { advance, back, selectCamera, sendOverlay, confirm, dismiss, panic, setMode }
  })

  useEffect(() => {
    const offs = [
      dispatcher.register(ActionId.advance, () => {
        void latest.current.advance()
      }),

      // BACK moves the pointer and fires nothing — `stepBack()` leaves `firedCueIds` alone, and an
      // undo that re-shows the slide you were removing is not an undo.
      dispatcher.register(ActionId.back, () => {
        void latest.current.back()
      }),

      dispatcher.register(ActionId.cameraSelect, (dispatched) => {
        const slot = toCameraSlot(dispatched.param)
        if (slot === null) return
        void latest.current.selectCamera(slot)
      }),

      // The lower third only. Touches no other layer — that independence is asserted by
      // `CameraPanel.test.tsx` and `OverlayPanel.test.tsx`, not merely intended.
      dispatcher.register(ActionId.lowerThirdDismiss, () => {
        void latest.current.sendOverlay({
          channel: 'command',
          name: 'lowerThird.hide',
          payload: {},
        })
      }),

      // DESTRUCTIVE — reachable only via a hold, enforced by `isSafeBinding` over the keymap.
      dispatcher.register(ActionId.clearAll, () => {
        void latest.current.sendOverlay({ channel: 'command', name: 'clearAll', payload: {} })
      }),

      dispatcher.register(ActionId.confirm, () => {
        void latest.current.confirm()
      }),

      dispatcher.register(ActionId.dismiss, () => {
        void latest.current.dismiss()
      }),

      // The master switch. Halts automation and touches neither the stream, the recording, nor
      // what is currently on the congregation screen.
      dispatcher.register(ActionId.panic, () => {
        void latest.current.panic()
      }),

      // Non-destructive hand-back: the dial goes to `manual`, the screen keeps whatever is on it.
      dispatcher.register(ActionId.disableAi, () => {
        void latest.current.setMode('manual')
      }),
    ]

    return () => {
      for (const off of offs) off()
    }
  }, [dispatcher])
}
