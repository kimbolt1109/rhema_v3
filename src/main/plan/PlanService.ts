/**
 * The plan service — the manual slide driver, and the thing every later automation degrades to.
 *
 * Phase 6 exists to make one promise true: **an operator with no ASR, no cue engine and no
 * network can drive the whole service by pressing SPACE.** Phases 7 and 8 bolt a transcript
 * follower on top of this, and when that follower is unsure, wrong, or switched off, what is left
 * is exactly this file. So it is built first and it is built to be boring.
 *
 * ## What firing a cue actually does
 *
 * | cue type     | route                                                                   |
 * | ------------ | ----------------------------------------------------------------------- |
 * | `slide`      | overlay `slide.show` with the asset resolved to a URL                    |
 * | `lowerthird` | overlay `lowerThird.show`                                                |
 * | `scripture`  | overlay `scripture.show` with the REFERENCE and an EMPTY text            |
 * | `scene`      | the camera service when the name is a camera slot, else OBS by name      |
 * | `media`      | refused — see below                                                      |
 * | `action`     | the matching overlay command (`clearAll`, `slide.hide`, …)               |
 *
 * ### Scripture cues carry a reference, never verse text (Standing Rule 4)
 *
 * `ScripturePayload` has no `text` field, so there is nothing to send even if this file wanted
 * to. The overlay is given the reference and an empty string; Phase 8 resolves the text from a
 * licensed API at fire time. Nothing in Verger authors, stores, or ships verse text.
 *
 * ### Media cues are refused, on purpose
 *
 * Playing an OBS media source needs `TriggerMediaInputAction`, and that request is not on
 * `ALLOWED_WRITE_REQUESTS` in `src/main/obs/ObsClient.ts` — a deliberate seven-name list that
 * keeps Verger from rearranging the operator's OBS (Standing Rule 2). This module therefore
 * ASKS the guard rather than assuming, and when the answer is no it returns a clear `Err` saying
 * the allowlist would have to be widened in a reviewed change. A phase does not get to quietly
 * punch through that guard, so this one does not.
 *
 * ## Advance moves forward; back only moves the pointer
 *
 * `advance()` fires the next cue. `back()` steps the pointer back and **fires nothing** — see
 * {@link PlanService.back} for why that asymmetry is the correct one.
 *
 * ## Everything is injected, nothing throws
 *
 * The overlay, the camera, OBS and the filesystem are four local structural seams, so this whole
 * service is driven in tests by trivial mocks with no Electron, no OBS Studio and no real disk.
 * Every method returns a {@link Result}; every seam call and every subscriber is wrapped.
 */

import type { z } from 'zod'

import { isAllowedRequest } from '@main/obs/ObsClient'
import { CAMERA_SLOTS } from '@shared/camera'
import type { CameraSlot } from '@shared/camera'
import type {
  DeckImportProgress,
  DeckImporterStatus,
  PlanState,
  Unsubscribe
} from '@shared/ipc'
import type { Logger } from '@shared/log'
import { LOWER_THIRD_TEMPLATES } from '@shared/overlay'
import type { LowerThirdTemplate, OverlayCommand, OverlayState } from '@shared/overlay'
import {
  advance as advancePosition,
  cuePayloadSchemas,
  cueAt,
  emptyServicePlan,
  initialPlanPosition,
  nextCue,
  stepBack
} from '@shared/plan'
import type { Cue, PlanPosition, ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

import { resolveAssetDir, validatePlanDocument } from './planFile'
import type { LoadedPlan } from './planFile'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of the overlay server this service uses.
 *
 * One method. The overlay owns its own state and re-sends it on reconnect, so the plan service
 * has nothing to remember and nothing to resync.
 */
export interface PlanOverlayLike {
  send(command: OverlayCommand): Result<OverlayState>
  /**
   * Point the overlay server's HTTP asset route at the open plan's folder.
   *
   * Optional so tests can supply a two-line double. In production it is essential: slide images
   * are served over HTTP from that route, because Chromium refuses `file:` subresources inside
   * the `http:` overlay document. Without it every slide is a broken image.
   */
  setAssetRoot?(root: string | null): void
}

/**
 * The slice of the camera service this service uses.
 *
 * The return value is deliberately `unknown`: the plan does not care what the camera state looks
 * like, only whether the switch was accepted, and not importing `CameraState` keeps this file
 * from growing a dependency on a module written in parallel.
 */
export interface PlanCameraLike {
  select(slot: CameraSlot): Promise<Result<unknown>>
}

/**
 * The slice of the OBS client this service uses.
 *
 * `call` is already gated by `ObsClient`'s own read/allowlisted-write guard, so holding this seam
 * grants no authority the client does not already have.
 */
export interface PlanObsLike {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Result<unknown>>
}

/**
 * Plan persistence and asset resolution.
 *
 * Supplied by `index.ts` from `planFile.ts` bound to the real filesystem. Omitted, the service is
 * still a fully working in-memory cue driver — `open`, `save` and slide cues report
 * `NOT_CONFIGURED` rather than failing in some more exciting way (Standing Rule 5).
 */
export interface PlanFileAccess {
  load(path: string): Result<LoadedPlan>
  /** Returns the absolute path written to. */
  save(path: string, plan: ServicePlan): Result<string>
  /**
   * A URL the overlay can load for one asset of this plan.
   *
   * Given the plan's own path so asset paths stay relative to the plan file, and expected to
   * refuse anything that escapes the plan's asset folder.
   */
  assetUrl(planPath: string, plan: ServicePlan, asset: string): Result<string>
}

/**
 * The slice of the deck importer this service uses.
 *
 * A PowerPoint deck is an arbitrary file a stranger may have produced, so the actual parsing and
 * conversion live behind this seam in `deckImport.ts` (bounded parser + child-process renderer).
 * The plan service only ever sees the cues that came back, and — Standing Rule 4 — those cues
 * carry an image path and a generated label, never a word of the slide's own text.
 *
 * Omitted, `importDeck` reports that no importer is wired and `getImporterStatus` reports
 * `available: false` with the reason. Degrade, never crash (Standing Rule 5).
 */
export interface PlanDeckImporterLike {
  /** Whether a converter exists on this machine, and what to install when it does not. */
  detect(): DeckImporterStatus
  /** Convert a deck into one manual slide cue per slide, writing images under `assetDir`. */
  import(
    deckPath: string,
    options: {
      readonly assetDir: string
      readonly onProgress: (progress: DeckImportProgress) => void
    }
  ): Promise<Result<{ readonly cues: readonly Cue[]; readonly warnings?: readonly string[] }>>
}

/** Constructor dependencies. `overlay`, `camera`, `obs` and `logger` are required. */
export interface PlanServiceOptions {
  readonly overlay: PlanOverlayLike
  readonly camera: PlanCameraLike
  readonly obs: PlanObsLike
  readonly logger: Logger
  /** Omitted: the plan lives for the session only and slide assets cannot be resolved. */
  readonly files?: PlanFileAccess
  /** Omitted: deck import reports itself unavailable rather than failing in some louder way. */
  readonly deck?: PlanDeckImporterLike
  /** Epoch-milliseconds clock, injected so log fields are deterministic in tests. */
  readonly now?: () => number
  /**
   * The OBS write guard, injected only so a test can prove both sides of the media refusal.
   *
   * Production passes nothing and gets `isAllowedRequest` — the real allowlist in
   * `src/main/obs/ObsClient.ts`. If a future reviewed change adds the media request to that list,
   * media cues start working here with no edit to this file.
   */
  readonly isObsRequestAllowed?: (requestType: string) => boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The cue types that have a payload schema — every one of them. */
type CuePayloadKind = keyof typeof cuePayloadSchemas

/** The validated payload shape for one cue type. */
type CuePayloadFor<K extends CuePayloadKind> = z.infer<(typeof cuePayloadSchemas)[K]>

/** The obs-websocket request a media cue would need. NOT on the allowlist — see the docblock. */
export const MEDIA_TRIGGER_REQUEST = 'TriggerMediaInputAction'

/** Restart the media source from the top. The only media action a cue means. */
export const MEDIA_RESTART_ACTION = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'

/** The OBS request a scene cue sends when the scene is not one of the camera buttons. */
const SET_PROGRAM_SCENE_REQUEST = 'SetCurrentProgramScene'

/** The name a fresh, unsaved plan carries until the operator names it. */
export const UNTITLED_SERVICE = 'Untitled service'

/**
 * Action cue names, mapped onto the overlay commands that take no payload.
 *
 * Deliberately a small closed list: an `action` cue is an app verb, not an escape hatch, and an
 * unknown one is an authoring mistake that must be reported rather than silently ignored during
 * a service.
 */
const ACTION_COMMANDS: Readonly<Record<string, 'clearAll' | 'slide.hide' | 'lowerThird.hide' | 'scripture.hide'>> = {
  clear: 'clearAll',
  clearall: 'clearAll',
  'overlay.clearall': 'clearAll',
  'slide.hide': 'slide.hide',
  hideslide: 'slide.hide',
  'lowerthird.hide': 'lowerThird.hide',
  hidelowerthird: 'lowerThird.hide',
  'scripture.hide': 'scripture.hide',
  hidescripture: 'scripture.hide'
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class PlanService {
  private readonly overlay: PlanOverlayLike
  private readonly camera: PlanCameraLike
  private readonly obs: PlanObsLike
  private readonly log: Logger
  private readonly files: PlanFileAccess | null
  private readonly deck: PlanDeckImporterLike | null
  private readonly now: () => number
  private readonly isObsRequestAllowed: (requestType: string) => boolean

  private plan: ServicePlan = emptyServicePlan(UNTITLED_SERVICE)
  private position: PlanPosition = initialPlanPosition()
  private path: string | null = null
  private dirty = false
  private lastFired: Cue | null = null

  private readonly subscribers = new Set<(state: PlanState) => void>()
  private readonly progressSubscribers = new Set<(progress: DeckImportProgress) => void>()

  /** True while an import is running. One deck at a time; a second press is refused. */
  private importing = false
  private disposed = false

  constructor(options: PlanServiceOptions) {
    this.overlay = options.overlay
    this.camera = options.camera
    this.obs = options.obs
    this.log = options.logger.child('plan')
    this.files = options.files ?? null
    this.deck = options.deck ?? null
    this.now = options.now ?? Date.now
    this.isObsRequestAllowed = options.isObsRequestAllowed ?? isAllowedRequest
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The current plan, position and dirty flag. Always a complete, serialisable snapshot. */
  getState(): Result<PlanState> {
    return ok(this.snapshot())
  }

  /** Subscribe to state changes. Published after every accepted edit, fire and move. */
  onState(callback: (state: PlanState) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /**
   * Replace the plan — the write path for every authoring edit the renderer makes.
   *
   * Validated even though the caller is typed, because by the time a plan arrives here it has
   * crossed IPC and is untrusted input.
   *
   * **The position is preserved, not reset.** Editing a plan mid-service is normal (a cue is
   * added, a hymn is dropped), and throwing the operator back to the top of the order of service
   * because they fixed a typo would be its own emergency. The pointer is clamped to the new
   * length and `firedCueIds` is filtered to cues that still exist.
   */
  setPlan(plan: ServicePlan): Result<PlanState> {
    if (this.disposed) return this.disposedError()

    const validated = validatePlanDocument(plan)
    if (!validated.ok) {
      this.log.warn('rejected an invalid service plan', { detail: validated.error.detail })
      return validated
    }

    const next = validated.value
    this.plan = next
    this.position = clampPosition(this.position, next)
    if (this.lastFired !== null && !next.cues.some((cue) => cue.id === this.lastFired?.id)) {
      this.lastFired = null
    }
    this.dirty = true

    this.log.info('the service plan was updated', {
      service: next.service,
      cues: next.cues.length
    })
    return ok(this.publish())
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Load a plan from disk.
   *
   * With no path, re-opens the plan already loaded — the "revert my edits" gesture. A validation
   * failure leaves the CURRENT plan completely untouched: refusing to open a broken file must
   * never also lose the plan the operator already had open.
   */
  open(path?: string): Result<PlanState> {
    if (this.disposed) return this.disposedError()

    const files = this.files
    if (files === null) return this.noFilesError('open')

    const target = path ?? this.path
    if (target === null || target.trim() === '') {
      return err(ErrorCode.INVALID_ARG, 'no plan file was chosen to open')
    }

    const loaded = this.attempt(() => files.load(target), 'the plan could not be opened')
    if (!loaded.ok) {
      this.log.warn('could not open a service plan', {
        path: target,
        code: loaded.error.code,
        detail: loaded.error.detail
      })
      return loaded
    }

    this.plan = loaded.value.plan
    this.path = loaded.value.path
    this.publishAssetRoot()
    // A freshly loaded plan starts at the top, with nothing fired and nothing unsaved.
    this.position = initialPlanPosition()
    this.lastFired = null
    this.dirty = false

    this.log.info('opened a service plan', {
      path: loaded.value.path,
      service: loaded.value.plan.service,
      cues: loaded.value.plan.cues.length
    })
    return ok(this.publish())
  }

  /**
   * Save the plan.
   *
   * With no path, saves back where it was opened from. A plan that has never been saved needs a
   * path — choosing one is the caller's job (a file dialog lives in the IPC layer, not here).
   * `dirty` clears only when the write actually succeeded.
   */
  save(path?: string): Result<PlanState> {
    if (this.disposed) return this.disposedError()

    const files = this.files
    if (files === null) return this.noFilesError('save')

    const target = path ?? this.path
    if (target === null || target.trim() === '') {
      return err(
        ErrorCode.INVALID_ARG,
        'this plan has never been saved — choose where to save it first'
      )
    }

    const saved = this.attempt(() => files.save(target, this.plan), 'the plan could not be saved')
    if (!saved.ok) {
      this.log.error('could not save the service plan', {
        path: target,
        code: saved.error.code,
        detail: saved.error.detail
      })
      return saved
    }

    this.path = saved.value
    this.publishAssetRoot()
    this.dirty = false
    this.log.info('saved the service plan', { path: saved.value, cues: this.plan.cues.length })
    return ok(this.publish())
  }

  // -------------------------------------------------------------------------
  // Deck import
  // -------------------------------------------------------------------------

  /**
   * Whether a PowerPoint deck can be converted on this machine.
   *
   * Never an error: "there is no converter installed" is a resting state the settings panel
   * explains, not a failure (Standing Rule 5). With no importer wired at all the answer is the
   * same shape with `available: false` and a reason.
   */
  getImporterStatus(): Result<DeckImporterStatus> {
    const deck = this.deck
    if (deck === null) {
      return ok({
        available: false,
        backend: null,
        executablePath: null,
        detail: 'no deck importer is wired into this build — slide cues can still be authored by hand'
      })
    }
    try {
      return ok(deck.detect())
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  /** Subscribe to import progress. A deck can take a while and the UI must not look frozen. */
  onImportProgress(callback: (progress: DeckImportProgress) => void): Unsubscribe {
    this.progressSubscribers.add(callback)
    return () => {
      this.progressSubscribers.delete(callback)
    }
  }

  /**
   * Import a `.pptx` and APPEND its slides to the plan.
   *
   * Appending rather than replacing is the deliberate choice: an operator importing the sermon
   * deck at 09:45 has already authored the welcome, the notices and the offering, and an import
   * that wiped those would be unrecoverable in the ten minutes they have left.
   *
   * The imported cues are validated as part of the whole plan before anything is committed, so a
   * deck that produced something malformed cannot half-land in a plan that is about to be driven
   * at a congregation. Slide text is never read (Standing Rule 4) — a slide is an opaque image
   * and its cue is labelled by number.
   */
  async importDeck(deckPath: string): Promise<Result<PlanState>> {
    if (this.disposed) return this.disposedError()

    const deck = this.deck
    if (deck === null) {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'no deck importer is wired into this build',
        'slide cues can still be authored by hand'
      )
    }
    if (this.importing) {
      return err(ErrorCode.INVALID_ARG, 'a deck import is already running')
    }
    if (deckPath.trim() === '') {
      return err(ErrorCode.INVALID_ARG, 'no deck was chosen to import')
    }

    const planPath = this.path
    if (planPath === null) {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'save the plan before importing a deck — slide images are written beside the plan file'
      )
    }

    const assetDir = resolveAssetDir(planPath, this.plan)
    if (!assetDir.ok) return assetDir

    this.importing = true
    try {
      const imported = await this.attemptAsync(
        () =>
          deck.import(deckPath, {
            assetDir: assetDir.value,
            onProgress: (progress) => {
              this.publishProgress(progress)
            }
          }),
        'the deck could not be imported'
      )
      if (!imported.ok) {
        this.log.warn('a deck import failed', {
          code: imported.error.code,
          message: imported.error.message
        })
        return imported
      }

      const merged: ServicePlan = {
        ...this.plan,
        cues: [...this.plan.cues, ...imported.value.cues]
      }
      const validated = validatePlanDocument(merged)
      if (!validated.ok) {
        this.log.error('the imported deck did not produce a valid plan; nothing was changed', {
          detail: validated.error.detail
        })
        return validated
      }

      this.plan = validated.value
      this.dirty = true
      this.log.info('imported a deck', {
        deckPath,
        added: imported.value.cues.length,
        cues: this.plan.cues.length,
        warnings: imported.value.warnings?.length ?? 0
      })
      return ok(this.publish())
    } finally {
      this.importing = false
    }
  }

  // -------------------------------------------------------------------------
  // Driving
  // -------------------------------------------------------------------------

  /**
   * Fire one cue by id and move the pointer to it.
   *
   * **The pointer moves even when the routed action failed.** A dead OBS or a missing slide file
   * must not wedge the operator at cue 7 of 40 with SPACE retrying the same broken cue forever;
   * they get a visible error and can keep walking the plan. `lastFired` is only set on success,
   * so the "now showing" readout never claims something reached the screen that did not.
   */
  async fireCue(cueId: string): Promise<Result<PlanState>> {
    if (this.disposed) return this.disposedError()

    const index = this.plan.cues.findIndex((cue) => cue.id === cueId)
    const cue = cueAt(this.plan, index)
    if (cue === null) {
      return err(ErrorCode.NOT_FOUND, 'there is no cue with that id in this plan', cueId)
    }
    return this.fireAt(index, cue)
  }

  /**
   * Fire the next cue and move on. The SPACE bar.
   *
   * Clamps at the end rather than wrapping: running off the end of the plan is a no-op with a
   * plain `NOT_FOUND`, never a jump back to the welcome slide with the congregation watching.
   */
  async advance(): Promise<Result<PlanState>> {
    if (this.disposed) return this.disposedError()

    const cue = nextCue(this.plan, this.position)
    if (cue === null) {
      return err(
        ErrorCode.NOT_FOUND,
        'this is the last cue in the plan',
        `${this.plan.cues.length} cues`
      )
    }
    return this.fireAt(this.position.index + 1, cue)
  }

  /**
   * Step the pointer back one cue — and fire NOTHING.
   *
   * This is the deliberate asymmetry with {@link advance}. Pressing back means "I did not mean
   * that", not "do it again": re-firing the previous cue would put a slide the operator has just
   * moved past back on the congregation screen, which is the opposite of an undo. For the same
   * reason it does not hide anything either — blanking the screen because someone tapped back is
   * worse than leaving the current slide up while they decide.
   *
   * Clamps at -1 (before the first cue) and never wraps to the end.
   */
  back(): Result<PlanState> {
    if (this.disposed) return this.disposedError()

    const previous = this.position
    this.position = stepBack(this.position)
    this.log.info('stepped back in the plan', {
      from: previous.index,
      to: this.position.index,
      fired: false
    })
    return ok(this.publish())
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Release subscribers. Leaves the overlay exactly as it is — quitting blanks nothing. */
  dispose(): void {
    this.disposed = true
    this.subscribers.clear()
    this.progressSubscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /** Fire the cue at `index`, then move the pointer there whatever the routing said. */
  private async fireAt(index: number, cue: Cue): Promise<Result<PlanState>> {
    const fired = await this.route(cue)

    this.position = movePositionTo(this.position, this.plan, index)
    if (fired.ok) {
      this.lastFired = cue
      this.log.info('fired a cue', { id: cue.id, type: cue.type, index, at: this.now() })
    } else {
      this.log.error('a cue did not fire; the plan pointer moved on anyway', {
        id: cue.id,
        type: cue.type,
        index,
        code: fired.error.code,
        message: fired.error.message,
        at: this.now()
      })
    }

    const state = this.publish()
    if (!fired.ok) return { ok: false, error: fired.error }
    return ok(state)
  }

  /** Route one cue to the subsystem that performs it. */
  private async route(cue: Cue): Promise<Result<void>> {
    switch (cue.type) {
      case 'slide':
        return this.fireSlide(cue)
      case 'lowerthird':
        return this.fireLowerThird(cue)
      case 'scripture':
        return this.fireScripture(cue)
      case 'scene':
        return this.fireScene(cue)
      case 'media':
        return this.fireMedia(cue)
      case 'action':
        return this.fireAction(cue)
      default: {
        // Exhaustiveness: adding a cue type without routing it fails to compile.
        const unreachable: never = cue.type
        return err(ErrorCode.INVALID_ARG, `unknown cue type "${String(unreachable)}"`)
      }
    }
  }

  /** An imported slide is an OPAQUE IMAGE (Standing Rule 4): a path in, a URL out, no text. */
  private fireSlide(cue: Cue): Result<void> {
    const payload = this.readPayload(cue, 'slide')
    if (!payload.ok) return payload

    const files = this.files
    if (files === null) return this.noFilesError('show a slide')

    const planPath = this.path
    if (planPath === null) {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'save the plan before showing slides — slide assets are resolved relative to the plan file',
        cue.id
      )
    }

    const url = this.attempt(
      () => files.assetUrl(planPath, this.plan, payload.value.asset),
      'the slide asset could not be resolved'
    )
    if (!url.ok) return url

    return this.sendOverlay({
      channel: 'command',
      name: 'slide.show',
      payload: { src: url.value }
    })
  }

  private fireLowerThird(cue: Cue): Result<void> {
    const payload = this.readPayload(cue, 'lowerthird')
    if (!payload.ok) return payload

    return this.sendOverlay({
      channel: 'command',
      name: 'lowerThird.show',
      payload: {
        line1: payload.value.line1,
        line2: payload.value.line2 ?? '',
        // The cue's template is a free string; the overlay's is a closed enum. An unrecognised
        // name falls back to `bar` rather than refusing the cue — a plain lower-third on screen
        // beats an error message and an empty screen.
        template: toLowerThirdTemplate(payload.value.template)
      }
    })
  }

  /**
   * Fire the scripture layer with the REFERENCE and an empty text.
   *
   * Standing Rule 4, enforced by the shape of the data: `ScripturePayload` has no `text` field,
   * so there is nothing to pass on. Phase 8 resolves verse text from a licensed API at fire time
   * and supplies the attribution its licence requires. Nothing here invents it.
   */
  private fireScripture(cue: Cue): Result<void> {
    const payload = this.readPayload(cue, 'scripture')
    if (!payload.ok) return payload

    return this.sendOverlay({
      channel: 'command',
      name: 'scripture.show',
      payload: {
        reference: payload.value.reference,
        text: '',
        translation: payload.value.translation ?? '',
        attribution: null
      }
    })
  }

  /**
   * Switch scenes.
   *
   * A payload naming one of the four camera slots (`cam1`, `cam2`, `wide`, `pulpit`) goes through
   * the camera service, so Verger's camera buttons and the plan agree about what is live. Any
   * other name is an OBS scene name and is sent straight to OBS — one allowlisted request.
   */
  private async fireScene(cue: Cue): Promise<Result<void>> {
    const payload = this.readPayload(cue, 'scene')
    if (!payload.ok) return payload

    const slot = toCameraSlot(payload.value.scene)
    if (slot !== null) {
      const selected = await this.attemptAsync(
        () => this.camera.select(slot),
        'the camera could not be switched'
      )
      return selected.ok ? ok(undefined) : selected
    }

    const called = await this.attemptAsync(
      () => this.obs.call(SET_PROGRAM_SCENE_REQUEST, { sceneName: payload.value.scene }),
      'OBS could not switch scenes'
    )
    return called.ok ? ok(undefined) : called
  }

  /**
   * Media cues, and the guard they run into.
   *
   * Playing an OBS media source needs `TriggerMediaInputAction`, which is NOT one of the seven
   * names on `ALLOWED_WRITE_REQUESTS`. Rather than assume, this asks the guard; when it says no,
   * the operator gets a precise explanation instead of a mysterious refusal from three layers
   * down. Widening that allowlist is a deliberate, separately reviewed change — Phase 6 does not
   * get to do it as a side effect of shipping media cues.
   */
  private async fireMedia(cue: Cue): Promise<Result<void>> {
    const payload = this.readPayload(cue, 'media')
    if (!payload.ok) return payload

    if (!this.isObsRequestAllowed(MEDIA_TRIGGER_REQUEST)) {
      const message =
        `media cues cannot fire: OBS request "${MEDIA_TRIGGER_REQUEST}" is not on Verger's OBS ` +
        'write allowlist, and widening that list is a deliberate reviewed change'
      this.log.warn(message, { cue: cue.id, request: MEDIA_TRIGGER_REQUEST })
      return err(
        ErrorCode.INVALID_ARG,
        message,
        'see ALLOWED_WRITE_REQUESTS in src/main/obs/ObsClient.ts'
      )
    }

    const inputName = payload.value.obsInputName
    if (inputName === undefined || inputName.trim() === '') {
      return err(
        ErrorCode.INVALID_ARG,
        'this media cue names no OBS media input to play',
        cue.id
      )
    }

    const called = await this.attemptAsync(
      () =>
        this.obs.call(MEDIA_TRIGGER_REQUEST, {
          inputName,
          mediaAction: MEDIA_RESTART_ACTION
        }),
      'OBS could not play the media input'
    )
    return called.ok ? ok(undefined) : called
  }

  private fireAction(cue: Cue): Result<void> {
    const payload = this.readPayload(cue, 'action')
    if (!payload.ok) return payload

    const name = ACTION_COMMANDS[payload.value.action.trim().toLowerCase()]
    if (name === undefined) {
      return err(
        ErrorCode.NOT_FOUND,
        `this plan uses an action Verger does not know: "${payload.value.action}"`,
        `known actions: ${[...new Set(Object.values(ACTION_COMMANDS))].join(', ')}`
      )
    }
    return this.sendOverlay({ channel: 'command', name, payload: {} })
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Narrow a cue's payload to the shape its type promises.
   *
   * `Cue` is not a discriminated union — `type` and `payload` are independent fields — so the
   * narrowing is done at runtime against `cuePayloadSchemas`, the same schemas `cueSchema` used
   * when the plan was validated. A mismatch here means something bypassed validation, and the cue
   * is refused rather than fired half-formed.
   */
  private readPayload<K extends CuePayloadKind>(cue: Cue, type: K): Result<CuePayloadFor<K>> {
    const schema: z.ZodType<unknown> = cuePayloadSchemas[type]
    const parsed = schema.safeParse(cue.payload)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return err(
        ErrorCode.INVALID_ARG,
        `cue "${cue.label}" does not carry a valid ${type} payload`,
        detail
      )
    }
    return ok(parsed.data as CuePayloadFor<K>)
  }

  /** Send an overlay command, discarding the returned state — the overlay owns that. */
  private sendOverlay(command: OverlayCommand): Result<void> {
    const sent = this.attempt(() => this.overlay.send(command), 'the overlay refused the command')
    return sent.ok ? ok(undefined) : sent
  }

  private snapshot(): PlanState {
    return {
      plan: this.plan,
      position: this.position,
      path: this.path,
      dirty: this.dirty,
      lastFired: this.lastFired
    }
  }

  /** Publish and return the new snapshot. A throwing subscriber never stops the others. */
  /**
   * Tell the overlay server which folder to serve slide images from.
   *
   * Called after every open and save, because the asset folder is resolved relative to the plan
   * file and therefore moves with it. When no plan is open the root is cleared to `null` so the
   * route 404s rather than serving last week's slides.
   *
   * Failures are swallowed and logged: an overlay server that is not running yet must not stop
   * the operator opening a plan.
   */
  private publishAssetRoot(): void {
    const setAssetRoot = this.overlay.setAssetRoot?.bind(this.overlay)
    if (setAssetRoot === undefined) return

    try {
      const path = this.path
      if (path === null) {
        setAssetRoot(null)
        return
      }
      const assetDir = resolveAssetDir(path, this.plan)
      setAssetRoot(assetDir.ok ? assetDir.value : null)
    } catch (cause) {
      this.log.warn('could not point the overlay at the plan asset folder', { cause })
    }
  }

  private publish(): PlanState {
    const snapshot = this.snapshot()
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('a plan state subscriber threw', { cause })
      }
    }
    return snapshot
  }

  /** Fan an import progress record out. A throwing subscriber never fails the import. */
  private publishProgress(progress: DeckImportProgress): void {
    for (const subscriber of [...this.progressSubscribers]) {
      try {
        subscriber(progress)
      } catch (cause) {
        this.log.warn('a deck import progress subscriber threw', { cause })
      }
    }
  }

  /** Run a synchronous seam, converting anything it throws into an `Err`. */
  private attempt<T>(operation: () => Result<T>, fallback: string): Result<T> {
    try {
      const result = operation()
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, fallback, 'the dependency did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  /** Run an asynchronous seam, converting anything it throws or rejects with into an `Err`. */
  private async attemptAsync<T>(
    operation: () => Promise<Result<T>>,
    fallback: string
  ): Promise<Result<T>> {
    try {
      const result = await operation()
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, fallback, 'the dependency did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  private noFilesError(what: string): Result<never> {
    return err(
      ErrorCode.NOT_CONFIGURED,
      `Verger cannot ${what}: this plan service was built with no filesystem access`
    )
  }

  private disposedError(): Result<never> {
    return err(ErrorCode.INTERNAL, 'the plan service has been disposed')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A camera slot id, or `null` when the name is an ordinary OBS scene name. */
export function toCameraSlot(scene: string): CameraSlot | null {
  const normalised = scene.trim().toLowerCase()
  return CAMERA_SLOTS.find((slot) => slot === normalised) ?? null
}

/** A known overlay template, or `bar` — never a refusal. */
export function toLowerThirdTemplate(template: string | undefined): LowerThirdTemplate {
  if (template === undefined) return 'bar'
  const normalised = template.trim().toLowerCase()
  return LOWER_THIRD_TEMPLATES.find((known) => known === normalised) ?? 'bar'
}

/**
 * Move the pointer to `index`, recording the cue there as passed.
 *
 * `firedCueIds` means "the pointer has been here", not "this definitely reached the screen" —
 * `PlanState.lastFired` is the honest record of what actually rendered.
 */
export function movePositionTo(
  position: PlanPosition,
  plan: ServicePlan,
  index: number
): PlanPosition {
  const cue = cueAt(plan, index)
  if (cue === null) return position
  // Reuse the contract's own step function for the common case, so the two can never disagree.
  if (index === position.index + 1) return advancePosition(plan, position)
  return {
    index,
    firedCueIds: position.firedCueIds.includes(cue.id)
      ? position.firedCueIds
      : [...position.firedCueIds, cue.id]
  }
}

/**
 * Keep a position meaningful after the plan was edited.
 *
 * The index is clamped into range and `firedCueIds` is filtered to cues that still exist, so a
 * deleted cue cannot leave the pointer past the end of the plan or the UI highlighting a row that
 * is no longer there.
 */
export function clampPosition(position: PlanPosition, plan: ServicePlan): PlanPosition {
  const ids = new Set(plan.cues.map((cue) => cue.id))
  const index = Math.min(position.index, plan.cues.length - 1)
  return {
    index: Math.max(index, -1),
    firedCueIds: position.firedCueIds.filter((id) => ids.has(id))
  }
}
