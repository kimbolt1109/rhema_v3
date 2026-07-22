/**
 * The camera module's public surface, and the one place Electron and `node:fs` are touched.
 *
 * `CameraService` itself knows nothing about `app.getPath('userData')` or the filesystem: it
 * takes a pair of function seams for persistence and a five-method structural interface for OBS.
 * This file supplies the real ones, so the service stays testable in a plain Node process with
 * no Electron runtime and no OBS Studio.
 *
 * The singleton is **lazy and inert**: constructing it opens no socket, binds no port and starts
 * no timer. It subscribes to the OBS client that already exists and reads a small JSON file —
 * and if that file is missing, unreadable or corrupt, it starts from
 * `defaultCameraConfig()` (four labelled buttons, nothing bound) rather than failing. Standing
 * Rule 5: absent configuration is a resting state, not a crash.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import { createNullLogger } from '@main/logging/logger'
import { getObsClient } from '@main/obs'
import type { CameraConfig } from '@shared/camera'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

import { CameraService } from './CameraService'

export { CameraService, parseTransitionNames, sameCameraState } from './CameraService'
export type {
  CameraConfigReader,
  CameraConfigWriter,
  CameraObsClientLike,
  CameraServiceOptions
} from './CameraService'

/** On-disk envelope. The version is for future migrations, never for feature detection. */
const FILE_VERSION = 1

/** Overrides for {@link getCameraService}. Every field has a production default. */
export interface GetCameraServiceOptions {
  /**
   * Where the service's diagnostics go.
   *
   * Defaults to the null logger, because the main process builds its rolling-file logger inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one
   * (`getCameraService({ logger })`) to route camera diagnostics into the service-day log.
   */
  readonly logger?: Logger
  /** Defaults to `<userData>/camera.json`. */
  readonly filePath?: string
}

/** `<userData>/camera.json`. Resolved lazily — `userData` is only valid once `app` is ready. */
export function defaultCameraConfigPath(): string {
  return join(app.getPath('userData'), 'camera.json')
}

/**
 * Read the saved configuration.
 *
 * A missing file is `ok(null)` — "nothing saved yet" is the normal first-run state and not an
 * error. A corrupt file is an `Err`, which the service logs before falling back to the defaults;
 * it is deliberately not deleted, so a hand-editing mistake can still be recovered by hand.
 */
export function readCameraConfigFile(filePath: string): Result<CameraConfig | null> {
  try {
    if (!existsSync(filePath)) return ok(null)
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return err(ErrorCode.IO_ERROR, 'the saved camera configuration is not an object', filePath)
    }
    // Validation proper is the service's job — `cameraConfigSchema` strips the envelope's
    // `version` key on the way through, so the whole object can be handed over as-is.
    return ok(parsed as CameraConfig)
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

/**
 * Write the configuration.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write cannot leave a half-written
 * `camera.json` that loses the operator's mapping the next Sunday morning.
 */
export function writeCameraConfigFile(filePath: string, config: CameraConfig): Result<void> {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, ...config }, null, 2), 'utf8')
    renameSync(temporary, filePath)
    return ok(undefined)
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

let singleton: CameraService | null = null

/**
 * The process-wide camera service.
 *
 * Callable with no arguments — that is exactly how `src/main/ipc/register.ts` wires it.
 * Construction subscribes to the OBS client and reads one small file; it dials nothing.
 */
export function getCameraService(options: GetCameraServiceOptions = {}): CameraService {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()
  // Resolved lazily inside the seams: `app.getPath('userData')` is only meaningful after the
  // app is ready, and neither seam runs before the service actually needs the file.
  const resolvePath = (): string => options.filePath ?? defaultCameraConfigPath()

  singleton = new CameraService({
    obs: getObsClient(),
    logger,
    load: () => readCameraConfigFile(resolvePath()),
    persist: (config) => writeCameraConfigFile(resolvePath(), config)
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Exists for tests and for a clean app shutdown; production code holds the instance rather than
 * resetting it mid-service.
 */
export function resetCameraService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
