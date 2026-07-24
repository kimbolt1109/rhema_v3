/**
 * Prep/verify tool: import the operator's real decks through the app's OWN importDeck, exercising the
 * PowerPoint renderer end-to-end, and bake a ready-to-open plan.
 *
 *   npx tsx --tsconfig ./tsconfig.node.json scripts/import-decks.mts
 *
 * This deliberately drives the SAME code path the app uses (importDeck with the bundled PowerPoint
 * helper), so a clean result here is real evidence the app renders every slide by itself. Output
 * lives under the gitignored release/ folder and must never be committed (operator's own content);
 * slide text is never printed, only counts.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { detectImporter, detectPowerPoint, importDeck } from '@main/plan/deckImport'
import { emptyServicePlan } from '@shared/plan'

const REPO = process.cwd()
const PP_SCRIPT = join(REPO, 'resources', 'powerpoint', 'export-slides.ps1')
const OUT_BASE = join(REPO, 'release', '0.1.0', 'win-unpacked', 'plans')

const DECKS = [
  { service: '11am', deck: 'C:\\Users\\user\\OneDrive\\문서\\카카오톡 받은 파일\\【【【11시예배】】】.pptx' },
  { service: 'afternoon', deck: 'C:\\Users\\user\\OneDrive\\문서\\카카오톡 받은 파일\\오후예배.pptx' },
]

console.log(`PowerPoint: ${detectPowerPoint() ?? 'none'} | LibreOffice: ${detectImporter().executablePath ?? 'none'}`)

for (const { service, deck } of DECKS) {
  const planDir = join(OUT_BASE, service)
  const assetDir = join(planDir, 'assets')

  console.log(`\n[${service}] importing via app importDeck (PowerPoint preferred)…`)
  const result = await importDeck(deck, { assetDir, deriveAnchors: true, powerPointScriptPath: PP_SCRIPT })
  if (!result.ok) {
    console.error(`  FAILED — ${result.error.code}: ${result.error.message}`)
    continue
  }
  const r = result.value
  const anchored = r.cues.filter((c) => c.trigger.mode === 'anchor').length
  const plan = { ...emptyServicePlan(service), cues: [...r.cues], assetDir: 'assets' }
  writeFileSync(join(planDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  console.log(
    `  backend=${r.backend}: ${r.slidesTotal} slides, ${r.slidesWithAsset} with an image, ${anchored} auto-anchored -> plan.json`,
  )
  if (r.slidesMissingAsset.length > 0) {
    console.log(`  slides with no image: ${r.slidesMissingAsset.join(', ')}`)
  }
  for (const w of r.warnings) console.log(`  warning: ${w}`)
}
