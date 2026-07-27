/**
 * The operator's caption switch.
 *
 * ## Why this is its own store and not part of `overlayStore`
 *
 * `overlayStore` mirrors the overlay's WIRE state — what is on screen. This holds an operator
 * INTENT that outlives any particular line of text: "captions are on for this service". The two
 * change at completely different rates. Caption text is replaced several times a second while
 * someone is speaking; the switch moves twice in a service. Folding them together would re-render
 * every caption control on every partial result.
 *
 * ## The switch is never optimistic
 *
 * {@link CaptionStoreState.setEnabled} does not touch local state before the main process answers,
 * and the truth it settles on is the pushed `caption:state` event, not the call's return value.
 * That is deliberate and it is the opposite of what feels responsive: this is a kill switch, and a
 * UI that flipped to Off the instant it was clicked would tell the operator the congregation screen
 * is clear at the exact moment we do not yet know that. The lag is the honesty.
 *
 * A failed call therefore leaves the switch where it was and surfaces `lastError`, rather than
 * leaving the UI and the driver disagreeing.
 */

import { create } from 'zustand'

import type { CaptionRuntimeState } from '@shared/caption'
import { idleCaptionState } from '@shared/caption'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/** Shown when the preload bridge is absent — jsdom, or a packaged build whose preload failed. */
export const CAPTION_BRIDGE_UNAVAILABLE_MESSAGE =
  'The caption driver is not reachable from this window.'

export interface CaptionStoreState {
  readonly state: CaptionRuntimeState
  /** False when the preload bridge is missing, which disables every caption control. */
  readonly bridgeAvailable: boolean
  readonly hydrated: boolean
  /** True while a switch call is in flight, so the control can show it is not yet settled. */
  readonly pending: boolean
  readonly lastError: AppError | null

  hydrate: () => Promise<void>
  /** Wire the push channel. Returns an unsubscribe — call it on unmount. */
  subscribe: () => Unsubscribe
  setEnabled: (enabled: boolean) => Promise<Result<CaptionRuntimeState>>
  setShowDrafts: (showDrafts: boolean) => Promise<Result<CaptionRuntimeState>>
  /** Flip the switch. What the keyboard shortcut and the bar button both call. */
  toggle: () => Promise<Result<CaptionRuntimeState>>
}

const noop: Unsubscribe = () => undefined

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: CAPTION_BRIDGE_UNAVAILABLE_MESSAGE }
}

/**
 * Run an operation against the bridge, turning every failure mode into an `Err`.
 *
 * Local rather than shared, matching every other store: a missing bridge and a rejected promise
 * both have to become a `Result`, because a renderer must not take a promise's word for the IPC
 * contract holding.
 */
async function callBridge<T>(
  operation: (api: VergerApi) => Promise<Result<T>>,
): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return { ok: false, error: bridgeUnavailableError() }
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

export const useCaptionStore = create<CaptionStoreState>()((set, get) => ({
  state: idleCaptionState(),
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  pending: false,
  lastError: null,

  hydrate: async () => {
    if (getVergerApi() === undefined) {
      set({
        state: idleCaptionState(),
        bridgeAvailable: false,
        hydrated: true,
        pending: false,
        lastError: bridgeUnavailableError(),
      })
      return
    }

    set({ bridgeAvailable: true })

    const result = await callBridge((bridge) => bridge.caption.getState())
    if (result.ok) {
      set({ state: result.value, hydrated: true, lastError: null })
      return
    }
    // Falls back to the resting state rather than keeping a stale one: OFF is both the safe reading
    // and the true one whenever the driver cannot be asked.
    set({ state: idleCaptionState(), hydrated: true, lastError: result.error })
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false, state: idleCaptionState() })
      return noop
    }

    // The single source of truth for what the switch reads. An idle-hide or a retraction inside the
    // driver arrives here exactly like an operator's own click — no separate path to drift apart.
    return api.caption.onState((state) => {
      set({ state, pending: false })
    })
  },

  setEnabled: async (enabled) => {
    if (getVergerApi() === undefined) {
      const error = bridgeUnavailableError()
      set({ bridgeAvailable: false, lastError: error })
      return { ok: false, error }
    }

    set({ pending: true })
    const result = await callBridge((bridge) => bridge.caption.setEnabled(enabled))
    if (result.ok) {
      // `pending` is cleared here as well as in the push listener: the event is the authority, but a
      // build where it never arrives must not leave the control stuck mid-flight forever.
      set({ state: result.value, pending: false, lastError: null })
    } else {
      set({ pending: false, lastError: result.error })
    }
    return result
  },

  setShowDrafts: async (showDrafts) => {
    if (getVergerApi() === undefined) {
      const error = bridgeUnavailableError()
      set({ bridgeAvailable: false, lastError: error })
      return { ok: false, error }
    }

    set({ pending: true })
    const result = await callBridge((bridge) => bridge.caption.setShowDrafts(showDrafts))
    if (result.ok) {
      set({ state: result.value, pending: false, lastError: null })
    } else {
      set({ pending: false, lastError: result.error })
    }
    return result
  },

  toggle: async () => get().setEnabled(!get().state.enabled),
}))

/**
 * Put the store back to its launch state. Test-only.
 *
 * Zustand stores are module singletons, so without this one test's switch position leaks into the
 * next — and "captions default to off" is precisely the invariant that would stop being tested.
 */
export function resetCaptionStore(): void {
  useCaptionStore.setState({
    state: idleCaptionState(),
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    pending: false,
    lastError: null,
  })
}
