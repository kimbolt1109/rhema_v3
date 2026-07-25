/**
 * Importing a standalone image or video the operator picked from disk into the plan's asset folder.
 *
 * A deck import (`deckImport.ts`) covers the Sunday where everything is in one `.pptx`. This covers
 * the other Sunday: a single logo, a countdown clip, a baptism photo someone AirDropped ten minutes
 * ago. The operator picks it in a file dialog; this copies it next to the plan so the plan folder
 * stays self-contained and can be carried to the booth machine on a stick, and returns the
 * plan-relative path a cue payload stores.
 *
 * ## Why copy instead of referencing in place
 *
 * A cue that points at `C:\Users\someone\Downloads\clip.mp4` works until the Downloads folder is
 * cleaned, the file is renamed, or the plan is opened on the booth machine — and it fails at the
 * moment the cue fires, in front of the congregation. Copying costs disk and buys a plan that
 * cannot rot. The same reason `planFile.ts` resolves `assetDir` relative to the plan file.
 *
 * ## Containment is the security property
 *
 * The source path is trusted to be wherever the operator pointed the dialog — that is their machine
 * and their business. The DESTINATION is not: it is derived from the source's own basename, and a
 * filename is attacker-controlled the moment the file arrived by email. So the basename is
 * sanitised, then the destination is *proved* to resolve inside the asset folder before anything is
 * written. Two independent defences, because either one alone is a single edit away from being
 * wrong.
 *
 * Sanitising deliberately keeps non-ASCII characters. A Korean church's files are routinely named
 * in Hangul; an ASCII allowlist of the kind {@link safeAssetFilename}'s neighbour `safeDeckStem`
 * uses would mangle every one of them into dashes. Only the characters that carry *meaning to a
 * filesystem* are removed.
 *
 * ## Why the extension is trusted here and sniffed in deckImport
 *
 * `deckImport.ts` reads magic bytes because a `.pptx` entry name is chosen by whoever built the
 * deck. Here the extension is the operator's own claim about their own file, and the overlay is the
 * thing that has to render it. Sniffing would buy nothing and would refuse legitimate video: a
 * `.mkv` or `.mov` may hold any of a dozen codecs, so the only honest test of "can the overlay play
 * this" is the overlay trying. An unplayable clip is a visible, recoverable mistake in rehearsal; a
 * refused-but-fine clip is an argument with the app at 10:25.
 *
 * ## Nothing here throws, and one bad file never costs the batch
 *
 * The operator can multi-select. If file three is a `.pptx` and file four was deleted since the
 * dialog opened, files one, two and five still land, and three and four come back in
 * {@link AssetCopyOutcome.failed} with a reason that can be shown verbatim in the booth UI
 * (Standing Rule 5: degrade, never crash). A batch where every file fails is not an error either —
 * it is an outcome with nothing copied.
 */

import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path'

import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Extensions the overlay's slide layer can show in an `<img>`.
 *
 * `.avif` is included because Chromium — and an OBS Browser Source is Chromium — has supported it
 * since 85, and phones now produce it by default. `.svg` is deliberately absent: an SVG is a
 * document that can carry script, and the overlay page's job is not to run someone's artwork.
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.avif'
]

/**
 * Extensions the overlay's slide layer can play in a `<video>`.
 *
 * `.mkv` and `.mov` are accepted on the same reasoning as the file-header note above: the container
 * is not the codec, so whether a given file plays is Chromium's answer to give, not ours to guess.
 */
export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.webm', '.m4v', '.mov', '.mkv']

/**
 * Largest single asset accepted.
 *
 * Generous on purpose — a 4K bumper or a full worship-set backing video is comfortably a few
 * hundred megabytes, and refusing the operator's real content is worse than copying a big file.
 * The limit exists for the other case: the operator who picks a 40 GB camera master by mistake and
 * would otherwise fill the booth machine's system disk during the service.
 */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024

/**
 * Longest filename stem kept, in code points.
 *
 * Windows caps a path at 260 characters by default and the asset folder already eats most of a
 * user profile path, so a 200-character filename from someone's phone export is a write that fails
 * for a reason no operator could diagnose. Truncating is the graceful version of that failure.
 */
const MAX_STEM_CODE_POINTS = 120

/**
 * How many `-2`, `-3`, … suffixes are tried before the file is refused.
 *
 * A bound, not a limit anyone should reach: 200 files named `logo.png` in one plan means something
 * has gone wrong upstream, and an unbounded loop against the filesystem is not how we find out.
 */
const MAX_NAME_ATTEMPTS = 200

/** Used when a filename sanitises away to nothing at all (`..`, `...`, a name of only colons). */
const FALLBACK_STEM = 'asset'

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** What the overlay will build for this asset: an `<img>` or a `<video>`. */
export type AssetKind = 'image' | 'video'

/**
 * Which sub-folder of the asset dir each kind lives in.
 *
 * Images go to `slides` so a picture imported on its own sits beside the slides a deck import
 * produced and the overlay's existing `/assets/slides/…` URL works unchanged. Video gets its own
 * folder because "everything in slides is a still" is a useful thing for a human poking at the plan
 * folder to be able to assume.
 */
const SUBFOLDERS: Readonly<Record<AssetKind, string>> = {
  image: 'slides',
  video: 'media'
}

/**
 * Decide from the extension whether this is an image, a video, or neither.
 *
 * Case-insensitive, because Windows filesystems are and a camera that writes `IMG_0001.JPG` is not
 * unusual. `null` means "Verger has nothing to do with this file" — a `.pptx` (which belongs to
 * `importDeck`, not here), an `.exe`, a `.json`, or a name with no extension at all. Note that a
 * name that is *only* an extension (`.png`) has no extension as far as `path.extname` is concerned,
 * which is the right answer: that is a dotfile, not a picture.
 */
export function classifyAsset(path: string): AssetKind | null {
  const extension = extname(path).toLowerCase()
  if (extension === '') return null
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video'
  return null
}

/** The asset-dir sub-folder an asset of this kind is written into. */
export function assetSubfolder(kind: AssetKind): string {
  return SUBFOLDERS[kind]
}

/** A path's extension when it is one the overlay handles, lower-cased; otherwise `null`. */
function knownExtension(path: string): string | null {
  const extension = extname(path).toLowerCase()
  if (extension === '') return null
  if (IMAGE_EXTENSIONS.includes(extension) || VIDEO_EXTENSIONS.includes(extension)) {
    return extension
  }
  return null
}

// ---------------------------------------------------------------------------
// Filename sanitising
// ---------------------------------------------------------------------------

/**
 * Reduce an arbitrary source path to a filename that is safe to create inside the asset folder.
 *
 * Exported because this is the containment boundary, and a boundary that is only reachable through
 * an async filesystem call is a boundary that does not get tested properly.
 *
 * What is removed, and why each one is a real escape and not paranoia:
 *
 *  - **Everything up to the last `/` or `\`.** Both separators, always, on both platforms:
 *    `node:path`'s `basename` only knows the separators of the host OS, so a name authored on
 *    Windows and processed on Linux would keep its backslashes and become one long "filename" that
 *    a later `path.resolve` may well split again.
 *  - **A leading `C:` drive qualifier.** `C:logo.png` is drive-*relative* on Windows and resolves
 *    against that drive's current directory, which is not the asset folder.
 *  - **Everything from the first remaining `:`.** On NTFS, `logo.png:payload` writes an alternate
 *    data stream hanging off `logo.png` — a file that exists, that the overlay never serves, and
 *    that no directory listing shows.
 *  - **Control characters and the Windows-reserved `* ? " < > |`.** These make a name that either
 *    cannot be created or that behaves as a wildcard somewhere downstream.
 *  - **Leading dots.** This is what makes `..` and `...` collapse to nothing rather than to a
 *    parent-directory reference, and it keeps imports from creating dotfiles.
 *  - **Trailing dots and spaces.** Windows silently strips them when creating a file, so a name
 *    ending in one is a name that does not round-trip: we would write `clip.mp4 ` and later look
 *    for a file that is actually called `clip.mp4`.
 *
 * Everything else is kept verbatim, including every non-ASCII character.
 */
export function safeAssetFilename(sourcePath: string): string {
  const segments = sourcePath.split(/[\\/]+/)
  const lastSegment = segments[segments.length - 1] ?? ''

  const withoutDrive = lastSegment.replace(/^[A-Za-z]:/, '')
  const streamAt = withoutDrive.indexOf(':')
  const named = streamAt === -1 ? withoutDrive : withoutDrive.slice(0, streamAt)

  const cleaned = named
    // eslint-disable-next-line no-control-regex -- the control range is exactly what is unsafe here
    .replace(/[\u0000-\u001f\u007f*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()

  // The extension comes from the ORIGINAL path when it is one Verger knows, so cutting an
  // alternate-data-stream suffix off `clip:payload.mp4` still leaves a file called `clip.mp4`
  // rather than an extensionless `clip` that the overlay could not tell was a video. For anything
  // else, the cleaned name's own extension is the best available answer.
  const known = knownExtension(sourcePath)
  const extension = known ?? extname(cleaned).toLowerCase()
  const stem =
    extension !== '' && cleaned.toLowerCase().endsWith(extension)
      ? cleaned.slice(0, cleaned.length - extension.length)
      : cleaned

  // Sliced by code point, not by UTF-16 unit: cutting an emoji filename in half leaves a lone
  // surrogate, which some filesystems refuse and every log renders as a replacement character.
  const points = Array.from(stem)
  const truncated = points.length > MAX_STEM_CODE_POINTS
    ? points.slice(0, MAX_STEM_CODE_POINTS).join('')
    : stem

  const finalStem = truncated === '' ? FALLBACK_STEM : truncated
  return `${finalStem}${extension}`
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Resolve `fragment` inside `assetDir`, proving the result is still inside it.
 *
 * Defence in depth behind {@link safeAssetFilename}, and the same proof `planFile.ts` and
 * `deckImport.ts` use: if the resolved path is genuinely under the base, then the relative path
 * from base to it is a plain forward reference. Anything starting with `..`, or coming back
 * absolute because it landed on another drive, escaped.
 *
 * This module deliberately does not import that check from `planFile.ts`. Containment is the one
 * property here that must not be able to break because a shared helper's signature changed, and
 * the check is six lines.
 */
export function resolveInsideAssetDir(assetDir: string, fragment: string): Result<string> {
  const trimmed = fragment.trim()
  if (trimmed === '') return err(ErrorCode.INVALID_ARG, 'the asset path is empty')
  if (trimmed.includes('\0') || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return err(ErrorCode.INVALID_ARG, 'the asset path must stay inside the plan folder', fragment)
  }
  if (/^[A-Za-z]:/.test(trimmed) || isAbsolute(trimmed)) {
    return err(ErrorCode.INVALID_ARG, 'the asset path must stay inside the plan folder', fragment)
  }

  const base = resolvePath(assetDir)
  const full = resolvePath(base, trimmed)
  const rel = relativePath(base, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return err(
      ErrorCode.INVALID_ARG,
      'the asset path must stay inside the plan folder',
      `refused "${fragment}" — it resolves outside "${base}"`
    )
  }
  return ok(full)
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/** One asset that made it into the plan folder. */
export interface CopiedAsset {
  /** The path the operator picked, echoed back so the UI can say which file this row was. */
  readonly sourcePath: string
  /**
   * The path a cue payload stores: relative to the asset folder, forward slashes always.
   *
   * Forward slashes even on Windows, because this string is also half of the overlay's
   * `/assets/<relative>` URL, and a backslash in a URL path is not a separator.
   */
  readonly relative: string
  readonly kind: AssetKind
}

/** One asset that did not, and the sentence to show the operator about it. */
export interface AssetCopyFailure {
  readonly sourcePath: string
  /** Short, operator-readable, safe to render verbatim in the booth UI. */
  readonly reason: string
}

/** The outcome of a batch. Both lists may be empty; neither case is an error. */
export interface AssetCopyOutcome {
  readonly copied: readonly CopiedAsset[]
  readonly failed: readonly AssetCopyFailure[]
}

/** Everything {@link copyAssetsIntoPlan} needs. */
export interface CopyAssetsOptions {
  /** Absolute path to the plan's asset folder. May not exist yet; sub-folders are created lazily. */
  readonly assetDir: string
  /** Absolute source files, in the order the operator chose them. */
  readonly paths: readonly string[]
  /** Per-file size ceiling. Defaults to {@link MAX_ASSET_BYTES}. */
  readonly maxBytes?: number
}

/**
 * Copy each chosen file into the plan's asset folder, one at a time, never overwriting anything.
 *
 * Order of operations per file, cheapest and most decisive check first: classify by extension (no
 * disk touched at all), then `stat` (so a directory or an absurd file is refused before it is
 * opened), then create the sub-folder, then copy under an unused name.
 *
 * Two properties are worth stating outright because they are what make this safe to point at a
 * folder the operator cares about:
 *
 *  1. **Nothing is ever overwritten.** The copy uses `COPYFILE_EXCL`, so the *filesystem* enforces
 *     it and there is no window between "does this name exist?" and "write it" for a second import
 *     to slip through. `EEXIST` is not a failure, it is the signal to try `logo-2.png`.
 *  2. **The copy never passes through this process's heap.** `copyFile` is an OS-level copy;
 *     `readFile` + `writeFile` on a 500 MB clip would spike the main process's memory and stall the
 *     event loop, and this runs while a service is live.
 *
 * A batch with no paths resolves immediately and touches no disk — not even an `mkdir` — so calling
 * this after a cancelled file dialog is free.
 */
export async function copyAssetsIntoPlan(options: CopyAssetsOptions): Promise<AssetCopyOutcome> {
  const copied: CopiedAsset[] = []
  const failed: AssetCopyFailure[] = []

  if (options.paths.length === 0) return { copied, failed }

  // A caller that passes a nonsensical ceiling gets the default rather than a batch where every
  // file is "too large" (Standing Rule 5: degrade, never surprise).
  const maxBytes =
    Number.isFinite(options.maxBytes) && (options.maxBytes ?? 0) > 0
      ? (options.maxBytes ?? MAX_ASSET_BYTES)
      : MAX_ASSET_BYTES

  /** Sub-folders already created (or already known to be uncreatable) in this batch. */
  const preparedDirs = new Map<string, Result<string>>()

  for (const sourcePath of options.paths) {
    const kind = classifyAsset(sourcePath)
    if (kind === null) {
      failed.push({ sourcePath, reason: unsupportedReason(sourcePath) })
      continue
    }

    const sized = await inspectSource(sourcePath, maxBytes)
    if (!sized.ok) {
      failed.push({ sourcePath, reason: sized.error.message })
      continue
    }

    const subfolder = assetSubfolder(kind)
    let prepared = preparedDirs.get(subfolder)
    if (prepared === undefined) {
      prepared = await prepareSubfolder(options.assetDir, subfolder)
      preparedDirs.set(subfolder, prepared)
    }
    if (!prepared.ok) {
      failed.push({ sourcePath, reason: prepared.error.message })
      continue
    }

    const written = await copyUnderUnusedName(sourcePath, options.assetDir, subfolder)
    if (!written.ok) {
      failed.push({ sourcePath, reason: written.error.message })
      continue
    }
    copied.push({ sourcePath, relative: written.value, kind })
  }

  return { copied, failed }
}

/** The sentence for a file Verger has no use for. Names the extension, because that is the fix. */
function unsupportedReason(sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase()
  if (extension === '') {
    return 'that file has no extension, so Verger cannot tell what it is'
  }
  return `Verger cannot show a ${extension} file — choose an image or a video`
}

/**
 * Prove the source is a regular file of an acceptable size.
 *
 * A directory gets its own sentence because picking one is a plausible mistake in a file dialog,
 * where "the file could not be read" would send the operator looking for a permissions problem
 * they do not have.
 */
async function inspectSource(sourcePath: string, maxBytes: number): Promise<Result<number>> {
  try {
    const stats = await stat(sourcePath)
    if (stats.isDirectory()) {
      return err(ErrorCode.INVALID_ARG, 'that is a folder, not a file')
    }
    if (!stats.isFile()) {
      return err(ErrorCode.INVALID_ARG, 'that is not a file Verger can copy')
    }
    if (stats.size > maxBytes) {
      return err(
        ErrorCode.INVALID_ARG,
        `that file is ${describeSize(stats.size)} — over the ${describeSize(maxBytes)} limit`
      )
    }
    return ok(stats.size)
  } catch (cause) {
    if (errorCodeOf(cause) === 'ENOENT') {
      return err(ErrorCode.NOT_FOUND, 'that file no longer exists')
    }
    return err(ErrorCode.IO_ERROR, 'that file could not be read')
  }
}

/** Rounded up, so a file one byte over a 4 MB limit never reads as "4 MB — over the 4 MB limit". */
function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const megabytes = bytes / (1024 * 1024)
  if (megabytes < 1) return `${Math.ceil(bytes / 1024)} KB`
  return `${Math.ceil(megabytes)} MB`
}

/** Create the asset sub-folder, proving it is inside the asset dir first. */
async function prepareSubfolder(assetDir: string, subfolder: string): Promise<Result<string>> {
  const contained = resolveInsideAssetDir(assetDir, subfolder)
  if (!contained.ok) return contained
  try {
    await mkdir(contained.value, { recursive: true })
    return contained
  } catch {
    return err(ErrorCode.IO_ERROR, 'the plan asset folder could not be created')
  }
}

/**
 * Copy to the first unused name, returning the plan-relative path with forward slashes.
 *
 * `-2`, `-3`, … are appended before the extension, so `logo.png` becomes `logo-2.png` and stays a
 * PNG. Every candidate is re-proved contained: the sanitiser has already run, and this is still
 * checked, because a containment bug that only shows up on the fourth duplicate of a file is
 * exactly the bug nobody finds.
 */
async function copyUnderUnusedName(
  sourcePath: string,
  assetDir: string,
  subfolder: string
): Promise<Result<string>> {
  const filename = safeAssetFilename(sourcePath)
  const extension = extname(filename)
  const stem = extension === '' ? filename : filename.slice(0, filename.length - extension.length)

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stem}${extension}` : `${stem}-${attempt}${extension}`
    const relative = `${subfolder}/${candidate}`
    const contained = resolveInsideAssetDir(assetDir, join(subfolder, candidate))
    if (!contained.ok) {
      return err(ErrorCode.INVALID_ARG, 'that filename cannot be used inside the plan folder')
    }
    try {
      await copyFile(sourcePath, contained.value, constants.COPYFILE_EXCL)
      return ok(relative)
    } catch (cause) {
      // The name was taken between the last attempt and now, or was already there: not a failure,
      // just the next suffix. Anything else is a real I/O problem and stops this file.
      if (errorCodeOf(cause) === 'EEXIST') continue
      return err(ErrorCode.IO_ERROR, 'that file could not be copied into the plan folder')
    }
  }

  return err(
    ErrorCode.IO_ERROR,
    'too many files with that name are already in the plan folder — rename it and try again'
  )
}

/** The `errno` string off a Node system error, without asserting a type onto an unknown `catch`. */
function errorCodeOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null
  const code: unknown = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}
