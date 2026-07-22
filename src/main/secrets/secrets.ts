/**
 * OS-encrypted storage for secrets that must outlive `.env`.
 *
 * `.env` is the contract for *operator-supplied* configuration (Standing Rule 5). This
 * module is for secrets the app itself mints at runtime and must keep across restarts —
 * principally Phase 4's Google OAuth **refresh token**, which never belongs in a
 * plaintext file the operator might paste into a support email.
 *
 * Hard rule: **there is no plaintext fallback.** If Electron's `safeStorage` reports that
 * encryption is unavailable — including the Linux `basic_text` backend, which is
 * plaintext-equivalent despite the API "working" — every write returns
 * `Err('NOT_CONFIGURED')` and logs a warning. The caller degrades to "sign in again each
 * session". We never claim "encrypted at rest" on a system where it is not true.
 *
 * On-disk shape (`<userData>/secrets.json`):
 *
 * ```json
 * { "version": 1, "secrets": { "google.refreshToken": "<base64 of the encrypted blob>" } }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'

import { createNullLogger } from '@main/logging/logger'
import type { Logger } from '@main/logging/logger'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

// `Result`, `ok` and `err` come from the project-wide contract in `src/shared/result.ts`.
// Secrets originally declared its own parallel copy; a second Result type would have to be
// translated at every boundary it touches, which is exactly how the prior project ended up
// with three incompatible error envelopes (see docs/v2-notes/PROTOCOL.md).
import { err, ok } from '@shared/result'
import type { AppError, ErrorCode, Result } from '@shared/result'

export { err, ok } from '@shared/result'
export type { Result } from '@shared/result'

/** The subset of the project-wide `ErrorCode` this module can produce. */
export type SecretsErrorCode = Extract<
  ErrorCode,
  'NOT_CONFIGURED' | 'NOT_FOUND' | 'IO_ERROR' | 'CRYPTO_ERROR' | 'INVALID_ARG'
>

/** Alias kept for readability at call sites; identical to the shared {@link AppError}. */
export type Failure = AppError

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** The `safeStorage` surface used here. Injectable so this module is testable headless. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

/** The `node:fs` surface used here. Injectable for tests. */
export interface SecretsFs {
  existsSync(file: string): boolean
  readFileSync(file: string): string
  writeFileSync(file: string, data: string): void
  mkdirSync(directory: string, options: { readonly recursive: true }): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

const nodeSecretsFs: SecretsFs = {
  existsSync: (file) => existsSync(file),
  readFileSync: (file) => readFileSync(file, 'utf8'),
  writeFileSync: (file, data) => {
    writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 })
  },
  mkdirSync: (directory, options) => {
    mkdirSync(directory, options)
  },
  renameSync: (from, to) => {
    renameSync(from, to)
  },
  unlinkSync: (file) => {
    unlinkSync(file)
  }
}

export interface SecretsStore {
  /**
   * Whether OS-backed encryption is usable. Always succeeds; the boolean is the answer.
   * `false` means every mutating call below will return `Err('NOT_CONFIGURED')`.
   */
  isAvailable(): Result<boolean>
  setSecret(key: string, value: string): Result<void>
  getSecret(key: string): Result<string>
  deleteSecret(key: string): Result<void>
}

export interface CreateSecretsStoreOptions {
  /** File the encrypted blobs live in. Defaults to `<userData>/secrets.json`. */
  readonly filePath?: string
  readonly logger?: Logger
  readonly safeStorage?: SafeStorageLike
  readonly fs?: SecretsFs
}

interface SecretsFileShape {
  readonly version: number
  readonly secrets: Record<string, string>
}

const FILE_VERSION = 1

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createSecretsStore(options: CreateSecretsStoreOptions = {}): SecretsStore {
  const log = (options.logger ?? createNullLogger()).child('secrets')
  const fs = options.fs ?? nodeSecretsFs
  const storage: SafeStorageLike = options.safeStorage ?? safeStorage
  const filePath = options.filePath ?? defaultSecretsPath()

  let warnedUnavailable = false

  const encryptionAvailable = (): boolean => {
    try {
      if (!storage.isEncryptionAvailable()) return false
      // Linux-only: `basic_text` is obfuscation, not encryption. Treat it as unavailable
      // rather than lie to the operator about secrets being safe at rest.
      const backend = storage.getSelectedStorageBackend?.()
      if (backend === 'basic_text') return false
      return true
    } catch {
      return false
    }
  }

  const requireEncryption = (): Failure | null => {
    if (encryptionAvailable()) return null
    if (!warnedUnavailable) {
      warnedUnavailable = true
      log.warn(
        'OS secret storage is unavailable; secrets will not be persisted. Sign-in will be required each session.'
      )
    }
    return {
      code: 'NOT_CONFIGURED',
      message: 'safeStorage reports encryption is unavailable on this system'
    }
  }

  const read = (): Result<Record<string, string>> => {
    try {
      if (!fs.existsSync(filePath)) return ok({})
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath))
      if (typeof parsed !== 'object' || parsed === null) return ok({})
      const secrets = (parsed as { secrets?: unknown }).secrets
      if (typeof secrets !== 'object' || secrets === null) return ok({})
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
      }
      return ok(out)
    } catch (cause) {
      log.error('failed to read the secrets file', { filePath, cause })
      return err('IO_ERROR', 'the secrets file could not be read')
    }
  }

  const persist = (secrets: Record<string, string>): Result<void> => {
    try {
      fs.mkdirSync(dirname(filePath), { recursive: true })
      const payload: SecretsFileShape = { version: FILE_VERSION, secrets }
      // Write-then-rename so an interrupted write can never leave a truncated file that
      // loses every stored secret.
      const temporary = `${filePath}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2))
      fs.renameSync(temporary, filePath)
      return ok(undefined)
    } catch (cause) {
      log.error('failed to write the secrets file', { filePath, cause })
      return err('IO_ERROR', 'the secrets file could not be written')
    }
  }

  return {
    isAvailable: () => ok(encryptionAvailable()),

    setSecret: (key, value) => {
      if (key.length === 0) return err('INVALID_ARG', 'secret key must not be empty')
      const unavailable = requireEncryption()
      if (unavailable !== null) return { ok: false, error: unavailable }

      let encoded: string
      try {
        encoded = storage.encryptString(value).toString('base64')
      } catch (cause) {
        log.error('failed to encrypt a secret', { key, cause })
        return err('CRYPTO_ERROR', 'the value could not be encrypted')
      }

      const current = read()
      if (!current.ok) return { ok: false, error: current.error }

      const next = { ...current.value, [key]: encoded }
      const written = persist(next)
      if (written.ok) log.info('secret stored', { key })
      return written
    },

    getSecret: (key) => {
      const unavailable = requireEncryption()
      if (unavailable !== null) return { ok: false, error: unavailable }

      const current = read()
      if (!current.ok) return { ok: false, error: current.error }

      const encoded = current.value[key]
      if (encoded === undefined) return err('NOT_FOUND', 'no secret is stored under that key')

      try {
        return ok(storage.decryptString(Buffer.from(encoded, 'base64')))
      } catch (cause) {
        log.error('failed to decrypt a secret', { key, cause })
        return err('CRYPTO_ERROR', 'the stored value could not be decrypted')
      }
    },

    deleteSecret: (key) => {
      const current = read()
      if (!current.ok) return { ok: false, error: current.error }
      if (!(key in current.value)) return ok(undefined)

      const next = { ...current.value }
      delete next[key]
      const written = persist(next)
      if (written.ok) log.info('secret deleted', { key })
      return written
    }
  }
}

function defaultSecretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

let sharedStore: SecretsStore | null = null

/**
 * Process-wide store, created on first use. Must not be called before `app` is ready —
 * `app.getPath('userData')` is only meaningful from then on.
 */
export function getSecretsStore(options: CreateSecretsStoreOptions = {}): SecretsStore {
  sharedStore ??= createSecretsStore(options)
  return sharedStore
}
