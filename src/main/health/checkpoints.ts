/**
 * Checkpoints — a safe rewind of AUTOMATION, and of nothing else.
 *
 * `docs/v2-notes/SHORTCUTS_AND_A11Y.md` describes a CTRL+D "back to the last checkpoint" gesture.
 * BLUEPRINT.md §9 lists it as the safeguard for a wrong auto-trigger. The value is narrow and the
 * narrowness is the point: the operator has just watched the app jump two cues ahead, and they
 * want the plan pointer back where it was — *without* their next keystroke being the one that
 * ends the broadcast.
 *
 * ## What a restore touches
 *
 * The plan pointer, by stepping it back one cue at a time with `PlanService.back()`, which fires
 * nothing; and the cue engine's pending suggestion, which is dropped because it was formed against
 * the position being abandoned. The engine adopts the plan's real position on its next tick.
 *
 * ## What a restore must never touch, and how that is proved
 *
 * Not the stream. Not the recording. Not the overlay. A rewind is a correction of *intent*; the
 * broadcast has already happened and cannot be un-happened, and blanking the congregation's screen
 * because an operator pressed undo would be its own emergency (the same rule PANIC obeys).
 *
 * That is not left to good intentions. This store is handed seams it deliberately never invokes —
 * {@link CheckpointBroadcastLike.stopStream}, {@link CheckpointBroadcastLike.stopRecord} and
 * {@link CheckpointOverlayLike.send} — and `checkpoints.test.ts` passes spies for all three and
 * asserts a zero call count across a full record/restore cycle, plus scans this source file for
 * the forbidden verbs. The only method called on the broadcast seam is `isLive()`, which is
 * read-only and exists so the restore can say in the log that it left a live broadcast alone.
 *
 * ## The ring
 *
 * Bounded at {@link MAX_CHECKPOINTS}. Enough to undo a bad patch, not enough to rewind a whole
 * service — an unbounded history invites an operator to jump back forty minutes mid-sermon, and a
 * plan pointer that far out of step with the room is worse than no pointer.
 *
 * Restoring FORWARD is refused. Moving the pointer forward means firing cues, and firing a cue
 * puts something on the congregation's screen; a recovery gesture must never do that.
 */

import { MAX_CHECKPOINTS } from '@shared/health'
import type { Checkpoint } from '@shared/health'
import type { CueEngineState, CueSuggestion } from '@shared/cue'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { OverlayCommand } from '@shared/overlay'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import { formatReference } from '@shared/scripture'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Matches `PlanService`.
 *
 * `back()` is the only mutating verb in this whole module. It steps the pointer back and fires
 * nothing — that asymmetry with `advance()` is exactly why it is safe to drive from a recovery
 * gesture.
 */
export interface CheckpointPlanLike {
  /** The current plan pointer. `-1` before the first cue has fired. */
  getPosition(): number
  /** Step the pointer back one cue, firing nothing. */
  back(): Result<unknown>
}

/**
 * Matches `OverlayServer`.
 *
 * `getRevision()` is read when a checkpoint is recorded, so the operator can see what was on
 * screen at the time. `send` is present ONLY so a test can prove restore never calls it — the
 * congregation's screen is not part of a rewind.
 */
export interface CheckpointOverlayLike {
  getRevision(): number
  send(command: OverlayCommand): Result<unknown>
}

/**
 * Matches `CueEngine`.
 *
 * `dismiss` is called on restore for the pending suggestion only. There is deliberately no
 * `confirm` and no `fireCue` here: a rewind never fires anything.
 */
export interface CheckpointCueLike {
  getState(): Result<CueEngineState>
  onState(callback: (state: CueEngineState) => void): Unsubscribe
  dismiss(suggestionId: string): Result<unknown>
}

/**
 * The broadcast, read-only.
 *
 * `stopStream` and `stopRecord` are in this interface and are never called. They are here so the
 * guarantee is *testable* rather than merely stated: a spy passed in here must record zero calls
 * after a full record/restore cycle. If a future edit ever calls one, a test fails loudly instead
 * of a service ending quietly.
 */
export interface CheckpointBroadcastLike {
  /** Whether OBS is currently streaming or recording. Read-only, used for the log line. */
  isLive(): boolean
  /** NEVER CALLED by this module. Present so a test can prove it. */
  stopStream(): Promise<Result<unknown>>
  /** NEVER CALLED by this module. Present so a test can prove it. */
  stopRecord(): Promise<Result<unknown>>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on rewind steps in one restore.
 *
 * A `back()` that stops moving the pointer (a plan edited out from under a checkpoint) must end
 * the loop, not spin the main process during a service. Generous enough to cross any real plan.
 */
export const MAX_REWIND_STEPS = 500

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * A human summary of the cue that just fired.
 *
 * Read at speed in a dark booth, so it names the thing rather than the mechanism: the cue id, or
 * the reference, before it falls back to the detector's own reason.
 */
export function firedCueLabel(suggestion: CueSuggestion): string {
  if (suggestion.cueId !== null) return `after cue "${suggestion.cueId}"`
  if (suggestion.reference !== null) {
    return `after scripture "${formatReference(suggestion.reference)}"`
  }
  return `after ${suggestion.detector}: ${suggestion.why}`
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Constructor dependencies. Every seam is required, so a missing one is a compile error. */
export interface CheckpointStoreOptions {
  readonly plan: CheckpointPlanLike
  readonly overlay: CheckpointOverlayLike
  readonly cue: CheckpointCueLike
  readonly broadcast: CheckpointBroadcastLike
  readonly logger: Logger
  readonly now?: () => number
  /** Injected so ids are deterministic in tests. */
  readonly newId?: () => string
}

/** What an explicit operator checkpoint may override. Positions are always read live. */
export interface RecordCheckpointInput {
  /** Human summary. Defaults to a timestamped "operator checkpoint". */
  readonly label?: string
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class CheckpointStore {
  private readonly plan: CheckpointPlanLike
  private readonly overlay: CheckpointOverlayLike
  private readonly cue: CheckpointCueLike
  private readonly broadcast: CheckpointBroadcastLike
  private readonly log: Logger
  private readonly now: () => number
  private readonly newId: () => string

  /** Oldest first. Capped at {@link MAX_CHECKPOINTS}. */
  private ring: Checkpoint[] = []

  private sequence = 0
  private lastFiredSuggestionId: string | null = null
  private unsubscribe: Unsubscribe | null = null
  private started = false
  private disposed = false

  constructor(options: CheckpointStoreOptions) {
    this.plan = options.plan
    this.overlay = options.overlay
    this.cue = options.cue
    this.broadcast = options.broadcast
    this.log = options.logger.child('checkpoints')
    this.now = options.now ?? Date.now
    this.newId =
      options.newId ??
      ((): string => {
        this.sequence += 1
        return `checkpoint-${this.now()}-${this.sequence}`
      })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Watch the cue engine and auto-record a checkpoint after each fired cue.
   *
   * Idempotent, and no I/O — one in-process subscription. Automatic checkpoints are what make the
   * gesture worth having: an operator who has just been surprised by an auto-fire has no spare
   * hand to have pressed "save a checkpoint" beforehand.
   */
  start(): Result<void> {
    if (this.disposed) return this.disposedError()
    if (this.started) return ok(undefined)
    this.started = true

    const initial = this.cue.getState()
    if (initial.ok) this.lastFiredSuggestionId = newestFiredId(initial.value)

    try {
      this.unsubscribe = this.cue.onState((state) => {
        this.onCueState(state)
      })
    } catch (cause) {
      this.log.error('could not watch the cue engine for checkpoints', { detail: String(cause) })
    }
    return ok(undefined)
  }

  /** Release the subscription. Keeps the ring — disposing is not forgetting. */
  dispose(): void {
    this.disposed = true
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    if (unsubscribe === null) return
    try {
      unsubscribe()
    } catch (cause) {
      this.log.warn('the cue engine threw while unsubscribing', { detail: String(cause) })
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Record a checkpoint from the live plan and overlay positions.
   *
   * The positions are read here rather than passed in, so an operator checkpoint can never
   * describe a state the app was in a moment ago.
   */
  record(input: RecordCheckpointInput = {}): Result<Checkpoint> {
    if (this.disposed) return this.disposedError()

    const at = this.now()
    const planPosition = this.readNumber('plan position', () => this.plan.getPosition())
    const overlayRevision = this.readNumber('overlay revision', () => this.overlay.getRevision())

    const checkpoint: Checkpoint = {
      id: this.newId(),
      at,
      planPosition,
      overlayRevision,
      label: input.label ?? 'operator checkpoint',
    }

    this.ring.push(checkpoint)
    if (this.ring.length > MAX_CHECKPOINTS) {
      this.ring = this.ring.slice(this.ring.length - MAX_CHECKPOINTS)
    }

    this.log.info('checkpoint recorded', {
      id: checkpoint.id,
      planPosition,
      overlayRevision,
      label: checkpoint.label,
    })
    return ok(checkpoint)
  }

  /** Every retained checkpoint, newest first — the order the recovery list renders in. */
  list(): Result<readonly Checkpoint[]> {
    if (this.disposed) return this.disposedError()
    return ok([...this.ring].reverse())
  }

  // -------------------------------------------------------------------------
  // Restoring
  // -------------------------------------------------------------------------

  /**
   * Rewind automation to a checkpoint.
   *
   * Steps the plan pointer back to the recorded position and drops any pending suggestion. Does
   * not stop the stream, does not stop the recording, does not blank or rewind the overlay, and
   * never moves the pointer forward.
   */
  restore(id: string): Result<Checkpoint> {
    if (this.disposed) return this.disposedError()

    const checkpoint = this.ring.find((entry) => entry.id === id)
    if (checkpoint === undefined) {
      return err(ErrorCode.NOT_FOUND, 'there is no checkpoint with that id', id)
    }

    // Read-only. Logged so the service-day log records that a rewind happened DURING a live
    // broadcast and left it alone — the question someone will ask afterwards.
    const live = this.readBoolean('broadcast state', () => this.broadcast.isLive())

    const rewound = this.rewindPlan(checkpoint.planPosition)
    if (!rewound.ok) return rewound

    this.dropPendingSuggestion()

    this.log.warn('automation rewound to a checkpoint', {
      id: checkpoint.id,
      label: checkpoint.label,
      planPosition: checkpoint.planPosition,
      steps: rewound.value,
      broadcastLive: live,
      note: 'the stream, the recording and the overlay were not touched',
    })
    return ok(checkpoint)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Step back to `target`. Never forward, always bounded. Returns the number of steps taken. */
  private rewindPlan(target: number): Result<number> {
    let position = this.readNumber('plan position', () => this.plan.getPosition())

    if (position <= target) {
      this.log.info('the plan pointer is already at or behind the checkpoint; nothing to rewind', {
        position,
        target,
      })
      return ok(0)
    }

    let steps = 0
    while (position > target && steps < MAX_REWIND_STEPS) {
      const back = this.step()
      if (!back.ok) return back
      const next = this.readNumber('plan position', () => this.plan.getPosition())
      if (next >= position) {
        // `back()` reported success but the pointer did not move — the plan was edited under the
        // checkpoint. Stop rather than spin the main process mid-service.
        this.log.warn('the plan pointer stopped moving before the checkpoint was reached', {
          position: next,
          target,
        })
        break
      }
      position = next
      steps += 1
    }
    return ok(steps)
  }

  private step(): Result<unknown> {
    try {
      return this.plan.back()
    } catch (cause) {
      return err(ErrorCode.INTERNAL, 'the plan service threw while stepping back', String(cause))
    }
  }

  /** Drop a suggestion formed against the position we have just abandoned. Fires nothing. */
  private dropPendingSuggestion(): void {
    let state: CueEngineState
    try {
      const current = this.cue.getState()
      if (!current.ok) return
      state = current.value
    } catch (cause) {
      this.log.warn('the cue engine threw while being read for a restore', {
        detail: String(cause),
      })
      return
    }

    const pending = state.pending
    if (pending === null) return
    try {
      this.cue.dismiss(pending.id)
    } catch (cause) {
      this.log.warn('the cue engine threw while dismissing a stale suggestion', {
        detail: String(cause),
      })
    }
  }

  /** Auto-record after a cue fires, identified by a new newest entry in `recent`. */
  private onCueState(state: CueEngineState): void {
    const firedId = newestFiredId(state)
    if (firedId === null || firedId === this.lastFiredSuggestionId) return
    this.lastFiredSuggestionId = firedId

    const suggestion = state.recent[0]
    if (suggestion === undefined) return
    this.record({ label: firedCueLabel(suggestion) })
  }

  private readNumber(what: string, get: () => number): number {
    try {
      const value = get()
      return Number.isFinite(value) ? value : -1
    } catch (cause) {
      this.log.warn('a checkpoint source threw while being read', {
        what,
        detail: String(cause),
      })
      return -1
    }
  }

  private readBoolean(what: string, get: () => boolean): boolean {
    try {
      return get()
    } catch (cause) {
      this.log.warn('a checkpoint source threw while being read', {
        what,
        detail: String(cause),
      })
      return false
    }
  }

  private disposedError(): Result<never> {
    return err(ErrorCode.INTERNAL, 'the checkpoint store has been disposed')
  }
}

/** The id of the most recently fired suggestion, or `null` when nothing has fired. */
function newestFiredId(state: CueEngineState): string | null {
  return state.recent[0]?.id ?? null
}
