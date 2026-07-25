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

/**
 * Three variants, and none of them is a filled coloured field.
 *
 * `primary` used to be a solid indigo cap with a coloured drop-glow, which is the single most
 * template-looking control in the ecosystem — and after the theme's repoint `bg-accent` would paint a
 * LIGHT chalk surface, which ERGO-1 forbids outright. So primary is now an outlined cap with a
 * machined top edge: it is the brightest border in the row, which is all "primary" has to mean.
 *
 * `danger` keeps a saturated border and a tint but its label goes bone — saturated colour is never a
 * text colour in this theme, and bone measures 12.77:1 on that tint where red measured 4.10:1.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-surface-2 text-text border border-accent shadow-edge hover:bg-surface-3 ' +
    'disabled:bg-surface-2 disabled:border-border disabled:text-text-dim disabled:shadow-none',
  secondary:
    'bg-surface-2 text-text border border-border shadow-edge hover:border-accent-hover hover:bg-surface-3 ' +
    'disabled:text-text-dim disabled:shadow-none',
  danger:
    'bg-panic/12 text-text border border-panic hover:bg-panic/20 ' +
    'disabled:bg-surface-2 disabled:text-text-dim disabled:border-border',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'min-h-touch min-w-touch px-4 text-meta',
  lg: 'min-h-touch-lg min-w-touch-lg px-6 text-label',
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
