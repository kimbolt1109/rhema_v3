/**
 * `CaptionService` — the only thing that drives the caption layer.
 *
 * BLUEPRINT.md §6 gives captions their own overlay layer; `@shared/overlay` explains why that
 * layer is unlike the other three: **nothing human authored its text.** A lower third was typed by
 * the operator, scripture came from a licensed API, a slide was prepared during the week — a
 * caption is whatever the recogniser thought it heard, on the congregation screen before anyone
 * could veto it. Standing Rule 1 says design for veto, not trust, so the safety lives here, in the
 * one component between the transcript and the layer.
 *
 * ## Three rules, enforced structurally
 *
 * 1. **OFF is the default, and OFF means off.** While `enabled` is false {@link onTranscript}
 *    returns before it has looked at the segment: no command, no timer, no state change. There is
 *    no "captions are off but the last sentence is still up" state to explain to an operator.
 * 2. **`setEnabled(false)` HIDES, immediately.** It is the kill switch, so it sends `caption.hide`
 *    on the enabled -> disabled transition unconditionally — not "if we think something is
 *    visible", because the moment the operator reaches for that switch is exactly the moment this
 *    service's belief about the screen is least worth trusting. It is also transition-guarded, so
 *    holding the switch off does not spam the overlay with hides.
 * 3. **Nothing throws.** Every method returns a {@link Result}; the ASR seam, the `send` seam and
 *    every state subscriber are wrapped. An exception escaping into the main process while the
 *    service is live would take the booth UI down with it.
 *
 * ## Windowing is not cosmetic
 *
 * `captionShowPayload` caps `text` at 400 characters and REJECTS anything longer — a caption that
 * overflows the frame covers the person speaking. A preacher speaking uninterrupted produces spans
 * far longer than that, so an un-windowed caption would simply stop appearing partway through a
 * sermon, silently, because the schema refused it. {@link windowCaptionText} keeps the most recent
 * 400 characters and prefers to start at a word boundary.
 *
 * ## Idle hide
 *
 * ASR goes quiet during prayer, communion, and every pause a preacher takes for effect. The layer
 * has no idea speech stopped, so without a deadline the last sentence sits over the congregation
 * until someone says something. After {@link CAPTION_IDLE_HIDE_MS} with no new segment the layer
 * is hidden; the text is kept, because `caption.hide` is a hide and not a wipe.
 *
 * ## Seams
 *
 * The ASR service and the overlay server are two local structural seams — this file imports
 * neither, so the whole service is driven in tests by trivial fakes with no Electron, no network
 * and no microphone. `src/main/caption/index.ts` supplies the real ones.
 */

import type { TranscriptSegment } from '@shared/asr'
import { CAPTION_IDLE_HIDE_MS, windowCaptionText } from '@shared/caption'
import type { CaptionRuntimeState } from '@shared/caption'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { OverlayCommand } from '@shared/overlay'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/*
 * The text cap, the idle delay, the word-boundary slack, `CaptionRuntimeState` and
 * `windowCaptionText` all live in `@shared/caption`, not here.
 *
 * That is a constraint, not tidiness. `CaptionRuntimeState` crosses IPC to the booth UI, and the
 * renderer must never import main-process code — `tsconfig.web.json` deliberately leaves `@main/*`
 * unmapped so the preload bridge stays the only channel between them. A copy of the type on each
 * side of that boundary is a copy that drifts. The windowing function moved with it because the cap
 * it enforces is the same cap `caption.show`'s schema REJECTS on, and `src/shared/caption.test.ts`
 * guards that pairing directly — a drift there stops captions silently, mid-sermon.
 */

// ---------------------------------------------------------------------------
// Seams and types
// ---------------------------------------------------------------------------

/** The slice of the ASR service this consumes. Structurally satisfied by `AsrService`. */
export interface CaptionAsrLike {
  onTranscript(callback: (segment: TranscriptSegment) => void): Unsubscribe
}

/** Constructor dependencies. Only `asr` and `send` are required. */
export interface CaptionServiceOptions {
  readonly asr: CaptionAsrLike
  /** Injected by the composition root; the service never reaches for the server itself. */
  readonly send: (command: OverlayCommand) => void
  /**
   * Where the service's diagnostics go.
   *
   * Optional, unlike `CueEngine`'s: a caption driver with nowhere to log is still safe to run, and
   * the main process only builds its rolling-file logger inside `app.whenReady()`.
   */
  readonly logger?: Logger
  /** Epoch-milliseconds clock. */
  readonly now?: () => number
  /** Overrides {@link CAPTION_IDLE_HIDE_MS}. Non-finite or non-positive values are ignored. */
  readonly idleHideMs?: number
}

/** Why a `caption.hide` was sent. Logged so a service-day log explains a blank layer. */
type HideReason = 'operator' | 'idle' | 'retraction' | 'drafts-off'

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class CaptionService {
  private readonly asr: CaptionAsrLike
  private readonly sendCommand: (command: OverlayCommand) => void
  private readonly log: Logger
  private readonly now: () => number
  private readonly idleHideMs: number

  private enabled = false
  private showDrafts = false
  private lastText = ''

  /** Whether a `caption.show` has been sent that no `caption.hide` has followed. */
  private visible = false
  /** Whether what is on the layer is a partial. Only that may be pulled by `setShowDrafts(false)`. */
  private lastWasDraft = false
  /** `now()` of the most recent accepted segment, for the idle deadline. */
  private lastSegmentAt = 0

  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeAsr: Unsubscribe | null = null
  private disposed = false

  private readonly stateSubscribers = new Set<(state: CaptionRuntimeState) => void>()

  constructor(options: CaptionServiceOptions) {
    this.asr = options.asr
    this.sendCommand = options.send
    this.log = (options.logger ?? noopLogger).child('caption')
    this.now = options.now ?? Date.now
    const requested = options.idleHideMs ?? CAPTION_IDLE_HIDE_MS
    // A zero or negative deadline would hide every caption in the same tick it appeared, which
    // reads as "captions are broken" rather than as a misconfiguration.
    this.idleHideMs =
      Number.isFinite(requested) && requested > 0 ? requested : CAPTION_IDLE_HIDE_MS
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the transcript.
   *
   * Idempotent, and safe to call before the operator has enabled anything: captions are off, so
   * every segment that arrives is dropped at the top of {@link onTranscript}. A recogniser that
   * cannot be subscribed to is reported rather than thrown, and the rest of the app is unaffected.
   */
  start(): Result<void> {
    if (this.disposed) return this.disposedError()
    if (this.unsubscribeAsr !== null) return ok(undefined)

    try {
      this.unsubscribeAsr = this.asr.onTranscript((segment) => {
        this.onTranscript(segment)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to the transcript; captions are unavailable', { cause })
      return { ok: false, error: toAppError(cause) }
    }

    this.log.info('captions are attached to the transcript', { enabled: this.enabled })
    return ok(undefined)
  }

  /**
   * Release the subscription, the timer and the subscribers. Idempotent.
   *
   * Deliberately does NOT hide the layer. Disposal happens at shutdown and in tests; the service
   * going away is never a reason to change what the congregation can see — the same rule
   * `CueEngine.dispose` follows. The operator's off switch is {@link setEnabled}.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearIdleTimer()

    const unsubscribe = this.unsubscribeAsr
    this.unsubscribeAsr = null
    if (unsubscribe !== null) {
      try {
        unsubscribe()
      } catch {
        /* a failing unsubscribe must not fail a shutdown */
      }
    }
    this.stateSubscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Operator controls
  // -------------------------------------------------------------------------

  /**
   * The kill switch, and the most important method in this file.
   *
   * Switching OFF hides the layer in the same tick, mid-utterance, before anything else happens —
   * an operator who has just seen the recogniser put something wrong in front of the congregation
   * needs it gone, not "no further updates". Switching ON deliberately sends nothing: the layer
   * still holds the last text, and re-showing it would flash a sentence from before the pause. The
   * next segment puts a caption up.
   *
   * Transition-guarded, so a repeated OFF is silent rather than a stream of hides.
   */
  setEnabled(on: boolean): Result<CaptionRuntimeState> {
    if (this.disposed) return this.disposedError()
    if (this.enabled === on) return ok(this.getState())

    // Set first, hide second: from this line on, any segment already in flight is dropped.
    this.enabled = on
    if (on) {
      this.log.info('captions were switched on', { showDrafts: this.showDrafts })
    } else {
      this.hide('operator')
    }
    return ok(this.publish())
  }

  /**
   * Opt into in-flight partials.
   *
   * Off by default: a partial is the recogniser's first guess, it changes under the reader, and it
   * is wrong more often than the final that replaces it. Turning it back off pulls a partial that
   * is currently on the layer, because leaving the last unvetted guess up is the state the operator
   * just asked to leave. A final already on the layer is untouched — it is not a draft.
   */
  setShowDrafts(on: boolean): Result<CaptionRuntimeState> {
    if (this.disposed) return this.disposedError()
    if (this.showDrafts === on) return ok(this.getState())

    this.showDrafts = on
    if (!on && this.visible && this.lastWasDraft) this.hide('drafts-off')
    this.log.info('caption drafts were toggled', { showDrafts: on })
    return ok(this.publish())
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The current control state. Always a complete snapshot. */
  getState(): CaptionRuntimeState {
    return { enabled: this.enabled, showDrafts: this.showDrafts, lastText: this.lastText }
  }

  /** Subscribe to control-state changes. Published only when something observable changed. */
  onState(callback: (state: CaptionRuntimeState) => void): Unsubscribe {
    this.stateSubscribers.add(callback)
    return () => {
      this.stateSubscribers.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // The transcript
  // -------------------------------------------------------------------------

  /**
   * One transcript segment.
   *
   * The disabled check is the first statement on purpose (Standing Rule 1). Everything below it —
   * windowing, the draft gate, the idle clock — only runs for an operator who asked for captions.
   *
   * An empty FINAL is not silence: `AsrService` re-emits a span with empty text to RETRACT a
   * partial it has since judged a hallucination. Consumers replace by `id`, so the retraction has
   * to reach the layer as a hide; ignoring it would leave a phantom "thank you for watching" over
   * the congregation for as long as the service runs.
   */
  private onTranscript(segment: TranscriptSegment): void {
    if (this.disposed) return
    if (!this.enabled) return

    const text = windowCaptionText(segment.text)
    if (text.length === 0) {
      if (segment.isFinal && this.visible) this.hide('retraction')
      return
    }

    // A segment is provisional if it is not final, or if the fast draft model produced it and a
    // slower final is still coming (`docs/v2-notes/ASR_PIPELINE.md`). Both are guesses.
    const draft = !segment.isFinal || segment.isDraft
    if (draft && !this.showDrafts) return

    this.lastSegmentAt = this.now()
    this.show(text, draft)
  }

  // -------------------------------------------------------------------------
  // The layer
  // -------------------------------------------------------------------------

  private show(text: string, draft: boolean): void {
    this.dispatch({ channel: 'command', name: 'caption.show', payload: { text, draft } })
    this.visible = true
    this.lastWasDraft = draft
    this.armIdleHide()

    if (this.lastText === text) return
    this.lastText = text
    this.publish()
  }

  /**
   * Hide the layer.
   *
   * Unconditional: it does not consult {@link visible}. The one caller that can afford to be wrong
   * about what is on screen is the kill switch, and it is the one that must never be. The callers
   * that should be quiet — the idle deadline, a retraction, drafts being switched off — check
   * `visible` themselves before calling.
   */
  private hide(reason: HideReason): void {
    this.clearIdleTimer()
    this.visible = false
    this.lastWasDraft = false
    this.dispatch({ channel: 'command', name: 'caption.hide', payload: {} })
    this.log.info('the caption layer was hidden', { reason })
  }

  /**
   * Hand one command to the overlay.
   *
   * The text is never logged. It is a live transcription of what is being said in the room, and a
   * rolling log file is not where service content belongs; the length is enough to debug windowing.
   */
  private dispatch(command: OverlayCommand): void {
    try {
      this.sendCommand(command)
    } catch (cause) {
      this.log.warn('the overlay refused a caption command', { command: command.name, cause })
    }
  }

  // -------------------------------------------------------------------------
  // The idle deadline
  // -------------------------------------------------------------------------

  /**
   * Arm the deadline, if it is not already armed.
   *
   * Deliberately not a clear-and-reset on every segment: a running recogniser emits several
   * segments a second for the length of a sermon, and churning a timer at that rate for an event
   * that fires once a pause is waste. One timer runs; when it fires it consults the clock and
   * re-arms for whatever is left, so the hide still lands exactly `idleHideMs` after the last
   * segment.
   */
  private armIdleHide(): void {
    if (this.idleTimer !== null) return
    this.scheduleIdleHide(this.idleHideMs)
  }

  private scheduleIdleHide(delayMs: number): void {
    try {
      this.idleTimer = setTimeout(() => {
        this.onIdleDeadline()
      }, delayMs)
    } catch (cause) {
      // No timer means a caption lingers until the next segment or the operator's switch. Strictly
      // less tidy than hiding, strictly better than crashing the main process mid-service.
      this.idleTimer = null
      this.log.warn('could not arm the caption idle-hide deadline', { cause })
    }
  }

  private onIdleDeadline(): void {
    this.idleTimer = null
    if (this.disposed || !this.visible) return

    const remaining = this.idleHideMs - (this.now() - this.lastSegmentAt)
    if (remaining > 0) {
      this.scheduleIdleHide(remaining)
      return
    }
    this.hide('idle')
  }

  private clearIdleTimer(): void {
    const handle = this.idleTimer
    this.idleTimer = null
    if (handle === null) return
    try {
      clearTimeout(handle)
    } catch {
      /* a failing clear must not fail a tick */
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private publish(): CaptionRuntimeState {
    const snapshot = this.getState()
    for (const subscriber of [...this.stateSubscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('a caption state subscriber threw', { cause })
      }
    }
    return snapshot
  }

  private disposedError(): Result<never> {
    return err(ErrorCode.INTERNAL, 'the caption service has been disposed')
  }
}

/*
 * Windowing lives in `@shared/caption`. Its boundary rule, the Korean-spacing rationale behind the
 * slack constant, and the empty-slice guard all moved there intact — see the note at the top of
 * this file for why the shared module owns them.
 */
