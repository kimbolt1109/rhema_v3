/**
 * The renderer's view of YouTube Live.
 *
 * BLUEPRINT.md §5 and `src/shared/youtube.ts`: the main process owns OAuth, the broadcast and the
 * persistent ingest stream; this store is a mirror of the last {@link YouTubeStatus} it reported.
 * Nothing here predicts. Pressing "Sign in" does not flip the readout to `signed-in`; it asks, and
 * the readout moves when the main process says it moved. The operator has to be able to trust the
 * "connected as <channel>" line absolutely — it is the only thing standing between them and
 * broadcasting a service to the wrong Google account.
 *
 * ## The resting state is `not-configured`, and that is not an error
 *
 * With no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` there is no OAuth client, so there
 * is nothing to sign into. Standing Rule 5: that is a resting state. This store settles into it
 * quietly, every action returns an `Err` rather than throwing, and the rest of the app is
 * untouched. The same path covers `window.verger` being absent entirely (jsdom, or a packaged
 * build whose preload failed to load) — see `obsStore` / `cameraStore` for the same shape.
 *
 * ## What is deliberately absent
 *
 * There is no stream key here, and there is no field to put one in. `PersistentStream` omits it on
 * purpose: it is a credential that lets anyone broadcast to the channel, it belongs in OBS's own
 * settings, and it must never cross IPC into the renderer or reach a log line. If a future change
 * makes a key appear in this file, that change is wrong.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'
import type {
  Broadcast,
  BroadcastTemplate,
  PreflightIssue,
  YouTubeAuthState,
  YouTubeStatus,
} from '@shared/youtube'
import { defaultBroadcastTemplate } from '@shared/youtube'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `youtube.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const YOUTUBE_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; YouTube control is disabled.'

/**
 * The status to show when nothing has been observed yet.
 *
 * `not-configured` rather than `signed-out`, because "signed out" implies there is something to
 * sign into. Until the main process says otherwise, we do not know that there is.
 */
export function unknownYouTubeStatus(): YouTubeStatus {
  return {
    auth: { state: 'not-configured', channel: null, lastError: null },
    broadcast: null,
    stream: null,
    template: defaultBroadcastTemplate(),
    preflight: [],
  }
}

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: YOUTUBE_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, YOUTUBE_BRIDGE_UNAVAILABLE_MESSAGE)
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

/** Pre-flight split into the two things the operator has to treat differently. */
export interface PreflightSummary {
  /** Blocks GO LIVE (Phase 5). Must be fixed, not acknowledged. */
  readonly errors: readonly PreflightIssue[]
  /** Shown and ignorable — but shown, because "ignorable" is the operator's call, not ours. */
  readonly warnings: readonly PreflightIssue[]
  /** True when at least one error is present. */
  readonly blocking: boolean
}

/**
 * Split pre-flight issues by severity.
 *
 * A pure function rather than three inline `.filter()` calls in JSX, so the rule "an error blocks,
 * a warning does not" is decided once and is unit-testable on its own.
 */
export function summarisePreflight(issues: readonly PreflightIssue[]): PreflightSummary {
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  return { errors, warnings, blocking: errors.length > 0 }
}

/**
 * Whether the operator can meaningfully act on this screen.
 *
 * `not-configured` is the only state in which the controls are switched off wholesale; every other
 * state at least lets them sign in or out.
 */
export function isYouTubeConfigured(state: YouTubeAuthState): boolean {
  return state !== 'not-configured'
}

export interface YouTubeStoreState {
  /** The last status observed by the main process. Never locally invented. */
  readonly status: YouTubeStatus
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link YouTubeStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a sign-in or sign-out is in flight. */
  readonly authorizing: boolean
  /** True while a template save is in flight. */
  readonly saving: boolean
  /** True while a broadcast is being created and bound. */
  readonly creating: boolean
  /** The last refusal, kept so the UI can explain why a press did nothing. */
  readonly lastError: AppError | null

  /** Pull the whole status from the main process. */
  hydrate: () => Promise<void>
  /**
   * Wire the push channel. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `useYouTubeStore.subscribe`. Reach it via
   * `useYouTubeStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  /** Run the loopback OAuth consent flow. Silent on later launches. */
  signIn: () => Promise<Result<YouTubeStatus>>
  /** Forget the stored refresh token. */
  signOut: () => Promise<Result<YouTubeStatus>>
  /** Persist the weekly template. */
  setTemplate: (template: BroadcastTemplate) => Promise<Result<YouTubeStatus>>
  /** Create the broadcast and bind the persistent stream. Does NOT go live — that is Phase 5. */
  createBroadcast: (options?: { scheduledStartTime?: string }) => Promise<Result<Broadcast>>
}

const noop: Unsubscribe = () => undefined

export const useYouTubeStore = create<YouTubeStoreState>()((set, get) => ({
  status: unknownYouTubeStatus(),
  bridgeAvailable: getVergerApi() !== undefined,
  hydrated: false,
  authorizing: false,
  saving: false,
  creating: false,
  lastError: null,

  hydrate: async () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({
        status: unknownYouTubeStatus(),
        bridgeAvailable: false,
        hydrated: true,
        authorizing: false,
        saving: false,
        creating: false,
        lastError: bridgeUnavailableError(),
      })
      return
    }

    set({ bridgeAvailable: true })

    const status = await callBridge((bridge) => bridge.youtube.getStatus())
    if (status.ok) {
      set({ status: status.value, hydrated: true, lastError: null })
    } else {
      // A failed read is itself information. The last known status is kept rather than blanked:
      // blanking it would claim the operator is signed out when they may not be.
      set({ hydrated: true, lastError: status.error })
    }
  },

  subscribe: () => {
    const api = getVergerApi()
    if (api === undefined) {
      set({ bridgeAvailable: false, status: unknownYouTubeStatus() })
      return noop
    }

    return api.youtube.onStatus((status) => {
      // Any pushed status ends whatever was in flight: the main process has settled.
      set({ status, authorizing: status.auth.state === 'authorizing' })
    })
  },

  signIn: async () => {
    set({ authorizing: true })
    const result = await callBridge((bridge) => bridge.youtube.signIn())
    if (result.ok) {
      set({ status: result.value, authorizing: false, lastError: null })
    } else {
      set({ authorizing: false, lastError: result.error })
    }
    return result
  },

  signOut: async () => {
    set({ authorizing: true })
    const result = await callBridge((bridge) => bridge.youtube.signOut())
    if (result.ok) {
      set({ status: result.value, authorizing: false, lastError: null })
    } else {
      set({ authorizing: false, lastError: result.error })
    }
    return result
  },

  setTemplate: async (template) => {
    set({ saving: true })
    const result = await callBridge((bridge) => bridge.youtube.setTemplate(template))
    if (result.ok) {
      set({ status: result.value, saving: false, lastError: null })
    } else {
      // A refused save has not changed what the main process holds, so the mirrored template is
      // left exactly as it was; only the explanation is recorded.
      set({ saving: false, lastError: result.error })
    }
    return result
  },

  createBroadcast: async (options) => {
    set({ creating: true })
    // `exactOptionalPropertyTypes` is on: pass the key only when there is a value for it.
    const request =
      options?.scheduledStartTime === undefined
        ? {}
        : { scheduledStartTime: options.scheduledStartTime }

    const result = await callBridge((bridge) => bridge.youtube.createBroadcast(request))
    if (result.ok) {
      // Adopting the returned broadcast is reporting, not predicting: this is the broadcast
      // YouTube actually created, handed back by the main process.
      set({ status: { ...get().status, broadcast: result.value }, creating: false, lastError: null })
    } else {
      set({ creating: false, lastError: result.error })
    }
    return result
  },
}))

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `authorizing: true` from one test silently breaks the next.
 */
export function resetYouTubeStore(): void {
  useYouTubeStore.setState({
    status: unknownYouTubeStatus(),
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    authorizing: false,
    saving: false,
    creating: false,
    lastError: null,
  })
}
