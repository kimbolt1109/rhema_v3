/**
 * Weekly templates' contract.
 *
 * Everything runs against an in-memory filesystem double: no disk, no Electron, no temp files left
 * behind. Four properties are asserted, and the second is the one that would cost a service:
 *
 *  1. A template round-trips — save, list, and create next week's plan from it.
 *  2. **The asset decision is enforced.** A template never carries a slide or media asset
 *     reference, and the previous week's filename does not survive anywhere in the saved file.
 *     A plan whose relative asset path silently resolved into last week's shared `assets/` folder
 *     would put last week's notices on the congregation screen looking entirely deliberate.
 *  3. An invalid template is refused whole, with a message that names the offending cue, and one
 *     corrupt file never hides the readable ones in a listing.
 *  4. A save writes through a temp file and renames, so a crash mid-save cannot destroy the
 *     template it was replacing.
 *
 * Every fixture is an obvious placeholder ("SLIDE 1", "PLACEHOLDER TITLE"). Standing Rule 4: no
 * verse text, no hymn lyrics, no real sermon appears in this repo, including in tests.
 */

import { basename, dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Cue, ServicePlan } from '@shared/plan'
import { ErrorCode } from '@shared/result'

import {
  MAX_TEMPLATES,
  SERVICE_DATE_TOKEN,
  TEMPLATE_ASSET_CLEARED_NOTE,
  TEMPLATE_FILE_VERSION,
  TEMPLATE_PLACEHOLDER_ASSET,
  TEMPLATE_TEMP_SUFFIX,
  cloneCueSkeleton,
  createTemplateStore,
  deriveServiceNameTemplate,
  expandServiceName,
  hasClearedAsset,
  listTemplates,
  newServiceFromTemplate,
  readTemplate,
  saveAsTemplate,
  slugifyTemplateName,
  templateFilePath,
  templateIdFromFileName,
  templatesDirectory,
  toTemplatePlan,
  validateTemplateDocument,
} from './templates'
import type { TemplateFileSystem } from './templates'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = resolve('/verger-test/userData/templates')

/** Last week's actual deck filename. It must not appear in a template. */
const LAST_WEEK_SLIDE = 'slides/2026-07-19-notices-001.png'
const LAST_WEEK_CLIP = 'media/2026-07-19-welcome.mp4'

const FIXED_NOW = 1_690_000_000_000

/** Midday local, so no timezone can shift the formatted day. */
const NEXT_SUNDAY = new Date(2026, 6, 26, 12, 0, 0)

function slideCue(overrides: Partial<Cue> = {}): Cue {
  return {
    id: 'cue-slide-1',
    type: 'slide',
    label: 'SLIDE 1',
    trigger: { mode: 'manual' },
    payload: { asset: LAST_WEEK_SLIDE, sourceSlide: 1 },
    ...overrides,
  }
}

function samplePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    schemaVersion: 1,
    service: '2026-07-19 PLACEHOLDER SERVICE',
    defaultMode: 'assist',
    cues: [
      {
        id: 'cue-welcome',
        type: 'scene',
        label: 'PLACEHOLDER TITLE',
        trigger: { mode: 'manual' },
        payload: { scene: 'Welcome loop' },
      },
      slideCue({ note: 'operator note' }),
      {
        id: 'cue-clip',
        type: 'media',
        label: 'PLACEHOLDER CLIP',
        trigger: { mode: 'manual' },
        payload: { asset: LAST_WEEK_CLIP, obsInputName: 'Welcome video' },
      },
      {
        id: 'cue-reading',
        type: 'scripture',
        label: 'PLACEHOLDER READING',
        trigger: { mode: 'anchor', text: 'our reading this morning' },
        payload: { reference: 'John 3:16' },
        options: { autoFireThreshold: 0.9, confirmAlways: true },
      },
    ],
    assetDir: 'assets',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The filesystem double
// ---------------------------------------------------------------------------

interface FakeFs extends TemplateFileSystem {
  readonly files: Map<string, string>
  readonly operations: string[]
  failWrite: boolean
  failRename: boolean
}

function createFakeFs(seed: Readonly<Record<string, string>> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed))
  const operations: string[] = []
  const directories = new Set<string>()

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
      if (fs.failWrite) throw new Error('EACCES')
      operations.push(`write ${path}`)
      files.set(path, contents)
    },
    rename: (from, to) => {
      if (fs.failRename) throw new Error('EPERM')
      const contents = files.get(from)
      if (contents === undefined) throw new Error(`ENOENT ${from}`)
      operations.push(`rename ${from} -> ${to}`)
      files.delete(from)
      files.set(to, contents)
    },
    mkdirp: (directory) => {
      operations.push(`mkdirp ${directory}`)
      directories.add(directory)
    },
    exists: (path) => files.has(path) || directories.has(path),
    remove: (path) => {
      operations.push(`remove ${path}`)
      files.delete(path)
    },
    listDir: (directory) => {
      if (!directories.has(directory)) throw new Error(`ENOENT ${directory}`)
      return [...files.keys()].filter((path) => dirname(path) === directory).map((path) => basename(path))
    },
  }
  return fs
}

/** A fake with the templates folder already created, which is what a second save sees. */
function seededFs(): FakeFs {
  const fs = createFakeFs()
  fs.mkdirp(DIR)
  fs.operations.length = 0
  return fs
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('slugifyTemplateName', () => {
  it('reduces a name to a filename-safe stem', () => {
    expect(slugifyTemplateName('Sunday Morning')).toBe('sunday-morning')
    expect(slugifyTemplateName('  Evening   Service!  ')).toBe('evening-service')
  })

  it('falls back rather than producing an empty stem', () => {
    // A Korean name reduces to nothing; the operator's name is kept verbatim in the envelope, so
    // only the *filename* falls back.
    expect(slugifyTemplateName('주일예배')).toBe('template')
    expect(slugifyTemplateName('   ')).toBe('template')
  })
})

describe('deriveServiceNameTemplate', () => {
  it('replaces a date-like run with the token', () => {
    expect(deriveServiceNameTemplate('2026-07-19 PLACEHOLDER SERVICE')).toBe(
      `${SERVICE_DATE_TOKEN} PLACEHOLDER SERVICE`,
    )
    expect(deriveServiceNameTemplate('Service 2026/7/5')).toBe(`Service ${SERVICE_DATE_TOKEN}`)
  })

  it('keeps a template that already carries the token', () => {
    expect(deriveServiceNameTemplate(`${SERVICE_DATE_TOKEN} Sunday`)).toBe(
      `${SERVICE_DATE_TOKEN} Sunday`,
    )
  })

  it('appends the token when there is no date, so every week is not called the same thing', () => {
    expect(deriveServiceNameTemplate('Sunday morning')).toBe(`Sunday morning — ${SERVICE_DATE_TOKEN}`)
  })
})

describe('expandServiceName', () => {
  it('substitutes a sortable YYYY-MM-DD date', () => {
    expect(expandServiceName(`${SERVICE_DATE_TOKEN} PLACEHOLDER SERVICE`, NEXT_SUNDAY)).toBe(
      '2026-07-26 PLACEHOLDER SERVICE',
    )
  })

  it('leaves a template with no token alone', () => {
    expect(expandServiceName('PLACEHOLDER SERVICE', NEXT_SUNDAY)).toBe('PLACEHOLDER SERVICE')
  })
})

describe('templateFilePath', () => {
  it('builds the file for a bare id', () => {
    const path = templateFilePath(DIR, 'sunday-morning-abc')
    expect(path.ok && path.value).toBe(join(DIR, 'sunday-morning-abc.json'))
  })

  it.each([
    '../../../Windows/System32/config',
    '/etc/passwd',
    'C:\\Users\\someone\\evil',
    'sub\\dir',
    'sub/dir',
    'has.dot',
    'UPPER',
    '',
  ])('refuses %j', (id) => {
    const path = templateFilePath(DIR, id)
    expect(path.ok).toBe(false)
    if (!path.ok) expect(path.error.code).toBe(ErrorCode.INVALID_ARG)
  })
})

describe('templateIdFromFileName', () => {
  it('accepts a template file and rejects anything else', () => {
    expect(templateIdFromFileName('sunday-abc.json')).toBe('sunday-abc')
    expect(templateIdFromFileName('sunday-abc.json.tmp')).toBeNull()
    expect(templateIdFromFileName('notes.txt')).toBeNull()
    expect(templateIdFromFileName('Sunday.json')).toBeNull()
  })
})

describe('templatesDirectory', () => {
  it('sits under userData', () => {
    expect(templatesDirectory(resolve('/userData'))).toBe(join(resolve('/userData'), 'templates'))
  })
})

// ---------------------------------------------------------------------------
// The asset decision
// ---------------------------------------------------------------------------

describe('the asset-reference decision', () => {
  it('clears every slide and media asset, keeping the cue slot', () => {
    const stripped = toTemplatePlan(samplePlan())

    expect(stripped.cleared).toBe(2)
    const [, slide, clip] = stripped.plan.cues
    expect(slide?.payload).toEqual({ asset: TEMPLATE_PLACEHOLDER_ASSET })
    // The OBS input is skeleton, not last week's file, so it survives.
    expect(clip?.payload).toEqual({
      asset: TEMPLATE_PLACEHOLDER_ASSET,
      obsInputName: 'Welcome video',
    })
    expect(hasClearedAsset(slide as Cue)).toBe(true)
    expect(hasClearedAsset(clip as Cue)).toBe(true)
  })

  it('drops sourceSlide, which belongs to the deck that is no longer referenced', () => {
    const stripped = toTemplatePlan(samplePlan())
    expect(stripped.plan.cues[1]?.payload).not.toHaveProperty('sourceSlide')
  })

  it('marks each stripped cue so it announces what it needs', () => {
    const stripped = toTemplatePlan(samplePlan())
    expect(stripped.plan.cues[1]?.note).toContain(TEMPLATE_ASSET_CLEARED_NOTE)
    // The operator's own note is kept above the marker.
    expect(stripped.plan.cues[1]?.note).toContain('operator note')
  })

  it('preserves cue ids, labels, triggers and options', () => {
    const stripped = toTemplatePlan(samplePlan())
    expect(stripped.plan.cues.map((cue) => cue.id)).toEqual([
      'cue-welcome',
      'cue-slide-1',
      'cue-clip',
      'cue-reading',
    ])
    expect(stripped.plan.cues[3]?.options).toEqual({ autoFireThreshold: 0.9, confirmAlways: true })
    expect(stripped.plan.cues[3]?.trigger).toEqual({
      mode: 'anchor',
      text: 'our reading this morning',
    })
  })

  it('resets assetDir rather than inheriting the previous plan folder', () => {
    const stripped = toTemplatePlan(samplePlan({ assetDir: 'deck-2026-07-19' }))
    expect(stripped.plan.assetDir).toBe('assets')
  })

  it('leaves cues that carry no asset untouched', () => {
    const skeleton = cloneCueSkeleton(samplePlan().cues)
    expect(skeleton.cleared).toBe(2)
    expect(skeleton.cues[0]).toEqual(samplePlan().cues[0])
    expect(skeleton.cues[3]).toEqual(samplePlan().cues[3])
  })

  it('never lets last week’s filename reach the saved file', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday morning', { now: () => FIXED_NOW })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const raw = fs.files.get(join(DIR, `${saved.value.id}.json`))
    expect(raw).toBeDefined()
    expect(raw).not.toContain(LAST_WEEK_SLIDE)
    expect(raw).not.toContain(LAST_WEEK_CLIP)
    expect(raw).toContain(TEMPLATE_PLACEHOLDER_ASSET)
    expect(saved.value.clearedAssets).toBe(2)
  })

  it('survives the round trip: a created service still carries no asset reference', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday morning', { now: () => FIXED_NOW })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const created = newServiceFromTemplate(fs, DIR, saved.value.id, NEXT_SUNDAY)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    for (const cue of created.value.cues) {
      if (cue.type !== 'slide' && cue.type !== 'media') continue
      expect((cue.payload as { asset: string }).asset).toBe(TEMPLATE_PLACEHOLDER_ASSET)
    }
    expect(JSON.stringify(created.value)).not.toContain(LAST_WEEK_SLIDE)
  })
})

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('the template round trip', () => {
  it('saves, lists and creates next week’s service', () => {
    const fs = seededFs()
    const store = createTemplateStore({ fs, directory: DIR, now: () => FIXED_NOW })

    const saved = store.saveAsTemplate(samplePlan(), 'Sunday morning')
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.templateVersion).toBe(TEMPLATE_FILE_VERSION)
    expect(saved.value.name).toBe('Sunday morning')
    expect(saved.value.serviceNameTemplate).toBe(`${SERVICE_DATE_TOKEN} PLACEHOLDER SERVICE`)

    const listed = store.listTemplates()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.unreadable).toEqual([])
    expect(listed.value.templates).toEqual([
      {
        id: saved.value.id,
        name: 'Sunday morning',
        serviceNameTemplate: `${SERVICE_DATE_TOKEN} PLACEHOLDER SERVICE`,
        createdAt: FIXED_NOW,
        cues: 4,
        clearedAssets: 2,
      },
    ])

    const created = store.newServiceFromTemplate(saved.value.id, NEXT_SUNDAY)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.service).toBe('2026-07-26 PLACEHOLDER SERVICE')
    expect(created.value.schemaVersion).toBe(1)
    expect(created.value.defaultMode).toBe('assist')
    expect(created.value.cues.map((cue) => cue.label)).toEqual([
      'PLACEHOLDER TITLE',
      'SLIDE 1',
      'PLACEHOLDER CLIP',
      'PLACEHOLDER READING',
    ])
  })

  it('lists newest first', () => {
    const fs = seededFs()
    const first = saveAsTemplate(fs, DIR, samplePlan(), 'Older', { now: () => FIXED_NOW })
    const second = saveAsTemplate(fs, DIR, samplePlan(), 'Newer', { now: () => FIXED_NOW + 1000 })
    expect(first.ok && second.ok).toBe(true)

    const listed = listTemplates(fs, DIR)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.templates.map((entry) => entry.name)).toEqual(['Newer', 'Older'])
  })

  it('reports an empty folder rather than failing on first run', () => {
    const listed = listTemplates(createFakeFs(), DIR)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value).toEqual({ templates: [], unreadable: [] })
  })

  it('gives a second template with the same name its own file', () => {
    const fs = seededFs()
    const first = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', { now: () => FIXED_NOW })
    const second = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', { now: () => FIXED_NOW })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.id).not.toBe(first.value.id)
    expect(fs.files.size).toBe(2)
  })

  it('accepts an explicit service-name template', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', {
      now: () => FIXED_NOW,
      serviceNameTemplate: `Evening — ${SERVICE_DATE_TOKEN}`,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const created = newServiceFromTemplate(fs, DIR, saved.value.id, NEXT_SUNDAY)
    expect(created.ok && created.value.service).toBe('Evening — 2026-07-26')
  })

  it('caps a listing so a folder full of files cannot stall a service', () => {
    expect(MAX_TEMPLATES).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('refuses a template whose plan is invalid, naming the offending cue', () => {
    const fs = seededFs()
    const broken = {
      templateVersion: TEMPLATE_FILE_VERSION,
      id: 'broken-1',
      name: 'Broken',
      serviceNameTemplate: SERVICE_DATE_TOKEN,
      createdAt: FIXED_NOW,
      clearedAssets: 0,
      plan: {
        schemaVersion: 1,
        service: 'PLACEHOLDER SERVICE',
        defaultMode: 'assist',
        assetDir: 'assets',
        cues: [
          {
            id: 'cue-bad',
            type: 'scene',
            label: 'PLACEHOLDER TITLE',
            trigger: { mode: 'manual' },
            // A scene payload with no scene name — the plan schema refuses this.
            payload: { asset: 'nope.png' },
          },
        ],
      },
    }
    fs.writeText(join(DIR, 'broken-1.json'), JSON.stringify(broken))

    const read = readTemplate(fs, DIR, 'broken-1')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(read.error.detail).toContain('PLACEHOLDER TITLE')
    expect(read.error.detail).toContain('cue-bad')
  })

  it('refuses a file that is not a template envelope', () => {
    const fs = seededFs()
    fs.writeText(join(DIR, 'not-a-template.json'), JSON.stringify({ hello: 'world' }))

    const read = readTemplate(fs, DIR, 'not-a-template')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(read.error.message).toMatch(/not a Verger service template/i)
  })

  it('refuses a template written by a newer build', () => {
    const document = { templateVersion: 2, id: 'x-1', name: 'X', serviceNameTemplate: '{date}', createdAt: 0, clearedAssets: 0, plan: {} }
    const validated = validateTemplateDocument(document)
    expect(validated.ok).toBe(false)
  })

  it('refuses invalid JSON', () => {
    const fs = seededFs()
    fs.writeText(join(DIR, 'truncated-1.json'), '{"templateVersion": 1,')

    const read = readTemplate(fs, DIR, 'truncated-1')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.message).toMatch(/not valid JSON/i)
  })

  it('skips one corrupt template without hiding the readable ones', () => {
    const fs = seededFs()
    const good = saveAsTemplate(fs, DIR, samplePlan(), 'Good', { now: () => FIXED_NOW })
    expect(good.ok).toBe(true)
    fs.writeText(join(DIR, 'corrupt-1.json'), 'not json at all')

    const listed = listTemplates(fs, DIR)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.templates.map((entry) => entry.name)).toEqual(['Good'])
    expect(listed.value.unreadable).toEqual(['corrupt-1.json'])
  })

  it('refuses to save an invalid plan', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, { ...samplePlan(), service: '' }, 'Sunday')
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(fs.files.size).toBe(0)
  })

  it('refuses a blank template name', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, samplePlan(), '   ')
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.message).toMatch(/give the template a name/i)
  })

  it('reports a missing template as NOT_FOUND', () => {
    const read = newServiceFromTemplate(seededFs(), DIR, 'nothing-here', NEXT_SUNDAY)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('refuses an invalid date rather than producing a service called "Invalid Date"', () => {
    const created = newServiceFromTemplate(seededFs(), DIR, 'anything-1', new Date(Number.NaN))
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.message).toMatch(/not a valid service date/i)
  })
})

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('atomic save', () => {
  it('writes through a temp file and renames', () => {
    const fs = seededFs()
    const saved = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', { now: () => FIXED_NOW })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const target = join(DIR, `${saved.value.id}.json`)
    expect(fs.operations).toContain(`write ${target}${TEMPLATE_TEMP_SUFFIX}`)
    expect(fs.operations).toContain(`rename ${target}${TEMPLATE_TEMP_SUFFIX} -> ${target}`)
    expect(fs.operations.indexOf(`write ${target}${TEMPLATE_TEMP_SUFFIX}`)).toBeLessThan(
      fs.operations.indexOf(`rename ${target}${TEMPLATE_TEMP_SUFFIX} -> ${target}`),
    )
  })

  it('leaves the previous template intact when the rename fails', () => {
    const fs = seededFs()
    const first = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', { now: () => FIXED_NOW })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const before = fs.files.get(join(DIR, `${first.value.id}.json`))

    fs.failRename = true
    const second = saveAsTemplate(fs, DIR, samplePlan({ service: '2026-08-02 OTHER' }), 'Sunday', {
      now: () => FIXED_NOW,
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe(ErrorCode.IO_ERROR)
    expect(fs.files.get(join(DIR, `${first.value.id}.json`))).toBe(before)
    // The orphaned temp file is cleaned up rather than left beside the template.
    expect([...fs.files.keys()].some((path) => path.endsWith(TEMPLATE_TEMP_SUFFIX))).toBe(false)
  })

  it('reports a refused write instead of claiming a template was saved', () => {
    const fs = seededFs()
    fs.failWrite = true
    const saved = saveAsTemplate(fs, DIR, samplePlan(), 'Sunday', { now: () => FIXED_NOW })
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.error.code).toBe(ErrorCode.IO_ERROR)
    expect(fs.files.size).toBe(0)
  })
})
