/**
 * Reading and writing a service plan as JSON — the operator's Sunday, on disk.
 *
 * Three properties matter more than anything else in this file, and each one is a Sunday-morning
 * failure that has to be impossible rather than unlikely:
 *
 * ## 1. A plan is validated on LOAD, and a bad plan is refused whole
 *
 * `servicePlanSchema` runs against the parsed document before a single cue reaches the service.
 * A hand-edited file, a plan from a different (or newer) build, or a truncated write produces an
 * `Err(INVALID_ARG)` that NAMES the offending cue — its index, its label and its id — and nothing
 * is loaded. The alternative, a half-loaded plan that fails on cue 23 in the middle of the
 * service, is the thing this refuses to do.
 *
 * ## 2. A save cannot destroy the plan it is replacing
 *
 * Every save is written to a sibling temp file and then renamed over the target. A crash, a power
 * cut or a full disk mid-write leaves the previous plan intact; `rename` is the only step that
 * can be observed by a reader, and it is atomic on both NTFS and POSIX filesystems.
 *
 * ## 3. Assets never escape the plan's folder
 *
 * `assetDir` is resolved RELATIVE TO THE PLAN FILE, and every asset path is resolved relative to
 * that folder and then proved to still be inside it. Assets arrive from imported PowerPoint decks
 * — arbitrary files a stranger may have produced — so `../../../Windows/System32/…`,
 * `C:\Users\…`, `/etc/passwd` and `\\server\share\…` are all rejected by construction, not by
 * hoping the importer sanitised them.
 *
 * ## Seams
 *
 * All I/O goes through {@link PlanFileSystem}, a seven-method structural interface, so this file
 * touches neither `node:fs` nor Electron and the whole thing is driven in tests by an in-memory
 * fake. Only `node:path` and `node:url` are imported, and only for their pure functions.
 *
 * Nothing here throws: every seam call is wrapped and every failure becomes a {@link Result}.
 */

import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { servicePlanSchema } from '@shared/plan'
import type { ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The filesystem surface a plan needs.
 *
 * Deliberately tiny and synchronous. A plan is a few hundred kilobytes of JSON on local disk;
 * making this async would buy nothing and would put an `await` between the temp write and the
 * rename, which is exactly the window the atomic save exists to close.
 */
export interface PlanFileSystem {
  /**
   * Size of a file in bytes.
   *
   * Read BEFORE the file is opened, so an absurd file is refused rather than pulled into the
   * main process's heap. A plan file is untrusted input like any other.
   */
  size(path: string): number
  readText(path: string): string
  writeText(path: string, contents: string): void
  /** Replace `to` with `from`. Must overwrite an existing destination. */
  rename(from: string, to: string): void
  /** Create a directory and its parents. A directory that already exists is not an error. */
  mkdirp(directory: string): void
  exists(path: string): boolean
  /** Best-effort delete, used to clear a temp file after a failed save. Never fatal. */
  remove(path: string): void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only schema version that exists. The migration seam below is keyed on it. */
export const CURRENT_PLAN_SCHEMA_VERSION = 1

/**
 * The largest plan file this will read.
 *
 * `servicePlanSchema` caps a plan at 1000 cues and every string field is length-bounded, so a
 * legitimate plan is well under a megabyte. Eight megabytes is a generous ceiling that still
 * refuses to hand `JSON.parse` a multi-gigabyte file dropped in the plans folder.
 */
export const MAX_PLAN_FILE_BYTES = 8 * 1024 * 1024

/** Suffix for the temp file an atomic save writes through. */
export const PLAN_TEMP_SUFFIX = '.tmp'

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A plan and the absolute path it came from. */
export interface LoadedPlan {
  readonly plan: ServicePlan
  /** Absolute, resolved. The service saves back here unless told otherwise. */
  readonly path: string
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Whether a path fragment tries to leave the folder it is supposed to be relative to.
 *
 * Rejects, before any resolution: an empty fragment, an embedded NUL, a POSIX-absolute path, a
 * Windows drive-qualified path, and a UNC path. Those are the four ways "relative" input arrives
 * absolute, and `path.isAbsolute` alone only catches the ones for the platform it is running on —
 * which is not good enough for a file authored on someone else's machine.
 */
export function isEscapingFragment(fragment: string): boolean {
  if (fragment.includes('\0')) return true
  if (fragment.startsWith('/') || fragment.startsWith('\\')) return true
  if (/^[a-zA-Z]:/.test(fragment)) return true
  if (isAbsolute(fragment)) return true
  return false
}

/**
 * Resolve `fragment` inside `baseDir`, proving the result is still inside it.
 *
 * The proof is `path.relative`: if the resolved path is genuinely under the base, the relative
 * path from base to it is a plain forward reference. Anything that starts with `..` or that comes
 * back absolute (a different drive, for instance) escaped, and is refused.
 *
 * `allowSelf` permits the fragment to denote the base directory itself, which is meaningful for
 * `assetDir` (`""` or `"."` means "assets live next to the plan file") and meaningless for an
 * asset (a directory is not a slide).
 */
export function containWithin(
  baseDir: string,
  fragment: string,
  options: { readonly allowSelf?: boolean; readonly label?: string } = {}
): Result<string> {
  const label = options.label ?? 'path'
  const allowSelf = options.allowSelf ?? false
  const trimmed = fragment.trim()

  if (trimmed === '' && !allowSelf) {
    return err(ErrorCode.INVALID_ARG, `the ${label} is empty`)
  }
  if (isEscapingFragment(trimmed)) {
    return err(
      ErrorCode.INVALID_ARG,
      `the ${label} must stay inside the plan folder`,
      `refused "${fragment}" — absolute and UNC paths are not allowed`
    )
  }

  const base = resolvePath(baseDir)
  const full = resolvePath(base, trimmed)
  const rel = relative(base, full)

  if (rel === '') {
    if (allowSelf) return ok(full)
    return err(ErrorCode.INVALID_ARG, `the ${label} resolves to the folder itself`, fragment)
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return err(
      ErrorCode.INVALID_ARG,
      `the ${label} must stay inside the plan folder`,
      `refused "${fragment}" — it resolves outside "${base}"`
    )
  }
  return ok(full)
}

/**
 * The absolute asset folder for a plan.
 *
 * Relative to the PLAN FILE, always — a plan and its imported slides move together as one folder,
 * and an operator who copies that folder onto the booth machine must not have to re-import.
 */
export function resolveAssetDir(planPath: string, plan: ServicePlan): Result<string> {
  const planDir = dirname(resolvePath(planPath))
  return containWithin(planDir, plan.assetDir, { allowSelf: true, label: 'asset folder' })
}

/**
 * The absolute on-disk path of one asset.
 *
 * Two containment checks, not one: the asset folder must be inside the plan folder, and the asset
 * must be inside the asset folder. A deck importer that got a slide filename from a hostile file
 * cannot reach outside either.
 */
export function resolveAssetPath(
  planPath: string,
  plan: ServicePlan,
  asset: string
): Result<string> {
  const assetDir = resolveAssetDir(planPath, plan)
  if (!assetDir.ok) return assetDir
  return containWithin(assetDir.value, asset, { label: 'asset path' })
}

/**
 * A URL the overlay page can load for a local asset.
 *
 * `pathToFileURL` handles drive letters, UNC prefixes and percent-encoding correctly, which
 * hand-rolled string concatenation does not (a slide called `my slide #2.png` is the usual way
 * that discovery happens).
 */
export function assetFileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * The migration seam, keyed on `schemaVersion`.
 *
 * Only version 1 exists, so today this is an identity function with a guard on either side. It is
 * here rather than added later because the alternative — discovering at version 2 that a year of
 * plans have no upgrade path — is a data-loss bug, and because a plan written by a NEWER Verger
 * must be refused with an explanation rather than silently half-understood.
 *
 * When version 2 lands: add a `case 1:` that returns the upgraded document and fall through.
 */
export function migratePlanDocument(document: unknown): Result<unknown> {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return err(ErrorCode.INVALID_ARG, 'the plan file does not contain a JSON object')
  }

  const version: unknown = (document as { schemaVersion?: unknown }).schemaVersion
  if (version === undefined) {
    return err(
      ErrorCode.INVALID_ARG,
      'the plan file has no schemaVersion',
      'this does not look like a Verger service plan'
    )
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return err(ErrorCode.INVALID_ARG, 'the plan file has a non-numeric schemaVersion', String(version))
  }
  if (version > CURRENT_PLAN_SCHEMA_VERSION) {
    return err(
      ErrorCode.INVALID_ARG,
      `this plan was written by a newer version of Verger (schemaVersion ${version})`,
      `this build understands up to schemaVersion ${CURRENT_PLAN_SCHEMA_VERSION}`
    )
  }
  if (version < CURRENT_PLAN_SCHEMA_VERSION) {
    return err(
      ErrorCode.INVALID_ARG,
      `plan schemaVersion ${version} is not supported`,
      `this build understands schemaVersion ${CURRENT_PLAN_SCHEMA_VERSION}`
    )
  }
  return ok(document)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The structural slice of a zod issue this module reads. Avoids pinning a zod internal type. */
interface PlanIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/**
 * Turn validation issues into something an operator can act on at 09:50 on a Sunday.
 *
 * The important part is naming the CUE: `cues.7.payload` on its own tells the operator nothing,
 * whereas `cue 8 ("PLACEHOLDER TITLE", id "cue-h2i")` points straight at the row to fix. Labels
 * and ids are echoed from the raw document, so a cue that failed *because* its label is missing
 * still gets identified by index.
 */
export function describePlanIssues(issues: readonly PlanIssue[], document: unknown): string {
  const cues = readRawCues(document)

  return issues
    .map((issue) => {
      const segments = issue.path.map((part) => String(part))
      const [head, index] = segments
      if (head === 'cues' && index !== undefined && /^\d+$/.test(index)) {
        const position = Number(index)
        const raw = cues[position]
        const rest = segments.slice(2).join('.')
        const where = rest === '' ? '' : ` at ${rest}`
        return `${describeCue(position, raw)}${where}: ${issue.message}`
      }
      const at = segments.join('.')
      return `${at === '' ? '(root)' : at}: ${issue.message}`
    })
    .join('; ')
}

function describeCue(position: number, raw: unknown): string {
  const label = readStringField(raw, 'label')
  const id = readStringField(raw, 'id')
  const parts: string[] = []
  if (label !== null) parts.push(JSON.stringify(label))
  if (id !== null) parts.push(`id ${JSON.stringify(id)}`)
  // `position` is zero-based in the data and one-based for a human — the operator counts rows.
  const suffix = parts.length === 0 ? '' : ` (${parts.join(', ')})`
  return `cue ${position + 1}${suffix}`
}

function readRawCues(document: unknown): readonly unknown[] {
  if (typeof document !== 'object' || document === null) return []
  const cues: unknown = (document as { cues?: unknown }).cues
  return Array.isArray(cues) ? cues : []
}

function readStringField(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null
  const value: unknown = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Validate a document as a {@link ServicePlan}.
 *
 * Used on load AND before every save. Validating on save is not belt-and-braces: it is what keeps
 * a plan that was mutated in memory by a bug from being written over the operator's good file.
 */
export function validatePlanDocument(document: unknown): Result<ServicePlan> {
  const parsed = servicePlanSchema.safeParse(document)
  if (!parsed.success) {
    return err(
      ErrorCode.INVALID_ARG,
      'the service plan is not valid',
      describePlanIssues(parsed.error.issues, document)
    )
  }
  // `parsed.data` is a structural clone with defaults applied; the cast narrows the payload
  // record onto the discriminated `CuePayload` union that `cueSchema` has already proved.
  return ok(parsed.data as unknown as ServicePlan)
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read, migrate and validate a plan.
 *
 * Every failure is an `Err` and leaves NOTHING loaded — there is no partial success here by
 * design. The order is size → read → parse → migrate → validate → asset containment, so the
 * cheapest and most dangerous check runs first.
 */
export function loadPlanFile(fs: PlanFileSystem, filePath: string): Result<LoadedPlan> {
  const path = resolvePath(filePath)

  const exists = attempt(() => fs.exists(path), 'the plan file could not be checked')
  if (!exists.ok) return exists
  if (!exists.value) {
    return err(ErrorCode.NOT_FOUND, 'there is no plan file at that path', path)
  }

  const size = attempt(() => fs.size(path), 'the plan file size could not be read')
  if (!size.ok) return size
  if (size.value > MAX_PLAN_FILE_BYTES) {
    return err(
      ErrorCode.INVALID_ARG,
      'that file is far too large to be a service plan',
      `${size.value} bytes exceeds the ${MAX_PLAN_FILE_BYTES}-byte limit`
    )
  }

  const raw = attempt(() => fs.readText(path), 'the plan file could not be read')
  if (!raw.ok) return raw

  let document: unknown
  try {
    document = JSON.parse(raw.value)
  } catch (cause) {
    return err(
      ErrorCode.INVALID_ARG,
      'the plan file is not valid JSON',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  const migrated = migratePlanDocument(document)
  if (!migrated.ok) return migrated

  const validated = validatePlanDocument(migrated.value)
  if (!validated.ok) return validated

  const plan = validated.value
  const assetDir = resolveAssetDir(path, plan)
  if (!assetDir.ok) return assetDir

  return ok({ plan, path })
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Write a plan atomically.
 *
 * Temp file, then rename. The operator's existing plan is only ever replaced by a file that has
 * already been written in full, so the worst case of a crash mid-save is an orphaned `.tmp`
 * beside the plan — never a truncated plan.
 *
 * The plan is validated first and the asset folder is proved contained first, so a save can never
 * be the thing that puts an unloadable file on disk.
 */
export function savePlanFile(
  fs: PlanFileSystem,
  filePath: string,
  plan: ServicePlan
): Result<string> {
  const path = resolvePath(filePath)

  const validated = validatePlanDocument(plan)
  if (!validated.ok) return validated

  const assetDir = resolveAssetDir(path, validated.value)
  if (!assetDir.ok) return assetDir

  const contents = `${JSON.stringify(validated.value, null, 2)}\n`
  const temporary = `${path}${PLAN_TEMP_SUFFIX}`

  const made = attempt(() => fs.mkdirp(dirname(path)), 'the plan folder could not be created')
  if (!made.ok) return made

  const written = attempt(
    () => fs.writeText(temporary, contents),
    'the plan could not be written'
  )
  if (!written.ok) {
    discard(fs, temporary)
    return written
  }

  const renamed = attempt(
    () => fs.rename(temporary, path),
    'the plan could not be moved into place'
  )
  if (!renamed.ok) {
    // The previous plan is still exactly as it was; only the temp file is wasted.
    discard(fs, temporary)
    return renamed
  }

  return ok(path)
}

/** Best-effort temp cleanup. A failure here is genuinely uninteresting and never surfaces. */
function discard(fs: PlanFileSystem, path: string): void {
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
