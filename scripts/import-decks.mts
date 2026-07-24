/**
 * One-off prep tool: build a ready-to-open Verger plan for each real deck.
 *
 *   npx tsx --tsconfig ./tsconfig.node.json scripts/import-decks.mts
 *
 * Slide IMAGES are rendered separately by PowerPoint COM (export-slides) into
 * <plan>/assets/slides/slide-NNN.png — PowerPoint renders every slide of its own format perfectly,
 * whereas LibreOffice's one-shot PNG export only emits slide 1. This script reads each slide's TEXT
 * with the real parser (opt-in includeText) to build auto-anchors, matches it to the exported image,
 * validates every cue against the shipped schema, and writes plan.json.
 *
 * Build/prep tool, NOT shipped. Reads the operator's OWN slide content; output lives under the
 * gitignored release/ folder and must never be committed. Slide text is never printed (only counts).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readPptx } from '@main/plan/pptx'
import { cueSchema, emptyServicePlan } from '@shared/plan'

const OUT_BASE = join(process.cwd(), 'release', '0.1.0', 'win-unpacked', 'plans')

const DECKS = [
  { service: '11am', deck: 'C:\\Users\\user\\OneDrive\\문서\\카카오톡 받은 파일\\【【【11시예배】】】.pptx' },
  { service: 'afternoon', deck: 'C:\\Users\\user\\OneDrive\\문서\\카카오톡 받은 파일\\오후예배.pptx' },
]

function normalizeAnchor(text: string | undefined): string {
  if (text === undefined) return ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 500 ? collapsed.slice(0, 500).trim() : collapsed
}

for (const { service, deck } of DECKS) {
  const planDir = join(OUT_BASE, service)
  const bytes = new Uint8Array(readFileSync(deck))
  const parsed = readPptx(bytes, undefined, { includeText: true })
  if (!parsed.ok) {
    console.error(`[${service}] readPptx FAILED — ${parsed.error.code}: ${parsed.error.message}`)
    continue
  }

  const slides = parsed.value.slides
  let anchored = 0
  let missingImage = 0
  let invalid = 0

  const cues = slides.map((slide, idx) => {
    const slideNumber = idx + 1
    const asset = `slides/slide-${String(slideNumber).padStart(3, '0')}.png`
    if (!existsSync(join(planDir, 'assets', asset))) missingImage += 1
    const anchor = normalizeAnchor(slide.text)
    if (anchor.length > 0) anchored += 1
    const cue = {
      id: randomUUID().slice(0, 64),
      type: 'slide' as const,
      label: `Slide ${slideNumber}`,
      trigger: anchor.length > 0 ? { mode: 'anchor' as const, text: anchor } : { mode: 'manual' as const },
      payload: { asset, sourceSlide: slideNumber },
    }
    if (!cueSchema.safeParse(cue).success) invalid += 1
    return cue
  })

  const plan = { ...emptyServicePlan(service), cues, assetDir: 'assets' }
  const planPath = join(planDir, 'plan.json')
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  console.log(
    `[${service}] ${slides.length} slides, ${anchored} auto-anchored, ${missingImage} missing image, ${invalid} invalid cues -> ${planPath}`,
  )
}
