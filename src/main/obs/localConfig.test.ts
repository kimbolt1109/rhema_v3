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

import { describe, expect, it } from 'vitest'

import { ErrorCode } from '@shared/result'

import {
  OBS_WEBSOCKET_CONFIG_SEGMENTS,
  isObsPortListening,
  obsWebsocketConfigPath,
  readObsWebsocketConfig,
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
