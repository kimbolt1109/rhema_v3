/**
 * The renderer's view of OBS.
 *
 * Standing Rule 2 shapes this whole module: OBS is the engine, Verger is a convenience layer.
 * Nothing here is a *desired* state — every field is the last thing the main process observed and
 * pushed over IPC. The store never predicts, and it never writes a status it did not receive.
 *
 * Standing Rule 5 shapes the other half: `window.verger` is typed as **optional** in
 * `src/shared/ipc.ts` because under vitest/jsdom, or if the preload fails to load in a packaged
 * build, it genuinely is absent. Every action here therefore checks for the bridge and returns an
 * `Err` instead of throwing on `undefined.obs`. A missing bridge settles the store into an
 * explicitly flagged `not-configured` state carrying a `NOT_CONFIGURED` error the UI can explain,
 * which is exactly the "degrade, never crash" behaviour the rule demands.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { ObsConfig } from '@shared/config'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { ObsConnectionConfig, ObsSceneList, ObsStatus } from '@shared/obs'
import { initialObsStatus } from '@shared/obs'
import type { Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `connection.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; OBS control is disabled.'

/** The bridge, or `undefined` under jsdom / a failed preload. Never throws. */
export function getVergerApi(): VergerApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.verger
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, BRIDGE_UNAVAILABLE_MESSAGE)
}

/**
 * The resting status when there is no bridge at all.
 *
 * `not-configured` rather than `disconnected`, because nothing was ever configured *or* dialled —
 * and `lastError` is populated so the UI can say *why* it is not configured rather than leaving
 * the operator to guess whether they forgot a setting.
 */
export function bridgeUnavailableStatus(now: number): ObsStatus {
  return {
    ...initialObsStatus('not-configured', now),
    lastError: { code: ErrorCode.NOT_CONFIGURED, message: BRIDGE_UNAVAILABLE_MESSAGE },
  }
}

/**
 * Run an operation against the bridge, converting every failure mode into an `Err`.
 *
 * Both failure modes are covered: the bridge being absent, and the bridge rejecting (which the
 * IPC contract says cannot happen, but a renderer must not take a promise's word for it).
 */
async function callBridge<T>(
  operation: (api: VergerApi) => Promise<Result<T>>,
): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

export interface ObsStoreState {
  /** The last status observed by the main process. Never locally invented. */
  readonly status: ObsStatus
  /** `null` until OBS has reported a scene list at least once. */
  readonly sceneList: ObsSceneList | null
  /** True while a connect / disconnect / set-config round trip is in flight. */
  readonly connecting: boolean
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link hydrate} has completed at least once. */
  readonly hydrated: boolean

  /** Pull the current status and scene list from the main process. */
  hydrate: () => Promise<void>
  /**
   * Wire the push channels. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `useObsStore.subscribe`. Reach it via
   * `useObsStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  connect: (config: ObsConnectionConfig) => Promise<Result<ObsStatus>>
  disconnect: () => Promise<Result<ObsStatus>>
  setConfig: (config: ObsConfig) => Promise<Result<ObsStatus>>
}

const noop: Unsubscribe = () => undefined

export const useObsStore = create<ObsStoreState>()((set, get) => ({
  status: bridgeUnavailableStatus(Date.now()),
  sceneList: null,
  connecting: false,
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        status: bridgeUnavailableStatus(Date.now()),
        sceneList: null,
        connecting: false,
        bridgeAvailable: false,
        hydrated: true,
      })
      return
    }

    set({ bridgeAvailable: true })

    const status = await callBridge((bridge) => bridge.obs.getStatus())
    if (status.ok) {
      set({ status: status.value })
    } else {
      // A failed status read is itself information: surface it in `lastError` rather than
      // silently keeping a stale status the operator would then trust.
      set((state) => ({ status: { ...state.status, lastError: status.error } }))
    }

    // A scene list is only meaningful while connected; a `NOT_CONNECTED` error here is the
    // expected answer, not a fault, so it clears the list rather than raising anything.
    const sceneList = await callBridge((bridge) => bridge.obs.getSceneList())
    set({ sceneList: sceneList.ok ? sceneList.value : null, hydrated: true })
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false, status: bridgeUnavailableStatus(Date.now()) })
      return noop
    }

    const offStatus = api.obs.onStatus((status) => {
      // Any terminal-ish status ends an in-flight request; leaving `connecting` true would
      // strand the Connect button disabled for the rest of the service.
      const settled = status.state !== 'connecting'
      set(settled ? { status, connecting: false } : { status })
    })

    const offSceneList = api.obs.onSceneList((sceneList) => {
      set({ sceneList })
    })

    return () => {
      offStatus()
      offSceneList()
    }
  },

  connect: async (config) => {
    set({ connecting: true })
    const result = await callBridge((bridge) => bridge.obs.connect(config))
    applyResult(set, get, result)
    return result
  },

  disconnect: async () => {
    set({ connecting: true })
    const result = await callBridge((bridge) => bridge.obs.disconnect())
    applyResult(set, get, result)
    return result
  },

  setConfig: async (config) => {
    set({ connecting: true })
    const result = await callBridge((bridge) => bridge.obs.setConfig(config))
    applyResult(set, get, result)
    return result
  },
}))

type SetState = (partial: Partial<ObsStoreState>) => void
type GetState = () => ObsStoreState

/**
 * Fold a command's `Result<ObsStatus>` into the store.
 *
 * On success the returned status replaces the current one. On failure the *state* is left alone —
 * the main process owns state transitions, and a rejected command has not changed OBS — but the
 * error is attached so the screen can explain the refusal.
 */
function applyResult(set: SetState, get: GetState, result: Result<ObsStatus>): void {
  if (result.ok) {
    set({ status: result.value, connecting: false })
    return
  }
  set({ status: { ...get().status, lastError: result.error }, connecting: false })
}

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `connecting: true` from one test silently breaks the next.
 */
export function resetObsStore(): void {
  useObsStore.setState({
    status: bridgeUnavailableStatus(Date.now()),
    sceneList: null,
    connecting: false,
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
  })
}
