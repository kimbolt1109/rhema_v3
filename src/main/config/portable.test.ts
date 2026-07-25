import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadPortableConfig, resolveConfiguredPlanPath } from './portable'

/**
 * The portable loader is what stands between an operator's `config.json` (or the lack of one) and a
 * successful launch on a strange PC. These cases cover the four states it must survive: a packaged
 * first launch with no file, a returning launch with a good file, a hand-broken file, and the dev
 * machine — which must be left completely alone so the `.env` flow and its tests are unchanged.
 */
const scratchDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verger-portable-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  // Best-effort cleanup; a leftover temp dir is harmless if this ever fails.
  scratchDirs.length = 0
})

describe('loadPortableConfig', () => {
  it('writes a default config.json on a packaged first launch, and runs on it', () => {
    const configDir = freshDir()
    const result = loadPortableConfig({ isPackaged: true, exeDir: configDir, configDir })

    expect(result.source).toBe('default-written')
    expect(result.managed).toBe(true)
    expect(existsSync(join(configDir, 'config.json'))).toBe(true)
    expect(result.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://127.0.0.1:4455')
    expect(result.overlayPort).toBe(7320)
    expect(result.envFilePath).toBe(join(configDir, '.env'))
  })

  it('reads an existing valid file on the next launch', () => {
    const configDir = freshDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ obs: { host: '10.0.0.7', port: 4460, password: 'x' }, overlay: { port: 7999 } }),
      'utf8',
    )

    const result = loadPortableConfig({ isPackaged: true, exeDir: configDir, configDir })

    expect(result.source).toBe('file')
    expect(result.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://10.0.0.7:4460')
    expect(result.envOverrides['OBS_WEBSOCKET_PASSWORD']).toBe('x')
    expect(result.overlayPort).toBe(7999)
  })

  it('falls back to defaults on a corrupt file WITHOUT overwriting the operator’s file', () => {
    const configDir = freshDir()
    const path = join(configDir, 'config.json')
    const broken = '{ this is not: json,,, '
    writeFileSync(path, broken, 'utf8')

    const result = loadPortableConfig({ isPackaged: true, exeDir: configDir, configDir })

    expect(result.source).toBe('invalid-fell-back')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://127.0.0.1:4455')
    // The operator's (broken) file is preserved so a hand-editing mistake can be fixed by hand.
    expect(readFileSync(path, 'utf8')).toBe(broken)
  })

  it('leaves the dev machine alone: no file written, no env overrides', () => {
    const configDir = freshDir()
    const result = loadPortableConfig({ isPackaged: false, exeDir: configDir, configDir })

    expect(result.source).toBe('dev-env')
    expect(result.managed).toBe(false)
    expect(result.envOverrides).toEqual({})
    expect(result.envFilePath).toBeNull()
    expect(existsSync(join(configDir, 'config.json'))).toBe(false)
  })

  it('reads a config.json in dev too, if a developer drops one in (opt-in)', () => {
    const configDir = freshDir()
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ obs: { host: '127.0.0.1', port: 4455 } }), 'utf8')

    const result = loadPortableConfig({ isPackaged: false, exeDir: configDir, configDir })

    expect(result.source).toBe('file')
    expect(result.managed).toBe(true)
    expect(result.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://127.0.0.1:4455')
  })
})

/**
 * `assets.plan` decides which service plan is on screen the second Verger launches — after the UI
 * redesign the slide grid IS the console, so getting this path wrong means a church PC that opens to
 * "No service plan is open." across the whole window.
 *
 * The load-bearing case is the relative one. A USB stick is `E:` on one machine and `F:` on the next,
 * so a plan path may only ever be anchored to the folder `config.json` itself sits in — never to the
 * working directory, which for a double-clicked exe is not reliably anything.
 */
describe('resolveConfiguredPlanPath', () => {
  const configDir = join('E:', 'Verger')

  it('anchors a relative path to the folder config.json lives in, not the cwd', () => {
    expect(resolveConfiguredPlanPath('plans/11am/plan.json', configDir)).toBe(
      join(configDir, 'plans', '11am', 'plan.json'),
    )
  })

  it('accepts Windows separators in the operator-typed value', () => {
    expect(resolveConfiguredPlanPath('plans\\afternoon\\plan.json', configDir)).toBe(
      join(configDir, 'plans', 'afternoon', 'plan.json'),
    )
  })

  it('honours an absolute path unchanged, for plans kept on a fixed drive', () => {
    const absolute = join('D:', 'services', '2026-07-26', 'plan.json')
    expect(resolveConfiguredPlanPath(absolute, configDir)).toBe(absolute)
  })

  it('treats an empty or whitespace-only value as "no plan configured"', () => {
    expect(resolveConfiguredPlanPath('', configDir)).toBeNull()
    expect(resolveConfiguredPlanPath('   ', configDir)).toBeNull()
  })

  it('trims a value a hand-editing operator left a space on', () => {
    expect(resolveConfiguredPlanPath('  plans/11am/plan.json  ', configDir)).toBe(
      join(configDir, 'plans', '11am', 'plan.json'),
    )
  })

  it('is the same answer whatever drive the stick got, given the same relative path', () => {
    const onE = resolveConfiguredPlanPath('plans/11am/plan.json', join('E:', 'Verger'))
    const onF = resolveConfiguredPlanPath('plans/11am/plan.json', join('F:', 'Verger'))
    expect(onE).not.toBe(onF)
    // The tail is identical; only the anchor moved. That is the whole portability property.
    expect(onE?.endsWith(join('Verger', 'plans', '11am', 'plan.json'))).toBe(true)
    expect(onF?.endsWith(join('Verger', 'plans', '11am', 'plan.json'))).toBe(true)
  })
})
