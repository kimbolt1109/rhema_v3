/**
 * Environment / secret configuration for the Verger main process.
 *
 * THE CONTRACT (Standing Rule 5, and the header of `.env.example`):
 *
 *  - Every key is optional. A missing or empty key is **never** an error; it sets
 *    `configured[key] = false` and the owning subsystem reports "not configured" in the
 *    UI. Nothing in this module throws — not even for malformed input.
 *  - A malformed `OBS_WEBSOCKET_URL` yields `obs = null`, `configured` false, and a
 *    warning. The app still starts; the OBS panel simply says the URL is unusable.
 *  - An **empty** `OBS_WEBSOCKET_PASSWORD` is valid and means "OBS has authentication
 *    disabled". That is deliberately distinct from the key being absent entirely
 *    (`password === null`).
 *
 * {@link loadConfig} is pure — it reads a plain record, touches no disk and no Electron —
 * so the whole contract is unit-testable. {@link loadConfigFromDisk} is the thin impure
 * wrapper that runs dotenv first.
 *
 * NOTE: `EnvKey` and the `ENV_KEYS` tuple are the canonical mirror of `.env.example`. The
 * eight names here must match that file exactly, in order. If `src/shared/config.ts`
 * later declares the same union, this file should re-export it rather than duplicate it —
 * there must only ever be one list.
 */

import { config as loadDotenv } from 'dotenv'

import type {
  AppConfig,
  ConfigSummary,
  ConfigWarning,
  EnvKey,
  EnvSource,
  GoogleConfig,
  ObsConfig,
} from '@shared/config'

// ---------------------------------------------------------------------------
// The key contract
// ---------------------------------------------------------------------------

// The key contract and every resolved-config shape are declared ONCE, in
// `src/shared/config.ts`, because the renderer needs them too (to render "not configured"
// states) and `src/shared` is the only folder all three processes may import. They are
// re-exported here so existing `@main/config/env` importers keep working.
export { ENV_KEYS, emptyConfiguredMap, obsConfigSchema, obsUrlSchema } from '@shared/config'
export type {
  AppConfig,
  ConfigSummary,
  ConfigWarning,
  EnvKey,
  EnvSource,
  GoogleConfig,
  ObsConfig,
} from '@shared/config'

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Trimmed value, or `undefined` when the key is absent. Presence is preserved. */
function raw(env: EnvSource, key: EnvKey): string | undefined {
  const value = env[key]
  return value === undefined ? undefined : value.trim()
}

/** A key counts as configured when it is present AND non-empty after trimming. */
function isSet(env: EnvSource, key: EnvKey): boolean {
  const value = raw(env, key)
  return value !== undefined && value.length > 0
}

/** Non-empty trimmed value, or `null`. */
function optional(env: EnvSource, key: EnvKey): string | null {
  const value = raw(env, key)
  return value === undefined || value.length === 0 ? null : value
}

function isValidObsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * Pure configuration resolution. Never throws, never reads the disk, never touches
 * Electron.
 */
export function loadConfig(env: EnvSource): AppConfig {
  const warnings: ConfigWarning[] = []

  // --- OBS ---------------------------------------------------------------
  const obsUrlRaw = raw(env, 'OBS_WEBSOCKET_URL')
  const obsUrlPresent = obsUrlRaw !== undefined && obsUrlRaw.length > 0
  const obsUrlValid = obsUrlPresent && isValidObsUrl(obsUrlRaw)

  if (obsUrlPresent && !obsUrlValid) {
    warnings.push({
      key: 'OBS_WEBSOCKET_URL',
      message: 'not a valid ws:// or wss:// URL; the OBS panel will report "not configured"'
    })
  }

  // Presence, not emptiness: an empty password means "OBS auth is disabled", which is a
  // real, supported configuration and must not be collapsed into "absent".
  const obsPasswordRaw = env['OBS_WEBSOCKET_PASSWORD']
  const obsPassword = obsPasswordRaw === undefined ? null : obsPasswordRaw

  const obs: ObsConfig | null =
    obsUrlValid && obsUrlRaw !== undefined ? { url: obsUrlRaw, password: obsPassword } : null

  // --- Google / YouTube ---------------------------------------------------
  const googleClientId = optional(env, 'GOOGLE_CLIENT_ID')
  const googleClientSecret = optional(env, 'GOOGLE_CLIENT_SECRET')
  if (googleClientId !== null && googleClientSecret === null) {
    warnings.push({
      key: 'GOOGLE_CLIENT_SECRET',
      message: 'missing while GOOGLE_CLIENT_ID is set; YouTube stays disabled'
    })
  }
  if (googleClientSecret !== null && googleClientId === null) {
    warnings.push({
      key: 'GOOGLE_CLIENT_ID',
      message: 'missing while GOOGLE_CLIENT_SECRET is set; YouTube stays disabled'
    })
  }
  const google: GoogleConfig | null =
    googleClientId !== null && googleClientSecret !== null
      ? { clientId: googleClientId, clientSecret: googleClientSecret }
      : null

  // --- Flags --------------------------------------------------------------
  const configured: Record<EnvKey, boolean> = {
    OBS_WEBSOCKET_URL: obsUrlValid,
    OBS_WEBSOCKET_PASSWORD: isSet(env, 'OBS_WEBSOCKET_PASSWORD'),
    GOOGLE_CLIENT_ID: isSet(env, 'GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: isSet(env, 'GOOGLE_CLIENT_SECRET'),
    DEEPGRAM_API_KEY: isSet(env, 'DEEPGRAM_API_KEY'),
    ESV_API_KEY: isSet(env, 'ESV_API_KEY'),
    API_BIBLE_KEY: isSet(env, 'API_BIBLE_KEY'),
    SENTRY_DSN: isSet(env, 'SENTRY_DSN')
  }

  return {
    obs,
    google,
    deepgramApiKey: optional(env, 'DEEPGRAM_API_KEY'),
    esvApiKey: optional(env, 'ESV_API_KEY'),
    apiBibleKey: optional(env, 'API_BIBLE_KEY'),
    sentryDsn: optional(env, 'SENTRY_DSN'),
    configured,
    warnings
  }
}

export interface LoadConfigFromDiskOptions {
  /** Explicit `.env` location. Defaults to dotenv's own resolution (cwd). */
  readonly envFilePath?: string
  /** Env to resolve from after dotenv has populated it. Defaults to `process.env`. */
  readonly env?: EnvSource
}

/**
 * Impure wrapper: populates `process.env` from a `.env` file (if one exists) and then
 * delegates to the pure {@link loadConfig}. A missing or unreadable `.env` is normal —
 * the app runs fully "not configured" and never crashes.
 */
export function loadConfigFromDisk(options: LoadConfigFromDiskOptions = {}): AppConfig {
  try {
    if (options.envFilePath === undefined) {
      loadDotenv({ quiet: true })
    } else {
      loadDotenv({ path: options.envFilePath, quiet: true })
    }
  } catch {
    // No .env, unreadable .env, or a parse failure — all mean "nothing configured".
  }
  return loadConfig(options.env ?? process.env)
}

/**
 * Projects a config down to key names and booleans for logging and for the renderer.
 *
 * This is the ONLY shape that may cross a log or IPC boundary. It cannot leak a secret,
 * because it never reads one.
 */
export function summarize(config: AppConfig): ConfigSummary {
  return {
    configured: { ...config.configured },
    obsConfigured: config.obs !== null,
    googleConfigured: config.google !== null,
    warnings: config.warnings.map((warning) => `${warning.key}: ${warning.message}`)
  }
}
