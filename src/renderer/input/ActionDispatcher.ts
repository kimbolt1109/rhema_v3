/**
 * The single place every operator intent passes through.
 *
 * ## Why one dispatcher
 *
 * `src/shared/actions.ts` explains the payoff: a foot pedal and a Stream Deck are keyboard-HID
 * devices, so if the keyboard, the on-screen buttons and (later) a pedal all express themselves as
 * a named {@link ActionId} rather than as their own `onClick`/`onKeyDown` wiring, then adding a
 * control surface in Phase 10 is a remap UI, not a second input path. Everything the operator can
 * do goes through {@link ActionDispatcher.dispatch}.
 *
 * ## Why a broken handler may never escape
 *
 * This runs during a live service. If one handler throws — a stale OBS socket, a null deref in a
 * newly added camera panel — and that exception propagates back into the keydown listener, the
 * listener's remaining work is skipped and, worse, the operator's *next* keypress lands in a
 * half-torn-down state machine. A single bad handler must not deafen the keyboard mid-service.
 * So every handler and every observer is invoked inside its own `try`/`catch`, the failure is
 * logged, and the remaining handlers still run.
 *
 * That is also why {@link ActionDispatcher.dispatch} returns the {@link DispatchedAction} rather
 * than a `Result`: dispatching cannot fail. A handler failing is not the dispatcher failing, and
 * there is nothing useful the input layer could do with an error it is contractually obliged to
 * swallow. Failures go to the log, never back up the input loop.
 *
 * Framework-free on purpose: no React, no zustand, no DOM. The keyboard hook, the UI buttons and
 * the Phase 10 pedal binding all wrap this; it wraps nothing.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import type { ActionId, DispatchedAction } from '@shared/actions'
import type { Logger } from '@shared/log'

/** Where a dispatch came from. Carried on every {@link DispatchedAction}. */
export type ActionSource = DispatchedAction['source']

/** Invoked when its action is dispatched. Must not throw — but if it does, it is contained. */
export type ActionHandler = (dispatched: DispatchedAction) => void

/** Sees every dispatch regardless of action. Feeds the "last action" readout and the log. */
export type ActionObserver = (dispatched: DispatchedAction) => void

/** Returned by {@link ActionDispatcher.register} and {@link ActionDispatcher.subscribe}. */
export type Unregister = () => void

/**
 * The slice of {@link Logger} the dispatcher needs.
 *
 * Narrow on purpose: a test can pass `{ warn: vi.fn(), error: vi.fn() }` without standing up the
 * whole logging stack, and the renderer can pass a real child logger.
 */
export type ActionLogger = Pick<Logger, 'warn' | 'error'>

export interface ActionDispatcherOptions {
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Where contained handler failures are reported. Falls back to `console`. */
  readonly logger?: ActionLogger
}

export interface ActionDispatcher {
  /**
   * Register a handler for one action. Several handlers may share an action; all of them run.
   * The returned function removes exactly the handler that was registered.
   */
  register(action: ActionId, handler: ActionHandler): Unregister
  /** Observe every dispatch, in registration order, after the action's own handlers have run. */
  subscribe(observer: ActionObserver): Unregister
  /**
   * Fire an action. Never throws, whatever the handlers do.
   *
   * `source` defaults to `'ui'` because on-screen buttons are the only caller that would rather
   * not name themselves; the keyboard hook and the engine always pass their own source.
   */
  dispatch(action: ActionId, param?: string, source?: ActionSource): DispatchedAction
  /** The most recent dispatch, for the operator UI's "last action" readout. */
  lastAction(): DispatchedAction | null
  /** Whether anything is listening. Lets a panel disable a button that would do nothing. */
  hasHandler(action: ActionId): boolean
  /** Drop every handler and observer. For teardown; not part of normal operation. */
  clear(): void
}

/** Best-effort one-line description of a thrown value, which need not be an `Error`. */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`
  if (typeof thrown === 'string') return thrown
  try {
    return JSON.stringify(thrown) ?? String(thrown)
  } catch {
    return String(thrown)
  }
}

export function createActionDispatcher(options: ActionDispatcherOptions = {}): ActionDispatcher {
  const now = options.now ?? ((): number => Date.now())
  const logger = options.logger
  const handlers = new Map<ActionId, Set<ActionHandler>>()
  const observers = new Set<ActionObserver>()
  let last: DispatchedAction | null = null

  const report = (message: string, fields: Record<string, unknown>): void => {
    if (logger !== undefined) {
      logger.error(message, fields)
      return
    }
    // With no logger injected the failure still has to be visible somewhere: a silently dead
    // handler is how a whole service goes by with one control quietly doing nothing.
    console.error(`[actions] ${message}`, fields)
  }

  /** Runs one callback in isolation. Returns nothing: the caller cannot act on a failure. */
  const runContained = (
    kind: 'handler' | 'observer',
    callback: (dispatched: DispatchedAction) => void,
    dispatched: DispatchedAction,
  ): void => {
    try {
      callback(dispatched)
    } catch (thrown) {
      report(`action ${kind} threw`, {
        action: dispatched.action,
        source: dispatched.source,
        error: describeThrown(thrown),
      })
    }
  }

  return {
    register(action, handler) {
      const existing = handlers.get(action)
      const set = existing ?? new Set<ActionHandler>()
      if (existing === undefined) handlers.set(action, set)
      set.add(handler)
      return () => {
        set.delete(handler)
        if (set.size === 0) handlers.delete(action)
      }
    },

    subscribe(observer) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },

    dispatch(action, param, source = 'ui') {
      const dispatched: DispatchedAction = {
        action,
        source,
        at: now(),
        // `exactOptionalPropertyTypes`: omit the key rather than assign `undefined`.
        ...(param === undefined ? {} : { param }),
      }
      last = dispatched

      const registered = handlers.get(action)
      if (registered === undefined || registered.size === 0) {
        // Not an error: plenty of actions are unbound until the phase that owns them lands, and
        // an unmapped camera button is *supposed* to be inert. Worth a breadcrumb, nothing more.
        if (logger !== undefined) logger.warn('action dispatched with no handler', { action, source })
      } else {
        // Snapshot first: a handler that unregisters itself must not perturb this iteration.
        for (const handler of [...registered]) runContained('handler', handler, dispatched)
      }

      for (const observer of [...observers]) runContained('observer', observer, dispatched)

      return dispatched
    },

    lastAction() {
      return last
    },

    hasHandler(action) {
      const registered = handlers.get(action)
      return registered !== undefined && registered.size > 0
    },

    clear() {
      handlers.clear()
      observers.clear()
    },
  }
}
