/**
 * The camera contract.
 *
 * BLUEPRINT.md §6: each camera is an OBS scene, and the app has plain buttons — CAM 1 / CAM 2 /
 * WIDE / PULPIT — mapped to `SetCurrentProgramScene`. Transitions are configured once in OBS and
 * reused, so Verger picks a transition by NAME and never defines one.
 *
 * ## The independence guarantee
 *
 * Switching cameras must not touch overlay state, and showing an overlay must not touch the
 * camera. Nothing in this module references the overlay, and nothing in `src/shared/overlay.ts`
 * references cameras — the two are separate state machines that never read each other. That is
 * the property tested at both the service level and the UI level.
 *
 * Node-global free.
 */

import { z } from 'zod'

/**
 * The four camera buttons.
 *
 * Fixed rather than user-extensible on purpose. BLUEPRINT.md names exactly these, and a
 * one-operator booth wants four big unambiguous targets, not an arbitrary list to hunt through
 * mid-service. Which OBS scene each one selects IS configurable — see {@link CameraBinding}.
 */
export const CAMERA_SLOTS = ['cam1', 'cam2', 'wide', 'pulpit'] as const

/** Union of the camera slot ids. */
export type CameraSlot = (typeof CAMERA_SLOTS)[number]

/** Default operator-facing labels. Overridable, and translated in the UI. */
export const DEFAULT_CAMERA_LABELS: Readonly<Record<CameraSlot, string>> = {
  cam1: 'CAM 1',
  cam2: 'CAM 2',
  wide: 'WIDE',
  pulpit: 'PULPIT',
}

/**
 * One button's mapping.
 *
 * `sceneName` is `null` until the operator picks a scene in settings — an unmapped button is
 * disabled and says so, rather than firing a request for a scene that does not exist.
 * `transition` is `null` to mean "use whatever OBS's current transition is", which is the right
 * default: the operator has already configured that once in OBS.
 */
export interface CameraBinding {
  readonly slot: CameraSlot
  readonly label: string
  readonly sceneName: string | null
  readonly transition: string | null
  /** Transition duration in ms. `null` uses OBS's configured duration. */
  readonly transitionDurationMs: number | null
}

/** The whole camera configuration. */
export interface CameraConfig {
  readonly bindings: readonly CameraBinding[]
}

/** Live camera state, as observed from OBS. */
export interface CameraState {
  /** OBS's current program scene, whatever set it — Verger, OBS's own UI, or a hotkey. */
  readonly currentProgramScene: string | null
  /**
   * Which slot corresponds to the live scene, or `null` when the live scene is not one Verger
   * has a button for. That happens routinely: the operator can switch scenes in OBS directly,
   * and Verger must reflect it rather than pretend a button is active.
   */
  readonly activeSlot: CameraSlot | null
  /** Transitions available in OBS, for the settings picker. */
  readonly availableTransitions: readonly string[]
}

/** Validation for a single binding. */
export const cameraBindingSchema = z.object({
  slot: z.enum(CAMERA_SLOTS),
  label: z.string().min(1).max(24),
  sceneName: z.string().max(200).nullable(),
  transition: z.string().max(200).nullable(),
  transitionDurationMs: z.number().int().min(0).max(20_000).nullable(),
})

/** Validation for the whole configuration. */
export const cameraConfigSchema = z.object({
  bindings: z.array(cameraBindingSchema).max(CAMERA_SLOTS.length),
})

/** An unconfigured camera set: four labelled buttons, no scenes bound yet. */
export function defaultCameraConfig(): CameraConfig {
  return {
    bindings: CAMERA_SLOTS.map((slot) => ({
      slot,
      label: DEFAULT_CAMERA_LABELS[slot],
      sceneName: null,
      transition: null,
      transitionDurationMs: null,
    })),
  }
}

/** Look up a binding by slot. */
export function findBinding(config: CameraConfig, slot: CameraSlot): CameraBinding | null {
  return config.bindings.find((binding) => binding.slot === slot) ?? null
}

/**
 * Which slot, if any, maps to the given live scene.
 *
 * Returns `null` when the scene is not bound to a button — see {@link CameraState.activeSlot}.
 */
export function slotForScene(config: CameraConfig, sceneName: string | null): CameraSlot | null {
  if (sceneName === null) return null
  return config.bindings.find((binding) => binding.sceneName === sceneName)?.slot ?? null
}

/** Whether a slot can be fired: it must have a scene bound. */
export function isBindingUsable(binding: CameraBinding | null): boolean {
  return binding !== null && binding.sceneName !== null && binding.sceneName.length > 0
}
