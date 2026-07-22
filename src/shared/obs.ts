/**
 * The OBS domain contract.
 *
 * Standing Rule 2 governs this whole module: **OBS is the resilient engine; Verger is a
 * convenience layer.** If Verger crashes, OBS keeps streaming and recording. On (re)connect the
 * client READS whatever state OBS is in and reflects it — it never imposes state. Nothing here
 * describes a "desired" scene or stream; every field is an observation.
 *
 * Node-global free: this is imported by the renderer as well as main.
 */

import type { AppError } from './result'

/**
 * The OBS connection lifecycle.
 *
 * Two of these carry decisions worth stating explicitly, because collapsing either one into a
 * generic "disconnected" costs the operator real diagnostic information mid-service:
 *
 * - `not-configured` — no `OBS_WEBSOCKET_URL` in `.env`. The client never dials at all. This is
 *   an expected resting state, not a failure (Standing Rule 5), and the UI explains how to fix it.
 * - `auth-failed` — the password was rejected. **Terminal: no retries.** Reconnecting forever
 *   against a wrong password cannot succeed, burns OBS's connection slots, and buries the actual
 *   problem under a scrolling "reconnecting…" indicator. The operator is told plainly instead.
 */
export type ObsConnectionState =
  | 'not-configured'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth-failed'

/** A scene as reported by OBS. */
export interface ObsScene {
  readonly name: string
  /** OBS's own ordering index. Preserved so the UI can list scenes as OBS shows them. */
  readonly index: number
}

/** A snapshot of OBS's scene list. Purely observed — Verger never reorders it. */
export interface ObsSceneList {
  readonly scenes: readonly ObsScene[]
  readonly currentProgramScene: string | null
  /** `null` when OBS is not in studio mode. */
  readonly currentPreviewScene: string | null
}

/**
 * Everything the UI needs to render the connection light at a glance.
 *
 * Deliberately flat and serialisable: it crosses IPC on every state change.
 */
export interface ObsStatus {
  readonly state: ObsConnectionState
  /** Epoch ms at which the client entered `state`. Drives the "live for 12:34" style readouts. */
  readonly since: number
  /** Consecutive failed connection attempts. Resets to 0 on success. */
  readonly attempt: number
  /** Milliseconds until the next reconnect attempt, or `null` when no retry is scheduled. */
  readonly nextRetryInMs: number | null
  readonly obsVersion: string | null
  readonly obsWebSocketVersion: string | null
  readonly rpcVersion: number | null
  readonly currentProgramScene: string | null
  /** The failure that caused the current state, if any. Cleared on a successful connect. */
  readonly lastError: AppError | null
}

/**
 * Connection settings.
 *
 * `password: null` means "OBS has authentication disabled", which is a legitimate configuration
 * and is distinct from "no password supplied yet". `src/main/config/env.ts` preserves that
 * distinction: an empty `OBS_WEBSOCKET_PASSWORD` yields `''`, an absent one yields `null`.
 */
export interface ObsConnectionConfig {
  readonly url: string
  readonly password: string | null
}

/** Parameters for the exponential-backoff reconnect loop. */
export interface ReconnectPolicy {
  /** Delay before the first retry. */
  readonly baseDelayMs: number
  /** Ceiling for the delay, however many attempts have failed. */
  readonly maxDelayMs: number
  /** Multiplier applied per attempt. */
  readonly factor: number
  /** Fraction of the computed delay that is randomised, to avoid synchronised retries. */
  readonly jitterRatio: number
  /** `null` means retry indefinitely. */
  readonly maxAttempts: number | null
}

/**
 * The default reconnect policy.
 *
 * The numbers are chosen for a live service, not for a server:
 * - `baseDelayMs: 500` — OBS restarting takes about a second, so the first retry should land
 *   almost immediately. An operator who closed OBS by accident sees it recover before they react.
 * - `maxDelayMs: 30_000` — the ceiling. Long enough not to hammer a machine that is genuinely
 *   down, short enough that recovery during a 90-minute service is never more than half a minute
 *   away.
 * - `factor: 2`, `jitterRatio: 0.25` — conventional; the jitter matters little with one client
 *   but costs nothing and keeps the delays from looking robotic in the countdown UI.
 * - `maxAttempts: null` — never stop trying. A service can run for hours; giving up silently
 *   would be the worst possible behaviour. `auth-failed` is the one state that bypasses this
 *   policy entirely, because retrying a rejected password cannot succeed.
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitterRatio: 0.25,
  maxAttempts: null,
}

/**
 * Compute the delay before reconnect attempt number `attempt` (0-based).
 *
 * Pure, with injectable randomness, so the reconnect sequence is deterministically testable.
 * `random` must return a value in `[0, 1)` — the same contract as `Math.random`.
 *
 * Guarantees, all covered by `src/main/obs/backoff.test.ts`:
 * - never returns `NaN`, a negative number, or `Infinity` for any finite input;
 * - non-decreasing in `attempt` up to the cap;
 * - saturates at `policy.maxDelayMs` and never exceeds it, jitter included.
 *
 * Jitter is applied symmetrically (`±jitterRatio`) around the exponential value, then clamped —
 * so the cap is a true ceiling rather than a value the jitter can overshoot.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  const base = Math.max(0, policy.baseDelayMs)
  const cap = Math.max(0, policy.maxDelayMs)

  // A large `attempt` with factor > 1 overflows to Infinity, which would poison the arithmetic
  // below. Clamp to the cap before applying jitter instead.
  const growth = Math.pow(Math.max(1, policy.factor), safeAttempt)
  const exponential = Number.isFinite(growth) ? Math.min(base * growth, cap) : cap

  const ratio = Math.min(Math.max(policy.jitterRatio, 0), 1)
  // random() in [0,1) -> offset in [-ratio, +ratio)
  const offset = (random() * 2 - 1) * ratio
  const jittered = exponential * (1 + offset)

  return Math.min(cap, Math.max(0, Math.round(jittered)))
}

/** The resting status used before any connection attempt has been made. */
export function initialObsStatus(state: ObsConnectionState, now: number): ObsStatus {
  return {
    state,
    since: now,
    attempt: 0,
    nextRetryInMs: null,
    obsVersion: null,
    obsWebSocketVersion: null,
    rpcVersion: null,
    currentProgramScene: null,
    lastError: null,
  }
}
