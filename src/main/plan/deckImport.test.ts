/**
 * `deckImport.ts` — importer detection, the two backends, and the failure modes that must not
 * cost an operator their service.
 *
 * Decks are built here with `fflate` (a few XML entries plus a 67-byte 1x1 PNG); no binary fixture
 * is committed. Placeholder strings only — `PLACEHOLDER TITLE`, `SLIDE 1` — never real hymn,
 * verse or sermon text (Standing Rule 4), and one test asserts none of it can reach a cue.
 *
 * The LibreOffice path is exercised through the injected {@link DeckSpawn} seam, because
 * LibreOffice is not installed on the build machine and cannot be (see `HUMAN_TASKS.md`). The
 * fallback path is exercised for real, against a real temp directory.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cueSchema } from '@shared/plan'

import {
  BACKEND_EMBEDDED_MEDIA,
  BACKEND_LIBREOFFICE,
  NO_RENDERER_DETAIL,
  SOFFICE_ENV_VAR,
  canImportWithoutRenderer,
  detectImporter,
  importDeck,
  missingAssetNote,
  resolveWithinDir,
  safeDeckStem,
  sniffImageExtension,
  sofficeCandidates
} from './deckImport'
import type { DeckSpawn } from './deckImport'
import type { DeckImportProgress } from '@shared/ipc'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
)

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

function slideXml(embedIds: readonly string[], placeholderText?: string): string {
  const pictures = embedIds
    .map((id) => `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`)
    .join('')
  const text =
    placeholderText === undefined
      ? ''
      : `<p:sp><p:txBody><a:p><a:r><a:t>${placeholderText}</a:t></a:r></a:p></p:txBody></p:sp>`
  return `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>${text}${pictures}</p:spTree></p:cSld></p:sld>`
}

interface SlideSpec {
  readonly number: number
  readonly images?: readonly string[]
  readonly placeholderText?: string
}

function buildDeckBytes(slides: readonly SlideSpec[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>')
  }
  const media = new Set<string>()
  for (const slide of slides) {
    const images = slide.images ?? []
    const ids = images.map((_, i) => `rId${i + 2}`)
    files[`ppt/slides/slide${slide.number}.xml`] = strToU8(slideXml(ids, slide.placeholderText))
    files[`ppt/slides/_rels/slide${slide.number}.xml.rels`] = strToU8(
      `<?xml version="1.0"?><Relationships xmlns="rel">${images
        .map(
          (entry, i) =>
            `<Relationship Id="rId${i + 2}" Type="${IMAGE_REL_TYPE}" Target="../media/${entry}"/>`
        )
        .join('')}</Relationships>`
    )
    for (const entry of images) media.add(entry)
  }
  for (const entry of media) files[`ppt/media/${entry}`] = PNG_1X1
  return zipSync(files, { level: 6 })
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`expected an item at index ${index}`)
  return value
}

let workDir = ''
let assetDir = ''
let deckPath = ''
let counter = 0
const nextId = (): string => `cue-${(counter += 1)}`

beforeEach(async () => {
  counter = 0
  workDir = await mkdtemp(join(tmpdir(), 'verger-deck-test-'))
  assetDir = join(workDir, 'assets')
  deckPath = join(workDir, 'Sunday Service 2026-07-26.pptx')
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

async function writeDeck(slides: readonly SlideSpec[], name = deckPath): Promise<string> {
  await writeFile(name, buildDeckBytes(slides))
  return name
}

/** A status that pretends LibreOffice is present, for driving the renderer branch. */
const fakeRendererStatus = {
  available: true,
  backend: BACKEND_LIBREOFFICE,
  executablePath: 'C:\\fake\\soffice.exe',
  detail: null
} as const

/** A converter that writes `count` PNGs into whatever `--outdir` it was given. */
function fakeConverter(count: number): DeckSpawn {
  return async (_executable, args, _options) => {
    const outIndex = args.indexOf('--outdir')
    const outDir = args[outIndex + 1]
    if (outDir !== undefined) {
      for (let i = 1; i <= count; i += 1) {
        await writeFile(join(outDir, `render-${i}.png`), PNG_1X1)
      }
    }
    return { code: 0, timedOut: false, failure: null }
  }
}

// ---------------------------------------------------------------------------
// detectImporter
// ---------------------------------------------------------------------------

describe('detectImporter', () => {
  it('reports unavailable cleanly, with actionable copy, when no converter exists', () => {
    const status = detectImporter({
      env: { PATH: '/nowhere' },
      platform: 'win32',
      isFile: () => false
    })
    expect(status.available).toBe(false)
    expect(status.executablePath).toBeNull()
    expect(status.backend).toBe(BACKEND_EMBEDDED_MEDIA)
    expect(status.detail).toBe(NO_RENDERER_DETAIL)
    // The operator is told what to install, and what the reduced mode actually does.
    expect(status.detail).toContain('LibreOffice')
    expect(status.detail).toContain('libreoffice.org/download')
    expect(status.detail).toContain(SOFFICE_ENV_VAR)
    expect(status.detail).toContain('text-only')
  })

  it('is honest about this machine: no LibreOffice, so no renderer', () => {
    // The real probe, on the real machine, with no injection. LibreOffice is not installed here
    // and cannot be (HUMAN_TASKS.md), so this asserts the unavailable contract end to end. If a
    // future machine has LibreOffice, the `available` branch is asserted instead of failing.
    const status = detectImporter()
    if (status.available) {
      expect(status.executablePath).not.toBeNull()
      expect(status.backend).toBe(BACKEND_LIBREOFFICE)
      expect(status.detail).toBeNull()
    } else {
      expect(status.executablePath).toBeNull()
      expect(status.backend).toBe(BACKEND_EMBEDDED_MEDIA)
      expect(status.detail).toBe(NO_RENDERER_DETAIL)
    }
    // Whatever the machine, import is never simply impossible.
    expect(canImportWithoutRenderer(status)).toBe(true)
  })

  it('finds soffice on PATH', () => {
    const status = detectImporter({
      env: { PATH: '/opt/lo/bin' },
      platform: 'linux',
      isFile: (p) => p === '/opt/lo/bin/soffice'
    })
    expect(status).toEqual({
      available: true,
      backend: BACKEND_LIBREOFFICE,
      executablePath: '/opt/lo/bin/soffice',
      detail: null
    })
  })

  it('finds a Windows install that is not on PATH', () => {
    const expected = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
    const status = detectImporter({
      env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      platform: 'win32',
      isFile: (p) => p === expected
    })
    expect(status.available).toBe(true)
    expect(status.executablePath).toBe(expected)
  })

  it('honours the environment override first', () => {
    const status = detectImporter({
      env: { [SOFFICE_ENV_VAR]: '/custom/soffice', PATH: '/usr/bin' },
      platform: 'linux',
      isFile: () => true
    })
    expect(status.executablePath).toBe('/custom/soffice')
  })

  it('searches PATH and the usual install locations, never throwing on a weird PATH', () => {
    expect(() => sofficeCandidates({ env: {}, platform: 'win32' })).not.toThrow()
    const candidates = sofficeCandidates({ env: { PATH: '"C:\\q"' }, platform: 'win32' })
    expect(candidates).toContain('C:\\q\\soffice.exe')
    // The injected platform decides the separators, so this is the same on any host.
    const posix = sofficeCandidates({ env: { PATH: '/a:/b' }, platform: 'linux' })
    expect(posix).toContain('/a/soffice')
    expect(posix).toContain('/b/libreoffice')
  })
})

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

describe('resolveWithinDir', () => {
  it('accepts a relative path inside the asset folder', () => {
    const result = resolveWithinDir('/plans/assets', 'slides/deck-slide-001.png')
    expect(result.ok).toBe(true)
  })

  it('refuses traversal and absolute paths rather than sanitising them', () => {
    for (const bad of ['../outside.png', 'slides/../../outside.png', '../../../../etc/passwd']) {
      const result = resolveWithinDir('/plans/assets', bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('escapes')
    }
    const absolute = resolveWithinDir('/plans/assets', '/etc/passwd')
    expect(absolute.ok).toBe(false)
    expect(resolveWithinDir('/plans/assets', '').ok).toBe(false)
  })
})

describe('safeDeckStem', () => {
  it('reduces an arbitrary filename to something safe to embed in an asset name', () => {
    expect(safeDeckStem('C:\\decks\\Sunday Service 2026-07-26.pptx')).toBe(
      'Sunday-Service-2026-07-26'
    )
    expect(safeDeckStem('/x/../.. .pptx')).toBe('deck')
    expect(safeDeckStem('/x/---.pptx')).toBe('deck')
    // A dotfile has no extension, so the whole name is the stem; the leading dot is stripped.
    expect(safeDeckStem('/x/.pptx')).toBe('pptx')
    expect(safeDeckStem(`/x/${'a'.repeat(200)}.pptx`)).toHaveLength(40)
  })
})

describe('sniffImageExtension', () => {
  it('decides the extension from the bytes, not from the entry name', () => {
    expect(sniffImageExtension(PNG_1X1)).toBe('.png')
    expect(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('.jpg')
    expect(sniffImageExtension(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('.gif')
    expect(sniffImageExtension(strToU8('<svg/>'))).toBeNull()
    expect(sniffImageExtension(new Uint8Array(0))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The embedded-media backend — the path this machine actually has
// ---------------------------------------------------------------------------

describe('importDeck — embedded-media backend', () => {
  it('creates one manual slide cue per slide, in order, with images on disk', async () => {
    await writeDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] },
      { number: 10, images: ['image3.png'] }
    ])

    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.backend).toBe(BACKEND_EMBEDDED_MEDIA)
    expect(result.value.slidesTotal).toBe(3)
    expect(result.value.slidesWithAsset).toBe(3)
    expect(result.value.slidesMissingAsset).toEqual([])
    expect(result.value.cues.map((c) => c.label)).toEqual(['Slide 1', 'Slide 2', 'Slide 3'])

    for (const cue of result.value.cues) {
      expect(cue.type).toBe('slide')
      // Manual first: nothing imported is armed for automation (Phase 8 arms it later).
      expect(cue.trigger).toEqual({ mode: 'manual' })
      expect(cueSchema.safeParse(cue).success).toBe(true)
    }

    const payloads = result.value.cues.map((c) => c.payload as { asset: string; sourceSlide: number })
    expect(payloads.map((p) => p.sourceSlide)).toEqual([1, 2, 3])
    expect(at(payloads, 0).asset).toBe('slides/Sunday-Service-2026-07-26-slide-001.png')

    const written = (await readdir(join(assetDir, 'slides'))).sort()
    expect(written).toEqual([
      'Sunday-Service-2026-07-26-slide-001.png',
      'Sunday-Service-2026-07-26-slide-002.png',
      'Sunday-Service-2026-07-26-slide-003.png'
    ])
    expect(new Uint8Array(await readFile(join(assetDir, 'slides', at(written, 0))))).toEqual(PNG_1X1)
  })

  it('warns, in the operator\'s words, that pictures were extracted rather than rendered', async () => {
    await writeDeck([{ number: 1, images: ['image1.png'] }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.join(' ')).toContain('embedded pictures were extracted')
    expect(result.value.warnings.join(' ')).toContain('text-only slide will have no image')
  })

  it('keeps going when a slide yields no image — one bad slide never costs the deck', async () => {
    await writeDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, placeholderText: 'PLACEHOLDER TITLE' },
      { number: 3, images: ['image3.png'] }
    ])

    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.cues).toHaveLength(3)
    expect(result.value.slidesTotal).toBe(3)
    expect(result.value.slidesWithAsset).toBe(2)
    expect(result.value.slidesMissingAsset).toEqual([2])

    const orphan = at(result.value.cues, 1)
    expect(orphan.label).toBe('Slide 2')
    expect(orphan.note).toBe(missingAssetNote(2))
    // The cue is still valid and still points where its asset would live, so dropping a file in
    // later is all the repair it needs.
    expect(cueSchema.safeParse(orphan).success).toBe(true)
    expect((orphan.payload as { asset: string }).asset).toBe(
      'slides/Sunday-Service-2026-07-26-slide-002.png'
    )
    expect(at(result.value.cues, 0).note).toBeUndefined()
    expect(at(result.value.cues, 2).note).toBeUndefined()
  })

  it('reports progress through reading -> converting -> writing -> done', async () => {
    await writeDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] }
    ])
    const seen: DeckImportProgress[] = []
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false }),
      onProgress: (p) => seen.push(p)
    })
    expect(result.ok).toBe(true)
    expect(seen.map((p) => p.stage)).toEqual([
      'reading',
      'converting',
      'writing',
      'writing',
      'writing',
      'done'
    ])
    expect(at(seen, seen.length - 1)).toEqual({
      stage: 'done',
      slidesDone: 2,
      slidesTotal: 2,
      message: 'Imported 2 slides'
    })
  })

  it('cannot be broken by a progress subscriber that throws', async () => {
    await writeDeck([{ number: 1, images: ['image1.png'] }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false }),
      onProgress: () => {
        throw new Error('subscriber exploded')
      }
    })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The LibreOffice backend, through the child-process seam
// ---------------------------------------------------------------------------

describe('importDeck — LibreOffice backend', () => {
  it('runs the converter in a child process and uses its rendered images', async () => {
    await writeDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] }
    ])
    const calls: Array<readonly string[]> = []
    const spawnFn: DeckSpawn = async (executable, args, options) => {
      calls.push([executable, ...args])
      expect(options.timeoutMs).toBe(5_000)
      return fakeConverter(2)(executable, args, options)
    }

    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: fakeRendererStatus,
      spawn: spawnFn,
      tempDir: workDir,
      convertTimeoutMs: 5_000
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.backend).toBe(BACKEND_LIBREOFFICE)
    expect(result.value.slidesWithAsset).toBe(2)
    expect(at(calls, 0)).toContain('--headless')
    expect(at(calls, 0)).toContain('--convert-to')
    expect(at(calls, 0)[0]).toBe('C:\\fake\\soffice.exe')
  })

  it('falls back to embedded pictures for the slides the converter did not render', async () => {
    await writeDeck([
      { number: 1, images: ['image1.png'] },
      { number: 2, images: ['image2.png'] },
      { number: 3, images: ['image3.png'] }
    ])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: fakeRendererStatus,
      spawn: fakeConverter(1),
      tempDir: workDir
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.slidesWithAsset).toBe(3)
    expect(result.value.warnings.join(' ')).toContain('remaining slides fall back')
  })

  it('survives a converter that times out', async () => {
    await writeDeck([{ number: 1, images: ['image1.png'] }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: fakeRendererStatus,
      spawn: async () => ({ code: null, timedOut: true, failure: 'converter timed out' }),
      tempDir: workDir
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.backend).toBe(BACKEND_EMBEDDED_MEDIA)
    expect(result.value.slidesWithAsset).toBe(1)
    expect(result.value.warnings.join(' ')).toContain('took too long')
  })

  it('survives a converter that cannot be launched at all', async () => {
    await writeDeck([{ number: 1, images: ['image1.png'] }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: fakeRendererStatus,
      spawn: async () => ({ code: null, timedOut: false, failure: 'ENOENT' }),
      tempDir: workDir
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.join(' ')).toContain('could not be run')
  })

  it('survives a converter that exits non-zero', async () => {
    await writeDeck([{ number: 1, images: ['image1.png'] }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: fakeRendererStatus,
      spawn: async () => ({ code: 77, timedOut: false, failure: null }),
      tempDir: workDir
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.join(' ')).toContain('exited with code 77')
  })
})

// ---------------------------------------------------------------------------
// Hostile and broken input
// ---------------------------------------------------------------------------

describe('importDeck — hostile and broken input', () => {
  it('refuses a file that is not a PowerPoint package', async () => {
    const notADeck = join(workDir, 'notes.pptx')
    await writeFile(notADeck, 'this is not a zip')
    const result = await importDeck(notADeck, { assetDir, newId: nextId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not a PowerPoint presentation')
  })

  it('refuses a missing path without throwing', async () => {
    const result = await importDeck(join(workDir, 'nope.pptx'), { assetDir, newId: nextId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('IO_ERROR')
  })

  it('refuses a directory handed to it as a deck', async () => {
    const result = await importDeck(workDir, { assetDir, newId: nextId })
    expect(result.ok).toBe(false)
  })

  it('refuses an archive with a path-traversal entry rather than importing the safe half', async () => {
    const hostile = zipSync(
      {
        'ppt/slides/slide1.xml': strToU8(slideXml(['rId2'])),
        'ppt/slides/_rels/slide1.xml.rels': strToU8(
          `<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId2" Type="${IMAGE_REL_TYPE}" Target="../media/image1.png"/></Relationships>`
        ),
        'ppt/media/image1.png': PNG_1X1,
        '../../../Windows/System32/evil.txt': strToU8('OWNED')
      },
      { level: 6 }
    )
    const hostilePath = join(workDir, 'hostile.pptx')
    await writeFile(hostilePath, hostile)

    const result = await importDeck(hostilePath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('unsafe entry name')
    // Nothing was written outside — in fact nothing was written at all.
    await expect(readdir(assetDir)).rejects.toThrow()
  })

  it('refuses a zip bomb', async () => {
    const bomb = zipSync(
      {
        'ppt/slides/slide1.xml': strToU8(slideXml([])),
        'ppt/media/image1.png': new Uint8Array(4 * 1024 * 1024)
      },
      { level: 6 }
    )
    const bombPath = join(workDir, 'bomb.pptx')
    await writeFile(bombPath, bomb)

    const seen: DeckImportProgress[] = []
    const result = await importDeck(bombPath, {
      assetDir,
      newId: nextId,
      onProgress: (p) => seen.push(p),
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('zip bomb')
    expect(at(seen, seen.length - 1).stage).toBe('failed')
  })

  it('refuses a deck with more slides than the cap', async () => {
    await writeDeck([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }])
    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      limits: { maxSlides: 2 },
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('slide import limit')
  })
})

// ---------------------------------------------------------------------------
// Standing Rule 4
// ---------------------------------------------------------------------------

describe('Standing Rule 4 — no slide text reaches a cue', () => {
  it('labels cues by position and carries no slide text in the result', async () => {
    const marker = 'PLACEHOLDER TITLE ZZQX'
    await writeDeck([
      { number: 1, images: ['image1.png'], placeholderText: marker },
      { number: 2, placeholderText: `${marker} TWO` }
    ])

    const result = await importDeck(deckPath, {
      assetDir,
      newId: nextId,
      importer: detectImporter({ env: {}, platform: 'win32', isFile: () => false })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const serialised = JSON.stringify(result.value)
    expect(serialised).not.toContain('ZZQX')
    expect(serialised).not.toContain('PLACEHOLDER TITLE')
    expect(result.value.cues.map((c) => c.label)).toEqual(['Slide 1', 'Slide 2'])
  })
})
