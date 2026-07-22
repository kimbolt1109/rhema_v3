/**
 * Weekly service templates — save this Sunday's shape, start next Sunday from it.
 *
 * A church service is the same skeleton fifty-two times a year: welcome, notices, two songs, the
 * reading, the sermon, the offering, the blessing. Re-authoring that every Saturday night is how
 * an operator ends up with a half-finished plan at 09:45. A template is that skeleton, saved once
 * and re-dated on demand.
 *
 * ## The asset decision, stated plainly: **templates CLEAR asset references**
 *
 * This is the single design decision in this file that can cost a service, so it is documented
 * rather than assumed.
 *
 * A slide cue's `asset` is a path *relative to the plan's own asset folder*, and
 * `resolveAssetDir()` resolves that folder relative to the plan FILE. Churches keep their plans in
 * one folder — `plans/2026-07-19.json`, `plans/2026-07-26.json` — which means those plans share
 * `plans/assets/`. A template that carried `slides/slide-001.png` through would therefore resolve,
 * silently and successfully, to **last week's rendered deck**. Not a broken image: last week's
 * actual notices, on the congregation screen, looking entirely deliberate.
 *
 * Copying the image files instead was considered and rejected: a term's worth of templates would
 * duplicate hundreds of megabytes of PNGs, this module has no byte-copy seam (its filesystem seam
 * is text-only, on purpose), and a copied deck is still last week's deck — it just fails less
 * visibly.
 *
 * So {@link saveAsTemplate} **strips every asset reference**:
 *
 * - a `slide` cue keeps its id, label, trigger, options and note, and its `asset` becomes
 *   {@link TEMPLATE_PLACEHOLDER_ASSET}; `sourceSlide` is dropped;
 * - a `media` cue's `asset` becomes the same placeholder, but its `obsInputName` is KEPT — an OBS
 *   input name is part of the skeleton, not part of last week's file;
 * - each stripped cue gains {@link TEMPLATE_ASSET_CLEARED_NOTE} in its operator note, so the cue
 *   announces what it needs instead of quietly pointing at nothing;
 * - `assetDir` is reset to the default.
 *
 * The cue survives because the *slot* is the valuable part — "SLIDE 1 goes here, third in the
 * order" — and a plan that lost its slide rows would not be a skeleton at all.
 *
 * ## Everything else
 *
 * - Templates live one JSON file per template under a caller-supplied directory (production:
 *   `<userData>/templates`, via {@link templatesDirectory}). Nothing here imports Electron, at
 *   module scope or anywhere else.
 * - Every load runs `servicePlanSchema` through `validatePlanDocument()`, so a hand-edited or
 *   half-written template is refused with a message that names the offending cue.
 * - Every save is a temp write followed by a rename, so a crash mid-save cannot destroy the
 *   template it was replacing.
 * - All I/O goes through {@link TemplateFileSystem}, which is `PlanFileSystem` plus one directory
 *   listing. The whole module is driven in tests by an in-memory fake.
 * - Nothing throws: every seam call is wrapped and every failure becomes a {@link Result}.
 */

import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'

import { z } from 'zod'

import { emptyServicePlan } from '@shared/plan'
import type { Cue, CuePayload, ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

import { MAX_PLAN_FILE_BYTES, validatePlanDocument } from './planFile'
import type { PlanFileSystem } from './planFile'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The filesystem surface a template store needs.
 *
 * `PlanFileSystem` plus one method. Deliberately text-only and synchronous, exactly like the plan
 * file's seam — and the absence of a byte-copy method is load-bearing rather than an oversight, as
 * the module docblock explains.
 */
export interface TemplateFileSystem extends PlanFileSystem {
  /**
   * The entry names directly inside a directory — names, not paths.
   *
   * May throw for a missing directory; callers check {@link PlanFileSystem.exists} first and wrap
   * the call regardless.
   */
  listDir(directory: string): readonly string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The on-disk envelope version. Bumped only by a migration, never for feature detection. */
export const TEMPLATE_FILE_VERSION = 1

/** Templates are `<id>.json`. */
export const TEMPLATE_FILE_EXTENSION = '.json'

/** The folder templates live in, under `userData`. */
export const TEMPLATES_DIRECTORY_NAME = 'templates'

/** Suffix for the temp file an atomic save writes through. */
export const TEMPLATE_TEMP_SUFFIX = '.tmp'

/** The token {@link expandServiceName} substitutes. Same convention as the broadcast template. */
export const SERVICE_DATE_TOKEN = '{date}'

/**
 * What a stripped `slide` / `media` cue points at.
 *
 * Deliberately a path that means something to a human reading the plan file, and deliberately one
 * that cannot resolve to a real image. See the module docblock for why this is not last week's
 * filename.
 */
export const TEMPLATE_PLACEHOLDER_ASSET = 'unassigned/needs-reimport'

/** Appended to the operator note of every cue whose asset reference was cleared. */
export const TEMPLATE_ASSET_CLEARED_NOTE =
  'Asset cleared by the weekly template — import this week’s deck before the service.'

/** `note` is capped at 2000 characters by `cueSchema`; the append respects that. */
const MAX_CUE_NOTE_LENGTH = 2000

/** `service` is capped at 200 characters by `servicePlanSchema`. */
const MAX_SERVICE_NAME_LENGTH = 200

/** Longest base name kept when deriving a name template, leaving room for the expanded date. */
const MAX_SERVICE_NAME_BASE_LENGTH = 180

/** The most templates a listing will read in one pass. A folder is not a database. */
export const MAX_TEMPLATES = 500

/**
 * The shape of a template id, which is also the shape of its filename stem.
 *
 * Lowercase alphanumerics and hyphens only, so an id can never contain a path separator, a drive
 * letter, a `..`, or a NUL. Containment is therefore a property of the pattern rather than of a
 * check somebody has to remember to run.
 */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/

/**
 * A date-like run inside a service name, e.g. `2026-07-26`, `2026/7/5`, `2026.07.26`.
 *
 * Used only to find the part of last week's name that should become {@link SERVICE_DATE_TOKEN}.
 */
export const SERVICE_DATE_PATTERN = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A saved template, as it exists on disk and in memory. */
export interface ServiceTemplate {
  readonly templateVersion: typeof TEMPLATE_FILE_VERSION
  /** Filename stem; matches {@link TEMPLATE_ID_PATTERN}. */
  readonly id: string
  /** What the operator called it, e.g. "Sunday morning". */
  readonly name: string
  /** The service name with its date replaced by {@link SERVICE_DATE_TOKEN}. */
  readonly serviceNameTemplate: string
  /** Epoch ms the template was saved. */
  readonly createdAt: number
  /** How many cues had an asset reference cleared when this template was saved. */
  readonly clearedAssets: number
  /** The cue skeleton. Carries no asset references — see the module docblock. */
  readonly plan: ServicePlan
}

/** What a picker needs, without reading every cue of every template. */
export interface ServiceTemplateSummary {
  readonly id: string
  readonly name: string
  readonly serviceNameTemplate: string
  readonly createdAt: number
  readonly cues: number
  readonly clearedAssets: number
}

/**
 * The result of a listing.
 *
 * `unreadable` names the files that failed to parse or validate. They are reported rather than
 * thrown, because one corrupt template must never hide the other nine on a Sunday morning.
 */
export interface TemplateListing {
  readonly templates: readonly ServiceTemplateSummary[]
  readonly unreadable: readonly string[]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The envelope schema.
 *
 * `plan` is `unknown` here on purpose: it is handed to `validatePlanDocument()` — the same
 * `servicePlanSchema` path the plan loader uses — so a bad template produces the same
 * cue-naming error message an operator already knows how to read.
 */
const templateEnvelopeSchema = z.object({
  templateVersion: z.literal(TEMPLATE_FILE_VERSION),
  id: z.string().regex(TEMPLATE_ID_PATTERN),
  name: z.string().min(1).max(120),
  serviceNameTemplate: z.string().min(1).max(MAX_SERVICE_NAME_LENGTH),
  createdAt: z.number().int().nonnegative(),
  clearedAssets: z.number().int().nonnegative(),
  plan: z.unknown(),
})

/** Validate a parsed document as a {@link ServiceTemplate}. */
export function validateTemplateDocument(document: unknown): Result<ServiceTemplate> {
  const envelope = templateEnvelopeSchema.safeParse(document)
  if (!envelope.success) {
    return err(
      ErrorCode.INVALID_ARG,
      'that file is not a Verger service template',
      envelope.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
    )
  }

  const plan = validatePlanDocument(envelope.data.plan)
  if (!plan.ok) return plan

  return ok({
    templateVersion: TEMPLATE_FILE_VERSION,
    id: envelope.data.id,
    name: envelope.data.name,
    serviceNameTemplate: envelope.data.serviceNameTemplate,
    createdAt: envelope.data.createdAt,
    clearedAssets: envelope.data.clearedAssets,
    plan: plan.value,
  })
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `<userData>/templates`. Resolved by the caller — this module never asks Electron for it. */
export function templatesDirectory(userDataPath: string): string {
  return join(userDataPath, TEMPLATES_DIRECTORY_NAME)
}

/**
 * A filename-safe stem from an operator-supplied name.
 *
 * A Korean or emoji-only name reduces to nothing, which is why there is a fallback rather than an
 * error: the operator's *name* is preserved verbatim in the envelope, and the id is only ever a
 * filename.
 */
export function slugifyTemplateName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? 'template' : slug
}

/**
 * Derive the re-datable service name.
 *
 * Three cases, in order: a name that already carries the token is kept as-is; a name with a
 * date-like run has that run replaced; anything else gets the token appended. The last case is
 * what stops every service created from a template being called the same thing.
 */
export function deriveServiceNameTemplate(service: string): string {
  const trimmed = service.trim().slice(0, MAX_SERVICE_NAME_BASE_LENGTH).trim()
  if (trimmed === '') return SERVICE_DATE_TOKEN
  if (trimmed.includes(SERVICE_DATE_TOKEN)) return trimmed
  if (SERVICE_DATE_PATTERN.test(trimmed)) {
    return trimmed.replace(SERVICE_DATE_PATTERN, SERVICE_DATE_TOKEN)
  }
  return `${trimmed} — ${SERVICE_DATE_TOKEN}`
}

/**
 * Expand {@link SERVICE_DATE_TOKEN}.
 *
 * `en-CA` is not a localisation choice, it is a *format* choice: it yields `YYYY-MM-DD`, which
 * sorts correctly in a file listing. The operator-facing service name is theirs to edit afterwards.
 */
export function expandServiceName(template: string, date: Date, locale = 'en-CA'): string {
  const formatted = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return template.replaceAll(SERVICE_DATE_TOKEN, formatted)
}

// ---------------------------------------------------------------------------
// The asset decision
// ---------------------------------------------------------------------------

/** Whether a cue type carries a path to a file inside the plan's asset folder. */
export function carriesAsset(cue: Cue): boolean {
  return cue.type === 'slide' || cue.type === 'media'
}

/** Whether this cue's asset reference has been cleared. Used by the UI and by the tests. */
export function hasClearedAsset(cue: Cue): boolean {
  if (!carriesAsset(cue)) return false
  const asset: unknown = (cue.payload as { asset?: unknown }).asset
  return asset === TEMPLATE_PLACEHOLDER_ASSET
}

/** Append the marker to an operator note without ever exceeding the schema's cap. */
function noteWithMarker(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === '') return TEMPLATE_ASSET_CLEARED_NOTE
  if (existing.includes(TEMPLATE_ASSET_CLEARED_NOTE)) return existing
  const joined = `${existing}\n${TEMPLATE_ASSET_CLEARED_NOTE}`
  // A note already near the cap loses its tail rather than the warning: the warning is the part
  // that stops last week's deck reaching the congregation screen.
  return joined.length <= MAX_CUE_NOTE_LENGTH ? joined : TEMPLATE_ASSET_CLEARED_NOTE
}

/**
 * Rebuild a cue with no asset reference.
 *
 * Built field by field rather than by spreading, because `exactOptionalPropertyTypes` makes
 * `{ ...cue, note: undefined }` a type error and because being explicit here documents exactly
 * what survives into next week.
 */
function stripCueAsset(cue: Cue): Cue {
  const payload: CuePayload =
    cue.type === 'media'
      ? mediaPayloadWithoutAsset(cue.payload)
      : { asset: TEMPLATE_PLACEHOLDER_ASSET }

  const base = {
    id: cue.id,
    type: cue.type,
    label: cue.label,
    trigger: cue.trigger,
    payload,
  }
  const withOptions = cue.options === undefined ? base : { ...base, options: cue.options }
  return { ...withOptions, note: noteWithMarker(cue.note) }
}

/** The OBS input name is skeleton, not last week's file — it is the one thing kept. */
function mediaPayloadWithoutAsset(payload: CuePayload): CuePayload {
  const inputName: unknown = (payload as { obsInputName?: unknown }).obsInputName
  return typeof inputName === 'string' && inputName.trim() !== ''
    ? { asset: TEMPLATE_PLACEHOLDER_ASSET, obsInputName: inputName }
    : { asset: TEMPLATE_PLACEHOLDER_ASSET }
}

/**
 * Clone the cue skeleton, clearing every asset reference.
 *
 * Cue **ids are preserved**. They are only meaningful inside one plan, and keeping them means the
 * operator's configured hot phrases — which bind to a `cueId` — still point at the right cue in
 * next week's service instead of quietly firing nothing.
 */
export function cloneCueSkeleton(cues: readonly Cue[]): {
  readonly cues: readonly Cue[]
  readonly cleared: number
} {
  let cleared = 0
  const next = cues.map((cue) => {
    if (!carriesAsset(cue)) return cue
    cleared += 1
    return stripCueAsset(cue)
  })
  return { cues: next, cleared }
}

/**
 * Turn a plan into a template's plan: cue skeleton, no assets, default asset folder.
 *
 * Exported because "the asset-reference decision" is a contract, and a contract deserves to be
 * assertable without going through the filesystem.
 */
export function toTemplatePlan(plan: ServicePlan): {
  readonly plan: ServicePlan
  readonly cleared: number
} {
  const skeleton = cloneCueSkeleton(plan.cues)
  return {
    plan: {
      schemaVersion: 1,
      service: plan.service,
      defaultMode: plan.defaultMode,
      cues: skeleton.cues,
      // Reset rather than carried: a template belongs to no folder, and inheriting a previous
      // plan's `assetDir` is the same class of mistake as inheriting its slides.
      assetDir: emptyServicePlan('').assetDir,
    },
    cleared: skeleton.cleared,
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The absolute file for a template id, refusing anything that is not a bare id. */
export function templateFilePath(directory: string, id: string): Result<string> {
  const trimmed = id.trim()
  if (trimmed === '') return err(ErrorCode.INVALID_ARG, 'no template was named')
  if (!TEMPLATE_ID_PATTERN.test(trimmed)) {
    return err(
      ErrorCode.INVALID_ARG,
      'that is not a valid template id',
      `refused ${JSON.stringify(id)} — ids are lowercase letters, digits and hyphens`
    )
  }
  return ok(join(resolvePath(directory), `${trimmed}${TEMPLATE_FILE_EXTENSION}`))
}

/** The id a template filename denotes, or `null` when the file is not a template. */
export function templateIdFromFileName(fileName: string): string | null {
  if (extname(fileName).toLowerCase() !== TEMPLATE_FILE_EXTENSION) return null
  const stem = basename(fileName, extname(fileName))
  return TEMPLATE_ID_PATTERN.test(stem) ? stem : null
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Overrides for {@link saveAsTemplate}. Every field has a production default. */
export interface SaveTemplateOptions {
  /** Epoch-ms clock, injected so ids and `createdAt` are deterministic in tests. */
  readonly now?: () => number
  /** Override the derived name template, e.g. from a settings field. */
  readonly serviceNameTemplate?: string
}

/**
 * Save a plan as a reusable template.
 *
 * The plan is validated first, the cue skeleton is cloned with every asset reference cleared, and
 * the envelope is written through a temp file and renamed over the target. A crash at any point
 * leaves either the previous template or no template — never a half-written one.
 */
export function saveAsTemplate(
  fs: TemplateFileSystem,
  directory: string,
  plan: ServicePlan,
  name: string,
  options: SaveTemplateOptions = {}
): Result<ServiceTemplate> {
  const trimmedName = name.trim()
  if (trimmedName === '') return err(ErrorCode.INVALID_ARG, 'give the template a name')
  if (trimmedName.length > 120) {
    return err(ErrorCode.INVALID_ARG, 'that template name is too long', `${trimmedName.length} characters`)
  }

  const validated = validatePlanDocument(plan)
  if (!validated.ok) return validated

  const now = options.now ?? Date.now
  const stripped = toTemplatePlan(validated.value)

  // Validated a second time, after stripping: the placeholder asset and the appended note both
  // have to satisfy `cueSchema`, and finding out here beats finding out next Sunday.
  const revalidated = validatePlanDocument(stripped.plan)
  if (!revalidated.ok) return revalidated

  const id = allocateTemplateId(fs, directory, trimmedName, now())
  if (!id.ok) return id

  const target = templateFilePath(directory, id.value)
  if (!target.ok) return target

  const supplied = (options.serviceNameTemplate ?? '').trim()
  const template: ServiceTemplate = {
    templateVersion: TEMPLATE_FILE_VERSION,
    id: id.value,
    name: trimmedName,
    serviceNameTemplate:
      supplied === ''
        ? deriveServiceNameTemplate(validated.value.service)
        : supplied.slice(0, MAX_SERVICE_NAME_LENGTH),
    createdAt: now(),
    clearedAssets: stripped.cleared,
    plan: revalidated.value,
  }

  const written = writeTemplateFile(fs, target.value, template)
  if (!written.ok) return written
  return ok(template)
}

/** Write one envelope atomically. Temp file, then rename — the only observable step. */
function writeTemplateFile(
  fs: TemplateFileSystem,
  path: string,
  template: ServiceTemplate
): Result<string> {
  const contents = `${JSON.stringify(template, null, 2)}\n`
  const temporary = `${path}${TEMPLATE_TEMP_SUFFIX}`

  const made = attempt(() => fs.mkdirp(dirname(path)), 'the templates folder could not be created')
  if (!made.ok) return made

  const write = attempt(() => fs.writeText(temporary, contents), 'the template could not be written')
  if (!write.ok) {
    discard(fs, temporary)
    return write
  }

  const renamed = attempt(() => fs.rename(temporary, path), 'the template could not be moved into place')
  if (!renamed.ok) {
    // The previous template is exactly as it was; only the temp file is wasted.
    discard(fs, temporary)
    return renamed
  }
  return ok(path)
}

/** A free id for a new template. Suffixes on collision rather than overwriting a saved template. */
function allocateTemplateId(
  fs: TemplateFileSystem,
  directory: string,
  name: string,
  now: number
): Result<string> {
  const stem = `${slugifyTemplateName(name)}-${now.toString(36)}`
  for (let attemptNumber = 0; attemptNumber < 100; attemptNumber += 1) {
    const candidate = attemptNumber === 0 ? stem : `${stem}-${String(attemptNumber + 1)}`
    const path = templateFilePath(directory, candidate)
    if (!path.ok) return path
    const exists = attempt(() => fs.exists(path.value), 'the templates folder could not be read')
    if (!exists.ok) return exists
    if (!exists.value) return ok(candidate)
  }
  return err(ErrorCode.IO_ERROR, 'could not find a free name for this template')
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Every readable template in the folder, newest first.
 *
 * A missing folder is an empty list, not an error: no template saved yet is the ordinary first-run
 * state. A file that fails to parse or validate is reported in `unreadable` and skipped.
 */
export function listTemplates(fs: TemplateFileSystem, directory: string): Result<TemplateListing> {
  const root = resolvePath(directory)

  const exists = attempt(() => fs.exists(root), 'the templates folder could not be checked')
  if (!exists.ok) return exists
  if (!exists.value) return ok({ templates: [], unreadable: [] })

  const entries = attempt(() => fs.listDir(root), 'the templates folder could not be read')
  if (!entries.ok) return entries

  const templates: ServiceTemplateSummary[] = []
  const unreadable: string[] = []

  for (const entry of entries.value.slice(0, MAX_TEMPLATES)) {
    const id = templateIdFromFileName(entry)
    if (id === null) continue
    const loaded = readTemplate(fs, root, id)
    if (!loaded.ok) {
      unreadable.push(entry)
      continue
    }
    templates.push({
      id: loaded.value.id,
      name: loaded.value.name,
      serviceNameTemplate: loaded.value.serviceNameTemplate,
      createdAt: loaded.value.createdAt,
      cues: loaded.value.plan.cues.length,
      clearedAssets: loaded.value.clearedAssets,
    })
  }

  templates.sort((left, right) =>
    right.createdAt === left.createdAt
      ? left.name.localeCompare(right.name)
      : right.createdAt - left.createdAt
  )
  return ok({ templates, unreadable })
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read, parse and validate one template. Every failure leaves nothing loaded. */
export function readTemplate(
  fs: TemplateFileSystem,
  directory: string,
  id: string
): Result<ServiceTemplate> {
  const path = templateFilePath(directory, id)
  if (!path.ok) return path

  const exists = attempt(() => fs.exists(path.value), 'the template could not be checked')
  if (!exists.ok) return exists
  if (!exists.value) return err(ErrorCode.NOT_FOUND, 'there is no template with that id', id)

  const size = attempt(() => fs.size(path.value), 'the template size could not be read')
  if (!size.ok) return size
  if (size.value > MAX_PLAN_FILE_BYTES) {
    return err(
      ErrorCode.INVALID_ARG,
      'that file is far too large to be a service template',
      `${String(size.value)} bytes exceeds the ${String(MAX_PLAN_FILE_BYTES)}-byte limit`
    )
  }

  const raw = attempt(() => fs.readText(path.value), 'the template could not be read')
  if (!raw.ok) return raw

  let document: unknown
  try {
    document = JSON.parse(raw.value)
  } catch (cause) {
    return err(
      ErrorCode.INVALID_ARG,
      'the template file is not valid JSON',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  return validateTemplateDocument(document)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Start a new service from a template.
 *
 * Clones the cue skeleton — which, by construction, already carries no asset references — and
 * re-templates the service name for `date`. The returned plan has never been saved: the caller
 * chooses where it lives, and only then does its (empty) asset folder exist.
 */
export function newServiceFromTemplate(
  fs: TemplateFileSystem,
  directory: string,
  id: string,
  date: Date,
  locale = 'en-CA'
): Result<ServicePlan> {
  if (Number.isNaN(date.getTime())) {
    return err(ErrorCode.INVALID_ARG, 'that is not a valid service date')
  }

  const template = readTemplate(fs, directory, id)
  if (!template.ok) return template

  const skeleton = cloneCueSkeleton(template.value.plan.cues)
  const service = expandServiceName(template.value.serviceNameTemplate, date, locale)

  const plan: ServicePlan = {
    schemaVersion: 1,
    service: service.slice(0, MAX_SERVICE_NAME_LENGTH),
    defaultMode: template.value.plan.defaultMode,
    cues: skeleton.cues,
    assetDir: template.value.plan.assetDir,
  }

  // Validated on the way out as well as on the way in: a template written by a future build, or
  // hand-edited to the edge of the schema, must not become a plan the operator cannot save.
  return validatePlanDocument(plan)
}

// ---------------------------------------------------------------------------
// The bound store
// ---------------------------------------------------------------------------

/** Constructor dependencies for {@link createTemplateStore}. */
export interface TemplateStoreOptions {
  readonly fs: TemplateFileSystem
  /** Absolute folder templates live in. Production passes {@link templatesDirectory}. */
  readonly directory: string
  /** Epoch-ms clock, injected so ids and `createdAt` are deterministic in tests. */
  readonly now?: () => number
  /** Locale used to format the substituted date. `en-CA` yields a sortable `YYYY-MM-DD`. */
  readonly locale?: string
}

/**
 * The three verbs, bound to one folder and one filesystem.
 *
 * This is the shape the rest of the app uses; the free functions above exist so each step can be
 * asserted on its own.
 */
export interface TemplateStore {
  saveAsTemplate(plan: ServicePlan, name: string): Result<ServiceTemplate>
  listTemplates(): Result<TemplateListing>
  newServiceFromTemplate(id: string, date: Date): Result<ServicePlan>
}

/** Bind the template verbs to a filesystem and a folder. Performs no I/O. */
export function createTemplateStore(options: TemplateStoreOptions): TemplateStore {
  const { fs, directory } = options
  const now = options.now ?? Date.now
  const locale = options.locale ?? 'en-CA'

  return {
    saveAsTemplate: (plan, name) => saveAsTemplate(fs, directory, plan, name, { now }),
    listTemplates: () => listTemplates(fs, directory),
    newServiceFromTemplate: (id, date) => newServiceFromTemplate(fs, directory, id, date, locale),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Best-effort temp cleanup. A failure here is genuinely uninteresting and never surfaces. */
function discard(fs: TemplateFileSystem, path: string): void {
  try {
    fs.remove(path)
  } catch {
    /* the temp file may not exist, or may be locked — either way there is nothing to do */
  }
}

/** Run a seam call, converting anything it throws into an `IO_ERROR`. */
function attempt<T>(operation: () => T, fallback: string): Result<T> {
  try {
    return ok(operation())
  } catch (cause) {
    const error = toAppError(cause, ErrorCode.IO_ERROR)
    return { ok: false, error: { ...error, message: `${fallback}: ${error.message}` } }
  }
}
