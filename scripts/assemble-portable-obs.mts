/**
 * Assemble a portable OBS into the USB folder, pre-wired so the operator configures nothing.
 *
 * ## What this removes
 *
 * `portable/obs/OBS-SETUP.md` is seven steps long, and five of them are OBS's, not Verger's: switch
 * the WebSocket server on, add a Browser source, set its URL, clear its CSS, untick two checkboxes
 * that would otherwise destroy the page on every scene change, and tick "Control audio via OBS" so
 * a video cue is not silent. Every one of those is a click on a Sunday morning, and two of them
 * fail *invisibly* — a wrong checkbox looks identical to a right one until the graphic vanishes
 * mid-service or the video plays with no sound.
 *
 * All of it is state in files. So it is shipped as files.
 *
 * After this runs, first launch on the church PC is: start OBS from the USB, start Verger. Verger
 * finds OBS by itself, because `readObsWebsocketConfig` checks the portable location this writes.
 *
 * ## The password
 *
 * A fresh random password per assembly, generated here and never committed. Not a fixed one — a
 * shared secret in a public repo is not a secret, and obs-websocket listens on every interface, so
 * on a church LAN a known password means anyone on the wifi can drive the stream. Not blank either,
 * for the same reason. The operator never sees it and never types it: it goes into OBS's own config
 * file, and Verger reads it from there (Standing Rule 5 — it stays out of Verger's `config.json`).
 *
 * ## What it will NOT do
 *
 * It does not download OBS. Redistributing OBS is a licensing decision for whoever ships the stick,
 * so you supply the OBS folder or its .zip and this wires up a COPY. It never writes to the source
 * you point it at, and it refuses to run against an installed OBS under `Program Files`.
 *
 * Usage:
 *   npm run obs:assemble -- <path-to-obs-folder-or-zip> [target]
 *
 * `target` defaults to `release/0.1.0/win-unpacked/obs`, i.e. beside `Verger.exe`.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const TEMPLATE_DIR = join(REPO_ROOT, 'obs-template')
const DEFAULT_TARGET = join(REPO_ROOT, 'release', '0.1.0', 'win-unpacked', 'obs')

/** Must match `OBS_PORTABLE_DIR_NAME` in `src/main/obs/localConfig.ts`. */
const EXPECTED_DIR_NAME = 'obs'
/** Must match `obs.port` in `portable/config.json`. */
const OBS_PORT = 4455

function fail(message: string): never {
  console.error(`\n  assemble-portable-obs: ${message}\n`)
  process.exit(1)
}

function findObsRoot(start: string): string | null {
  // An OBS zip may unpack with a wrapper folder. Accept either shape rather than making the operator
  // care which one they downloaded.
  if (existsSync(join(start, 'bin', '64bit', 'obs64.exe'))) return start
  for (const entry of readdirSync(start)) {
    const candidate = join(start, entry)
    if (!statSync(candidate).isDirectory()) continue
    if (existsSync(join(candidate, 'bin', '64bit', 'obs64.exe'))) return candidate
  }
  return null
}

const sourceArg = process.argv[2]
if (sourceArg === undefined || sourceArg.length === 0) {
  fail('Pass the OBS folder or .zip:\n    npm run obs:assemble -- "C:\\path\\to\\OBS-Studio-32.1.2"')
}
const source = resolve(sourceArg)
if (!existsSync(source)) fail(`No such path:\n    ${source}`)

const target = resolve(process.argv[3] ?? DEFAULT_TARGET)
if (!existsSync(TEMPLATE_DIR)) {
  fail(
    `The template is missing:\n    ${TEMPLATE_DIR}\n` +
      `  Regenerate it with scripts/derive-obs-scene-template.mts.`,
  )
}

// Standing Rule 2: this project does not modify an OBS the operator installed.
if (source.toLowerCase().includes('program files')) {
  fail(
    `That is an installed OBS:\n    ${source}\n` +
      `  This script assembles a separate PORTABLE copy and will not touch an installed one.\n` +
      `  Copy the folder elsewhere first, or point at a downloaded .zip.`,
  )
}

console.log(`Source:  ${source}`)
console.log(`Target:  ${target}`)

let unpackedSource = source
if (statSync(source).isFile()) {
  if (!source.toLowerCase().endsWith('.zip')) {
    fail(`Expected a folder or a .zip, got:\n    ${source}`)
  }
  const staging = join(target, '..', '.obs-unzip-staging')
  console.log('\nUnzipping…')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  // Expand-Archive rather than a zip dependency: this runs on the machine that builds the stick,
  // which is Windows by construction (the target is an unpacked Windows Electron app).
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath "${source}" -DestinationPath "${staging}" -Force`,
    ],
    { stdio: 'inherit' },
  )
  unpackedSource = staging
}

const obsRoot = findObsRoot(unpackedSource)
if (obsRoot === null) {
  fail(
    `No bin\\64bit\\obs64.exe under:\n    ${unpackedSource}\n  That does not look like an OBS build.`,
  )
}

if (target.split(/[\\/]/).pop() !== EXPECTED_DIR_NAME) {
  console.warn(
    `\n  WARNING: the target folder is not named "${EXPECTED_DIR_NAME}".\n` +
      `  Verger looks for a bundled OBS at <folder-with-Verger.exe>\\${EXPECTED_DIR_NAME}, so it will\n` +
      `  not find this one automatically.\n`,
  )
}

console.log('\nCopying OBS…')
mkdirSync(target, { recursive: true })
cpSync(obsRoot, target, { recursive: true, force: true })

// The marker. Its presence beside bin/ is what makes OBS store settings inside its own folder
// instead of %APPDATA% — which is what makes the stick self-contained AND what makes the settings
// below take effect at all. Verified by running it: with this file, OBS created
// <obs>/config/obs-studio/ and never touched %APPDATA%.
writeFileSync(join(target, 'portable_mode.txt'), '', 'utf8')
console.log('  portable_mode.txt written')

// Start from no config at all. If the source folder had ever been launched, its `config/` came
// along with the copy — someone else's scene collections, logs and cached settings, merging with
// the template instead of being replaced by it. The stick must be identical whichever OBS folder it
// was built from, so the only settings present are the ones below.
rmSync(join(target, 'config'), { recursive: true, force: true })

console.log('Applying the pre-wired scene collection and profile…')
cpSync(join(TEMPLATE_DIR, 'config'), join(target, 'config'), { recursive: true, force: true })

const password = randomBytes(18).toString('base64url')
const wsDir = join(target, 'config', 'obs-studio', 'plugin_config', 'obs-websocket')
mkdirSync(wsDir, { recursive: true })
writeFileSync(
  join(wsDir, 'config.json'),
  `${JSON.stringify(
    {
      alerts_enabled: false,
      // Authentication ON. obs-websocket listens on every interface, so on a church wifi an
      // unauthenticated server is a stream anyone present can take over.
      auth_required: true,
      // Tells obs-websocket the settings are already established, so it does not replace the
      // password below with one of its own on first launch.
      first_load: false,
      server_enabled: true,
      server_password: password,
      server_port: OBS_PORT,
    },
    null,
    2,
  )}\n`,
  'utf8',
)
console.log(`  obs-websocket enabled on port ${String(OBS_PORT)}, unique password generated`)

if (unpackedSource !== source) {
  rmSync(unpackedSource, { recursive: true, force: true })
}

const exeRelative = join('bin', '64bit', 'obs64.exe')
console.log(`
Done.

  ${join(target, exeRelative)}

  The password is inside the assembled folder and nowhere else — it is not printed here, not
  committed, and never has to be typed. Verger reads it from OBS's own config file at launch.

  On the church PC: start OBS from this folder, then start Verger. The Connection screen should
  already say Connected, and the "Overlays" browser source is already in the "Cam 1" scene.
  Add the room's camera to that scene and you are done.
`)
