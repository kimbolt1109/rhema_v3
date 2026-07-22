/**
 * The YouTube Live contract.
 *
 * BLUEPRINT.md §5: one GO LIVE button creates the broadcast, binds a persistent stream, starts
 * OBS streaming, waits for health, and transitions to live. This module defines the vocabulary;
 * Phase 4 builds OAuth and the broadcast lifecycle, Phase 5 builds the orchestration.
 *
 * ## The persistent-stream decision
 *
 * A YouTube "broadcast" is the event; a "stream" is the RTMP ingest it binds to. Verger reuses
 * ONE persistent stream forever, so **the RTMP key never changes and OBS stays configured**. The
 * alternative — a fresh stream per service — means re-pasting a key into OBS every Sunday, which
 * is precisely the many-clicks pain this feature exists to remove. Only the broadcast is created
 * weekly; the stream is created once and bound each time.
 *
 * ## Never a single point of failure
 *
 * Every state here is observational. If YouTube is unreachable, OBS keeps streaming and
 * recording and the operator can drive it by hand — the app must never wedge the broadcast.
 *
 * Node-global free.
 */

import { z } from 'zod'

/**
 * Whether Google OAuth has usable credentials.
 *
 * `not-configured` (no client id/secret in `.env`) is a resting state, not an error: the Go Live
 * screen disables itself and explains, and the rest of the app is unaffected (Standing Rule 5).
 */
export type YouTubeAuthState =
  | 'not-configured'
  | 'signed-out'
  | 'authorizing'
  | 'signed-in'
  | 'auth-error'

/**
 * Who we are signed in as. Shown so the operator can confirm the right channel before going live.
 */
export interface YouTubeChannel {
  readonly id: string
  readonly title: string
  readonly customUrl: string | null
}

/** Auth status, safe to send to the renderer — carries no token. */
export interface YouTubeAuthStatus {
  readonly state: YouTubeAuthState
  readonly channel: YouTubeChannel | null
  readonly lastError: string | null
}

/** YouTube broadcast privacy. */
export const BROADCAST_PRIVACY = ['public', 'unlisted', 'private'] as const

/** Union of the privacy values. */
export type BroadcastPrivacy = (typeof BROADCAST_PRIVACY)[number]

/**
 * The lifecycle status YouTube reports for a broadcast.
 *
 * These are YouTube's own names, kept verbatim so a reader can match them against the API docs.
 */
export type BroadcastLifecycle = 'created' | 'ready' | 'testing' | 'live' | 'complete' | 'revoked'

/** Ingest health, as YouTube reports it. `noData` is the state before OBS starts pushing. */
export type StreamHealth = 'good' | 'ok' | 'bad' | 'noData'

/** A broadcast as Verger tracks it. */
export interface Broadcast {
  readonly id: string
  readonly title: string
  readonly privacy: BroadcastPrivacy
  readonly scheduledStartTime: string
  readonly lifecycle: BroadcastLifecycle
  /** The bound persistent stream, or `null` before binding. */
  readonly boundStreamId: string | null
  /** The public watch URL, once known. */
  readonly watchUrl: string | null
}

/** The persistent ingest stream. Created once, reused every week. */
export interface PersistentStream {
  readonly id: string
  readonly title: string
  /**
   * The RTMP ingest address. NOT a secret on its own.
   *
   * The stream KEY is deliberately absent from this type: it is a credential that grants anyone
   * the ability to broadcast to the channel, it lives in OBS's own settings rather than in
   * Verger, and it must never cross IPC into the renderer or reach a log file.
   */
  readonly ingestAddress: string | null
  readonly health: StreamHealth
}

/**
 * The weekly template.
 *
 * `titleTemplate` supports `{date}`, substituted at creation time — BLUEPRINT.md's
 * "Sunday Service — {date}".
 */
export interface BroadcastTemplate {
  readonly titleTemplate: string
  readonly description: string
  readonly privacy: BroadcastPrivacy
  /** Local path to a thumbnail image, or `null`. */
  readonly thumbnailPath: string | null
  /** IANA zone used to resolve `{date}` and the scheduled start. */
  readonly timeZone: string
}

/** A sensible starting template. */
export function defaultBroadcastTemplate(): BroadcastTemplate {
  return {
    titleTemplate: 'Sunday Service — {date}',
    description: '',
    privacy: 'unlisted',
    thumbnailPath: null,
    timeZone: 'Asia/Seoul',
  }
}

/**
 * Expand `{date}` in a title template.
 *
 * Pure and explicitly parameterised by `now` so it is testable without freezing the clock.
 */
export function expandTitleTemplate(template: string, now: Date, locale = 'en-CA'): string {
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return template.replaceAll('{date}', date)
}

/** One pre-flight problem. */
export interface PreflightIssue {
  readonly code: string
  readonly message: string
  /** `error` blocks going live; `warning` is shown but does not block. */
  readonly severity: 'error' | 'warning'
}

/** Everything the Go Live screen needs to render. */
export interface YouTubeStatus {
  readonly auth: YouTubeAuthStatus
  readonly broadcast: Broadcast | null
  readonly stream: PersistentStream | null
  readonly template: BroadcastTemplate
  /**
   * Blocking pre-flight problems. A non-empty `error` disables GO LIVE and each entry is shown.
   * Includes the CCLI licence gate from `docs/v2-notes/LEGAL_AND_CONTENT.md`.
   */
  readonly preflight: readonly PreflightIssue[]
}

/** Validation for the template, used at the IPC boundary. */
export const broadcastTemplateSchema = z.object({
  titleTemplate: z.string().min(1).max(100),
  description: z.string().max(5000),
  privacy: z.enum(BROADCAST_PRIVACY),
  thumbnailPath: z.string().max(4096).nullable(),
  timeZone: z.string().min(1).max(64),
})

/** Validation for a create-broadcast request. */
export const createBroadcastSchema = z.object({
  scheduledStartTime: z.string().min(1).max(64).optional(),
})
