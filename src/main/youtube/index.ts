/**
 * The YouTube module's public surface, and the one place `googleapis`, `node:fs` and Electron
 * are touched.
 *
 * {@link YouTubeService} knows nothing about `google.youtube('v3')`, the filesystem or
 * `app.getPath('userData')`: it takes an API factory, a thumbnail reader and a pair of
 * persistence seams. This file supplies the real ones, so the service stays testable in a plain
 * Node process with no Electron runtime, no network and no Google account.
 *
 * The singleton is **lazy and inert**. Constructing it opens no socket, starts no timer, spends
 * no quota and makes no network call — it subscribes to the OAuth service and reads one small
 * JSON file. With an empty `.env` there is no OAuth client to build, the auth seam reports
 * `not-configured`, and the Go Live screen renders a complete explanation instead of a crash
 * (Standing Rule 5).
 */

import { existsSync, createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import { app } from 'electron'
import { google } from 'googleapis'
import type { youtube_v3 } from 'googleapis'

import { createNullLogger } from '@main/logging/logger'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { Result } from '@shared/result'
import { broadcastTemplateSchema, defaultBroadcastTemplate } from '@shared/youtube'
import type { BroadcastTemplate, YouTubeAuthStatus } from '@shared/youtube'

import { createOAuthService } from './OAuthService'
import { YouTubeService } from './YouTubeService'
import type {
  ThumbnailPayload,
  YouTubeApiLike,
  YouTubeAuthLike,
  YouTubeServiceOptions
} from './YouTubeService'
import type { PreflightSong } from './preflight'

export { computePreflight, preflightBlocks, missingCopyrightFields, PreflightCode, DEFAULT_DAILY_QUOTA_UNITS, QUOTA_WARNING_FRACTION } from './preflight'
export type { PreflightInput, PreflightSong, PreflightCodeValue } from './preflight'
export {
  YouTubeService,
  PERSISTENT_STREAM_TITLE,
  QUOTA_COST,
  DEFAULT_START_LEAD_MS,
  classifyGoogleError,
  toBroadcast,
  toBroadcastLifecycle,
  toBroadcastPrivacy,
  toChannel,
  toPersistentStream,
  toStreamHealth
} from './YouTubeService'
export type {
  ChannelResource,
  ClassifiedGoogleError,
  ListResponse,
  LiveBroadcastResource,
  LiveStreamResource,
  ThumbnailPayload,
  ThumbnailReader,
  YouTubeApiFactory,
  YouTubeApiLike,
  YouTubeAuthLike,
  YouTubeApiResponse,
  YouTubeServiceOptions
} from './YouTubeService'

// The OAuth flow — loopback redirect, `state` verification, safeStorage-backed refresh token —
// lives in `./OAuthService` and is re-exported here so the rest of the main process has one
// import path for the whole YouTube module. The scopes are that module's to own; re-exporting
// rather than restating them keeps a second, drifting copy from existing.
export {
  OAuthService,
  createOAuthService,
  createNodeLoopbackServer,
  parseCallback,
  YOUTUBE_OAUTH_SCOPES,
  REFRESH_TOKEN_SECRET_KEY,
  LOOPBACK_HOST
} from './OAuthService'
export type { CreateOAuthServiceOptions, OAuthServiceOptions } from './OAuthService'

/** On-disk envelope for the template. The version is for migrations, never feature detection. */
const FILE_VERSION = 1

// ---------------------------------------------------------------------------
// The real googleapis client
// ---------------------------------------------------------------------------

/**
 * Build the narrow {@link YouTubeApiLike} from the real `googleapis` client.
 *
 * Written as an explicit adapter rather than a cast so the eight methods Verger uses are visible
 * in one place, and so a breaking change in `googleapis` shows up here as a type error rather
 * than at 09:58 on a Sunday. The `params` objects are widened on the way in because the generated
 * `Params$Resource$*` types spell `part` as a mutable `string[]`.
 */
export function createYouTubeApi(authClient: unknown): YouTubeApiLike {
  const youtube = google.youtube({ version: 'v3', auth: authClient as never })
  // The generated `Params$Resource$*` types spell `part` as a mutable `string[]`; Verger's seam
  // keeps it `readonly`. Copying is the whole of the impedance mismatch.
  const part = (parts: readonly string[]): string[] => [...parts]

  return {
    liveBroadcasts: {
      insert: (params) =>
        youtube.liveBroadcasts.insert({
          part: part(params.part),
          requestBody: params.requestBody as youtube_v3.Schema$LiveBroadcast
        }),
      bind: (params) =>
        youtube.liveBroadcasts.bind({
          part: part(params.part),
          id: params.id,
          streamId: params.streamId
        }),
      list: (params) =>
        youtube.liveBroadcasts.list({
          part: part(params.part),
          ...(params.id === undefined ? {} : { id: [...params.id] }),
          ...(params.mine === undefined ? {} : { mine: params.mine })
        }),
      transition: (params) =>
        youtube.liveBroadcasts.transition({
          part: part(params.part),
          id: params.id,
          broadcastStatus: params.broadcastStatus
        })
    },
    liveStreams: {
      list: (params) =>
        youtube.liveStreams.list({
          part: part(params.part),
          ...(params.id === undefined ? {} : { id: [...params.id] }),
          ...(params.mine === undefined ? {} : { mine: params.mine }),
          ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults })
        }),
      insert: (params) =>
        youtube.liveStreams.insert({
          part: part(params.part),
          requestBody: params.requestBody as youtube_v3.Schema$LiveStream
        })
    },
    thumbnails: {
      set: (params) =>
        youtube.thumbnails.set({
          videoId: params.videoId,
          media: { mimeType: params.media.mimeType, body: params.media.body }
        })
    },
    channels: {
      list: (params) =>
        youtube.channels.list({
          part: part(params.part),
          ...(params.mine === undefined ? {} : { mine: params.mine })
        })
    }
  }
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** Extension-to-MIME for the formats YouTube accepts as a thumbnail. */
const THUMBNAIL_MIME_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

/**
 * Open a thumbnail for upload.
 *
 * Streams rather than buffers — a 2 MB image read into memory is harmless, but there is no reason
 * to do it. A missing file is `NOT_FOUND`, an unsupported extension is `INVALID_ARG`, and either
 * way `createBroadcast` logs it and carries on: the thumbnail is cosmetic.
 */
export function readThumbnailFile(path: string): Result<ThumbnailPayload> {
  try {
    if (!existsSync(path)) {
      return err(ErrorCode.NOT_FOUND, 'the thumbnail file does not exist', path)
    }
    const mimeType = THUMBNAIL_MIME_TYPES[extname(path).toLowerCase()]
    if (mimeType === undefined) {
      return err(
        ErrorCode.INVALID_ARG,
        'the thumbnail must be a JPEG, PNG, GIF or BMP image',
        extname(path)
      )
    }
    return ok({ mimeType, body: createReadStream(path) })
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

// ---------------------------------------------------------------------------
// Template persistence
// ---------------------------------------------------------------------------

/** `<userData>/youtube-template.json`. Resolved lazily — `userData` needs a ready `app`. */
export function defaultTemplatePath(): string {
  return join(app.getPath('userData'), 'youtube-template.json')
}

/**
 * Read the saved template.
 *
 * Anything unreadable, missing or invalid yields {@link defaultBroadcastTemplate} rather than an
 * error: a corrupt preferences file must never be the reason a service cannot go live. The file
 * is left on disk so a hand-editing mistake stays recoverable.
 */
export function readTemplateFile(filePath: string): BroadcastTemplate {
  try {
    if (!existsSync(filePath)) return defaultBroadcastTemplate()
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    const validated = broadcastTemplateSchema.safeParse(parsed)
    if (!validated.success) return defaultBroadcastTemplate()
    return {
      titleTemplate: validated.data.titleTemplate,
      description: validated.data.description,
      privacy: validated.data.privacy,
      thumbnailPath: validated.data.thumbnailPath,
      timeZone: validated.data.timeZone
    }
  } catch {
    return defaultBroadcastTemplate()
  }
}

/** Write the template via a temp file and a rename, so a crash mid-write cannot truncate it. */
export function writeTemplateFile(filePath: string, template: BroadcastTemplate): Result<void> {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, ...template }, null, 2), 'utf8')
    renameSync(temporary, filePath)
    return ok(undefined)
  } catch (cause) {
    return { ok: false, error: toAppError(cause, ErrorCode.IO_ERROR) }
  }
}

// ---------------------------------------------------------------------------
// The OAuth seam
// ---------------------------------------------------------------------------

/**
 * A permanently not-configured auth seam.
 *
 * The fallback when the OAuth module exposes nothing recognisable. It is not a silent failure —
 * it is logged — but it *is* a survivable one: the Go Live screen says "not configured", the
 * pre-flight explains it, and the rest of Verger is untouched. There is no state of this app in
 * which a missing Google integration is allowed to be fatal.
 */
export function createUnavailableAuth(reason: string): YouTubeAuthLike {
  const status: YouTubeAuthStatus = { state: 'not-configured', channel: null, lastError: reason }
  return {
    getStatus: () => status,
    signIn: () => Promise.resolve(err(ErrorCode.NOT_CONFIGURED, reason)),
    signOut: () => Promise.resolve(ok(status)),
    onStatus: () => () => undefined,
    getAuthClient: () => Promise.resolve(err(ErrorCode.NOT_CONFIGURED, reason))
  }
}

/**
 * Build the real OAuth service.
 *
 * `createOAuthService` reads `.env` itself and, with no `GOOGLE_*` keys, yields a service that
 * reports `not-configured` and does nothing else — the intended empty-`.env` outcome. The
 * try/catch is for the case it cannot even be constructed (a corrupt secrets file, a keychain
 * that refuses to open): a missing Google integration degrades the Go Live screen and nothing
 * more. There is no state of this app in which it may be fatal.
 */
function resolveAuth(logger: Logger): YouTubeAuthLike {
  try {
    return createOAuthService({ logger })
  } catch (cause) {
    logger.child('youtube').error('the OAuth service could not be created', { cause })
    return createUnavailableAuth('the Google sign-in service failed to start')
  }
}

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

/** Overrides for {@link getYouTubeService}. Every field has a production default. */
export interface GetYouTubeServiceOptions {
  /**
   * Where diagnostics go. Defaults to the null logger, because the rolling-file logger is built
   * inside `app.whenReady()` and there is no module-level singleton to reach for.
   */
  readonly logger?: Logger
  /** Defaults to `<userData>/youtube-template.json`. */
  readonly filePath?: string
  /** Supplied by another slice; lets a caller inject a pre-built auth service. */
  readonly auth?: YouTubeAuthLike
  /** Phase 6 wires the queued-song list into the legal pre-flight through here. */
  readonly songs?: () => readonly PreflightSong[]
  /** The operator's CCLI Streaming Licence number, for the pre-flight gate. */
  readonly ccliStreamingLicenceNumber?: () => string | null
}

let singleton: YouTubeService | null = null

/**
 * The process-wide YouTube service.
 *
 * Callable with no arguments — that is how `src/main/ipc/register.ts` wires it. **Construction
 * performs no network call**: it builds no OAuth client, contacts no Google endpoint and spends
 * no quota. The first request that needs the API is the first one that touches the wire.
 */
export function getYouTubeService(options: GetYouTubeServiceOptions = {}): YouTubeService {
  if (singleton !== null) return singleton

  const logger = options.logger ?? createNullLogger()
  // Resolved lazily inside the seams: `app.getPath('userData')` is only meaningful once the app
  // is ready, and neither seam runs before the service actually needs the file.
  const resolvePath = (): string => options.filePath ?? defaultTemplatePath()

  const serviceOptions: YouTubeServiceOptions = {
    auth: options.auth ?? resolveAuth(logger),
    logger,
    apiFactory: createYouTubeApi,
    template: readTemplateFile(resolvePath()),
    persistTemplate: (template) => writeTemplateFile(resolvePath(), template),
    readThumbnail: readThumbnailFile,
    ...(options.songs === undefined ? {} : { songs: options.songs }),
    ...(options.ccliStreamingLicenceNumber === undefined
      ? {}
      : { ccliStreamingLicenceNumber: options.ccliStreamingLicenceNumber })
  }

  singleton = new YouTubeService(serviceOptions)
  return singleton
}

/** Drop the singleton, disposing it first. For tests and for a clean shutdown. */
export function resetYouTubeService(): void {
  const existing = singleton
  singleton = null
  if (existing !== null) existing.dispose()
}
