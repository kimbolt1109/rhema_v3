/**
 * A hostile-input-safe PPTX package reader.
 *
 * A `.pptx` is a ZIP file an operator downloaded from somewhere. It is **untrusted input** in the
 * strict sense: a stranger may have produced it, and the three attacks that matter are all cheap
 * to mount and expensive to survive:
 *
 * 1. **Zip bombs.** A 40 KB archive can declare petabytes of uncompressed content. `fflate` will
 *    happily try to allocate it. So this module never hands the archive to `fflate` blind: it
 *    parses the ZIP **central directory itself** first — which requires no inflation at all — and
 *    refuses on the declared sizes, the entry count, and an implausible compression ratio *before*
 *    a single byte is decompressed. Refuse rather than allocate.
 * 2. **Path traversal.** Entry names like `../../../Windows/System32/x`, `/etc/passwd` or
 *    `C:\x` are legal ZIP strings. {@link isSafeZipEntryName} rejects them structurally — it does
 *    not "strip `..`", because stripping is how traversal bugs are written. Nothing here ever
 *    touches the filesystem, and {@link readPptx} only ever returns names it has already validated.
 * 3. **Pathological decks.** A 10,000-slide deck must not hang a Sunday morning. Slides are capped.
 *
 * ## Standing Rule 4 — slides are OPAQUE IMAGES
 *
 * This module parses **package structure and media relationships only**. It does not extract,
 * return, or log slide text. The one place slide XML is read at all is a bounded scan for
 * `r:embed` / `r:link` *attribute values* (relationship ids like `rId3`), which is the only way to
 * learn which picture belongs to which slide. Text nodes (`<a:t>`) are never parsed, never
 * decoded into a value that escapes this function, and never logged. `PptxSlideInfo` deliberately
 * has no text field, so a caller cannot accidentally propagate slide text.
 *
 * ## The gotcha this module exists to fix
 *
 * `docs/v2-notes/PLAN_LESSONS.md` records that rhema_v2 dumped every image in the deck into one
 * flat bucket and left `ParsedSlide.image_paths` permanently empty, because
 * `ppt/slides/_rels/slideN.xml.rels` — the file that maps a slide's relationship ids to
 * `ppt/media/imageN.png` — was never parsed. Slide images therefore never rendered on cues. That
 * mapping is parsed here, per slide, and it is the whole point of {@link PptxSlideInfo.media}.
 *
 * Nothing in this file throws. Every entry point returns a `Result`.
 */

import { unzipSync } from 'fflate'

import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Every bound this reader enforces. All of them are refusals, not truncations: a deck that trips
 * a limit produces an error the operator can read, never a silently half-imported service.
 */
export interface PptxLimits {
  /** Largest `.pptx` file accepted at all, in bytes. */
  readonly maxPackageBytes: number
  /** Largest number of ZIP entries. A deck with more is pathological or hostile. */
  readonly maxEntries: number
  /** Largest declared uncompressed size for any single entry. */
  readonly maxEntryBytes: number
  /** Largest declared uncompressed size for the whole archive. The primary zip-bomb guard. */
  readonly maxTotalBytes: number
  /** Largest number of slides imported from one deck. */
  readonly maxSlides: number
  /** Largest slide XML inflated for the `r:embed` scan. Bigger slides fall back to the rels file. */
  readonly maxSlideXmlBytes: number
  /** Largest `.rels` file inflated. */
  readonly maxRelsBytes: number
  /** Largest number of media references kept per slide. */
  readonly maxMediaPerSlide: number
  /**
   * Largest plausible uncompressed:compressed ratio for one entry.
   *
   * Only applied to entries whose declared uncompressed size exceeds
   * {@link PptxLimits.ratioCheckFloorBytes}, because a 40-byte XML stub legitimately has a silly
   * ratio and false positives here would refuse real decks. Genuine bombs run 1000:1 and up;
   * real presentation XML runs 5-15:1 and media runs about 1:1.
   */
  readonly maxCompressionRatio: number
  /** Entries smaller than this skip the ratio check. */
  readonly ratioCheckFloorBytes: number
}

/** The defaults. Sized for "the biggest real deck a church will ever bring", not for headroom. */
export const DEFAULT_PPTX_LIMITS: PptxLimits = {
  maxPackageBytes: 50 * 1024 * 1024,
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSlides: 500,
  maxSlideXmlBytes: 8 * 1024 * 1024,
  maxRelsBytes: 4 * 1024 * 1024,
  maxMediaPerSlide: 64,
  maxCompressionRatio: 300,
  ratioCheckFloorBytes: 1024 * 1024
}

/** Fill a partial override against {@link DEFAULT_PPTX_LIMITS}. */
export function resolveLimits(overrides?: Partial<PptxLimits>): PptxLimits {
  return { ...DEFAULT_PPTX_LIMITS, ...(overrides ?? {}) }
}

// ---------------------------------------------------------------------------
// Public shapes — note the complete absence of any text field
// ---------------------------------------------------------------------------

/** One ZIP entry, as described by the central directory. No content has been inflated yet. */
export interface ZipEntry {
  readonly name: string
  readonly compressedSize: number
  readonly uncompressedSize: number
  /** PKZIP method id: 0 = stored, 8 = deflate. */
  readonly method: number
}

/** The archive's directory plus the totals the caps were checked against. */
export interface ZipDirectory {
  readonly entries: readonly ZipEntry[]
  readonly totalUncompressedBytes: number
}

/** A picture belonging to one slide, resolved through that slide's `_rels` mapping. */
export interface PptxMediaRef {
  /** The relationship id it was reached by, e.g. `rId3`. Kept for diagnosis, never shown. */
  readonly relationshipId: string
  /** A validated ZIP entry name under `ppt/media/`. */
  readonly entryName: string
  /** Declared uncompressed size, in bytes. */
  readonly size: number
}

/**
 * One slide's structural metadata.
 *
 * There is deliberately no `text` and no `notes` field (Standing Rule 4). A slide is an opaque
 * image as far as Verger is concerned.
 */
export interface PptxSlideInfo {
  /** 1-based position in the deck AFTER numeric ordering. This is what "Slide 3" means. */
  readonly index: number
  /** The number in the entry name — `slide12.xml` is 12. Usually equals `index`, not always. */
  readonly slideNumber: number
  /** The validated entry name, e.g. `ppt/slides/slide12.xml`. */
  readonly entryName: string
  /** Pictures this slide references, in document order where that could be determined. */
  readonly media: readonly PptxMediaRef[]
}

/** What {@link readPptx} learned about a deck. */
export interface PptxPackage {
  readonly slides: readonly PptxSlideInfo[]
  readonly entryCount: number
  readonly totalUncompressedBytes: number
  /** Non-fatal notes for the operator, e.g. "slide 7 references a picture that is not in the file". */
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Entry-name safety
// ---------------------------------------------------------------------------

const MAX_ENTRY_NAME_LENGTH = 512
// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const WINDOWS_DRIVE = /^[A-Za-z]:/

/**
 * Is this ZIP entry name safe to use as a *relative* path?
 *
 * Rejects, rather than sanitises: absolute paths, drive letters, UNC prefixes, any `..` or `.`
 * segment, backslashes (illegal as a ZIP separator, and the classic Windows traversal vector),
 * control characters including NUL, empty names and absurd lengths.
 *
 * Sanitising is not offered on purpose. "Strip the `..`" is how `....//` bypasses get written.
 */
export function isSafeZipEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_ENTRY_NAME_LENGTH) return false
  if (CONTROL_CHARS.test(name)) return false
  if (name.includes('\\')) return false
  if (name.startsWith('/')) return false
  if (WINDOWS_DRIVE.test(name)) return false
  if (name.endsWith('/')) return false // a directory entry, never something we read
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/**
 * Resolve a `.rels` `Target` against the directory holding the `.rels` file.
 *
 * `ppt/slides/_rels/slide1.xml.rels` targets are relative to `ppt/slides/`, so `../media/i.png`
 * becomes `ppt/media/i.png`. Returns `null` when the target escapes the package root or the
 * result is not a safe entry name — a target of `../../../../../../etc/passwd` resolves above the
 * root and is refused here rather than anywhere downstream.
 */
export function resolveRelativeEntry(baseDir: string, target: string): string | null {
  if (target.length === 0 || target.length > MAX_ENTRY_NAME_LENGTH) return null
  if (CONTROL_CHARS.test(target)) return null
  const normalisedTarget = target.replace(/\\/g, '/')
  if (normalisedTarget.startsWith('/') || WINDOWS_DRIVE.test(normalisedTarget)) return null

  const segments = baseDir.length === 0 ? [] : baseDir.split('/').filter((s) => s.length > 0)
  for (const segment of normalisedTarget.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null // escapes the package root
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const resolved = segments.join('/')
  return isSafeZipEntryName(resolved) ? resolved : null
}

// ---------------------------------------------------------------------------
// ZIP central directory — parsed by hand, so nothing is inflated to learn the sizes
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x0605_4b50
const CENTRAL_SIGNATURE = 0x0201_4b50
const EOCD_FIXED_SIZE = 22
const CENTRAL_FIXED_SIZE = 46
const ZIP64_SENTINEL_32 = 0xffff_ffff
const ZIP64_SENTINEL_16 = 0xffff
/** The ZIP local-file-header magic; also the first four bytes of every `.pptx`. */
export const ZIP_MAGIC: readonly number[] = [0x50, 0x4b, 0x03, 0x04]

/** Do these bytes start with the ZIP local-file-header magic (`PK\x03\x04`)? */
export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_MAGIC.length) return false
  return ZIP_MAGIC.every((byte, i) => bytes[i] === byte)
}

function findEocdOffset(view: DataView, length: number): number {
  // The EOCD is at the very end unless there is a ZIP comment, which is capped at 65535 bytes.
  const earliest = Math.max(0, length - EOCD_FIXED_SIZE - 0xffff)
  for (let offset = length - EOCD_FIXED_SIZE; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Read the archive's central directory and enforce every size bound.
 *
 * This inflates nothing. It is the gate that must pass before any decompression happens, which is
 * what makes "refuse rather than allocate" true rather than aspirational.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  overrides?: Partial<PptxLimits>
): Result<ZipDirectory> {
  const limits = resolveLimits(overrides)

  if (bytes.length > limits.maxPackageBytes) {
    return err(
      ErrorCode.INVALID_ARG,
      `file is larger than the ${Math.round(limits.maxPackageBytes / (1024 * 1024))} MB import limit`,
      `${bytes.length} bytes`
    )
  }
  if (!hasZipMagic(bytes)) {
    return err(ErrorCode.INVALID_ARG, 'not a PowerPoint file (missing ZIP signature)')
  }
  if (bytes.length < EOCD_FIXED_SIZE) {
    return err(ErrorCode.INVALID_ARG, 'file is too short to be a ZIP archive')
  }

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findEocdOffset(view, bytes.length)
    if (eocd < 0) {
      return err(ErrorCode.INVALID_ARG, 'ZIP end-of-central-directory record not found')
    }

    const totalEntries = view.getUint16(eocd + 10, true)
    const directorySize = view.getUint32(eocd + 12, true)
    const directoryOffset = view.getUint32(eocd + 16, true)

    if (totalEntries === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32) {
      return err(ErrorCode.INVALID_ARG, 'ZIP64 archives are not supported')
    }
    if (totalEntries > limits.maxEntries) {
      return err(
        ErrorCode.INVALID_ARG,
        `archive declares ${totalEntries} entries, above the ${limits.maxEntries} limit`
      )
    }
    if (directoryOffset + directorySize > bytes.length) {
      return err(ErrorCode.INVALID_ARG, 'ZIP central directory is truncated')
    }

    const entries: ZipEntry[] = []
    let totalUncompressedBytes = 0
    let cursor = directoryOffset

    for (let i = 0; i < totalEntries; i += 1) {
      if (cursor + CENTRAL_FIXED_SIZE > bytes.length) {
        return err(ErrorCode.INVALID_ARG, 'ZIP central directory is truncated')
      }
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        return err(ErrorCode.INVALID_ARG, 'ZIP central directory is corrupt')
      }

      const method = view.getUint16(cursor + 10, true)
      const compressedSize = view.getUint32(cursor + 20, true)
      const uncompressedSize = view.getUint32(cursor + 24, true)
      const nameLength = view.getUint16(cursor + 28, true)
      const extraLength = view.getUint16(cursor + 30, true)
      const commentLength = view.getUint16(cursor + 32, true)
      const localOffset = view.getUint32(cursor + 42, true)

      if (
        compressedSize === ZIP64_SENTINEL_32 ||
        uncompressedSize === ZIP64_SENTINEL_32 ||
        localOffset === ZIP64_SENTINEL_32
      ) {
        return err(ErrorCode.INVALID_ARG, 'ZIP64 archives are not supported')
      }

      const nameStart = cursor + CENTRAL_FIXED_SIZE
      if (nameStart + nameLength > bytes.length) {
        return err(ErrorCode.INVALID_ARG, 'ZIP central directory is truncated')
      }
      const name = decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength))

      // Directory entries are the one legitimate name ending in `/`; skip them silently. Anything
      // else that fails the name check is an attack or a corrupt file and refuses the whole import,
      // because a deck containing `../../x` is not a deck we want to be clever about.
      if (!name.endsWith('/')) {
        if (!isSafeZipEntryName(name)) {
          return err(
            ErrorCode.INVALID_ARG,
            'archive contains an unsafe entry name and was refused',
            `entry #${i}`
          )
        }
        if (uncompressedSize > limits.maxEntryBytes) {
          return err(
            ErrorCode.INVALID_ARG,
            `archive entry declares ${uncompressedSize} bytes, above the per-entry limit`,
            name
          )
        }
        if (
          uncompressedSize > limits.ratioCheckFloorBytes &&
          compressedSize > 0 &&
          uncompressedSize / compressedSize > limits.maxCompressionRatio
        ) {
          return err(
            ErrorCode.INVALID_ARG,
            'archive entry has an implausible compression ratio and was refused as a zip bomb',
            name
          )
        }
        totalUncompressedBytes += uncompressedSize
        if (totalUncompressedBytes > limits.maxTotalBytes) {
          return err(
            ErrorCode.INVALID_ARG,
            `archive declares more than ${Math.round(limits.maxTotalBytes / (1024 * 1024))} MB of content and was refused as a zip bomb`
          )
        }
        entries.push({ name, compressedSize, uncompressedSize, method })
      }

      cursor += CENTRAL_FIXED_SIZE + nameLength + extraLength + commentLength
    }

    return ok({ entries, totalUncompressedBytes })
  } catch (cause) {
    return err(
      ErrorCode.INVALID_ARG,
      'could not read the PowerPoint file',
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}

// ---------------------------------------------------------------------------
// Bounded extraction
// ---------------------------------------------------------------------------

const decoder = new TextDecoder('utf-8')

function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/**
 * Inflate exactly the named entries and nothing else.
 *
 * The name list must already have come out of {@link readZipDirectory}, so it is bounded and
 * validated. `fflate`'s `filter` means untouched entries are never decompressed at all, which is
 * why a deck with a 200 MB embedded video costs nothing when we only wanted three XML files.
 */
export function extractEntries(
  bytes: Uint8Array,
  wanted: readonly string[],
  overrides?: Partial<PptxLimits>
): Result<Map<string, Uint8Array>> {
  const limits = resolveLimits(overrides)
  if (wanted.length === 0) return ok(new Map())

  const wantedSet = new Set(wanted)
  let budget = limits.maxTotalBytes
  try {
    const unzipped = unzipSync(bytes, {
      filter: (file) => {
        if (!wantedSet.has(file.name)) return false
        if (file.originalSize > limits.maxEntryBytes) return false
        budget -= file.originalSize
        return budget >= 0
      }
    })
    if (budget < 0) {
      return err(ErrorCode.INVALID_ARG, 'selected archive entries exceed the extraction budget')
    }
    const out = new Map<string, Uint8Array>()
    for (const [name, content] of Object.entries(unzipped)) {
      out.set(name, content)
    }
    return ok(out)
  } catch (cause) {
    return err(
      ErrorCode.INVALID_ARG,
      'could not decompress the PowerPoint file',
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}

// ---------------------------------------------------------------------------
// Slide enumeration
// ---------------------------------------------------------------------------

const SLIDE_ENTRY = /^ppt\/slides\/slide(\d+)\.xml$/
const MEDIA_PREFIX = 'ppt/media/'

/**
 * Numeric, not lexicographic, ordering of slide entries.
 *
 * Exported because this is the ordering bug that silently scrambles a service: a plain string sort
 * puts `slide10.xml` before `slide2.xml`, so slide 10 fires third and nobody notices until the
 * congregation is looking at the wrong hymn. `pptx.test.ts` asserts this directly.
 */
export function slideEntryNumber(entryName: string): number | null {
  const match = SLIDE_ENTRY.exec(entryName)
  if (match === null) return null
  const digits = match[1]
  if (digits === undefined || digits.length > 9) return null
  const value = Number.parseInt(digits, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** The `_rels` companion for a slide entry. */
function relsEntryFor(slideEntry: string): string {
  const slash = slideEntry.lastIndexOf('/')
  const dir = slideEntry.slice(0, slash)
  const file = slideEntry.slice(slash + 1)
  return `${dir}/_rels/${file}.rels`
}

const RELATIONSHIP_TAG = /<Relationship\b[^>]*\/?>/g
const ATTR_ID = /\bId="([^"]{1,64})"/
const ATTR_TYPE = /\bType="([^"]{1,300})"/
const ATTR_TARGET = /\bTarget="([^"]{1,512})"/
const ATTR_TARGET_MODE = /\bTargetMode="([^"]{1,32})"/

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'tif',
  'tiff',
  'emf',
  'wmf',
  'svg'
])

function looksLikeImageEntry(entryName: string): boolean {
  const dot = entryName.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(entryName.slice(dot + 1).toLowerCase())
}

/**
 * Parse one slide's `.rels` file into an ordered id -> media-entry map.
 *
 * This is the mapping `docs/v2-notes/PLAN_LESSONS.md` records as never having been parsed in
 * rhema_v2, and therefore the reason its per-slide images were always empty.
 *
 * External targets (`TargetMode="External"`) are dropped — they point at a URL, not at package
 * content — as is anything that resolves outside `ppt/media/`.
 */
export function parseSlideRels(xml: string, relsEntryName: string): Map<string, string> {
  const out = new Map<string, string>()
  const slash = relsEntryName.lastIndexOf('/_rels/')
  const baseDir = slash < 0 ? '' : relsEntryName.slice(0, slash)

  RELATIONSHIP_TAG.lastIndex = 0
  let tag: RegExpExecArray | null = RELATIONSHIP_TAG.exec(xml)
  while (tag !== null) {
    const raw = tag[0]
    const id = ATTR_ID.exec(raw)?.[1]
    const target = ATTR_TARGET.exec(raw)?.[1]
    const type = ATTR_TYPE.exec(raw)?.[1] ?? ''
    const mode = ATTR_TARGET_MODE.exec(raw)?.[1] ?? 'Internal'

    if (id !== undefined && target !== undefined && mode !== 'External') {
      const resolved = resolveRelativeEntry(baseDir, target)
      if (
        resolved !== null &&
        resolved.startsWith(MEDIA_PREFIX) &&
        (type.endsWith('/image') || looksLikeImageEntry(resolved))
      ) {
        out.set(id, resolved)
      }
    }
    tag = RELATIONSHIP_TAG.exec(xml)
  }
  return out
}

/**
 * Pull the relationship ids a slide's pictures are drawn with, in document order.
 *
 * **This reads attribute values only.** The regex matches `r:embed="rId3"` / `r:link="rId3"`,
 * which are relationship ids — never `<a:t>` text nodes. Nothing derived from slide text is
 * returned, retained, or logged (Standing Rule 4).
 */
export function parseSlideEmbedIds(xml: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const pattern = /\br:(?:embed|link)="([^"]{1,64})"/g
  let match: RegExpExecArray | null = pattern.exec(xml)
  while (match !== null) {
    const id = match[1]
    if (id !== undefined && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    match = pattern.exec(xml)
  }
  return ids
}

/**
 * Read a `.pptx` package: which slides exist, in what order, and which pictures each one owns.
 *
 * Returns structure only. There is no code path in this function that produces slide text.
 */
export function readPptx(bytes: Uint8Array, overrides?: Partial<PptxLimits>): Result<PptxPackage> {
  const limits = resolveLimits(overrides)

  const directory = readZipDirectory(bytes, limits)
  if (!directory.ok) return directory

  const warnings: string[] = []
  const byName = new Map<string, ZipEntry>()
  for (const entry of directory.value.entries) byName.set(entry.name, entry)

  const slideEntries: Array<{ readonly name: string; readonly number: number }> = []
  for (const entry of directory.value.entries) {
    const number = slideEntryNumber(entry.name)
    if (number !== null) slideEntries.push({ name: entry.name, number })
  }

  if (slideEntries.length === 0) {
    return err(
      ErrorCode.NOT_FOUND,
      'no slides were found in this file — it may not be a PowerPoint presentation'
    )
  }
  if (slideEntries.length > limits.maxSlides) {
    return err(
      ErrorCode.INVALID_ARG,
      `this deck has ${slideEntries.length} slides, above the ${limits.maxSlides}-slide import limit`
    )
  }

  // NUMERIC order. A string sort would place slide10 before slide2 and scramble the service.
  slideEntries.sort((a, b) => a.number - b.number)

  // One bounded extraction for every slide XML plus every rels file we might need.
  const wanted: string[] = []
  for (const slide of slideEntries) {
    const entry = byName.get(slide.name)
    if (entry !== undefined && entry.uncompressedSize <= limits.maxSlideXmlBytes) {
      wanted.push(slide.name)
    }
    const rels = relsEntryFor(slide.name)
    const relsEntry = byName.get(rels)
    if (relsEntry !== undefined && relsEntry.uncompressedSize <= limits.maxRelsBytes) {
      wanted.push(rels)
    }
  }

  const extracted = extractEntries(bytes, wanted, limits)
  if (!extracted.ok) return extracted

  const slides: PptxSlideInfo[] = []
  for (const [position, slide] of slideEntries.entries()) {
    const relsName = relsEntryFor(slide.name)
    const relsBytes = extracted.value.get(relsName)
    const relMap =
      relsBytes === undefined ? new Map<string, string>() : parseSlideRels(decodeUtf8(relsBytes), relsName)

    const media: PptxMediaRef[] = []
    const push = (relationshipId: string, entryName: string): void => {
      if (media.length >= limits.maxMediaPerSlide) return
      if (media.some((m) => m.entryName === entryName)) return
      const entry = byName.get(entryName)
      if (entry === undefined) {
        warnings.push(`slide ${position + 1} references a picture that is not in the file`)
        return
      }
      media.push({ relationshipId, entryName, size: entry.uncompressedSize })
    }

    const slideBytes = extracted.value.get(slide.name)
    if (slideBytes !== undefined) {
      // Attribute scan only — see parseSlideEmbedIds. The decoded XML never leaves this scope.
      for (const id of parseSlideEmbedIds(decodeUtf8(slideBytes))) {
        const target = relMap.get(id)
        if (target !== undefined) push(id, target)
      }
    }

    // Fallback: a slide whose XML was too large to scan, or whose pictures are referenced in a way
    // the attribute scan did not see, still gets its rels-declared images. Slide rels only ever
    // describe that slide, so this cannot borrow another slide's picture.
    if (media.length === 0) {
      for (const [id, target] of relMap) push(id, target)
    }

    slides.push({
      index: position + 1,
      slideNumber: slide.number,
      entryName: slide.name,
      media
    })
  }

  return ok({
    slides,
    entryCount: directory.value.entries.length,
    totalUncompressedBytes: directory.value.totalUncompressedBytes,
    warnings
  })
}
