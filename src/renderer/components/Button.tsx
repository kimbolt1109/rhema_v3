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
 * Every variant carries a visible focus ring, and it is **the** ring — the single
 * `:focus-visible` outline in `styles/index.css`, inherited rather than restated. This component
 * used to re-declare it locally as `focus-visible:outline-none` plus a box-shadow ring, which is
 * self-defeating: the `outline-none` half is what suppressed the global outline in the first
 * place, so every control had to opt back in by hand and any that forgot shipped with no ring at
 * all. That is precisely the failure v2 logged as focus-visible "not yet standardized"
 * (SHORTCUTS_AND_A11Y.md §9.5). Deleting the local override makes the global rule load-bearing:
 * a control cannot now ship without a ring, because it cannot turn one off by omission.
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
/*
 * Each variant also carries a PRESS state, and it is a shadow swap rather than a transform.
 *
 * `shadow-edge` is a 1px machined highlight along the top edge — what makes a cap look raised.
 * `shadow-recess` is its opposite, an inset that sinks the face into the panel. Trading one for the
 * other on `:active` reads as the cap physically going down, which is the feedback an operator needs
 * in a dark booth: "did that register?" answered without looking away from the stage.
 *
 * Deliberately NOT `scale(0.96)`, the usual choice. Cycle 14 removed transform-based motion from this
 * surface on purpose — a control that changes SIZE draws the eye in peripheral vision, and on a
 * console beside a live stage anything that twitches reads as something firing. A shadow swap is
 * invisible until you are looking at the button you just pressed.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-surface-2 text-text border border-accent shadow-edge hover:bg-surface-3 ' +
    'active:shadow-recess active:bg-surface-2 ' +
    'disabled:bg-surface-2 disabled:border-border disabled:text-text-dim disabled:shadow-none',
  secondary:
    'bg-surface-2 text-text border border-border shadow-edge hover:border-accent-hover hover:bg-surface-3 ' +
    'active:shadow-recess active:bg-surface-2 ' +
    'disabled:text-text-dim disabled:shadow-none',
  danger:
    'bg-panic/[0.12] text-text border border-panic hover:bg-panic/20 ' +
    'active:shadow-recess active:bg-panic/[0.12] ' +
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
        // Enumerated, never the blanket keyword — and note the comment says "blanket keyword" rather
        // than spelling the class out, because Tailwind scans comments as plain text: an earlier
        // draft of this note named it and thereby emitted that very rule into production CSS.
        // `transition-colors` alone is also wrong here: it omits box-shadow, so the press state's
        // shadow would snap while the background eased, reading as two controls reacting at once.
        'transition-[background-color,border-color,box-shadow] duration-150 ease-instrument',
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
