/**
 * The plan module's public surface, and the one place `node:fs` and the other real services are
 * wired to {@link PlanService}.
 *
 * `PlanService` itself knows nothing about the overlay server class, `CameraService`, `ObsClient`
 * or the filesystem: it takes four structural seams. This file supplies the production ones, so
 * the service stays testable in a plain Node process with no Electron runtime and no OBS Studio.
 *
 * The singleton is **lazy and inert in both directions**. Constructing it performs no I/O: it
 * reads no plan, binds no port, sends OBS nothing and does not even construct the overlay,
 * camera or OBS singletons. Each seam resolves its dependency on FIRST USE, so `getPlanService()`
 * is safe to call from anywhere in main-process startup regardless of what has been built yet —
 * and calling it inside a unit test does not drag Electron's `app.getPath` in behind it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'

import { createNullLogger } from '@main/logging/logger'
import { getCameraService } from '@main/camera'
import { getObsClient } from '@main/obs'
import { getOverlayServer } from '@main/overlay'
import type { CameraSlot } from '@shared/camera'
import { overlayAssetUrl } from '@shared/net'
import type { Logger } from '@shared/log'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import type { ServicePlan } from '@shared/plan'
import type { Result } from '@shared/result'

import { PlanService } from './PlanService'
import type {
  PlanCameraLike,
  PlanDeckImporterLike,
  PlanFileAccess,
  PlanObsLike,
  PlanOverlayLike
} from './PlanService'
import { detectImporter, importDeck } from './deckImport'
import { loadPlanFile, resolveAssetPath, savePlanFile } from './planFile'
import type { LoadedPlan, PlanFileSystem } from './planFile'

export {
  MEDIA_RESTART_ACTION,
  MEDIA_TRIGGER_REQUEST,
  PlanService,
  UNTITLED_SERVICE,
  clampPosition,
  movePositionTo,
  toCameraSlot,
  toLowerThirdTemplate
} from './PlanService'
export type {
  PlanCameraLike,
  PlanDeckImporterLike,
  PlanFileAccess,
  PlanObsLike,
  PlanOverlayLike,
  PlanServiceOptions
} from './PlanService'

export {
  CURRENT_PLAN_SCHEMA_VERSION,
  MAX_PLAN_FILE_BYTES,
  PLAN_TEMP_SUFFIX,
  assetFileUrl,
  containWithin,
  describePlanIssues,
  isEscapingFragment,
  loadPlanFile,
  migratePlanDocument,
  resolveAssetDir,
  resolveAssetPath,
  savePlanFile,
  validatePlanDocument
} from './planFile'
export type { LoadedPlan, PlanFileSystem } from './planFile'

// ---------------------------------------------------------------------------
// The real filesystem
// ---------------------------------------------------------------------------

/**
 * `node:fs`, behind {@link PlanFileSystem}.
 *
 * Every call may throw; `planFile.ts` wraps all of them, which is exactly why this adapter is
 * allowed to be four-line-per-method thin.
 */
export const nodePlanFileSystem: PlanFileSystem = {
  size: (path) => statSync(path).size,
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, contents) => {
    writeFileSync(path, contents, 'utf8')
  },
  rename: (from, to) => {
    renameSync(from, to)
  },
  mkdirp: (directory) => {
    mkdirSync(directory, { recursive: true })
  },
  exists: (path) => existsSync(path),
  remove: (path) => {
    rmSync(path, { force: true })
  }
}

/** The production {@link PlanFileAccess}: real disk, real path containment. */
export function createPlanFileAccess(fs: PlanFileSystem = nodePlanFileSystem): PlanFileAccess {
  return {
    load: (path: string): Result<LoadedPlan> => loadPlanFile(fs, path),
    save: (path: string, plan: ServicePlan): Result<string> => savePlanFile(fs, path, plan),
    assetUrl: (planPath: string, plan: ServicePlan, asset: string): Result<string> => {
      const resolved = resolveAssetPath(planPath, plan, asset)
      if (!resolved.ok) return resolved
      // Slides are served over HTTP from the overlay server's `/assets` route, NOT as `file:`
      // URLs. The overlay page is loaded from `http://127.0.0.1:7320/overlay`, and Chromium —
      // including an OBS Browser Source — refuses `file:` subresources inside an `http:`
      // document; the page's CSP (`img-src 'self' data:`) rejects them too. A `file:` URL here
      // means the slide silently never appears on the congregation screen.
      //
      // `overlayAssetUrl` percent-encodes each segment, so filenames with spaces or Hangul —
      // both routine in a deck from a Korean church — resolve correctly. `resolved` is still
      // computed above because it performs the path-containment check.
      return { ok: true, value: overlayAssetUrl(asset) }
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy seams
// ---------------------------------------------------------------------------

/**
 * The overlay seam, resolved on first send.
 *
 * `getOverlayServer()` is cheap but not free, and constructing the plan service must not be the
 * thing that decides when the overlay server object comes into existence.
 */
const lazyOverlay: PlanOverlayLike = {
  send: (command: OverlayCommand): Result<OverlayState> => getOverlayServer().send(command),

  /**
   * Point the overlay server's `/assets` route at the open plan's folder.
   *
   * Without this the route 404s and every slide is a broken image. It is called whenever a plan
   * is opened, saved or imported into, because the folder moves with the plan.
   */
  setAssetRoot: (root: string | null): void => {
    getOverlayServer().setAssetRoot(root)
  }
}

/** The camera seam, resolved on first switch — `getCameraService()` reads a file on construction. */
const lazyCamera: PlanCameraLike = {
  select: async (slot: CameraSlot): Promise<Result<unknown>> => getCameraService().select(slot)
}

/** The OBS seam, resolved on first request. Still gated by the client's own write allowlist. */
const lazyObs: PlanObsLike = {
  call: async (
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Result<unknown>> =>
    requestData === undefined
      ? getObsClient().call(requestType)
      : getObsClient().call(requestType, requestData)
}

/**
 * The deck importer seam, bound to `deckImport.ts`.
 *
 * `detect()` probes for a converter and reports `available: false` with an explanation when there
 * is none — which is the state of the machine Phase 6 was built on, and the reason the UI can
 * disable import and say what to install rather than failing at click time.
 */
const realDeckImporter: PlanDeckImporterLike = {
  detect: () => detectImporter(),
  import: async (deckPath, options) =>
    importDeck(deckPath, { assetDir: options.assetDir, onProgress: options.onProgress })
}

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

/** Overrides for {@link getPlanService}. Every field has a production default. */
export interface GetPlanServiceOptions {
  /**
   * Where the service's diagnostics go.
   *
   * Defaults to the null logger, because the rolling-file logger is built inside
   * `app.whenReady()` and there is no module-level singleton to reach for. Pass the real one
   * (`getPlanService({ logger })`) so every cue fired on a Sunday is in the service-day log.
   */
  readonly logger?: Logger
  readonly overlay?: PlanOverlayLike
  readonly camera?: PlanCameraLike
  readonly obs?: PlanObsLike
  readonly files?: PlanFileAccess
  readonly deck?: PlanDeckImporterLike
}

let singleton: PlanService | null = null

/**
 * The process-wide plan service.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it. Construction
 * performs no I/O of any kind.
 */
export function getPlanService(options: GetPlanServiceOptions = {}): PlanService {
  if (singleton !== null) return singleton

  singleton = new PlanService({
    overlay: options.overlay ?? lazyOverlay,
    camera: options.camera ?? lazyCamera,
    obs: options.obs ?? lazyObs,
    logger: options.logger ?? createNullLogger(),
    files: options.files ?? createPlanFileAccess(),
    deck: options.deck ?? realDeckImporter,
    now: Date.now
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Disposing clears subscribers only. It deliberately leaves the overlay showing whatever it is
 * showing: Verger going away is never a reason to blank the congregation screen.
 */
export function resetPlanService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
