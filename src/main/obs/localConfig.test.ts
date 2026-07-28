/**
 * OBS's own settings, read rather than retyped.
 *
 * The last test in this file is the important one and it is deliberately conditional: it reads the
 * REAL obs-websocket settings file on this machine when one exists. Every other assertion here is
 * against a fixture I wrote, which proves only that the parser matches my belief about the format —
 * and my belief is exactly what could be wrong. A file OBS actually produced is the only evidence
 * that the field names are right.
 *
 * It never asserts on the password's value, and never prints it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ErrorCode } from '@shared/result'

import {
  OBS_PORTABLE_CONFIG_SEGMENTS,
  OBS_PORTABLE_DIR_NAME,
  OBS_WEBSOCKET_CONFIG_SEGMENTS,
  isObsPortListening,
  obsPortableWebsocketConfigPath,
  obsWebsocketConfigPath,
  readObsWebsocketConfig,
  waitForObsPort,
} from './localConfig'

/** The shape a real OBS install writes, with a synthetic secret. */
const REAL_SHAPE = {
  alerts_enabled: false,
  auth_required: true,
  first_load: false,
  server_enabled: true,
  server_password: 'PLACEHOLDERSECRET',
  server_port: 4455,
}

function reader(payload: unknown): () => string {
  return () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
}

function throwing(): () => string {
  return () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  }
}

describe('obsWebsocketConfigPath', () => {
  it('lands inside the obs-websocket plugin config directory', () => {
    const path = obsWebsocketConfigPath('C:/Users/someone/AppData/Roaming')
    for (const segment of OBS_WEBSOCKET_CONFIG_SEGMENTS) {
      expect(path).toContain(segment)
    }
    expect(path.endsWith('config.json')).toBe(true)
  })
})

describe('readObsWebsocketConfig', () => {
  it('reads the port, the auth flag and the password from a real-shaped file', () => {
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader(REAL_SHAPE),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.port).toBe(4455)
    expect(result.value.serverEnabled).toBe(true)
    expect(result.value.authRequired).toBe(true)
    expect(result.value.password).toBe('PLACEHOLDERSECRET')
    expect(result.value.sourcePath).toContain('obs-websocket')
  })

  it('reports a switched-off server rather than pretending it is reachable', () => {
    // The common state on a fresh machine: the plugin ships disabled. Discovery succeeding while
    // there is nothing listening is the case a caller must be able to tell apart, or it dials a
    // dead port and blames the network.
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader({ ...REAL_SHAPE, server_enabled: false }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.serverEnabled).toBe(false)
  })

  it('trusts auth_required over the presence of a password', () => {
    // OBS keeps the last password in the file after authentication is switched off, so a non-empty
    // `server_password` does not mean one is wanted.
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader({ ...REAL_SHAPE, auth_required: false }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.authRequired).toBe(false)
  })

  it('treats a missing file as NOT_FOUND, not as a fault', () => {
    const result = readObsWebsocketConfig({ appDataDir: 'C:/appdata', readFile: throwing() })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('refuses malformed JSON without throwing', () => {
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader('{ not json'),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.IO_ERROR)
  })

  it('refuses a JSON array, which is valid JSON and the wrong shape', () => {
    const result = readObsWebsocketConfig({ appDataDir: 'C:/appdata', readFile: reader([1, 2, 3]) })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.IO_ERROR)
  })

  // Each row is a COMPLETE fixture, not an override spread. Spreading `{}` over a base to mean
  // "absent" silently keeps the base's value, which made the absent case assert nothing at all.
  it.each([
    ['absent', { auth_required: true, server_enabled: true, server_password: 'PLACEHOLDERSECRET' }],
    ['null', { ...REAL_SHAPE, server_port: null }],
    ['a string', { ...REAL_SHAPE, server_port: '4455' }],
    ['zero', { ...REAL_SHAPE, server_port: 0 }],
    ['out of range', { ...REAL_SHAPE, server_port: 70_000 }],
    ['fractional', { ...REAL_SHAPE, server_port: 4455.5 }],
  ])('refuses a port that is %s', (_label, fixture) => {
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader(fixture),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.IO_ERROR)
  })

  it('defaults a non-string password to empty rather than rejecting the whole file', () => {
    // A usable port plus an odd password is still worth having: it connects when OBS has auth off,
    // and reports "password rejected" honestly when it does not.
    const result = readObsWebsocketConfig({
      appDataDir: 'C:/appdata',
      readFile: reader({ ...REAL_SHAPE, server_password: 42 }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.password).toBe('')
  })

  it('says so plainly when APPDATA is unavailable', () => {
    const result = readObsWebsocketConfig({ appDataDir: '' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
  })
})

describe('isObsPortListening', () => {
  it('says yes to a port that is really accepting, and no once it stops', async () => {
    // A real listener on an ephemeral port. The point of the probe is to tell "something is there"
    // from "nothing is", so a fake would test nothing.
    const server = createServer()
    const port = await new Promise<number>((resolvePort) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    expect(port).toBeGreaterThan(0)
    await expect(isObsPortListening(port)).resolves.toBe(true)

    await new Promise<void>((closed) => {
      server.close(() => {
        closed()
      })
    })

    // And the same port with nothing behind it. This is the case that decides whether Verger arms a
    // reconnect loop that would report "OBS went away" about an OBS that was never there.
    await expect(isObsPortListening(port)).resolves.toBe(false)
  })

  it('resolves false rather than rejecting on a nonsense port', async () => {
    await expect(isObsPortListening(0)).resolves.toBe(false)
  })
})

describe('against the OBS installed on this machine', () => {
  const appData = process.env['APPDATA']
  const realPath = appData === undefined ? null : obsWebsocketConfigPath(appData)
  const present = realPath !== null && existsSync(realPath)

  it.skipIf(!present)(
    'parses the file OBS actually wrote, which is the only proof the field names are right',
    () => {
      const result = readObsWebsocketConfig()

      expect(result.ok).toBe(true)
      if (!result.ok) return

      // A port OBS could really be serving on. Not asserted as 4455 — an operator may have moved it,
      // and this test must not fail because of a legitimate local choice.
      expect(result.value.port).toBeGreaterThan(0)
      expect(result.value.port).toBeLessThan(65_536)
      expect(typeof result.value.serverEnabled).toBe('boolean')
      expect(typeof result.value.authRequired).toBe('boolean')
      expect(typeof result.value.password).toBe('string')

      // And the field names really are the ones the parser looks for, checked against the raw file
      // rather than through the parser that could share the same wrong assumption.
      const raw = JSON.parse(readFileSync(realPath as string, 'utf8')) as Record<string, unknown>
      expect(Object.keys(raw)).toContain('server_port')
      expect(Object.keys(raw)).toContain('auth_required')
      expect(Object.keys(raw)).toContain('server_enabled')
    },
  )
})

/**
 * A portable OBS — one shipped beside Verger.exe on the USB stick — does not use `%APPDATA%`.
 *
 * This was not a guess. A real OBS was copied, given a `portable_mode.txt`, and launched: it created
 * `<obs>/config/obs-studio/plugin_config/obs-websocket/config.json` and never wrote to `%APPDATA%`
 * at all. Before this path existed, the launch-time discovery added in Cycle 17 would have reported
 * "OBS may not be installed" on a stick that had OBS sitting in the next folder along — making the
 * bundled build WORSE than the installed one.
 */
describe('portable OBS discovery', () => {
  it('looks inside the OBS folder, not %APPDATA%', () => {
    expect(obsPortableWebsocketConfigPath(join('D:', 'verger', 'obs'))).toBe(
      join('D:', 'verger', 'obs', 'config', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'),
    )
  })

  it('nests the %APPDATA% segments under config/, which is the only difference', () => {
    // Stated as a relationship rather than a second literal: if OBS moves the plugin_config folder,
    // one edit to OBS_WEBSOCKET_CONFIG_SEGMENTS must move both paths or neither.
    expect(OBS_PORTABLE_CONFIG_SEGMENTS).toEqual(['config', ...OBS_WEBSOCKET_CONFIG_SEGMENTS])
  })

  it('agrees with the folder name the assembly script writes', () => {
    expect(OBS_PORTABLE_DIR_NAME).toBe('obs')
  })

  it('reads the portable file when one is there', () => {
    const portableDir = join('D:', 'verger', 'obs')
    const wanted = obsPortableWebsocketConfigPath(portableDir)

    const result = readObsWebsocketConfig({
      portableObsDir: portableDir,
      appDataDir: join('C:', 'Users', 'someone', 'AppData', 'Roaming'),
      readFile: (path) => {
        if (path !== wanted) throw new Error('ENOENT')
        return JSON.stringify(REAL_SHAPE)
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourcePath).toBe(wanted)
    expect(result.value.port).toBe(4455)
  })

  it('prefers the portable OBS over an installed one', () => {
    // The operator who put an OBS in the Verger folder chose the OBS for this deployment, and it is
    // the one START.bat launches. An OBS installed years ago is the fallback, not the intent.
    const portableDir = join('D:', 'verger', 'obs')
    const appDataDir = join('C:', 'Users', 'someone', 'AppData', 'Roaming')

    const result = readObsWebsocketConfig({
      portableObsDir: portableDir,
      appDataDir,
      // BOTH exist, and they disagree about the port.
      readFile: (path) =>
        JSON.stringify(
          path === obsPortableWebsocketConfigPath(portableDir)
            ? { ...REAL_SHAPE, server_port: 4455 }
            : { ...REAL_SHAPE, server_port: 4499 },
        ),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.port).toBe(4455)
    expect(result.value.sourcePath).toBe(obsPortableWebsocketConfigPath(portableDir))
  })

  it('falls back to the installed OBS when no portable one is bundled', () => {
    // The overwhelmingly common case, and the one that must not regress: a normal machine with OBS
    // installed and no bundled copy behaves exactly as it did before portable support existed.
    const appDataDir = join('C:', 'Users', 'someone', 'AppData', 'Roaming')
    const portableDir = join('D:', 'verger', 'obs')

    const result = readObsWebsocketConfig({
      portableObsDir: portableDir,
      appDataDir,
      readFile: (path) => {
        if (path !== obsWebsocketConfigPath(appDataDir)) throw new Error('ENOENT')
        return JSON.stringify(REAL_SHAPE)
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourcePath).toBe(obsWebsocketConfigPath(appDataDir))
  })

  it('still reports NOT_FOUND when neither location has a file', () => {
    const result = readObsWebsocketConfig({
      portableObsDir: join('D:', 'verger', 'obs'),
      appDataDir: join('C:', 'Users', 'someone', 'AppData', 'Roaming'),
      readFile: () => {
        throw new Error('ENOENT')
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('works with a portable OBS and no APPDATA at all', () => {
    // Not hypothetical: APPDATA is absent under some service accounts and login shells, and the
    // whole point of a portable stick is not depending on the host's user profile.
    const portableDir = join('D:', 'verger', 'obs')

    const result = readObsWebsocketConfig({
      portableObsDir: portableDir,
      appDataDir: '',
      readFile: () => JSON.stringify(REAL_SHAPE),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourcePath).toBe(obsPortableWebsocketConfigPath(portableDir))
  })
})

/**
 * `waitForObsPort` — the reason START.bat can start Verger BEFORE OBS.
 *
 * That ordering is what keeps the overlay alive (an OBS Browser Source loads its URL when OBS
 * creates it, and a refused load is never retried), and it costs exactly this: OBS is not up when
 * Verger reaches its launch-time connect. Both the probe and the sleep are injected, so these run
 * with no sockets and no real timers.
 */
describe('waitForObsPort', () => {
  it('returns true on the first probe when OBS is already listening', async () => {
    const probed: number[] = []
    const listening = await waitForObsPort(4455, {
      probe: (port) => {
        probed.push(port)
        return Promise.resolve(true)
      },
      sleep: () => Promise.reject(new Error('must not sleep when the port answers immediately')),
    })

    expect(listening).toBe(true)
    expect(probed).toEqual([4455])
  })

  it('keeps probing until OBS finally opens the port', async () => {
    // The real case: START.bat launched OBS, and it takes a few seconds to bind.
    let attempts = 0
    let slept = 0
    const listening = await waitForObsPort(4455, {
      timeoutMs: 10_000,
      intervalMs: 1_000,
      probe: () => {
        attempts += 1
        return Promise.resolve(attempts >= 4)
      },
      sleep: () => {
        slept += 1
        return Promise.resolve()
      },
    })

    expect(listening).toBe(true)
    expect(attempts).toBe(4)
    expect(slept).toBe(3) // no sleep after the successful probe
  })

  it('gives up and reports false when OBS never appears', async () => {
    let attempts = 0
    const listening = await waitForObsPort(4455, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
      probe: () => {
        attempts += 1
        return Promise.resolve(false)
      },
      sleep: () => Promise.resolve(),
    })

    expect(listening).toBe(false)
    expect(attempts).toBe(5)
  })

  it('still asks once when given no time at all', async () => {
    // "Wait up to zero" that never even looks would be a surprising reading, and would silently
    // disable the launch-time connect on any machine where OBS was already running.
    let attempts = 0
    const listening = await waitForObsPort(4455, {
      timeoutMs: 0,
      probe: () => {
        attempts += 1
        return Promise.resolve(true)
      },
      sleep: () => Promise.resolve(),
    })

    expect(listening).toBe(true)
    expect(attempts).toBe(1)
  })

  it('passes the host through to the probe', async () => {
    const seen: string[] = []
    await waitForObsPort(4455, {
      host: '127.0.0.1',
      probe: (_port, host) => {
        seen.push(host)
        return Promise.resolve(true)
      },
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual(['127.0.0.1'])
  })
})
