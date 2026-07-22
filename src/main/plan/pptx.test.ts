/**
 * `pptx.ts` — the hostile-input tests.
 *
 * Every `.pptx` used here is **built in the test with `fflate`**: a handful of XML entries plus a
 * 67-byte 1x1 PNG. No binary fixture is committed, so there is nothing in the repo that a future
 * reader has to trust, and a malicious-archive case can be constructed byte-exactly rather than
 * approximated.
 *
 * Standing Rule 4: every string that stands in for slide content is an obvious placeholder
 * (`PLACEHOLDER TITLE`, `SLIDE 1`). There is no real hymn, verse or sermon text anywhere in this
 * file, and one of the tests asserts that no such string can escape the parser even when present
 * in the input.
 */

import { strFromU8, strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PPTX_LIMITS,
  extractEntries,
  hasZipMagic,
  isSafeZipEntryName,
  parseSlideEmbedIds,
  parseSlideRels,
  readPptx,
  readZipDirectory,
  resolveLimits,
  resolveRelativeEntry,
  slideEntryNumber
} from './pptx'

// ---------------------------------------------------------------------------
// Fixtures, built here rather than committed
// ---------------------------------------------------------------------------

/** A real, minimal 1x1 PNG. The smallest thing that is honestly an image. */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
)

/**
 * A slide XML body.
 *
 * `placeholderText` goes into an `<a:t>` node exactly as PowerPoint would put slide text there,
 * so the "no slide text escapes" test has something real to catch. It is always a placeholder.
 */
function slideXml(options: { embedIds?: readonly string[]; placeholderText?: string }): string {
  const pictures = (options.embedIds ?? [])
    .map(
      (id) =>
        `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`
    )
    .join('')
  const text =
    options.placeholderText === undefined
      ? ''
      : `<p:sp><p:txBody><a:p><a:r><a:t>${options.placeholderText}</a:t></a:r></a:p></p:txBody></p:sp>`
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>${text}${pictures}</p:spTree></p:cSld></p:sld>`
}

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

function relsXml(relationships: ReadonlyArray<{ id: string; target: string; type?: string; mode?: string }>): string {
  const body = relationships
    .map((rel) => {
      const mode = rel.mode === undefined ? '' : ` TargetMode="${rel.mode}"`
      return `<Relationship Id="${rel.id}" Type="${rel.type ?? IMAGE_REL_TYPE}" Target="${rel.target}"${mode}/>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="rel">${body}</Relationships>`
}

type ZipFiles = Record<string, Uint8Array>

/** Build a `.pptx` from a plain map of entry name -> bytes. */
function buildZip(files: ZipFiles): Uint8Array {
  return zipSync(files, { level: 6 })
}

interface DeckSlideSpec {
  /** Number used in the entry name: `slide<n>.xml`. */
  readonly number: number
  /** Media entry names this slide's `_rels` points at, in order. */
  readonly images?: readonly string[]
  readonly placeholderText?: string
  /** Omit the `_rels` file entirely, as a deck with no relationships would. */
  readonly omitRels?: boolean
}

/** Assemble a deck whose slides own the pictures named in each spec. */
function buildDeck(slides: readonly DeckSlideSpec[], extra: ZipFiles = {}): Uint8Array {
  const files: ZipFiles = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    ...extra
  }
  const mediaNeeded = new Set<string>()

  for (const slide of slides) {
    const images = slide.images ?? []
    const rels = images.map((entry, i) => ({
      id: `rId${i + 2}`,
      target: `../media/${entry}`
    }))
    files[`ppt/slides/slide${slide.number}.xml`] = strToU8(
      slideXml({
        embedIds: rels.map((r) => r.id),
        ...(slide.placeholderText === undefined ? {} : { placeholderText: slide.placeholderText })
      })
    )
    if (slide.omitRels !== true) {
      files[`ppt/slides/_rels/slide${slide.number}.xml.rels`] = strToU8(relsXml(rels))
    }
    for (const entry of images) mediaNeeded.add(entry)
  }
  for (const entry of mediaNeeded) {
    files[`ppt/media/${entry}`] = PNG_1X1
  }
  return buildZip(files)
}

/** Index into a readonly array and fail loudly rather than returning `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`expected an item at index ${index}`)
  return value
}

// ---------------------------------------------------------------------------
// Entry-name safety
// ---------------------------------------------------------------------------

describe('isSafeZipEntryName', () => {
  it('accepts the names a real package uses', () => {
    expect(isSafeZipEntryName('ppt/slides/slide1.xml')).toBe(true)
    expect(isSafeZipEntryName('ppt/slides/_rels/slide1.xml.rels')).toBe(true)
    expect(isSafeZipEntryName('ppt/media/image1.png')).toBe(true)
    expect(isSafeZipEntryName('[Content_Types].xml')).toBe(true)
  })

  it('rejects traversal, absolute paths, drive letters and UNC', () => {
    expect(isSafeZipEntryName('../../../Windows/System32/x')).toBe(false)
    expect(isSafeZipEntryName('ppt/../../x')).toBe(false)
    expect(isSafeZipEntryName('/etc/passwd')).toBe(false)
    expect(isSafeZipEntryName('C:/Windows/x')).toBe(false)
    expect(isSafeZipEntryName('C:\\Windows\\x')).toBe(false)
    expect(isSafeZipEntryName('\\\\server\\share\\x')).toBe(false)
    expect(isSafeZipEntryName('ppt\\media\\image1.png')).toBe(false)
  })

  it('rejects a `..` segment even when it is dressed up', () => {
    // The point of rejecting rather than stripping: a stripper turns `....//` into `../`.
    expect(isSafeZipEntryName('a/../b')).toBe(false)
    expect(isSafeZipEntryName('./a')).toBe(false)
    expect(isSafeZipEntryName('a//b')).toBe(false)
  })

  it('rejects control characters, empty names and absurd lengths', () => {
    expect(isSafeZipEntryName('')).toBe(false)
    expect(isSafeZipEntryName(`a${String.fromCharCode(0)}b`)).toBe(false)
    expect(isSafeZipEntryName(`a${String.fromCharCode(10)}b`)).toBe(false)
    expect(isSafeZipEntryName('a'.repeat(513))).toBe(false)
  })
})

describe('resolveRelativeEntry', () => {
  it('resolves a slide rels target the way the OPC spec says', () => {
    expect(resolveRelativeEntry('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png')
    expect(resolveRelativeEntry('ppt/slides', 'sub/image1.png')).toBe('ppt/slides/sub/image1.png')
  })

  it('refuses a target that climbs above the package root', () => {
    expect(resolveRelativeEntry('ppt/slides', '../../../../../../etc/passwd')).toBeNull()
    expect(resolveRelativeEntry('ppt/slides', '/etc/passwd')).toBeNull()
    expect(resolveRelativeEntry('ppt/slides', 'C:\\x')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Slide ordering — the bug that silently scrambles a service
// ---------------------------------------------------------------------------

describe('slide ordering', () => {
  it('parses the slide number out of the entry name', () => {
    expect(slideEntryNumber('ppt/slides/slide1.xml')).toBe(1)
    expect(slideEntryNumber('ppt/slides/slide10.xml')).toBe(10)
    expect(slideEntryNumber('ppt/slides/_rels/slide1.xml.rels')).toBeNull()
    expect(slideEntryNumber('ppt/media/image1.png')).toBeNull()
  })

  it('sorts slide10 AFTER slide2, which a string sort does not', () => {
    // Guard the premise: a lexicographic sort really does get this wrong.
    const lexicographic = ['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml'].sort()
    expect(at(lexicographic, 0)).toBe('ppt/slides/slide10.xml')

    // Entries are deliberately supplied out of order, and with 10 before 2.
    const deck = buildDeck([{ number: 10 }, { number: 2 }, { number: 1 }, { number: 11 }])
    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.slides.map((s) => s.slideNumber)).toEqual([1, 2, 10, 11])
    expect(parsed.value.slides.map((s) => s.index)).toEqual([1, 2, 3, 4])

    const positionOf = (n: number): number =>
      parsed.value.slides.findIndex((s) => s.slideNumber === n)
    expect(positionOf(10)).toBeGreaterThan(positionOf(2))
  })
})

// ---------------------------------------------------------------------------
// The `_rels` media mapping — the documented rhema_v2 gotcha
// ---------------------------------------------------------------------------

describe('per-slide _rels media mapping', () => {
  it('maps r:embed ids to ppt/media entries, per slide, not into a flat bucket', () => {
    const deck = buildDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] },
      { number: 3, images: ['image3.png', 'image1.png'] }
    ])
    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const [one, two, three] = [
      at(parsed.value.slides, 0),
      at(parsed.value.slides, 1),
      at(parsed.value.slides, 2)
    ]
    expect(one.media.map((m) => m.entryName)).toEqual(['ppt/media/image1.png'])
    expect(two.media.map((m) => m.entryName)).toEqual(['ppt/media/image2.png'])
    expect(three.media.map((m) => m.entryName)).toEqual([
      'ppt/media/image3.png',
      'ppt/media/image1.png'
    ])
    expect(at(one.media, 0).relationshipId).toBe('rId2')
    expect(at(one.media, 0).size).toBe(PNG_1X1.length)
  })

  it('parses the relationships file directly', () => {
    const xml = relsXml([
      { id: 'rId1', target: '../slideLayouts/slideLayout1.xml', type: 'x/slideLayout' },
      { id: 'rId2', target: '../media/image7.png' },
      { id: 'rId3', target: 'https://example.invalid/x.png', mode: 'External' },
      { id: 'rId4', target: '../../../../etc/passwd' }
    ])
    const map = parseSlideRels(xml, 'ppt/slides/_rels/slide1.xml.rels')
    expect([...map.entries()]).toEqual([['rId2', 'ppt/media/image7.png']])
  })

  it('reads embed ids in document order and de-duplicates them', () => {
    const ids = parseSlideEmbedIds(slideXml({ embedIds: ['rId5', 'rId2', 'rId5'] }))
    expect(ids).toEqual(['rId5', 'rId2'])
  })

  it('drops a relationship whose media entry is absent, with a warning and no crash', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({ embedIds: ['rId2'] })),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(
        relsXml([{ id: 'rId2', target: '../media/missing.png' }])
      )
    })
    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(at(parsed.value.slides, 0).media).toEqual([])
    expect(parsed.value.warnings.join(' ')).toContain('slide 1')
  })

  it('falls back to the rels-declared images when the slide XML declares no embed', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({ placeholderText: 'PLACEHOLDER TITLE' })),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(
        relsXml([{ id: 'rId2', target: '../media/image1.png' }])
      ),
      'ppt/media/image1.png': PNG_1X1
    })
    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(at(parsed.value.slides, 0).media.map((m) => m.entryName)).toEqual([
      'ppt/media/image1.png'
    ])
  })
})

// ---------------------------------------------------------------------------
// Text-only slides
// ---------------------------------------------------------------------------

describe('text-only slides', () => {
  it('yields no media but never fails the deck', () => {
    const deck = buildDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, placeholderText: 'PLACEHOLDER TITLE', omitRels: true },
      { number: 3, images: ['image3.png'] }
    ])
    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.slides).toHaveLength(3)
    expect(at(parsed.value.slides, 1).media).toEqual([])
    expect(at(parsed.value.slides, 0).media).toHaveLength(1)
    expect(at(parsed.value.slides, 2).media).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Standing Rule 4
// ---------------------------------------------------------------------------

describe('Standing Rule 4 — slide text never escapes the parser', () => {
  it('returns no slide text anywhere in the result, even though the XML contains it', () => {
    const marker = 'PLACEHOLDER TITLE ZZQX'
    const deck = buildDeck([
      { number: 1, images: ['image1.png'], placeholderText: marker },
      { number: 2, placeholderText: `${marker} TWO` }
    ])
    // The marker really is in the package, so this test is not vacuous.
    const raw = readZipDirectory(deck)
    expect(raw.ok).toBe(true)
    const roundTripped = extractEntries(deck, ['ppt/slides/slide1.xml'])
    expect(roundTripped.ok).toBe(true)
    if (roundTripped.ok) {
      const slide = roundTripped.value.get('ppt/slides/slide1.xml')
      expect(slide).toBeDefined()
      expect(strFromU8(slide as Uint8Array)).toContain(marker)
    }

    const parsed = readPptx(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(JSON.stringify(parsed.value)).not.toContain('PLACEHOLDER')
    expect(JSON.stringify(parsed.value)).not.toContain('ZZQX')
    // And structurally: the slide shape has no text-bearing field at all.
    expect(Object.keys(at(parsed.value.slides, 0)).sort()).toEqual([
      'entryName',
      'index',
      'media',
      'slideNumber'
    ])
  })
})

// ---------------------------------------------------------------------------
// Hostile archives
// ---------------------------------------------------------------------------

describe('hostile archives', () => {
  it('refuses anything without the ZIP magic', () => {
    expect(hasZipMagic(strToU8('not a zip'))).toBe(false)
    const parsed = readPptx(strToU8('definitely not a pptx'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('not a PowerPoint file')
  })

  it('refuses an archive containing a path-traversal entry name', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      '../../../Windows/System32/evil.txt': strToU8('OWNED')
    })
    const parsed = readZipDirectory(deck)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('unsafe entry name')

    // And the whole import refuses, rather than importing the "safe" half.
    expect(readPptx(deck).ok).toBe(false)
  })

  it('refuses an absolute entry name', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      '/etc/passwd': strToU8('root:x:0:0')
    })
    expect(readZipDirectory(deck).ok).toBe(false)
  })

  it('refuses a zip bomb on declared total size, before inflating anything', () => {
    // 512 KiB of zeros compresses to almost nothing; the declared total is what refuses it.
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      'ppt/media/image1.png': new Uint8Array(512 * 1024)
    })
    const parsed = readZipDirectory(deck, { maxTotalBytes: 64 * 1024 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('zip bomb')
  })

  it('refuses a zip bomb on compression ratio under the DEFAULT limits', () => {
    // 4 MiB of zeros deflates to a few kilobytes: a ratio around 1000:1, where real presentation
    // XML runs 5-15:1 and media runs about 1:1. No limits are overridden here on purpose.
    const bomb = new Uint8Array(4 * 1024 * 1024)
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      'ppt/media/image1.png': bomb
    })
    expect(deck.length).toBeLessThan(bomb.length / DEFAULT_PPTX_LIMITS.maxCompressionRatio)

    const parsed = readZipDirectory(deck)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('zip bomb')
  })

  it('refuses an entry that alone exceeds the per-entry cap', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      'ppt/media/image1.png': new Uint8Array(200 * 1024)
    })
    const parsed = readZipDirectory(deck, { maxEntryBytes: 1024 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('per-entry limit')
  })

  it('refuses an archive with too many entries', () => {
    const files: ZipFiles = { 'ppt/slides/slide1.xml': strToU8(slideXml({})) }
    for (let i = 0; i < 10; i += 1) files[`ppt/media/image${i}.png`] = PNG_1X1

    const parsed = readZipDirectory(buildZip(files), { maxEntries: 4 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('entries')
  })

  it('refuses a deck with more slides than the slide cap', () => {
    const slides = Array.from({ length: 6 }, (_, i) => ({ number: i + 1 }))
    const deck = buildDeck(slides)

    expect(readPptx(deck, { maxSlides: 3 }).ok).toBe(false)
    const message = readPptx(deck, { maxSlides: 3 })
    if (message.ok) return
    expect(message.error.message).toContain('slide import limit')

    // The same deck is fine under the real cap.
    expect(readPptx(deck).ok).toBe(true)
  })

  it('refuses a package larger than the file cap', () => {
    const deck = buildDeck([{ number: 1 }])
    const parsed = readZipDirectory(deck, { maxPackageBytes: 32 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('import limit')
  })

  it('reports a ZIP with no slides as a not-found, not a crash', () => {
    const parsed = readPptx(buildZip({ 'word/document.xml': strToU8('<x/>') }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('no slides')
  })

  it('never throws on truncated or corrupt input', () => {
    const deck = buildDeck([{ number: 1, images: ['image1.png'] }])
    for (const cut of [4, 32, deck.length - 8, deck.length - 1]) {
      const truncated = deck.subarray(0, cut)
      expect(() => readPptx(truncated)).not.toThrow()
      expect(readPptx(truncated).ok).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Bounded extraction
// ---------------------------------------------------------------------------

describe('extractEntries', () => {
  it('inflates only what was asked for', () => {
    const deck = buildDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] }
    ])
    const extracted = extractEntries(deck, ['ppt/media/image2.png'])
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) return
    expect([...extracted.value.keys()]).toEqual(['ppt/media/image2.png'])
    expect(extracted.value.get('ppt/media/image2.png')).toEqual(PNG_1X1)
  })

  it('returns an empty map for an empty request without touching the archive', () => {
    const extracted = extractEntries(new Uint8Array(0), [])
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) return
    expect(extracted.value.size).toBe(0)
  })

  it('refuses when the selected entries exceed the budget', () => {
    const deck = buildZip({
      'ppt/slides/slide1.xml': strToU8(slideXml({})),
      'ppt/media/image1.png': new Uint8Array(128 * 1024)
    })
    const extracted = extractEntries(deck, ['ppt/media/image1.png'], { maxTotalBytes: 1024 })
    expect(extracted.ok).toBe(false)
  })
})

describe('resolveLimits', () => {
  it('defaults everything and lets one bound be overridden in isolation', () => {
    expect(resolveLimits()).toEqual(DEFAULT_PPTX_LIMITS)
    expect(resolveLimits({ maxSlides: 7 })).toEqual({ ...DEFAULT_PPTX_LIMITS, maxSlides: 7 })
  })

  it('caps slides at 500 by default, so a pathological deck cannot hang a service', () => {
    expect(DEFAULT_PPTX_LIMITS.maxSlides).toBe(500)
  })
})
