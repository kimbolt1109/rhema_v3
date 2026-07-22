/**
 * One row in the service plan.
 *
 * The row is the operator's whole mental model of the service, so it carries five things and no
 * more: a **drag handle**, a **type icon**, the **label**, a **trigger badge**, and a **fire
 * button**. Everything else lives in the editor panel.
 *
 * ## Reordering is keyboard-first, not pointer-only
 *
 * The handle spreads `@dnd-kit/sortable`'s `attributes` *and* `listeners`, which is what makes the
 * `KeyboardSensor` work: Space picks the cue up, the arrow keys move it, Space drops it. That is
 * not a nicety. A booth operator at 7am on a trackpad — or anyone who does not use a pointer at
 * all — has to be able to reorder a service, and `docs/v2-notes/SHORTCUTS_AND_A11Y.md` treats
 * pointer-only reordering as a defect. The handle is a real `<button>` so it is in the tab order
 * by construction rather than by a `tabIndex` someone can delete.
 *
 * ## Current and next are visually distinct from each other
 *
 * Not one "highlighted" style shared between them. During a service the two questions are "what is
 * on screen right now?" and "what does SPACE do next?", and an operator who has to work out which
 * of two identically-styled rows is which has already lost the thread. `data-position` carries the
 * same fact to the tests, and the row states it in words in a visually-hidden span so a screen
 * reader hears it too — colour is never the only channel.
 */

import clsx from 'clsx'
import {
  BookOpen,
  Clapperboard,
  Film,
  GripVertical,
  ImageIcon,
  Play,
  Type,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { Cue, CueType } from '@shared/plan'

/** One icon per cue type. A slide and a video must not look the same at a glance. */
export const CUE_TYPE_ICONS: Record<CueType, LucideIcon> = {
  scene: Clapperboard,
  slide: ImageIcon,
  media: Film,
  scripture: BookOpen,
  lowerthird: Type,
  action: Zap,
}

/** Where this row sits relative to the pointer. */
export type CuePosition = 'current' | 'next' | 'other'

export interface CueRowProps {
  readonly cue: Cue
  /** 1-based, as the operator counts. */
  readonly ordinal: number
  readonly position: CuePosition
  /** True when this cue is the one open in the editor panel. */
  readonly selected: boolean
  readonly onSelect: (cueId: string) => void
  readonly onFire: (cueId: string) => void
  /** Disables the fire button only — a row must stay editable when the bridge is down. */
  readonly fireDisabled?: boolean
}

export function CueRow({
  cue,
  ordinal,
  position,
  selected,
  onSelect,
  onFire,
  fireDisabled = false,
}: CueRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: cue.id })

  const Icon = CUE_TYPE_ICONS[cue.type]
  const typeLabel = t(`plan.cueType.${cue.type}`)
  const triggerLabel = t(`plan.trigger.mode.${cue.trigger.mode}`)

  return (
    <li
      ref={setNodeRef}
      data-testid={`cue-row-${cue.id}`}
      data-cue-id={cue.id}
      data-position={position}
      data-selected={selected ? 'true' : 'false'}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx(
        'flex items-center gap-2 rounded-glass border bg-surface px-2 py-2',
        // Two different treatments, deliberately: a left bar for what is on screen now, a dashed
        // outline for what SPACE will do next.
        position === 'current' && 'border-live bg-surface-2 border-s-4',
        position === 'next' && 'border-dashed border-accent',
        position === 'other' && 'border-border',
        selected && 'ring-2 ring-ring',
        isDragging && 'opacity-60',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`cue-drag-${cue.id}`}
        aria-label={t('plan.row.dragHandle', { label: cue.label })}
        className="flex min-h-touch w-8 shrink-0 cursor-grab items-center justify-center rounded-glass text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripVertical aria-hidden="true" className="h-5 w-5" />
      </button>

      <span
        aria-hidden="true"
        className="w-6 shrink-0 text-end font-mono text-xs text-text-muted"
      >
        {ordinal}
      </span>

      <Icon
        aria-hidden="true"
        className={clsx(
          'h-5 w-5 shrink-0',
          position === 'current' ? 'text-live' : 'text-text-muted',
        )}
      />

      {/* The label is the button: clicking anywhere on the words opens the cue in the editor. */}
      <button
        type="button"
        data-testid={`cue-select-${cue.id}`}
        onClick={() => {
          onSelect(cue.id)
        }}
        className="min-w-0 flex-1 truncate text-start text-sm font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate">{cue.label}</span>
        <span className="sr-only">
          {' — '}
          {t('plan.row.accessibleSummary', {
            ordinal,
            type: typeLabel,
            trigger: triggerLabel,
          })}
          {position === 'current' ? ` — ${t('plan.row.current')}` : ''}
          {position === 'next' ? ` — ${t('plan.row.next')}` : ''}
        </span>
      </button>

      <span className="shrink-0 rounded-glass border border-border px-2 py-0.5 text-[11px] uppercase tracking-wide text-text-muted">
        {typeLabel}
      </span>

      <span
        data-testid={`cue-trigger-${cue.id}`}
        data-trigger-mode={cue.trigger.mode}
        className={clsx(
          'shrink-0 rounded-glass border px-2 py-0.5 text-[11px] uppercase tracking-wide',
          cue.trigger.mode === 'manual'
            ? 'border-border text-text-muted'
            : 'border-accent text-accent',
        )}
      >
        {triggerLabel}
      </span>

      {position === 'current' || position === 'next' ? (
        <span
          aria-hidden="true"
          className={clsx(
            'shrink-0 rounded-glass px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
            position === 'current' ? 'bg-live/20 text-live' : 'bg-accent/20 text-accent',
          )}
        >
          {position === 'current' ? t('plan.row.current') : t('plan.row.next')}
        </span>
      ) : null}

      <button
        type="button"
        data-testid={`cue-fire-${cue.id}`}
        disabled={fireDisabled}
        onClick={() => {
          onFire(cue.id)
        }}
        aria-label={t('plan.row.fire', { label: cue.label })}
        className="flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-glass border border-accent bg-surface-2 text-accent hover:bg-accent hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:border-border disabled:text-text-muted"
      >
        <Play aria-hidden="true" className="h-5 w-5" />
      </button>
    </li>
  )
}
