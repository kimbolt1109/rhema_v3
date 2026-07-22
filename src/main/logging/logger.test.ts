import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  REDACTED,
  createLogger,
  createNullLogger
} from '@main/logging/logger'
import type { LoggerConsole, LoggerFs } from '@main/logging/logger'

const LOG_DIR = '/verger/logs'

/** An in-memory {@link LoggerFs}: no Electron, no clock, no disk. */
class FakeFs implements LoggerFs {
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>()

  mkdirSync(directory: string): void {
    this.directories.add(directory)
  }

  appendFileSync(file: string, data: string): void {
    this.files.set(file, (this.files.get(file) ?? '') + data)
  }

  statSync(file: string): { size: number } {
    const content = this.files.get(file)
    if (content === undefined) throw new Error(`ENOENT: ${file}`)
    return { size: Buffer.byteLength(content, 'utf8') }
  }

  renameSync(from: string, to: string): void {
    const content = this.files.get(from)
    if (content === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.delete(from)
    this.files.set(to, content)
  }

  // `node:path.join` uses `\` on Windows and `/` elsewhere, so the fake normalises
  // separators rather than assuming either.
  readdirSync(directory: string): string[] {
    const normalize = (value: string): string => value.replace(/\\/g, '/')
    const prefix = `${normalize(directory).replace(/\/+$/, '')}/`
    return [...this.files.keys()]
      .map(normalize)
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
  }

  unlinkSync(file: string): void {
    if (!this.files.delete(file)) throw new Error(`ENOENT: ${file}`)
  }

  /** Log-file basenames only, so assertions don't depend on the path separator. */
  names(): string[] {
    return [...this.files.keys()].map((file) => file.split(/[\\/]/).pop() ?? file)
  }
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso)
}

function readRecords(fs: FakeFs, file: string): Array<Record<string, unknown>> {
  const content = fs.files.get(file) ?? ''
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createLogger', () => {
  let fs: FakeFs

  beforeEach(() => {
    fs = new FakeFs()
  })

  const activeFile = join(LOG_DIR, 'verger-2026-07-23.log')

  it('writes one JSON object per line to verger-<YYYY-MM-DD>.log', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      level: 'debug'
    })

    log.info('obs connected', { sceneCount: 4 })
    log.debug('a debug line')

    const records = readRecords(fs, activeFile)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      level: 'info',
      msg: 'obs connected',
      sceneCount: 4,
      ts: '2026-07-23T09:15:00.000Z'
    })
    expect(records[1]).toMatchObject({ level: 'debug', msg: 'a debug line' })
    expect(fs.directories.has(LOG_DIR)).toBe(true)
  })

  it('honours the minimum level', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      level: 'warn'
    })

    log.debug('dropped')
    log.info('dropped')
    log.warn('kept')
    log.error('kept')

    expect(readRecords(fs, activeFile).map((record) => record['level'])).toEqual(['warn', 'error'])
  })

  // --- redaction ----------------------------------------------------------

  it('does NOT redact boolean values under secret-shaped keys', () => {
    // Regression: `ConfigSummary.configured` is a Record<EnvKey, boolean> whose KEYS are
    // literally OBS_WEBSOCKET_PASSWORD / GOOGLE_CLIENT_SECRET / DEEPGRAM_API_KEY. Redacting
    // on the key alone blanked those booleans, so the startup log read
    // {"OBS_WEBSOCKET_PASSWORD":"[redacted]"} instead of reporting whether the subsystem was
    // configured — destroying the most useful diagnostic we have and implying a secret was
    // present when none was. A boolean cannot carry a secret value.
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })

    log.info('verger starting', {
      configured: {
        OBS_WEBSOCKET_URL: false,
        OBS_WEBSOCKET_PASSWORD: true,
        GOOGLE_CLIENT_SECRET: false,
        DEEPGRAM_API_KEY: true,
        SENTRY_DSN: false
      }
    })

    const line = JSON.parse((fs.files.get(activeFile) ?? '').trim()) as {
      configured: Record<string, unknown>
    }

    expect(line.configured).toEqual({
      OBS_WEBSOCKET_URL: false,
      OBS_WEBSOCKET_PASSWORD: true,
      GOOGLE_CLIENT_SECRET: false,
      DEEPGRAM_API_KEY: true,
      SENTRY_DSN: false
    })
    expect(JSON.stringify(line)).not.toContain('[redacted]')
  })

  it('still redacts a STRING under a secret-shaped key even beside booleans', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })

    log.info('mixed', {
      OBS_WEBSOCKET_PASSWORD: false,
      obsPassword: 'the-actual-secret-value'
    })

    const raw = fs.files.get(activeFile) ?? ''
    expect(raw).not.toContain('the-actual-secret-value')
    expect(raw).toContain('"OBS_WEBSOCKET_PASSWORD":false')
  })

  it('redacts values whose key looks like a secret, at any depth', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })

    log.info('connecting', {
      url: 'ws://127.0.0.1:4455',
      password: 'obs-password-value',
      apiKey: 'deepgram-key-value',
      SENTRY_DSN: 'https://dsn-value@example.invalid/1',
      nested: {
        refreshToken: 'google-refresh-token-value',
        clientSecret: 'google-client-secret-value',
        harmless: 'keep me'
      },
      list: [{ accessToken: 'list-token-value' }]
    })

    const raw = fs.files.get(activeFile) ?? ''
    for (const secret of [
      'obs-password-value',
      'deepgram-key-value',
      'dsn-value',
      'google-refresh-token-value',
      'google-client-secret-value',
      'list-token-value'
    ]) {
      expect(raw, `${secret} must not reach the log file`).not.toContain(secret)
    }

    const record = readRecords(fs, activeFile)[0]
    expect(record?.['password']).toBe(REDACTED)
    expect(record?.['apiKey']).toBe(REDACTED)
    expect(record?.['SENTRY_DSN']).toBe(REDACTED)
    expect(record?.['url']).toBe('ws://127.0.0.1:4455')
    expect(record?.['nested']).toEqual({
      refreshToken: REDACTED,
      clientSecret: REDACTED,
      harmless: 'keep me'
    })
    expect(record?.['list']).toEqual([{ accessToken: REDACTED }])
  })

  it('survives a circular structure without throwing or hanging', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic

    expect(() => {
      log.info('cyclic', { cyclic })
    }).not.toThrow()
    expect(readRecords(fs, activeFile)).toHaveLength(1)
  })

  // --- child scopes -------------------------------------------------------

  it('prefixes records with the child scope, nesting with ":"', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })

    log.info('root line')
    const obs = log.child('obs')
    obs.info('obs line')
    obs.child('reconnect').info('nested line')

    const records = readRecords(fs, activeFile)
    expect(records[0]?.['scope']).toBeUndefined()
    expect(records[1]?.['scope']).toBe('obs')
    expect(records[2]?.['scope']).toBe('obs:reconnect')
  })

  it('shares one sink between the parent and its children', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z')
    })
    log.child('a').info('one')
    log.child('b').info('two')

    expect(fs.files.size).toBe(1)
    expect(readRecords(fs, activeFile)).toHaveLength(2)
  })

  // --- rotation -----------------------------------------------------------

  it('defaults to a 5 MiB cap and 5 retained files', () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(DEFAULT_MAX_FILES).toBe(5)
  })

  it('rotates once appending would cross the byte cap', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      // Roughly two records per file.
      maxBytes: 200
    })

    log.info('first')
    const sizeAfterOne = fs.files.get(activeFile)?.length ?? 0
    expect(sizeAfterOne).toBeGreaterThan(0)
    expect(fs.names()).toEqual(['verger-2026-07-23.log'])

    // Keep writing until a rotation has to happen.
    for (let index = 0; index < 10; index += 1) {
      log.info(`line ${index}`)
    }

    expect(fs.names()).toContain('verger-2026-07-23.log.1')
    // No file may exceed the cap.
    for (const content of fs.files.values()) {
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(200)
    }
  })

  it('retains exactly 5 files — the active log plus four archives', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      maxBytes: 120
    })

    for (let index = 0; index < 200; index += 1) {
      log.info(`line ${index}`)
    }

    expect(fs.files.size).toBe(DEFAULT_MAX_FILES)
    expect(fs.names().sort()).toEqual([
      'verger-2026-07-23.log',
      'verger-2026-07-23.log.1',
      'verger-2026-07-23.log.2',
      'verger-2026-07-23.log.3',
      'verger-2026-07-23.log.4'
    ])
  })

  it('honours a custom retention count', () => {
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      maxBytes: 120,
      maxFiles: 2
    })

    for (let index = 0; index < 100; index += 1) {
      log.info(`line ${index}`)
    }

    expect(fs.files.size).toBe(2)
    expect(fs.names().sort()).toEqual(['verger-2026-07-23.log', 'verger-2026-07-23.log.1'])
  })

  it('prunes files left behind by earlier days', () => {
    let iso = '2026-07-20T09:00:00.000Z'
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: () => new Date(iso),
      maxBytes: 120,
      maxFiles: 3
    })

    for (const day of ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']) {
      iso = `${day}T09:00:00.000Z`
      for (let index = 0; index < 20; index += 1) log.info(`line ${index}`)
    }

    expect(fs.files.size).toBeLessThanOrEqual(3)
    // The newest day's active file must always survive.
    expect(fs.names()).toContain('verger-2026-07-23.log')
  })

  // --- failure containment -------------------------------------------------

  it('never propagates a filesystem failure to the caller', () => {
    const explodingFs: LoggerFs = {
      mkdirSync: () => {
        throw new Error('EACCES')
      },
      appendFileSync: () => {
        throw new Error('ENOSPC')
      },
      statSync: () => {
        throw new Error('EIO')
      },
      renameSync: () => {
        throw new Error('EPERM')
      },
      readdirSync: () => {
        throw new Error('EIO')
      },
      unlinkSync: () => {
        throw new Error('EPERM')
      }
    }

    const log = createLogger({
      directory: LOG_DIR,
      fs: explodingFs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      level: 'debug'
    })

    // A dead disk must never take down a live service.
    expect(() => {
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e', { cause: new Error('boom') })
      log.child('obs').error('nested')
    }).not.toThrow()
  })

  it('mirrors to the injected console when asked, with redaction applied', () => {
    const lines: string[] = []
    const fakeConsole: LoggerConsole = {
      log: (message) => lines.push(`log:${message}`),
      warn: (message) => lines.push(`warn:${message}`),
      error: (message) => lines.push(`error:${message}`)
    }

    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      mirrorToConsole: true,
      console: fakeConsole
    })

    log.info('hello', { password: 'obs-password-value' })
    log.warn('careful')
    log.error('bad')

    expect(lines).toHaveLength(3)
    expect(lines[0]?.startsWith('log:')).toBe(true)
    expect(lines[0]).not.toContain('obs-password-value')
    expect(lines[0]).toContain(REDACTED)
    expect(lines[1]?.startsWith('warn:')).toBe(true)
    expect(lines[2]?.startsWith('error:')).toBe(true)
  })

  it('does not mirror by default', () => {
    const lines: string[] = []
    const log = createLogger({
      directory: LOG_DIR,
      fs,
      now: fixedClock('2026-07-23T09:15:00.000Z'),
      console: {
        log: (message) => lines.push(message),
        warn: (message) => lines.push(message),
        error: (message) => lines.push(message)
      }
    })
    log.info('quiet')
    expect(lines).toHaveLength(0)
  })
})

describe('createNullLogger', () => {
  it('discards everything and keeps returning itself from child()', () => {
    const log = createNullLogger()
    expect(() => {
      log.info('ignored')
      log.child('scope').child('deeper').error('also ignored')
    }).not.toThrow()
  })
})
