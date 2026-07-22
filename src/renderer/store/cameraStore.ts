/**
 * The renderer's view of the camera layer.
 *
 * BLUEPRINT.md §6: each camera is an OBS scene, and the four buttons map to
 * `SetCurrentProgramScene`. This store is the mirror of what the main process last observed — it
 * never predicts. Pressing CAM 2 does not optimistically light CAM 2 up; it asks, and the light
 * moves when OBS says the program scene moved. That matters because OBS is the engine (Standing
 * Rule 2): the operator can switch scenes in OBS itself, from a hotkey, or from a Stream Deck, and
 * `activeSlot` must reflect *reality*, including the reality that the live scene belongs to no
 * button at all (`activeSlot === null`).
 *
 * ## The independence guarantee
 *
 * Nothing in this file imports, reads, or writes overlay state, and `overlayStore.ts` does not
 * reference cameras. The two are separate mirrors of two separate state machines. `src/shared/
 * camera.ts` states the property; `CameraPanel.test.tsx` proves it at the control surface by
 * asserting that a camera switch produces **zero** overlay commands, and vice versa.
 *
 * Standing Rule 5 shapes the degradation path, exactly as in `obsStore` / `overlayStore`:
 * `window.verger` is typed optional because under vitest/jsdom, or when a packaged build's preload
 * fails to load, it genuinely is absent. Nothing here dereferences it without a check; a missing
 * bridge settles into an explicitly flagged state carrying an error the panel can explain, rather
 * than throwing.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { CameraBinding, CameraConfig, CameraSlot, CameraState } from '@shared/camera'
import { CAMERA_SLOTS, defaultCameraConfig, findBinding, isBindingUsable } from '@shared/camera'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `camera.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const CAMERA_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; camera switching is disabled.'

/** Nothing observed yet: no program scene, no active slot, no transitions listed. */
export function unknownCameraState(): CameraState {
  return { currentProgramScene: null, activeSlot: null, availableTransitions: [] }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, CAMERA_BRIDGE_UNAVAILABLE_MESSAGE)
}

/**
 * Run an operation against the bridge, converting every failure mode into an `Err`.
 *
 * Both failure modes are covered: the bridge being absent, and the bridge rejecting (which the IPC
 * contract says cannot happen, but a renderer must not take a promise's word for it).
 */
async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/**
 * One button's worth of derived truth, so the panel renders from data instead of from four
 * near-identical branches — and so "is this button live" and "may this button be pressed" are
 * decided once, in a unit-testable place, rather than inside JSX.
 */
export interface CameraButtonModel {
  readonly slot: CameraSlot
  /** The operator-configured label, or the slot's default when it has never been renamed. */
  readonly label: string
  /** The OBS scene this button selects, or `null` when nothing has been mapped yet. */
  readonly sceneName: string | null
  /** False when no scene is bound: the button is disabled and explains why. */
  readonly usable: boolean
  /** True when OBS's live program scene is this button's scene. */
  readonly live: boolean
}

/**
 * Project the configuration and the observed state into one row per button.
 *
 * Always returns exactly {@link CAMERA_SLOTS}.length rows, in slot order, even if the stored
 * configuration is short or scrambled — the booth must never be shown three buttons because a
 * config file lost one.
 */
export function cameraButtons(config: CameraConfig, state: CameraState): CameraButtonModel[] {
  return CAMERA_SLOTS.map((slot) => {
    const binding: CameraBinding | null = findBinding(config, slot)
    const sceneName = binding?.sceneName ?? null
    return {
      slot,
      label: binding?.label ?? slot,
      sceneName,
      usable: isBindingUsable(binding),
      // Compared against the *observed* program scene rather than against `activeSlot` alone, so
      // that a stale or partially-hydrated state can never light two buttons at once.
      live: state.activeSlot === slot && sceneName !== null,
    }
  })
}

export interface CameraStoreState {
  /** The slot → scene mapping, as last read from the main process. */
  readonly config: CameraConfig
  /** The last camera state observed by the main process. Never locally invented. */
  readonly state: CameraState
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a camera switch is in flight. */
  readonly selecting: boolean
  /** True while a configuration save is in flight. */
  readonly saving: boolean
  /** The last refusal, kept so the UI can explain why a press did nothing. */
  readonly lastError: AppError | null

  /** Pull the configuration and the live camera state from the main process. */
  hydrate: () => Promise<void>
  /**
   * Wire the push channel. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `useCameraStore.subscribe`. Reach it via
   * `useCameraStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  /** Switch the program camera. Resolves with the resulting camera state. */
  select: (slot: CameraSlot) => Promise<Result<CameraState>>
  /** Persist a new slot → scene mapping. Resolves with the stored configuration. */
  setConfig: (config: CameraConfig) => Promise<Result<CameraConfig>>
}

const noop: Unsubscribe = () => undefined

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: CAMERA_BRIDGE_UNAVAILABLE_MESSAGE }
}

export const useCameraStore = create<CameraStoreState>()((set) => ({
  config: defaultCameraConfig(),
  state: unknownCameraState(),
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  selecting: false,
  saving: false,
  lastError: null,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        config: defaultCameraConfig(),
        state: unknownCameraState(),
        bridgeAvailable: false,
        hydrated: true,
        selecting: false,
        saving: false,
        lastError: bridgeUnavailableError(),
      })
      return
    }

    set({ bridgeAvailable: true })

    const config = await callBridge((bridge) => bridge.camera.getConfig())
    if (config.ok) {
      set({ config: config.value, lastError: null })
    } else {
      // A failed read is itself information. The last known mapping is kept rather than blanked:
      // blanking it would disable all four buttons and tell the operator nothing is mapped when
      // something is.
      set({ lastError: config.error })
    }

    const state = await callBridge((bridge) => bridge.camera.getState())
    if (state.ok) {
      set({ state: state.value, hydrated: true })
    } else {
      set({ hydrated: true, lastError: state.error })
    }
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false, state: unknownCameraState() })
      return noop
    }

    // One channel, one listener. A scene switched inside OBS arrives here exactly like one this
    // app asked for — there is no "our switch" vs "their switch" path to drift apart.
    return api.camera.onState((state) => {
      set({ state, selecting: false })
    })
  },

  select: async (slot) => {
    set({ selecting: true })
    const result = await callBridge((bridge) => bridge.camera.select(slot))
    if (result.ok) {
      set({ state: result.value, selecting: false, lastError: null })
    } else {
      // A refused switch has not moved OBS, so the mirrored state is left exactly as it was; only
      // the explanation is recorded. Lighting the requested button here would tell the operator a
      // camera is live when the old one still is.
      set({ selecting: false, lastError: result.error })
    }
    return result
  },

  setConfig: async (config) => {
    set({ saving: true })
    const result = await callBridge((bridge) => bridge.camera.setConfig(config))
    if (result.ok) {
      set({ config: result.value, saving: false, lastError: null })
    } else {
      set({ saving: false, lastError: result.error })
    }
    return result
  },
}))

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `selecting: true` from one test silently breaks the next.
 */
export function resetCameraStore(): void {
  useCameraStore.setState({
    config: defaultCameraConfig(),
    state: unknownCameraState(),
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    selecting: false,
    saving: false,
    lastError: null,
  })
}
