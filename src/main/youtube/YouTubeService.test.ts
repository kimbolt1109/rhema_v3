/**
 * `YouTubeService` unit tests.
 *
 * **No test in this file makes a network call.** There is no Google account and no OAuth client
 * on this machine, and there never will be, so the entire YouTube Data API arrives through the
 * injected {@link YouTubeApiLike} seam and is satisfied here by a hand-written mock that records
 * every call. `googleapis` is never imported. To make that a property rather than a promise, the
 * last test in this file replaces `globalThis.fetch` (and blows up on any `http`/`https` request)
 * for the duration of a full create-and-bind flow.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Logger, LogFields } from '@shared/log'
import { ErrorCode } from '@shared/result'
import type { Result } from '@shared/result'
import { defaultBroadcastTemplate } from '@shared/youtube'
import type { BroadcastTemplate, YouTubeAuthState, YouTubeAuthStatus } from '@shared/youtube'

import {
  PERSISTENT_STREAM_TITLE,
  YouTubeService,
  classifyGoogleError,
  toBroadcastLifecycle,
  toPersistentStream,
  toStreamHealth
} from './YouTubeService'
import type {
  ChannelResource,
  ListResponse,
  LiveBroadcastResource,
  LiveStreamResource,
  ThumbnailPayload,
  YouTubeApiLike,
  YouTubeApiResponse,
  YouTubeAuthLike
} from './YouTubeService'
import { PreflightCode } from './preflight'

// ---------------------------------------------------------------------------
// The canary
// ---------------------------------------------------------------------------

/**
 * A stand-in for the RTMP stream key.
 *
 * The real `liveStreams` response carries `cdn.ingestionInfo.streamName`, which is a credential:
 * anyone holding it can broadcast to the channel. Fixtures below include it, and the tests assert
 * this exact string never appears in anything the service returns or logs.
 */
const STREAM_KEY_CANARY = 'xxxx-SECRET-STREAM-KEY-DO-NOT-LEAK-xxxx'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields: LogFields | undefined
}

function createRecordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const make = (): Logger => ({
    debug: (message, fields) => lines.push({ level: 'debug', message, fields }),
    info: (message, fields) => lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => lines.push({ level: 'error', message, fields }),
    child: () => make()
  })
  return { logger: make(), lines }
}

interface StubAuth extends YouTubeAuthLike {
  set(state: YouTubeAuthState, lastError?: string | null): void
  readonly failures: string[]
  readonly clientCalls: { count: number }
}

function createStubAuth(initial: YouTubeAuthState = 'signed-in'): StubAuth {
  let status: YouTubeAuthStatus = {
    state: initial,
    channel: initial === 'signed-in' ? { id: 'UC123', title: 'Grace Chapel', customUrl: '@grace' } : null,
    lastError: null
  }
  const listeners = new Set<(next: YouTubeAuthStatus) => void>()
  const failures: string[] = []
  const clientCalls = { count: 0 }

  return {
    failures,
    clientCalls,
    set(state, lastError = null) {
      status = { state, channel: status.channel, lastError }
      for (const listener of [...listeners]) listener(status)
    },
    getStatus: () => status,
    signIn: () => Promise.resolve({ ok: true as const, value: status }),
    signOut: () => Promise.resolve({ ok: true as const, value: status }),
    onStatus: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    getAuthClient: () => {
      clientCalls.count += 1
      return Promise.resolve({ ok: true as const, value: { token: 'fake-oauth-client' } })
    },
    reportAuthFailure: (message) => {
      failures.push(message)
    }
  }
}

interface MockApi {
  api: YouTubeApiLike
  /** Every call, in order, as `"resource.method"`. The ordering assertions read this. */
  readonly calls: string[]
  readonly params: Record<string, unknown>[]
  streams: LiveStreamResource[]
  /** Set to make the next call of that name reject. */
  readonly rejections: Map<string, unknown>
  insertedBroadcast: LiveBroadcastResource
  boundBroadcast: LiveBroadcastResource
  transitionedBroadcast: LiveBroadcastResource
  channels: ChannelResource[]
}

function persistentStreamFixture(overrides: Partial<LiveStreamResource> = {}): LiveStreamResource {
  return {
    id: 'stream-abc',
    snippet: { title: PERSISTENT_STREAM_TITLE },
    cdn: {
      ingestionInfo: {
        ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
        rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2',
        // The credential. Present in the fixture precisely so the tests can prove it is dropped.
        ...({ streamName: STREAM_KEY_CANARY } as Record<string, string>)
      }
    },
    status: { streamStatus: 'ready', healthStatus: { status: 'good' } },
    ...overrides
  }
}

function createMockApi(): MockApi {
  const state: MockApi = {
    calls: [],
    params: [],
    streams: [persistentStreamFixture()],
    rejections: new Map<string, unknown>(),
    insertedBroadcast: {
      id: 'bcast-1',
      snippet: {
        title: 'Sunday Service — 2026-03-15',
        description: 'Welcome',
        scheduledStartTime: '2026-03-15T09:08:00.000Z'
      },
      status: { lifeCycleStatus: 'created', privacyStatus: 'unlisted' },
      contentDetails: { boundStreamId: null }
    },
    boundBroadcast: {
      id: 'bcast-1',
      snippet: {
        title: 'Sunday Service — 2026-03-15',
        description: 'Welcome',
        scheduledStartTime: '2026-03-15T09:08:00.000Z'
      },
      status: { lifeCycleStatus: 'ready', privacyStatus: 'unlisted' },
      contentDetails: { boundStreamId: 'stream-abc' }
    },
    transitionedBroadcast: {
      id: 'bcast-1',
      snippet: { title: 'Sunday Service — 2026-03-15', scheduledStartTime: '2026-03-15T09:08:00.000Z' },
      status: { lifeCycleStatus: 'live', privacyStatus: 'unlisted' },
      contentDetails: { boundStreamId: 'stream-abc' }
    },
    channels: [{ id: 'UC123', snippet: { title: 'Grace Chapel', customUrl: '@grace' } }],
    api: undefined as unknown as YouTubeApiLike
  }

  const record = <T>(name: string, params: object, value: T): Promise<YouTubeApiResponse<T>> => {
    state.calls.push(name)
    state.params.push({ ...params })
    const rejection = state.rejections.get(name)
    if (rejection !== undefined) return Promise.reject(rejection)
    return Promise.resolve({ data: value })
  }

  state.api = {
    liveBroadcasts: {
      insert: (params) => record('liveBroadcasts.insert', params, state.insertedBroadcast),
      bind: (params) => record('liveBroadcasts.bind', params, state.boundBroadcast),
      list: (params) =>
        record<ListResponse<LiveBroadcastResource>>('liveBroadcasts.list', params, {
          items: [state.boundBroadcast]
        }),
      transition: (params) =>
        record('liveBroadcasts.transition', params, state.transitionedBroadcast)
    },
    liveStreams: {
      list: (params) =>
        record<ListResponse<LiveStreamResource>>('liveStreams.list', params, {
          items: state.streams
        }),
      insert: (params) => {
        const created = persistentStreamFixture({
          id: 'stream-new',
          status: { streamStatus: 'created', healthStatus: { status: 'noData' } }
        })
        return record('liveStreams.insert', params, created)
      }
    },
    thumbnails: {
      set: (params) => record('thumbnails.set', params, {})
    },
    channels: {
      list: (params) =>
        record<ListResponse<ChannelResource>>('channels.list', params, { items: state.channels })
    }
  }

  return state
}

const FIXED_NOW = new Date('2026-03-15T09:03:20.500Z')

interface Harness {
  readonly service: YouTubeService
  readonly mock: MockApi
  readonly auth: StubAuth
  readonly lines: RecordedLog[]
  readonly factoryCalls: { count: number }
  readonly thumbnailCalls: string[]
}

function createHarness(
  overrides: {
    authState?: YouTubeAuthState
    template?: BroadcastTemplate
    thumbnail?: (path: string) => Result<ThumbnailPayload>
    songs?: () => readonly { title?: string | null; author?: string | null; ccliSongNumber?: string | null; publisher?: string | null }[]
    ccli?: () => string | null
  } = {}
): Harness {
  const mock = createMockApi()
  const auth = createStubAuth(overrides.authState ?? 'signed-in')
  const { logger, lines } = createRecordingLogger()
  const factoryCalls = { count: 0 }
  const thumbnailCalls: string[] = []

  const service = new YouTubeService({
    auth,
    logger,
    apiFactory: () => {
      factoryCalls.count += 1
      return mock.api
    },
    now: () => FIXED_NOW,
    template: overrides.template ?? defaultBroadcastTemplate(),
    ...(overrides.thumbnail === undefined
      ? {}
      : {
          readThumbnail: (path: string): Result<ThumbnailPayload> => {
            thumbnailCalls.push(path)
            return overrides.thumbnail!(path)
          }
        }),
    ...(overrides.songs === undefined ? {} : { songs: overrides.songs }),
    ...(overrides.ccli === undefined ? {} : { ccliStreamingLicenceNumber: overrides.ccli })
  })

  return { service, mock, auth, lines, factoryCalls, thumbnailCalls }
}

/** A Google API error envelope, shaped the way `GaxiosError` presents one. */
function googleError(status: number, reason: string, message: string): unknown {
  const error = new Error(message) as Error & Record<string, unknown>
  error.code = status
  error.status = status
  error.response = {
    status,
    data: { error: { code: status, message, errors: [{ reason, message }] } }
  }
  return error
}

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------

describe('YouTubeService — not configured', () => {
  it('renders a complete status with an empty .env and never crashes', () => {
    const { service } = createHarness({ authState: 'not-configured' })
    const status = service.getStatus()

    expect(status.auth.state).toBe('not-configured')
    expect(status.broadcast).toBeNull()
    expect(status.stream).toBeNull()
    expect(status.template).toEqual(defaultBroadcastTemplate())
    expect(status.preflight.map((issue) => issue.code)).toContain(PreflightCode.NOT_CONFIGURED)
  })

  it('short-circuits every API method without building a client or calling the API at all', async () => {
    const { service, mock, auth, factoryCalls } = createHarness({ authState: 'not-configured' })

    const results = [
      await service.ensurePersistentStream(),
      await service.createBroadcast(),
      await service.transition('live'),
      await service.refresh()
    ]

    for (const result of results) {
      expect(result.ok).toBe(false)
    }
    // `transition` refuses earlier still (no broadcast), which is also a NOT_FOUND, not a crash.
    expect(mock.calls).toEqual([])
    expect(factoryCalls.count).toBe(0)
    expect(auth.clientCalls.count).toBe(0)
  })

  it('reports NOT_CONFIGURED with an actionable message', async () => {
    const { service } = createHarness({ authState: 'not-configured' })
    const result = await service.ensurePersistentStream()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(result.error.message).toContain('GOOGLE_CLIENT_ID')
  })

  it('refuses while signed out without spending a call', async () => {
    const { service, mock } = createHarness({ authState: 'signed-out' })
    const result = await service.ensurePersistentStream()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(mock.calls).toEqual([])
  })

  it('spends no quota when nothing was called', () => {
    const { service } = createHarness({ authState: 'not-configured' })
    expect(service.quotaUnitsUsed()).toBe(0)
  })

  it('construction performs no API call', () => {
    const { mock, factoryCalls, auth } = createHarness()
    expect(mock.calls).toEqual([])
    expect(factoryCalls.count).toBe(0)
    expect(auth.clientCalls.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The persistent stream
// ---------------------------------------------------------------------------

describe('YouTubeService.ensurePersistentStream', () => {
  it('reuses an existing stream and does NOT call liveStreams.insert', async () => {
    const { service, mock } = createHarness()

    const result = await service.ensurePersistentStream()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe('stream-abc')
    expect(mock.calls).toEqual(['liveStreams.list'])
    expect(mock.calls).not.toContain('liveStreams.insert')
  })

  it('creates one only when no stream carries the Verger title', async () => {
    const { service, mock } = createHarness()
    mock.streams = [
      { id: 'someone-elses', snippet: { title: 'My Other Stream' }, status: { healthStatus: { status: 'noData' } } }
    ]

    const result = await service.ensurePersistentStream()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe('stream-new')
    expect(mock.calls).toEqual(['liveStreams.list', 'liveStreams.insert'])
  })

  it('asks for a REUSABLE stream, which is what keeps the RTMP key stable', async () => {
    const { service, mock } = createHarness()
    mock.streams = []

    await service.ensurePersistentStream()

    const insertParams = mock.params[mock.calls.indexOf('liveStreams.insert')] as {
      requestBody: { contentDetails: { isReusable: boolean }; snippet: { title: string } }
    }
    expect(insertParams.requestBody.contentDetails.isReusable).toBe(true)
    expect(insertParams.requestBody.snippet.title).toBe(PERSISTENT_STREAM_TITLE)
  })

  it('never surfaces the RTMP stream key', async () => {
    const { service } = createHarness()

    const result = await service.ensurePersistentStream()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.value)).not.toContain(STREAM_KEY_CANARY)
    expect(JSON.stringify(service.getStatus())).not.toContain(STREAM_KEY_CANARY)
    expect(Object.keys(result.value)).toEqual(['id', 'title', 'ingestAddress', 'health'])
  })

  it('never logs the RTMP stream key', async () => {
    const { service, lines } = createHarness()
    await service.ensurePersistentStream()
    expect(JSON.stringify(lines)).not.toContain(STREAM_KEY_CANARY)
  })

  it('exposes the ingest address and health but nothing else', () => {
    const stream = toPersistentStream(persistentStreamFixture())
    expect(stream).toEqual({
      id: 'stream-abc',
      title: PERSISTENT_STREAM_TITLE,
      ingestAddress: 'rtmp://a.rtmp.youtube.com/live2',
      health: 'good'
    })
  })
})

// ---------------------------------------------------------------------------
// createBroadcast
// ---------------------------------------------------------------------------

describe('YouTubeService.createBroadcast', () => {
  it('lists the stream, inserts, then binds — in that order', async () => {
    const { service, mock } = createHarness()

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    expect(mock.calls).toEqual(['liveStreams.list', 'liveBroadcasts.insert', 'liveBroadcasts.bind'])
  })

  it('binds the inserted broadcast id to the persistent stream id', async () => {
    const { service, mock } = createHarness()

    await service.createBroadcast()

    const bindParams = mock.params[mock.calls.indexOf('liveBroadcasts.bind')] as {
      id: string
      streamId: string
    }
    expect(bindParams).toMatchObject({ id: 'bcast-1', streamId: 'stream-abc' })
  })

  it('expands {date} in the title with the injected clock', async () => {
    const template: BroadcastTemplate = {
      ...defaultBroadcastTemplate(),
      titleTemplate: 'Morning Service — {date} ({date})'
    }
    const { service, mock } = createHarness({ template })

    await service.createBroadcast()

    const insertParams = mock.params[mock.calls.indexOf('liveBroadcasts.insert')] as {
      requestBody: { snippet: { title: string } }
    }
    expect(insertParams.requestBody.snippet.title).toMatch(
      /^Morning Service — \d{4}-\d{2}-\d{2} \(\d{4}-\d{2}-\d{2}\)$/
    )
    expect(insertParams.requestBody.snippet.title).not.toContain('{date}')
  })

  it('sends the template description and privacy', async () => {
    const template: BroadcastTemplate = {
      ...defaultBroadcastTemplate(),
      description: 'Join us this Sunday.',
      privacy: 'private'
    }
    const { service, mock } = createHarness({ template })

    await service.createBroadcast()

    const insertParams = mock.params[mock.calls.indexOf('liveBroadcasts.insert')] as {
      requestBody: { snippet: { description: string }; status: { privacyStatus: string } }
    }
    expect(insertParams.requestBody.snippet.description).toBe('Join us this Sunday.')
    expect(insertParams.requestBody.status.privacyStatus).toBe('private')
  })

  it('defaults the scheduled start to a few minutes ahead of the injected clock', async () => {
    const { service, mock } = createHarness()

    await service.createBroadcast()

    const insertParams = mock.params[mock.calls.indexOf('liveBroadcasts.insert')] as {
      requestBody: { snippet: { scheduledStartTime: string } }
    }
    expect(insertParams.requestBody.snippet.scheduledStartTime).toBe('2026-03-15T09:08:00.000Z')
  })

  it('accepts an explicit scheduled start and normalises it to ISO', async () => {
    const { service, mock } = createHarness()

    await service.createBroadcast({ scheduledStartTime: '2026-03-22T01:00:00Z' })

    const insertParams = mock.params[mock.calls.indexOf('liveBroadcasts.insert')] as {
      requestBody: { snippet: { scheduledStartTime: string } }
    }
    expect(insertParams.requestBody.snippet.scheduledStartTime).toBe('2026-03-22T01:00:00.000Z')
  })

  it('rejects an unparseable scheduled start before any API call', async () => {
    const { service, mock } = createHarness()

    const result = await service.createBroadcast({ scheduledStartTime: 'next tuesday-ish' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(mock.calls).toEqual([])
  })

  it('returns a bound broadcast with a watch URL', async () => {
    const { service } = createHarness()

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      id: 'bcast-1',
      boundStreamId: 'stream-abc',
      lifecycle: 'ready',
      privacy: 'unlisted',
      watchUrl: 'https://www.youtube.com/watch?v=bcast-1'
    })
  })

  it('records the bound stream even when YouTube omits contentDetails from the bind response', async () => {
    const { service, mock } = createHarness()
    mock.boundBroadcast = { id: 'bcast-1', status: { lifeCycleStatus: 'ready' } }

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.boundStreamId).toBe('stream-abc')
  })

  it('fails the whole call when the bind fails — an unbound broadcast is worse than none', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveBroadcasts.bind', googleError(500, 'backendError', 'Backend Error'))

    const result = await service.createBroadcast()

    expect(result.ok).toBe(false)
    expect(mock.calls).toContain('liveBroadcasts.insert')
  })

  it('does not attempt an insert when the stream cannot be resolved', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveStreams.list', googleError(500, 'backendError', 'Backend Error'))

    const result = await service.createBroadcast()

    expect(result.ok).toBe(false)
    expect(mock.calls).not.toContain('liveBroadcasts.insert')
  })
})

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

describe('YouTubeService.createBroadcast — thumbnails are cosmetic', () => {
  const withThumbnail: BroadcastTemplate = {
    ...defaultBroadcastTemplate(),
    thumbnailPath: 'C:/services/cover.jpg'
  }

  it('sets the thumbnail after the bind when the template has one', async () => {
    const { service, mock, thumbnailCalls } = createHarness({
      template: withThumbnail,
      thumbnail: () => ({ ok: true, value: { mimeType: 'image/jpeg', body: 'stream' } })
    })

    await service.createBroadcast()

    expect(thumbnailCalls).toEqual(['C:/services/cover.jpg'])
    expect(mock.calls).toEqual([
      'liveStreams.list',
      'liveBroadcasts.insert',
      'liveBroadcasts.bind',
      'thumbnails.set'
    ])
  })

  it('still succeeds when the thumbnail file cannot be read', async () => {
    const { service, mock } = createHarness({
      template: withThumbnail,
      thumbnail: () => ({ ok: false, error: { code: ErrorCode.NOT_FOUND, message: 'no such file' } })
    })

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    expect(mock.calls).not.toContain('thumbnails.set')
  })

  it('still succeeds when the thumbnail reader throws', async () => {
    const { service } = createHarness({
      template: withThumbnail,
      thumbnail: () => {
        throw new Error('disk on fire')
      }
    })

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
  })

  it('still succeeds when thumbnails.set itself fails', async () => {
    const { service, mock } = createHarness({
      template: withThumbnail,
      thumbnail: () => ({ ok: true, value: { mimeType: 'image/jpeg', body: 'stream' } })
    })
    mock.rejections.set('thumbnails.set', googleError(400, 'invalidImage', 'Invalid image'))

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.boundStreamId).toBe('stream-abc')
  })

  it('skips thumbnails entirely when no reader is configured', async () => {
    const { service, mock } = createHarness({ template: withThumbnail })

    const result = await service.createBroadcast()

    expect(result.ok).toBe(true)
    expect(mock.calls).not.toContain('thumbnails.set')
  })
})

// ---------------------------------------------------------------------------
// transition + health (defined here, driven by Phase 5)
// ---------------------------------------------------------------------------

describe('YouTubeService.transition', () => {
  it('refuses a target YouTube does not accept', async () => {
    const { service, mock } = createHarness()
    await service.createBroadcast()
    mock.calls.length = 0

    const result = await service.transition('created')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(mock.calls).toEqual([])
  })

  it('refuses when there is no broadcast', async () => {
    const { service } = createHarness()
    const result = await service.transition('live')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('moves an existing broadcast and keeps the bound stream', async () => {
    const { service, mock } = createHarness()
    await service.createBroadcast()
    mock.calls.length = 0
    mock.params.length = 0

    const result = await service.transition('live')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lifecycle).toBe('live')
    expect(result.value.boundStreamId).toBe('stream-abc')
    expect(mock.params[0]).toMatchObject({ id: 'bcast-1', broadcastStatus: 'live' })
  })
})

describe('YouTubeService.pollStreamHealth', () => {
  it('refuses before a stream has been resolved', async () => {
    const { service } = createHarness()
    const result = await service.pollStreamHealth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('re-reads the health of the known stream', async () => {
    const { service, mock } = createHarness()
    await service.ensurePersistentStream()
    mock.streams = [
      persistentStreamFixture({ status: { healthStatus: { status: 'bad' } } })
    ]

    const result = await service.pollStreamHealth()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.health).toBe('bad')
    expect(JSON.stringify(result.value)).not.toContain(STREAM_KEY_CANARY)
  })

  it('reports NOT_FOUND when the stream has vanished from the channel', async () => {
    const { service, mock } = createHarness()
    await service.ensurePersistentStream()
    mock.streams = []

    const result = await service.pollStreamHealth()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('is never driven automatically by this service', () => {
    const timer = vi.spyOn(globalThis, 'setInterval')
    createHarness()
    expect(timer).not.toHaveBeenCalled()
    timer.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('YouTubeService — error mapping', () => {
  it('moves auth to auth-error on a 401 and explains re-authorising', async () => {
    const { service, mock, auth } = createHarness()
    mock.rejections.set('liveStreams.list', googleError(401, 'authError', 'Invalid Credentials'))

    const result = await service.ensurePersistentStream()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/sign out and sign in again/i)
    expect(service.getStatus().auth.state).toBe('auth-error')
    expect(auth.failures).toHaveLength(1)
    expect(service.getStatus().preflight.map((issue) => issue.code)).toContain(
      PreflightCode.AUTH_ERROR
    )
  })

  it('moves auth to auth-error on a bare 403 too', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveStreams.list', googleError(403, 'forbidden', 'Forbidden'))

    await service.ensurePersistentStream()

    expect(service.getStatus().auth.state).toBe('auth-error')
  })

  it('clears the auth error once a call succeeds again', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveStreams.list', googleError(401, 'authError', 'Invalid Credentials'))
    await service.ensurePersistentStream()
    expect(service.getStatus().auth.state).toBe('auth-error')

    mock.rejections.clear()
    await service.ensurePersistentStream()

    expect(service.getStatus().auth.state).toBe('signed-in')
  })

  it('maps a spent daily quota to a distinguishable RATE_LIMITED message', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set(
      'liveBroadcasts.insert',
      googleError(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.')
    )

    const result = await service.createBroadcast()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.RATE_LIMITED)
    expect(result.error.message).toMatch(/daily API quota/i)
    expect(result.error.message).toMatch(/midnight Pacific/i)
    // A spent quota is not a credentials problem; it must not send the operator to sign in again.
    expect(service.getStatus().auth.state).toBe('signed-in')
  })

  it('distinguishes a momentary rate limit from a spent quota', () => {
    const spent = classifyGoogleError(googleError(403, 'quotaExceeded', 'quota'))
    const throttled = classifyGoogleError(googleError(403, 'rateLimitExceeded', 'slow down'))

    expect(spent.error.code).toBe(ErrorCode.RATE_LIMITED)
    expect(throttled.error.code).toBe(ErrorCode.RATE_LIMITED)
    expect(spent.error.message).not.toBe(throttled.error.message)
    expect(throttled.error.message).toMatch(/wait a moment/i)
  })

  it('maps a 404 to NOT_FOUND', () => {
    const { error, authFailure } = classifyGoogleError(googleError(404, 'notFound', 'Not Found'))
    expect(error.code).toBe(ErrorCode.NOT_FOUND)
    expect(authFailure).toBe(false)
  })

  it('maps a 400 to INVALID_ARG', () => {
    const { error } = classifyGoogleError(googleError(400, 'invalidValue', 'Bad Request'))
    expect(error.code).toBe(ErrorCode.INVALID_ARG)
  })

  it('treats a channel not enabled for live streaming as configuration, not bad credentials', () => {
    const { error, authFailure } = classifyGoogleError(
      googleError(403, 'liveStreamingNotEnabled', 'Live streaming is not enabled')
    )
    expect(error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(error.message).toMatch(/YouTube Studio/i)
    expect(authFailure).toBe(false)
  })

  it('maps an unreachable network to NOT_CONNECTED and reassures about OBS', () => {
    const offline = new Error('getaddrinfo ENOTFOUND www.googleapis.com') as Error &
      Record<string, unknown>
    offline.code = 'ENOTFOUND'
    const { error } = classifyGoogleError(offline)
    expect(error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(error.message).toMatch(/OBS keeps streaming/i)
  })

  it('maps a timeout to TIMEOUT', () => {
    const slow = new Error('timeout of 30000ms exceeded') as Error & Record<string, unknown>
    slow.code = 'ETIMEDOUT'
    expect(classifyGoogleError(slow).error.code).toBe(ErrorCode.TIMEOUT)
  })

  it('never throws on a nonsense cause', () => {
    for (const cause of [undefined, null, 'boom', 42, {}, [], new Error('plain')]) {
      const { error } = classifyGoogleError(cause)
      expect(typeof error.code).toBe('string')
      expect(typeof error.message).toBe('string')
    }
  })

  it('survives a non-throwing but rejecting API with no useful shape', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveStreams.list', 'just a string')
    const result = await service.ensurePersistentStream()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INTERNAL)
  })
})

// ---------------------------------------------------------------------------
// Template, status and subscriptions
// ---------------------------------------------------------------------------

describe('YouTubeService.setTemplate', () => {
  it('rejects an invalid template without changing the current one', () => {
    const { service } = createHarness()
    const before = service.getStatus().template

    const result = service.setTemplate({
      titleTemplate: '',
      description: '',
      privacy: 'unlisted',
      thumbnailPath: null,
      timeZone: 'Asia/Seoul'
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(service.getStatus().template).toEqual(before)
  })

  it('accepts a valid template and reflects it in the status', () => {
    const { service } = createHarness()

    const result = service.setTemplate({
      titleTemplate: 'Evening Service — {date}',
      description: 'Come along',
      privacy: 'public',
      thumbnailPath: null,
      timeZone: 'Europe/London'
    })

    expect(result.ok).toBe(true)
    expect(service.getStatus().template.titleTemplate).toBe('Evening Service — {date}')
    // Public privacy is a deliberate speed bump, surfaced immediately.
    expect(service.getStatus().preflight.map((issue) => issue.code)).toContain(
      PreflightCode.PRIVACY_PUBLIC
    )
  })

  it('reports a persistence failure without rolling the template back', () => {
    const mock = createMockApi()
    const { logger } = createRecordingLogger()
    const service = new YouTubeService({
      auth: createStubAuth(),
      logger,
      apiFactory: () => mock.api,
      persistTemplate: () => ({ ok: false, error: { code: ErrorCode.IO_ERROR, message: 'read-only disk' } })
    })

    const result = service.setTemplate({ ...defaultBroadcastTemplate(), description: 'kept' })

    expect(result.ok).toBe(false)
    expect(service.getStatus().template.description).toBe('kept')
  })
})

describe('YouTubeService.onStatus', () => {
  it('notifies subscribers when the template changes', () => {
    const { service } = createHarness()
    const seen: string[] = []
    service.onStatus((status) => seen.push(status.template.titleTemplate))

    service.setTemplate({ ...defaultBroadcastTemplate(), titleTemplate: 'A — {date}' })
    service.setTemplate({ ...defaultBroadcastTemplate(), titleTemplate: 'B — {date}' })

    expect(seen).toEqual(['A — {date}', 'B — {date}'])
  })

  it('does not re-notify for an unchanged status', () => {
    const { service } = createHarness()
    const seen: unknown[] = []
    service.onStatus((status) => seen.push(status))

    service.setTemplate(defaultBroadcastTemplate())
    service.setTemplate(defaultBroadcastTemplate())

    expect(seen).toHaveLength(0)
  })

  it('survives a subscriber that throws', () => {
    const { service, lines } = createHarness()
    service.onStatus(() => {
      throw new Error('renderer gone')
    })

    expect(() => service.setTemplate({ ...defaultBroadcastTemplate(), description: 'x' })).not.toThrow()
    expect(lines.some((line) => line.message.includes('subscriber threw'))).toBe(true)
  })

  it('stops notifying after unsubscribe and after dispose', () => {
    const { service } = createHarness()
    const seen: unknown[] = []
    const unsubscribe = service.onStatus((status) => seen.push(status))

    unsubscribe()
    service.setTemplate({ ...defaultBroadcastTemplate(), description: 'one' })
    expect(seen).toHaveLength(0)

    service.onStatus((status) => seen.push(status))
    service.dispose()
    service.setTemplate({ ...defaultBroadcastTemplate(), description: 'two' })
    expect(seen).toHaveLength(0)
  })
})

describe('YouTubeService — sign out', () => {
  it('drops every cached YouTube resource so the next operator sees nothing of the last', async () => {
    const { service } = createHarness()
    await service.createBroadcast()
    expect(service.getStatus().broadcast).not.toBeNull()

    await service.signOut()

    expect(service.getStatus().broadcast).toBeNull()
    expect(service.getStatus().stream).toBeNull()
  })
})

describe('YouTubeService.refresh', () => {
  it('reads the channel and the stream without a broadcast in play', async () => {
    const { service, mock } = createHarness()

    const result = await service.refresh()

    expect(result.ok).toBe(true)
    expect(mock.calls).toEqual(['channels.list', 'liveStreams.list'])
    expect(service.getStatus().auth.channel?.title).toBe('Grace Chapel')
  })

  it('re-reads a broadcast that already exists', async () => {
    const { service, mock } = createHarness()
    await service.createBroadcast()
    mock.calls.length = 0

    await service.refresh()

    expect(mock.calls).toContain('liveBroadcasts.list')
  })
})

describe('YouTubeService — quota accounting', () => {
  it('counts the expensive writes so the UI can warn before the allowance runs out', async () => {
    const { service } = createHarness()
    expect(service.quotaUnitsUsed()).toBe(0)

    await service.createBroadcast()

    // list (1) + insert (50) + bind (50)
    expect(service.quotaUnitsUsed()).toBe(101)
  })

  it('counts a failed call too — Google charges for it either way', async () => {
    const { service, mock } = createHarness()
    mock.rejections.set('liveStreams.list', googleError(500, 'backendError', 'Backend Error'))

    await service.ensurePersistentStream()

    expect(service.quotaUnitsUsed()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

describe('resource narrowing', () => {
  it('folds YouTube\'s transient lifecycle states into the contract\'s six', () => {
    expect(toBroadcastLifecycle('testStarting')).toBe('testing')
    expect(toBroadcastLifecycle('liveStarting')).toBe('live')
    expect(toBroadcastLifecycle('complete')).toBe('complete')
    expect(toBroadcastLifecycle('revoked')).toBe('revoked')
    expect(toBroadcastLifecycle('something-new-in-2027')).toBe('created')
    expect(toBroadcastLifecycle(null)).toBe('created')
  })

  it('treats an unknown health string as no data rather than as bad', () => {
    expect(toStreamHealth('good')).toBe('good')
    expect(toStreamHealth('ok')).toBe('ok')
    expect(toStreamHealth('bad')).toBe('bad')
    expect(toStreamHealth('revoked')).toBe('noData')
    expect(toStreamHealth(null)).toBe('noData')
  })

  it('falls back to the rtmps ingest address when the rtmp one is absent', () => {
    const stream = toPersistentStream({
      id: 's',
      snippet: { title: PERSISTENT_STREAM_TITLE },
      cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://only' } }
    })
    expect(stream.ingestAddress).toBe('rtmps://only')
  })
})

// ---------------------------------------------------------------------------
// The no-network guarantee
// ---------------------------------------------------------------------------

describe('the no-network guarantee', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  it('completes a full create-and-bind flow with fetch booby-trapped', async () => {
    const attempted: string[] = []
    globalThis.fetch = ((input: unknown) => {
      attempted.push(String(input))
      throw new Error('a unit test attempted a network call')
    }) as typeof globalThis.fetch

    try {
      const { service } = createHarness()
      const result = await service.createBroadcast()
      expect(result.ok).toBe(true)
      await service.transition('live')
      await service.pollStreamHealth()
      await service.refresh()
      expect(attempted).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
