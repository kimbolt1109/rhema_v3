/**
 * The portable, operator-editable `config.json` contract.
 *
 * Verger's canonical configuration is `.env` (see `src/shared/config.ts`). That shape is right for
 * a developer and for secrets, but it is the wrong shape for the one person setting this up on an
 * unfamiliar church PC from a USB stick: `KEY=value` lines, a hidden dotfile, and no structure.
 *
 * `config.json` is the friendly face of the same configuration. It sits **next to the launcher**
 * (not inside the app bundle), holds only the handful of things an operator actually changes — which
 * OBS to talk to, which port the overlay serves on, which speech engine runs — and is written with a
 * sensible default on first launch if absent (Standing Rule 5: absence is a resting state, never a
 * crash).
 *
 * This module is Node-global free and Electron free. It describes the shape and the **pure** mapping
 * from `config.json` into the env keys the rest of the app already understands. The impure half —
 * working out WHERE the file lives next to the executable, reading it, writing the default — is
 * `src/main/config/portable.ts`.
 *
 * Forgiveness is deliberate. Every field carries a `.catch(default)`, so a hand-edited file with one
 * bad value (a quoted port, a typo'd engine name) degrades that single field to its default rather
 * than taking the whole app down at 10:25 on a Sunday.
 */

import { z } from 'zod'

import { OBS_DEFAULT_WS_PORT, normalizeObsUrl } from './config'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT } from './net'

/** The speech engines an operator can select. `whisper` = local, free, offline faster-whisper. */
export const ASR_ENGINES = ['whisper', 'none'] as const

/** Union of the recognised ASR engine names. */
export type AsrEngine = (typeof ASR_ENGINES)[number]

/** A TCP port an operator might type by hand — coerced from a string, clamped to the legal range. */
const portField = (fallback: number): z.ZodType<number> =>
  z.coerce.number().int().min(1).max(65535).catch(fallback)

/**
 * The `config.json` schema.
 *
 * Unknown keys are stripped (forward compatible — a newer build's key in an older app is ignored,
 * not rejected). Every field has a default, so `parse({})` yields a complete, valid config.
 */
export const portableConfigSchema = z
  .object({
    obs: z
      .object({
        host: z.string().catch(LOOPBACK_ADDRESS),
        port: portField(OBS_DEFAULT_WS_PORT),
        password: z.string().catch(''),
      })
      .catch({ host: LOOPBACK_ADDRESS, port: OBS_DEFAULT_WS_PORT, password: '' }),
    overlay: z
      .object({ port: portField(OVERLAY_SERVER_PORT) })
      .catch({ port: OVERLAY_SERVER_PORT }),
    asr: z
      .object({ engine: z.enum(ASR_ENGINES).catch('whisper') })
      .catch({ engine: 'whisper' }),
    assets: z
      .object({
        /** Optional path to a `plan.json` to remember for the operator, relative to config.json. */
        plan: z.string().catch(''),
      })
      .catch({ plan: '' }),
  })
  .catch({
    obs: { host: LOOPBACK_ADDRESS, port: OBS_DEFAULT_WS_PORT, password: '' },
    overlay: { port: OVERLAY_SERVER_PORT },
    asr: { engine: 'whisper' },
    assets: { plan: '' },
  })

/** A fully-resolved, validated `config.json`. */
export type PortableConfig = z.infer<typeof portableConfigSchema>

/** The config written to disk on first launch, and the fallback for anything unreadable. */
export const DEFAULT_PORTABLE_CONFIG: PortableConfig = {
  obs: { host: LOOPBACK_ADDRESS, port: OBS_DEFAULT_WS_PORT, password: '' },
  overlay: { port: OVERLAY_SERVER_PORT },
  asr: { engine: 'whisper' },
  assets: { plan: '' },
}

/**
 * The result of turning a {@link PortableConfig} into the values the rest of the app consumes.
 *
 * `envOverrides` are exactly the `.env` keys `config.json` is responsible for (the OBS connection).
 * They are applied to the environment BEFORE dotenv runs, so `config.json` is the source of truth
 * for OBS in a portable build and a stray `.env` cannot override it.
 */
export interface ResolvedPortableConfig {
  readonly config: PortableConfig
  readonly envOverrides: Readonly<Record<string, string>>
  readonly overlayPort: number
  readonly asrEngine: AsrEngine
}

/**
 * Pure mapping from `config.json` to env overrides + the non-env settings the launcher wires up.
 *
 * The OBS host and port are folded into a single `OBS_WEBSOCKET_URL` through the very same
 * {@link normalizeObsUrl} the Connection screen uses, so `host: "127.0.0.1"`, `port: 4455` becomes
 * `ws://127.0.0.1:4455` — the shape `src/main/config/env.ts` validates. An empty password is passed
 * through as an empty string, which the loader reads as "OBS authentication is disabled" (distinct
 * from the key being absent).
 */
export function resolvePortableConfig(config: PortableConfig): ResolvedPortableConfig {
  const url = normalizeObsUrl(`${config.obs.host}:${config.obs.port}`)
  return {
    config,
    envOverrides: {
      OBS_WEBSOCKET_URL: url,
      OBS_WEBSOCKET_PASSWORD: config.obs.password,
    },
    overlayPort: config.overlay.port,
    asrEngine: config.asr.engine,
  }
}

/** The `_readme` line written into the default file. Stripped on read; it is only there for humans. */
const CONFIG_README =
  'Verger settings — edit and save, then restart Verger. ' +
  'obs.host/obs.port/obs.password must match OBS > Tools > WebSocket Server Settings. ' +
  'See RUNBOOK.md next to this file. This file may sit on a USB stick; keep it beside START.bat.'

/**
 * Serialize a config to the exact JSON text written next to the launcher.
 *
 * A `_readme` hint is included so an operator opening the file in Notepad sees what it is and what to
 * do. JSON has no comments, so this is the honest way to leave a note in the file itself; it is an
 * unknown key and is stripped on the way back in.
 */
export function serializePortableConfig(config: PortableConfig): string {
  return `${JSON.stringify({ _readme: CONFIG_README, ...config }, null, 2)}\n`
}
