/**
 * The Service Plan — the authored order of service.
 *
 * BLUEPRINT.md §7. A Service is an ordered list of Cues; each cue has a *trigger* (when it should
 * fire) and a *payload* (what to show). Phase 6 makes this a fully useful MANUAL slide and media
 * driver; Phase 8's cue engine later watches the transcript and drives the same structure.
 *
 * ## Manual first, automation second
 *
 * Every cue defaults to `trigger.mode = 'manual'`. The plan must be completely usable by an
 * operator pressing SPACE with no ASR, no cue engine and no network — because that manual path is
 * the fallback the automation degrades to. Building it first means the hard AI in Phases 7-8
 * lands on top of something already trustworthy.
 *
 * ## No copyrighted text lives here
 *
 * A `scripture` cue carries a REFERENCE, never verse text (Standing Rule 4). The text is resolved
 * at fire time from a licensed API or a verified public-domain source. A `slide` cue points at an
 * image asset — imported slides are treated as opaque images and their text is never read into
 * the model.
 *
 * Node-global free.
 */

import { z } from 'zod'

/** What a cue does when it fires. */
export const CUE_TYPES = ['scene', 'slide', 'media', 'scripture', 'lowerthird', 'action'] as const

/** Union of the cue types. */
export type CueType = (typeof CUE_TYPES)[number]

/**
 * How a cue is triggered.
 *
 * - `manual` — the operator fires it. The default, and the only mode Phase 6 acts on.
 * - `anchor` — fuzzy-match the recent transcript against `text` (Phase 8's plan-follower).
 * - `scripture` — fire when a scripture reference is detected (Phase 8).
 * - `hotphrase` — fire on an exact configured phrase (Phase 8).
 */
export const TRIGGER_MODES = ['manual', 'anchor', 'scripture', 'hotphrase'] as const

/** Union of the trigger modes. */
export type TriggerMode = (typeof TRIGGER_MODES)[number]

/** How a cue is armed. */
export interface CueTrigger {
  readonly mode: TriggerMode
  /** The anchor phrase or hot phrase. Absent for `manual`. */
  readonly text?: string
}

/**
 * Per-cue automation settings — the "trust dial" applied to a single cue.
 *
 * `confirmAlways` wins over any service-level auto mode. That asymmetry is deliberate: a cue may
 * always be made SAFER than the service default, never more dangerous.
 */
export interface CueOptions {
  /** Confidence a match must exceed before this cue may fire itself in auto mode. */
  readonly autoFireThreshold?: number
  /** Never auto-fire this cue, whatever the mode. Use for anything irreversible on screen. */
  readonly confirmAlways?: boolean
}

/** A scene cue: switch OBS to a named scene. */
export interface ScenePayload {
  readonly scene: string
}

/** A slide cue: show an image on the overlay's slide layer. */
export interface SlidePayload {
  /** Path relative to the plan's asset folder. */
  readonly asset: string
  /** 1-based slide number when this came from an imported deck. */
  readonly sourceSlide?: number
}

/** A media cue: play a video/audio source in OBS. */
export interface MediaPayload {
  readonly asset: string
  /** The OBS media input to drive, when the media lives in OBS rather than as a file. */
  readonly obsInputName?: string
}

/**
 * A scripture cue: a REFERENCE ONLY.
 *
 * There is deliberately no `text` field. Verse text is resolved at fire time and never authored,
 * stored or committed (Standing Rule 4).
 */
export interface ScripturePayload {
  readonly reference: string
  /** Preferred translation code, e.g. `KJV`. Resolution falls back when unavailable. */
  readonly translation?: string
}

/** A lower-third cue. */
export interface LowerThirdPayload {
  readonly line1: string
  readonly line2?: string
  readonly template?: string
}

/** An action cue: a named app action, e.g. clearing the overlay. */
export interface ActionPayload {
  readonly action: string
}

/** The payload union, discriminated by the cue's `type`. */
export type CuePayload =
  | ScenePayload
  | SlidePayload
  | MediaPayload
  | ScripturePayload
  | LowerThirdPayload
  | ActionPayload

/** One cue in the service. */
export interface Cue {
  readonly id: string
  readonly type: CueType
  readonly label: string
  readonly trigger: CueTrigger
  readonly payload: CuePayload
  readonly options?: CueOptions
  /** Operator notes. Never shown on the congregation screen. */
  readonly note?: string
}

/** How much autonomy the engine has for a whole service. */
export const SERVICE_MODES = ['assist', 'auto', 'manual'] as const

/** Union of the service modes. `assist` is the default everywhere. */
export type ServiceMode = (typeof SERVICE_MODES)[number]

/** A whole order of service. */
export interface ServicePlan {
  readonly schemaVersion: 1
  /** Human name, e.g. "2026-07-26 Sunday". */
  readonly service: string
  readonly defaultMode: ServiceMode
  readonly cues: readonly Cue[]
  /** Folder holding imported slide images and media, relative to the plan file. */
  readonly assetDir: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const cueTriggerSchema = z.object({
  mode: z.enum(TRIGGER_MODES),
  text: z.string().max(500).optional(),
})

const cueOptionsSchema = z.object({
  autoFireThreshold: z.number().min(0).max(1).optional(),
  confirmAlways: z.boolean().optional(),
})

/**
 * Payload validation, per cue type.
 *
 * Note `scripture` accepts `reference` and NOT `text` — a plan carrying verse text is invalid by
 * construction, so Standing Rule 4 cannot be violated by a hand-edited or imported file.
 */
export const cuePayloadSchemas = {
  scene: z.object({ scene: z.string().min(1).max(200) }),
  slide: z.object({
    asset: z.string().min(1).max(1024),
    sourceSlide: z.number().int().positive().optional(),
  }),
  media: z.object({
    asset: z.string().min(1).max(1024),
    obsInputName: z.string().max(200).optional(),
  }),
  scripture: z.object({
    reference: z.string().min(1).max(120),
    translation: z.string().max(20).optional(),
  }),
  lowerthird: z.object({
    line1: z.string().min(1).max(120),
    line2: z.string().max(120).optional(),
    template: z.string().max(40).optional(),
  }),
  action: z.object({ action: z.string().min(1).max(80) }),
} as const

/** A cue, validated with its payload matched to its type. */
export const cueSchema = z
  .object({
    id: z.string().min(1).max(64),
    type: z.enum(CUE_TYPES),
    label: z.string().min(1).max(200),
    trigger: cueTriggerSchema,
    payload: z.record(z.string(), z.unknown()),
    options: cueOptionsSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((cue, ctx) => {
    const schema = cuePayloadSchemas[cue.type]
    const parsed = schema.safeParse(cue.payload)
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message: `payload does not match cue type "${cue.type}": ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      })
    }
    // A non-manual trigger without text can never match anything — catch it at authoring time
    // rather than leaving a cue that silently never fires during a service.
    if (cue.trigger.mode !== 'manual' && (cue.trigger.text ?? '').trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'text'],
        message: `a "${cue.trigger.mode}" trigger needs text to match against`,
      })
    }
  })

/** A whole plan. */
export const servicePlanSchema = z.object({
  schemaVersion: z.literal(1),
  service: z.string().min(1).max(200),
  defaultMode: z.enum(SERVICE_MODES),
  cues: z.array(cueSchema).max(1000),
  assetDir: z.string().max(1024),
})

/** An empty plan, ready to author. */
export function emptyServicePlan(service: string): ServicePlan {
  return { schemaVersion: 1, service, defaultMode: 'assist', cues: [], assetDir: 'assets' }
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/**
 * Where the operator is in the plan.
 *
 * `index` is -1 before the first cue has fired. Phase 8's plan-follower moves this pointer, but
 * a manual advance moves it too — and a manual move always wins (Standing Rule 1).
 */
export interface PlanPosition {
  readonly index: number
  readonly firedCueIds: readonly string[]
}

/** The starting position. */
export function initialPlanPosition(): PlanPosition {
  return { index: -1, firedCueIds: [] }
}

/** The cue at a position, or `null` when the position is out of range. */
export function cueAt(plan: ServicePlan, index: number): Cue | null {
  return plan.cues[index] ?? null
}

/** The next cue, or `null` at the end of the plan. */
export function nextCue(plan: ServicePlan, position: PlanPosition): Cue | null {
  return cueAt(plan, position.index + 1)
}

/**
 * Advance one cue.
 *
 * Clamps at the end rather than wrapping: running off the end of the plan mid-service must be a
 * no-op, never a jump back to the welcome slide.
 */
export function advance(plan: ServicePlan, position: PlanPosition): PlanPosition {
  const next = Math.min(position.index + 1, plan.cues.length - 1)
  const cue = cueAt(plan, next)
  if (cue === null) return position
  return {
    index: next,
    firedCueIds: position.firedCueIds.includes(cue.id)
      ? position.firedCueIds
      : [...position.firedCueIds, cue.id],
  }
}

/** Step back one cue. Clamps at -1. The one-tap undo for a mis-fire. */
export function stepBack(position: PlanPosition): PlanPosition {
  return { index: Math.max(position.index - 1, -1), firedCueIds: position.firedCueIds }
}
