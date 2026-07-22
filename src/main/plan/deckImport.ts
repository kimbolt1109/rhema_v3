/**
 * PowerPoint import — turning a `.pptx` into one manual slide cue per slide.
 *
 * ## Two backends, one honest story
 *
 * The good backend renders each slide to a PNG with **headless LibreOffice, in a child process**
 * (Standing Rule: untrusted input never gets parsed in the main process, and a converter that
 * hangs or crashes must take nothing with it). The child is bounded by a timeout and killed on
 * overrun.
 *
 * The other backend exists because LibreOffice is **not installed on the target machine and cannot
 * be installed there** — see `HUMAN_TASKS.md`. Rather than a disabled button and a shrug, import
 * falls back to `pptx.ts` and extracts the pictures **embedded in each slide**, resolved through
 * that slide's `_rels` mapping. A great many church decks are one full-bleed image per slide, so
 * for them this produces exactly the same result as rendering. For a text-only slide it produces
 * nothing, and {@link detectImporter} says so in words the operator can act on: this backend
 * extracts embedded pictures, it does not render slides.
 *
 * That honesty is the design. {@link DeckImporterStatus.available} is `false` when no renderer was
 * found — the UI is entitled to disable the button and tell the operator to install LibreOffice —
 * while {@link importDeck} still works via `embedded-media` for the operator who wants it anyway.
 * {@link canImportWithoutRenderer} is the one predicate the UI needs to offer that choice.
 *
 * ## A bad slide never costs you the deck
 *
 * If slide 7 is text-only and yields no image, slide 7 gets a cue with a note saying so and the
 * import carries on. Losing 30 slides because one of them had no picture is the wrong trade at
 * 10:25 on a Sunday. {@link DeckImportResult.slidesMissingAsset} tells the editor exactly which
 * cues still need an asset attached.
 *
 * ## Standing Rule 4
 *
 * Cue labels are `Slide 3`. Never the slide's own text. No function here reads, returns or logs
 * slide text — `pptx.ts` does not expose any, by construction.
 *
 * Nothing in this file throws; everything returns a `Result`.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

import type { DeckImporterStatus, DeckImportProgress } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { Cue, SlidePayload } from '@shared/plan'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

import { extractEntries, hasZipMagic, readPptx, resolveLimits } from './pptx'
import type { PptxLimits, PptxSlideInfo } from './pptx'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Point this at `soffice`/`soffice.exe` to use a LibreOffice that is not in a standard place. */
export const SOFFICE_ENV_VAR = 'VERGER_SOFFICE'

/** Backend id reported when slides were rendered by LibreOffice. */
export const BACKEND_LIBREOFFICE = 'libreoffice'

/** Backend id reported when slide pictures were extracted from the package instead. */
export const BACKEND_EMBEDDED_MEDIA = 'embedded-media'

/** How long the converter child process may run before it is killed. */
export const CONVERT_TIMEOUT_MS = 120_000

/** Largest `.pptx` accepted, mirroring rhema_v2's `MAX_IMPORT_BYTES`. */
export const MAX_DECK_BYTES = 50 * 1024 * 1024

/** What the operator is told when no renderer is installed. Also the settings-panel copy. */
export const NO_RENDERER_DETAIL =
  'LibreOffice was not found, so Verger cannot render slides to images on this machine. ' +
  'Import still works in a reduced mode: it extracts the pictures embedded in each slide, so a ' +
  'deck that is one image per slide imports perfectly, while a text-only slide produces no image ' +
  'and its cue is created with no asset attached. Install LibreOffice (libreoffice.org/download) ' +
  `and restart Verger for full slide rendering, or set ${SOFFICE_ENV_VAR} to your soffice executable.`

// ---------------------------------------------------------------------------
// Importer detection
// ---------------------------------------------------------------------------

/** Injection points for {@link detectImporter}, so the probe is testable on any machine. */
export interface ImporterProbeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: string
  /** Returns true when the path exists AND is a regular file. Default: `node:fs`. */
  readonly isFile?: (path: string) => boolean
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Candidate `soffice` locations, most specific first.
 *
 * PATH is searched as well as the usual install directories, because a Windows LibreOffice install
 * does NOT put `soffice.exe` on PATH by default — checking only PATH would report "not installed"
 * on a machine that has it, which is the more annoying of the two possible wrong answers.
 */
export function sofficeCandidates(options: ImporterProbeOptions = {}): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const candidates: string[] = []

  const override = env[SOFFICE_ENV_VAR]
  if (override !== undefined && override.trim().length > 0) candidates.push(override.trim())

  const isWindows = platform === 'win32'
  const executables = isWindows ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice']

  // Separator and delimiter come from the REQUESTED platform, not the host's, so an injected
  // `platform` produces the paths that platform would really use. `node:path`'s host-bound `join`
  // and `delimiter` would otherwise make this function untestable for anything but the host OS —
  // and would quietly join a POSIX PATH with backslashes on Windows.
  const separator = isWindows ? '\\' : '/'
  const pathDelimiter = isWindows ? ';' : ':'
  const joinPath = (...parts: readonly string[]): string =>
    parts.reduce((acc, part) =>
      acc.endsWith(separator) || acc.endsWith('/') ? `${acc}${part}` : `${acc}${separator}${part}`
    )

  for (const dir of (env['PATH'] ?? '').split(pathDelimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    for (const exe of executables) candidates.push(joinPath(trimmed, exe))
  }

  if (isWindows) {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env['LOCALAPPDATA']
    candidates.push(joinPath(programFiles, 'LibreOffice', 'program', 'soffice.exe'))
    candidates.push(joinPath(programFilesX86, 'LibreOffice', 'program', 'soffice.exe'))
    if (localAppData !== undefined) {
      candidates.push(joinPath(localAppData, 'Programs', 'LibreOffice', 'program', 'soffice.exe'))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    candidates.push('/opt/homebrew/bin/soffice')
    candidates.push('/usr/local/bin/soffice')
  } else {
    candidates.push('/usr/bin/soffice')
    candidates.push('/usr/local/bin/soffice')
    candidates.push('/opt/libreoffice/program/soffice')
    candidates.push('/snap/bin/libreoffice')
  }

  return candidates
}

/**
 * Probe this machine for a slide renderer.
 *
 * Never throws, never spawns anything — a stat-only probe, safe to call on every settings render.
 * On a machine with no LibreOffice this returns `available: false`, `backend: 'embedded-media'`
 * and {@link NO_RENDERER_DETAIL}: `backend` names what an import WOULD use, so the settings panel
 * can describe the degraded mode without a second call.
 */
export function detectImporter(options: ImporterProbeOptions = {}): DeckImporterStatus {
  const isFile = options.isFile ?? defaultIsFile
  for (const candidate of sofficeCandidates(options)) {
    if (isFile(candidate)) {
      return {
        available: true,
        backend: BACKEND_LIBREOFFICE,
        executablePath: candidate,
        detail: null
      }
    }
  }
  return {
    available: false,
    backend: BACKEND_EMBEDDED_MEDIA,
    executablePath: null,
    detail: NO_RENDERER_DETAIL
  }
}

/**
 * Can an import still be attempted with this status?
 *
 * True whenever a renderer exists OR the embedded-media backend is on offer — which is always, so
 * this is really "is there any path at all", kept explicit so the UI's decision is legible rather
 * than a hardcoded `true` somewhere in a component.
 */
export function canImportWithoutRenderer(status: DeckImporterStatus): boolean {
  return status.available || status.backend === BACKEND_EMBEDDED_MEDIA
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Resolve `relative` inside `baseDir`, or refuse.
 *
 * Containment is verified on the *resolved* paths — `..` is not stripped, absolute inputs are not
 * quietly rebased. Every filesystem write in this module goes through here, so no archive entry,
 * however named, can place a file outside the plan's asset folder.
 */
export function resolveWithinDir(baseDir: string, relative: string): Result<string> {
  if (relative.length === 0) return err(ErrorCode.INVALID_ARG, 'empty asset path')
  if (isAbsolute(relative)) {
    return err(ErrorCode.INVALID_ARG, 'asset path must be relative', relative)
  }
  const base = resolve(baseDir)
  const target = resolve(base, relative)
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) {
    return err(ErrorCode.INVALID_ARG, 'asset path escapes the plan asset folder', relative)
  }
  return ok(target)
}

/** Reduce an arbitrary deck filename to something safe to use in an asset filename. */
export function safeDeckStem(deckPath: string): string {
  const raw = basename(deckPath, extname(deckPath))
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'deck'
}

// ---------------------------------------------------------------------------
// Image sniffing
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, i) => bytes[i] === byte)
}

/**
 * Decide a file extension from the bytes, never from the archive entry name.
 *
 * The entry name is attacker-controlled; the magic bytes are what the file actually is. Anything
 * that is not a raster image the overlay can display returns `null` and is skipped — which is also
 * how embedded video and EMF/WMF vector art are kept out of slide payloads.
 */
export function sniffImageExtension(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return '.jpg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return '.gif'
  if (startsWith(bytes, [0x42, 0x4d])) return '.bmp'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return '.webp'
  }
  return null
}

// ---------------------------------------------------------------------------
// The converter child process
// ---------------------------------------------------------------------------

/** Outcome of one converter run. Never a thrown error. */
export interface DeckSpawnResult {
  readonly code: number | null
  readonly timedOut: boolean
  readonly failure: string | null
}

/** The child-process seam, injected in tests so no LibreOffice is required to exercise this path. */
export type DeckSpawn = (
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number }
) => Promise<DeckSpawnResult>

/**
 * Run the converter in a real child process, killed on overrun.
 *
 * stdio is ignored entirely: a converter's chatter is not something we want in the log, and
 * reading its stdout is how a hostile file gets a second chance at us.
 */
export const spawnConverter: DeckSpawn = (executable, args, options) =>
  new Promise<DeckSpawnResult>((settle) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (cause) {
      settle({
        code: null,
        timedOut: false,
        failure: cause instanceof Error ? cause.message : String(cause)
      })
      return
    }

    const spawned = child
    let done = false
    const timer = setTimeout(() => {
      try {
        spawned.kill('SIGKILL')
      } catch {
        // The child already exited; nothing left to kill.
      }
      finish({ code: null, timedOut: true, failure: 'converter timed out' })
    }, options.timeoutMs)

    function finish(result: DeckSpawnResult): void {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(result)
    }

    spawned.on('error', (cause: Error) => {
      finish({ code: null, timedOut: false, failure: cause.message })
    })
    spawned.on('close', (code) => {
      finish({ code, timedOut: false, failure: null })
    })
  })

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Everything {@link importDeck} needs, with every external dependency injectable. */
export interface DeckImportOptions {
  /** Absolute path to the plan's asset folder. Images are written under here and nowhere else. */
  readonly assetDir: string
  /** Sub-folder of the asset dir, and the prefix stored in `SlidePayload.asset`. Default `slides`. */
  readonly assetPrefix?: string
  /** Label prefix — cues are named `<prefix> <n>`. Default `Slide`. Never the slide's own text. */
  readonly labelPrefix?: string
  /** Progress sink. Wrapped: a throwing subscriber cannot fail the import. */
  readonly onProgress?: (progress: DeckImportProgress) => void
  /** A pre-detected importer status. Default: {@link detectImporter} run now. */
  readonly importer?: DeckImporterStatus
  /** Override any of the parser's bounds. */
  readonly limits?: Partial<PptxLimits>
  /** Converter timeout. Default {@link CONVERT_TIMEOUT_MS}. */
  readonly convertTimeoutMs?: number
  /** Cue id factory. Default `crypto.randomUUID`. */
  readonly newId?: () => string
  /** Child-process seam. Default {@link spawnConverter}. */
  readonly spawn?: DeckSpawn
  /** Scratch directory for converter output. Default the OS temp dir. */
  readonly tempDir?: string
  readonly logger?: Logger
}

/** What an import produced. */
export interface DeckImportResult {
  /** {@link BACKEND_LIBREOFFICE} when any slide was rendered, otherwise {@link BACKEND_EMBEDDED_MEDIA}. */
  readonly backend: string
  /** One `slide` cue per slide, in deck order, every one of them `trigger.mode = 'manual'`. */
  readonly cues: readonly Cue[]
  readonly slidesTotal: number
  readonly slidesWithAsset: number
  /** 1-based slide numbers whose cue has no image on disk yet. */
  readonly slidesMissingAsset: readonly number[]
  /** Operator-facing, non-fatal. Never contains slide text. */
  readonly warnings: readonly string[]
}

/** The note attached to a cue whose slide produced no image. */
export function missingAssetNote(slideNumber: number): string {
  return `Slide ${slideNumber} produced no image (a text-only slide, or a picture Verger cannot display). Attach an asset to this cue.`
}

function emit(
  onProgress: ((progress: DeckImportProgress) => void) | undefined,
  progress: DeckImportProgress
): void {
  if (onProgress === undefined) return
  try {
    onProgress(progress)
  } catch {
    // A progress subscriber must never be able to fail an import.
  }
}

/** Numeric ordering for the converter's output files, for the same reason slides need it. */
function compareNumeric(a: string, b: string): number {
  const na = Number.parseInt(/(\d+)(?=\.[^.]+$)/.exec(a)?.[1] ?? '', 10)
  const nb = Number.parseInt(/(\d+)(?=\.[^.]+$)/.exec(b)?.[1] ?? '', 10)
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b)
  return na - nb
}

/**
 * Render the deck with LibreOffice into a scratch directory and return the produced images in
 * slide order.
 *
 * Returns an empty list on any failure — a converter that crashed, timed out, or produced nothing
 * is not an error, it is a reason to fall back to embedded media. That decision is deliberate:
 * the operator gets whatever images the deck can give up, plus a warning, rather than an abort.
 */
async function renderWithConverter(
  executable: string,
  deckPath: string,
  scratchDir: string,
  timeoutMs: number,
  spawnFn: DeckSpawn,
  warnings: string[]
): Promise<Uint8Array[]> {
  try {
    await mkdir(scratchDir, { recursive: true })
    const result = await spawnFn(
      executable,
      ['--headless', '--norestore', '--convert-to', 'png', '--outdir', scratchDir, deckPath],
      { cwd: scratchDir, timeoutMs }
    )
    if (result.timedOut) {
      warnings.push('The slide renderer took too long and was stopped; embedded pictures were used instead.')
      return []
    }
    if (result.failure !== null) {
      warnings.push('The slide renderer could not be run; embedded pictures were used instead.')
      return []
    }
    if (result.code !== 0 && result.code !== null) {
      warnings.push(
        `The slide renderer exited with code ${result.code}; embedded pictures were used instead.`
      )
      return []
    }

    const produced = (await readdir(scratchDir)).filter((name) => /\.(png|jpe?g)$/i.test(name))
    produced.sort(compareNumeric)

    const images: Uint8Array[] = []
    for (const name of produced) {
      const contained = resolveWithinDir(scratchDir, name)
      if (!contained.ok) continue
      images.push(new Uint8Array(await readFile(contained.value)))
    }
    return images
  } catch (cause) {
    warnings.push('The slide renderer failed; embedded pictures were used instead.')
    void cause
    return []
  }
}

/**
 * Import a `.pptx` as a run of manual slide cues.
 *
 * Order of operations, and why: the package is size-checked and magic-byte-checked before it is
 * opened, parsed by `pptx.ts` under every bound it enforces, rendered in a child process when a
 * renderer exists, and only then written to disk — each write path-contained to the asset folder.
 * A slide that yields no image still gets a cue.
 */
export async function importDeck(
  deckPath: string,
  options: DeckImportOptions
): Promise<Result<DeckImportResult>> {
  const onProgress = options.onProgress
  const warnings: string[] = []
  const limits = resolveLimits(options.limits)
  const assetPrefix = options.assetPrefix ?? 'slides'
  const labelPrefix = options.labelPrefix ?? 'Slide'
  const newId = options.newId ?? (() => randomUUID())

  emit(onProgress, { stage: 'reading', slidesDone: 0, slidesTotal: null, message: 'Reading deck' })

  // --- read and pre-flight the file ------------------------------------------------------------
  let bytes: Uint8Array
  try {
    const stats = statSync(deckPath)
    if (!stats.isFile()) {
      emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal: null, message: 'Not a file' })
      return err(ErrorCode.INVALID_ARG, 'that path is not a file', deckPath)
    }
    if (stats.size > MAX_DECK_BYTES) {
      emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal: null, message: 'Deck too large' })
      return err(
        ErrorCode.INVALID_ARG,
        `that deck is larger than the ${Math.round(MAX_DECK_BYTES / (1024 * 1024))} MB import limit`
      )
    }
    bytes = new Uint8Array(await readFile(deckPath))
  } catch (cause) {
    emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal: null, message: 'Could not read deck' })
    return err(
      ErrorCode.IO_ERROR,
      'could not read that PowerPoint file',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  if (!hasZipMagic(bytes)) {
    emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal: null, message: 'Not a .pptx' })
    return err(ErrorCode.INVALID_ARG, 'that file is not a PowerPoint presentation')
  }

  // --- parse the package (structure only; never text) ------------------------------------------
  const parsed = readPptx(bytes, limits)
  if (!parsed.ok) {
    emit(onProgress, {
      stage: 'failed',
      slidesDone: 0,
      slidesTotal: null,
      message: parsed.error.message
    })
    return parsed
  }
  const slides = parsed.value.slides
  warnings.push(...parsed.value.warnings)
  const slidesTotal = slides.length

  emit(onProgress, {
    stage: 'converting',
    slidesDone: 0,
    slidesTotal,
    message: 'Preparing slide images'
  })

  // --- render, if a renderer exists -------------------------------------------------------------
  const importer = options.importer ?? detectImporter()
  let rendered: Uint8Array[] = []
  if (importer.available && importer.executablePath !== null) {
    const scratchDir = join(options.tempDir ?? tmpdir(), `verger-deck-${newId()}`)
    rendered = await renderWithConverter(
      importer.executablePath,
      deckPath,
      scratchDir,
      options.convertTimeoutMs ?? CONVERT_TIMEOUT_MS,
      options.spawn ?? spawnConverter,
      warnings
    )
    if (rendered.length > 0 && rendered.length < slidesTotal) {
      warnings.push(
        `The renderer produced ${rendered.length} image${rendered.length === 1 ? '' : 's'} for ${slidesTotal} slides; the remaining slides fall back to their embedded pictures.`
      )
    }
  } else {
    warnings.push(
      'No slide renderer is installed, so embedded pictures were extracted instead of rendered slides. A text-only slide will have no image.'
    )
  }

  // --- extract only the embedded media we actually need ------------------------------------------
  const neededMedia: string[] = []
  for (const [i, slide] of slides.entries()) {
    if (rendered[i] !== undefined) continue
    const first = slide.media[0]
    if (first !== undefined && !neededMedia.includes(first.entryName)) neededMedia.push(first.entryName)
  }
  const mediaResult = extractEntries(bytes, neededMedia, limits)
  if (!mediaResult.ok) {
    emit(onProgress, {
      stage: 'failed',
      slidesDone: 0,
      slidesTotal,
      message: mediaResult.error.message
    })
    return mediaResult
  }
  const media = mediaResult.value

  // --- write assets and build cues ---------------------------------------------------------------
  emit(onProgress, { stage: 'writing', slidesDone: 0, slidesTotal, message: 'Writing slide images' })

  const targetDirResult = resolveWithinDir(options.assetDir, assetPrefix)
  if (!targetDirResult.ok) {
    emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal, message: 'Bad asset folder' })
    return targetDirResult
  }
  try {
    await mkdir(targetDirResult.value, { recursive: true })
  } catch (cause) {
    emit(onProgress, { stage: 'failed', slidesDone: 0, slidesTotal, message: 'Could not create asset folder' })
    return err(
      ErrorCode.IO_ERROR,
      'could not create the plan asset folder',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  const stem = safeDeckStem(deckPath)
  const cues: Cue[] = []
  const slidesMissingAsset: number[] = []
  let usedRenderer = false

  for (const [i, slide] of slides.entries()) {
    const slideNumber = i + 1
    const written = await writeSlideAsset({
      slide,
      slideNumber,
      stem,
      assetPrefix,
      assetDir: options.assetDir,
      renderedBytes: rendered[i],
      media
    })
    if (written.usedRenderer) usedRenderer = true
    if (written.warning !== null) warnings.push(written.warning)

    const payload: SlidePayload =
      written.assetPath === null
        ? { asset: expectedAssetPath(assetPrefix, stem, slideNumber, '.png'), sourceSlide: slideNumber }
        : { asset: written.assetPath, sourceSlide: slideNumber }

    const base = {
      id: newId().slice(0, 64),
      type: 'slide' as const,
      label: `${labelPrefix} ${slideNumber}`,
      // Manual first: every imported cue is operator-fired until someone arms it (Phase 8).
      trigger: { mode: 'manual' as const },
      payload
    }
    cues.push(
      written.assetPath === null ? { ...base, note: missingAssetNote(slideNumber) } : base
    )
    if (written.assetPath === null) slidesMissingAsset.push(slideNumber)

    emit(onProgress, {
      stage: 'writing',
      slidesDone: slideNumber,
      slidesTotal,
      message: `${labelPrefix} ${slideNumber}`
    })
  }

  const backend = usedRenderer ? BACKEND_LIBREOFFICE : BACKEND_EMBEDDED_MEDIA
  options.logger?.info('deck imported', {
    backend,
    slidesTotal,
    slidesMissing: slidesMissingAsset.length
  })

  emit(onProgress, {
    stage: 'done',
    slidesDone: slidesTotal,
    slidesTotal,
    message: `Imported ${slidesTotal} slide${slidesTotal === 1 ? '' : 's'}`
  })

  return ok({
    backend,
    cues,
    slidesTotal,
    slidesWithAsset: slidesTotal - slidesMissingAsset.length,
    slidesMissingAsset,
    warnings
  })
}

/** The asset path a slide's image occupies, using POSIX separators so plans stay portable. */
function expectedAssetPath(
  assetPrefix: string,
  stem: string,
  slideNumber: number,
  extension: string
): string {
  const padded = String(slideNumber).padStart(3, '0')
  return `${assetPrefix}/${stem}-slide-${padded}${extension}`
}

interface WriteSlideArgs {
  readonly slide: PptxSlideInfo
  readonly slideNumber: number
  readonly stem: string
  readonly assetPrefix: string
  readonly assetDir: string
  readonly renderedBytes: Uint8Array | undefined
  readonly media: ReadonlyMap<string, Uint8Array>
}

interface WriteSlideOutcome {
  /** Plan-relative asset path, or `null` when this slide produced no image. */
  readonly assetPath: string | null
  readonly usedRenderer: boolean
  readonly warning: string | null
}

/**
 * Write one slide's image, or report that there was none.
 *
 * Every failure here is local to the slide — a bad picture costs that one cue its asset and
 * nothing more.
 */
async function writeSlideAsset(args: WriteSlideArgs): Promise<WriteSlideOutcome> {
  const source: Uint8Array | null = args.renderedBytes ?? pickEmbedded(args.slide, args.media)
  if (source === null) {
    return { assetPath: null, usedRenderer: false, warning: null }
  }
  const usedRenderer = args.renderedBytes !== undefined

  const extension = sniffImageExtension(source)
  if (extension === null) {
    return {
      assetPath: null,
      usedRenderer: false,
      warning: `Slide ${args.slideNumber} has a picture in a format Verger cannot display; its cue needs an asset.`
    }
  }

  const relative = expectedAssetPath(args.assetPrefix, args.stem, args.slideNumber, extension)
  const contained = resolveWithinDir(args.assetDir, relative)
  if (!contained.ok) {
    return {
      assetPath: null,
      usedRenderer: false,
      warning: `Slide ${args.slideNumber} could not be written safely and was skipped.`
    }
  }
  try {
    await writeFile(contained.value, source)
  } catch {
    return {
      assetPath: null,
      usedRenderer: false,
      warning: `Slide ${args.slideNumber}'s image could not be written to disk.`
    }
  }
  return { assetPath: relative, usedRenderer, warning: null }
}

function pickEmbedded(
  slide: PptxSlideInfo,
  media: ReadonlyMap<string, Uint8Array>
): Uint8Array | null {
  for (const ref of slide.media) {
    const bytes = media.get(ref.entryName)
    if (bytes !== undefined && bytes.length > 0) return bytes
  }
  return null
}
