/**
 * The booth button.
 *
 * Sizing is a safety property, not a style one. `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §9.4
 * records that rhema_v2 shipped 28×28px PTZ hold-buttons against a 48px minimum and logged it as
 * a defect (PROBLEMS.md #87). The floor here is `min-h-touch` (44px, WCAG 2.2 target size);
 * primary actions get `min-h-touch-lg` (56px), because a mis-hit on the primary action during a
 * service costs more than a mis-hit on a secondary one, and more finger surface means fewer
 * mis-hits under stress.
 *
 * Every variant carries a visible focus ring — one ring, defined once in `styles/index.css` and
 * reinforced here with Tailwind's `focus-visible:ring` so it survives a `outline: none` reset.
 * v2 left focus-visible "not yet standardized"; not repeating that.
 */

import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger'
export type ButtonSize = 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  /** Rendered before the label and marked `aria-hidden` — the label is the accessible name. */
  readonly icon?: LucideIcon
  readonly children: ReactNode
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-text hover:bg-accent-hover border border-accent-hover shadow-glow ' +
    'disabled:bg-surface-2 disabled:border-border disabled:shadow-none',
  secondary:
    'bg-surface-2 text-text border border-border hover:border-accent/60 ' +
    'disabled:text-text-muted',
  danger:
    'bg-surface-2 text-panic border border-panic/60 hover:bg-panic hover:text-text ' +
    'disabled:text-text-muted disabled:border-border',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'min-h-touch min-w-touch px-4 text-sm',
  lg: 'min-h-touch-lg min-w-touch-lg px-6 text-base',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  children,
  className,
  type = 'button',
  disabled = false,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      // Explicit `type` default: an untyped <button> inside a <form> is a submit button, which is
      // exactly the kind of surprise that fires the wrong action mid-service.
      type={type}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-glass font-medium',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-60',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {Icon !== undefined ? <Icon aria-hidden="true" className="h-5 w-5 shrink-0" /> : null}
      <span>{children}</span>
    </button>
  )
}
