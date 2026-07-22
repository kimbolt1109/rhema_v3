/**
 * One cue, rendered so an operator can recognise it in half a second in a dark booth.
 *
 * This is the component the NOW/NEXT hero cards in {@link PlanRunner} are built out of, and it is
 * deliberately dumb: it takes a {@link Cue} and draws it. It fires nothing, fetches nothing and
 * owns no state, so it can be mounted twice on the same screen (once for NOW, once for NEXT)
 * without either copy affecting the other.
 *
 * ## Standing Rule 4 lives here
 *
 * A `slide` cue is an **opaque image**. This component renders the picture and the operator's own
 * label; it never reads, extracts or displays text *from inside* the slide, and nothing in this
 * file goes near the pixels. A `scripture` cue renders its REFERENCE and its translation code and
 * nothing else — `src/shared/plan.ts` gives the scripture payload no `text` field precisely so that
 * a component like this one cannot accidentally become a verse renderer. The line under the
 * reference says the text is resolved at fire time, so an operator is never left wondering whether
 * a blank preview means a broken cue.
 *
 * ## Why the `<img>` is the pre-loader
 *
 * BLUEPRINT.md §4: "The next slide is **pre-loaded** so firing is instant." The cheapest correct
 * way to get an image into the renderer's cache before it is needed is to have already painted it
 * somewhere — so the NEXT card's thumbnail *is* the pre-load, not merely a picture of it. That is
 * why {@link CuePreviewProps.imageTestId} exists: the runner (and its tests) can point at the exact
 * element that proves the asset was fetched ahead of the advance.
 *
 * ## Malformed cues degrade, they do not crash
 *
 * The payload union is discriminated by `cue.type`, which TypeScript cannot correlate across an
 * object boundary. Rather than cast — a cast is a promise about a value that may have come off
 * disk, out of a hand-edited plan file or out of a deck importer — each branch re-validates with the
 * shared `cuePayloadSchemas`. A payload that does not match its type renders as an explicit
 * "malformed cue" note instead of throwing inside a live service (Standing Rule 5).
 *
 * No Node globals — this module is bundled into the renderer.
 */

import clsx from 'clsx'
import {
  BookOpen,
  CircleAlert,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Type,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { overlayOrigin } from '@shared/net'
import type { Cue, CueType } from '@shared/plan'
import { cuePayloadSchemas } from '@shared/plan'

/**
 * Turns a plan-relative asset path into something an `<img>` can load.
 *
 * Returns `null` when the path cannot be served, which the caller renders as a labelled
 * placeholder rather than as a broken image icon.
 */
export type AssetUrlResolver = (asset: string) => string | null

/**
 * The route the overlay server is expected to expose the plan's asset folder under.
 *
 * ASSUMPTION: the main-process half of Phase 6 serves `ServicePlan.assetDir` from the overlay
 * server (the same server that already serves the overlay pages, per `src/shared/net.ts` — one
 * port, not two). Nothing in the renderer can verify that, so the resolver is injectable end to
 * end: `PlanRunner` and `CuePreview` both take an `assetUrl` prop, and the day the real route is
 * known, one function changes and no component does.
 */
export const PLAN_ASSET_PATH = '/plan-assets'

/**
 * Build a loadable URL for a plan-relative asset.
 *
 * Refuses anything that is not plainly relative. `SlidePayload.asset` is documented as "path
 * relative to the plan's asset folder", so a `..` segment, a leading `/` or a `C:` drive letter is
 * either a mistake or a traversal attempt from an imported deck — and in both cases the honest
 * answer on screen is "this asset cannot be shown", not a request that escapes the asset folder.
 */
export function defaultAssetUrl(asset: string): string | null {
  const trimmed = asset.trim()
  if (trimmed.length === 0) return null
  // An importer may legitimately have written an absolute http(s) URL; pass it through untouched.
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null

  const segments = trimmed
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes(':'))) {
    return null
  }

  return `${overlayOrigin()}${PLAN_ASSET_PATH}/${segments.map(encodeURIComponent).join('/')}`
}

/** The glyph for each cue type. Reinforces the type word; never the only signal. */
export const CUE_TYPE_ICONS: Readonly<Record<CueType, LucideIcon>> = {
  scene: Clapperboard,
  slide: ImageIcon,
  media: Film,
  scripture: BookOpen,
  lowerthird: Type,
  action: Zap,
}

/** English fallbacks for the cue-type word, used until the `plan.*` locale keys land. */
const CUE_TYPE_LABELS: Readonly<Record<CueType, string>> = {
  scene: 'Scene',
  slide: 'Slide',
  media: 'Media',
  scripture: 'Scripture',
  lowerthird: 'Lower third',
  action: 'Action',
}

export interface CuePreviewProps {
  /** The cue to draw. `null` renders the "nothing here" state rather than an empty box. */
  readonly cue: Cue | null
  /** Defaults to {@link defaultAssetUrl}. */
  readonly assetUrl?: AssetUrlResolver
  /**
   * `data-testid` stamped on the slide `<img>`.
   *
   * The image is the pre-load; naming it lets the runner's tests assert the next slide was
   * fetched *before* the advance rather than inferring it from a screenshot.
   */
  readonly imageTestId?: string
  /** `lg` is the NOW/NEXT hero sizing; `sm` is the inline cue-list sizing. */
  readonly size?: 'sm' | 'lg'
  /** What to say when `cue` is `null`. */
  readonly emptyLabel?: string
  readonly className?: string
}

/** A labelled key/value line. The label is the small muted half. */
function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className="select-text break-words font-medium text-text">{value}</span>
    </p>
  )
}

/** Shown when a payload does not match its cue type — an authoring fault, not a crash. */
function Malformed({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 text-sm text-panic">
      <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </p>
  )
}

export function CuePreview({
  cue,
  assetUrl = defaultAssetUrl,
  imageTestId,
  size = 'lg',
  emptyLabel,
  className,
}: CuePreviewProps): React.JSX.Element {
  const { t } = useTranslation()

  const malformed = t('plan.preview.malformed', {
    defaultValue: 'This cue’s settings do not match its type. Fix it in the plan editor.',
  })

  if (cue === null) {
    return (
      <p
        data-cue-preview="empty"
        className={clsx('text-text-muted', size === 'lg' ? 'text-lg' : 'text-sm', className)}
      >
        {emptyLabel ?? t('plan.preview.empty', { defaultValue: 'Nothing here.' })}
      </p>
    )
  }

  const Icon = CUE_TYPE_ICONS[cue.type]

  const body = ((): React.JSX.Element => {
    switch (cue.type) {
      case 'slide': {
        const parsed = cuePayloadSchemas.slide.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        const url = assetUrl(parsed.data.asset)
        return (
          <div className="flex flex-col gap-2">
            {url === null ? (
              <div
                data-cue-preview="slide-missing"
                className="flex min-h-[6rem] items-center justify-center rounded-glass border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-sm text-text-muted"
              >
                {t('plan.preview.slideUnavailable', {
                  defaultValue: 'Slide image unavailable.',
                })}
              </div>
            ) : (
              // `alt=""` on purpose: the image is decorative *to the assistive-tech user* because
              // the operator's own cue label sits right next to it and carries the meaning. The
              // slide's own text is never read out of the image (Standing Rule 4), so there is no
              // honest alternative text this component could invent.
              <img
                {...(imageTestId === undefined ? {} : { 'data-testid': imageTestId })}
                src={url}
                alt=""
                // Eager + async decode: this thumbnail exists to warm the cache before the
                // operator presses SPACE, so deferring it would defeat the entire point.
                loading="eager"
                decoding="async"
                data-cue-preview="slide-image"
                data-asset={parsed.data.asset}
                className={clsx(
                  'w-full rounded-glass border border-border bg-surface-2 object-contain',
                  size === 'lg' ? 'max-h-64' : 'max-h-24',
                )}
              />
            )}
            <p className="truncate font-mono text-xs text-text-muted">
              {parsed.data.sourceSlide === undefined
                ? parsed.data.asset
                : `#${String(parsed.data.sourceSlide)} · ${parsed.data.asset}`}
            </p>
          </div>
        )
      }

      case 'lowerthird': {
        const parsed = cuePayloadSchemas.lowerthird.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        return (
          <div className="flex flex-col gap-1">
            <p
              data-cue-preview="lowerthird-line1"
              className={clsx('font-semibold text-text', size === 'lg' ? 'text-xl' : 'text-base')}
            >
              {parsed.data.line1}
            </p>
            {parsed.data.line2 === undefined || parsed.data.line2.length === 0 ? null : (
              <p data-cue-preview="lowerthird-line2" className="text-text-muted">
                {parsed.data.line2}
              </p>
            )}
            {parsed.data.template === undefined ? null : (
              <Field
                label={t('plan.preview.template', { defaultValue: 'Template' })}
                value={parsed.data.template}
              />
            )}
          </div>
        )
      }

      case 'scripture': {
        const parsed = cuePayloadSchemas.scripture.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        return (
          <div className="flex flex-col gap-1">
            <p
              data-cue-preview="scripture-reference"
              className={clsx('font-semibold text-text', size === 'lg' ? 'text-xl' : 'text-base')}
            >
              {parsed.data.reference}
              {parsed.data.translation === undefined ? null : (
                <span className="ml-2 font-normal text-text-muted">{parsed.data.translation}</span>
              )}
            </p>
            {/* Verger stores references, never verse text. Saying so here stops an operator
                reading a reference-only preview as a cue that failed to load. */}
            <p className="text-xs text-text-muted">
              {t('plan.preview.scriptureResolved', {
                defaultValue: 'Verse text is fetched when the cue fires.',
              })}
            </p>
          </div>
        )
      }

      case 'scene': {
        const parsed = cuePayloadSchemas.scene.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        return (
          <Field label={t('plan.preview.scene', { defaultValue: 'OBS scene' })} value={parsed.data.scene} />
        )
      }

      case 'media': {
        const parsed = cuePayloadSchemas.media.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        return (
          <div className="flex flex-col gap-1">
            <Field
              label={t('plan.preview.asset', { defaultValue: 'File' })}
              value={parsed.data.asset}
            />
            {parsed.data.obsInputName === undefined ? null : (
              <Field
                label={t('plan.preview.obsInput', { defaultValue: 'OBS input' })}
                value={parsed.data.obsInputName}
              />
            )}
          </div>
        )
      }

      case 'action': {
        const parsed = cuePayloadSchemas.action.safeParse(cue.payload)
        if (!parsed.success) return <Malformed message={malformed} />
        return (
          <Field
            label={t('plan.preview.action', { defaultValue: 'Action' })}
            value={parsed.data.action}
          />
        )
      }
    }
  })()

  return (
    <div
      data-cue-preview="cue"
      data-cue-id={cue.id}
      data-cue-type={cue.type}
      className={clsx('flex flex-col gap-2', className)}
    >
      <p className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="text-xs uppercase tracking-wide text-text-muted">
          {t(`plan.cueType.${cue.type}`, { defaultValue: CUE_TYPE_LABELS[cue.type] })}
        </span>
      </p>
      <p
        data-cue-preview="label"
        className={clsx('break-words font-semibold text-text', size === 'lg' ? 'text-2xl' : 'text-sm')}
      >
        {cue.label}
      </p>
      {body}
      {cue.note === undefined || cue.note.length === 0 ? null : (
        // Operator notes never reach the congregation screen (`src/shared/plan.ts`), so showing
        // them here is safe and is the whole reason they exist.
        <p data-cue-preview="note" className="text-sm italic text-text-muted">
          {cue.note}
        </p>
      )}
    </div>
  )
}
