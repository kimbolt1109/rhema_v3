/**
 * `planFile` behaviour — the three properties the operator's Sunday depends on.
 *
 * Everything here runs against an in-memory filesystem double: no disk, no Electron, no temp
 * directories left behind. What is asserted is not "the JSON round-trips" but the three failure
 * modes that would cost a service:
 *
 *  1. A corrupt or hand-edited plan is refused WHOLE, with a message naming the offending cue.
 *  2. A save writes through a temp file and renames, so a crash mid-save cannot destroy the plan.
 *  3. An asset path from an imported deck cannot escape the plan's folder.
 *
 * Every fixture uses obvious placeholders ("SLIDE 1", "PLACEHOLDER TITLE"). Standing Rule 4: no
 * hymn lyrics, no verse text, no real sermon appears in this repo, including in tests.
 */

import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CURRENT_PLAN_SCHEMA_VERSION,
  MAX_PLAN_FILE_BYTES,
  PLAN_TEMP_SUFFIX,
  assetFileUrl,
  describePlanIssues,
  isEscapingFragment,
  loadPlanFile,
  migratePlanDocument,
  resolveAssetDir,
  resolveAssetPath,
  savePlanFile,
  validatePlanDocument
} from '@main/plan/planFile'
import type { PlanFileSystem } from '@main/plan/planFile'
import { ErrorCode } from '@shared/result'
import type { Cue, ServicePlan } from '@shared/plan'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_PATH = resolve('/verger-test/plans/sunday.json')
const PLAN_DIR = dirname(PLAN_PATH)

function slideCue(index: number): Cue {
  return {
    id: `cue-${index}`,
    type: 'slide',
    label: `SLIDE ${index}`,
    trigger: { mode: 'manual' },
    payload: { asset: `slides/slide-${index}.png`, sourceSlide: index }
  }
}

function samplePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    schemaVersion: 1,
    service: 'PLACEHOLDER SERVICE',
    defaultMode: 'assist',
    cues: [slideCue(1), slideCue(2)],
    assetDir: 'assets',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// The filesystem double
// ---------------------------------------------------------------------------

interface FakeFs extends PlanFileSystem {
  readonly files: Map<string, string>
  readonly operations: string[]
  failWrite: boolean
  failRename: boolean
}

function createFakeFs(seed: Readonly<Record<string, string>> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed))
  const operations: string[] = []

  const fs: FakeFs = {
    files,
    operations,
    failWrite: false,
    failRename: false,
    size: (path) => {
      const contents = files.get(path)
      if (contents === undefined) throw new Error(`ENOENT ${path}`)
      return Buffer.byteLength(contents, 'utf8')
    },
    readText: (path) => {
      const contents = files.get(path)
      if (contents === undefined) throw new Error(`ENOENT ${path}`)
      operations.push(`read ${path}`)
      return contents
    },
    writeText: (path, contents) => {
      if (fs.failWrite) throw new Error('disk full')
      operations.push(`write ${path}`)
      files.set(path, contents)
    },
    rename: (from, to) => {
      if (fs.failRename) throw new Error('rename refused')
      operations.push(`rename ${from} -> ${to}`)
      const contents = files.get(from)
      if (contents === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, contents)
    },
    mkdirp: (directory) => {
      operations.push(`mkdirp ${directory}`)
    },
    exists: (path) => files.has(path),
    remove: (path) => {
      operations.push(`remove ${path}`)
      files.delete(path)
    }
  }
  return fs
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

describe('loadPlanFile', () => {
  it('round-trips a plan that was saved by savePlanFile', () => {
    const fs = createFakeFs()
    const saved = savePlanFile(fs, PLAN_PATH, samplePlan())
    expect(saved.ok).toBe(true)

    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.path).toBe(PLAN_PATH)
    expect(loaded.value.plan.cues).toHaveLength(2)
    expect(loaded.value.plan.cues[0]?.label).toBe('SLIDE 1')
  })

  it('reports NOT_FOUND for a path that does not exist', () => {
    const loaded = loadPlanFile(createFakeFs(), PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('refuses a file too large to be a plan without reading it', () => {
    const fs = createFakeFs()
    // `size` is consulted before `readText`, so an absurd file never reaches the heap.
    fs.files.set(PLAN_PATH, '')
    fs.size = () => MAX_PLAN_FILE_BYTES + 1

    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(fs.operations.some((entry) => entry.startsWith('read '))).toBe(false)
  })

  it('refuses a file that is not JSON at all', () => {
    const fs = createFakeFs({ [PLAN_PATH]: 'not json {' })
    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(loaded.error.message).toContain('not valid JSON')
  })

  it('names the offending cue when a hand-edited plan is invalid', () => {
    const broken = {
      ...samplePlan(),
      cues: [
        slideCue(1),
        {
          id: 'cue-2',
          type: 'slide',
          label: 'PLACEHOLDER TITLE',
          trigger: { mode: 'manual' },
          // A scene payload on a slide cue — the classic hand-edit mistake.
          payload: { scene: 'PLACEHOLDER SCENE' }
        }
      ]
    }
    const fs = createFakeFs({ [PLAN_PATH]: JSON.stringify(broken) })

    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.code).toBe(ErrorCode.INVALID_ARG)
    // One-based index, the label AND the id, so the operator can find the row.
    expect(loaded.error.detail).toContain('cue 2')
    expect(loaded.error.detail).toContain('PLACEHOLDER TITLE')
    expect(loaded.error.detail).toContain('cue-2')
  })

  it('refuses a plan whose asset folder escapes the plan folder', () => {
    const escaping = JSON.stringify(samplePlan({ assetDir: '../../somewhere-else' }))
    const fs = createFakeFs({ [PLAN_PATH]: escaping })

    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(loaded.error.message).toContain('inside the plan folder')
  })

  it('loads nothing at all when validation fails', () => {
    const fs = createFakeFs({ [PLAN_PATH]: JSON.stringify({ schemaVersion: 1 }) })
    const loaded = loadPlanFile(fs, PLAN_PATH)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.detail).toContain('service')
  })
})

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migratePlanDocument', () => {
  it('passes the current version through untouched', () => {
    const document = samplePlan()
    const migrated = migratePlanDocument(document)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value).toBe(document)
  })

  it('explains a plan written by a newer Verger rather than half-understanding it', () => {
    const migrated = migratePlanDocument({ schemaVersion: CURRENT_PLAN_SCHEMA_VERSION + 1 })
    expect(migrated.ok).toBe(false)
    if (migrated.ok) return
    expect(migrated.error.message).toContain('newer version of Verger')
  })

  it('refuses a document with no schemaVersion', () => {
    const migrated = migratePlanDocument({ service: 'PLACEHOLDER SERVICE' })
    expect(migrated.ok).toBe(false)
    if (migrated.ok) return
    expect(migrated.error.message).toContain('no schemaVersion')
  })

  it('refuses a non-object document', () => {
    expect(migratePlanDocument([]).ok).toBe(false)
    expect(migratePlanDocument(null).ok).toBe(false)
    expect(migratePlanDocument('plan').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Atomic save
// ---------------------------------------------------------------------------

describe('savePlanFile', () => {
  it('writes through a temp file and renames it into place', () => {
    const fs = createFakeFs()
    const saved = savePlanFile(fs, PLAN_PATH, samplePlan())
    expect(saved.ok).toBe(true)

    const temporary = `${PLAN_PATH}${PLAN_TEMP_SUFFIX}`
    expect(fs.operations).toEqual([
      `mkdirp ${PLAN_DIR}`,
      `write ${temporary}`,
      `rename ${temporary} -> ${PLAN_PATH}`
    ])
    // The temp file does not survive the rename.
    expect(fs.files.has(temporary)).toBe(false)
  })

  it('leaves the previous plan intact when the write fails', () => {
    const fs = createFakeFs({ [PLAN_PATH]: 'PREVIOUS PLAN' })
    fs.failWrite = true

    const saved = savePlanFile(fs, PLAN_PATH, samplePlan())
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.code).toBe(ErrorCode.IO_ERROR)
    expect(fs.files.get(PLAN_PATH)).toBe('PREVIOUS PLAN')
  })

  it('leaves the previous plan intact and discards the temp file when the rename fails', () => {
    const fs = createFakeFs({ [PLAN_PATH]: 'PREVIOUS PLAN' })
    fs.failRename = true

    const saved = savePlanFile(fs, PLAN_PATH, samplePlan())
    expect(saved.ok).toBe(false)
    expect(fs.files.get(PLAN_PATH)).toBe('PREVIOUS PLAN')
    expect(fs.files.has(`${PLAN_PATH}${PLAN_TEMP_SUFFIX}`)).toBe(false)
  })

  it('refuses to write an invalid plan over a good one', () => {
    const fs = createFakeFs({ [PLAN_PATH]: 'PREVIOUS PLAN' })
    const invalid = { ...samplePlan(), service: '' } as ServicePlan

    const saved = savePlanFile(fs, PLAN_PATH, invalid)
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(fs.files.get(PLAN_PATH)).toBe('PREVIOUS PLAN')
    expect(fs.operations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

describe('asset path containment', () => {
  it('resolves an ordinary asset inside the plan folder', () => {
    const resolved = resolveAssetPath(PLAN_PATH, samplePlan(), 'slides/slide-1.png')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value).toBe(join(PLAN_DIR, 'assets', 'slides', 'slide-1.png'))
  })

  it('resolves the asset folder relative to the plan file, not the process', () => {
    const dir = resolveAssetDir(PLAN_PATH, samplePlan())
    expect(dir.ok).toBe(true)
    if (!dir.ok) return
    expect(dir.value).toBe(join(PLAN_DIR, 'assets'))
  })

  it('allows an asset folder that is the plan folder itself', () => {
    expect(resolveAssetDir(PLAN_PATH, samplePlan({ assetDir: '' })).ok).toBe(true)
    expect(resolveAssetDir(PLAN_PATH, samplePlan({ assetDir: '.' })).ok).toBe(true)
  })

  it.each([
    ['parent traversal', '../../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32\\config\\sam'],
    ['posix absolute', '/etc/passwd'],
    ['windows absolute', 'C:\\Windows\\System32\\drivers\\etc\\hosts'],
    ['unc share', '\\\\attacker\\share\\payload.png'],
    ['embedded nul', 'slides/ok.png\0../../escape.png'],
    ['empty', '  ']
  ])('refuses %s', (_name, asset) => {
    const resolved = resolveAssetPath(PLAN_PATH, samplePlan(), asset)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe(ErrorCode.INVALID_ARG)
  })

  it('refuses an asset that resolves to the asset folder itself', () => {
    expect(resolveAssetPath(PLAN_PATH, samplePlan(), '.').ok).toBe(false)
  })

  it('flags escaping fragments without touching the filesystem', () => {
    expect(isEscapingFragment('/etc/passwd')).toBe(true)
    expect(isEscapingFragment('D:\\decks')).toBe(true)
    expect(isEscapingFragment('\\\\server\\share')).toBe(true)
    expect(isEscapingFragment('slides/slide-1.png')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('builds a file URL that survives spaces and hashes in a slide filename', () => {
    const url = assetFileUrl(join(PLAN_DIR, 'assets', 'my slide #2.png'))
    expect(url.startsWith('file:///')).toBe(true)
    expect(url).toContain('%20')
    expect(url).toContain('%23')
  })

  it('describes a root-level issue without pretending it belongs to a cue', () => {
    const parsed = validatePlanDocument({ ...samplePlan(), defaultMode: 'turbo' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.detail).toContain('defaultMode')
  })

  it('falls back to the index when the offending cue has no label or id', () => {
    const described = describePlanIssues(
      [{ path: ['cues', 0, 'label'], message: 'required' }],
      { cues: [{}] }
    )
    expect(described).toBe('cue 1 at label: required')
  })
})
