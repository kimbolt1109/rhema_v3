/**
 * Persistence, merging and validation for the operator's keymap — the data half of the remap UI.
 *
 * ## Why there is no HID code in here
 *
 * A foot pedal and a Stream Deck are keyboard-HID devices: they enumerate as keyboards and emit
 * ordinary key codes. `useKeyboardActions` already turns key codes into {@link ActionId}
 * dispatches, so a pedal that sends SPACE *already works today* with no code at all. What was
 * missing was not a second input path but the ability to say "my pedal sends F13, bind advance to
 * F13" and have that survive a restart. That is all this module is: load, merge, validate, save.
 * Adding a native HID dependency would buy nothing and cost a native rebuild per Electron bump.
 *
 * ## Where the map is stored, and why localStorage
 *
 * **localStorage, under {@link BINDINGS_STORAGE_KEY}.** The alternative was the config IPC channel
 * in `@shared/config`. localStorage wins here for three reasons: the keymap is consumed only by
 * the renderer (the main process never matches a key), it is read on the render that mounts the
 * booth UI so a synchronous read avoids a frame where no key is bound, and it keeps this slice
 * inside the renderer instead of adding an IPC channel and a main-process writer for a few hundred
 * bytes. The cost is honest and worth stating: the map is per-machine-profile and is **not** in the
 * exported/backed-up config, and clearing the app's site data resets it to the defaults. If a later
 * phase needs the map on the main side (a REST control surface, say), move it behind
 * `@shared/config` — every function here takes an injectable {@link BindingStorage}, so the swap is
 * one adapter, not a rewrite.
 *
 * ## The three rules this module exists to enforce
 *
 * 1. **{@link isSafeBinding} is enforced on save.** A destructive action bound to a *tap*, or to a
 *    hold shorter than {@link MIN_DESTRUCTIVE_HOLD_MS}, is refused with a reason the UI can show.
 *    This is the guard against re-introducing rhema_v2's instant-clear-ESC regression *through the
 *    remap screen* — the incident is written up in `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6, and
 *    `isSafeBinding` exists precisely so that the check is one function rather than UI discipline.
 * 2. **Merging is additive.** A map saved by v0.1 must not hide an action introduced in v0.2. So a
 *    stored map is merged *over* the defaults by action identity, never used in place of them:
 *    what the operator changed is kept, what they have never seen appears with its default binding.
 * 3. **Conflicts are reported, not refused.** Two bindings on the same key+modifiers+gesture is a
 *    mistake — `useKeyboardActions` takes the first match, so the second is simply dead — but it is
 *    not dangerous, and refusing the save would strand the operator mid-remap with an unsaveable
 *    screen. Unsafe is fatal; ambiguous is a warning.
 *
 * No Node globals: this module is bundled into the renderer.
 */

import type { Gesture, KeyBinding } from '@shared/actions'
import {
  ActionId,
  DEFAULT_KEY_BINDINGS,
  DESTRUCTIVE_ACTIONS,
  MIN_DESTRUCTIVE_HOLD_MS,
  isSafeBinding,
} from '@shared/actions'
import type { Result } from '@shared/result'
import { ErrorCode, err, ok } from '@shared/result'

/** localStorage key holding the operator's keymap, as a JSON array of {@link KeyBinding}. */
export const BINDINGS_STORAGE_KEY = 'verger-key-bindings'

/**
 * Floor for a *non*-destructive hold.
 *
 * Not a safety rule — nothing bad happens if `logo` fires at 250 ms — but a hold shorter than this
 * is indistinguishable from a slow tap on real hardware, and a binding the operator cannot reliably
 * trigger is a support call.
 */
export const MIN_HOLD_MS = 250

/** Upper bound for a hold. Longer than this and the operator assumes the app has frozen. */
export const MAX_HOLD_MS = 10_000

/** What a newly-created hold binding gets, before the destructive floor is applied. */
export const DEFAULT_HOLD_MS = 1000

/** The subset of `Storage` this module uses. Injectable so tests need no jsdom localStorage. */
export interface BindingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Why a binding was refused. Stable strings — the UI maps them to copy. */
export const RejectionReason = {
  /** `key` was empty, or was a bare modifier such as `Shift`. */
  EMPTY_KEY: 'empty-key',
  /** The action is not in {@link ActionId} — e.g. a map written by a newer version. */
  UNKNOWN_ACTION: 'unknown-action',
  /** `gesture` was neither `tap` nor `hold`. */
  BAD_GESTURE: 'bad-gesture',
  /** A `hold` binding with no usable `holdMs`, or one outside {@link MAX_HOLD_MS}. */
  BAD_HOLD_MS: 'bad-hold-ms',
  /** A destructive action bound to a tap. Refused by {@link isSafeBinding}. */
  DESTRUCTIVE_TAP: 'destructive-tap',
  /** A destructive action held for less than {@link MIN_DESTRUCTIVE_HOLD_MS}. */
  DESTRUCTIVE_HOLD_TOO_SHORT: 'destructive-hold-too-short',
} as const

/** Union of every {@link RejectionReason} value. */
export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason]

/** One refused binding, with a reason the remap screen can render next to the offending row. */
export interface BindingRejection {
  readonly binding: KeyBinding
  readonly reason: RejectionReason
  /** English, developer-facing; the UI shows its own localised copy keyed off `reason`. */
  readonly message: string
}

/** Two or more bindings competing for the same physical gesture. */
export interface BindingConflict {
  /** `bindingSignature` of the contested key+modifiers+gesture. */
  readonly signature: string
  readonly key: string
  readonly gesture: Gesture
  /** In list order. The first one wins at runtime; the rest are dead. */
  readonly bindings: readonly KeyBinding[]
}

/** Every {@link ActionId} value, for validating a map read back from storage. */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.values(ActionId))

/** Keys that are only ever modifiers — binding one alone would swallow every chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'OS',
])

/**
 * Case-folds single-character keys, mirroring `useKeyboardActions.normalizeKey`.
 *
 * It has to mirror it exactly: if this module thought `B` and `b` were different bindings while the
 * dispatcher thought they were the same, a "conflict-free" map would still have a dead binding in
 * it — and if the dead one were the destructive hold, the operator would be pressing a key that
 * does nothing in the moment they need it.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/**
 * The identity a binding competes on: key + modifiers + gesture.
 *
 * Deliberately *not* including the action or param — two bindings differing only in action are
 * exactly the conflict this detects.
 */
export function bindingSignature(binding: KeyBinding): string {
  const modifiers = [
    binding.ctrl === true ? 'ctrl' : '',
    binding.alt === true ? 'alt' : '',
    binding.shift === true ? 'shift' : '',
  ]
    .filter((part) => part.length > 0)
    .join('+')
  const chord = modifiers.length > 0 ? `${modifiers}+${normalizeKey(binding.key)}` : normalizeKey(binding.key)
  return `${chord}/${binding.gesture}`
}

/**
 * The identity a binding *belongs* to: action + param.
 *
 * `cameraSelect` appears four times in the defaults with four different params, so action alone
 * would collapse them into one row and lose three cameras.
 */
export function bindingIdentity(binding: Pick<KeyBinding, 'action' | 'param'>): string {
  return binding.param === undefined ? binding.action : `${binding.action}:${binding.param}`
}

/** The shortest hold `action` may legally use. */
export function holdFloorFor(action: ActionId): number {
  return DESTRUCTIVE_ACTIONS.includes(action) ? MIN_DESTRUCTIVE_HOLD_MS : MIN_HOLD_MS
}

/** Whether `action` can blank the congregation's screen, and so may never be a tap. */
export function isDestructive(action: ActionId): boolean {
  return DESTRUCTIVE_ACTIONS.includes(action)
}

/** A printable name for a key: `' '` → `Space`, `Escape` → `Esc`, `b` → `B`. */
export function keyLabel(key: string): string {
  if (key === ' ') return 'Space'
  if (key === 'Escape') return 'Esc'
  if (key === 'ArrowLeft') return '←'
  if (key === 'ArrowRight') return '→'
  if (key === 'ArrowUp') return '↑'
  if (key === 'ArrowDown') return '↓'
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** A printable chord: `Shift + Esc`. Modifier order is fixed so the printed card is stable. */
export function formatChord(binding: KeyBinding): string {
  const parts: string[] = []
  if (binding.ctrl === true) parts.push('Ctrl')
  if (binding.alt === true) parts.push('Alt')
  if (binding.shift === true) parts.push('Shift')
  parts.push(keyLabel(binding.key))
  return parts.join(' + ')
}

/**
 * Check one binding.
 *
 * Order matters: the structural checks run first so that a garbage `gesture` is reported as a bad
 * gesture rather than as a destructive tap. The last two branches are the whole reason this
 * function is exported — they are {@link isSafeBinding}'s two failure modes, split apart so the UI
 * can say *which* rule was broken instead of "invalid".
 */
export function validateBinding(binding: KeyBinding): BindingRejection | null {
  const reject = (reason: RejectionReason, message: string): BindingRejection => ({
    binding,
    reason,
    message,
  })

  if (typeof binding.key !== 'string' || binding.key.length === 0) {
    return reject(RejectionReason.EMPTY_KEY, 'A binding needs a key.')
  }
  if (MODIFIER_KEYS.has(binding.key)) {
    return reject(
      RejectionReason.EMPTY_KEY,
      `"${binding.key}" is a modifier, not a key — hold it and press another key.`,
    )
  }
  if (!KNOWN_ACTIONS.has(binding.action)) {
    return reject(RejectionReason.UNKNOWN_ACTION, `Unknown action "${binding.action}".`)
  }
  if (binding.gesture !== 'tap' && binding.gesture !== 'hold') {
    return reject(RejectionReason.BAD_GESTURE, `Unknown gesture "${String(binding.gesture)}".`)
  }

  if (binding.gesture === 'hold') {
    const holdMs = binding.holdMs
    if (typeof holdMs !== 'number' || !Number.isFinite(holdMs) || holdMs <= 0) {
      return reject(RejectionReason.BAD_HOLD_MS, 'A hold binding needs a hold duration.')
    }
    if (holdMs > MAX_HOLD_MS) {
      return reject(
        RejectionReason.BAD_HOLD_MS,
        `A hold longer than ${MAX_HOLD_MS} ms reads as a frozen app.`,
      )
    }
    if (holdMs < MIN_HOLD_MS && !isDestructive(binding.action)) {
      return reject(
        RejectionReason.BAD_HOLD_MS,
        `A hold shorter than ${MIN_HOLD_MS} ms cannot be told apart from a tap.`,
      )
    }
  }

  // The v2 regression guard. Kept as a call to the shared predicate rather than re-implemented,
  // so there is exactly one definition of "safe" in the codebase.
  if (!isSafeBinding(binding)) {
    if (binding.gesture !== 'hold') {
      return reject(
        RejectionReason.DESTRUCTIVE_TAP,
        `"${binding.action}" can blank the output, so it must be a hold, never a tap.`,
      )
    }
    return reject(
      RejectionReason.DESTRUCTIVE_HOLD_TOO_SHORT,
      `"${binding.action}" can blank the output, so it must be held for at least ${MIN_DESTRUCTIVE_HOLD_MS} ms.`,
    )
  }

  return null
}

/** Every rejection in `bindings`, in list order. Empty means the map is safe to save. */
export function validateBindings(bindings: readonly KeyBinding[]): readonly BindingRejection[] {
  const rejections: BindingRejection[] = []
  for (const binding of bindings) {
    const rejection = validateBinding(binding)
    if (rejection !== null) rejections.push(rejection)
  }
  return rejections
}

/**
 * Bindings competing for the same key+modifiers+gesture.
 *
 * Reported rather than refused — see the module note. The first binding in each group is the one
 * `useKeyboardActions` will actually fire; the rest are dead, which is what the UI warns about.
 */
export function findConflicts(bindings: readonly KeyBinding[]): readonly BindingConflict[] {
  const groups = new Map<string, KeyBinding[]>()
  for (const binding of bindings) {
    const signature = bindingSignature(binding)
    const group = groups.get(signature)
    if (group === undefined) groups.set(signature, [binding])
    else group.push(binding)
  }

  const conflicts: BindingConflict[] = []
  for (const [signature, group] of groups) {
    if (group.length < 2) continue
    const first = group[0]
    if (first === undefined) continue
    conflicts.push({
      signature,
      key: first.key,
      gesture: first.gesture,
      bindings: [...group],
    })
  }
  return conflicts
}

/**
 * Merge a stored map over a defaults list.
 *
 * The additive half of rule 2 in the module note. For each default *identity* (action+param): if
 * the stored map has bindings for it, they win outright — including having more than one, so an
 * operator who bound `advance` to both SPACE and a pedal's F13 keeps both. If it has none, the
 * default is used, which is how an action introduced after the map was saved shows up at all.
 *
 * Stored bindings for identities the defaults no longer contain are dropped, not appended: an
 * action removed from {@link ActionId} has no handler, so keeping its binding would put a row in
 * the remap screen for a key that does nothing.
 */
export function mergeWithDefaults(
  stored: readonly KeyBinding[],
  defaults: readonly KeyBinding[] = DEFAULT_KEY_BINDINGS,
): readonly KeyBinding[] {
  const byIdentity = new Map<string, KeyBinding[]>()
  for (const binding of stored) {
    const identity = bindingIdentity(binding)
    const group = byIdentity.get(identity)
    if (group === undefined) byIdentity.set(identity, [binding])
    else group.push(binding)
  }

  const merged: KeyBinding[] = []
  const emitted = new Set<string>()
  for (const fallback of defaults) {
    const identity = bindingIdentity(fallback)
    if (emitted.has(identity)) continue
    emitted.add(identity)
    const userBindings = byIdentity.get(identity)
    if (userBindings === undefined || userBindings.length === 0) merged.push(fallback)
    else merged.push(...userBindings)
  }
  return merged
}

/**
 * Coerce whatever came out of storage into bindings, dropping anything unusable.
 *
 * Storage is an untrusted boundary — the operator can edit it, and a downgrade can leave a newer
 * map behind — so this is written defensively and never throws. A dropped entry is not an error:
 * {@link mergeWithDefaults} puts the default back, which is a far better outcome than refusing to
 * open the screen.
 */
function sanitize(parsed: unknown): readonly KeyBinding[] {
  if (!Array.isArray(parsed)) return []
  const bindings: KeyBinding[] = []
  for (const entry of parsed as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const action = record['action']
    const key = record['key']
    const gesture = record['gesture']
    if (typeof action !== 'string' || !KNOWN_ACTIONS.has(action)) continue
    if (typeof key !== 'string' || key.length === 0) continue
    if (gesture !== 'tap' && gesture !== 'hold') continue

    const holdMs = record['holdMs']
    const param = record['param']
    const binding: KeyBinding = {
      action: action as ActionId,
      key,
      gesture,
      ...(typeof holdMs === 'number' && Number.isFinite(holdMs) ? { holdMs } : {}),
      ...(record['shift'] === true ? { shift: true } : {}),
      ...(record['ctrl'] === true ? { ctrl: true } : {}),
      ...(record['alt'] === true ? { alt: true } : {}),
      ...(typeof param === 'string' ? { param } : {}),
    }
    // A stored binding that would blank the screen on a tap is discarded outright rather than
    // shown for the operator to fix: it must never reach `useKeyboardActions`, and the default
    // takes its place on merge.
    if (validateBinding(binding) !== null) continue
    bindings.push(binding)
  }
  return bindings
}

/** `globalThis.localStorage` when there is one, else `null` — SSR/node tests get no storage. */
export function defaultStorage(): BindingStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: BindingStorage }).localStorage
    return candidate ?? null
  } catch {
    // Some environments throw on `localStorage` access when site data is blocked.
    return null
  }
}

/** What a load produced, and whether anything had to be repaired to get there. */
export interface LoadedBindings {
  readonly bindings: readonly KeyBinding[]
  /** True when the stored map was absent, corrupt, or partially dropped. */
  readonly repaired: boolean
}

/**
 * Read the keymap.
 *
 * **Never fails.** A corrupt or missing map yields the defaults with `repaired: true`, because the
 * one outcome that is not acceptable is an operator opening the booth to no keyboard at all. The
 * flag is what the UI uses to say "we reset something" instead of silently rewriting their map.
 */
export function loadBindings(storage: BindingStorage | null = defaultStorage()): LoadedBindings {
  if (storage === null) return { bindings: DEFAULT_KEY_BINDINGS, repaired: false }

  let raw: string | null = null
  try {
    raw = storage.getItem(BINDINGS_STORAGE_KEY)
  } catch {
    return { bindings: DEFAULT_KEY_BINDINGS, repaired: true }
  }
  if (raw === null || raw.length === 0) return { bindings: DEFAULT_KEY_BINDINGS, repaired: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { bindings: DEFAULT_KEY_BINDINGS, repaired: true }
  }

  const stored = sanitize(parsed)
  const storedCount = Array.isArray(parsed) ? (parsed as readonly unknown[]).length : 0
  return {
    bindings: mergeWithDefaults(stored),
    repaired: stored.length !== storedCount,
  }
}

/**
 * Validate and write the keymap.
 *
 * The gate. `isSafeBinding` runs over every binding *before* anything is written, so a map that
 * would let a tap blank the output cannot reach storage, cannot survive a restart, and cannot be
 * loaded back by a future version that trusts what it reads. Conflicts do not block the write —
 * they come back in the success value so the screen can warn about the dead binding.
 */
export function saveBindings(
  bindings: readonly KeyBinding[],
  storage: BindingStorage | null = defaultStorage(),
): Result<{ readonly bindings: readonly KeyBinding[]; readonly conflicts: readonly BindingConflict[] }> {
  const rejections = validateBindings(bindings)
  const first = rejections[0]
  if (first !== undefined) {
    return err(
      ErrorCode.INVALID_ARG,
      first.message,
      rejections.map((rejection) => `${rejection.binding.action}: ${rejection.reason}`).join('; '),
    )
  }

  if (storage === null) {
    return err(ErrorCode.IO_ERROR, 'No storage is available to save shortcuts.')
  }

  try {
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings))
  } catch (cause) {
    return err(
      ErrorCode.IO_ERROR,
      'Could not save shortcuts.',
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  return ok({ bindings, conflicts: findConflicts(bindings) })
}

/** Forget the stored map. Returns the defaults, which is what the next load will produce. */
export function resetBindings(
  storage: BindingStorage | null = defaultStorage(),
): readonly KeyBinding[] {
  if (storage !== null) {
    try {
      storage.removeItem(BINDINGS_STORAGE_KEY)
    } catch {
      // A storage that will not forget is not worth failing the reset over: the caller is handed
      // the defaults either way, and the next save overwrites the stale entry.
    }
  }
  return DEFAULT_KEY_BINDINGS
}

/** A key press reduced to the parts of a binding it determines. */
export interface CapturedKey {
  readonly key: string
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly alt?: boolean
}

/** The fields {@link captureKey} reads. Lets a test pass a literal instead of a `KeyboardEvent`. */
export interface CaptureSource {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
}

/**
 * Turn a key press into the key half of a binding — this is the "press the key you want" capture,
 * and equally the "press the pedal you want" capture, because they are the same event.
 *
 * Returns `null` for a bare modifier: the operator holding SHIFT on the way to SHIFT+F13 must not
 * have `Shift` itself recorded. Modifier flags are **omitted rather than set false**
 * (`exactOptionalPropertyTypes`), which also keeps the stored JSON to what the operator actually
 * pressed.
 */
export function captureKey(source: CaptureSource): CapturedKey | null {
  if (typeof source.key !== 'string' || source.key.length === 0) return null
  if (MODIFIER_KEYS.has(source.key)) return null
  return {
    key: source.key,
    ...(source.shiftKey === true ? { shift: true } : {}),
    ...(source.ctrlKey === true ? { ctrl: true } : {}),
    ...(source.altKey === true ? { alt: true } : {}),
  }
}

/**
 * Apply a captured key to a binding, preserving action, gesture, hold and param.
 *
 * Rebuilt rather than spread-patched so that a modifier the operator *stopped* using is actually
 * removed: `{ ...binding, ...captured }` would leave a stale `shift: true` behind, and a binding
 * the operator believes is on F13 would silently require SHIFT+F13.
 */
export function applyCapture(binding: KeyBinding, captured: CapturedKey): KeyBinding {
  return {
    action: binding.action,
    key: captured.key,
    gesture: binding.gesture,
    ...(binding.holdMs !== undefined ? { holdMs: binding.holdMs } : {}),
    ...(captured.shift === true ? { shift: true } : {}),
    ...(captured.ctrl === true ? { ctrl: true } : {}),
    ...(captured.alt === true ? { alt: true } : {}),
    ...(binding.param !== undefined ? { param: binding.param } : {}),
  }
}

/**
 * Switch a binding's gesture, choosing a hold duration that is legal for the action.
 *
 * A destructive action switched to `hold` lands on {@link MIN_DESTRUCTIVE_HOLD_MS} at minimum, so
 * the common path through the UI produces a safe binding without the operator having to know the
 * rule. Switching a destructive action to `tap` is *allowed here and refused on save* — deliberate,
 * so the screen can show the operator the reason rather than silently ignoring the click.
 */
export function withGesture(binding: KeyBinding, gesture: Gesture): KeyBinding {
  if (gesture === 'tap') {
    const { holdMs: _holdMs, ...rest } = binding
    return { ...rest, gesture: 'tap' }
  }
  const floor = holdFloorFor(binding.action)
  const current = binding.holdMs ?? DEFAULT_HOLD_MS
  return { ...binding, gesture: 'hold', holdMs: Math.max(floor, current) }
}

/** Set a hold duration, clamped to the action's floor and {@link MAX_HOLD_MS}. */
export function withHoldMs(binding: KeyBinding, holdMs: number): KeyBinding {
  if (binding.gesture !== 'hold') return binding
  const floor = holdFloorFor(binding.action)
  const clamped = Math.min(MAX_HOLD_MS, Math.max(floor, Math.round(holdMs)))
  return { ...binding, holdMs: clamped }
}
