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
 * ## The resolver is defaulted too, as of Phase 10
 *
 * It was left for a caller to inject and, predictably, nobody injected it — so a detected
 * reference was offered with no text and `Resolve scripture` answered *not configured* even with
 * a key present. `getScriptureResolver()` is now the default.
 *
 * Standing Rule 5 still holds: with no ESV / API.Bible key and no downloaded public-domain
 * translation, the resolver resolves nothing — but it *says* `NOT_CONFIGURED`, a designed state
 * the UI renders, and `canAutoShow()` keeps an unresolved reference from ever showing itself.
 * That is a configured absence, not an unconnected wire.
 */

import { getAsrService } from '@main/asr'
import { loadConfigFromDisk } from '@main/config/env'
import type { AppConfig } from '@main/config/env'
import { getOverlayServer } from '@main/overlay'
import { getPlanService } from '@main/plan'
import { createNullLogger } from '@main/logging/logger'
import type { CueEngineSettings } from '@shared/cue'
import type { Logger } from '@shared/log'
import type { ScriptureReference } from '@shared/scripture'

import { CueEngine } from './CueEngine'
import { ScriptureResolver } from './ScriptureResolver'
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

let resolverSingleton: ScriptureResolver | null = null

/**
 * The process-wide scripture resolver.
 *
 * Defaulted rather than left to a caller, because "left to a caller" is how this build produced
 * five subsystems that were built, tested, and connected to nothing. Without it a detected
 * reference is offered with no text and `Resolve scripture` answers *not configured* even when
 * `ESV_API_KEY` is present — a silent gap that no unit test sees, since every resolver test
 * constructs its own.
 *
 * With no key and no downloaded public-domain translation it still resolves nothing — but it
 * says so as `NOT_CONFIGURED`, which is a designed state the UI renders, rather than a wire that
 * was never connected.
 */
export function getScriptureResolver(
  options: { readonly logger?: Logger; readonly config?: AppConfig } = {},
): ScriptureResolver {
  if (resolverSingleton !== null) return resolverSingleton
  const logger = options.logger ?? createNullLogger()
  resolverSingleton = new ScriptureResolver({
    config: options.config ?? loadConfigFromDisk(),
    logger,
  })
  return resolverSingleton
}

/** Drop the resolver singleton. Tests use this; nothing in production does. */
export function resetScriptureResolver(): void {
  resolverSingleton = null
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
  // The detector is pure and free to construct. The resolver is defaulted just below.
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
    resolver: options.resolver ?? getScriptureResolver({ logger }),
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
