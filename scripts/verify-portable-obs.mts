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
 *      checkboxes that fail invisibly set the right way;
 *   6. the folder is byte-identical afterwards — see below.
 *
 * ## Why it restores the config
 *
 * Verifying is destructive. Running OBS even once writes logs, crash and profiler directories,
 * several megabytes of Chromium GPU shader cache compiled for the GPU of whichever machine built
 * the stick, a cookie database, and its own rewrite of `user.ini`. That is the same machine-specific
 * leakage the profile allowlist in `derive-obs-scene-template.mts` exists to prevent, arriving
 * through the back door — and it lands in the folder that is about to be carried to a church.
 *
 * So `config/` is snapshotted before OBS starts and restored after it exits, and the restore is
 * itself a check rather than an assumption. `portable_mode.txt` confines OBS to this directory, so
 * `config/` is the whole of what it can reach.
 *
 * Usage:
 *   npm run obs:verify -- <path-to-assembled-obs-folder>
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import OBSWebSocket from 'obs-websocket-js'

import { isObsPortListening, readObsWebsocketConfig } from '@main/obs/localConfig'

const checks: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string, detail = ''): void {
  checks.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * Delete `dir`, retrying while Windows still holds handles open.
 *
 * `taskkill /T` ends OBS's browser subprocesses, but Windows releases their file handles
 * asynchronously — for a second or so afterwards `debug.log` and the leveldb `LOCK` files under
 * `plugin_config/obs-browser/` are still open, and `rmSync` throws EPERM part-way through. That
 * failure is worse than not restoring at all: it deletes `basic/` (the scene collection and
 * profile) before it reaches the locked file, then aborts, leaving a folder that is both
 * contaminated AND missing the very thing the stick exists to carry. Observed, not theorised.
 */
async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(500)
    }
  }
  // Last attempt outside the catch, so a genuine permissions problem still surfaces as an error
  // rather than being silently swallowed into a mangled restore.
  rmSync(dir, { recursive: true, force: true })
}

/** Sorted `<relative-path>:<sha256>` lines for every file under `dir`. Order-stable, content-exact. */
function fingerprint(dir: string): string {
  const lines: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else lines.push(`${relative(dir, full)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  walk(dir)
  return lines.sort().join('\n')
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

const configDir = join(obsDir, 'config')
const snapshotDir = mkdtempSync(join(tmpdir(), 'verger-obs-config-'))
cpSync(configDir, snapshotDir, { recursive: true })
const configBefore = fingerprint(configDir)

console.log('\nStarting OBS…')
const child = spawn(exe, ['--multi', '--disable-updater'], {
  cwd: join(obsDir, 'bin', '64bit'),
  stdio: 'ignore',
})
const childExited = new Promise<void>((resolveExit) => {
  child.once('exit', () => {
    resolveExit()
  })
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
  } catch (error) {
    check(false, 'the generated password authenticates', String(error))
  }

  if (connected) {
    try {
      // OBS opens the WebSocket port BEFORE it has finished loading its scene collection, and
      // answers anything asked in that window with "OBS is not ready to perform the request".
      // Poll rather than sleep a constant: on a slower machine the collection takes longer than
      // any number worth hard-coding, and a fixed sleep would make this pass or fail by luck —
      // which is exactly how an earlier run of this script reported a false 16/16.
      for (let i = 0; i < 30; i += 1) {
        try {
          await obs.call('GetVersion')
          break
        } catch {
          await delay(1000)
        }
      }

      const list = await obs.call('GetSceneList')
      sceneNames = list.scenes.map((s) => String((s as { sceneName?: string }).sceneName ?? ''))
      const settings = await obs.call('GetInputSettings', { inputName: 'Overlays' })
      overlaySettings = settings.inputSettings as Record<string, unknown>
    } catch (error) {
      check(false, 'OBS answered the scene and source queries', String(error))
      connected = false
    }
    await obs.disconnect()
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
// Wait for the process to be gone rather than guessing at a delay: restoring while OBS is still
// alive would let it write the contamination back after the restore.
await Promise.race([childExited, delay(15_000)])
await delay(1000)

let restored = false
try {
  await removeWithRetry(configDir)
  cpSync(snapshotDir, configDir, { recursive: true })
  restored = true
  rmSync(snapshotDir, { recursive: true, force: true })
} catch (error) {
  // Keep the snapshot and say where it is. A half-restored folder is the one outcome that must
  // never pass quietly, because it looks fine in a directory listing and is not.
  console.error(`\n  RESTORE FAILED: ${String(error)}`)
  console.error(`  The untouched config is still at:\n    ${snapshotDir}`)
  console.error(`  Re-run "npm run obs:assemble" to rebuild this folder before shipping it.\n`)
}
check(
  restored && fingerprint(configDir) === configBefore,
  'the verified folder was left byte-identical (nothing this machine wrote survives)',
)

const failed = checks.filter((c) => !c.ok)
console.log(
  `\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed.${
    failed.length === 0 ? ' The stick is ready.' : ''
  }\n`,
)
process.exit(failed.length > 0 ? 1 : 0)
