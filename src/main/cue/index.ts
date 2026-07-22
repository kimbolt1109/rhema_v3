/**
 * The cue module's public surface, and the one place the engine is wired to the rest of the app.
 *
 * {@link CueEngine} itself knows nothing about `PlanService`, the overlay server or the ASR
 * service — it holds five local structural seams and is driven in tests by trivial fakes. This
 * file supplies the real ones.
 *
 * ## The singleton is lazy and inert
 *
 * Constructing it opens no socket, reads no file, spawns nothing and starts no timer. It resolves
 * three sibling singletons (each itself inert), subscribes to an in-process transcript emitter,
 * and returns. The engine does nothing at all until a transcript final arrives, and it never
 * *applies* anything until the operator confirms or `shouldAutoFire()` permits it.
 *
 * ## The transcript source and the detector are DEFAULTED here
 *
 * Both were originally left for a caller to inject, and both were then injected by nobody — so
 * the engine ran in production subscribed to no transcript and holding no scripture detector: a
 * brain with no ears and no eyes, while every unit test passed, because the tests supply their own
 * fakes and call `onTranscript()` directly.
 *
 * They are therefore defaulted alongside `plan` and `overlay`. Overriding them is still possible
 * and is what the tests do; omitting them now yields a working engine rather than an inert one.
 *
 * ## The resolver is still injected, and that is deliberate
 *
 * It reaches the network and reads a translation catalogue, so `src/main/ipc/register.ts` supplies
 * it when one is configured. Standing Rule 5: a build with no ESV / API.Bible key and no verified
 * public-domain translation on disk must still run. Without a resolver, references are detected
 * and offered for confirmation, and `canAutoShow()` simply never lets one show itself — which is
 * exactly the gate that rule wants.
 */

import { getAsrService } from '@main/asr'
import { getOverlayServer } from '@main/overlay'
import { getPlanService } from '@main/plan'
import { createNullLogger } from '@main/logging/logger'
import type { CueEngineSettings } from '@shared/cue'
import type { Logger } from '@shared/log'
import type { ScriptureReference } from '@shared/scripture'

import { CueEngine } from './CueEngine'
import { detect as detectScripture } from './scriptureDetector'
import type {
  CueAsrLike,
  CueOverlayLike,
  CuePlanLike,
  CueScriptureDetectorLike,
  CueScriptureResolverLike,
  CueTimers
} from './CueEngine'

export {
  CueEngine,
  HOT_PHRASE_CONFIDENCE,
  MAX_RECENT_SUGGESTIONS,
  MAX_WINDOW_SEGMENTS,
  ROLLING_WINDOW_MS,
  SUGGESTION_TTL_MS,
  realCueTimers
} from './CueEngine'
export type {
  CueAsrLike,
  CueEngineOptions,
  CueOverlayLike,
  CuePlanLike,
  CuePlanSnapshot,
  CueScriptureDetectorLike,
  CueScriptureResolverLike,
  CueTimerHandle,
  CueTimers
} from './CueEngine'
export {
  MAX_ANCHOR_TOKENS,
  MAX_FUZZY_COMPARISONS,
  MAX_LEVENSHTEIN_LENGTH,
  MAX_SPAN_TOKENS,
  MAX_TOKEN_LENGTH_DELTA,
  MIN_TOKEN_SIMILARITY,
  bestMatch,
  containsPhrase,
  levenshtein,
  levenshteinSimilarity,
  normaliseText,
  similarity,
  tokenise,
  uniqueTokens
} from './fuzzy'

/** Overrides for {@link getCueEngine}. Every field has a production default. */
export interface GetCueEngineOptions {
  /**
   * Where the engine's diagnostics go.
   *
   * Defaults to the null logger, because the rolling-file logger is built inside `app.whenReady()`
   * and there is no module-level singleton to reach for. Pass the real one so every suggestion and
   * every fire on a Sunday is in the service-day log.
   */
  readonly logger?: Logger
  readonly plan?: CuePlanLike
  readonly overlay?: CueOverlayLike
  readonly asr?: CueAsrLike
  /** Omitted, the scripture detector is inert; the other two detectors are unaffected. */
  readonly scripture?: CueScriptureDetectorLike
  /** Omitted, references are detected and offered but can never auto-show (the hard gate). */
  readonly resolver?: CueScriptureResolverLike
  readonly settings?: CueEngineSettings
  readonly now?: () => number
  readonly timers?: CueTimers
}

let singleton: CueEngine | null = null

/**
 * The process-wide cue engine.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it. Construction
 * performs no I/O.
 */
export function getCueEngine(options: GetCueEngineOptions = {}): CueEngine {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()
  const plan = options.plan ?? getPlanService({ logger })
  const overlay = options.overlay ?? getOverlayServer({ logger })

  // The ASR service is defaulted here for the same reason `plan` and `overlay` are: without it
  // the engine subscribes to nothing, never sees a transcript, and silently suggests nothing —
  // an inert brain that every unit test still passes, because the tests drive `onTranscript()`
  // directly. Wiring it here is what makes the engine live in the running app.
  const asr = options.asr ?? getAsrService({ logger })

  // The scripture detector is defaulted for the same reason. BLUEPRINT.md §4 calls scripture
  // detection "often the single highest-value feature" — it is the one that works when the pastor
  // goes entirely off-script. Left unwired it is silently inert, and no test catches that because
  // every engine test injects a detector explicitly.
  //
  // The detector is pure and free to construct. The RESOLVER is not defaulted here: it reaches the
  // network and reads a translation catalogue, so `src/main/ipc/register.ts` supplies it when one
  // is configured. Without a resolver, references are still detected and offered for confirmation
  // — `canAutoShow()` simply never lets one show itself, which is exactly the intended gate.
  const scripture: CueScriptureDetectorLike = options.scripture ?? {
    detect: (text: string, now?: number): readonly ScriptureReference[] =>
      detectScripture(text, { now: now ?? Date.now() })
  }

  singleton = new CueEngine({
    plan,
    overlay,
    logger,
    asr,
    scripture,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    now: options.now ?? Date.now
  })
  return singleton
}

/**
 * Drop the singleton, disposing it first.
 *
 * Disposing releases subscribers and the pending-suggestion timer. It deliberately leaves the
 * overlay showing whatever it is showing and the plan pointer where it is: the engine going away
 * is never a reason to change what the congregation can see.
 */
export function resetCueEngine(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
