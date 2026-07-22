/**
 * The ASR module's public surface, and the one place Electron, `node:fs` and the two concrete
 * adapters are touched.
 *
 * `AsrService` itself knows nothing about `app.getPath('userData')`, about Deepgram's websocket,
 * or about the Python sidecar that runs faster-whisper: it takes a pair of function seams for
 * persistence and an array of {@link AsrProvider}s. This file supplies the real ones, so the
 * service — and with it the whole fallback policy — stays testable in a plain Node process with
 * no key, no network, no GPU and no Electron runtime.
 *
 * The singleton is **lazy and inert**. Constructing it opens no socket, spawns no child process,
 * downloads no model and starts no timer: it builds two dormant adapter objects and reads one
 * small JSON file. Both adapters are inert until `start()`, which only ever happens because the
 * operator pressed something. If the settings file is missing, unreadable or corrupt the service
 * starts from `defaultAsrSettings()` — Standing Rule 5: absent configuration is a resting state,
 * not a crash.
 *
 * And if the whole subsystem cannot be built at all — no `DEEPGRAM_API_KEY`, no usable GPU, a
 * Python environment that is not there — `src/main/ipc/register.ts` catches it, the seven `asr:*`
 * channels answer `NOT_CONFIGURED`, and the plan, the cameras, the overlay and GO LIVE are
 * untouched. A dead recogniser never blocks the operator (Standing Rule 1).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import { loadConfigFromDisk } from '@main/config/env'
import { createNullLogger } from '@main/logging/logger'
import type { AsrSettings } from '@shared/asr'
import type { AppConfig } from '@shared/config'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

import { AsrService } from './AsrService'
import type { AsrProvider } from './AsrProvider'
import { DeepgramProvider } from './DeepgramProvider'
import { WhisperProvider } from './WhisperProvider'

export { ASR_PROVIDER_LABELS, asrProviderLabel } from './AsrProvider'
export type {
  AsrErrorListener,
  AsrProvider,
  AsrSegmentListener,
  AsrStartOptions
} from './AsrProvider'
export {
  AsrService,
  DEFAULT_ERROR_WINDOW_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_START_TIMEOUT_MS,
  median,
  realAsrTimers,
  sameAsrStatus
} from './AsrService'
export type {
  AsrConfigLike,
  AsrServiceOptions,
  AsrSettingsReader,
  AsrSettingsWriter,
  AsrTimerHandle,
  AsrTimers
} from './AsrService'

/** On-disk envelope. The version is for future migrations, never for feature detection. */
const FILE_VERSION = 1

/** Overrides for {@link getAsrService}. Every field has a production default. */
export interface GetAsrServiceOptions {
  /**
   * Where the service's diagnostics go.
   *
   * Defaults to the null logger, because the main process builds its rolling-file logger inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one
   * (`getAsrService({ logger })`) to route ASR diagnostics into the service-day log.
   */
  readonly logger?: Logger
  /** Defaults to a fresh `loadConfigFromDisk()`. Only `deepgramApiKey` is read. */
  readonly config?: AppConfig
  /** Defaults to `<userData>/asr.json`. */
  readonly filePath?: string
  /** Defaults to the real Deepgram and faster-whisper adapters. */
  readonly providers?: readonly AsrProvider[]
}

/** `<userData>/asr.json`. Resolved lazily — `userData` is only valid once `app` is ready. */
export function defaultAsrSettingsPath(): string {
  return join(app.getPath('userData'), 'asr.json')
}

/**
 * Read the saved settings.
 *
 * A missing file is `ok(null)` — "nothing saved yet" is the normal first-run state and not an
 * error. A corrupt file is an `Err`, which the service logs before falling back to the defaults;
 * it is deliberately not deleted, so a hand-editing mistake can still be recovered by hand.
 */
export function readAsrSettingsFile(filePath: string): Result<AsrSettings | null> {
  try {
    if (!existsSync(filePath)) return ok(null)
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return err(ErrorCode.IO_ERROR, 'the saved ASR settings are not an object', filePath)
    }
    // Validation proper is the service's job — `asrSettingsSchema` strips the envelope's
    // `version` key on the way through, so the whole object can be handed over as-is.
    return ok(parsed as AsrSettings)
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

/**
 * Write the settings.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write cannot leave a half-written
 * `asr.json` that loses the operator's custom vocabulary the next Sunday morning.
 */
export function writeAsrSettingsFile(filePath: string, settings: AsrSettings): Result<void> {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({ version: FILE_VERSION, ...settings }, null, 2),
      'utf8'
    )
    renameSync(temporary, filePath)
    return ok(undefined)
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

/**
 * Build the two real adapters, in preference order.
 *
 * Both constructors are inert: the Deepgram adapter holds a key and opens nothing; the whisper
 * adapter records where its Python lives and spawns nothing. Which of them actually runs is the
 * service's decision, taken from the operator's mode setting — see `AsrService`.
 *
 * Note that an absent key is NOT an error here. The Deepgram adapter is still constructed and
 * still registered; it simply reports `isConfigured() === false`, the service drops it from the
 * plan, and `auto` mode runs local. That is the whole of Standing Rule 5 in this subsystem.
 */
export function createAsrProviders(config: AppConfig, logger: Logger): readonly AsrProvider[] {
  return [
    new DeepgramProvider({ apiKey: config.deepgramApiKey, logger }),
    new WhisperProvider({ logger })
  ]
}

let singleton: AsrService | null = null

/**
 * The process-wide ASR service.
 *
 * Callable with no arguments — that is exactly how `src/main/ipc/register.ts` wires it.
 * Construction builds two dormant adapters and reads one small file; it dials nothing, spawns
 * nothing and downloads nothing.
 */
export function getAsrService(options: GetAsrServiceOptions = {}): AsrService {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()
  const config = options.config ?? loadConfigFromDisk()
  // Resolved lazily inside the seams: `app.getPath('userData')` is only meaningful after the
  // app is ready, and neither seam runs before the service actually needs the file.
  const resolvePath = (): string => options.filePath ?? defaultAsrSettingsPath()

  singleton = new AsrService({
    config,
    logger,
    providers: options.providers ?? createAsrProviders(config, logger),
    load: () => readAsrSettingsFile(resolvePath()),
    persist: (settings) => writeAsrSettingsFile(resolvePath(), settings)
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Exists for tests and for a clean app shutdown; production code holds the instance rather than
 * resetting it mid-service.
 */
export function resetAsrService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
