/**
 * The renderer's view of the cue engine.
 *
 * `src/shared/cue.ts` and `src/shared/scripture.ts` are the contract; this store mirrors the last
 * {@link CueEngineState} and {@link CueEngineSettings} the main process reported and resolves the
 * verse text for whatever scripture suggestion is currently pending.
 *
 * ## What this store may and may not do
 *
 * The engine lives in the main process and it never writes authoritative state — it emits an
 * INTENT. This store is one step further out still: it is a **mirror plus two safe local
 * overrides**, and the direction of those overrides is the whole design.
 *
 * 1. **A veto is applied locally, immediately.** {@link CueStoreState.dismiss} and
 *    {@link CueStoreState.panic} clear `pending` (and, for panic, set `panicked`) before the round
 *    trip resolves. Both moves are strictly *safer* than the state they replace, so applying them
 *    optimistically can only ever reduce what automation does. If the call then fails, the local
 *    halt **stays** and the error is reported: automation may never come back because a message
 *    was lost.
 * 2. **Nothing is ever made more dangerous locally.** {@link CueStoreState.confirm} does not
 *    pre-apply anything, `panicked` is never cleared except by an explicit
 *    {@link CueStoreState.resume} that the main process acknowledged, and no code path here
 *    invents a `pending` suggestion.
 *
 * ## The resolution race
 *
 * Verse text is fetched per pending suggestion, asynchronously. A resolution that arrives after the
 * suggestion it belongs to has been superseded is **dropped** ({@link CueStoreState.resolvedFor}
 * guards it). Letting a late answer attach itself to the current suggestion would put the previous
 * reference's text under the current reference's heading — an invisible failure that ends up on the
 * congregation screen.
 *
 * ## Standing Rule 4
 *
 * Nothing in this file contains, embeds or derives verse text. It holds a {@link ResolvedScripture}
 * handed to it at runtime, and when there is none it says so.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type {
  CueEngineSettings,
  CueEngineState,
  CueSuggestion,
  TrustMode,
} from '@shared/cue'
import { defaultCueEngineSettings, idleCueEngineState, shouldAutoFire } from '@shared/cue'
import type { Unsubscribe, VergerApi } from '@shared/ipc'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'
import type { ResolvedScripture, ScriptureReference } from '@shared/scripture'
import { canAutoShow } from '@shared/scripture'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `cue.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const CUE_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; the cue engine is not running.'

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: CUE_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, CUE_BRIDGE_UNAVAILABLE_MESSAGE)
}

async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/* ------------------------------ pure helpers, unit-testable ------------------------------ */

/** How the panel should describe the state of a pending suggestion's verse text. */
export type ScriptureResolution =
  /** Not a scripture suggestion — there is nothing to resolve. */
  | 'not-scripture'
  /** A provider has been asked and has not answered yet. */
  | 'resolving'
  /** Text is in hand and non-empty. */
  | 'resolved'
  /** Asked and refused, or answered with nothing. The card must say so and must not auto-show. */
  | 'unavailable'

/**
 * Whether a pending suggestion may fire itself right now.
 *
 * Deliberately **not** just `shouldAutoFire`. That function answers "does the mode and the
 * suggestion's own flag permit it"; this one additionally re-applies the scripture gate on the
 * renderer's side, using the text this store actually holds. Both have to agree, and where they
 * disagree the safer answer wins — a cue may always be made safer than the service default, never
 * more dangerous.
 */
export function willAutoFire(
  suggestion: CueSuggestion | null,
  mode: TrustMode,
  panicked: boolean,
  resolved: ResolvedScripture | null,
): boolean {
  if (suggestion === null) return false
  if (!shouldAutoFire(suggestion, mode, panicked)) return false
  if (suggestion.reference === null) return true
  // A confident reference whose text never arrived would auto-show an empty scripture card, and
  // the operator would not find out until somebody in the congregation told them.
  return canAutoShow(suggestion.reference, resolved)
}

/** Classify a pending suggestion's verse text for the UI. See {@link ScriptureResolution}. */
export function classifyResolution(
  suggestion: CueSuggestion | null,
  resolved: ResolvedScripture | null,
  resolving: boolean,
): ScriptureResolution {
  if (suggestion === null || suggestion.reference === null) return 'not-scripture'
  if (resolving) return 'resolving'
  if (resolved !== null && resolved.text.trim().length > 0) return 'resolved'
  return 'unavailable'
}

/* ---------------------------------------- the store ---------------------------------------- */

export interface CueStoreState {
  /** The last engine state the main process reported, plus the two safe local halts. */
  readonly state: CueEngineState
  readonly settings: CueEngineSettings
  /** Verse text for the pending suggestion, or null. Never authored here (Standing Rule 4). */
  readonly resolved: ResolvedScripture | null
  /** Which suggestion {@link CueStoreState.resolved} belongs to. Guards the resolution race. */
  readonly resolvedFor: string | null
  readonly resolving: boolean
  /** Why the text could not be fetched, for the "text unavailable" explanation. */
  readonly resolveError: AppError | null
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link CueStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while a confirm/dismiss/mode round trip is in flight. */
  readonly busy: boolean
  readonly lastError: AppError | null

  hydrate: () => Promise<void>
  /** Wire the two push channels. Returns an unsubscribe — call it on unmount. */
  subscribe: () => Unsubscribe
  /** The trust dial. */
  setMode: (mode: TrustMode) => Promise<Result<CueEngineState>>
  /** Accept the pending suggestion (Y / pedal). Defaults to whatever is pending. */
  confirm: (suggestionId?: string) => Promise<Result<CueEngineState>>
  /** Reject it (N). Applied locally first — a veto is never allowed to wait on a round trip. */
  dismiss: (suggestionId?: string) => Promise<Result<CueEngineState>>
  /** Master switch. Halts automation and touches nothing else. */
  panic: () => Promise<Result<CueEngineState>>
  /** Re-engage automation. Explicit by construction — nothing else clears `panicked`. */
  resume: () => Promise<Result<CueEngineState>>
  setSettings: (settings: CueEngineSettings) => Promise<Result<CueEngineSettings>>
  /** Fold a pushed suggestion in. Exposed so the panel and tests share one path. */
  ingestSuggestion: (suggestion: CueSuggestion) => void
}

const noop: Unsubscribe = () => undefined

function initialState(): Omit<
  CueStoreState,
  | 'hydrate'
  | 'subscribe'
  | 'setMode'
  | 'confirm'
  | 'dismiss'
  | 'panic'
  | 'resume'
  | 'setSettings'
  | 'ingestSuggestion'
> {
  return {
    state: idleCueEngineState(),
    settings: defaultCueEngineSettings(),
    resolved: null,
    resolvedFor: null,
    resolving: false,
    resolveError: null,
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    busy: false,
    lastError: null,
  }
}

export const useCueStore = create<CueStoreState>()((set, get) => {
  /**
   * Fetch verse text for a pending scripture suggestion.
   *
   * Fire-and-forget on purpose: the panel renders the reference and the "fetching" state
   * immediately, because a reference the operator can read is useful a second before its text is.
   */
  const resolveFor = (suggestion: CueSuggestion): void => {
    const reference: ScriptureReference | null = suggestion.reference
    if (reference === null) {
      set({ resolved: null, resolvedFor: suggestion.id, resolving: false, resolveError: null })
      return
    }

    set({ resolved: null, resolvedFor: suggestion.id, resolving: true, resolveError: null })

    void callBridge((bridge) =>
      bridge.cue.resolveScripture({ reference, translation: get().settings.translation }),
    ).then((result) => {
      // The guard is the point. A resolution for a superseded suggestion must be dropped, not
      // shown under the current reference's heading.
      if (get().resolvedFor !== suggestion.id) return
      if (result.ok) {
        set({ resolved: result.value, resolving: false, resolveError: null })
      } else {
        set({ resolved: null, resolving: false, resolveError: result.error })
      }
    })
  }

  /** Adopt an engine state the main process handed back, and chase its pending suggestion's text. */
  const adopt = (next: CueEngineState): void => {
    const previous = get()
    set({ state: next })

    if (next.pending === null) {
      set({ resolved: null, resolvedFor: null, resolving: false, resolveError: null })
      return
    }
    // Already resolved (or resolving) for exactly this suggestion — do not re-ask.
    if (previous.resolvedFor === next.pending.id) return
    resolveFor(next.pending)
  }

  /** Run one engine call, adopting its answer and never blanking the mirror on refusal. */
  const run = async (
    operation: (api: VergerApi) => Promise<Result<CueEngineState>>,
  ): Promise<Result<CueEngineState>> => {
    set({ busy: true })
    const result = await callBridge(operation)
    if (result.ok) {
      adopt(result.value)
      set({ busy: false, lastError: null })
    } else {
      // The mirrored state is kept exactly as it was: a refused call is not evidence that the
      // engine changed its mind.
      set({ busy: false, lastError: result.error })
    }
    return result
  }

  return {
    ...initialState(),

    hydrate: async () => {
      const api = getVergerApi()
      if (api === undefined) {
        set({
          ...initialState(),
          bridgeAvailable: false,
          hydrated: true,
          lastError: bridgeUnavailableError(),
        })
        return
      }

      set({ bridgeAvailable: true })

      const [state, settings] = await Promise.all([
        callBridge((bridge) => bridge.cue.getState()),
        callBridge((bridge) => bridge.cue.getSettings()),
      ])

      if (settings.ok) set({ settings: settings.value })
      if (state.ok) adopt(state.value)

      const failure = !state.ok ? state.error : !settings.ok ? settings.error : null
      set({ hydrated: true, lastError: failure })
    },

    subscribe: () => {
      const api = getVergerApi()
      if (api === undefined) {
        set({ bridgeAvailable: false })
        return noop
      }

      const offState = api.cue.onState((next) => {
        adopt(next)
      })
      const offSuggestion = api.cue.onSuggestion((suggestion) => {
        get().ingestSuggestion(suggestion)
      })

      return () => {
        offState()
        offSuggestion()
      }
    },

    ingestSuggestion: (suggestion) => {
      // A suggestion arriving while panicked is recorded but never made pending. Panic means the
      // engine is not offering anything, and a card appearing after a PANIC would read as automation
      // coming back on its own.
      if (get().state.panicked) return
      adopt({ ...get().state, pending: suggestion })
    },

    setMode: async (mode) => run((bridge) => bridge.cue.setMode({ mode })),

    confirm: async (suggestionId) => {
      const pending = get().state.pending
      const id = suggestionId ?? pending?.id
      if (id === undefined) {
        // Nothing to accept. Refused here rather than at the boundary so a stray Y keypress cannot
        // become a request the main process has to guess the meaning of.
        const refusal = err(ErrorCode.NOT_FOUND, 'there is no pending suggestion to confirm')
        set({ lastError: refusal.error })
        return refusal
      }
      // Deliberately NOT optimistic. Confirming makes something happen on the congregation screen,
      // and the UI must not claim it happened until the main process says it did.
      return run((bridge) => bridge.cue.confirm({ suggestionId: id }))
    },

    dismiss: async (suggestionId) => {
      const before = get().state
      const id = suggestionId ?? before.pending?.id
      if (id === undefined) {
        const refusal = err(ErrorCode.NOT_FOUND, 'there is no pending suggestion to dismiss')
        set({ lastError: refusal.error })
        return refusal
      }

      // Applied locally first: a veto that waits for a round trip is not a veto. Clearing `pending`
      // can only ever make the console do less, so it is safe to do before the answer arrives.
      set({
        state: { ...before, pending: null },
        resolved: null,
        resolvedFor: null,
        resolving: false,
        resolveError: null,
      })
      return run((bridge) => bridge.cue.dismiss({ suggestionId: id }))
    },

    panic: async () => {
      // Same reasoning as `dismiss`, one step stronger: halting automation is applied before the
      // round trip, and if the round trip fails the halt STAYS. Automation never comes back because
      // a message was lost.
      set({ state: { ...get().state, panicked: true, pending: null } })
      const result = await run((bridge) => bridge.cue.panic())
      if (!result.ok) set({ state: { ...get().state, panicked: true, pending: null } })
      return result
    },

    resume: async () => {
      // No optimism here, in either direction: `panicked` is cleared only by adopting a main-process
      // state that says so. A resume that failed leaves automation halted, which is correct.
      return run((bridge) => bridge.cue.resume())
    },

    setSettings: async (settings) => {
      set({ busy: true })
      const result = await callBridge((bridge) => bridge.cue.setSettings(settings))
      if (result.ok) {
        set({ settings: result.value, busy: false, lastError: null })
      } else {
        set({ busy: false, lastError: result.error })
      }
      return result
    },
  }
})

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `panicked: true` from one test silently breaks the next.
 */
export function resetCueStore(): void {
  useCueStore.setState(initialState())
}
