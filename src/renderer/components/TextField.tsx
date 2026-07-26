/**
 * The booth text field.
 *
 * Notable choices:
 *
 * - **A real `<label htmlFor>`, never a placeholder-as-label.** A placeholder vanishes the moment
 *   the operator types, which is precisely when they most need to know which of two near-identical
 *   fields they are in.
 * - **The password reveal toggle is a labelled `<button>`, not an icon.** Its accessible name
 *   changes with its state (`Show password` / `Hide password`) and it carries `aria-pressed`, so a
 *   screen reader user knows both what it does and what it did. It is also a full 44px target —
 *   it is the control most likely to be hit in a hurry after an `auth-failed`.
 * - **Hint and error are wired through `aria-describedby`**, and the error additionally has
 *   `role="alert"` so it is announced when it appears rather than only when focus lands on it.
 */

import clsx from 'clsx'
import { Eye, EyeOff } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface TextFieldProps {
  readonly id?: string
  readonly label: string
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly type?: 'text' | 'password'
  readonly placeholder?: string
  readonly hint?: string
  /** When set, the field renders as invalid and announces this text. */
  readonly error?: string
  readonly disabled?: boolean
  readonly autoComplete?: string
  readonly spellCheck?: boolean
  readonly name?: string
}

export function TextField({
  id,
  label,
  value,
  onValueChange,
  type = 'text',
  placeholder,
  hint,
  error,
  disabled = false,
  autoComplete,
  spellCheck = false,
  name,
}: TextFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  const [revealed, setRevealed] = useState(false)
  const isPassword = type === 'password'
  const effectiveType = isPassword && revealed ? 'text' : type

  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((part): part is string => part !== null)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-label font-medium text-text">
        {label}
      </label>

      <div className="relative flex items-center">
        <input
          id={inputId}
          name={name}
          type={effectiveType}
          value={value}
          disabled={disabled}
          spellCheck={spellCheck}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(autoComplete !== undefined ? { autoComplete } : {})}
          {...(describedBy.length > 0 ? { 'aria-describedby': describedBy } : {})}
          aria-invalid={error !== undefined}
          onChange={(event) => {
            onValueChange(event.target.value)
          }}
          className={clsx(
            'min-h-touch w-full rounded-glass border bg-surface-2 px-3 text-label font-normal text-text',
            // `select-text` re-enables selection, which `body { user-select: none }` disabled
            // globally. An operator must be able to select and correct a mistyped URL.
            'select-text placeholder:text-text-muted/70',
            'disabled:cursor-not-allowed disabled:opacity-60',
            isPassword ? 'pe-touch' : '',
            error !== undefined ? 'border-panic' : 'border-border',
          )}
        />

        {isPassword ? (
          <button
            type="button"
            onClick={() => {
              setRevealed((current) => !current)
            }}
            disabled={disabled}
            aria-pressed={revealed}
            aria-controls={inputId}
            aria-label={revealed ? t('actions.hidePassword') : t('actions.showPassword')}
            className={clsx(
              'absolute end-0 flex min-h-touch min-w-touch items-center justify-center',
              'rounded-glass text-text-muted hover:text-text',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {revealed ? (
              <EyeOff aria-hidden="true" className="h-5 w-5" />
            ) : (
              <Eye aria-hidden="true" className="h-5 w-5" />
            )}
          </button>
        ) : null}
      </div>

      {hint !== undefined ? (
        <p id={hintId} className="text-meta text-text-muted">
          {hint}
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-meta font-medium text-panic">
          {error}
        </p>
      ) : null}
    </div>
  )
}
