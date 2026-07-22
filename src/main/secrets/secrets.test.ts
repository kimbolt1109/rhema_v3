import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `src/main/secrets/secrets.ts` imports `app` and `safeStorage` from `electron` at module
 * scope. Under Vitest's `node` project there is no Electron runtime, and the `electron` npm
 * package exports a path string rather than the API surface — so the import is stubbed here.
 *
 * Nothing below relies on the stub: every test injects its own `safeStorage` and `fs`. The
 * stub exists purely so the module can be loaded, and it deliberately reports encryption as
 * *unavailable* so that any accidental fall-through to the real default can never be mistaken
 * for a passing round-trip.
 */
vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/mock-user-data/${name}` },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('electron is stubbed in tests')
    },
    decryptString: () => {
      throw new Error('electron is stubbed in tests')
    }
  }
}))

import { createSecretsStore, getSecretsStore } from '@main/secrets/secrets'
import type { SafeStorageLike, SecretsErrorCode, SecretsFs } from '@main/secrets/secrets'
import type { Logger } from '@shared/log'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const SECRETS_PATH = '/verger-test/userData/secrets.json'
const TEMP_PATH = `${SECRETS_PATH}.tmp`

/** A refresh-token-shaped value; deliberately distinctive so it is easy to grep a file for. */
const PLAINTEXT = 'ya29.a0-SUPER-SECRET-refresh-token-value'

type FsFailure = 'read' | 'write' | 'mkdir' | 'rename' | 'unlink'

interface MemoryFs extends SecretsFs {
  /** The whole "disk". Tests read this directly to assert what was persisted. */
  readonly files: Map<string, string>
  readonly calls: {
    existsSync: number
    readFileSync: number
    writeFileSync: number
    mkdirSync: number
    renameSync: number
    unlinkSync: number
  }
  /** Add a member to make the corresponding operation throw. */
  readonly fail: Set<FsFailure>
}

function createMemoryFs(seed: Readonly<Record<string, string>> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(seed))
  const calls = {
    existsSync: 0,
    readFileSync: 0,
    writeFileSync: 0,
    mkdirSync: 0,
    renameSync: 0,
    unlinkSync: 0
  }
  const fail = new Set<FsFailure>()

  return {
    files,
    calls,
    fail,
    existsSync: (file) => {
      calls.existsSync += 1
      return files.has(file)
    },
    readFileSync: (file) => {
      calls.readFileSync += 1
      if (fail.has('read')) throw new Error('EIO: simulated read failure')
      const contents = files.get(file)
      if (contents === undefined) throw new Error(`ENOENT: no such file, open '${file}'`)
      return contents
    },
    writeFileSync: (file, data) => {
      calls.writeFileSync += 1
      if (fail.has('write')) throw new Error('EACCES: simulated write failure')
      files.set(file, data)
    },
    mkdirSync: (_directory, _options) => {
      calls.mkdirSync += 1
      if (fail.has('mkdir')) throw new Error('EACCES: simulated mkdir failure')
    },
    renameSync: (from, to) => {
      calls.renameSync += 1
      if (fail.has('rename')) throw new Error('EPERM: simulated rename failure')
      const contents = files.get(from)
      if (contents === undefined) throw new Error(`ENOENT: no such file, rename '${from}'`)
      files.delete(from)
      files.set(to, contents)
    },
    unlinkSync: (file) => {
      calls.unlinkSync += 1
      if (fail.has('unlink')) throw new Error('EPERM: simulated unlink failure')
      files.delete(file)
    }
  }
}

interface FakeSafeStorageOptions {
  readonly available?: boolean
  /** Present only when supplied, mirroring Electron's Linux-only method. */
  readonly backend?: string
  readonly throwOnAvailabilityCheck?: boolean
  readonly failEncrypt?: boolean
  readonly failDecrypt?: boolean
}

interface FakeSafeStorage extends SafeStorageLike {
  readonly calls: { encrypt: number; decrypt: number }
}

/**
 * A reversible byte transform standing in for OS encryption. It is *not* an encoding of the
 * plaintext: every byte is XORed and the buffer reversed, so the plaintext cannot survive into
 * the persisted file even in base64 form. That is what makes the "no plaintext on disk"
 * assertion meaningful rather than a tautology about base64.
 */
const XOR_MASK = 0x5a

function scramble(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length)
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = (bytes[bytes.length - 1 - index] ?? 0) ^ XOR_MASK
  }
  return out
}

function createFakeSafeStorage(options: FakeSafeStorageOptions = {}): FakeSafeStorage {
  const available = options.available ?? true
  const calls = { encrypt: 0, decrypt: 0 }

  const base: FakeSafeStorage = {
    calls,
    isEncryptionAvailable: () => {
      if (options.throwOnAvailabilityCheck === true) {
        throw new Error('safeStorage exploded')
      }
      return available
    },
    encryptString: (plainText) => {
      calls.encrypt += 1
      if (options.failEncrypt === true) throw new Error('keychain refused to encrypt')
      return scramble(Buffer.from(plainText, 'utf8'))
    },
    decryptString: (encrypted) => {
      calls.decrypt += 1
      if (options.failDecrypt === true) throw new Error('keychain refused to decrypt')
      return scramble(encrypted).toString('utf8')
    }
  }

  // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional member, so the
  // Linux-only method is attached only when a backend was actually requested.
  return options.backend === undefined
    ? base
    : { ...base, getSelectedStorageBackend: () => options.backend as string }
}

interface RecordingLogger extends Logger {
  readonly warnings: string[]
  readonly errors: string[]
}

function createRecordingLogger(): RecordingLogger {
  const warnings: string[] = []
  const errors: string[] = []
  const logger: RecordingLogger = {
    warnings,
    errors,
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
    child: () => logger
  }
  return logger
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code}): ${result.error.message}`)
  }
  return result.value
}

function expectErrCode<T>(result: Result<T>, code: SecretsErrorCode): void {
  if (result.ok) {
    throw new Error(`expected Err(${code}), got Ok(${JSON.stringify(result.value)})`)
  }
  expect(result.error.code).toBe(code)
  expect(result.error.message.length).toBeGreaterThan(0)
  // An error crossing a process boundary must never carry the secret it failed on.
  expect(JSON.stringify(result.error)).not.toContain(PLAINTEXT)
}

interface Harness {
  readonly fs: MemoryFs
  readonly storage: FakeSafeStorage
  readonly logger: RecordingLogger
  readonly store: ReturnType<typeof createSecretsStore>
}

function createHarness(
  storageOptions: FakeSafeStorageOptions = {},
  seed: Readonly<Record<string, string>> = {}
): Harness {
  const fs = createMemoryFs(seed)
  const storage = createFakeSafeStorage(storageOptions)
  const logger = createRecordingLogger()
  const store = createSecretsStore({ filePath: SECRETS_PATH, fs, safeStorage: storage, logger })
  return { fs, storage, logger, store }
}

/** The on-disk envelope, as the module documents it. */
function readPersisted(fs: MemoryFs): { version: unknown; secrets: Record<string, unknown> } {
  const raw = fs.files.get(SECRETS_PATH)
  expect(raw, 'expected the secrets file to exist on the fake disk').toBeDefined()
  const parsed: unknown = JSON.parse(raw ?? '')
  expect(typeof parsed).toBe('object')
  const envelope = parsed as { version: unknown; secrets: Record<string, unknown> }
  return envelope
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSecretsStore — availability', () => {
  it('reports available when safeStorage says encryption works', () => {
    const { store } = createHarness({ available: true })
    expect(expectOk(store.isAvailable())).toBe(true)
  })

  it('reports unavailable when safeStorage says encryption does not work', () => {
    const { store } = createHarness({ available: false })
    expect(expectOk(store.isAvailable())).toBe(false)
  })

  it('reports unavailable — never throws — when safeStorage itself throws', () => {
    const { store } = createHarness({ throwOnAvailabilityCheck: true })
    expect(expectOk(store.isAvailable())).toBe(false)
  })

  it('treats the Linux basic_text backend as unavailable even though the API "works"', () => {
    const { store } = createHarness({ available: true, backend: 'basic_text' })
    expect(expectOk(store.isAvailable())).toBe(false)
  })

  it('accepts a real Linux backend such as gnome_libsecret', () => {
    const { store } = createHarness({ available: true, backend: 'gnome_libsecret' })
    expect(expectOk(store.isAvailable())).toBe(true)
  })
})

describe('createSecretsStore — no plaintext fallback (security critical)', () => {
  it('refuses to write anything at all when encryption is unavailable', () => {
    const { store, fs, storage, logger } = createHarness({ available: false })

    expectErrCode(store.setSecret('google.refreshToken', PLAINTEXT), 'NOT_CONFIGURED')

    // The point of the assertion: nothing reached the disk, encrypted or otherwise.
    expect(fs.files.size).toBe(0)
    expect(fs.calls.writeFileSync).toBe(0)
    expect(fs.calls.renameSync).toBe(0)
    expect(fs.calls.mkdirSync).toBe(0)
    expect(storage.calls.encrypt).toBe(0)
    expect(logger.warnings.length).toBeGreaterThan(0)
  })

  it('refuses to write when the backend is basic_text (plaintext-equivalent)', () => {
    const { store, fs, storage } = createHarness({ available: true, backend: 'basic_text' })

    expectErrCode(store.setSecret('google.refreshToken', PLAINTEXT), 'NOT_CONFIGURED')

    expect(fs.files.size).toBe(0)
    expect(fs.calls.writeFileSync).toBe(0)
    expect(storage.calls.encrypt).toBe(0)
  })

  it('reads back NOT_CONFIGURED rather than exposing anything when encryption is unavailable', () => {
    const { store } = createHarness({ available: false })
    expectErrCode(store.getSecret('google.refreshToken'), 'NOT_CONFIGURED')
  })

  it('warns exactly once per store, not once per call', () => {
    const { store, logger } = createHarness({ available: false })

    expectErrCode(store.setSecret('a', PLAINTEXT), 'NOT_CONFIGURED')
    expectErrCode(store.setSecret('b', PLAINTEXT), 'NOT_CONFIGURED')
    expectErrCode(store.getSecret('a'), 'NOT_CONFIGURED')

    expect(logger.warnings).toHaveLength(1)
  })
})

describe('createSecretsStore — round trip', () => {
  it('stores and retrieves a value', () => {
    const { store } = createHarness()

    expectOk(store.setSecret('google.refreshToken', PLAINTEXT))
    expect(expectOk(store.getSecret('google.refreshToken'))).toBe(PLAINTEXT)
  })

  it('keeps multiple keys independent and overwrites in place', () => {
    const { store } = createHarness()

    expectOk(store.setSecret('one', 'first-value'))
    expectOk(store.setSecret('two', 'second-value'))
    expectOk(store.setSecret('one', 'first-value-updated'))

    expect(expectOk(store.getSecret('one'))).toBe('first-value-updated')
    expect(expectOk(store.getSecret('two'))).toBe('second-value')
  })

  it('round-trips an empty string value', () => {
    const { store } = createHarness()
    expectOk(store.setSecret('empty', ''))
    expect(expectOk(store.getSecret('empty'))).toBe('')
  })

  it('round-trips non-ASCII values', () => {
    const { store } = createHarness()
    const korean = '주일예배-토큰-값'
    expectOk(store.setSecret('korean', korean))
    expect(expectOk(store.getSecret('korean'))).toBe(korean)
  })

  it('survives a fresh store over the same file — the value is really persisted', () => {
    const fs = createMemoryFs()
    const storage = createFakeSafeStorage()
    const first = createSecretsStore({ filePath: SECRETS_PATH, fs, safeStorage: storage })
    expectOk(first.setSecret('google.refreshToken', PLAINTEXT))

    const second = createSecretsStore({ filePath: SECRETS_PATH, fs, safeStorage: storage })
    expect(expectOk(second.getSecret('google.refreshToken'))).toBe(PLAINTEXT)
  })
})

describe('createSecretsStore — lookup failures', () => {
  it('returns NOT_FOUND for an unknown key when the file does not exist yet', () => {
    const { store } = createHarness()
    expectErrCode(store.getSecret('never.stored'), 'NOT_FOUND')
  })

  it('returns NOT_FOUND for an unknown key when other keys are stored', () => {
    const { store } = createHarness()
    expectOk(store.setSecret('present', 'value'))
    expectErrCode(store.getSecret('absent'), 'NOT_FOUND')
  })

  it('returns INVALID_ARG for an empty key, before it even consults safeStorage', () => {
    const { store, fs, storage } = createHarness()

    expectErrCode(store.setSecret('', PLAINTEXT), 'INVALID_ARG')

    expect(storage.calls.encrypt).toBe(0)
    expect(fs.calls.writeFileSync).toBe(0)
    expect(fs.files.size).toBe(0)
  })

  it('rejects an empty key even when encryption is unavailable (INVALID_ARG wins)', () => {
    const { store } = createHarness({ available: false })
    expectErrCode(store.setSecret('', PLAINTEXT), 'INVALID_ARG')
  })
})

describe('createSecretsStore — deletion', () => {
  it('removes a stored key, leaving its siblings intact', () => {
    const { store, fs } = createHarness()

    expectOk(store.setSecret('doomed', 'value-a'))
    expectOk(store.setSecret('kept', 'value-b'))

    expect(expectOk(store.deleteSecret('doomed'))).toBeUndefined()

    expectErrCode(store.getSecret('doomed'), 'NOT_FOUND')
    expect(expectOk(store.getSecret('kept'))).toBe('value-b')
    expect(Object.keys(readPersisted(fs).secrets)).toEqual(['kept'])
  })

  it('treats deleting an absent key as success and does not rewrite the file', () => {
    // The documented contract, read off the implementation: `deleteSecret` short-circuits
    // with `ok(undefined)` when the key is not present — deletion is idempotent, and an
    // absent key is NOT a NOT_FOUND failure.
    const { store, fs } = createHarness()
    expectOk(store.setSecret('kept', 'value'))
    const writesBefore = fs.calls.writeFileSync

    expect(expectOk(store.deleteSecret('never.stored'))).toBeUndefined()

    expect(fs.calls.writeFileSync).toBe(writesBefore)
    expect(Object.keys(readPersisted(fs).secrets)).toEqual(['kept'])
  })

  it('succeeds against a store that has never been written to', () => {
    const { store, fs } = createHarness()
    expect(expectOk(store.deleteSecret('anything'))).toBeUndefined()
    expect(fs.files.size).toBe(0)
  })

  it('deletes without requiring encryption to be available', () => {
    // Deliberate: a machine that has lost its keychain must still be able to purge a stale
    // blob it can no longer decrypt.
    const fs = createMemoryFs()
    const working = createSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage({ available: true })
    })
    expectOk(working.setSecret('google.refreshToken', PLAINTEXT))

    const broken = createSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage({ available: false })
    })
    expect(expectOk(broken.deleteSecret('google.refreshToken'))).toBeUndefined()
    expect(readPersisted(fs).secrets).toEqual({})
  })
})

describe('createSecretsStore — filesystem failures never propagate', () => {
  it('converts a throwing read into IO_ERROR on getSecret', () => {
    const { store, fs, logger } = createHarness()
    expectOk(store.setSecret('key', 'value'))
    fs.fail.add('read')

    let thrown: unknown = null
    let result: Result<string> | null = null
    try {
      result = store.getSecret('key')
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBeNull()
    expect(result).not.toBeNull()
    if (result !== null) expectErrCode(result, 'IO_ERROR')
    expect(logger.errors.length).toBeGreaterThan(0)
  })

  it('converts a throwing read into IO_ERROR on setSecret and deleteSecret', () => {
    const { store, fs } = createHarness()
    expectOk(store.setSecret('key', 'value'))
    fs.fail.add('read')

    expectErrCode(store.setSecret('another', 'value'), 'IO_ERROR')
    expectErrCode(store.deleteSecret('key'), 'IO_ERROR')
  })

  it('converts a throwing write into IO_ERROR without propagating', () => {
    const { store, fs, logger } = createHarness()
    fs.fail.add('write')

    let thrown: unknown = null
    let result: Result<void> | null = null
    try {
      result = store.setSecret('key', PLAINTEXT)
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBeNull()
    expect(result).not.toBeNull()
    if (result !== null) expectErrCode(result, 'IO_ERROR')
    expect(fs.files.has(SECRETS_PATH)).toBe(false)
    expect(logger.errors.length).toBeGreaterThan(0)
  })

  it('converts a throwing mkdir into IO_ERROR', () => {
    const { store, fs } = createHarness()
    fs.fail.add('mkdir')
    expectErrCode(store.setSecret('key', PLAINTEXT), 'IO_ERROR')
    expect(fs.calls.writeFileSync).toBe(0)
  })

  it('converts a throwing rename into IO_ERROR and leaves the live file untouched', () => {
    const { store, fs } = createHarness()
    expectOk(store.setSecret('kept', 'value'))
    const before = fs.files.get(SECRETS_PATH)

    fs.fail.add('rename')
    expectErrCode(store.setSecret('new', 'value'), 'IO_ERROR')

    expect(fs.files.get(SECRETS_PATH)).toBe(before)
    expect(expectOk(store.getSecret('kept'))).toBe('value')
  })

  it('degrades a corrupt, non-JSON secrets file to IO_ERROR rather than throwing', () => {
    const { store, fs } = createHarness({}, { [SECRETS_PATH]: 'this is not json {{{' })

    let thrown: unknown = null
    try {
      expectErrCode(store.getSecret('key'), 'IO_ERROR')
      expectErrCode(store.setSecret('key', PLAINTEXT), 'IO_ERROR')
      expectErrCode(store.deleteSecret('key'), 'IO_ERROR')
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeNull()
    // The corrupt file is not clobbered on the failed write.
    expect(fs.files.get(SECRETS_PATH)).toBe('this is not json {{{')
  })

  it('degrades valid JSON of the wrong shape to an empty store rather than an error', () => {
    // Documented actual behaviour: `read()` only errors on a *parse* failure. Structurally
    // wrong-but-parseable content is treated as "no secrets yet".
    const { store } = createHarness({}, { [SECRETS_PATH]: '{"version":1,"secrets":"nonsense"}' })
    expectErrCode(store.getSecret('key'), 'NOT_FOUND')
  })

  it('ignores non-string entries inside the secrets map', () => {
    const { store } = createHarness(
      {},
      { [SECRETS_PATH]: '{"version":1,"secrets":{"good":"AAAA","bad":42}}' }
    )
    expectErrCode(store.getSecret('bad'), 'NOT_FOUND')
  })
})

describe('createSecretsStore — crypto failures', () => {
  it('returns CRYPTO_ERROR when encryption throws, and writes nothing', () => {
    const { store, fs } = createHarness({ available: true, failEncrypt: true })

    expectErrCode(store.setSecret('key', PLAINTEXT), 'CRYPTO_ERROR')

    expect(fs.files.size).toBe(0)
    expect(fs.calls.writeFileSync).toBe(0)
  })

  it('returns CRYPTO_ERROR when a stored blob cannot be decrypted', () => {
    const fs = createMemoryFs()
    const good = createSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage({ available: true })
    })
    expectOk(good.setSecret('google.refreshToken', PLAINTEXT))

    // A different machine / rotated OS key: the blob is present but undecryptable.
    const rotated = createSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage({ available: true, failDecrypt: true })
    })

    let thrown: unknown = null
    let result: Result<string> | null = null
    try {
      result = rotated.getSecret('google.refreshToken')
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeNull()
    if (result !== null) expectErrCode(result, 'CRYPTO_ERROR')
  })
})

describe('createSecretsStore — on-disk representation', () => {
  it('never writes the plaintext secret to disk in any form', () => {
    const { store, fs } = createHarness()

    expectOk(store.setSecret('google.refreshToken', PLAINTEXT))

    // Every byte that ever touched the fake disk, including the temp file if it lingered.
    const everything = [...fs.files.values()].join('\n')
    expect(everything.length).toBeGreaterThan(0)
    expect(everything).not.toContain(PLAINTEXT)
    // Not even a recognisable fragment of it.
    expect(everything).not.toContain('SUPER-SECRET')
    expect(everything).not.toContain('refresh-token-value')
    // And not a naive base64 encoding of the plaintext either.
    expect(everything).not.toContain(Buffer.from(PLAINTEXT, 'utf8').toString('base64'))
  })

  it('persists a versioned envelope whose secrets map is key -> base64 blob', () => {
    const { store, fs } = createHarness()
    expectOk(store.setSecret('google.refreshToken', PLAINTEXT))

    const envelope = readPersisted(fs)
    expect(envelope.version).toBe(1)
    expect(Object.keys(envelope.secrets)).toEqual(['google.refreshToken'])

    const blob = envelope.secrets['google.refreshToken']
    expect(typeof blob).toBe('string')
    const encoded = blob as string
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    // Base64 in the strict sense: decoding and re-encoding is lossless.
    expect(Buffer.from(encoded, 'base64').toString('base64')).toBe(encoded)
    expect(Buffer.from(encoded, 'base64').toString('utf8')).not.toContain(PLAINTEXT)
  })

  it('writes through a temp file and renames, leaving no .tmp behind', () => {
    const { store, fs } = createHarness()
    expectOk(store.setSecret('google.refreshToken', PLAINTEXT))

    expect(fs.calls.renameSync).toBe(1)
    expect(fs.files.has(TEMP_PATH)).toBe(false)
    expect(fs.files.has(SECRETS_PATH)).toBe(true)
  })

  it('preserves unrelated keys already present in the file', () => {
    const fs = createMemoryFs({
      [SECRETS_PATH]: '{"version":1,"secrets":{"legacy":"QUJD"}}'
    })
    const store = createSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage()
    })

    expectOk(store.setSecret('fresh', 'value'))

    const envelope = readPersisted(fs)
    expect(Object.keys(envelope.secrets).sort()).toEqual(['fresh', 'legacy'])
    expect(envelope.secrets['legacy']).toBe('QUJD')
  })
})

describe('createSecretsStore — key handling edge cases', () => {
  it('does not return NOT_FOUND for keys inherited from Object.prototype (documented gap)', () => {
    // ACTUAL behaviour, not desired behaviour. `read()` builds a plain `{}` object and
    // `getSecret` looks the key up with plain indexing, so `constructor` resolves to the
    // inherited function rather than `undefined`. `Buffer.from(fn, 'base64')` then throws and
    // is caught as CRYPTO_ERROR. A caller cannot distinguish "absent" from "corrupt" for such
    // a key. Reported as a concern; the test documents the status quo so a fix is visible.
    const { store } = createHarness()
    expectOk(store.setSecret('real', 'value'))

    expectErrCode(store.getSecret('constructor'), 'CRYPTO_ERROR')
  })

  it('round-trips a key that merely looks dangerous', () => {
    const { store } = createHarness()
    expectOk(store.setSecret('google.refresh-token/v2', PLAINTEXT))
    expect(expectOk(store.getSecret('google.refresh-token/v2'))).toBe(PLAINTEXT)
  })
})

describe('getSecretsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the same process-wide instance on every call', () => {
    const fs = createMemoryFs()
    const first = getSecretsStore({
      filePath: SECRETS_PATH,
      fs,
      safeStorage: createFakeSafeStorage()
    })
    const second = getSecretsStore()

    expect(second).toBe(first)
    // The options from the first call are the ones that stuck.
    expectOk(first.setSecret('shared', 'value'))
    expect(expectOk(second.getSecret('shared'))).toBe('value')
    expect(fs.files.has(SECRETS_PATH)).toBe(true)
  })
})
