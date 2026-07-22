/**
 * The keyboard half of the input layer: raw key events in, {@link ActionId} dispatches out.
 *
 * ## The tap/hold state machine, and why it is shaped like this
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6 records the incident this encodes. rhema_v2 shipped
 * plain ESC as an instant "clear every overlay" and had to walk it back: the control an operator
 * reaches for when they want to take over from the AI must never be able to blank the
 * congregation's screen. The corrected model, which this hook implements literally:
 *
 * - **SPACE tap (≤ {@link MAX_TAP_MS}) = advance. SPACE hold ({@link PANIC_HOLD_MS}) = PANIC.**
 *   One physical key, two gestures — the most-used action and the emergency stop cannot be
 *   confused because they are separated in *time*, not just in position.
 * - **ESC hold ({@link DISABLE_AI_HOLD_MS}) = disable AI, and it is non-destructive.** Whatever is
 *   live stays live. A bare ESC *tap* deliberately fires nothing at all — there is no binding for
 *   it, and this hook must not invent one.
 * - **SHIFT+ESC = dismiss lower-thirds only.** A modifier-qualified binding is matched exactly, so
 *   the unmodified ESC binding can never shadow it (and vice versa).
 * - **Nothing destructive is reachable in under {@link MIN_DESTRUCTIVE_HOLD_MS}** — enforced by
 *   `isSafeBinding` over the binding list, not by this hook's good behaviour.
 *
 * Three details that look like edge cases and are not:
 *
 * 1. **A hold fires the moment it elapses, while the key is still down**, not on release. The
 *    operator gets feedback at the moment of commitment; a PANIC that only lands when you let go
 *    feels broken exactly when nothing may feel broken.
 * 2. **A press longer than {@link MAX_TAP_MS} with no `hold` binding fires NOTHING on release.**
 *    It is neither a tap nor a hold. This is deliberate: a key leaned on for half a second is not
 *    evidence of intent, and "late taps still count" is how a resting hand advances the service.
 * 3. **Autorepeat (`event.repeat`) is ignored.** The OS emits a keydown stream while a key is
 *    held; treating those as fresh presses would fire the tap action dozens of times.
 *
 * ## Text fields
 *
 * All key handling is suppressed while focus is inside an `input`, `textarea`, `select` or a
 * `contenteditable` host. This is a real hazard, not a nicety: the operator types a speaker's name
 * into the lower-third field, hits `b` in "Bob", and the program output goes black. v2 documents
 * the same rule ("shortcuts are globally disabled while a text field has focus").
 *
 * ## Foot pedals
 *
 * Nothing here knows what a pedal is, which is the point — a pedal that emits SPACE is a keyboard,
 * and it gets this whole state machine for free (`SHORTCUTS_AND_A11Y.md` §8, Verger note 5).
 *
 * No Node globals — this module is bundled into the renderer.
 */

import { useEffect, useRef } from 'react'

import type { KeyBinding } from '@shared/actions'
import { DEFAULT_KEY_BINDINGS, MAX_TAP_MS } from '@shared/actions'

import type { ActionDispatcher } from './ActionDispatcher'

/**
 * Injectable timers, so tests drive the hold thresholds with fake timers rather than waiting three
 * real seconds for a PANIC.
 */
export interface KeyboardTimers {
  readonly setTimeout: (callback: () => void, ms: number) => number
  readonly clearTimeout: (handle: number) => void
}

/** The subset of `Window` this hook binds to. Injectable so a test can pass a stub target. */
export type KeyboardEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export interface UseKeyboardActionsOptions {
  /** Where matched keys are sent. Owns the handlers; this hook owns only the gestures. */
  readonly dispatcher: ActionDispatcher
  /** Defaults to {@link DEFAULT_KEY_BINDINGS}. Phase 10's remap UI supplies its own list. */
  readonly bindings?: readonly KeyBinding[]
  /** Set false to suspend all key handling — e.g. while a modal owns the keyboard. */
  readonly enabled?: boolean
  /** Defaults to `window`. */
  readonly target?: KeyboardEventTarget
  /** Injectable clock in milliseconds, for tap-length measurement. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Defaults to `window.setTimeout` / `window.clearTimeout`. */
  readonly timers?: KeyboardTimers
}

/** One key currently held down. */
interface PressState {
  /** Clock reading at keydown, used to measure the tap. */
  readonly startedAt: number
  /** The binding to fire on release, if the release is quick enough. `null` when there is none. */
  readonly tap: KeyBinding | null
  /** Pending hold timer, or `null` once it has fired or been cancelled. */
  timer: number | null
  /** True once the hold fired. A consumed press fires nothing further on release. */
  consumed: boolean
}

/**
 * Case-folds single-character keys so `b` still matches with CapsLock on, while leaving named keys
 * (`Escape`, `Backspace`, and the space `' '`) untouched.
 */
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/**
 * Exact modifier matching.
 *
 * "Exact" is the load-bearing word: SHIFT+ESC and ESC are different bindings, and if an
 * unmodified binding were allowed to match a modified press, the unmodified ESC hold would shadow
 * SHIFT+ESC — re-merging "hand back control" with "clear something", which is precisely the v2
 * regression. The cost is that a chord nobody bound (SHIFT+SPACE, say) does nothing; that is the
 * correct and predictable outcome.
 */
function matchesModifiers(binding: KeyBinding, event: KeyboardEvent): boolean {
  return (
    (binding.shift ?? false) === event.shiftKey &&
    (binding.ctrl ?? false) === event.ctrlKey &&
    (binding.alt ?? false) === event.altKey
  )
}

/** Whether the event's target is somewhere the operator is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as Partial<HTMLElement> & Partial<Element>
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : null
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  if (element.isContentEditable === true) return true
  // jsdom does not implement `isContentEditable`, and the real editable host may be an ancestor of
  // the event target, so fall back to the attribute. `contenteditable="false"` is not editable.
  if (typeof element.closest !== 'function') return false
  const host = element.closest('[contenteditable]')
  if (host === null) return false
  const value = host.getAttribute('contenteditable')
  return value === null || value === '' || value.toLowerCase() === 'true'
}

/**
 * Binds keydown/keyup and translates them into dispatched actions.
 *
 * Every listener and every pending hold timer is removed on unmount: a PANIC timer that outlives
 * its component and fires into a dead tree would be a spectacular way to lose a service.
 */
export function useKeyboardActions(options: UseKeyboardActionsOptions): void {
  const enabled = options.enabled ?? true
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window)

  // The listeners are attached once and read the newest options through this ref, so a re-render
  // with a fresh `bindings` array does not detach and reattach the keyboard mid-service.
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const pressesRef = useRef(new Map<string, PressState>())

  useEffect(() => {
    const presses = pressesRef.current
    if (!enabled || target === undefined) return undefined

    const getTimers = (): KeyboardTimers =>
      latest.current.timers ?? {
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => {
          window.clearTimeout(handle)
        },
      }

    const clearPressTimer = (press: PressState): void => {
      if (press.timer === null) return
      getTimers().clearTimeout(press.timer)
      press.timer = null
    }

    const cancelAll = (): void => {
      for (const press of presses.values()) clearPressTimer(press)
      presses.clear()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      // Autorepeat is not a new press. Without this, holding SPACE would fire `advance` at the
      // OS repeat rate instead of arming PANIC.
      if (event.repeat) return
      if (isTypingTarget(event.target)) return

      const { dispatcher, bindings = DEFAULT_KEY_BINDINGS } = latest.current
      const key = normalizeKey(event.key)
      // A duplicate keydown with no `repeat` flag (some remote/HID stacks emit these) must not
      // restart the hold timer, or the hold could never complete.
      if (presses.has(key)) return

      const candidates = bindings.filter(
        (binding) => normalizeKey(binding.key) === key && matchesModifiers(binding, event),
      )
      if (candidates.length === 0) return

      const tap = candidates.find((binding) => binding.gesture === 'tap') ?? null
      const hold =
        candidates.find(
          (binding) =>
            binding.gesture === 'hold' && binding.holdMs !== undefined && binding.holdMs > 0,
        ) ?? null

      // Only swallow the browser default for keys we actually own — SPACE scrolling and
      // Backspace navigation are both hostile mid-service.
      event.preventDefault()

      const now = latest.current.now ?? Date.now
      const press: PressState = { startedAt: now(), tap, timer: null, consumed: false }
      presses.set(key, press)

      if (hold === null) return
      const holdMs = hold.holdMs ?? 0
      press.timer = getTimers().setTimeout(() => {
        press.timer = null
        // Still held — the press is only removed from the map on keyup, blur or unmount.
        press.consumed = true
        dispatcher.dispatch(hold.action, hold.param, 'keyboard')
      }, holdMs)
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      const key = normalizeKey(event.key)
      const press = presses.get(key)
      if (press === undefined) return
      presses.delete(key)
      clearPressTimer(press)

      // The hold already fired at the moment of commitment; releasing must not fire again, and
      // must not fall through to the tap binding on the same key (SPACE-hold is not an advance).
      if (press.consumed) return

      const now = latest.current.now ?? Date.now
      const heldFor = now() - press.startedAt
      // Deliberate: a press longer than MAX_TAP_MS with no hold binding fires NOTHING. It is
      // neither a tap nor a hold, and guessing "they probably meant a tap" is how a hand resting
      // on the keyboard advances the service.
      if (heldFor > MAX_TAP_MS) return
      if (press.tap === null) return

      latest.current.dispatcher.dispatch(press.tap.action, press.tap.param, 'keyboard')
    }

    // Losing focus mid-hold means the keyup will never arrive. Drop the press without firing:
    // a hold may only fire while we can still see that the key is down.
    const handleBlur = (): void => {
      cancelAll()
    }

    target.addEventListener('keydown', handleKeyDown)
    target.addEventListener('keyup', handleKeyUp)
    target.addEventListener('blur', handleBlur)

    return () => {
      target.removeEventListener('keydown', handleKeyDown)
      target.removeEventListener('keyup', handleKeyUp)
      target.removeEventListener('blur', handleBlur)
      cancelAll()
    }
  }, [enabled, target])
}
