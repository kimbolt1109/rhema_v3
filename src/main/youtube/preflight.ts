/**
 * The pre-flight check — the last thing between the operator and a mistake.
 *
 * This is a **pure function**. It reads no clock, touches no filesystem, calls no API and holds
 * no state: hand it a snapshot, get back a list of {@link PreflightIssue}. That is deliberate.
 * The go/no-go decision for a live broadcast is the highest-stakes logic in the app, so it is
 * the piece that must be exhaustively testable without mocking anything at all.
 *
 * ## Why this is a legal requirement, not a nicety
 *
 * `docs/v2-notes/LEGAL_AND_CONTENT.md` §1 tracks the obligations mined from the prior project.
 * Three rows land here:
 *
 *  - **Row 2 — CCLI Streaming Licence gating before go-live.** The CCLI *Streaming* Licence is a
 *    separate licence from the base Church Copyright Licence; broadcasting worship music without
 *    it is infringement. v2 enforced this at two checkpoints (settings time *and* the go-live
 *    action). This function is the go-live checkpoint: {@link CCLI_LICENCE_MISSING}.
 *  - **Row 4 — Pre-stream warning for songs missing copyright metadata.** If a queued song has no
 *    author / CCLI number / publisher, the auto-composed attribution overlay (row 3) cannot be
 *    built, and the service would stream unattributed. One warning per song, naming the song and
 *    the missing fields, because "3 songs have problems" is not actionable at 09:58 on a Sunday.
 *  - The song list itself arrives in Phase 6. It is an **input parameter defaulting to empty**
 *    rather than something this module reaches for, so the legal gate exists and is tested now
 *    and simply starts reporting the moment the service plan is wired in.
 *
 * ## Severity means exactly one thing
 *
 * `error` blocks GO LIVE. `warning` is displayed, prominently, and the operator may proceed —
 * Standing Rule 1, the human always wins. A licence problem is a *warning*, not a block: Verger
 * cannot verify a licence number and must not refuse to broadcast a service on a guess. It can
 * only make absolutely sure nobody goes live without having been told.
 *
 * Node-global free by construction; nothing here imports from `node:*`.
 */

import type {
  Broadcast,
  BroadcastTemplate,
  PersistentStream,
  PreflightIssue,
  YouTubeAuthStatus
} from '@shared/youtube'

// ---------------------------------------------------------------------------
// Stable issue codes
// ---------------------------------------------------------------------------

/**
 * Machine-readable codes. Like `ErrorCode`, these are part of the contract the renderer branches
 * on for i18n copy, so renaming one is a breaking change.
 */
export const PreflightCode = {
  /** No `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Resting state, but it does block going live. */
  NOT_CONFIGURED: 'youtube.not-configured',
  /** Credentials exist; nobody has signed in yet. */
  SIGNED_OUT: 'youtube.signed-out',
  /** A sign-in is in flight. Transient, but you cannot go live in the middle of one. */
  AUTHORIZING: 'youtube.authorizing',
  /** The stored token was rejected or revoked. */
  AUTH_ERROR: 'youtube.auth-error',
  /** No persistent ingest stream has been resolved, so nothing can be bound. */
  NO_PERSISTENT_STREAM: 'youtube.no-persistent-stream',
  /** A broadcast exists but is not bound to the stream — OBS would push into the void. */
  BROADCAST_NOT_BOUND: 'youtube.broadcast-not-bound',
  /** YouTube reports the ingest as unhealthy. */
  STREAM_UNHEALTHY: 'youtube.stream-unhealthy',
  /** LEGAL_AND_CONTENT.md row 2 — the CCLI streaming-licence gate. */
  CCLI_LICENCE_MISSING: 'legal.ccli-streaming-licence-missing',
  /** LEGAL_AND_CONTENT.md row 4 — a queued song cannot be attributed. */
  SONG_MISSING_COPYRIGHT: 'legal.song-missing-copyright',
  /** Publishing a service publicly by accident is not recoverable. A deliberate speed bump. */
  PRIVACY_PUBLIC: 'youtube.privacy-public',
  /** The YouTube Data API daily quota is nearly spent. */
  QUOTA_NEARLY_EXHAUSTED: 'youtube.quota-nearly-exhausted'
} as const

/** Union of every {@link PreflightCode} value. */
export type PreflightCodeValue = (typeof PreflightCode)[keyof typeof PreflightCode]

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The copyright metadata a queued song needs before it can be streamed.
 *
 * Every field is optional so Phase 6's richer song model can be passed straight in without this
 * module having to know its shape. Deliberately carries **no lyrics** — Standing Rule 4.
 */
export interface PreflightSong {
  /** For the warning message. A song with no title at all is reported as "an untitled song". */
  readonly title?: string | null
  readonly author?: string | null
  readonly ccliSongNumber?: string | null
  readonly publisher?: string | null
}

/** The snapshot {@link computePreflight} judges. */
export interface PreflightInput {
  readonly auth: YouTubeAuthStatus
  readonly stream: PersistentStream | null
  readonly broadcast: Broadcast | null
  readonly template: BroadcastTemplate
  /**
   * The songs queued for this service. Phase 6 supplies these; until then the legal gate that
   * depends on them simply has nothing to complain about.
   */
  readonly songs?: readonly PreflightSong[]
  /** The operator's CCLI **Streaming** Licence number. `null`/blank raises the licence warning. */
  readonly ccliStreamingLicenceNumber?: string | null
  /** Estimated YouTube Data API units spent today. See `YouTubeService.quotaUnitsUsed()`. */
  readonly quotaUnitsUsed?: number
  /** The project's daily allowance. Google's default for a new project is 10,000 units. */
  readonly quotaUnitsPerDay?: number
}

/** Google's default daily allowance for a new Cloud project, in quota units. */
export const DEFAULT_DAILY_QUOTA_UNITS = 10_000

/** Warn once the day's estimated spend crosses this share of the allowance. */
export const QUOTA_WARNING_FRACTION = 0.8

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Judge a snapshot. Pure: same input, same output, always.
 *
 * Issues come back **errors first, then warnings**, each group in a fixed evaluation order, so
 * the Go Live screen renders a stable list that does not reshuffle itself between polls.
 */
export function computePreflight(input: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  issues.push(...authIssues(input.auth))
  issues.push(...streamIssues(input.stream, input.broadcast))
  issues.push(...licenceIssues(input.ccliStreamingLicenceNumber ?? null))
  issues.push(...songIssues(input.songs ?? []))
  issues.push(...privacyIssues(input.template))
  issues.push(...quotaIssues(input.quotaUnitsUsed, input.quotaUnitsPerDay))

  // Stable partition rather than a comparator sort: within a severity, evaluation order is the
  // display order, and two runs over the same snapshot must produce byte-identical output.
  return [
    ...issues.filter((issue) => issue.severity === 'error'),
    ...issues.filter((issue) => issue.severity === 'warning')
  ]
}

/** `true` when nothing blocks GO LIVE. Warnings do not block — Standing Rule 1. */
export function preflightBlocks(issues: readonly PreflightIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error')
}

// ---------------------------------------------------------------------------
// Individual gates
// ---------------------------------------------------------------------------

function authIssues(auth: YouTubeAuthStatus): PreflightIssue[] {
  switch (auth.state) {
    case 'not-configured':
      return [
        error(
          PreflightCode.NOT_CONFIGURED,
          'YouTube is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then restart Verger.'
        )
      ]
    case 'signed-out':
      return [
        error(
          PreflightCode.SIGNED_OUT,
          'Not signed in to YouTube. Sign in once on the Go Live screen; later services are silent.'
        )
      ]
    case 'authorizing':
      return [
        error(
          PreflightCode.AUTHORIZING,
          'Sign-in is still in progress. Finish it in the browser window that opened.'
        )
      ]
    case 'auth-error':
      return [
        error(
          PreflightCode.AUTH_ERROR,
          auth.lastError === null
            ? 'YouTube rejected the stored authorisation. Sign in again.'
            : `YouTube rejected the stored authorisation (${auth.lastError}). Sign in again.`
        )
      ]
    case 'signed-in':
      return []
  }
}

function streamIssues(stream: PersistentStream | null, broadcast: Broadcast | null): PreflightIssue[] {
  if (stream === null) {
    return [
      error(
        PreflightCode.NO_PERSISTENT_STREAM,
        'No persistent ingest stream is available yet, so a broadcast cannot be bound to one.'
      )
    ]
  }

  const issues: PreflightIssue[] = []

  // A broadcast with nothing bound to it is the failure mode that looks fine right up until the
  // service starts and YouTube shows a black screen: OBS pushes to an ingest nobody is watching.
  if (broadcast !== null && broadcast.boundStreamId === null) {
    issues.push(
      error(
        PreflightCode.BROADCAST_NOT_BOUND,
        `The broadcast "${broadcast.title}" is not bound to the persistent stream. Create it again, or bind it before going live.`
      )
    )
  }

  // `noData` is the *normal* resting state before OBS starts pushing, so it is not an issue.
  if (stream.health === 'bad') {
    issues.push(
      warning(
        PreflightCode.STREAM_UNHEALTHY,
        'YouTube reports the ingest as unhealthy. Check the bitrate and the network before going live.'
      )
    )
  }

  return issues
}

/** LEGAL_AND_CONTENT.md row 2. Verger cannot verify a licence — it can only refuse to be silent. */
function licenceIssues(licenceNumber: string | null): PreflightIssue[] {
  if (isPresent(licenceNumber)) return []
  return [
    warning(
      PreflightCode.CCLI_LICENCE_MISSING,
      'No CCLI Streaming Licence number is recorded. Streaming worship music needs a CCLI Streaming Licence — this is separate from the Church Copyright Licence. Record it in settings. (Verger is not affiliated with or endorsed by CCLI.)'
    )
  ]
}

/** LEGAL_AND_CONTENT.md row 4. One warning per song, naming what is missing. */
function songIssues(songs: readonly PreflightSong[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  for (const song of songs) {
    const missing = missingCopyrightFields(song)
    if (missing.length === 0) continue
    const name = isPresent(song.title) ? `"${song.title.trim()}"` : 'an untitled song'
    issues.push(
      warning(
        PreflightCode.SONG_MISSING_COPYRIGHT,
        `${name} is missing ${formatList(missing)}. The streaming attribution cannot be composed without it.`
      )
    )
  }
  return issues
}

/** Which of the three attribution fields a song lacks, in a fixed order. */
export function missingCopyrightFields(song: PreflightSong): readonly string[] {
  const missing: string[] = []
  if (!isPresent(song.author)) missing.push('an author')
  if (!isPresent(song.ccliSongNumber)) missing.push('a CCLI song number')
  if (!isPresent(song.publisher)) missing.push('a publisher')
  return missing
}

/**
 * The public-privacy speed bump.
 *
 * Unlisted is recoverable; public is not. A service published publicly by mistake is indexed,
 * notified to subscribers, and potentially scraped before anyone notices — so `public` always
 * costs the operator one deliberate acknowledgement, every single time.
 */
function privacyIssues(template: BroadcastTemplate): PreflightIssue[] {
  if (template.privacy !== 'public') return []
  return [
    warning(
      PreflightCode.PRIVACY_PUBLIC,
      'This broadcast will be PUBLIC — visible to everyone and announced to subscribers. Use "unlisted" unless publishing publicly is intended; a public broadcast cannot be un-published after the fact.'
    )
  ]
}

/**
 * Quota awareness.
 *
 * `liveBroadcasts.insert` and `liveBroadcasts.bind` cost 50 units each against a default daily
 * allowance of 10,000, so a handful of services a day is comfortable (BLUEPRINT.md §5). The
 * warning exists for the case that is not comfortable: a retry loop, or a second app on the same
 * Cloud project. A quota that runs out mid-Sunday cannot be topped up.
 */
function quotaIssues(used: number | undefined, perDay: number | undefined): PreflightIssue[] {
  if (used === undefined) return []
  const allowance = perDay ?? DEFAULT_DAILY_QUOTA_UNITS
  if (allowance <= 0) return []
  if (used < allowance * QUOTA_WARNING_FRACTION) return []

  return [
    warning(
      PreflightCode.QUOTA_NEARLY_EXHAUSTED,
      `Roughly ${used} of the ${allowance} daily YouTube API units are spent. Creating another broadcast costs about 100 more; the allowance resets at midnight Pacific time.`
    )
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function error(code: PreflightCodeValue, message: string): PreflightIssue {
  return { code, message, severity: 'error' }
}

function warning(code: PreflightCodeValue, message: string): PreflightIssue {
  return { code, message, severity: 'warning' }
}

/** A value counts as present only when it is a non-blank string. `"   "` is not a licence number. */
function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** `["a", "b", "c"]` -> `"a, b and c"`. Plain English beats a bracketed list at 09:58. */
function formatList(items: readonly string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0] ?? ''
  const head = items.slice(0, -1).join(', ')
  const tail = items[items.length - 1] ?? ''
  return `${head} and ${tail}`
}
