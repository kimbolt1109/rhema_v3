/**
 * Derive the shipped OBS template by driving a real OBS, instead of hand-authoring its files.
 *
 * ## Why this script exists at all
 *
 * `portable/obs/template/` contains a scene collection and a profile that a fresh OBS will load as
 * its own. Both are OBS-internal formats with no published schema, and both were nearly authored
 * from memory. Doing that would have shipped at least two silent faults, because a real OBS was
 * asked instead and disagreed twice:
 *
 *   1. `global.ini` is **empty** on this OBS. Profile and scene-collection selection moved to
 *      `user.ini` under `[Basic]`. A template written from the older, widely-documented layout is
 *      not rejected — it is *ignored*, and OBS silently starts on its own default collection.
 *   2. The scene JSON carries a `canvas_uuid` and a `version` field that a hand-written file would
 *      have omitted.
 *
 * So the template is generated: this launches a throwaway copy of OBS, asks it over obs-websocket
 * to build exactly the scene we want, closes it so it serialises its own state, and harvests the
 * files it wrote. The format is therefore whatever OBS says it is, on the OBS version we tested.
 *
 * Re-run it when OBS changes format, or when the shipped scene should change. It is not part of the
 * build and nothing imports it.
 *
 * ## What it deliberately does NOT do
 *
 * It does not touch the operator's real OBS. It works only on the directory passed to it, which
 * must be a *copy*, and it refuses to run against a path under `Program Files` or `%APPDATA%` —
 * Standing Rule 2 says OBS is the resilient engine and this project does not edit its settings.
 *
 * Usage:
 *   npx tsx --tsconfig ./tsconfig.node.json scripts/derive-obs-scene-template.mts <path-to-obs-copy>
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import OBSWebSocket from 'obs-websocket-js'

/** The scene the operator sees. One scene, not four — see the note in OBS-SETUP.md. */
const SCENE_NAME = 'Cam 1'
/** Must match the name OBS-SETUP.md tells the operator to look for. */
const OVERLAY_SOURCE_NAME = 'Overlays'
const COLLECTION_NAME = 'Verger'
const PROFILE_NAME = 'Verger'
/** Matches `overlay.port` in `portable/config.json`. */
const OVERLAY_URL = 'http://127.0.0.1:7320/overlay'
/** Derivation only. The shipped assembly generates a fresh random password per USB stick. */
const DERIVE_PORT = 4455

/**
 * Build INPUT, so it lives at the repo root rather than under `portable/`.
 *
 * `scripts/make-portable.mjs` copies all of `portable/**` onto the USB stick — that folder means
 * "what ends up on the stick". A template kept there would ship as dead weight AND land at
 * `<USB>/obs/template`, inside the folder the assembled OBS itself occupies.
 */
const REPO_TEMPLATE_DIR = resolve(import.meta.dirname, '..', 'obs-template')

function fail(message: string): never {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

/**
 * The browser source settings, and the five that are the whole point of shipping this.
 *
 * `shutdown` and `restart_when_active` destroy and recreate the page on every scene change, which
 * is precisely when a graphic must not flicker or vanish. `reroute_audio` is what puts the source
 * into OBS's Audio Mixer — without it a video cue plays silently to the congregation and the stream,
 * and that cannot be fixed while it is playing. `css` must be EMPTY: OBS pre-fills a default
 * stylesheet that fights the overlay page's own layout.
 *
 * These are exactly the settings OBS-SETUP.md steps 4 and 7 asked the operator to set by hand, in
 * the right state. Shipping them is what deletes those two steps.
 */
const BROWSER_SETTINGS = {
  url: OVERLAY_URL,
  width: 1920,
  height: 1080,
  css: '',
  shutdown: false,
  restart_when_active: false,
  reroute_audio: true,
} as const

/**
 * Profile parameters worth pre-setting, each for a reason that shows up only when something breaks.
 *
 * `RecFormat2=mkv` is the important one and it is a Standing Rule 3 concern: recording is always on
 * whenever streaming is, and an `.mp4` whose OBS crashed mid-write is an unplayable file — the
 * recording of the service is simply gone. Matroska survives the same crash and remuxes to mp4
 * afterwards. Resolution is pinned to 1920x1080 so the overlay's own 1920x1080 page maps 1:1 and
 * text stays sharp.
 */
const PROFILE_PARAMETERS: ReadonlyArray<{ category: string; name: string; value: string }> = [
  { category: 'Video', name: 'BaseCX', value: '1920' },
  { category: 'Video', name: 'BaseCY', value: '1080' },
  { category: 'Video', name: 'OutputCX', value: '1920' },
  { category: 'Video', name: 'OutputCY', value: '1080' },
  { category: 'Video', name: 'FPSCommon', value: '30' },
  { category: 'SimpleOutput', name: 'RecFormat2', value: 'mkv' },
]

async function portAccepts(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const finish = (up: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(up)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('timeout', () => {
      finish(false)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}

async function waitForPort(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await portAccepts(port)) return
    await delay(1000)
  }
  fail(`OBS never began listening on ${String(port)}. Is obs-websocket enabled in the copy?`)
}

const obsRoot = process.argv[2]
if (obsRoot === undefined || obsRoot.length === 0) {
  fail('Pass the path to a COPY of an OBS install: derive-obs-scene-template.mts <path>')
}
const root = resolve(obsRoot)

// Refuse to operate on a real install. This script writes into the directory it is given.
const guarded = root.toLowerCase()
if (guarded.includes('program files') || guarded.includes('appdata\\roaming')) {
  fail(`Refusing to modify what looks like a real OBS install:\n  ${root}\nPass a copy instead.`)
}
const exe = join(root, 'bin', '64bit', 'obs64.exe')
if (!existsSync(exe)) fail(`No obs64.exe under ${root}. Expected ${exe}`)

const configDir = join(root, 'config', 'obs-studio')

console.log('Preparing the throwaway OBS copy…')
writeFileSync(join(root, 'portable_mode.txt'), '', 'utf8')

// Make the run repeatable. obs-websocket has no "delete scene collection" request, so a second run
// would collide with the collection the first one made and fail at CreateSceneCollection. Clearing
// the artefacts on disk first — and pointing `user.ini` away from them — puts OBS back in the state
// where it can create them cleanly.
for (const stale of [
  join(configDir, 'basic', 'scenes', `${COLLECTION_NAME}.json`),
  join(configDir, 'basic', 'scenes', `${COLLECTION_NAME}.json.bak`),
]) {
  if (existsSync(stale)) rmSync(stale)
}
const staleProfile = join(configDir, 'basic', 'profiles', PROFILE_NAME)
if (existsSync(staleProfile)) rmSync(staleProfile, { recursive: true })
const priorUserIni = join(configDir, 'user.ini')
if (existsSync(priorUserIni)) {
  // Blanking the selection makes OBS fall back to its own default collection, leaving the names
  // this script is about to create unoccupied.
  const reset = readFileSync(priorUserIni, 'utf8')
    .replace(new RegExp(`^(Profile|ProfileDir|SceneCollection|SceneCollectionFile)=${PROFILE_NAME}.*$`, 'gm'), '')
  writeFileSync(priorUserIni, reset, 'utf8')
}

// Enable the WebSocket server with authentication OFF. Derivation only, on a scratch copy, bound to
// loopback — the shipped assembly generates a random password instead.
const wsDir = join(configDir, 'plugin_config', 'obs-websocket')
mkdirSync(wsDir, { recursive: true })
writeFileSync(
  join(wsDir, 'config.json'),
  `${JSON.stringify(
    {
      alerts_enabled: false,
      auth_required: false,
      first_load: false,
      server_enabled: true,
      server_password: '',
      server_port: DERIVE_PORT,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// ConfirmOnExit would block the graceful close below on a modal dialog, and the close is what makes
// OBS serialise the scene collection at all.
const userIniPath = join(configDir, 'user.ini')
if (existsSync(userIniPath)) {
  const patched = readFileSync(userIniPath, 'utf8').replace(
    /ConfirmOnExit=true/g,
    'ConfirmOnExit=false',
  )
  writeFileSync(userIniPath, patched, 'utf8')
}

console.log('Launching OBS…')
const child = spawn(exe, ['--multi', '--disable-updater'], {
  cwd: join(root, 'bin', '64bit'),
  detached: false,
  stdio: 'ignore',
})

await waitForPort(DERIVE_PORT)
console.log('OBS is up. Connecting over obs-websocket…')

const obs = new OBSWebSocket()
await obs.connect(`ws://127.0.0.1:${String(DERIVE_PORT)}`)

const { obsVersion, obsWebSocketVersion } = await obs.call('GetVersion')
console.log(`  OBS ${obsVersion}, obs-websocket ${obsWebSocketVersion}`)

console.log(`Creating scene collection "${COLLECTION_NAME}"…`)
await obs.call('CreateSceneCollection', { sceneCollectionName: COLLECTION_NAME })
// Switching collections is asynchronous inside OBS; the next call can arrive mid-swap.
await delay(2500)

console.log(`Creating scene "${SCENE_NAME}" and the "${OVERLAY_SOURCE_NAME}" browser source…`)
await obs.call('CreateScene', { sceneName: SCENE_NAME })
await obs.call('SetCurrentProgramScene', { sceneName: SCENE_NAME })

await obs.call('CreateInput', {
  sceneName: SCENE_NAME,
  inputName: OVERLAY_SOURCE_NAME,
  inputKind: 'browser_source',
  inputSettings: { ...BROWSER_SETTINGS },
  sceneItemEnabled: true,
})

// A fresh collection comes with its own default scene, whose name is LOCALISED — on a Korean OBS it
// is "장면". Delete by difference rather than by name, so this works on any locale.
const { scenes } = await obs.call('GetSceneList')
for (const scene of scenes) {
  const name = (scene as { sceneName?: string }).sceneName
  if (name !== undefined && name !== SCENE_NAME) {
    console.log(`  removing OBS's default scene "${name}"`)
    await obs.call('RemoveScene', { sceneName: name })
  }
}

console.log('Setting profile parameters…')
await obs.call('CreateProfile', { profileName: PROFILE_NAME })
await delay(2500)
for (const parameter of PROFILE_PARAMETERS) {
  await obs.call('SetProfileParameter', {
    parameterCategory: parameter.category,
    parameterName: parameter.name,
    parameterValue: parameter.value,
  })
}

// Read back what OBS believes, rather than what we just sent it.
const readBack = await obs.call('GetInputSettings', { inputName: OVERLAY_SOURCE_NAME })
console.log('  browser source as OBS stored it:', JSON.stringify(readBack.inputSettings))

await obs.disconnect()

console.log('Closing OBS so it writes its files…')
// OBS serialises the scene collection on a clean shutdown, not while running. taskkill without /F
// posts WM_CLOSE, which is the graceful path; ConfirmOnExit was disabled above so nothing blocks.
spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' })
await delay(8000)

/**
 * What may leave this machine, key by key.
 *
 * OBS writes a COMPLETE profile, and most of it describes the computer it was written on. The first
 * derivation produced eight lines that would have been actively harmful on a church PC:
 *
 *   FilePath / RecFilePath / FFFilePath = C:\Users\user\Videos   <- this laptop's home directory
 *   StreamEncoder / RecEncoder = nvenc, NVENCPreset2 = p5        <- this laptop has an NVIDIA GPU
 *   MonitoringDeviceName = 기본값                                 <- this laptop's locale
 *   CookieId = BE56F2D3855B44C8                                  <- this laptop's browser panel
 *
 * A recording path that does not exist is a Standing Rule 3 failure — recording is always on when
 * streaming is, and it would fail on a machine nobody had tested. An encoder that does not exist is
 * worse: OBS refuses to start the output at all.
 *
 * So the profile is rebuilt from this allowlist rather than copied. Anything absent falls back to
 * OBS's own default, computed on the machine that runs it — which is exactly what a template wants.
 * An allowlist rather than a denylist because the failure directions are not symmetric: a key we
 * forgot to allow costs a default, a key we forgot to deny ships someone else's hardware.
 */
const PROFILE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  General: ['Name'],
  Output: ['Mode'],
  // Only the format. Bitrate, preset and encoder are all machine-shaped; let OBS choose.
  SimpleOutput: ['RecFormat2'],
  Video: ['BaseCX', 'BaseCY', 'OutputCX', 'OutputCY', 'FPSType', 'FPSCommon'],
  Audio: ['SampleRate', 'ChannelSetup'],
}

/** Rebuild an OBS ini keeping only allowlisted keys, preserving section order. */
function sanitiseIni(raw: string, allow: Readonly<Record<string, readonly string[]>>): string {
  const lines = raw.split(/\r?\n/)
  const kept = new Map<string, string[]>()
  let section = ''
  for (const line of lines) {
    const header = /^\[(.+)]$/.exec(line.trim().replace(/^\uFEFF/, ''))
    if (header?.[1] !== undefined) {
      section = header[1]
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!(allow[section] ?? []).includes(key)) continue
    const bucket = kept.get(section) ?? []
    bucket.push(`${key}=${line.slice(eq + 1).trim()}`)
    kept.set(section, bucket)
  }
  const out: string[] = []
  for (const [name, entries] of kept) {
    out.push(`[${name}]`, ...entries, '')
  }
  return out.join('\n')
}

/**
 * The one file that actually selects the profile and the scene collection.
 *
 * Written from scratch rather than harvested: the real `user.ini` is 40 lines of window geometry,
 * dock layout and this machine's appearance settings. Only `[Basic]` matters, and `FirstRun=true`,
 * which is what stops OBS opening its auto-configuration wizard on the church PC — a wizard that
 * would otherwise run a bandwidth test in front of the operator and overwrite the profile below.
 */
function renderUserIni(): string {
  return [
    '[General]',
    // These four select modern audio/encoder defaults. A fresh OBS writes them; without them OBS
    // can assume pre-2017 behaviour for a config it did not create itself.
    'Pre19Defaults=false',
    'Pre21Defaults=false',
    'Pre23Defaults=false',
    'Pre24.1Defaults=false',
    'HotkeyFocusType=NeverDisableHotkeys',
    // Suppresses the auto-configuration wizard on the very first launch. See above.
    'FirstRun=true',
    '',
    '[Basic]',
    `Profile=${PROFILE_NAME}`,
    `ProfileDir=${PROFILE_NAME}`,
    `SceneCollection=${COLLECTION_NAME}`,
    `SceneCollectionFile=${COLLECTION_NAME}.json`,
    'ConfigOnNewProfile=false',
    '',
  ].join('\n')
}

console.log('Harvesting…')
const scenesDir = join(configDir, 'basic', 'scenes')
const sceneFiles = readdirSync(scenesDir).filter(
  (f) => f.endsWith('.json') && f.includes(COLLECTION_NAME),
)
if (sceneFiles.length === 0) {
  fail(`OBS wrote no scene collection named ${COLLECTION_NAME} in ${scenesDir}`)
}
const sceneFile = sceneFiles[0] as string

const outRoot = join(REPO_TEMPLATE_DIR, 'config', 'obs-studio')
const outScenes = join(outRoot, 'basic', 'scenes')
const outProfile = join(outRoot, 'basic', 'profiles', PROFILE_NAME)
mkdirSync(outScenes, { recursive: true })
mkdirSync(outProfile, { recursive: true })

copyFileSync(join(scenesDir, sceneFile), join(outScenes, `${COLLECTION_NAME}.json`))
console.log(`  scene collection -> ${join(outScenes, `${COLLECTION_NAME}.json`)}`)

const profileSrc = join(configDir, 'basic', 'profiles', PROFILE_NAME, 'basic.ini')
if (!existsSync(profileSrc)) fail(`OBS wrote no profile at ${profileSrc}`)
const sanitised = sanitiseIni(readFileSync(profileSrc, 'utf8'), PROFILE_ALLOWLIST)
writeFileSync(join(outProfile, 'basic.ini'), sanitised, 'utf8')
console.log(`  profile          -> ${join(outProfile, 'basic.ini')} (${
  readFileSync(profileSrc, 'utf8').split(/\r?\n/).length
} lines in, ${sanitised.split('\n').length} out)`)

writeFileSync(join(outRoot, 'user.ini'), renderUserIni(), 'utf8')
console.log(`  user.ini         -> ${join(outRoot, 'user.ini')}`)

console.log('\nDone. `src/main/obs/obsTemplate.test.ts` guards the result.')
