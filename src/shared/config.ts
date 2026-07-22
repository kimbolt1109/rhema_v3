/**
 * The configuration contract.
 *
 * Standing Rule 5 is encoded here: **an empty value means the subsystem runs in
 * "not configured" / degraded mode, and never crashes.** Every field that depends on a secret is
 * therefore nullable, and `configured` carries a per-key boolean the UI uses to render
 * "not configured" states without ever seeing a value.
 *
 * The keys are the single source of truth shared with `.env.example` — if you add one, add it in
 * both places in the same commit. `src/main/config/env.test.ts` asserts the two stay in step.
 *
 * Node-global free: reading `process.env` happens in `src/main/config/env.ts`. This module only
 * describes shapes, so the renderer can consume {@link ConfigSummary} over IPC.
 */

import { z } from 'zod'

import type { ObsConnectionConfig } from './obs'

/** Exactly the keys in `.env.example`, in file order. No more, no fewer. */
export const ENV_KEYS = [
  'OBS_WEBSOCKET_URL',
  'OBS_WEBSOCKET_PASSWORD',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'DEEPGRAM_API_KEY',
  'ESV_API_KEY',
  'API_BIBLE_KEY',
  'SENTRY_DSN',
] as const

/** Union of every recognised environment-variable name. */
export type EnvKey = (typeof ENV_KEYS)[number]

/** The raw shape accepted by the loader — `process.env` satisfies this. */
export type EnvSource = Readonly<Record<string, string | undefined>>

/**
 * Resolved OBS settings.
 *
 * Structurally identical to {@link ObsConnectionConfig}; aliased rather than redeclared so the
 * config layer and the OBS client cannot drift apart.
 */
export type ObsConfig = ObsConnectionConfig

/** Resolved Google OAuth client credentials. Non-null only when BOTH halves are present. */
export interface GoogleConfig {
  readonly clientId: string
  readonly clientSecret: string
}

/** A non-fatal configuration problem. Surfaced in the UI and logged; never thrown. */
export interface ConfigWarning {
  readonly key: EnvKey
  /** Human-readable reason. Contains key names only — never a value. */
  readonly message: string
}

/**
 * The resolved application configuration.
 *
 * Every secret-bearing field is nullable: absence is an expected, supported state. Nothing in
 * here is required for Verger to start.
 */
export interface AppConfig {
  /** `null` when unset or unusable. The OBS reconnect loop stays idle rather than dialling. */
  readonly obs: ObsConfig | null
  /** `null` unless BOTH client id and secret are present. */
  readonly google: GoogleConfig | null
  readonly deepgramApiKey: string | null
  readonly esvApiKey: string | null
  readonly apiBibleKey: string | null
  readonly sentryDsn: string | null
  /** Per-key "has a usable value" flags. Safe to log, safe to send to the renderer. */
  readonly configured: Readonly<Record<EnvKey, boolean>>
  readonly warnings: readonly ConfigWarning[]
}

/**
 * The loggable / renderer-safe projection of {@link AppConfig}: key names and booleans only.
 *
 * By construction it can carry no secret value, which is why this — and never `AppConfig` — is
 * what crosses IPC to the renderer and what gets written to the log file.
 */
export interface ConfigSummary {
  readonly configured: Readonly<Record<EnvKey, boolean>>
  readonly obsConfigured: boolean
  readonly googleConfigured: boolean
  /** Warning strings of the form `"<KEY>: <reason>"`. Never contains a value. */
  readonly warnings: readonly string[]
}

/**
 * Validation schema for an OBS websocket URL.
 *
 * zod v4: `z.url()` is the current spelling — `z.string().url()` is deprecated. The protocol
 * check is explicit because obs-websocket only speaks `ws:`/`wss:`, and an `http://` URL pasted
 * from a browser is the most likely operator mistake.
 */
export const obsUrlSchema = z
  .url({ message: 'must be a valid URL' })
  .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
    message: 'must start with ws:// or wss://',
  })

/** Validation schema for {@link ObsConfig}, used at the IPC boundary. */
export const obsConfigSchema = z.object({
  url: obsUrlSchema,
  password: z.string().nullable(),
})

/** Validation schema for {@link ConfigSummary}. */
export const configSummarySchema = z.object({
  configured: z.record(z.enum(ENV_KEYS), z.boolean()),
  obsConfigured: z.boolean(),
  googleConfigured: z.boolean(),
  warnings: z.array(z.string()),
})

/** Every key flagged false — the starting point for the loader and a safe default for the UI. */
export function emptyConfiguredMap(): Record<EnvKey, boolean> {
  const map = {} as Record<EnvKey, boolean>
  for (const key of ENV_KEYS) {
    map[key] = false
  }
  return map
}
