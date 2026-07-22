/**
 * The action vocabulary and input bindings.
 *
 * ## Why a dispatcher and not `onKeyDown` handlers
 *
 * A foot pedal and a Stream Deck are keyboard-HID devices: they emit ordinary key codes. So if
 * every operator intent is expressed as a named ACTION, and keys are merely one way to trigger
 * an action, then pedal and Stream Deck support come for free the moment the keyboard works,
 * and Phase 10 only has to add a remap UI rather than a second input path. Everything the
 * operator can do goes through {@link ActionId}.
 *
 * ## Holds, not taps
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` records the incident this encodes. rhema_v2 shipped ESC
 * as an instant "clear everything", and had to walk it back: the control an operator reaches for
 * when they want to take over from the AI **must never be able to blank the congregation's
 * screen**. Two rules follow, and both are enforced here rather than left to UI discipline:
 *
 * 1. `disableAi` is non-destructive. It stops automation and leaves whatever is live, live.
 * 2. Anything destructive requires a deliberate HOLD of at least
 *    {@link MIN_DESTRUCTIVE_HOLD_MS}, and is bound to a different control entirely.
 *
 * Node-global free: imported by the renderer and by main.
 */

/**
 * Every operator intent.
 *
 * Adding one here and nowhere else is deliberate — the dispatcher, the keymap, the remap UI and
 * the pedal binding all enumerate this list, so a new action cannot be half-wired.
 */
export const ActionId = {
  /** Advance to the next cue/slide. The most-used action in a service. */
  advance: 'advance',
  /** Step back one cue. The undo for a mis-fire. */
  back: 'back',

  /** Switch the program camera. Carries which camera in the action's `param`. */
  cameraSelect: 'camera.select',

  /** Cut the program output to black. */
  black: 'output.black',
  /** Show the logo/holding slate. */
  logo: 'output.logo',
  /** Freeze the current frame. */
  freeze: 'output.freeze',

  /** Hide the lower-third only. Touches no other layer. */
  lowerThirdDismiss: 'overlay.lowerThird.dismiss',
  /** Clear every overlay layer. DESTRUCTIVE — hold only. */
  clearAll: 'overlay.clearAll',

  /**
   * Hand control back to the operator: stop all automation.
   * NON-DESTRUCTIVE by definition — see the module note.
   */
  disableAi: 'ai.disable',
  /**
   * Emergency stop. Halts all automation. Explicitly does NOT stop the stream, stop the
   * recording, or cut the video — a panicking operator must never take the broadcast down.
   */
  panic: 'ai.panic',

  /** Accept the pending suggestion. */
  confirm: 'suggestion.confirm',
  /** Reject the pending suggestion. */
  dismiss: 'suggestion.dismiss',
} as const

/** Union of every action id. */
export type ActionId = (typeof ActionId)[keyof typeof ActionId]

/** Actions that can destroy visible output and therefore require a hold. */
export const DESTRUCTIVE_ACTIONS: readonly ActionId[] = [ActionId.clearAll, ActionId.black]

/**
 * How an input gesture maps to firing.
 *
 * `tap` fires on release, only if released within {@link MAX_TAP_MS}. `hold` fires once the key
 * has been held for the binding's `holdMs`, and fires *while still held* rather than on release,
 * so the operator gets feedback at the moment of commitment.
 */
export type Gesture = 'tap' | 'hold'

/**
 * A tap must be released within this long. Beyond it, a bare press is treated as the start of a
 * hold, which is what makes SPACE-tap (advance) and SPACE-hold (panic) coexist on one key.
 */
export const MAX_TAP_MS = 300

/** ESC must be held this long to disable automation. A quick tap deliberately does nothing. */
export const DISABLE_AI_HOLD_MS = 2000

/** SPACE must be held this long to trigger PANIC. */
export const PANIC_HOLD_MS = 3000

/**
 * The floor for any destructive action.
 *
 * Below roughly a second and a half a "hold" stops being a deliberate decision and becomes a
 * slightly-slow press — which is exactly the failure mode this exists to prevent.
 */
export const MIN_DESTRUCTIVE_HOLD_MS = 1500

/** A key binding. `key` matches `KeyboardEvent.key`. */
export interface KeyBinding {
  readonly action: ActionId
  readonly key: string
  readonly gesture: Gesture
  /** Required for `hold`; ignored for `tap`. */
  readonly holdMs?: number
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly alt?: boolean
  /** For parameterised actions such as {@link ActionId.cameraSelect}. */
  readonly param?: string
}

/**
 * The default keymap, from `docs/v2-notes/SHORTCUTS_AND_A11Y.md`.
 *
 * Remappable in Phase 10 — the shapes here are the defaults, not a fixed wiring.
 */
export const DEFAULT_KEY_BINDINGS: readonly KeyBinding[] = [
  { action: ActionId.advance, key: ' ', gesture: 'tap' },
  { action: ActionId.panic, key: ' ', gesture: 'hold', holdMs: PANIC_HOLD_MS },

  { action: ActionId.disableAi, key: 'Escape', gesture: 'hold', holdMs: DISABLE_AI_HOLD_MS },
  { action: ActionId.lowerThirdDismiss, key: 'Escape', gesture: 'tap', shift: true },

  { action: ActionId.black, key: 'b', gesture: 'hold', holdMs: MIN_DESTRUCTIVE_HOLD_MS },
  { action: ActionId.logo, key: 'l', gesture: 'tap' },
  { action: ActionId.freeze, key: 'f', gesture: 'tap' },

  { action: ActionId.confirm, key: 'y', gesture: 'tap' },
  { action: ActionId.dismiss, key: 'n', gesture: 'tap' },
  { action: ActionId.back, key: 'Backspace', gesture: 'tap' },

  { action: ActionId.cameraSelect, key: '1', gesture: 'tap', param: 'cam1' },
  { action: ActionId.cameraSelect, key: '2', gesture: 'tap', param: 'cam2' },
  { action: ActionId.cameraSelect, key: '3', gesture: 'tap', param: 'wide' },
  { action: ActionId.cameraSelect, key: '4', gesture: 'tap', param: 'pulpit' },
]

/** A dispatched action, with the input that produced it. */
export interface DispatchedAction {
  readonly action: ActionId
  readonly param?: string
  readonly source: 'keyboard' | 'ui' | 'pedal' | 'engine'
  readonly at: number
}

/**
 * Whether a binding is safe.
 *
 * A destructive action bound to a tap, or to a hold shorter than
 * {@link MIN_DESTRUCTIVE_HOLD_MS}, is a bug — this is the check that stops the v2 regression
 * from being reintroduced by a remap. Phase 10's remap UI must refuse any binding this rejects.
 */
export function isSafeBinding(binding: KeyBinding): boolean {
  if (!DESTRUCTIVE_ACTIONS.includes(binding.action)) return true
  if (binding.gesture !== 'hold') return false
  return (binding.holdMs ?? 0) >= MIN_DESTRUCTIVE_HOLD_MS
}
