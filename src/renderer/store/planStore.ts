/**
 * The renderer's view of the service plan.
 *
 * `src/shared/plan.ts` is the contract and `src/shared/ipc.ts` is the wire; this store is a mirror
 * of the last {@link PlanState} the main process reported, plus the small amount of local editing
 * state the authoring UI needs. Four properties carry it:
 *
 * 1. **Manual first.** Nothing in this file needs ASR, a cue engine, or a network. `advance`,
 *    `back` and `fireCue` are the whole live surface, and they work against a plan authored by
 *    hand with every cue on `trigger.mode = 'manual'`. Phases 7-8 add automation *above* this;
 *    they do not replace it, and when they fail this is what the operator falls back to.
 * 2. **Edits are optimistic, then authoritative.** `addCue`, `updateCue`, `removeCue` and
 *    `reorderCues` mutate the local copy first — a booth operator dragging a cue must see it move
 *    now, not after a round trip — then push the whole plan through `plan.set`. On success the
 *    main process's answer replaces the local guess wholesale. On failure the *previous* plan is
 *    restored, which is `docs/v2-notes/PLAN_LESSONS.md`'s "refetch the authoritative list rather
 *    than trying to reconcile", done with the copy we already hold.
 * 3. **The importer's absence is a first-class state, not an error.** `importer.available` is
 *    false on a machine with no PowerPoint converter — which is this machine — and the UI is
 *    expected to disable import and print `importer.detail`. Standing Rule 5: degrade, never crash.
 * 4. **Nothing throws.** `window.verger` is optional (jsdom, or a preload that failed to load) and
 *    every action returns an `Err` rather than dereferencing `undefined`, exactly like `obsStore`,
 *    `cameraStore`, `youtubeStore` and `goLiveStore`.
 *
 * No Node globals: this module is imported by the renderer bundle.
 */

import { create } from 'zustand'

import type {
  DeckImportProgress,
  DeckImporterStatus,
  PlanState,
  Unsubscribe,
  VergerApi,
} from '@shared/ipc'
import type { Cue, CuePayload, CueType, PlanPosition, ServicePlan } from '@shared/plan'
import { emptyServicePlan, initialPlanPosition } from '@shared/plan'
import type { AppError, Result } from '@shared/result'
import { ErrorCode, err, toAppError } from '@shared/result'

import { getVergerApi } from './obsStore'

/**
 * Developer-facing text for the "preload never arrived" case. The operator sees the localised
 * `plan.bridgeUnavailable.*` copy instead — this string is for the log file.
 */
export const PLAN_BRIDGE_UNAVAILABLE_MESSAGE =
  'The Verger preload bridge (window.verger) is unavailable; the service plan is read-only.'

function bridgeUnavailableError(): AppError {
  return { code: ErrorCode.NOT_CONFIGURED, message: PLAN_BRIDGE_UNAVAILABLE_MESSAGE }
}

function bridgeUnavailable(): Result<never> {
  return err(ErrorCode.NOT_CONFIGURED, PLAN_BRIDGE_UNAVAILABLE_MESSAGE)
}

/** Run an operation against the bridge, converting every failure mode into an `Err`. */
async function callBridge<T>(operation: (api: VergerApi) => Promise<Result<T>>): Promise<Result<T>> {
  const api = getVergerApi()
  if (api === undefined) return bridgeUnavailable()
  try {
    return await operation(api)
  } catch (cause) {
    return { ok: false, error: toAppError(cause) }
  }
}

/* --------------------------- pure plan helpers, unit-testable --------------------------- */

/** The resting importer state: nothing detected, nothing claimed. */
export function unknownImporterStatus(): DeckImporterStatus {
  return { available: false, backend: null, executablePath: null, detail: null }
}

/** The launch state: an unnamed empty plan that has never been saved. */
export function emptyPlanState(): PlanState {
  return {
    plan: emptyServicePlan(''),
    position: initialPlanPosition(),
    path: null,
    dirty: false,
    lastFired: null,
  }
}

/**
 * A fresh cue id.
 *
 * `crypto.randomUUID` where it exists, and a counter-plus-timestamp where it does not. A booth
 * machine's Chromium always has the former; an older jsdom shim may not, and an authoring UI that
 * threw while adding a cue would be a spectacularly silly way to lose a service.
 */
let cueCounter = 0
export function newCueId(): string {
  const maybeCrypto = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto
  if (maybeCrypto !== undefined && typeof maybeCrypto.randomUUID === 'function') {
    return `cue-${maybeCrypto.randomUUID()}`
  }
  cueCounter += 1
  return `cue-${String(Date.now())}-${String(cueCounter)}`
}

/**
 * A valid starting payload for each cue type.
 *
 * Every default *passes* `cuePayloadSchemas`, deliberately: adding a cue must never produce a plan
 * the main process will refuse to save. They are obvious placeholders the operator then edits.
 *
 * Note what is absent from the `scripture` case — there is no text field to default, because
 * `ScripturePayload` has none (Standing Rule 4). The wording is resolved at fire time.
 */
export function defaultPayloadFor(type: CueType): CuePayload {
  switch (type) {
    case 'scene':
      return { scene: 'Wide' }
    case 'slide':
      return { asset: 'slides/slide-001.png' }
    case 'media':
      return { asset: 'media/clip.mp4' }
    case 'scripture':
      return { reference: 'John 3:16' }
    case 'lowerthird':
      return { line1: 'Name' }
    case 'action':
      return { action: 'overlay.clear' }
  }
}

/**
 * Build a cue.
 *
 * `trigger.mode` is always `manual`. That is not a default that happens to be convenient — it is
 * the phase's whole premise, and there is no parameter here that could make it anything else.
 */
export function createCue(type: CueType, label: string): Cue {
  return {
    id: newCueId(),
    type,
    label,
    trigger: { mode: 'manual' },
    payload: defaultPayloadFor(type),
  }
}

/**
 * Move `from` to `to`, clamped.
 *
 * A local `arrayMove`, rather than `@dnd-kit/sortable`'s, so the store stays free of a UI
 * dependency and so this is testable without rendering anything.
 */
export function moveCue(cues: readonly Cue[], from: number, to: number): readonly Cue[] {
  if (from === to) return cues
  if (from < 0 || from >= cues.length) return cues
  const target = Math.min(Math.max(to, 0), cues.length - 1)
  const next = [...cues]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return cues
  next.splice(target, 0, moved)
  return next
}

/**
 * Keep the pointer on the cue it was already on, across an edit.
 *
 * `PLAN_LESSONS.md` records this as one of the v2 playlist's load-bearing behaviours: the active
 * index follows the cue **by id**, not by slot number. Reordering the cue *after* the one on
 * screen must not silently change what is on screen.
 */
export function repositionAfterEdit(
  position: PlanPosition,
  before: readonly Cue[],
  after: readonly Cue[],
): PlanPosition {
  if (position.index < 0) return position
  const anchor = before[position.index]
  if (anchor === undefined) {
    return { index: Math.min(position.index, after.length - 1), firedCueIds: position.firedCueIds }
  }
  const found = after.findIndex((cue) => cue.id === anchor.id)
  // The cue the pointer was on has been deleted: fall back to the same slot, clamped, rather than
  // jumping to the top of the service.
  const index = found === -1 ? Math.min(position.index, after.length - 1) : found
  return { index, firedCueIds: position.firedCueIds }
}

/** The cue at the pointer, or `null` before anything has fired. */
export function currentCue(state: PlanState): Cue | null {
  return state.plan.cues[state.position.index] ?? null
}

/** The cue that SPACE will fire next, or `null` at the end of the plan. */
export function upcomingCue(state: PlanState): Cue | null {
  return state.plan.cues[state.position.index + 1] ?? null
}

/* ---------------------------------------- the store ---------------------------------------- */

export interface PlanStoreState {
  /** The last plan the main process reported, or the local optimistic edit awaiting its answer. */
  readonly plan: ServicePlan
  readonly position: PlanPosition
  readonly path: string | null
  readonly dirty: boolean
  readonly lastFired: Cue | null
  /** Whether a PowerPoint deck can be converted here. `available: false` disables import. */
  readonly importer: DeckImporterStatus
  /** The most recent import tick, or `null` when no import has been attempted this session. */
  readonly importProgress: DeckImportProgress | null
  /** True between pressing Import and the main process settling. */
  readonly importing: boolean
  /** False when `window.verger` is missing. Drives the "bridge did not load" explainer. */
  readonly bridgeAvailable: boolean
  /** True once {@link PlanStoreState.hydrate} has completed at least once. */
  readonly hydrated: boolean
  /** True while any plan round trip is in flight. */
  readonly busy: boolean
  /** The last refusal, kept so the editor can explain why an edit did not stick. */
  readonly lastError: AppError | null

  /** Pull the plan, the position and the importer's availability from the main process. */
  hydrate: () => Promise<void>
  /**
   * Wire the two push channels. Returns an unsubscribe function — call it on unmount.
   *
   * Note this is the *state* action, not zustand's own `usePlanStore.subscribe`. Reach it via
   * `usePlanStore.getState().subscribe()`.
   */
  subscribe: () => Unsubscribe
  /** Replace the whole plan. Every local edit funnels through here. */
  setPlan: (plan: ServicePlan) => Promise<Result<PlanState>>
  open: (options?: { path?: string }) => Promise<Result<PlanState>>
  save: (options?: { path?: string }) => Promise<Result<PlanState>>
  /** Convert a .pptx into one slide cue per slide. Refused when no converter exists. */
  importDeck: (options?: { path?: string }) => Promise<Result<PlanState>>
  /** Fire one cue by id and move the pointer to it. */
  fireCue: (cueId: string) => Promise<Result<PlanState>>
  /** The SPACE key's action: fire the next cue. */
  advance: () => Promise<Result<PlanState>>
  /** One-tap undo for a mis-fire. */
  back: () => Promise<Result<PlanState>>

  addCue: (cue: Cue) => Promise<Result<PlanState>>
  /** Replace one cue by id. Anything not in `next` is untouched — the caller supplies a whole cue. */
  updateCue: (id: string, next: Cue) => Promise<Result<PlanState>>
  removeCue: (id: string) => Promise<Result<PlanState>>
  reorderCues: (from: number, to: number) => Promise<Result<PlanState>>
}

const noop: Unsubscribe = () => undefined

function initialState(): Omit<
  PlanStoreState,
  | 'hydrate'
  | 'subscribe'
  | 'setPlan'
  | 'open'
  | 'save'
  | 'importDeck'
  | 'fireCue'
  | 'advance'
  | 'back'
  | 'addCue'
  | 'updateCue'
  | 'removeCue'
  | 'reorderCues'
> {
  const base = emptyPlanState()
  return {
    plan: base.plan,
    position: base.position,
    path: base.path,
    dirty: base.dirty,
    lastFired: base.lastFired,
    importer: unknownImporterStatus(),
    importProgress: null,
    importing: false,
    bridgeAvailable: getVergerApi() !== undefined,
    hydrated: false,
    busy: false,
    lastError: null,
  }
}

export const usePlanStore = create<PlanStoreState>()((set, get) => {
  /** Adopt a `PlanState` the main process handed back. */
  const adopt = (state: PlanState): void => {
    set({
      plan: state.plan,
      position: state.position,
      path: state.path,
      dirty: state.dirty,
      lastFired: state.lastFired,
    })
  }

  /**
   * Push a locally edited plan.
   *
   * Optimistic: the local copy moves first so the list re-renders immediately, and the pointer is
   * carried across by id. If the main process refuses, the *previous* plan and pointer are put
   * back — a half-applied edit on screen is worse than an edit that visibly did not take.
   */
  const pushPlan = async (
    nextCues: readonly Cue[],
    describe: (plan: ServicePlan) => ServicePlan = (plan) => plan,
  ): Promise<Result<PlanState>> => {
    const previous = get()
    const nextPlan = describe({ ...previous.plan, cues: nextCues })
    const nextPosition = repositionAfterEdit(previous.position, previous.plan.cues, nextCues)

    set({ plan: nextPlan, position: nextPosition, dirty: true, busy: true })

    const result = await callBridge((bridge) => bridge.plan.set(nextPlan))
    if (result.ok) {
      adopt(result.value)
      set({ busy: false, lastError: null })
    } else {
      set({
        plan: previous.plan,
        position: previous.position,
        dirty: previous.dirty,
        busy: false,
        lastError: result.error,
      })
    }
    return result
  }

  /** Run one main-process plan call, adopting its answer and never blanking on refusal. */
  const run = async (
    operation: (api: VergerApi) => Promise<Result<PlanState>>,
  ): Promise<Result<PlanState>> => {
    set({ busy: true })
    const result = await callBridge(operation)
    if (result.ok) {
      adopt(result.value)
      set({ busy: false, lastError: null })
    } else {
      // The mirrored plan is kept exactly as it was: a refused save has not un-authored anything.
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

      const state = await callBridge((bridge) => bridge.plan.getState())
      if (state.ok) {
        adopt(state.value)
        set({ hydrated: true, lastError: null })
      } else {
        set({ hydrated: true, lastError: state.error })
      }

      // Asked for separately and never inferred from the plan: whether a deck can be converted is
      // a fact about the *machine*, and it has to be known before the import control renders.
      const importer = await callBridge((bridge) => bridge.plan.getImporterStatus())
      if (importer.ok) {
        set({ importer: importer.value })
      } else {
        set({
          importer: { ...unknownImporterStatus(), detail: importer.error.message },
        })
      }
    },

    subscribe: () => {
      const api = getVergerApi()
      if (api === undefined) {
        set({ bridgeAvailable: false })
        return noop
      }

      const offState = api.plan.onState((state) => {
        adopt(state)
      })
      const offProgress = api.plan.onImportProgress((progress) => {
        set({
          importProgress: progress,
          // The terminal stages end the spinner; anything else means work is still happening.
          importing: progress.stage !== 'done' && progress.stage !== 'failed',
        })
      })

      return () => {
        offState()
        offProgress()
      }
    },

    setPlan: async (plan) => run((bridge) => bridge.plan.set(plan)),

    open: async (options = {}) => run((bridge) => bridge.plan.open(options)),

    save: async (options = {}) => run((bridge) => bridge.plan.save(options)),

    importDeck: async (options = {}) => {
      if (!get().importer.available) {
        // Refused here rather than at the boundary, so the UI's disabled control and the store
        // agree about *why*. There is no converter; there is nothing to try.
        const detail = get().importer.detail
        const refusal = err(
          ErrorCode.NOT_CONFIGURED,
          detail ?? 'No PowerPoint converter is available on this machine.',
        )
        set({ lastError: refusal.error })
        return refusal
      }

      set({ importing: true, importProgress: null })
      const result = await run((bridge) => bridge.plan.importDeck(options))
      set({ importing: false })
      return result
    },

    fireCue: async (cueId) => run((bridge) => bridge.plan.fireCue({ cueId })),

    advance: async () => run((bridge) => bridge.plan.advance()),

    back: async () => run((bridge) => bridge.plan.back()),

    addCue: async (cue) => pushPlan([...get().plan.cues, cue]),

    updateCue: async (id, next) =>
      pushPlan(get().plan.cues.map((cue) => (cue.id === id ? next : cue))),

    removeCue: async (id) => pushPlan(get().plan.cues.filter((cue) => cue.id !== id)),

    reorderCues: async (from, to) => pushPlan(moveCue(get().plan.cues, from, to)),
  }
})

/**
 * Reset the singleton store between tests.
 *
 * Exported rather than test-only-imported because a module-level zustand store outlives a single
 * test file, and a leaked `busy: true` from one test silently breaks the next.
 */
export function resetPlanStore(): void {
  usePlanStore.setState(initialState())
}
