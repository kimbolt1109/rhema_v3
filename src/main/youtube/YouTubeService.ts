/**
 * The YouTube Live broadcast lifecycle (BLUEPRINT.md §5, steps 1 and 2).
 *
 * This module creates the weekly broadcast and binds it to the one persistent ingest stream. It
 * deliberately stops there: `StartStream`, `StartRecord`, health-driven transitions and the GO
 * LIVE button are Phase 5's orchestration. {@link YouTubeService.transition} and
 * {@link YouTubeService.pollStreamHealth} exist and are tested here, but nothing in this file
 * drives them on a timer.
 *
 * ## Everything is injected; nothing is constructed inline
 *
 * There is no Google account, no OAuth client and no `.env` values on the build machine, and
 * there never will be. So the YouTube Data API arrives through {@link YouTubeApiLike} — eight
 * methods, exactly the ones used — produced by an injected {@link YouTubeApiFactory}. The whole
 * service is driven in tests by a hand-written mock with no network, no `googleapis` import and
 * no Electron runtime. `index.ts` supplies the real `google.youtube('v3')`.
 *
 * ## The stream key is a credential and never leaves this file
 *
 * A `liveStreams` resource carries `cdn.ingestionInfo.streamName` — that is the RTMP **stream
 * key**, and anyone holding it can broadcast to the channel. {@link PersistentStream}
 * deliberately has no field for it, this module never reads it, never logs it, and it never
 * crosses IPC. It lives in OBS's own settings, pasted once by a human. `YouTubeService.test.ts`
 * asserts a canary key value never appears in a returned value or in a log line.
 *
 * ## Nothing throws
 *
 * Every public method returns a {@link Result}. Every call into `googleapis` is wrapped and every
 * failure is classified by {@link classifyGoogleError} — a `GaxiosError` escaping into the main
 * process during a service would take the booth UI with it.
 *
 * ## Not configured is a resting state
 *
 * With an empty `.env` the auth seam reports `not-configured`, every method short-circuits with
 * `NOT_CONFIGURED` **before touching the API factory at all**, and `getStatus()` still returns a
 * complete, renderable {@link YouTubeStatus} whose pre-flight explains what is missing.
 * Standing Rule 5.
 */

import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok } from '@shared/result'
import type { AppError, Result } from '@shared/result'
import { broadcastTemplateSchema, createBroadcastSchema, defaultBroadcastTemplate, expandTitleTemplate } from '@shared/youtube'
import type {
  Broadcast,
  BroadcastLifecycle,
  BroadcastPrivacy,
  BroadcastTemplate,
  PersistentStream,
  StreamHealth,
  YouTubeAuthStatus,
  YouTubeChannel,
  YouTubeStatus
} from '@shared/youtube'

import { computePreflight } from './preflight'
import type { PreflightSong } from './preflight'

// ---------------------------------------------------------------------------
// The API seam — only the calls Verger actually makes
// ---------------------------------------------------------------------------

/** The `{ data }` envelope every `googleapis` method resolves with. */
export interface YouTubeApiResponse<T> {
  readonly data: T
}

/** The slice of a `liveBroadcast` resource this module reads. All fields are optional: the API
 *  omits a part that was not requested, and a future field must never break parsing. */
export interface LiveBroadcastResource {
  readonly id?: string | null
  readonly snippet?: {
    readonly title?: string | null
    readonly description?: string | null
    readonly scheduledStartTime?: string | null
  } | null
  readonly status?: {
    readonly lifeCycleStatus?: string | null
    readonly privacyStatus?: string | null
  } | null
  readonly contentDetails?: {
    readonly boundStreamId?: string | null
  } | null
}

/**
 * The slice of a `liveStream` resource this module reads.
 *
 * Note what is **absent**: `cdn.ingestionInfo.streamName`. The seam does not expose the stream
 * key, so no amount of refactoring inside this service can accidentally surface it — the type
 * does not admit it. (The real response still carries it; the point is that nothing here can
 * reach it without editing this interface, which a reviewer would see.)
 */
export interface LiveStreamResource {
  readonly id?: string | null
  readonly snippet?: {
    readonly title?: string | null
  } | null
  readonly cdn?: {
    readonly ingestionInfo?: {
      readonly ingestionAddress?: string | null
      readonly rtmpsIngestionAddress?: string | null
    } | null
  } | null
  readonly status?: {
    readonly streamStatus?: string | null
    readonly healthStatus?: {
      readonly status?: string | null
    } | null
  } | null
}

/** The slice of a `channel` resource this module reads. */
export interface ChannelResource {
  readonly id?: string | null
  readonly snippet?: {
    readonly title?: string | null
    readonly customUrl?: string | null
  } | null
}

/** A list response. `items` is absent, not empty, when the API returns nothing. */
export interface ListResponse<T> {
  readonly items?: readonly T[] | null
}

/** Parameters shared by every request. `part` is always explicit — it drives the response shape. */
interface PartParams {
  readonly part: readonly string[]
}

/**
 * The narrow YouTube Data API v3 surface Verger uses.
 *
 * Eight methods. `google.youtube('v3')` satisfies this structurally (see `index.ts`, which adapts
 * it explicitly rather than casting), and a test mock is forty lines.
 */
export interface YouTubeApiLike {
  readonly liveBroadcasts: {
    insert(
      params: PartParams & { readonly requestBody: Record<string, unknown> }
    ): Promise<YouTubeApiResponse<LiveBroadcastResource>>
    bind(
      params: PartParams & { readonly id: string; readonly streamId: string }
    ): Promise<YouTubeApiResponse<LiveBroadcastResource>>
    list(
      params: PartParams & { readonly id?: readonly string[]; readonly mine?: boolean }
    ): Promise<YouTubeApiResponse<ListResponse<LiveBroadcastResource>>>
    transition(
      params: PartParams & { readonly id: string; readonly broadcastStatus: string }
    ): Promise<YouTubeApiResponse<LiveBroadcastResource>>
  }
  readonly liveStreams: {
    list(
      params: PartParams & {
        readonly id?: readonly string[]
        readonly mine?: boolean
        readonly maxResults?: number
      }
    ): Promise<YouTubeApiResponse<ListResponse<LiveStreamResource>>>
    insert(
      params: PartParams & { readonly requestBody: Record<string, unknown> }
    ): Promise<YouTubeApiResponse<LiveStreamResource>>
  }
  readonly thumbnails: {
    set(params: {
      readonly videoId: string
      readonly media: { readonly mimeType: string; readonly body: unknown }
    }): Promise<YouTubeApiResponse<unknown>>
  }
  readonly channels: {
    list(
      params: PartParams & { readonly mine?: boolean }
    ): Promise<YouTubeApiResponse<ListResponse<ChannelResource>>>
  }
}

/**
 * Builds an API client bound to an authorised OAuth2 client.
 *
 * The auth client is `unknown` on purpose: this module has no business knowing what a
 * `google.auth.OAuth2` is, and typing it as such would drag `googleapis` into every test.
 */
export type YouTubeApiFactory = (authClient: unknown) => YouTubeApiLike

// ---------------------------------------------------------------------------
// The auth seam
// ---------------------------------------------------------------------------

/**
 * The OAuth service, as this module needs it.
 *
 * Declared here structurally rather than imported from `./OAuthService`, so the two files stay
 * decoupled and this one is testable with a ten-line stub.
 */
export interface YouTubeAuthLike {
  /** Cheap, synchronous, never throws. `not-configured` when `.env` has no Google credentials. */
  getStatus(): YouTubeAuthStatus
  signIn(): Promise<Result<YouTubeAuthStatus>>
  signOut(): Promise<Result<YouTubeAuthStatus>>
  onStatus(callback: (status: YouTubeAuthStatus) => void): Unsubscribe
  /** An authorised client to hand to {@link YouTubeApiFactory}, or an `Err` when unavailable. */
  getAuthClient(): Promise<Result<unknown>>
  /**
   * Optional: tell the auth layer that the API rejected our credentials.
   *
   * Optional because this service must not depend on the exact shape of a file another agent
   * owns — when it is absent, {@link YouTubeService} still reports `auth-error` itself.
   */
  reportAuthFailure?(message: string): void
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** A thumbnail loaded from disk, ready for `thumbnails.set`. */
export interface ThumbnailPayload {
  readonly mimeType: string
  /** A readable stream or buffer. Opaque here — `googleapis` consumes it. */
  readonly body: unknown
}

/**
 * Load a thumbnail from a local path.
 *
 * A `Result` rather than a throw, and injected rather than `node:fs`, so this service never
 * touches the filesystem. `index.ts` supplies the real reader. Omitted entirely: thumbnails are
 * skipped with a debug line.
 */
export type ThumbnailReader = (path: string) => Result<ThumbnailPayload>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The title Verger stamps on its persistent ingest stream, and the key to the whole design.
 *
 * `ensurePersistentStream()` matches on this exact title to find the stream it created on some
 * previous Sunday and reuse it. **That reuse is what keeps the RTMP stream key stable, which is
 * what lets OBS stay configured from one week to the next.** Creating a fresh stream per service
 * would mean re-pasting a new key into OBS every Sunday morning — precisely the many-clicks pain
 * this feature exists to remove (BLUEPRINT.md §5, "the persistent-stream decision").
 *
 * Changing this string strands the existing stream and mints a new key. Do not.
 */
export const PERSISTENT_STREAM_TITLE = 'Verger Persistent Stream'

/**
 * Estimated YouTube Data API quota cost per call, in units.
 *
 * A default Cloud project gets 10,000 units a day. Writes are expensive and reads are nearly
 * free, which is why this service **lists before it inserts** and why nothing here polls on a
 * tight loop. One complete go-live is roughly: `liveStreams.list` (1) + `liveBroadcasts.insert`
 * (50) + `liveBroadcasts.bind` (50) + optional `thumbnails.set` (50) + `transition` to live (50)
 * + `transition` to complete (50) ≈ 250 units. A handful of services a day is comfortable; a
 * retry loop around `insert` is not.
 */
export const QUOTA_COST = {
  broadcastInsert: 50,
  broadcastBind: 50,
  broadcastTransition: 50,
  broadcastList: 1,
  streamInsert: 50,
  streamList: 1,
  thumbnailSet: 50,
  channelList: 1
} as const

/**
 * How far ahead the default scheduled start is placed.
 *
 * YouTube requires `scheduledStartTime` to be in the future. The operator creates the broadcast
 * minutes before the service, so "a few minutes from now" is the honest default; anything
 * cleverer (next Sunday at 10:00 in the template's zone) needs timezone arithmetic that would be
 * wrong twice a year, and the caller can always pass an explicit ISO time.
 */
export const DEFAULT_START_LEAD_MS = 5 * 60 * 1000

/** The `part` lists. Explicit, because `part` decides what comes back and what it costs. */
const BROADCAST_PARTS = ['id', 'snippet', 'status', 'contentDetails'] as const
const STREAM_PARTS = ['id', 'snippet', 'cdn', 'status'] as const
const STREAM_INSERT_PARTS = ['snippet', 'cdn', 'contentDetails'] as const
const CHANNEL_PARTS = ['id', 'snippet'] as const

/** The only lifecycle states `liveBroadcasts.transition` accepts as a target. */
const TRANSITIONABLE: readonly BroadcastLifecycle[] = ['testing', 'live', 'complete']

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Constructor dependencies. Only `auth`, `logger` and `apiFactory` are required. */
export interface YouTubeServiceOptions {
  readonly auth: YouTubeAuthLike
  readonly logger: Logger
  readonly apiFactory: YouTubeApiFactory
  /** The clock. Injected so title expansion and scheduling are deterministic in tests. */
  readonly now?: () => Date
  /** The starting template. Defaults to {@link defaultBroadcastTemplate}. */
  readonly template?: BroadcastTemplate
  /** Called after every accepted `setTemplate`. Omitted: the template lives for the session. */
  readonly persistTemplate?: (template: BroadcastTemplate) => Result<void>
  /** Omitted: thumbnails are skipped rather than attempted. */
  readonly readThumbnail?: ThumbnailReader
  /** Phase 6 supplies the queued songs for the legal pre-flight. Defaults to none. */
  readonly songs?: () => readonly PreflightSong[]
  /** The operator's CCLI Streaming Licence number, for the pre-flight gate. */
  readonly ccliStreamingLicenceNumber?: () => string | null
  /** The project's daily quota allowance, if it is not Google's 10,000 default. */
  readonly quotaUnitsPerDay?: number
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class YouTubeService {
  private readonly auth: YouTubeAuthLike
  private readonly log: Logger
  private readonly apiFactory: YouTubeApiFactory
  private readonly now: () => Date
  private readonly persistTemplate: ((template: BroadcastTemplate) => Result<void>) | null
  private readonly readThumbnail: ThumbnailReader | null
  private readonly songs: () => readonly PreflightSong[]
  private readonly ccliLicence: () => string | null
  private readonly quotaPerDay: number | null

  private readonly subscribers = new Set<(status: YouTubeStatus) => void>()

  private template: BroadcastTemplate
  private stream: PersistentStream | null = null
  private broadcast: Broadcast | null = null
  private channel: YouTubeChannel | null = null

  /**
   * Set when the API itself rejects our credentials (401/403).
   *
   * Held locally rather than only pushed into the auth seam, because `reportAuthFailure` is
   * optional there: whatever the OAuth service does or does not implement, a rejected token
   * shows up as `auth-error` on the Go Live screen. Cleared by a successful call or a sign-in.
   */
  private authErrorOverride: string | null = null

  /** Estimated quota units spent by this process. A lower bound — other clients also spend. */
  private quotaUnits = 0

  /** Memoised per auth client, so repeated calls do not rebuild the googleapis wrapper. */
  private cachedApi: { readonly client: unknown; readonly api: YouTubeApiLike } | null = null

  private unsubscribeAuth: Unsubscribe | null = null
  private disposed = false
  private lastEmitted: string | null = null

  constructor(options: YouTubeServiceOptions) {
    this.auth = options.auth
    this.log = options.logger.child('youtube')
    this.apiFactory = options.apiFactory
    this.now = options.now ?? ((): Date => new Date())
    this.persistTemplate = options.persistTemplate ?? null
    this.readThumbnail = options.readThumbnail ?? null
    this.songs = options.songs ?? ((): readonly PreflightSong[] => [])
    this.ccliLicence = options.ccliStreamingLicenceNumber ?? ((): string | null => null)
    this.quotaPerDay = options.quotaUnitsPerDay ?? null
    this.template = options.template ?? defaultBroadcastTemplate()

    // Seed the change detector with the resting state, so a no-op edit does not wake the UI.
    this.lastEmitted = JSON.stringify(this.snapshot())

    // Construction is inert: it subscribes to an in-process emitter and nothing else. No network
    // call, no timer, no port. `index.ts` may build this before the operator has ever signed in.
    try {
      this.unsubscribeAuth = this.auth.onStatus((status) => {
        this.handleAuthStatus(status)
      })
    } catch (cause) {
      this.log.warn('could not subscribe to the YouTube auth status', { cause })
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Everything the Go Live screen renders. Always succeeds, in every auth state. */
  getStatus(): YouTubeStatus {
    return this.snapshot()
  }

  /** Subscribe to status changes. Fires on auth changes, template edits and API results. */
  onStatus(callback: (status: YouTubeStatus) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Estimated YouTube Data API units this process has spent.
   *
   * A lower bound, not a meter: Google counts per Cloud project, so anything else using the same
   * credentials spends from the same allowance. Enough for the UI to say "you have used roughly
   * N of 10,000 today", which is the only thing an operator can act on.
   */
  quotaUnitsUsed(): number {
    return this.quotaUnits
  }

  // -------------------------------------------------------------------------
  // Auth passthrough
  // -------------------------------------------------------------------------

  /** Run the loopback OAuth consent flow. Silent on later launches. */
  async signIn(): Promise<Result<YouTubeStatus>> {
    const result = await this.callAuth(() => this.auth.signIn())
    if (!result.ok) return result
    this.authErrorOverride = null
    this.publish()
    return ok(this.snapshot())
  }

  /** Forget the stored refresh token and drop every cached resource. */
  async signOut(): Promise<Result<YouTubeStatus>> {
    const result = await this.callAuth(() => this.auth.signOut())
    // Cached YouTube state belongs to the account that just went away, whether or not the sign
    // out itself reported success. Keeping it would show the next operator someone else's stream.
    this.authErrorOverride = null
    this.stream = null
    this.broadcast = null
    this.channel = null
    this.cachedApi = null
    this.publish()
    if (!result.ok) return result
    return ok(this.snapshot())
  }

  // -------------------------------------------------------------------------
  // Template
  // -------------------------------------------------------------------------

  /**
   * Replace the weekly template.
   *
   * Validated with `broadcastTemplateSchema` even though the caller is typed, because by the time
   * this runs the payload has crossed IPC from the renderer — a trust boundary.
   *
   * A persistence failure is reported but does not roll the template back: mid-service, a
   * template that works until restart beats no template at all.
   */
  setTemplate(template: BroadcastTemplate): Result<YouTubeStatus> {
    const parsed = broadcastTemplateSchema.safeParse(template)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      this.log.warn('rejected an invalid broadcast template', { detail })
      return err(ErrorCode.INVALID_ARG, 'the broadcast template is invalid', detail)
    }

    this.template = {
      titleTemplate: parsed.data.titleTemplate,
      description: parsed.data.description,
      privacy: parsed.data.privacy,
      thumbnailPath: parsed.data.thumbnailPath,
      timeZone: parsed.data.timeZone
    }
    this.publish()

    const written = this.writeTemplate(this.template)
    if (!written.ok) return { ok: false, error: written.error }

    this.log.info('broadcast template updated', { privacy: this.template.privacy })
    return ok(this.snapshot())
  }

  // -------------------------------------------------------------------------
  // The persistent stream
  // -------------------------------------------------------------------------

  /**
   * Resolve the one persistent ingest stream, creating it only if it does not exist.
   *
   * **This is the decision that keeps the RTMP key stable so OBS stays configured.** The stream
   * is looked up by its exact title ({@link PERSISTENT_STREAM_TITLE}) among the channel's own
   * reusable streams; a hit is reused verbatim, and `liveStreams.insert` runs only on the very
   * first go-live of a channel's life. Every subsequent Sunday binds a fresh broadcast to this
   * same stream, so the key the operator pasted into OBS keeps working forever.
   *
   * Cost: 1 unit for the list, plus 50 on the one occasion an insert is needed.
   *
   * The returned {@link PersistentStream} carries id, title, ingest address and health — and
   * **never the stream key**, which this method does not read.
   */
  async ensurePersistentStream(): Promise<Result<PersistentStream>> {
    const api = await this.resolveApi()
    if (!api.ok) return api

    const listed = await this.call('liveStreams.list', QUOTA_COST.streamList, () =>
      api.value.liveStreams.list({ part: [...STREAM_PARTS], mine: true, maxResults: 50 })
    )
    if (!listed.ok) return listed

    const items = listed.value.data.items ?? []
    const existing = items.find((item) => item.snippet?.title === PERSISTENT_STREAM_TITLE)
    if (existing !== undefined) {
      const stream = toPersistentStream(existing)
      this.stream = stream
      this.publish()
      this.log.info('reusing the persistent ingest stream', { streamId: stream.id })
      return ok(stream)
    }

    this.log.info('no persistent ingest stream found; creating one', {
      title: PERSISTENT_STREAM_TITLE
    })
    const created = await this.call('liveStreams.insert', QUOTA_COST.streamInsert, () =>
      api.value.liveStreams.insert({
        part: [...STREAM_INSERT_PARTS],
        requestBody: {
          snippet: { title: PERSISTENT_STREAM_TITLE },
          cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
          // Reusable is the whole point: a non-reusable stream is discarded with its broadcast
          // and would hand the operator a new key next week.
          contentDetails: { isReusable: true }
        }
      })
    )
    if (!created.ok) return created

    const stream = toPersistentStream(created.value.data)
    this.stream = stream
    this.publish()
    this.log.info('created the persistent ingest stream', {
      streamId: stream.id,
      note: 'paste the stream key into OBS once; it will not change again'
    })
    return ok(stream)
  }

  /**
   * Re-read the persistent stream's ingest health.
   *
   * Defined and tested here, **driven by Phase 5** — nothing in this file calls it on a timer.
   * Cost is 1 unit, but "cheap" is not "free": Phase 5 should poll no faster than every few
   * seconds, and only while it is actually waiting to transition.
   */
  async pollStreamHealth(): Promise<Result<PersistentStream>> {
    const current = this.stream
    if (current === null) {
      return err(
        ErrorCode.NOT_FOUND,
        'there is no persistent stream to poll yet',
        'call ensurePersistentStream() first'
      )
    }

    const api = await this.resolveApi()
    if (!api.ok) return api

    const listed = await this.call('liveStreams.list', QUOTA_COST.streamList, () =>
      api.value.liveStreams.list({ part: [...STREAM_PARTS], id: [current.id] })
    )
    if (!listed.ok) return listed

    const item = (listed.value.data.items ?? [])[0]
    if (item === undefined) {
      return err(
        ErrorCode.NOT_FOUND,
        'the persistent stream no longer exists on the channel',
        current.id
      )
    }

    const stream = toPersistentStream(item)
    this.stream = stream
    this.publish()
    return ok(stream)
  }

  // -------------------------------------------------------------------------
  // The broadcast
  // -------------------------------------------------------------------------

  /**
   * Create this week's broadcast and bind it to the persistent stream.
   *
   * The order is `insert` then `bind` and it cannot be otherwise: `bind` needs the broadcast id
   * that `insert` returns. An unbound broadcast is the failure mode that looks fine until the
   * service starts and YouTube shows black, so a failed bind fails the whole call — the operator
   * is told now rather than discovering it at 10:01.
   *
   * The thumbnail is the exception: it is set last, and **a thumbnail failure never fails the
   * broadcast**. It is cosmetic, the broadcast already exists and is already bound, and refusing
   * to go live over a missing JPEG would be absurd.
   *
   * Cost: about 100 units, or 150 with a thumbnail. This is the expensive call — do not retry it
   * in a loop.
   */
  async createBroadcast(options: { scheduledStartTime?: string } = {}): Promise<Result<Broadcast>> {
    const parsed = createBroadcastSchema.safeParse(options)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return err(ErrorCode.INVALID_ARG, 'the create-broadcast request is invalid', detail)
    }

    const scheduled = this.resolveScheduledStart(parsed.data.scheduledStartTime)
    if (!scheduled.ok) return scheduled

    const api = await this.resolveApi()
    if (!api.ok) return api

    // Bind needs a stream, so resolve it first: failing here costs 1 unit instead of 50.
    const stream = await this.ensurePersistentStream()
    if (!stream.ok) return stream

    const title = expandTitleTemplate(this.template.titleTemplate, this.now())
    const inserted = await this.call('liveBroadcasts.insert', QUOTA_COST.broadcastInsert, () =>
      api.value.liveBroadcasts.insert({
        part: [...BROADCAST_PARTS],
        requestBody: {
          snippet: {
            title,
            description: this.template.description,
            scheduledStartTime: scheduled.value
          },
          status: {
            privacyStatus: this.template.privacy
          },
          contentDetails: {
            // Verger drives the transitions itself in Phase 5, so YouTube must not auto-start or
            // auto-stop the broadcast underneath it. Recording from the start is belt-and-braces
            // on top of Standing Rule 3's always-on *local* recording.
            enableAutoStart: false,
            enableAutoStop: false,
            enableDvr: true,
            recordFromStart: true
          }
        }
      })
    )
    if (!inserted.ok) return inserted

    const broadcastId = inserted.value.data.id ?? null
    if (broadcastId === null || broadcastId === '') {
      return err(
        ErrorCode.INTERNAL,
        'YouTube created a broadcast but did not return its id',
        'liveBroadcasts.insert returned no id'
      )
    }

    this.broadcast = toBroadcast(inserted.value.data, this.template, scheduled.value, broadcastId)
    this.publish()
    this.log.info('broadcast created', { broadcastId, title, privacy: this.template.privacy })

    const bound = await this.call('liveBroadcasts.bind', QUOTA_COST.broadcastBind, () =>
      api.value.liveBroadcasts.bind({
        part: [...BROADCAST_PARTS],
        id: broadcastId,
        streamId: stream.value.id
      })
    )
    if (!bound.ok) {
      this.log.error('the broadcast was created but could not be bound to the stream', {
        broadcastId,
        streamId: stream.value.id,
        detail: bound.error.message
      })
      return bound
    }

    this.broadcast = toBroadcast(bound.value.data, this.template, scheduled.value, broadcastId)
    // YouTube occasionally answers `bind` without echoing contentDetails; the bind succeeded, so
    // record the stream we bound rather than reporting an unbound broadcast the operator would
    // have to re-create for nothing.
    if (this.broadcast.boundStreamId === null) {
      this.broadcast = { ...this.broadcast, boundStreamId: stream.value.id }
    }
    this.publish()
    this.log.info('broadcast bound to the persistent stream', {
      broadcastId,
      streamId: stream.value.id
    })

    await this.applyThumbnail(api.value, broadcastId)

    return ok(this.broadcast)
  }

  /**
   * Move the current broadcast to `testing`, `live` or `complete`.
   *
   * Defined and tested here; **Phase 5 orchestrates it.** Nothing in this file decides when a
   * broadcast should go live — that decision needs OBS's stream state and the ingest health,
   * neither of which this module can see.
   *
   * Cost: 50 units per call.
   */
  async transition(status: BroadcastLifecycle): Promise<Result<Broadcast>> {
    if (!TRANSITIONABLE.includes(status)) {
      return err(
        ErrorCode.INVALID_ARG,
        `a broadcast cannot be transitioned to "${status}"`,
        `expected one of ${TRANSITIONABLE.join(', ')}`
      )
    }

    const current = this.broadcast
    if (current === null) {
      return err(
        ErrorCode.NOT_FOUND,
        'there is no broadcast to transition',
        'create the broadcast first'
      )
    }

    const api = await this.resolveApi()
    if (!api.ok) return api

    const moved = await this.call('liveBroadcasts.transition', QUOTA_COST.broadcastTransition, () =>
      api.value.liveBroadcasts.transition({
        part: [...BROADCAST_PARTS],
        id: current.id,
        broadcastStatus: status
      })
    )
    if (!moved.ok) return moved

    this.broadcast = toBroadcast(moved.value.data, this.template, current.scheduledStartTime, current.id)
    if (this.broadcast.boundStreamId === null && current.boundStreamId !== null) {
      this.broadcast = { ...this.broadcast, boundStreamId: current.boundStreamId }
    }
    this.publish()
    this.log.info('broadcast transitioned', { broadcastId: current.id, to: status })
    return ok(this.broadcast)
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  /**
   * Re-read the channel, the persistent stream and the current broadcast.
   *
   * Called when the Go Live screen opens and after a sign-in — **not on a timer**. Roughly 3
   * quota units; cheap, but a background poll every few seconds would still spend thousands a
   * day for information nobody is looking at.
   */
  async refresh(): Promise<Result<YouTubeStatus>> {
    const api = await this.resolveApi()
    if (!api.ok) return api

    const channels = await this.call('channels.list', QUOTA_COST.channelList, () =>
      api.value.channels.list({ part: [...CHANNEL_PARTS], mine: true })
    )
    if (channels.ok) {
      const item = (channels.value.data.items ?? [])[0]
      this.channel = item === undefined ? null : toChannel(item)
    } else {
      this.log.debug('could not read the signed-in channel', { detail: channels.error.message })
    }

    const stream = await this.ensurePersistentStream()
    if (!stream.ok) {
      this.publish()
      return stream
    }

    const current = this.broadcast
    if (current !== null) {
      const listed = await this.call('liveBroadcasts.list', QUOTA_COST.broadcastList, () =>
        api.value.liveBroadcasts.list({ part: [...BROADCAST_PARTS], id: [current.id] })
      )
      if (listed.ok) {
        const item = (listed.value.data.items ?? [])[0]
        this.broadcast =
          item === undefined
            ? null
            : toBroadcast(item, this.template, current.scheduledStartTime, current.id)
      } else {
        this.log.debug('could not refresh the current broadcast', { detail: listed.error.message })
      }
    }

    this.publish()
    return ok(this.snapshot())
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Drop every subscriber and detach from the auth seam. Idempotent. */
  dispose(): Result<void> {
    this.disposed = true
    const unsubscribe = this.unsubscribeAuth
    this.unsubscribeAuth = null
    if (unsubscribe !== null) {
      try {
        unsubscribe()
      } catch {
        /* best effort — the producer is already gone */
      }
    }
    this.subscribers.clear()
    return ok(undefined)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Get an API client, or explain why there is not one.
   *
   * The `not-configured` check comes first and returns **before the API factory is ever called**,
   * so an empty `.env` produces exactly zero API objects and zero network activity — which is
   * what the "no API call at all" test asserts.
   */
  private async resolveApi(): Promise<Result<YouTubeApiLike>> {
    const state = this.readAuthState()
    if (state === 'not-configured') {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'YouTube is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then restart Verger.',
        'google credentials absent'
      )
    }
    if (state === 'signed-out' || state === 'authorizing') {
      return err(
        ErrorCode.NOT_CONNECTED,
        'Not signed in to YouTube. Sign in on the Go Live screen.',
        state
      )
    }

    let client: Result<unknown>
    try {
      client = await this.auth.getAuthClient()
    } catch (cause) {
      const { error } = classifyGoogleError(cause)
      return { ok: false, error }
    }
    if (!client.ok) return client

    const cached = this.cachedApi
    if (cached !== null && cached.client === client.value) return ok(cached.api)

    try {
      const api = this.apiFactory(client.value)
      this.cachedApi = { client: client.value, api }
      return ok(api)
    } catch (cause) {
      const { error } = classifyGoogleError(cause)
      this.log.error('could not build the YouTube API client', { detail: error.message })
      return { ok: false, error }
    }
  }

  /**
   * One API call: quota accounted, exceptions converted, auth failures recorded.
   *
   * Nothing else in this class calls the API directly, so there is exactly one place where a
   * `GaxiosError` can turn into an `AppError` and exactly one place quota is counted.
   */
  private async call<T>(
    operation: string,
    cost: number,
    invoke: () => Promise<T>
  ): Promise<Result<T>> {
    this.quotaUnits += cost
    try {
      const value = await invoke()
      // A call that succeeded proves the credentials are good again.
      if (this.authErrorOverride !== null) {
        this.authErrorOverride = null
        this.publish()
      }
      return ok(value)
    } catch (cause) {
      const { error, authFailure } = classifyGoogleError(cause)
      // `error.message` is Google's own text; it never contains a token, and the logger redacts
      // by key regardless. The cause object itself is deliberately not logged.
      this.log.error(`the YouTube API call ${operation} failed`, {
        operation,
        code: error.code,
        detail: error.message
      })
      if (authFailure) this.markAuthError(error.message)
      return { ok: false, error }
    }
  }

  /** Set the thumbnail. Never fails the caller — cosmetic, and the broadcast already exists. */
  private async applyThumbnail(api: YouTubeApiLike, broadcastId: string): Promise<void> {
    const path = this.template.thumbnailPath
    if (path === null || path.trim() === '') return

    const reader = this.readThumbnail
    if (reader === null) {
      this.log.debug('no thumbnail reader is configured; skipping the thumbnail', { broadcastId })
      return
    }

    let payload: Result<ThumbnailPayload>
    try {
      payload = reader(path)
    } catch (cause) {
      this.log.warn('the thumbnail could not be read; the broadcast is unaffected', {
        broadcastId,
        cause
      })
      return
    }
    if (!payload.ok) {
      this.log.warn('the thumbnail could not be read; the broadcast is unaffected', {
        broadcastId,
        detail: payload.error.message
      })
      return
    }

    const media = payload.value
    const set = await this.call('thumbnails.set', QUOTA_COST.thumbnailSet, () =>
      api.thumbnails.set({
        videoId: broadcastId,
        media: { mimeType: media.mimeType, body: media.body }
      })
    )
    if (!set.ok) {
      this.log.warn('the thumbnail could not be set; the broadcast is unaffected', {
        broadcastId,
        detail: set.error.message
      })
      return
    }
    this.log.info('broadcast thumbnail set', { broadcastId })
  }

  /** Validate an operator-supplied start time, or place the default lead ahead of now. */
  private resolveScheduledStart(supplied: string | undefined): Result<string> {
    if (supplied === undefined) {
      const at = new Date(this.now().getTime() + DEFAULT_START_LEAD_MS)
      at.setSeconds(0, 0)
      return ok(at.toISOString())
    }
    const parsedTime = Date.parse(supplied)
    if (Number.isNaN(parsedTime)) {
      return err(
        ErrorCode.INVALID_ARG,
        'the scheduled start time is not a valid date',
        'expected an ISO 8601 timestamp'
      )
    }
    return ok(new Date(parsedTime).toISOString())
  }

  private readAuthState(): YouTubeAuthStatus['state'] {
    return this.readAuthStatus().state
  }

  /** The auth seam's own status, defensively. A throwing seam must not take the UI down. */
  private readAuthStatus(): YouTubeAuthStatus {
    try {
      return this.auth.getStatus()
    } catch (cause) {
      this.log.warn('could not read the YouTube auth status', { cause })
      return { state: 'not-configured', channel: null, lastError: null }
    }
  }

  private handleAuthStatus(status: YouTubeAuthStatus): void {
    if (this.disposed) return
    // A fresh sign-in supersedes whatever the API last told us about our credentials.
    if (status.state === 'signed-in') this.authErrorOverride = null
    if (status.state === 'signed-out' || status.state === 'not-configured') {
      this.stream = null
      this.broadcast = null
      this.channel = null
      this.cachedApi = null
    }
    this.publish()
  }

  /** Record that the API rejected our credentials, and tell the auth layer if it wants to know. */
  private markAuthError(message: string): void {
    this.authErrorOverride = message
    this.cachedApi = null
    try {
      this.auth.reportAuthFailure?.(message)
    } catch (cause) {
      this.log.warn('the auth service rejected an auth-failure report', { cause })
    }
    this.publish()
  }

  private async callAuth(
    invoke: () => Promise<Result<YouTubeAuthStatus>>
  ): Promise<Result<YouTubeAuthStatus>> {
    try {
      return await invoke()
    } catch (cause) {
      const { error } = classifyGoogleError(cause)
      return { ok: false, error }
    }
  }

  private writeTemplate(template: BroadcastTemplate): Result<void> {
    const persist = this.persistTemplate
    if (persist === null) return ok(undefined)
    try {
      const written = persist(template)
      if (!written.ok) {
        this.log.error('the broadcast template could not be saved', {
          detail: written.error.message
        })
      }
      return written
    } catch (cause) {
      const error: AppError = { code: ErrorCode.IO_ERROR, message: String(cause) }
      this.log.error('the broadcast template could not be saved', { detail: error.message })
      return { ok: false, error }
    }
  }

  /** Build the renderer-facing snapshot. Cheap and pure over the current fields. */
  private snapshot(): YouTubeStatus {
    const auth = this.effectiveAuthStatus()
    return {
      auth,
      broadcast: this.broadcast,
      stream: this.stream,
      template: this.template,
      preflight: computePreflight({
        auth,
        stream: this.stream,
        broadcast: this.broadcast,
        template: this.template,
        songs: this.readSongs(),
        ccliStreamingLicenceNumber: this.readLicence(),
        quotaUnitsUsed: this.quotaUnits,
        ...(this.quotaPerDay === null ? {} : { quotaUnitsPerDay: this.quotaPerDay })
      })
    }
  }

  /** The auth seam's status, overridden to `auth-error` when the API itself rejected us. */
  private effectiveAuthStatus(): YouTubeAuthStatus {
    const base = this.readAuthStatus()
    const channel = base.channel ?? this.channel
    const override = this.authErrorOverride
    if (override !== null && base.state !== 'not-configured') {
      return { state: 'auth-error', channel, lastError: override }
    }
    return { state: base.state, channel, lastError: base.lastError }
  }

  private readSongs(): readonly PreflightSong[] {
    try {
      return this.songs()
    } catch (cause) {
      this.log.warn('the queued-song list could not be read for the pre-flight check', { cause })
      return []
    }
  }

  private readLicence(): string | null {
    try {
      return this.ccliLicence()
    } catch (cause) {
      this.log.warn('the CCLI licence number could not be read', { cause })
      return null
    }
  }

  /** Notify subscribers, but only when something observable actually changed. */
  private publish(): void {
    if (this.disposed) return
    const next = this.snapshot()
    const serialised = JSON.stringify(next)
    if (serialised === this.lastEmitted) return
    this.lastEmitted = serialised

    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(next)
      } catch (cause) {
        this.log.warn('a YouTube status subscriber threw', { cause })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Project a `liveStream` resource onto {@link PersistentStream}.
 *
 * Exported for the tests that assert the stream **key** is not carried across: this function
 * reads `id`, `snippet.title`, `cdn.ingestionInfo.ingestionAddress` and `status.healthStatus`,
 * and nothing else. `cdn.ingestionInfo.streamName` is never touched.
 */
export function toPersistentStream(resource: LiveStreamResource): PersistentStream {
  const ingestion = resource.cdn?.ingestionInfo
  return {
    id: resource.id ?? '',
    title: resource.snippet?.title ?? PERSISTENT_STREAM_TITLE,
    ingestAddress: ingestion?.ingestionAddress ?? ingestion?.rtmpsIngestionAddress ?? null,
    health: toStreamHealth(resource.status?.healthStatus?.status ?? null)
  }
}

/** YouTube's health strings, narrowed. Anything unrecognised is treated as "no data yet". */
export function toStreamHealth(raw: string | null): StreamHealth {
  switch (raw) {
    case 'good':
      return 'good'
    case 'ok':
      return 'ok'
    case 'bad':
      return 'bad'
    default:
      return 'noData'
  }
}

/**
 * YouTube's `lifeCycleStatus`, narrowed to the contract's six values.
 *
 * `testStarting` and `liveStarting` are transient states YouTube reports mid-transition; they are
 * folded into `testing` and `live` because the operator cares about where the broadcast is going,
 * not about the half-second it spends getting there.
 */
export function toBroadcastLifecycle(raw: string | null): BroadcastLifecycle {
  switch (raw) {
    case 'ready':
      return 'ready'
    case 'testing':
    case 'testStarting':
      return 'testing'
    case 'live':
    case 'liveStarting':
      return 'live'
    case 'complete':
      return 'complete'
    case 'revoked':
      return 'revoked'
    default:
      return 'created'
  }
}

/** YouTube's `privacyStatus`, narrowed. An unrecognised value falls back to the template's. */
export function toBroadcastPrivacy(raw: string | null, fallback: BroadcastPrivacy): BroadcastPrivacy {
  switch (raw) {
    case 'public':
      return 'public'
    case 'unlisted':
      return 'unlisted'
    case 'private':
      return 'private'
    default:
      return fallback
  }
}

/** Project a `liveBroadcast` resource onto {@link Broadcast}. */
export function toBroadcast(
  resource: LiveBroadcastResource,
  template: BroadcastTemplate,
  scheduledFallback: string,
  idFallback: string
): Broadcast {
  const id = resource.id ?? idFallback
  const boundStreamId = resource.contentDetails?.boundStreamId ?? null
  return {
    id,
    title: resource.snippet?.title ?? template.titleTemplate,
    privacy: toBroadcastPrivacy(resource.status?.privacyStatus ?? null, template.privacy),
    scheduledStartTime: resource.snippet?.scheduledStartTime ?? scheduledFallback,
    lifecycle: toBroadcastLifecycle(resource.status?.lifeCycleStatus ?? null),
    boundStreamId: boundStreamId === '' ? null : boundStreamId,
    watchUrl: id === '' ? null : `https://www.youtube.com/watch?v=${id}`
  }
}

/** Project a `channel` resource onto {@link YouTubeChannel}. */
export function toChannel(resource: ChannelResource): YouTubeChannel {
  return {
    id: resource.id ?? '',
    title: resource.snippet?.title ?? 'this channel',
    customUrl: resource.snippet?.customUrl ?? null
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** The outcome of reading an unknown thrown value from `googleapis`. */
export interface ClassifiedGoogleError {
  readonly error: AppError
  /** `true` when the credentials themselves were rejected, so auth must move to `auth-error`. */
  readonly authFailure: boolean
}

/** Reasons Google returns for a spent quota, as distinct from a momentary rate limit. */
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceeded402'])

/** Reasons that mean "rate-limited right now", which a retry a minute later would clear. */
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'servingLimitExceeded',
  'backendError'
])

/** 403 reasons that are about the *channel*, not the token — re-authorising would not help. */
const LIVE_PERMISSION_REASONS = new Set([
  'liveStreamingNotEnabled',
  'livePermissionBlocked',
  'liveBroadcastNotEnabled'
])

/**
 * Turn anything `googleapis` throws into a coded {@link AppError}.
 *
 * Defensive to the point of paranoia about the shape, because `GaxiosError` is not a stable
 * contract and the alternative — an unhandled rejection during a live service — is unacceptable.
 * A plain `Error`, a string, `undefined`, and a fully-formed Google error envelope all map to
 * something the renderer can act on.
 *
 * Never logs, never includes a token: only Google's own message text is carried through.
 */
export function classifyGoogleError(cause: unknown): ClassifiedGoogleError {
  const status = readStatus(cause)
  const reasons = readReasons(cause)
  const message = readMessage(cause)

  if (reasons.some((reason) => QUOTA_REASONS.has(reason))) {
    return {
      error: {
        code: ErrorCode.RATE_LIMITED,
        message:
          "YouTube's daily API quota for this Google Cloud project is exhausted. It resets at midnight Pacific time; until then no new broadcast can be created.",
        detail: `quota exceeded: ${message}`
      },
      authFailure: false
    }
  }

  if (status === 429 || reasons.some((reason) => RATE_REASONS.has(reason))) {
    return {
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: 'YouTube is rate-limiting Verger. Wait a moment and try again.',
        detail: message
      },
      authFailure: false
    }
  }

  if (status === 403 && reasons.some((reason) => LIVE_PERMISSION_REASONS.has(reason))) {
    return {
      error: {
        code: ErrorCode.NOT_CONFIGURED,
        message:
          'This YouTube channel is not enabled for live streaming. Enable live streaming in YouTube Studio (it can take 24 hours to activate) and try again.',
        detail: message
      },
      // Not an auth failure: the token is fine, the channel is not. Signing in again would only
      // waste the operator's time.
      authFailure: false
    }
  }

  if (status === 401 || status === 403) {
    return {
      error: {
        code: ErrorCode.NOT_CONFIGURED,
        message:
          'YouTube rejected Verger\'s authorisation. Sign out and sign in again to re-authorise the channel.',
        detail: message
      },
      authFailure: true
    }
  }

  if (status === 404) {
    return {
      error: { code: ErrorCode.NOT_FOUND, message: 'YouTube could not find that resource.', detail: message },
      authFailure: false
    }
  }

  if (status === 400) {
    return {
      error: { code: ErrorCode.INVALID_ARG, message: `YouTube rejected the request: ${message}`, detail: message },
      authFailure: false
    }
  }

  const networkCode = readNetworkCode(cause)
  if (networkCode === 'ETIMEDOUT' || networkCode === 'ECONNABORTED') {
    return {
      error: { code: ErrorCode.TIMEOUT, message: 'The request to YouTube timed out.', detail: message },
      authFailure: false
    }
  }
  if (
    networkCode === 'ENOTFOUND' ||
    networkCode === 'ECONNREFUSED' ||
    networkCode === 'ECONNRESET' ||
    networkCode === 'EAI_AGAIN' ||
    (status !== null && status >= 500)
  ) {
    return {
      error: {
        code: ErrorCode.NOT_CONNECTED,
        message: 'YouTube is unreachable. OBS keeps streaming and recording regardless.',
        detail: message
      },
      authFailure: false
    }
  }

  return {
    error: { code: ErrorCode.INTERNAL, message: `The YouTube request failed: ${message}`, detail: message },
    authFailure: false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** HTTP status, from any of the four places `googleapis` versions have put it. */
function readStatus(cause: unknown): number | null {
  const root = asRecord(cause)
  if (root === null) return null

  const direct = numeric(root['status']) ?? numeric(root['code'])
  if (direct !== null) return direct

  const response = asRecord(root['response'])
  const fromResponse = response === null ? null : numeric(response['status'])
  if (fromResponse !== null) return fromResponse

  const errorBody = readErrorBody(root)
  if (errorBody !== null) {
    const fromBody = numeric(errorBody['code'])
    if (fromBody !== null) return fromBody
  }
  return null
}

/** The `{ error: { code, message, status, errors[] } }` envelope, wherever it is hiding. */
function readErrorBody(root: Record<string, unknown>): Record<string, unknown> | null {
  const response = asRecord(root['response'])
  const data = response === null ? asRecord(root['data']) : asRecord(response['data'])
  if (data === null) return asRecord(root['error'])
  return asRecord(data['error'])
}

/** `error.errors[].reason` plus the top-level `error.status`, deduplicated. */
function readReasons(cause: unknown): readonly string[] {
  const root = asRecord(cause)
  if (root === null) return []

  const reasons: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') reasons.push(value)
  }
  const collectFromList = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const entry of list as readonly unknown[]) {
      const record = asRecord(entry)
      if (record !== null) push(record['reason'])
    }
  }

  // Older googleapis put `errors` straight on the thrown object.
  collectFromList(root['errors'])

  const errorBody = readErrorBody(root)
  if (errorBody !== null) {
    push(errorBody['status'])
    collectFromList(errorBody['errors'])
  }

  return [...new Set(reasons)]
}

function readMessage(cause: unknown): string {
  const root = asRecord(cause)
  if (root !== null) {
    const errorBody = readErrorBody(root)
    const nested = errorBody === null ? undefined : errorBody['message']
    if (typeof nested === 'string' && nested !== '') return nested

    const direct = root['message']
    if (typeof direct === 'string' && direct !== '') return direct
  }
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** A libuv/Node error code, when the failure never reached Google at all. */
function readNetworkCode(cause: unknown): string | null {
  const root = asRecord(cause)
  if (root === null) return null
  const code = root['code']
  return typeof code === 'string' && code !== '' ? code : null
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value)
  return null
}
