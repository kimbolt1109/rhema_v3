/**
 * The camera service — the CAM 1 / CAM 2 / WIDE / PULPIT buttons, and nothing else.
 *
 * ## The independence guarantee (BLUEPRINT.md §6)
 *
 * Switching cameras must not touch the lower-third, and showing a lower-third must not touch the
 * camera. That is enforced here in the strongest way available: **this module has no reference to
 * the overlay at all.** It imports no overlay type, holds no overlay server, and issues no
 * overlay command; the only side effects it can produce are the three OBS requests on
 * `ALLOWED_WRITE_REQUESTS`. `CameraService.test.ts` asserts both halves — structurally, that the
 * source file contains no overlay import, and behaviourally, that `select()` puts nothing but
 * scene/transition requests on the wire. Making a camera switch disturb an overlay would require
 * adding an import that a test would immediately fail on.
 *
 * ## OBS is the source of truth (Standing Rule 2)
 *
 * `activeSlot` is *derived* from whatever scene OBS says is live, never from the last button
 * pressed. The operator can switch scenes in OBS's own UI, or on an OBS hotkey, or from a
 * Stream Deck plugin talking to OBS directly — and the correct behaviour in every case is for
 * Verger's buttons to follow. When the live scene is not bound to any button, no button lights
 * up and Verger does *not* "correct" OBS by switching it back.
 *
 * ## Nothing throws
 *
 * Every method returns a {@link Result}. Every injected seam — the OBS client, the persistence
 * pair, every subscriber callback — is wrapped, because all of them cross a boundary this class
 * does not own and an exception escaping into the main process would take the booth UI with it.
 *
 * ## Everything is injected
 *
 * The OBS client is a five-method structural interface ({@link CameraObsClientLike}) and
 * persistence is a pair of function seams, so this file touches neither `node:fs` nor Electron
 * and the whole service is driven in tests by a forty-line mock. `index.ts` supplies the real
 * implementations.
 */

import {
  cameraConfigSchema,
  defaultCameraConfig,
  findBinding,
  isBindingUsable,
  slotForScene
} from '@shared/camera'
import type { CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { ObsSceneList, ObsStatus } from '@shared/obs'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of `ObsClient` this service uses.
 *
 * Structural and deliberately small: five members, and `call` is already gated by the client's
 * own allowlist, so this seam cannot be used to send OBS anything the client would not send.
 * Declared here rather than importing the class so the tests need no socket, no library and no
 * OBS Studio (which is not installed on the build machine).
 */
export interface CameraObsClientLike {
  /** Issue one OBS request. Subject to `ObsClient`'s read/allowlisted-write guard. */
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Result<unknown>>
  /** Ask OBS what scenes exist and which one is live. */
  getSceneList(): Promise<Result<ObsSceneList>>
  getStatus(): ObsStatus
  onStatus(callback: (status: ObsStatus) => void): Unsubscribe
  onSceneList(callback: (sceneList: ObsSceneList) => void): Unsubscribe
}

/** Write the configuration somewhere durable. Returns a {@link Result}; must not throw. */
export type CameraConfigWriter = (config: CameraConfig) => Result<void>

/**
 * Read the configuration back.
 *
 * `ok(null)` means "there is nothing saved yet", which is a resting state and not a failure —
 * a first run lands on {@link defaultCameraConfig}, four labelled buttons with no scenes bound.
 */
export type CameraConfigReader = () => Result<CameraConfig | null>

/** Constructor dependencies. `obs` and `logger` are required; persistence is optional. */
export interface CameraServiceOptions {
  readonly obs: CameraObsClientLike
  readonly logger: Logger
  /** Called after every accepted `setConfig`. Omitted: the config lives for the session only. */
  readonly persist?: CameraConfigWriter
  /** Called once, at construction. Omitted: start from {@link defaultCameraConfig}. */
  readonly load?: CameraConfigReader
}

/** The OBS request that asks for the configured transitions. A read — always permitted. */
const GET_TRANSITION_LIST = 'GetSceneTransitionList'

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class CameraService {
  private readonly obs: CameraObsClientLike
  private readonly log: Logger
  private readonly persist: CameraConfigWriter | null
  private readonly subscribers = new Set<(state: CameraState) => void>()

  private config: CameraConfig
  private currentProgramScene: string | null
  private availableTransitions: readonly string[] = []

  /** Last state handed to subscribers, so an unchanged state does not re-notify. */
  private lastEmitted: CameraState

  /** Tracks connection edges: `disconnected -> connected` is when OBS is re-interrogated. */
  private wasConnected: boolean

  private unsubscribeStatus: Unsubscribe | null = null
  private unsubscribeSceneList: Unsubscribe | null = null
  private disposed = false

  constructor(options: CameraServiceOptions) {
    this.obs = options.obs
    this.log = options.logger.child('camera')
    this.persist = options.persist ?? null
    this.config = this.readStoredConfig(options.load)

    const status = this.readStatus()
    this.currentProgramScene = status?.currentProgramScene ?? null
    this.wasConnected = status?.state === 'connected'
    this.lastEmitted = this.snapshot()

    this.subscribeToObs()

    // If OBS was already up when the service was constructed, interrogate it now rather than
    // waiting for a status edge that has already happened.
    if (this.wasConnected) void this.refreshFromObs()
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** The current button mapping. Always succeeds — a missing file yields the defaults. */
  getConfig(): Result<CameraConfig> {
    return ok(this.config)
  }

  /**
   * Replace the button mapping.
   *
   * Validated with `cameraConfigSchema` even though the caller is typed, because this is a trust
   * boundary: the settings screen's payload has crossed IPC by the time it arrives here.
   *
   * A persistence failure is reported but does *not* roll the mapping back. Mid-service, a
   * mapping that works until the app restarts is far more useful than no mapping at all — the
   * operator gets an `IO_ERROR` telling them it will not survive a restart, and keeps their
   * buttons.
   */
  setConfig(config: CameraConfig): Result<CameraConfig> {
    const parsed = cameraConfigSchema.safeParse(config)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      this.log.warn('rejected an invalid camera configuration', { detail })
      return err(ErrorCode.INVALID_ARG, 'the camera configuration is invalid', detail)
    }

    const next: CameraConfig = { bindings: parsed.data.bindings }
    this.config = next
    // Re-binding a button can change which one is live without OBS moving at all.
    this.publish()

    const written = this.writeConfig(next)
    if (!written.ok) return { ok: false, error: written.error }

    this.log.info('camera bindings updated', {
      mapped: next.bindings.filter((binding) => isBindingUsable(binding)).length
    })
    return ok(next)
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The live camera state, derived from what OBS reports. Always succeeds. */
  getState(): Result<CameraState> {
    return ok(this.snapshot())
  }

  /** Subscribe to camera-state changes, including scene switches made inside OBS. */
  onState(callback: (state: CameraState) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // Switching
  // -------------------------------------------------------------------------

  /**
   * Switch the program camera.
   *
   * The whole of what this does: at most one `SetCurrentSceneTransition`, at most one
   * `SetCurrentSceneTransitionDuration`, and one `SetCurrentProgramScene`. It never reads or
   * writes overlay state — a lower-third that is on screen stays exactly where it is.
   *
   * Two refusals happen before anything reaches OBS:
   *
   *  - an unmapped (or unusable) slot returns `INVALID_ARG` and issues no request at all, so a
   *    button the operator has not configured can never ask OBS for a scene that does not exist;
   *  - a disconnected OBS returns `NOT_CONNECTED` immediately rather than queueing. A camera cut
   *    that lands ninety seconds late is worse than one that visibly fails.
   *
   * A transition that cannot be set is logged and the switch proceeds regardless: the operator
   * pressed CAM 2 and must get CAM 2, even if it arrives with the wrong wipe.
   */
  async select(slot: CameraSlot): Promise<Result<CameraState>> {
    const binding = findBinding(this.config, slot)
    if (binding === null) {
      return err(ErrorCode.INVALID_ARG, `there is no camera button "${slot}"`, 'unknown slot')
    }
    if (!isBindingUsable(binding) || binding.sceneName === null) {
      return err(
        ErrorCode.INVALID_ARG,
        `the ${binding.label} button is not mapped to an OBS scene`,
        'choose a scene for it in camera settings'
      )
    }
    if (!this.isConnected()) {
      return err(
        ErrorCode.NOT_CONNECTED,
        `cannot switch to ${binding.label} while OBS is disconnected`,
        this.readStatus()?.state ?? 'unknown'
      )
    }

    const sceneName = binding.sceneName

    if (binding.transition !== null && binding.transition !== '') {
      // Transition first, then the scene: setting it afterwards would apply to the *next* cut.
      const transition = await this.callObs('SetCurrentSceneTransition', {
        transitionName: binding.transition
      })
      if (transition.ok) {
        // Only when the transition itself was named — changing the duration of a transition the
        // operator did not pick would be imposing state on OBS for no benefit.
        if (binding.transitionDurationMs !== null) {
          const duration = await this.callObs('SetCurrentSceneTransitionDuration', {
            transitionDuration: binding.transitionDurationMs
          })
          if (!duration.ok) {
            this.log.warn('could not set the transition duration; switching anyway', {
              slot,
              detail: duration.error.message
            })
          }
        }
      } else {
        this.log.warn('could not select the transition; switching anyway', {
          slot,
          transition: binding.transition,
          detail: transition.error.message
        })
      }
    }

    const switched = await this.callObs('SetCurrentProgramScene', { sceneName })
    if (!switched.ok) {
      this.log.error('the camera switch failed', { slot, sceneName, detail: switched.error.message })
      return { ok: false, error: switched.error }
    }

    // Reflect it immediately so the button lights up on the same frame as the cut. OBS's
    // `CurrentProgramSceneChanged` follows within milliseconds and remains authoritative — if it
    // disagrees (because something else moved the scene first), OBS wins.
    this.setProgramScene(sceneName)
    this.publish()
    this.log.info('camera switched', { slot, sceneName })
    return ok(this.snapshot())
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Detach from OBS and drop every subscriber. Idempotent. */
  dispose(): Result<void> {
    this.disposed = true
    runQuietly(this.unsubscribeStatus)
    runQuietly(this.unsubscribeSceneList)
    this.unsubscribeStatus = null
    this.unsubscribeSceneList = null
    this.subscribers.clear()
    return ok(undefined)
  }

  // -------------------------------------------------------------------------
  // OBS plumbing
  // -------------------------------------------------------------------------

  private subscribeToObs(): void {
    try {
      this.unsubscribeStatus = this.obs.onStatus((status) => {
        this.handleStatus(status)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to OBS status', { cause })
    }
    try {
      this.unsubscribeSceneList = this.obs.onSceneList((sceneList) => {
        this.handleSceneList(sceneList)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to the OBS scene list', { cause })
    }
  }

  /**
   * React to the OBS connection.
   *
   * A scene switched inside OBS arrives here (and on `onSceneList`) and updates `activeSlot`
   * with no request of our own — Verger reflects OBS, it does not poll it.
   */
  private handleStatus(status: ObsStatus): void {
    if (this.disposed) return

    const connected = status.state === 'connected'
    this.setProgramScene(status.currentProgramScene)

    if (connected && !this.wasConnected) {
      this.wasConnected = true
      void this.refreshFromObs()
    } else if (!connected && this.wasConnected) {
      this.wasConnected = false
      // Transitions belong to the OBS profile we are no longer attached to.
      this.availableTransitions = []
    }

    this.publish()
  }

  private handleSceneList(sceneList: ObsSceneList): void {
    if (this.disposed) return
    this.setProgramScene(sceneList.currentProgramScene)
    this.publish()
  }

  /**
   * Ask OBS what is live and which transitions exist.
   *
   * Never fails outward: a missing transition list leaves the settings picker empty, which is a
   * cosmetic degradation, not a reason to report the camera subsystem broken.
   */
  private async refreshFromObs(): Promise<void> {
    let scenes: Result<ObsSceneList>
    try {
      scenes = await this.obs.getSceneList()
    } catch (cause) {
      scenes = { ok: false, error: toAppError(cause, ErrorCode.OBS_ERROR) }
    }
    if (this.disposed) return
    if (scenes.ok) this.setProgramScene(scenes.value.currentProgramScene)

    const transitions = await this.callObs(GET_TRANSITION_LIST)
    if (this.disposed) return
    if (transitions.ok) {
      this.availableTransitions = parseTransitionNames(transitions.value)
    } else {
      this.log.debug('the OBS transition list could not be read', {
        detail: transitions.error.message
      })
    }

    this.publish()
  }

  /** One OBS request, with any thrown value converted rather than propagated. */
  private async callObs(
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Result<unknown>> {
    try {
      return await this.obs.call(requestType, requestData)
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.OBS_ERROR) }
    }
  }

  private readStatus(): ObsStatus | null {
    try {
      return this.obs.getStatus()
    } catch (cause) {
      this.log.warn('could not read the OBS status', { cause })
      return null
    }
  }

  private isConnected(): boolean {
    return this.readStatus()?.state === 'connected'
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  private setProgramScene(sceneName: string | null): void {
    this.currentProgramScene = sceneName
  }

  private snapshot(): CameraState {
    return {
      currentProgramScene: this.currentProgramScene,
      activeSlot: slotForScene(this.config, this.currentProgramScene),
      availableTransitions: this.availableTransitions
    }
  }

  /** Notify subscribers, but only when something a caller can observe actually changed. */
  private publish(): void {
    const next = this.snapshot()
    if (sameCameraState(next, this.lastEmitted)) return
    this.lastEmitted = next

    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(next)
      } catch (cause) {
        this.log.warn('a camera state subscriber threw', { cause })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private readStoredConfig(load: CameraConfigReader | undefined): CameraConfig {
    if (load === undefined) return defaultCameraConfig()

    let stored: Result<CameraConfig | null>
    try {
      stored = load()
    } catch (cause) {
      this.log.warn('the saved camera configuration could not be read; using defaults', { cause })
      return defaultCameraConfig()
    }

    if (!stored.ok) {
      this.log.warn('the saved camera configuration could not be read; using defaults', {
        detail: stored.error.message
      })
      return defaultCameraConfig()
    }
    if (stored.value === null) return defaultCameraConfig()

    const parsed = cameraConfigSchema.safeParse(stored.value)
    if (!parsed.success) {
      this.log.warn('the saved camera configuration is invalid; using defaults')
      return defaultCameraConfig()
    }
    return { bindings: parsed.data.bindings }
  }

  private writeConfig(config: CameraConfig): Result<void> {
    const persist = this.persist
    if (persist === null) return ok(undefined)

    try {
      const written = persist(config)
      if (!written.ok) {
        this.log.error('the camera configuration could not be saved', {
          detail: written.error.message
        })
      }
      return written
    } catch (cause) {
      const error = toAppError(cause, ErrorCode.IO_ERROR)
      this.log.error('the camera configuration could not be saved', { detail: error.message })
      return { ok: false, error }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structural equality for a {@link CameraState}. Cheap: three fields, one short array. */
export function sameCameraState(a: CameraState, b: CameraState): boolean {
  return (
    a.currentProgramScene === b.currentProgramScene &&
    a.activeSlot === b.activeSlot &&
    a.availableTransitions.length === b.availableTransitions.length &&
    a.availableTransitions.every((name, index) => name === b.availableTransitions[index])
  )
}

/**
 * Pull the transition names out of a `GetSceneTransitionList` response.
 *
 * Tolerant by design — an OBS build that adds or renames a field must not empty the operator's
 * transition picker, and anything unrecognised is simply skipped.
 */
export function parseTransitionNames(response: unknown): readonly string[] {
  if (typeof response !== 'object' || response === null) return []
  const transitions: unknown = (response as Record<string, unknown>)['transitions']
  if (!Array.isArray(transitions)) return []

  const names: string[] = []
  for (const entry of transitions as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const name: unknown = (entry as Record<string, unknown>)['transitionName']
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return names
}

function runQuietly(unsubscribe: Unsubscribe | null): void {
  if (unsubscribe === null) return
  try {
    unsubscribe()
  } catch {
    /* best effort — the producer is already gone */
  }
}
