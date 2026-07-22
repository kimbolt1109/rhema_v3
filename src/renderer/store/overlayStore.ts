/**
 * The renderer's view of the overlay layer.
 *
 * BLUEPRINT.md §6: the lower-third is its own LAYER, not a slide, and the overlay server — not
 * this store — owns the state. Everything here is a mirror of what the main process last
 * reported, exactly like `obsStore`. The store never predicts a layer's visibility: it sends a
 * command and waits for the resulting snapshot.
 *
 * **State-based, not event-based.** `src/shared/overlay.ts` explains why the wire carries full
 * {@link OverlayState} snapshots rather than show/hide events: an OBS browser source can be
 * reloaded or crash mid-service, and a reconnecting overlay must be able to re-render what should
 * be on screen from one message. That same property is what makes this store trivially correct —
 * every push replaces the whole state, so there is no local reduction to drift.
 *
 * Standing Rule 5 shapes the degradation path: `window.verger` is typed optional because under
 * vitest/jsdom, or when a packaged build's preload fails to load, it genuinely is absent. Nothing
 * here dereferences it without a check; a missing bridge settles into an explicitly flagged
 * *not running* {@link OverlayServerInfo} carrying a `lastError` the panel can explain, rather
 * than throwing.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { OverlayServerInfo, Unsubscribe, VergerApi } from '@shared/ipc'
import { LOOPBACK_ADDRESS, OVERLAY_SERVER_PORT, overlayPageUrl } from '@shared/net'
import type { OverlayCommand, OverlayState } from '@shared/overlay'
import { emptyOverlayState } from '@shared/overlay'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `overlay.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; the overlay server cannot be reached.'

/**
 * The resting server info before anything has been observed.
 *
 * `running: false` is the honest default — claiming a server is up before the main process has
 * said so is exactly the optimistic-light failure `App.tsx` refuses to ship. The `pageUrl` still
 * comes from `@shared/net`, the single source of truth for the address the server will bind, so
 * an operator can pre-configure the OBS browser source before Verger has finished starting.
 */
export function stoppedServerInfo(): OverlayServerInfo {
  return {
    running: false,
    host: LOOPBACK_ADDRESS,
    port: OVERLAY_SERVER_PORT,
    pageUrl: overlayPageUrl(),
    clients: 0,
    lastError: null,
  }
}

/** The same, but flagged with why it will never start: there is no bridge to start it. */
export function bridgeUnavailableServerInfo(): OverlayServerInfo {
  return { ...stoppedServerInfo(), lastError: OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE)
}

/**
 * Run an operation against the bridge, converting every failure mode into an `Err`.
 *
 * Both failure modes are covered: the bridge being absent, and the bridge rejecting (which the
 * IPC contract says cannot happen, but a renderer must not take a promise's word for it).
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
 * True when anything is currently on the congregation's screen.
 *
 * Used to decide whether "no overlays attached" is a warning or merely a fact: zero attached
 * browser sources while three layers claim to be visible means OBS's Overlays source is dead and
 * nothing the operator can see in this app is actually being rendered.
 */
export function anyLayerVisible(state: OverlayState): boolean {
  return state.lowerThird.visible || state.scripture.visible || state.slide.visible
}

export interface OverlayStoreState {
  /** The last snapshot the server broadcast. Never locally invented. */
  readonly state: OverlayState
  /** Server up/down, bind address, attached-overlay count. */
  readonly serverInfo: OverlayServerInfo
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a command round trip is in flight. */
  readonly sending: boolean
  /** The last refusal, kept so the panel can explain why a command did nothing. */
  readonly lastError: AppError | null

  /** Pull the current snapshot and server info from the main process. */
  hydrate: () => Promise<void>
  /**
   * Wire the push channels. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `useOverlayStore.subscribe`. Reach it via
   * `useOverlayStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  /** Send one command; resolves with the resulting snapshot. */
  send: (command: OverlayCommand) => Promise<Result<OverlayState>>
}

const noop: Unsubscribe = () => undefined

function initialServerInfo(): OverlayServerInfo {
  return getVergerApi() === undefined ? bridgeUnavailableServerInfo() : stoppedServerInfo()
}

export const useOverlayStore = create<OverlayStoreState>()((set) => ({
  state: emptyOverlayState(),
  serverInfo: initialServerInfo(),
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  sending: false,
  lastError: null,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        state: emptyOverlayState(),
        serverInfo: bridgeUnavailableServerInfo(),
        bridgeAvailable: false,
        hydrated: true,
        sending: false,
        lastError: {
          code: ErrorCode.NOT_CONFIGURED,
          message: OVERLAY_BRIDGE_UNAVAILABLE_MESSAGE,
        },
      })
      return
    }

    set({ bridgeAvailable: true })

    const snapshot = await callBridge((bridge) => bridge.overlay.getState())
    if (snapshot.ok) {
      set({ state: snapshot.value, lastError: null })
    } else {
      // A failed read is itself information. The last known snapshot is kept rather than blanked,
      // because blanking it here would tell the operator the screen is clear when it is not.
      set({ lastError: snapshot.error })
    }

    const info = await callBridge((bridge) => bridge.overlay.getServerInfo())
    if (info.ok) {
      set({ serverInfo: info.value, hydrated: true })
    } else {
      set({
        serverInfo: { ...stoppedServerInfo(), lastError: info.error.message },
        hydrated: true,
        lastError: info.error,
      })
    }
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false, serverInfo: bridgeUnavailableServerInfo() })
      return noop
    }

    const offState = api.overlay.onState((state) => {
      set({ state })
    })
    const offServerInfo = api.overlay.onServerInfo((serverInfo) => {
      set({ serverInfo })
    })

    return () => {
      offState()
      offServerInfo()
    }
  },

  send: async (command) => {
    set({ sending: true })
    const result = await callBridge((bridge) => bridge.overlay.send(command))
    if (result.ok) {
      set({ state: result.value, sending: false, lastError: null })
    } else {
      // A refused command has not moved the server, so the mirrored state is left exactly as it
      // was; only the explanation is recorded.
      set({ sending: false, lastError: result.error })
    }
    return result
  },
}))

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `sending: true` from one test silently breaks the next.
 */
export function resetOverlayStore(): void {
  useOverlayStore.setState({
    state: emptyOverlayState(),
    serverInfo: initialServerInfo(),
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    sending: false,
    lastError: null,
  })
}
