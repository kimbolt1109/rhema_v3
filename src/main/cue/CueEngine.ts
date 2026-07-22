/**
 * The cue engine — three parallel detectors behind one trust dial.
 *
 * BLUEPRINT.md §4. This is the brain of the product and its most dangerous component: a wrong
 * automated action mid-service is unacceptable and cannot be undone in front of a congregation.
 * Three rules dominate every decision in this file, and each is enforced structurally rather than
 * by care.
 *
 * ## 1. The engine never writes authoritative state
 *
 * It emits a {@link CueSuggestion} — an INTENT. `PlanService` (behind {@link CuePlanLike}) owns
 * the plan pointer; the overlay server owns what is on screen. Every path that changes the world
 * goes through {@link CueEngine.applySuggestion}, which is reached only from `confirm()` or from
 * an auto-fire that `shouldAutoFire()` in `@shared/cue` has already permitted. That separation is
 * what makes a veto instant: there is nothing to roll back, because nothing was applied.
 *
 * ## 2. `syncToActual()` runs first on every tick
 *
 * {@link CueEngine.onTranscript} calls `syncToActual()` from `@shared/cue` before it looks at the
 * segment at all. If the plan moved by any means other than this engine — a manual advance, BACK,
 * a click in the cue list — the engine adopts that position, **zeroes its dwell clock and drops
 * any pending suggestion**. `docs/v2-notes/PLAN_LESSONS.md` records this as the exact mechanism by
 * which the prior project achieved "human always wins", and it is copied here on purpose. Without
 * it, an operator who takes over manually is still racing a suggestion formed a second ago.
 *
 * ## 3. Nothing can force an auto-fire
 *
 * `confirmAlways` and a below-threshold confidence can each BLOCK one; nothing may compel one.
 * `canAutoFire` on a suggestion is computed as a conjunction of every applicable gate, so a cue
 * may always be made SAFER than the service default and never more dangerous. For scripture the
 * decisive gate is `canAutoShow(reference, resolved)`: a confident reference whose text failed to
 * resolve is offered for confirmation, never shown by itself, because an empty scripture card on
 * the congregation screen is a failure invisible to the operator until someone tells them.
 *
 * ## Degrading well is a feature, not a fallback
 *
 * Off-script preaching breaks plan alignment. When that happens the plan-follower stops suggesting
 * and waits, while the scripture and hot-phrase detectors carry on — they need no plan at all. The
 * system never gets stuck, it gets quieter. Alignment recovers when the operator moves the plan by
 * hand, because that move is evidence about where the service actually is.
 *
 * ## Everything is a local structural seam
 *
 * The plan, the overlay, ASR, the scripture detector and the scripture resolver are five
 * interfaces declared in this file. Nothing here imports a concrete module written in parallel, so
 * the whole engine is driven in tests by trivial fakes with no Electron, no OBS, no network and no
 * microphone. Nothing throws across any of them: every seam call is wrapped and converted to a
 * `Result`.
 */

import type { TranscriptSegment } from '@shared/asr'
import {
  ALIGNMENT_LOST_AFTER,
  LOOK_AHEAD_CUES,
  MIN_AUTO_FIRE_GAP_MS,
  ANCHOR_MATCH_THRESHOLD,
  defaultCueEngineSettings,
  cueEngineSettingsSchema,
  idleCueEngineState,
  shouldAutoFire,
  syncToActual
} from '@shared/cue'
import type {
  AlignmentState,
  CueEngineSettings,
  CueEngineState,
  CueSuggestion,
  DetectorKind,
  TrustMode
} from '@shared/cue'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { OverlayCommand } from '@shared/overlay'
import { cueAt } from '@shared/plan'
import type { Cue, PlanPosition, ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'
import { canAutoShow, confidenceBand, formatReference } from '@shared/scripture'
import type { ResolvedScripture, ScriptureReference } from '@shared/scripture'

import { bestMatch, containsPhrase } from './fuzzy'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The part of the plan's state the engine reads.
 *
 * Structurally a subset of `PlanState` from `@shared/ipc`, so the real `PlanService` satisfies it
 * without either module knowing about the other.
 */
export interface CuePlanSnapshot {
  readonly plan: ServicePlan
  readonly position: PlanPosition
}

/**
 * The slice of the plan service the engine uses.
 *
 * Two methods, and only one of them changes anything. `fireCue` is the ONLY route by which this
 * engine can move the service, and it is the plan service — not the engine — that owns the
 * resulting position.
 */
export interface CuePlanLike {
  getState(): Result<CuePlanSnapshot>
  fireCue(cueId: string): Promise<Result<unknown>>
}

/**
 * The slice of the overlay server the engine uses.
 *
 * Used for exactly one thing: putting a confirmed scripture reference on the scripture layer.
 * Notably NOT used by {@link CueEngine.panic}, which halts automation and touches no output.
 */
export interface CueOverlayLike {
  send(command: OverlayCommand): Result<unknown>
}

/** The slice of the ASR service the engine subscribes to. Optional — the engine can be fed by hand. */
export interface CueAsrLike {
  onTranscript(callback: (segment: TranscriptSegment) => void): Unsubscribe
}

/**
 * The scripture detector seam.
 *
 * Deliberately minimal: one call, text in, REFERENCES out (Standing Rule 4 — a detector never
 * produces verse text). `now` is optional so a detector that keeps its own priming clock can take
 * it and one that does not can ignore it; a `detect(text)` implementation satisfies this type.
 */
export interface CueScriptureDetectorLike {
  detect(text: string, now?: number): readonly ScriptureReference[]
}

/**
 * The scripture resolver seam.
 *
 * Verse text is fetched at fire time from a licensed API or a verified public-domain source. It is
 * never authored, stored or committed in this repository, and this engine only ever holds the
 * string long enough to hand it to the overlay.
 */
export interface CueScriptureResolverLike {
  resolve(
    reference: ScriptureReference,
    translation?: string
  ): Promise<Result<ResolvedScripture>>
}

/** The timer surface, injected so the pending-suggestion clock is deterministic in tests. */
export interface CueTimers {
  setTimeout(handler: () => void, ms: number): CueTimerHandle
  clearTimeout(handle: CueTimerHandle): void
}

/** An opaque timer handle. `number` in a browser, `Timeout` in Node — the engine does not care. */
export type CueTimerHandle = unknown

/** The real timers. Split out so `index.ts` is the only place that reaches for globals. */
export const realCueTimers: CueTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** Constructor dependencies. Only `plan`, `overlay` and `logger` are required. */
export interface CueEngineOptions {
  readonly plan: CuePlanLike
  readonly overlay: CueOverlayLike
  readonly logger: Logger
  /** Omitted, the engine must be fed by calling {@link CueEngine.onTranscript} directly. */
  readonly asr?: CueAsrLike
  /** Omitted, the scripture detector is simply inert — the other two detectors are unaffected. */
  readonly scripture?: CueScriptureDetectorLike
  /** Omitted, references are still detected and offered; they can never auto-show (the gate). */
  readonly resolver?: CueScriptureResolverLike
  /** Epoch-milliseconds clock. */
  readonly now?: () => number
  readonly timers?: CueTimers
  /** Starting settings. Defaults to `defaultCueEngineSettings()` — assist mode. */
  readonly settings?: CueEngineSettings
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How much recent transcript the plan-follower matches against.
 *
 * An anchor phrase is often split across two or three ASR finals ("the first thing" / "I want us
 * to see"), so matching a single final would miss most of them. Twelve seconds is long enough to
 * span that and short enough that words from the previous cue have fallen out.
 */
export const ROLLING_WINDOW_MS = 12_000

/** Backstop on the rolling window's size, independent of the clock. */
export const MAX_WINDOW_SEGMENTS = 40

/**
 * How long a pending suggestion survives before it is dropped unfired.
 *
 * A suggestion is about a moment. Twenty seconds later the service has moved on, and offering the
 * operator a stale "confirm?" invites them to fire a cue for a moment that has passed. Expiry only
 * ever makes the engine quieter — it never fires anything.
 */
export const SUGGESTION_TTL_MS = 20_000

/** How many fired suggestions the "what just happened" readout keeps. */
export const MAX_RECENT_SUGGESTIONS = 20

/** Hot phrases are exact matches by definition, so they carry full confidence. */
export const HOT_PHRASE_CONFIDENCE = 1

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface WindowEntry {
  readonly id: string
  readonly text: string
  readonly at: number
}

/** A suggestion the detectors produced, before the single-pending rule is applied. */
interface Candidate {
  readonly detector: DetectorKind
  readonly cueId: string | null
  readonly reference: ScriptureReference | null
  readonly confidence: number
  readonly why: string
  readonly canAutoFire: boolean
}

export class CueEngine {
  private readonly planService: CuePlanLike
  private readonly overlay: CueOverlayLike
  private readonly log: Logger
  private readonly detector: CueScriptureDetectorLike | null
  private readonly resolver: CueScriptureResolverLike | null
  private readonly now: () => number
  private readonly timers: CueTimers

  private settings: CueEngineSettings
  private state: CueEngineState

  /** Recent finals, newest last. Keyed by segment id so a retraction can remove one. */
  private window: WindowEntry[] = []
  /** Consecutive finals that matched nothing in the look-ahead window. The dwell clock. */
  private misses = 0
  /** Epoch ms of the last auto-fire, for {@link MIN_AUTO_FIRE_GAP_MS}. */
  private lastAutoFireAt: number | null = null
  /** The mode to return to when {@link resume} is called. */
  private modeBeforePanic: TrustMode | null = null

  private suggestionSeq = 0
  private expiryTimer: CueTimerHandle | null = null
  private unsubscribeAsr: Unsubscribe | null = null
  private disposed = false

  private readonly stateSubscribers = new Set<(state: CueEngineState) => void>()
  private readonly suggestionSubscribers = new Set<(suggestion: CueSuggestion) => void>()

  constructor(options: CueEngineOptions) {
    this.planService = options.plan
    this.overlay = options.overlay
    this.log = options.logger.child('cue')
    this.detector = options.scripture ?? null
    this.resolver = options.resolver ?? null
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realCueTimers
    this.settings = options.settings ?? defaultCueEngineSettings()
    this.state = { ...idleCueEngineState(), mode: this.settings.mode }

    if (options.asr !== undefined) {
      try {
        this.unsubscribeAsr = options.asr.onTranscript((segment) => {
          void this.onTranscript(segment)
        })
      } catch (cause) {
        // A recogniser that cannot be subscribed to is a quiet engine, never a broken one.
        this.log.warn('could not subscribe to the transcript', { cause })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** The full engine state. Always a complete, serialisable snapshot. */
  getState(): Result<CueEngineState> {
    return ok(this.state)
  }

  getSettings(): Result<CueEngineSettings> {
    return ok(this.settings)
  }

  /** Subscribe to state changes. Published after every tick that changed anything. */
  onState(callback: (state: CueEngineState) => void): Unsubscribe {
    this.stateSubscribers.add(callback)
    return () => {
      this.stateSubscribers.delete(callback)
    }
  }

  /** Subscribe to newly formed suggestions, for the confirm banner. */
  onSuggestion(callback: (suggestion: CueSuggestion) => void): Unsubscribe {
    this.suggestionSubscribers.add(callback)
    return () => {
      this.suggestionSubscribers.delete(callback)
    }
  }

  // -------------------------------------------------------------------------
  // Settings and the trust dial
  // -------------------------------------------------------------------------

  /**
   * Replace the settings.
   *
   * Validated even though the caller is typed, because these arrive over IPC from the renderer.
   * While panicked the stored mode is updated but the ACTIVE mode stays `manual`: re-enabling the
   * AI after a panic is `resume()`, an explicit gesture, and never a side effect of touching a
   * settings field.
   */
  setSettings(settings: CueEngineSettings): Result<CueEngineSettings> {
    if (this.disposed) return this.disposedError()

    const parsed = cueEngineSettingsSchema.safeParse(settings)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return err(ErrorCode.INVALID_ARG, 'those cue engine settings are not valid', detail)
    }

    this.settings = parsed.data as CueEngineSettings
    if (!this.state.panicked) {
      this.setState({ mode: this.settings.mode })
    } else {
      this.modeBeforePanic = this.settings.mode
      this.publish()
    }
    this.log.info('cue engine settings updated', {
      mode: this.settings.mode,
      hotPhrases: this.settings.hotPhrases.length,
      scriptureAutoShow: this.settings.scriptureAutoShow
    })
    return ok(this.settings)
  }

  /** Turn the trust dial. Refused while panicked — see {@link resume}. */
  setMode(mode: TrustMode): Result<CueEngineState> {
    if (this.disposed) return this.disposedError()

    this.settings = { ...this.settings, mode }
    if (this.state.panicked) {
      this.modeBeforePanic = mode
      this.log.warn('the trust mode was changed while panicked; it takes effect on resume', { mode })
      return ok(this.publish())
    }
    this.log.info('the trust mode changed', { mode })
    return ok(this.setState({ mode }))
  }

  /**
   * The master panic switch: halt all automation, immediately.
   *
   * Sets `panicked`, forces the active mode to `manual` and drops any pending suggestion. It
   * **touches nothing else** — not the stream, not the recording, not the overlay. `docs/v2-notes`
   * records the same rule from the prior project: PANIC silences the AI, it does not black out the
   * broadcast, and the congregation screen keeps showing whatever it was showing. Blanking a
   * screen because an operator hit the emergency button would be its own emergency.
   *
   * Recovery is {@link resume} and nothing else. Panicking deliberately does not re-enable itself.
   */
  panic(): Result<CueEngineState> {
    if (this.disposed) return this.disposedError()

    if (!this.state.panicked) this.modeBeforePanic = this.state.mode
    this.clearExpiry()
    this.misses = 0
    this.log.warn('PANIC: cue automation halted; stream, recording and overlay untouched')
    return ok(this.setState({ panicked: true, mode: 'manual', pending: null }))
  }

  /** Leave panic and restore the trust mode. Explicit, operator-driven, never automatic. */
  resume(): Result<CueEngineState> {
    if (this.disposed) return this.disposedError()
    if (!this.state.panicked) return ok(this.state)

    const mode = this.modeBeforePanic ?? this.settings.mode
    this.modeBeforePanic = null
    this.misses = 0
    this.log.info('cue automation resumed by the operator', { mode })
    return ok(this.setState({ panicked: false, mode, lastError: null }))
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * The entry point: one transcript segment.
   *
   * **`syncToActual()` runs first, before anything else looks at the segment.** Everything below
   * it is downstream of the operator's actual position (see the module docblock).
   *
   * Drafts are for the UI and never drive detection — acting on a partial that the final is about
   * to replace is how an engine fires a cue on a word the speaker did not say. A final with EMPTY
   * text is Phase 7 RETRACTING a hallucination: the segment is removed from the rolling window and
   * the tick ends. It is not speech, so it is not a miss, and it must not push the plan-follower
   * toward `lost`.
   */
  async onTranscript(segment: TranscriptSegment): Promise<Result<CueEngineState>> {
    if (this.disposed) return this.disposedError()

    // ---- 1. Human always wins. This must be the first thing that happens, every time. ----
    this.resync()

    if (!segment.isFinal || segment.isDraft) return ok(this.state)

    const text = segment.text.trim()
    if (text.length === 0) {
      this.retract(segment.id)
      return ok(this.state)
    }

    if (!this.state.enabled || this.state.panicked) return ok(this.state)

    // ---- 2. Rolling window ----
    const at = this.now()
    this.remember({ id: segment.id, text, at })

    // ---- 3. Three parallel detectors, each independent of the others ----
    const snapshot = this.planSnapshot()
    const candidates: Candidate[] = []

    const scripture = await this.detectScripture(text)
    if (scripture !== null) candidates.push(scripture)

    if (snapshot !== null) {
      const hot = this.detectHotPhrase(text, snapshot.plan)
      if (hot !== null) candidates.push(hot)

      const planned = this.followPlan(snapshot)
      if (planned !== null) candidates.push(planned)
    }

    // ---- 4. At most one pending suggestion ----
    const winner = pickBest(candidates)
    if (winner !== null) this.offer(winner, at)

    // ---- 5. Auto-fire, only if every gate says yes ----
    const pending = this.state.pending
    if (pending !== null && shouldAutoFire(pending, this.state.mode, this.state.panicked)) {
      const since = this.lastAutoFireAt === null ? Infinity : at - this.lastAutoFireAt
      if (since >= MIN_AUTO_FIRE_GAP_MS) {
        this.lastAutoFireAt = at
        return this.applySuggestion(pending, 'auto')
      }
      // Deliberately NOT queued for later. A cue held back by the dwell floor and fired a second
      // afterwards is a cue firing at a moment nobody chose. It stays pending, and the operator
      // can confirm it if they still want it.
      this.log.debug('an auto-fire was held back by the minimum gap', {
        suggestion: pending.id,
        sinceMs: since
      })
    }

    this.publish()
    return ok(this.state)
  }

  // -------------------------------------------------------------------------
  // Operator decisions
  // -------------------------------------------------------------------------

  /**
   * Confirm the pending suggestion.
   *
   * A stale id — the suggestion was already replaced by a better one, or dropped by a manual plan
   * move — is a harmless no-op returning the current state, NOT an error. The operator pressed Y a
   * beat after the world changed; that is not a fault condition and must not raise a dialog in the
   * middle of a service.
   *
   * Confirming ignores `canAutoFire` on purpose: that flag governs whether the engine may act by
   * itself, and the operator asking for something is not the engine acting by itself.
   */
  async confirm(suggestionId: string): Promise<Result<CueEngineState>> {
    if (this.disposed) return this.disposedError()

    const pending = this.state.pending
    if (pending === null || pending.id !== suggestionId) {
      this.log.debug('a confirm arrived for a suggestion that is no longer pending', {
        suggestionId
      })
      return ok(this.state)
    }
    return this.applySuggestion(pending, 'operator')
  }

  /** Dismiss the pending suggestion. A stale id is a harmless no-op, exactly as with `confirm`. */
  dismiss(suggestionId: string): Result<CueEngineState> {
    if (this.disposed) return this.disposedError()

    const pending = this.state.pending
    if (pending === null || pending.id !== suggestionId) return ok(this.state)

    this.clearExpiry()
    this.log.info('a suggestion was dismissed', { id: pending.id, detector: pending.detector })
    return ok(this.setState({ pending: null }))
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Release subscribers and timers. Leaves the overlay and the plan exactly as they are. */
  dispose(): void {
    this.disposed = true
    this.clearExpiry()
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
    this.suggestionSubscribers.clear()
  }

  // -------------------------------------------------------------------------
  // Human always wins
  // -------------------------------------------------------------------------

  /**
   * Adopt the plan's real position, dropping anything formed against the old one.
   *
   * The comparison is against the position the ENGINE believes, so this fires exactly when someone
   * else moved the plan. `syncToActual` in `@shared/cue` does the state surgery — including
   * lifting `lost` back to `aligned`, because a manual move is evidence about where the service is
   * — and this method zeroes the dwell clock alongside it.
   */
  private resync(): void {
    const snapshot = this.planSnapshot()
    if (snapshot === null) return

    const actual = snapshot.position.index
    if (actual === this.state.position) return

    const before = this.state.pending
    const synced = syncToActual(this.state, actual)
    this.misses = 0
    if (before !== null) this.clearExpiry()
    this.state = synced
    this.log.info('the plan moved outside the engine; re-syncing and dropping any suggestion', {
      position: actual,
      dropped: before?.id ?? null
    })
    this.publish()
  }

  // -------------------------------------------------------------------------
  // Detector 1 — the plan-follower
  // -------------------------------------------------------------------------

  /**
   * Fuzzy-match the recent transcript against the next {@link LOOK_AHEAD_CUES} anchored cues.
   *
   * The window is small on purpose: a wide one finds a match for almost anything, which is how an
   * engine ends up confidently jumping to the closing hymn during the sermon.
   *
   * After {@link ALIGNMENT_LOST_AFTER} consecutive non-matching finals the alignment is declared
   * `lost` and this detector returns `null` for good — until a manual plan move re-anchors it. The
   * scripture and hot-phrase detectors are untouched by that; they need no plan.
   */
  private followPlan(snapshot: CuePlanSnapshot): Candidate | null {
    const lookAhead = this.lookAhead(snapshot)

    if (lookAhead.length === 0) {
      // Nothing anchored ahead of us. Not a miss — there was nothing to miss. `no-plan` only when
      // the whole plan carries no anchors at all, so an all-manual stretch mid-service does not
      // make the panel claim there is no plan.
      if (!hasAnchors(snapshot.plan)) this.setAlignment('no-plan')
      return null
    }
    switch (this.state.alignment) {
      case 'no-plan':
        // There is a plan and it has anchors ahead of us, so `no-plan` is no longer true whatever
        // happens below. Tracking-but-not-yet-matched is `aligned`, not `no-plan`: the panel must
        // distinguish "there is nothing to follow" from "following, nothing seen yet".
        this.setAlignment('aligned')
        break
      case 'lost':
        return null
      default:
        break
    }

    const span = this.windowText()
    const { index, score } = bestMatch(
      span,
      lookAhead.map((entry) => entry.anchor)
    )
    const hit = index < 0 ? undefined : lookAhead[index]

    if (hit === undefined || score < ANCHOR_MATCH_THRESHOLD) {
      this.misses += 1
      if (this.misses >= ALIGNMENT_LOST_AFTER) {
        // Logged on the transition only — the switch above already returned for a `lost`
        // alignment, so reaching here with exactly the budget is the moment it was lost.
        if (this.misses === ALIGNMENT_LOST_AFTER) {
          this.log.info('plan alignment lost; the plan-follower is waiting', {
            misses: this.misses,
            position: this.state.position
          })
        }
        this.setAlignment('lost')
      }
      return null
    }

    this.misses = 0
    this.setAlignment('aligned')
    return {
      detector: 'plan',
      cueId: hit.cue.id,
      reference: null,
      confidence: score,
      why: `matched "${hit.anchor}"`,
      canAutoFire: this.cueMayAutoFire(hit.cue, score)
    }
  }

  /** The next few anchored cues after the pointer, in service order. */
  private lookAhead(snapshot: CuePlanSnapshot): readonly { cue: Cue; anchor: string }[] {
    const entries: { cue: Cue; anchor: string }[] = []
    const from = this.state.position + 1
    for (let index = from; index < from + LOOK_AHEAD_CUES; index += 1) {
      const cue = cueAt(snapshot.plan, index)
      if (cue === null) break
      if (cue.trigger.mode !== 'anchor') continue
      const anchor = (cue.trigger.text ?? '').trim()
      if (anchor.length === 0) continue
      entries.push({ cue, anchor })
    }
    return entries
  }

  // -------------------------------------------------------------------------
  // Detector 2 — scripture
  // -------------------------------------------------------------------------

  /**
   * Detect a reference in the latest final, then try to resolve its text.
   *
   * Standing Rule 4 in one method: the detector produces a REFERENCE; the text — if any — comes
   * from the resolver at runtime and is never authored here.
   *
   * `canAutoFire` is `canAutoShow(reference, resolved)`, the hard gate from `@shared/scripture`,
   * additionally conjoined with the operator's `scriptureAutoShow` preference. Conjunction only:
   * a preference can make this safer, and nothing here can make it more dangerous. A confident
   * reference whose text failed to resolve therefore reaches the operator as a suggestion and can
   * never fire itself.
   */
  private async detectScripture(text: string): Promise<Candidate | null> {
    const detector = this.detector
    if (detector === null) return null

    let hits: readonly ScriptureReference[]
    try {
      hits = detector.detect(text, this.now())
    } catch (cause) {
      this.log.warn('the scripture detector threw; ignoring this segment', { cause })
      return null
    }

    // Below CONFIDENCE_DISCARD `confidenceBand` returns null, and the reference is dropped in
    // silence. Not shown in grey — a stream of low-confidence guesses trains the operator to
    // ignore the panel, which costs more than the occasional missed reference.
    let best: ScriptureReference | null = null
    for (const hit of hits) {
      if (confidenceBand(hit.confidence) === null) continue
      if (best === null || hit.confidence > best.confidence) best = hit
    }
    if (best === null) return null

    const resolved = await this.resolveVerseText(best)
    const gate = canAutoShow(best, resolved)

    return {
      detector: 'scripture',
      cueId: null,
      reference: best,
      confidence: best.confidence,
      why: `heard ${formatReference(best)}${resolved === null ? ' (verse text unavailable)' : ''}`,
      canAutoFire: this.settings.scriptureAutoShow && gate
    }
  }

  /**
   * Fetch verse text for a reference — the IPC-facing verb.
   *
   * Standing Rule 4: the text comes from a licensed API or a verified public-domain source at
   * runtime and is never authored here. With no resolver attached this reports `NOT_CONFIGURED`
   * rather than failing in some louder way — a machine with no key and no downloaded translation
   * still detects references and still offers them for confirmation (Standing Rule 5).
   */
  async resolveScripture(
    reference: ScriptureReference,
    translation?: string
  ): Promise<Result<ResolvedScripture>> {
    if (this.disposed) return this.disposedError()

    const resolver = this.resolver
    if (resolver === null) {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'no Bible translation is available to resolve verse text',
        'add an ESV or API.Bible key, or download a verified public-domain translation'
      )
    }
    try {
      const result = await resolver.resolve(reference, translation ?? this.settings.translation)
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, 'the scripture resolver did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  /**
   * Resolve verse text, or `null`. The engine's internal view of {@link resolveScripture}.
   *
   * A missing resolver, a refusal and a thrown provider are all the same answer here: no text.
   * That answer is not an error — it closes the `canAutoShow` gate and the reference is offered
   * for confirmation instead, which is the designed behaviour and not a degraded one.
   */
  private async resolveVerseText(reference: ScriptureReference): Promise<ResolvedScripture | null> {
    const resolved = await this.resolveScripture(reference)
    if (resolved.ok) return resolved.value
    if (resolved.error.code !== ErrorCode.NOT_CONFIGURED) {
      this.log.debug('verse text could not be resolved; the reference will need confirmation', {
        code: resolved.error.code
      })
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Detector 3 — hot phrases
  // -------------------------------------------------------------------------

  /**
   * Exact substring match over the configured phrases, against the latest final only.
   *
   * Simple and exact by design: a hot phrase is something the operator typed and the speaker says
   * on purpose. Matching the latest final rather than the rolling window means one utterance
   * produces one suggestion instead of re-offering the same phrase for the next twelve seconds.
   *
   * Matching is via `containsPhrase`, which ignores case, punctuation and word spacing — the last
   * of which is what makes Korean phrases like "받으실 말씀은" match reliably.
   */
  private detectHotPhrase(text: string, plan: ServicePlan): Candidate | null {
    for (const phrase of this.settings.hotPhrases) {
      if (!phrase.enabled) continue
      if (!containsPhrase(text, phrase.phrase)) continue

      const cue = plan.cues.find((candidate) => candidate.id === phrase.cueId)
      if (cue === undefined) {
        this.log.warn('a hot phrase points at a cue that is not in this plan', {
          phrase: phrase.id,
          cueId: phrase.cueId
        })
        continue
      }
      return {
        detector: 'hotphrase',
        cueId: cue.id,
        reference: null,
        confidence: HOT_PHRASE_CONFIDENCE,
        why: `heard the hot phrase "${phrase.phrase}"`,
        canAutoFire: this.cueMayAutoFire(cue, HOT_PHRASE_CONFIDENCE)
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  /**
   * Whether a plan cue may fire itself at this confidence.
   *
   * `confirmAlways` wins over everything, and the cue's own threshold wins over the service
   * default. Both are one-directional: they can only refuse. Nothing in this method can return
   * `true` for a cue whose author asked for a confirmation.
   */
  private cueMayAutoFire(cue: Cue, confidence: number): boolean {
    if (cue.options?.confirmAlways === true) return false
    const threshold = cue.options?.autoFireThreshold ?? this.settings.autoFireThreshold
    return confidence >= threshold
  }

  /**
   * Install a candidate as the pending suggestion — or decline to.
   *
   * Only one may be pending. A strictly higher-confidence candidate replaces the incumbent; an
   * equal or lower one does not. Thrashing the operator's decision — swapping what the confirm
   * button does while their thumb is moving toward it — is worse than missing a marginally better
   * suggestion.
   */
  private offer(candidate: Candidate, at: number): void {
    const pending = this.state.pending
    if (pending !== null && candidate.confidence <= pending.confidence) return

    this.suggestionSeq += 1
    const suggestion: CueSuggestion = {
      id: `cue-${this.suggestionSeq}`,
      detector: candidate.detector,
      cueId: candidate.cueId,
      reference: candidate.reference,
      confidence: candidate.confidence,
      why: candidate.why,
      at,
      canAutoFire: candidate.canAutoFire
    }

    this.armExpiry()
    this.state = { ...this.state, pending: suggestion }
    this.log.info('a cue was suggested', {
      id: suggestion.id,
      detector: suggestion.detector,
      cueId: suggestion.cueId,
      confidence: Number(suggestion.confidence.toFixed(3)),
      canAutoFire: suggestion.canAutoFire
    })

    for (const subscriber of [...this.suggestionSubscribers]) {
      try {
        subscriber(suggestion)
      } catch (cause) {
        this.log.warn('a suggestion subscriber threw', { cause })
      }
    }
  }

  /**
   * Perform a suggestion, then adopt whatever position the plan service ended up at.
   *
   * Adopting the position here — rather than assuming it — is what keeps the next tick's
   * `syncToActual` quiet: the engine agrees with the plan because it asked, not because it
   * predicted. A failed fire still clears the pending suggestion and still records the error;
   * leaving a dead suggestion on screen for the operator to press again would be worse.
   */
  private async applySuggestion(
    suggestion: CueSuggestion,
    origin: 'auto' | 'operator'
  ): Promise<Result<CueEngineState>> {
    this.clearExpiry()
    this.state = { ...this.state, pending: null }

    const outcome =
      suggestion.detector === 'scripture'
        ? await this.showScripture(suggestion)
        : await this.fireCue(suggestion)
    this.misses = 0

    const snapshot = this.planSnapshot()
    const position = snapshot?.position.index ?? this.state.position

    if (!outcome.ok) {
      this.log.error('a suggestion could not be performed', {
        id: suggestion.id,
        origin,
        code: outcome.error.code,
        message: outcome.error.message
      })
      this.setState({ position, lastError: outcome.error.message })
      return { ok: false, error: outcome.error }
    }

    this.log.info('a suggestion was performed', {
      id: suggestion.id,
      origin,
      detector: suggestion.detector,
      cueId: suggestion.cueId
    })
    return ok(
      this.setState({
        position,
        lastError: null,
        recent: [suggestion, ...this.state.recent].slice(0, MAX_RECENT_SUGGESTIONS)
      })
    )
  }

  private async fireCue(suggestion: CueSuggestion): Promise<Result<unknown>> {
    const cueId = suggestion.cueId
    if (cueId === null) {
      return err(ErrorCode.INVALID_ARG, 'this suggestion names no cue to fire', suggestion.id)
    }
    try {
      const result = await this.planService.fireCue(cueId)
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, 'the plan service did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  /**
   * Put a detected reference on the scripture layer.
   *
   * The text sent is whatever the resolver supplied, re-resolved at fire time so the operator gets
   * the freshest answer rather than one cached when the words were spoken. When nothing resolves,
   * the reference is still shown with an empty text — the same thing a hand-authored scripture cue
   * does in `PlanService`. That is acceptable **only** on this path, because a human explicitly
   * asked for it; the auto path is closed by `canAutoShow` precisely so it can never happen by
   * itself.
   */
  private async showScripture(suggestion: CueSuggestion): Promise<Result<unknown>> {
    const reference = suggestion.reference
    if (reference === null) {
      return err(ErrorCode.INVALID_ARG, 'this suggestion carries no reference', suggestion.id)
    }

    const resolved = await this.resolveVerseText(reference)
    const command: OverlayCommand = {
      channel: 'command',
      name: 'scripture.show',
      payload: {
        reference: formatReference(reference),
        text: resolved?.text ?? '',
        translation: resolved?.translation ?? this.settings.translation,
        attribution: resolved?.attribution ?? null
      }
    }
    try {
      const result = this.overlay.send(command)
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return err(ErrorCode.INTERNAL, 'the overlay did not return a Result')
      }
      return result
    } catch (cause) {
      return { ok: false, error: toAppError(cause, ErrorCode.INTERNAL) }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read the plan, converting any failure into "no plan" rather than an exception. */
  private planSnapshot(): CuePlanSnapshot | null {
    try {
      const result = this.planService.getState()
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return null
      }
      return result.ok ? result.value : null
    } catch (cause) {
      this.log.warn('the plan service threw while reporting its state', { cause })
      return null
    }
  }

  private remember(entry: WindowEntry): void {
    const cutoff = entry.at - ROLLING_WINDOW_MS
    this.window = this.window.filter((held) => held.id !== entry.id && held.at >= cutoff)
    this.window.push(entry)
    if (this.window.length > MAX_WINDOW_SEGMENTS) {
      this.window = this.window.slice(this.window.length - MAX_WINDOW_SEGMENTS)
    }
  }

  /**
   * Drop a retracted segment from the window.
   *
   * Phase 7 emits a final with empty text when it withdraws a hallucination. Removing the segment
   * rather than ignoring the retraction matters: the withdrawn words must not keep contributing to
   * the plan-follower's span for the next twelve seconds.
   */
  private retract(id: string): void {
    const before = this.window.length
    this.window = this.window.filter((entry) => entry.id !== id)
    if (this.window.length !== before) {
      this.log.debug('a transcript segment was retracted', { id })
    }
  }

  private windowText(): string {
    return this.window.map((entry) => entry.text).join(' ')
  }

  private setAlignment(alignment: AlignmentState): void {
    if (this.state.alignment === alignment) return
    this.state = { ...this.state, alignment }
  }

  /** Merge a patch into the state and publish it. */
  private setState(patch: Partial<CueEngineState>): CueEngineState {
    this.state = { ...this.state, ...patch }
    return this.publish()
  }

  private publish(): CueEngineState {
    const snapshot = this.state
    for (const subscriber of [...this.stateSubscribers]) {
      try {
        subscriber(snapshot)
      } catch (cause) {
        this.log.warn('a cue state subscriber threw', { cause })
      }
    }
    return snapshot
  }

  /** Start (or restart) the pending suggestion's expiry clock. */
  private armExpiry(): void {
    this.clearExpiry()
    try {
      this.expiryTimer = this.timers.setTimeout(() => {
        this.expiryTimer = null
        if (this.disposed || this.state.pending === null) return
        this.log.info('a suggestion expired unconfirmed', { id: this.state.pending.id })
        this.setState({ pending: null })
      }, SUGGESTION_TTL_MS)
    } catch (cause) {
      // No timer means a suggestion lingers until something replaces it. Strictly less safe than
      // expiring, strictly safer than crashing — and it still cannot fire by itself.
      this.log.warn('could not arm the suggestion expiry timer', { cause })
    }
  }

  private clearExpiry(): void {
    const handle = this.expiryTimer
    this.expiryTimer = null
    if (handle === null) return
    try {
      this.timers.clearTimeout(handle)
    } catch {
      /* a failing clear must not fail a tick */
    }
  }

  private disposedError(): Result<never> {
    return err(ErrorCode.INTERNAL, 'the cue engine has been disposed')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The strongest candidate of a tick.
 *
 * Ties break by detector order — scripture, then hot phrase, then plan. A detected reference and a
 * hot phrase are both direct evidence of something the speaker actually said; a plan match is an
 * inference about where we are in a document.
 */
const DETECTOR_PRIORITY: Record<DetectorKind, number> = { scripture: 0, hotphrase: 1, plan: 2 }

function pickBest(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate
      continue
    }
    if (candidate.confidence > best.confidence) {
      best = candidate
      continue
    }
    if (
      candidate.confidence === best.confidence &&
      DETECTOR_PRIORITY[candidate.detector] < DETECTOR_PRIORITY[best.detector]
    ) {
      best = candidate
    }
  }
  return best
}

/** Whether any cue in the plan carries an anchor for the plan-follower to match. */
function hasAnchors(plan: ServicePlan): boolean {
  return plan.cues.some(
    (cue) => cue.trigger.mode === 'anchor' && (cue.trigger.text ?? '').trim().length > 0
  )
}
