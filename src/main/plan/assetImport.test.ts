/**
 * `assetImport.ts` — classification, filename containment, and the per-file failures that must not
 * cost an operator the rest of their selection.
 *
 * Real temp directories and real copies throughout: the properties under test are "did a file land
 * inside this folder" and "was an existing file left alone", and neither exists at the level of a
 * mocked `fs`. The payloads are a handful of bytes — nothing here cares what an image contains, only
 * where it ends up.
 *
 * Standing Rule 4: every filename is an obvious placeholder (`logo.png`, `PLACEHOLDER-CLIP.mp4`).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  IMAGE_EXTENSIONS,
  MAX_ASSET_BYTES,
  VIDEO_EXTENSIONS,
  assetSubfolder,
  classifyAsset,
  copyAssetsIntoPlan,
  resolveInsideAssetDir,
  safeAssetFilename
} from './assetImport'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const VIDEO_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])

const tempDirs: string[] = []

function makeTempDir(prefix = 'verger-assets-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Write a source file the operator could plausibly have picked, and return its absolute path. */
function makeSourceFile(dir: string, name: string, bytes: Buffer = IMAGE_BYTES): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

/** The containment assertion, spelled out once: a relative path must land under the asset folder. */
function isInside(assetDir: string, relative: string): boolean {
  const base = resolve(assetDir)
  const rel = relativePath(base, resolve(base, relative))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyAsset', () => {
  it('classifies every listed image extension as an image', () => {
    for (const extension of IMAGE_EXTENSIONS) {
      expect(classifyAsset(`logo${extension}`), extension).toBe('image')
    }
  })

  it('classifies every listed video extension as a video', () => {
    for (const extension of VIDEO_EXTENSIONS) {
      expect(classifyAsset(`PLACEHOLDER-CLIP${extension}`), extension).toBe('video')
    }
  })

  it('is case-insensitive, because cameras and Windows both are', () => {
    expect(classifyAsset('IMG_0001.JPG')).toBe('image')
    expect(classifyAsset('logo.PNG')).toBe('image')
    expect(classifyAsset('logo.JpEg')).toBe('image')
    expect(classifyAsset('PLACEHOLDER-CLIP.MP4')).toBe('video')
    expect(classifyAsset('PLACEHOLDER-CLIP.WebM')).toBe('video')
  })

  it('classifies a full absolute path by its extension alone', () => {
    expect(classifyAsset('C:\\Users\\operator\\Pictures\\logo.PNG')).toBe('image')
    expect(classifyAsset('/home/operator/media/PLACEHOLDER-CLIP.mp4')).toBe('video')
  })

  it('refuses anything that is not an image or a video', () => {
    // `.pptx` belongs to importDeck, not here; `.svg` is a scriptable document, deliberately out.
    for (const path of ['deck.pptx', 'setup.exe', 'plan.json', 'artwork.svg', 'notes.txt']) {
      expect(classifyAsset(path), path).toBeNull()
    }
  })

  it('refuses a name with no extension at all, and a dotfile that only looks like one', () => {
    expect(classifyAsset('plan')).toBeNull()
    expect(classifyAsset('C:\\Users\\operator\\Pictures')).toBeNull()
    expect(classifyAsset('')).toBeNull()
    // `.png` is a dotfile whose whole name is the extension — `extname` agrees it has none.
    expect(classifyAsset('.png')).toBeNull()
  })
})

describe('assetSubfolder', () => {
  it('puts images beside imported slides and video in its own folder', () => {
    expect(assetSubfolder('image')).toBe('slides')
    expect(assetSubfolder('video')).toBe('media')
  })
})

// ---------------------------------------------------------------------------
// Filename containment
// ---------------------------------------------------------------------------

describe('safeAssetFilename', () => {
  it('leaves an ordinary filename alone', () => {
    expect(safeAssetFilename('logo.png')).toBe('logo.png')
    expect(safeAssetFilename('PLACEHOLDER-CLIP.mp4')).toBe('PLACEHOLDER-CLIP.mp4')
  })

  it('keeps only the basename, so no traversal survives', () => {
    for (const hostile of [
      '..\\..\\..\\Windows\\System32\\evil.png',
      '../../../etc/evil.png',
      'C:\\Windows\\System32\\evil.png',
      '\\\\attacker\\share\\evil.png',
      '/etc/evil.png'
    ]) {
      expect(safeAssetFilename(hostile), hostile).toBe('evil.png')
    }
  })

  it('strips a drive-relative qualifier, which resolves against that drive and not the plan', () => {
    expect(safeAssetFilename('C:logo.png')).toBe('logo.png')
  })

  it('drops an NTFS alternate-data-stream suffix', () => {
    // `logo.png:payload` writes a stream hanging off logo.png: a file no listing shows.
    expect(safeAssetFilename('logo.png:payload.png')).toBe('logo.png')
    expect(safeAssetFilename('PLACEHOLDER-CLIP:stream.mp4')).toBe('PLACEHOLDER-CLIP.mp4')
  })

  it('collapses a name that is nothing but dots to a fallback rather than a parent reference', () => {
    expect(safeAssetFilename('..')).toBe('asset')
    expect(safeAssetFilename('.')).toBe('asset')
    expect(safeAssetFilename('...')).toBe('asset')
  })

  it('removes leading dots, reserved characters and control characters', () => {
    expect(safeAssetFilename('.hidden.png')).toBe('hidden.png')
    const cleaned = safeAssetFilename('bad*name?"<>|.png')
    expect(cleaned).toMatch(/\.png$/)
    expect(cleaned).not.toMatch(/[*?"<>|]/)
    expect(safeAssetFilename('tab\there.png')).toBe('tab-here.png')
  })

  it('removes trailing dots and spaces, which Windows silently strips on create', () => {
    // Keeping them would mean recording a path that does not match the file that got written.
    expect(safeAssetFilename('logo.png. ')).toBe('logo.png')
  })

  it('keeps non-ASCII characters verbatim', () => {
    // A Hangul-named file is routine, not exotic; a sanitiser that dashed these out would mangle
    // every filename in a Korean church's plan folder.
    expect(safeAssetFilename('한글-PLACEHOLDER.png')).toBe('한글-PLACEHOLDER.png')
    expect(safeAssetFilename('C:\\사진\\한글-PLACEHOLDER.mp4')).toBe('한글-PLACEHOLDER.mp4')
  })

  it('normalises the extension to lower case so the stored path is predictable', () => {
    expect(safeAssetFilename('IMG_0001.JPG')).toBe('IMG_0001.jpg')
  })

  it('truncates an absurdly long stem while keeping the extension', () => {
    const name = `${'x'.repeat(400)}.png`
    const result = safeAssetFilename(name)
    expect(result.endsWith('.png')).toBe(true)
    expect(result.length).toBeLessThan(200)
  })

  it('never returns something containing a separator or a colon', () => {
    for (const hostile of [
      '..\\..\\evil.png',
      '../../evil.png',
      'C:\\x\\evil.png',
      'logo.png:ads.png',
      '..'
    ]) {
      const result = safeAssetFilename(hostile)
      expect(result, hostile).not.toMatch(/[\\/:]/)
      expect(result.startsWith('.'), hostile).toBe(false)
    }
  })
})

describe('resolveInsideAssetDir', () => {
  it('accepts a plain forward reference', () => {
    const assetDir = resolve('/plans/sunday/assets')
    const contained = resolveInsideAssetDir(assetDir, join('slides', 'logo.png'))
    expect(contained.ok).toBe(true)
  })

  it('refuses anything that leaves the asset folder', () => {
    const assetDir = resolve('/plans/sunday/assets')
    for (const fragment of [
      '',
      '..',
      '../escape.png',
      join('slides', '..', '..', 'escape.png'),
      '/etc/passwd',
      '\\\\attacker\\share\\evil.png',
      'C:\\Windows\\System32\\evil.png',
      'slides/log\0o.png'
    ]) {
      const contained = resolveInsideAssetDir(assetDir, fragment)
      expect(contained.ok, JSON.stringify(fragment)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

describe('copyAssetsIntoPlan', () => {
  it('copies an image into slides/ and a video into media/, creating both folders', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = join(makeTempDir(), 'plan', 'assets')
    const image = makeSourceFile(sourceDir, 'logo.png', IMAGE_BYTES)
    const clip = makeSourceFile(sourceDir, 'PLACEHOLDER-CLIP.mp4', VIDEO_BYTES)

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [image, clip] })

    expect(outcome.failed).toEqual([])
    expect(outcome.copied).toHaveLength(2)
    expect(outcome.copied[0]).toEqual({
      sourcePath: image,
      relative: 'slides/logo.png',
      kind: 'image'
    })
    expect(outcome.copied[1]).toEqual({
      sourcePath: clip,
      relative: 'media/PLACEHOLDER-CLIP.mp4',
      kind: 'video'
    })
    expect(readFileSync(join(assetDir, 'slides', 'logo.png')).equals(IMAGE_BYTES)).toBe(true)
    expect(readFileSync(join(assetDir, 'media', 'PLACEHOLDER-CLIP.mp4')).equals(VIDEO_BYTES)).toBe(
      true
    )
  })

  it('returns relative paths with forward slashes, because they are also overlay URLs', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const image = makeSourceFile(sourceDir, 'logo.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [image] })

    const copied = outcome.copied[0]
    expect(copied).toBeDefined()
    expect(copied?.relative).toBe('slides/logo.png')
    expect(copied?.relative).not.toContain('\\')
  })

  it('never overwrites an existing asset: it writes -2, then -3', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const existing = join(assetDir, 'slides', 'logo.png')
    mkdirSync(join(assetDir, 'slides'), { recursive: true })
    const sentinel = Buffer.from([0x11, 0x22, 0x33])
    writeFileSync(existing, sentinel)
    const image = makeSourceFile(sourceDir, 'logo.png', IMAGE_BYTES)

    const first = await copyAssetsIntoPlan({ assetDir, paths: [image] })
    const second = await copyAssetsIntoPlan({ assetDir, paths: [image] })

    expect(first.copied[0]?.relative).toBe('slides/logo-2.png')
    expect(second.copied[0]?.relative).toBe('slides/logo-3.png')
    // The file that was already there is the point of this test.
    expect(readFileSync(existing).equals(sentinel)).toBe(true)
    expect(readFileSync(join(assetDir, 'slides', 'logo-2.png')).equals(IMAGE_BYTES)).toBe(true)
  })

  it('gives two files with the same name in one batch two names', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const image = makeSourceFile(sourceDir, 'logo.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [image, image] })

    expect(outcome.copied.map((asset) => asset.relative)).toEqual([
      'slides/logo.png',
      'slides/logo-2.png'
    ])
  })

  it('keeps a Hangul filename intact through the copy', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const image = makeSourceFile(sourceDir, '한글-PLACEHOLDER.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [image] })

    expect(outcome.copied[0]?.relative).toBe('slides/한글-PLACEHOLDER.png')
    expect(existsSync(join(assetDir, 'slides', '한글-PLACEHOLDER.png'))).toBe(true)
  })

  it('cannot be walked out of the asset folder by the source path', async () => {
    // The source is reached through a path full of `..` segments, which is legal and resolves to a
    // real file. Only the basename may influence the destination.
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    makeSourceFile(sourceDir, 'logo.png')
    const leaf = sourceDir.split(/[\\/]/).pop() ?? ''
    const viaDots = join(sourceDir, '..', leaf, '..', leaf, 'logo.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [viaDots] })

    expect(outcome.failed).toEqual([])
    expect(outcome.copied[0]?.relative).toBe('slides/logo.png')
    expect(isInside(assetDir, outcome.copied[0]?.relative ?? '..')).toBe(true)
  })

  it('reports an unsupported extension without touching the disk', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = join(makeTempDir(), 'plan', 'assets')
    const deck = makeSourceFile(sourceDir, 'deck.pptx')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [deck] })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]?.sourcePath).toBe(deck)
    expect(outcome.failed[0]?.reason).toContain('.pptx')
    expect(existsSync(assetDir)).toBe(false)
  })

  it('reports a file with no extension', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const nameless = makeSourceFile(sourceDir, 'mystery')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [nameless] })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed[0]?.reason).toContain('no extension')
  })

  it('reports a source that no longer exists', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const missing = join(sourceDir, 'never-existed.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [missing] })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed[0]?.reason).toContain('no longer exists')
  })

  it('reports a source that is a folder', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    // A folder that ends in an image extension is exactly the mistake a file dialog allows.
    const folder = join(sourceDir, 'pictures.png')
    mkdirSync(folder)

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [folder] })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed[0]?.reason).toBe('that is a folder, not a file')
  })

  it('reports a file over maxBytes', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const clip = makeSourceFile(sourceDir, 'PLACEHOLDER-CLIP.mp4', Buffer.alloc(64, 0x2a))

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [clip], maxBytes: 4 })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed[0]?.reason).toContain('over the')
    expect(existsSync(join(assetDir, 'media', 'PLACEHOLDER-CLIP.mp4'))).toBe(false)
  })

  it('defaults to the 512 MB ceiling when maxBytes is nonsense', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const image = makeSourceFile(sourceDir, 'logo.png')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [image], maxBytes: 0 })

    expect(MAX_ASSET_BYTES).toBe(512 * 1024 * 1024)
    expect(outcome.failed).toEqual([])
    expect(outcome.copied[0]?.relative).toBe('slides/logo.png')
  })

  it('lets one bad file cost only itself', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const before = makeSourceFile(sourceDir, 'first.png', IMAGE_BYTES)
    const deck = makeSourceFile(sourceDir, 'deck.pptx')
    const gone = join(sourceDir, 'never-existed.png')
    const folder = join(sourceDir, 'folder.jpg')
    mkdirSync(folder)
    const huge = makeSourceFile(sourceDir, 'huge.png', Buffer.alloc(64, 0x2a))
    const after = makeSourceFile(sourceDir, 'PLACEHOLDER-CLIP.mp4', VIDEO_BYTES)

    const outcome = await copyAssetsIntoPlan({
      assetDir,
      paths: [before, deck, gone, folder, huge, after],
      maxBytes: 32
    })

    expect(outcome.copied.map((asset) => asset.relative)).toEqual([
      'slides/first.png',
      'media/PLACEHOLDER-CLIP.mp4'
    ])
    expect(outcome.failed.map((failure) => failure.sourcePath)).toEqual([deck, gone, folder, huge])
    for (const failure of outcome.failed) {
      expect(failure.reason.length, failure.sourcePath).toBeGreaterThan(0)
    }
  })

  it('resolves normally when every file fails', async () => {
    const sourceDir = makeTempDir('verger-source-')
    const assetDir = makeTempDir()
    const deck = makeSourceFile(sourceDir, 'deck.pptx')

    const outcome = await copyAssetsIntoPlan({
      assetDir,
      paths: [deck, join(sourceDir, 'never-existed.png')]
    })

    expect(outcome.copied).toEqual([])
    expect(outcome.failed).toHaveLength(2)
  })

  it('touches no disk at all for an empty selection', async () => {
    // A cancelled file dialog must not create folders in the operator's plan.
    const assetDir = join(makeTempDir(), 'plan', 'assets')

    const outcome = await copyAssetsIntoPlan({ assetDir, paths: [] })

    expect(outcome).toEqual({ copied: [], failed: [] })
    expect(existsSync(assetDir)).toBe(false)
  })
})

/**
 * The one list that exists in three places, guarded.
 *
 * `VIDEO_EXTENSIONS` here decides which CUE TYPE an imported file becomes; `ASSET_FILE_EXTENSIONS`
 * in `src/main/ipc/register.ts` decides what the file dialog offers and what the IPC boundary
 * accepts; and `overlay.js` keeps its own hand-written copy that decides whether the full-frame layer
 * builds a `<video>` or an `<img>`. The overlay page is deliberately framework-free and loaded raw as
 * an OBS browser source, so it *cannot* import from `src/` — the duplication is structural, not
 * laziness (`protocol.js` is duplicated for the same reason).
 *
 * The failure drift causes is nasty and quiet: add `.avi` here and an operator's `.avi` imports
 * happily, becomes a `media` cue, fires, and the overlay renders it as a BROKEN IMAGE on the
 * congregation screen — because `overlay.js` never heard of it. Nothing throws and no other test
 * fails. So the lists are compared by reading the other file as text, which is ugly, and is the only
 * thing that actually holds them together.
 */
describe('the overlay page agrees about which extensions are video', () => {
  it('has the same VIDEO_EXTENSIONS list as overlay.js', () => {
    // `process.cwd()` is the repo root under vitest, and this is a test — a wrong path here fails
    // loudly on the very next line rather than silently passing.
    const overlaySource = readFileSync(
      join(process.cwd(), 'src', 'overlay', 'overlay.js'),
      'utf8'
    )

    // `Object.freeze([...])` is allowed for, because that is how overlay.js declares it.
    const declaration = /VIDEO_EXTENSIONS\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]/.exec(
      overlaySource
    )
    expect(
      declaration,
      'overlay.js no longer declares VIDEO_EXTENSIONS — find where it moved and re-point this guard'
    ).not.toBeNull()

    const inOverlay = [...(declaration?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)]
      .map((match) => (match[1] ?? '').toLowerCase())
      .sort()

    expect(inOverlay).toEqual([...VIDEO_EXTENSIONS].map((extension) => extension.toLowerCase()).sort())
  })
})
