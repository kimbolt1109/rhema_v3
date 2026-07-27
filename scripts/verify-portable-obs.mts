/**
 * Prove an assembled portable OBS actually works — before the stick is carried to a church.
 *
 * ## Why this is not a unit test
 *
 * Everything about the portable OBS support is testable in isolation and all of it passes: the path
 * resolver, the precedence rules, the template guard. None of that proves the one thing that
 * matters, which is that Verger's discovery finds a REAL running OBS and can authenticate to it.
 * That needs an actual OBS process, so it lives here rather than in `vitest`.
 *
 * It drives the SAME functions the app uses at launch — `readObsWebsocketConfig` and
 * `isObsPortListening`, imported from `@main/obs/localConfig`, not reimplemented — so a pass here is
 * evidence about the product and not about this script.
 *
 * ## What it proves, in order
 *
 *   1. the assembled folder is in portable mode and carries the template;
 *   2. Verger's discovery finds OBS's settings in the PORTABLE location, not %APPDATA%;
 *   3. OBS actually starts and opens the port discovery reported;
 *   4. the generated password authenticates — this is the step that catches a password written in
 *      the wrong shape, which every offline test would pass;
 *   5. the pre-wired scene and the Overlays browser source are really there, with the two
 *      checkboxes that fail invisibly set the right way.
 *
 * Usage:
 *   npm run obs:verify -- <path-to-assembled-obs-folder>
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import OBSWebSocket from 'obs-websocket-js'

import { isObsPortListening, readObsWebsocketConfig } from '@main/obs/localConfig'

const checks: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string, detail = ''): void {
  checks.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

const arg = process.argv[2]
if (arg === undefined || arg.length === 0) {
  console.error('\n  Pass the assembled OBS folder:  npm run obs:verify -- <path>\n')
  process.exit(1)
}
const obsDir = resolve(arg)
const exe = join(obsDir, 'bin', '64bit', 'obs64.exe')

console.log(`\nVerifying ${obsDir}\n`)

console.log('Files:')
check(existsSync(exe), 'obs64.exe is present')
check(existsSync(join(obsDir, 'portable_mode.txt')), 'portable_mode.txt marks it portable')
check(
  existsSync(join(obsDir, 'config', 'obs-studio', 'basic', 'scenes', 'Verger.json')),
  'the Verger scene collection is installed',
)
check(existsSync(join(obsDir, 'config', 'obs-studio', 'user.ini')), 'user.ini selects it')

if (!existsSync(exe)) {
  console.error('\n  Nothing further can be checked without obs64.exe.\n')
  process.exit(1)
}

console.log('\nDiscovery (the code Verger runs at launch):')
// APPDATA is blanked deliberately. If discovery still finds settings, they came from the portable
// folder — this machine also has an OBS installed, and reading THAT would be a false pass.
const discovered = readObsWebsocketConfig({ portableObsDir: obsDir, appDataDir: '' })
check(discovered.ok, 'readObsWebsocketConfig finds the portable settings')
if (!discovered.ok) {
  console.error(`\n  ${discovered.error.message}\n`)
  process.exit(1)
}
check(
  discovered.value.sourcePath.startsWith(obsDir),
  'the settings came from the portable folder, not %APPDATA%',
  discovered.value.sourcePath.replace(obsDir, '<obs>'),
)
check(discovered.value.serverEnabled, 'the WebSocket server is pre-enabled')
check(discovered.value.authRequired, 'authentication is required')
check(
  discovered.value.password.length >= 16,
  'a strong password was generated',
  `${String(discovered.value.password.length)} chars`,
)

console.log('\nStarting OBS…')
const child = spawn(exe, ['--multi', '--disable-updater'], {
  cwd: join(obsDir, 'bin', '64bit'),
  stdio: 'ignore',
})

let listening = false
for (let i = 0; i < 60 && !listening; i += 1) {
  listening = await isObsPortListening(discovered.value.port)
  if (!listening) await delay(1000)
}
check(listening, `OBS opened port ${String(discovered.value.port)}`)

let sceneNames: string[] = []
let overlaySettings: Record<string, unknown> = {}
let connected = false

if (listening) {
  const obs = new OBSWebSocket()
  try {
    // The real test of the generated password.
    await obs.connect(`ws://127.0.0.1:${String(discovered.value.port)}`, discovered.value.password)
    connected = true
    check(true, 'the generated password authenticates')

    const list = await obs.call('GetSceneList')
    sceneNames = list.scenes.map((s) => String((s as { sceneName?: string }).sceneName ?? ''))
    const settings = await obs.call('GetInputSettings', { inputName: 'Overlays' })
    overlaySettings = settings.inputSettings as Record<string, unknown>
    await obs.disconnect()
  } catch (error) {
    check(false, 'the generated password authenticates', String(error))
  }
}

if (connected) {
  console.log('\nWhat OBS reports:')
  check(sceneNames.includes('Cam 1'), 'the "Cam 1" scene exists', sceneNames.join(', '))
  check(
    overlaySettings['url'] === 'http://127.0.0.1:7320/overlay',
    'the Overlays source points at Verger',
    String(overlaySettings['url']),
  )
  check(overlaySettings['shutdown'] === false, 'the page is NOT shut down when hidden')
  check(overlaySettings['restart_when_active'] === false, 'the page does NOT reload on scene change')
  check(overlaySettings['reroute_audio'] === true, 'video audio is routed into the OBS mixer')
}

console.log('\nStopping OBS…')
spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await delay(2000)

const failed = checks.filter((c) => !c.ok)
console.log(
  `\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed.${
    failed.length === 0 ? ' The stick is ready.' : ''
  }\n`,
)
process.exit(failed.length > 0 ? 1 : 0)
