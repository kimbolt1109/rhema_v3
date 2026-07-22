/**
 * Shortcut, foot-pedal and Stream Deck setup.
 *
 * ## Binding a pedal is binding a key
 *
 * There is no pedal driver in Verger and there should not be one. A foot pedal and a Stream Deck
 * both enumerate as keyboards and emit ordinary key codes, so the entire integration is: put this
 * screen in capture mode, let the operator **press the pedal**, and record whatever code arrives.
 * That is why the primary control on every row is "press the key you want" rather than a dropdown
 * of key names — a dropdown could not represent the F13–F24 and media codes programmable pedals
 * actually send, and the operator would have to know what their hardware emits. Pressing it is
 * both the simplest UI and the only one that is guaranteed correct.
 *
 * ## What this screen may not let the operator do
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §6: rhema_v2 shipped ESC as an instant "clear everything"
 * and had to walk it back, because the control an operator reaches for when they want to take over
 * from the AI must never blank the congregation's screen. A remap screen is the obvious way to
 * re-create that hazard, so:
 *
 * - A **destructive** action (Clear all overlays, Black out) set to a tap, or to a hold under
 *   `MIN_DESTRUCTIVE_HOLD_MS`, is shown as an error on its row *and refused by `saveBindings`*.
 *   The refusal lives in `bindings.ts` over `isSafeBinding`, not in this file — a screen that only
 *   *discouraged* it would be one bug away from the v2 regression.
 * - The gesture control is still enabled for those actions, deliberately. Silently ignoring the
 *   click teaches nothing; showing the operator the rule they just hit teaches the rule.
 *
 * ## Two smaller decisions worth stating
 *
 * - **Capture listens in the capture phase and stops propagation.** Without that, pressing `b`
 *   while binding a pedal would *also* reach `useKeyboardActions` on the window and start a
 *   black-out hold. The key being bound must never fire the action it is being bound to.
 * - **Tab cancels a capture; every other key, including Escape, is recordable.** Escape is a real
 *   binding here (hold-to-disable-AI), so spending it on "cancel" would make it unrebindable — but
 *   a keyboard-only operator still needs a way out that is not a mouse. Tab is the compromise, it
 *   is stated in the panel, and it costs only the ability to bind Tab itself.
 */

import clsx from 'clsx'
import { Keyboard, Printer, RotateCcw, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Gesture, KeyBinding } from '@shared/actions'
import { ActionId, MIN_DESTRUCTIVE_HOLD_MS } from '@shared/actions'

import { Button } from '../components/Button'
import { HoldButton } from '../components/HoldButton'
import type { BindingConflict, BindingStorage } from '../input/bindings'
import {
  MAX_HOLD_MS,
  RejectionReason,
  applyCapture,
  bindingSignature,
  captureKey,
  defaultStorage,
  findConflicts,
  formatChord,
  holdFloorFor,
  isDestructive,
  loadBindings,
  resetBindings,
  saveBindings,
  validateBinding,
  withGesture,
} from '../input/bindings'

/** English fallbacks. Localised via `shortcuts.action.*`; see the i18n note below. */
const ACTION_LABELS: Record<ActionId, string> = {
  [ActionId.advance]: 'Advance',
  [ActionId.back]: 'Back',
  [ActionId.cameraSelect]: 'Camera',
  [ActionId.black]: 'Black out program',
  [ActionId.logo]: 'Show logo slate',
  [ActionId.freeze]: 'Freeze frame',
  [ActionId.lowerThirdDismiss]: 'Dismiss lower third',
  [ActionId.clearAll]: 'Clear all overlays',
  [ActionId.disableAi]: 'Disable AI — take over',
  [ActionId.panic]: 'PANIC — stop all automation',
  [ActionId.confirm]: 'Confirm suggestion',
  [ActionId.dismiss]: 'Dismiss suggestion',
}

/** i18n keys are dotted, and so are action ids; flatten so `overlay.clearAll` does not nest. */
function actionKey(action: ActionId): string {
  return `shortcuts.action.${action.replace(/\./gu, '_')}`
}

/**
 * Operator-facing copy for a refusal.
 *
 * `bindings.ts` messages name the raw action id (`output.black`) because it has no idea what the
 * UI calls things; here the friendly label and the localised sentence are available, so the
 * operator reads "Black out program can blank the output…". Reasons this screen cannot produce —
 * an unknown action, a corrupt gesture — fall back to the developer message rather than being
 * hidden.
 */
function rejectionCopy(
  reason: RejectionReason,
  developerMessage: string,
  name: string,
  floor: number,
  text: (key: string, fallback: string, values?: Record<string, string | number>) => string,
): string {
  switch (reason) {
    case RejectionReason.DESTRUCTIVE_TAP:
      return text(
        'shortcuts.reject.destructiveTap',
        '{{action}} can blank the output, so it must be a hold, never a tap.',
        { action: name },
      )
    case RejectionReason.DESTRUCTIVE_HOLD_TOO_SHORT:
      return text(
        'shortcuts.reject.holdTooShort',
        '{{action}} can blank the output, so it must be held for at least {{ms}} ms.',
        { action: name, ms: MIN_DESTRUCTIVE_HOLD_MS },
      )
    case RejectionReason.BAD_HOLD_MS:
      return text(
        'shortcuts.reject.badHold',
        'Enter a hold between {{floor}} and {{max}} milliseconds.',
        { floor, max: MAX_HOLD_MS },
      )
    default:
      return developerMessage
  }
}

/** One editable row. `holdText` is the raw field content, so a half-typed number is not clobbered. */
interface Row {
  readonly binding: KeyBinding
  readonly holdText: string
}

function toRow(binding: KeyBinding): Row {
  return {
    binding,
    holdText: binding.gesture === 'hold' ? String(binding.holdMs ?? '') : '',
  }
}

/**
 * A row per binding, plus an empty row for every action nothing is bound to.
 *
 * `clearAll` is the one that matters: it ships with **no** default key, because the blueprint puts
 * "clear everything" on a deliberately distant on-screen hold rather than under a finger. That is
 * the right default and it stays the default — but an operator with a four-switch pedal board may
 * legitimately want it on a switch, and a screen that simply omitted the action would make that
 * impossible while looking complete. An unbound row has `key: ''`, which is excluded from the saved
 * map, so "not bound" survives a save instead of becoming an invalid binding.
 */
function rowsFrom(bindings: readonly KeyBinding[]): readonly Row[] {
  const bound = new Set<string>(bindings.map((binding) => binding.action))
  const unbound = Object.values(ActionId)
    .filter((action) => !bound.has(action))
    .map((action) =>
      isDestructive(action)
        ? ({ action, key: '', gesture: 'hold', holdMs: holdFloorFor(action) } as const)
        : ({ action, key: '', gesture: 'tap' } as const),
    )
  return [...bindings, ...unbound].map(toRow)
}

/** Whether this row is a placeholder for an action the operator has not bound to anything. */
function isUnbound(binding: KeyBinding): boolean {
  return binding.key.length === 0
}

/**
 * The binding a row currently describes.
 *
 * An unparseable hold becomes `NaN` rather than being silently dropped or clamped: `validateBinding`
 * then reports it as a bad duration on the row, and `saveBindings` refuses it. Clamping while the
 * operator is still typing would fight them — typing "1500" passes through "1", and a field that
 * jumps to 1500 after the first keystroke is unusable.
 */
function bindingOf(row: Row): KeyBinding {
  if (row.binding.gesture !== 'hold') return row.binding
  const text = row.holdText.trim()
  const holdMs = /^\d+$/u.test(text) ? Number(text) : Number.NaN
  return { ...row.binding, holdMs }
}

export interface ShortcutSettingsProps {
  /** Defaults to `localStorage`. Injectable so a test needs no global storage. */
  readonly storage?: BindingStorage | null
  /** Called with the saved (or reset) map, so the app can hand it to `useKeyboardActions`. */
  readonly onChange?: (bindings: readonly KeyBinding[]) => void
}

export function ShortcutSettings({
  storage = defaultStorage(),
  onChange,
}: ShortcutSettingsProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  /** `t` with an English fallback: this slice ships no locale entries of its own yet. */
  const text = useCallback(
    (key: string, fallback: string, values?: Record<string, string | number>): string =>
      values === undefined
        ? t(key, { defaultValue: fallback })
        : t(key, { defaultValue: fallback, ...values }),
    [t],
  )

  const initial = useMemo(() => loadBindings(storage), [storage])
  const [rows, setRows] = useState<readonly Row[]>(() => rowsFrom(initial.bindings))
  const [repaired, setRepaired] = useState(initial.repaired)
  const [capturing, setCapturing] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [showCard, setShowCard] = useState(false)

  const bindings = useMemo(() => rows.map(bindingOf), [rows])
  /** What would actually be saved: the unbound placeholder rows are not bindings. */
  const activeBindings = useMemo(
    () => bindings.filter((binding) => !isUnbound(binding)),
    [bindings],
  )
  const rejections = useMemo(
    () => bindings.map((binding) => (isUnbound(binding) ? null : validateBinding(binding))),
    [bindings],
  )
  const conflicts = useMemo(() => findConflicts(activeBindings), [activeBindings])

  /** Signature → the conflict it belongs to, for the inline warning on each competing row. */
  const conflictBySignature = useMemo(() => {
    const map = new Map<string, BindingConflict>()
    for (const conflict of conflicts) map.set(conflict.signature, conflict)
    return map
  }, [conflicts])

  const patch = useCallback((index: number, next: Row): void => {
    setSaved(false)
    setSaveError(null)
    setRows((current) => current.map((row, position) => (position === index ? next : row)))
  }, [])

  // Capture mode. Listens on the window in the CAPTURE phase and stops propagation, so the key
  // being bound cannot also reach `useKeyboardActions` and fire the action it is being bound to.
  useEffect(() => {
    if (capturing === null) return undefined
    if (typeof window === 'undefined') return undefined

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Tab') {
        setCapturing(null)
        return
      }
      const captured = captureKey(event)
      // A bare modifier is not a binding; stay armed so SHIFT-then-F13 records the chord.
      if (captured === null) return
      setSaved(false)
      setSaveError(null)
      setRows((current) =>
        current.map((row, position) =>
          position === capturing ? { ...row, binding: applyCapture(row.binding, captured) } : row,
        ),
      )
      setCapturing(null)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [capturing])

  const handleSave = (): void => {
    // `saveBindings` is the authority on whether this map may exist — the screen only chooses the
    // wording. Doing it the other way round would put the safety rule in the UI.
    const result = saveBindings(activeBindings, storage)
    if (!result.ok) {
      const index = rejections.findIndex((rejection) => rejection !== null)
      const rejection = index === -1 ? null : rejections[index]
      const binding = index === -1 ? null : bindings[index]
      if (rejection === null || rejection === undefined || binding === undefined || binding === null) {
        setSaveError(result.error.message)
      } else {
        const label = text(actionKey(binding.action), ACTION_LABELS[binding.action])
        setSaveError(
          rejectionCopy(
            rejection.reason,
            rejection.message,
            binding.param === undefined ? label : `${label} — ${binding.param}`,
            holdFloorFor(binding.action),
            text,
          ),
        )
      }
      setSaved(false)
      return
    }
    setSaveError(null)
    setSaved(true)
    setRepaired(false)
    onChange?.(result.value.bindings)
  }

  const handleReset = (): void => {
    const defaults = resetBindings(storage)
    setRows(rowsFrom(defaults))
    setCapturing(null)
    setSaveError(null)
    setRepaired(false)
    setSaved(true)
    onChange?.(defaults)
  }

  const handlePrint = (): void => {
    if (typeof window === 'undefined' || typeof window.print !== 'function') return
    try {
      window.print()
    } catch {
      // A blocked or unimplemented print dialog is not worth an error banner — the card is on
      // screen either way, and the browser's own Ctrl+P still works.
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">
          {text('shortcuts.title', 'Shortcuts, foot pedals & Stream Deck')}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          {text(
            'shortcuts.subtitle',
            'Every operator action can be triggered by a key. Changes apply as soon as you save.',
          )}
        </p>
      </header>

      <section
        aria-label={text('shortcuts.pedal.title', 'Foot pedals and Stream Decks')}
        className="rounded-glass-lg border border-border bg-surface p-5"
      >
        <h2 className="flex items-center gap-2 font-semibold text-text">
          <Keyboard aria-hidden="true" className="h-5 w-5 shrink-0" />
          {text('shortcuts.pedal.title', 'Foot pedals and Stream Decks')}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-text-muted">
          {text(
            'shortcuts.pedal.body',
            'A foot pedal or Stream Deck is just a keyboard: it sends an ordinary key code. So there is nothing extra to install — choose an action below, press Rebind, and then press the pedal or the Stream Deck button itself. Verger records whatever key it sends. If your pedal has configuration software, set it to send a key nothing else uses, such as F13.',
          )}
        </p>
      </section>

      {repaired ? (
        <p role="status" className="text-sm text-panic">
          {text(
            'shortcuts.repaired',
            'Some saved shortcuts could not be read and were put back to their defaults.',
          )}
        </p>
      ) : null}

      {capturing !== null ? (
        <p
          role="status"
          aria-live="assertive"
          className="rounded-glass border border-accent bg-surface-2 p-4 text-sm text-text"
        >
          {text(
            'shortcuts.capture.prompt',
            'Press the key, foot pedal or Stream Deck button you want. Press Tab to cancel.',
          )}
        </p>
      ) : null}

      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          {text('shortcuts.tableCaption', 'Actions and the keys bound to them')}
        </caption>
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
            <th scope="col" className="py-2 pr-3">
              {text('shortcuts.column.action', 'Action')}
            </th>
            <th scope="col" className="py-2 pr-3">
              {text('shortcuts.column.key', 'Key')}
            </th>
            <th scope="col" className="py-2 pr-3">
              {text('shortcuts.column.gesture', 'Gesture')}
            </th>
            <th scope="col" className="py-2 pr-3">
              {text('shortcuts.column.hold', 'Hold (ms)')}
            </th>
            <th scope="col" className="py-2">
              {text('shortcuts.column.status', 'Notes')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const binding = bindings[index] ?? row.binding
            const rejection = rejections[index] ?? null
            const conflict = conflictBySignature.get(bindingSignature(binding))
            const label = text(actionKey(binding.action), ACTION_LABELS[binding.action])
            const name = binding.param === undefined ? label : `${label} — ${binding.param}`
            const destructive = isDestructive(binding.action)
            const floor = holdFloorFor(binding.action)
            const gestureId = `shortcut-gesture-${String(index)}`
            const holdId = `shortcut-hold-${String(index)}`
            const noteId = `shortcut-note-${String(index)}`

            return (
              // Keyed by position, not by the binding: a key derived from the chord changes the
              // moment the operator edits the row, which remounts it and rips the control they are
              // still using out of the DOM mid-interaction.
              <tr key={`row-${String(index)}`} className="border-b border-border/60 align-top">
                <th scope="row" className="py-3 pr-3 font-medium text-text">
                  {name}
                  {destructive ? (
                    <span className="ml-2 rounded-glass border border-panic/60 px-1.5 py-0.5 text-[0.65rem] uppercase text-panic">
                      {text('shortcuts.destructive', 'Hold only')}
                    </span>
                  ) : null}
                </th>

                <td className="py-3 pr-3">
                  <span className="mr-2 select-text font-mono text-text">
                    {isUnbound(binding)
                      ? text('shortcuts.unbound', 'Not bound')
                      : formatChord(binding)}
                  </span>
                  <Button
                    onClick={() => {
                      setCapturing(capturing === index ? null : index)
                    }}
                    aria-label={
                      capturing === index
                        ? text('shortcuts.cancelCaptureFor', 'Cancel rebinding {{action}}', {
                            action: name,
                          })
                        : text('shortcuts.rebindFor', 'Rebind {{action}}', { action: name })
                    }
                  >
                    {capturing === index
                      ? text('shortcuts.capture.waiting', 'Press a key…')
                      : text('shortcuts.rebind', 'Rebind')}
                  </Button>
                </td>

                <td className="py-3 pr-3">
                  <label htmlFor={gestureId} className="sr-only">
                    {text('shortcuts.gestureFor', 'Gesture for {{action}}', { action: name })}
                  </label>
                  <select
                    id={gestureId}
                    value={binding.gesture}
                    onChange={(event) => {
                      const gesture = event.target.value as Gesture
                      // Start from the row's *current* duration so that switching hold → tap →
                      // hold does not silently discard an edit, but fall back to the stored
                      // binding when the field holds something unparseable.
                      const edited = bindingOf(row)
                      const base = Number.isFinite(edited.holdMs ?? 0) ? edited : row.binding
                      const next = withGesture(base, gesture)
                      patch(index, {
                        binding: next,
                        holdText: next.gesture === 'hold' ? String(next.holdMs ?? '') : '',
                      })
                    }}
                    className="min-h-touch rounded-glass border border-border bg-surface-2 px-2 text-text"
                  >
                    <option value="tap">{text('shortcuts.gesture.tap', 'Tap')}</option>
                    <option value="hold">{text('shortcuts.gesture.hold', 'Hold')}</option>
                  </select>
                </td>

                <td className="py-3 pr-3">
                  {row.binding.gesture === 'hold' ? (
                    <>
                      <label htmlFor={holdId} className="sr-only">
                        {text('shortcuts.holdFor', 'Hold duration for {{action}} in milliseconds', {
                          action: name,
                        })}
                      </label>
                      <input
                        id={holdId}
                        // Text + numeric input mode rather than `type="number"`, which discards
                        // what was typed when it is not a valid number — here the operator can see
                        // the value that is being refused.
                        type="text"
                        inputMode="numeric"
                        value={row.holdText}
                        aria-invalid={rejection !== null}
                        aria-describedby={noteId}
                        onChange={(event) => {
                          patch(index, { ...row, holdText: event.target.value })
                        }}
                        className={clsx(
                          'min-h-touch w-24 select-text rounded-glass border bg-surface-2 px-2 text-text',
                          rejection === null ? 'border-border' : 'border-panic',
                        )}
                      />
                      <span className="ml-2 text-xs text-text-muted">
                        {text('shortcuts.holdRange', 'min {{floor}}, max {{max}}', {
                          floor,
                          max: MAX_HOLD_MS,
                        })}
                      </span>
                    </>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>

                <td className="py-3" id={noteId}>
                  {rejection !== null ? (
                    <span className="font-medium text-panic">
                      {rejectionCopy(rejection.reason, rejection.message, name, floor, text)}
                    </span>
                  ) : null}
                  {conflict !== undefined ? (
                    <span className="block text-panic">
                      {text(
                        'shortcuts.conflict',
                        'Conflict: {{chord}} is bound to {{actions}}. Only the first one will fire.',
                        {
                          chord: formatChord(binding),
                          actions: conflict.bindings
                            .map((other) =>
                              text(actionKey(other.action), ACTION_LABELS[other.action]),
                            )
                            .join(', '),
                        },
                      )}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={Save} onClick={handleSave}>
          {text('shortcuts.save', 'Save shortcuts')}
        </Button>
        <Button
          icon={Printer}
          onClick={() => {
            setShowCard((current) => !current)
          }}
        >
          {text('shortcuts.printableCard', 'Printable card')}
        </Button>
        <HoldButton
          label={text('shortcuts.reset', 'Reset all shortcuts to defaults')}
          icon={RotateCcw}
          durationMs={MIN_DESTRUCTIVE_HOLD_MS}
          onHoldComplete={handleReset}
        />
      </div>

      {saveError !== null ? (
        <p role="alert" className="text-sm font-medium text-panic">
          {saveError}
        </p>
      ) : null}
      <p role="status" className="text-sm text-text-muted">
        {saved ? text('shortcuts.saved', 'Shortcuts saved.') : ''}
      </p>

      {showCard ? (
        <section
          aria-label={text('shortcuts.card.title', 'Shortcut card')}
          className="rounded-glass-lg border border-border bg-surface p-5"
        >
          <h2 className="text-lg font-semibold text-text">
            {text('shortcuts.card.title', 'Shortcut card')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            {text(
              'shortcuts.card.body',
              'Print this and tape it to the booth keyboard. The blueprint asks for it by name: the key that hands control back to the human must be readable without opening the app.',
            )}
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-text">
            {activeBindings.map((binding, index) => {
              const label = text(actionKey(binding.action), ACTION_LABELS[binding.action])
              const name = binding.param === undefined ? label : `${label} — ${binding.param}`
              return (
                <li key={`card-${String(index)}`} className="flex justify-between gap-4">
                  <span>{name}</span>
                  <span className="select-text font-mono">
                    {binding.gesture === 'hold'
                      ? text('shortcuts.card.hold', '{{chord}} — hold {{seconds}}s', {
                          chord: formatChord(binding),
                          seconds: Number.isFinite(binding.holdMs ?? Number.NaN)
                            ? Math.round((binding.holdMs ?? 0) / 100) / 10
                            : '?',
                        })
                      : text('shortcuts.card.tap', '{{chord}} — tap', {
                          chord: formatChord(binding),
                        })}
                  </span>
                </li>
              )
            })}
          </ul>
          <Button icon={Printer} className="mt-4" onClick={handlePrint}>
            {text('shortcuts.card.print', 'Print this card')}
          </Button>
        </section>
      ) : null}
    </div>
  )
}

export default ShortcutSettings
