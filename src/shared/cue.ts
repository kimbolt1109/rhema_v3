/**
 * The cue engine contract — the trust dial and the three parallel detectors.
 *
 * BLUEPRINT.md §4. This is the brain: it watches the transcript and decides what to suggest or
 * fire. It is also the most dangerous component in the product, because a wrong automated action
 * mid-service is unacceptable and un-undoable in front of a congregation.
 *
 * ## Human always wins — the mechanism, not the slogan
 *
 * `docs/v2-notes/PLAN_LESSONS.md` records how the prior project actually achieved this, and it is
 * worth copying exactly: **the engine never writes authoritative state.** It emits an INTENT
 * ({@link CueSuggestion}); something else applies it. And on every tick the engine first
 * re-syncs to reality — if the operator moved the plan by hand, the engine snaps its pointer to
 * where they are, **resets its dwell clock to zero, and clears any pending suggestion**.
 *
 * That last part is what makes manual override trustworthy. Without it, an operator who takes
 * over manually is still racing a suggestion the engine formed a second ago.
 *
 * ## Why it degrades well
 *
 * Off-script preaching breaks plan alignment. When that happens the plan-follower quietly waits
 * while the scripture and hot-phrase detectors keep working — they need no plan at all. The
 * system never gets stuck, it just gets quieter.
 *
 * Node-global free.
 */

import { z } from 'zod'

import type { ScriptureReference } from './scripture'

/**
 * How much autonomy the engine has.
 *
 * `assist` is the default everywhere and the only mode that should be recommended: it highlights
 * the next likely cue and waits for a tap or a pedal. Massive workload cut, near-zero risk.
 */
export const TRUST_MODES = ['assist', 'auto', 'manual'] as const

/** Union of the trust modes. */
export type TrustMode = (typeof TRUST_MODES)[number]

/** Which detector produced a suggestion. */
export const DETECTOR_KINDS = ['plan', 'scripture', 'hotphrase'] as const

/** Union of the detector kinds. */
export type DetectorKind = (typeof DETECTOR_KINDS)[number]

/**
 * A proposed action. **An intent, never an applied change.**
 *
 * The engine emits these; the operator (or, in `auto`, the applier) decides. Keeping suggestion
 * and application separate is what allows a veto to be genuinely instant.
 */
export interface CueSuggestion {
  readonly id: string
  readonly detector: DetectorKind
  /** The plan cue this would fire, when the suggestion came from the plan or a hot phrase. */
  readonly cueId: string | null
  /** The detected reference, when the suggestion came from the scripture detector. */
  readonly reference: ScriptureReference | null
  readonly confidence: number
  /** Operator-facing reason, e.g. `matched "the first thing I want us to see"`. */
  readonly why: string
  /** Epoch ms the suggestion was formed. */
  readonly at: number
  /**
   * Whether this may fire itself in `auto`.
   *
   * Computed by the engine from the cue's own `autoFireThreshold` / `confirmAlways` and, for
   * scripture, the resolved-text gate. A suggestion that reaches the UI with `false` here is
   * offered for confirmation and can never self-fire, whatever the mode.
   */
  readonly canAutoFire: boolean
}

/** Why the plan-follower is not currently tracking. */
export type AlignmentState =
  /** Following the plan; the pointer is trusted. */
  | 'aligned'
  /** Recent transcript does not match the look-ahead window — the speaker went off-script. */
  | 'lost'
  /** No plan is loaded, or it has no anchor triggers. */
  | 'no-plan'

/** Everything the operator needs to see about the engine. */
export interface CueEngineState {
  readonly enabled: boolean
  readonly mode: TrustMode
  readonly alignment: AlignmentState
  /** Index into the plan the engine believes the speaker has reached. -1 before the first cue. */
  readonly position: number
  /** The pending suggestion awaiting confirmation, or null. At most one at a time. */
  readonly pending: CueSuggestion | null
  /** Recently fired suggestions, newest first, for the "what just happened" readout and undo. */
  readonly recent: readonly CueSuggestion[]
  /** Set when the master panic switch has forced full manual. */
  readonly panicked: boolean
  readonly lastError: string | null
}

/** The resting state: enabled, assisting, nothing pending. */
export function idleCueEngineState(): CueEngineState {
  return {
    enabled: true,
    mode: 'assist',
    alignment: 'no-plan',
    position: -1,
    pending: null,
    recent: [],
    panicked: false,
    lastError: null,
  }
}

/**
 * How far ahead of the pointer the plan-follower looks.
 *
 * Small on purpose. A wide window finds a match for almost anything, which is how an engine ends
 * up confidently jumping to the closing hymn during the sermon. Three cues covers a natural
 * "skipped one" without inviting a leap across the service.
 */
export const LOOK_AHEAD_CUES = 3

/**
 * Fuzzy-match score a transcript span must reach to move the pointer.
 *
 * Deliberately higher than the scripture `fuzzy` band: a mis-fired slide is more disruptive than
 * a mis-offered verse, because the slide is what the congregation is reading.
 */
export const ANCHOR_MATCH_THRESHOLD = 0.78

/**
 * Consecutive non-matching finals before alignment is declared `lost`.
 *
 * Three is enough to ride out one garbled sentence without pretending to follow a sermon that has
 * left the script entirely.
 */
export const ALIGNMENT_LOST_AFTER = 3

/**
 * Minimum gap between two auto-fires.
 *
 * A dwell floor. Without it a burst of transcript can fire three cues in a second, and the
 * congregation sees a slideshow flicker past. It also gives the operator time to veto.
 */
export const MIN_AUTO_FIRE_GAP_MS = 2500

/** A configured phrase that fires an action. */
export interface HotPhrase {
  readonly id: string
  /** Matched case-insensitively against the recent transcript. */
  readonly phrase: string
  /** The plan cue to fire. */
  readonly cueId: string
  readonly enabled: boolean
}

/** Operator-tunable engine settings. */
export interface CueEngineSettings {
  readonly mode: TrustMode
  readonly hotPhrases: readonly HotPhrase[]
  /** Default auto-fire threshold when a cue does not specify its own. */
  readonly autoFireThreshold: number
  /** Whether the scripture detector may auto-show at all (subject to the resolved-text gate). */
  readonly scriptureAutoShow: boolean
  /** Preferred translation code for resolution. */
  readonly translation: string
}

/** Defaults: assist mode, no hot phrases yet, conservative threshold. */
export function defaultCueEngineSettings(): CueEngineSettings {
  return {
    mode: 'assist',
    hotPhrases: [],
    autoFireThreshold: 0.85,
    scriptureAutoShow: false,
    translation: 'KJV',
  }
}

/** Validation for the settings at the IPC boundary. */
export const cueEngineSettingsSchema = z.object({
  mode: z.enum(TRUST_MODES),
  hotPhrases: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        phrase: z.string().min(2).max(120),
        cueId: z.string().min(1).max(64),
        enabled: z.boolean(),
      }),
    )
    .max(200),
  autoFireThreshold: z.number().min(0).max(1),
  scriptureAutoShow: z.boolean(),
  translation: z.string().min(1).max(20),
})

/**
 * Whether a suggestion may fire without confirmation, given the mode.
 *
 * The asymmetry is the safety property: `confirmAlways` and a below-threshold confidence can each
 * BLOCK an auto-fire, but nothing can force one. A cue may always be made safer than the service
 * default; never more dangerous.
 */
export function shouldAutoFire(
  suggestion: CueSuggestion,
  mode: TrustMode,
  panicked: boolean,
): boolean {
  if (panicked) return false
  if (mode !== 'auto') return false
  return suggestion.canAutoFire
}

/**
 * Re-sync the engine's pointer to where the operator actually is.
 *
 * Called FIRST on every tick, before any detection. If the plan moved by any means other than
 * this engine — a manual advance, a BACK, a click in the cue list — the engine adopts that
 * position, **zeroes its dwell clock and drops any pending suggestion.**
 *
 * Returns the corrected state. This function is the whole of "human always wins": everything
 * else in the engine is downstream of it.
 */
export function syncToActual(state: CueEngineState, actualPosition: number): CueEngineState {
  if (state.position === actualPosition) return state
  return {
    ...state,
    position: actualPosition,
    // Dropped deliberately: a suggestion formed against the old position is not merely stale,
    // it is about a different moment in the service.
    pending: null,
    // The operator taking manual control is evidence about where we are, not a failure.
    alignment: state.alignment === 'lost' ? 'aligned' : state.alignment,
  }
}
