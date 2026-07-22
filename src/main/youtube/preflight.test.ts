/**
 * `computePreflight` tests.
 *
 * This is the last thing between the operator and a mistake, so it is tested exhaustively: every
 * auth state, every legal gate from `docs/v2-notes/LEGAL_AND_CONTENT.md`, and the purity property
 * itself. No mocks are needed at all — that is the point of keeping it pure.
 */

import { describe, expect, it } from 'vitest'

import { defaultBroadcastTemplate } from '@shared/youtube'
import type {
  Broadcast,
  BroadcastTemplate,
  PersistentStream,
  PreflightIssue,
  YouTubeAuthState,
  YouTubeAuthStatus
} from '@shared/youtube'

import {
  DEFAULT_DAILY_QUOTA_UNITS,
  PreflightCode,
  computePreflight,
  missingCopyrightFields,
  preflightBlocks
} from './preflight'
import type { PreflightInput, PreflightSong } from './preflight'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function auth(state: YouTubeAuthState, lastError: string | null = null): YouTubeAuthStatus {
  return {
    state,
    channel: state === 'signed-in' ? { id: 'UC1', title: 'Grace Chapel', customUrl: null } : null,
    lastError
  }
}

const healthyStream: PersistentStream = {
  id: 'stream-abc',
  title: 'Verger Persistent Stream',
  ingestAddress: 'rtmp://a.rtmp.youtube.com/live2',
  health: 'good'
}

const boundBroadcast: Broadcast = {
  id: 'bcast-1',
  title: 'Sunday Service — 2026-03-15',
  privacy: 'unlisted',
  scheduledStartTime: '2026-03-15T09:08:00.000Z',
  lifecycle: 'ready',
  boundStreamId: 'stream-abc',
  watchUrl: 'https://www.youtube.com/watch?v=bcast-1'
}

/** The happy path: signed in, stream resolved, broadcast bound, licence recorded, unlisted. */
function readyInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    auth: auth('signed-in'),
    stream: healthyStream,
    broadcast: boundBroadcast,
    template: defaultBroadcastTemplate(),
    ccliStreamingLicenceNumber: '1234567',
    ...overrides
  }
}

function codes(issues: readonly PreflightIssue[]): string[] {
  return issues.map((issue) => issue.code)
}

function severityOf(issues: readonly PreflightIssue[], code: string): string | undefined {
  return issues.find((issue) => issue.code === code)?.severity
}

// ---------------------------------------------------------------------------
// The clean state
// ---------------------------------------------------------------------------

describe('computePreflight — nothing to report', () => {
  it('returns no issues when everything is in order', () => {
    expect(computePreflight(readyInput())).toEqual([])
    expect(preflightBlocks(computePreflight(readyInput()))).toBe(false)
  })

  it('is pure — the same snapshot always produces the identical list', () => {
    const input = readyInput({ auth: auth('signed-out'), stream: null })
    const first = computePreflight(input)
    const second = computePreflight(input)
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('never mutates its input', () => {
    const input = readyInput({ songs: [{ title: 'Untitled Hymn' }] })
    const before = JSON.stringify(input)
    computePreflight(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe('computePreflight — auth', () => {
  it('blocks when YouTube is not configured, and explains which .env keys are missing', () => {
    const issues = computePreflight(readyInput({ auth: auth('not-configured') }))
    expect(codes(issues)).toContain(PreflightCode.NOT_CONFIGURED)
    expect(severityOf(issues, PreflightCode.NOT_CONFIGURED)).toBe('error')
    expect(issues[0]?.message).toMatch(/GOOGLE_CLIENT_ID/)
    expect(issues[0]?.message).toMatch(/GOOGLE_CLIENT_SECRET/)
    expect(preflightBlocks(issues)).toBe(true)
  })

  it('blocks when signed out', () => {
    const issues = computePreflight(readyInput({ auth: auth('signed-out') }))
    expect(codes(issues)).toContain(PreflightCode.SIGNED_OUT)
    expect(preflightBlocks(issues)).toBe(true)
  })

  it('blocks mid sign-in', () => {
    const issues = computePreflight(readyInput({ auth: auth('authorizing') }))
    expect(codes(issues)).toContain(PreflightCode.AUTHORIZING)
    expect(preflightBlocks(issues)).toBe(true)
  })

  it('blocks on a rejected token and carries the reason through when there is one', () => {
    const withReason = computePreflight(readyInput({ auth: auth('auth-error', 'token revoked') }))
    expect(withReason[0]?.message).toContain('token revoked')

    const withoutReason = computePreflight(readyInput({ auth: auth('auth-error') }))
    expect(withoutReason[0]?.message).toMatch(/sign in again/i)
    expect(preflightBlocks(withoutReason)).toBe(true)
  })

  it('reports nothing about auth when signed in', () => {
    const issues = computePreflight(readyInput())
    expect(codes(issues)).not.toContain(PreflightCode.SIGNED_OUT)
    expect(codes(issues)).not.toContain(PreflightCode.AUTH_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Stream and binding gates
// ---------------------------------------------------------------------------

describe('computePreflight — the persistent stream', () => {
  it('blocks when no persistent stream has been resolved', () => {
    const issues = computePreflight(readyInput({ stream: null }))
    expect(codes(issues)).toContain(PreflightCode.NO_PERSISTENT_STREAM)
    expect(severityOf(issues, PreflightCode.NO_PERSISTENT_STREAM)).toBe('error')
  })

  it('blocks when a broadcast exists but is not bound to the stream', () => {
    const issues = computePreflight(
      readyInput({ broadcast: { ...boundBroadcast, boundStreamId: null } })
    )
    expect(codes(issues)).toContain(PreflightCode.BROADCAST_NOT_BOUND)
    expect(severityOf(issues, PreflightCode.BROADCAST_NOT_BOUND)).toBe('error')
    expect(issues[0]?.message).toContain(boundBroadcast.title)
  })

  it('says nothing about binding when there is no broadcast yet', () => {
    const issues = computePreflight(readyInput({ broadcast: null }))
    expect(codes(issues)).not.toContain(PreflightCode.BROADCAST_NOT_BOUND)
  })

  it('warns, but does not block, on an unhealthy ingest', () => {
    const issues = computePreflight(readyInput({ stream: { ...healthyStream, health: 'bad' } }))
    expect(severityOf(issues, PreflightCode.STREAM_UNHEALTHY)).toBe('warning')
    expect(preflightBlocks(issues)).toBe(false)
  })

  it('treats noData as normal — OBS has simply not started pushing yet', () => {
    const issues = computePreflight(readyInput({ stream: { ...healthyStream, health: 'noData' } }))
    expect(codes(issues)).not.toContain(PreflightCode.STREAM_UNHEALTHY)
  })

  it('accepts ok health without comment', () => {
    const issues = computePreflight(readyInput({ stream: { ...healthyStream, health: 'ok' } }))
    expect(issues).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The CCLI licence gate — LEGAL_AND_CONTENT.md row 2
// ---------------------------------------------------------------------------

describe('computePreflight — the CCLI streaming-licence gate', () => {
  it('warns when no licence number is recorded', () => {
    const issues = computePreflight(readyInput({ ccliStreamingLicenceNumber: null }))
    expect(codes(issues)).toContain(PreflightCode.CCLI_LICENCE_MISSING)
    expect(severityOf(issues, PreflightCode.CCLI_LICENCE_MISSING)).toBe('warning')
  })

  it('warns when the field is present but blank', () => {
    const issues = computePreflight(readyInput({ ccliStreamingLicenceNumber: '   ' }))
    expect(codes(issues)).toContain(PreflightCode.CCLI_LICENCE_MISSING)
  })

  it('warns when the field is simply absent from the snapshot', () => {
    const input: PreflightInput = {
      auth: auth('signed-in'),
      stream: healthyStream,
      broadcast: boundBroadcast,
      template: defaultBroadcastTemplate()
    }
    expect(codes(computePreflight(input))).toContain(PreflightCode.CCLI_LICENCE_MISSING)
  })

  it('says the streaming licence is a separate licence, and disclaims affiliation', () => {
    const issues = computePreflight(readyInput({ ccliStreamingLicenceNumber: null }))
    const message = issues.find((issue) => issue.code === PreflightCode.CCLI_LICENCE_MISSING)?.message
    expect(message).toMatch(/separate/i)
    expect(message).toMatch(/not affiliated/i)
  })

  it('does not block — Verger cannot verify a licence and must not refuse a service on a guess', () => {
    const issues = computePreflight(readyInput({ ccliStreamingLicenceNumber: null }))
    expect(preflightBlocks(issues)).toBe(false)
  })

  it('is silent once a number is recorded', () => {
    const issues = computePreflight(readyInput({ ccliStreamingLicenceNumber: '  1234567 ' }))
    expect(codes(issues)).not.toContain(PreflightCode.CCLI_LICENCE_MISSING)
  })
})

// ---------------------------------------------------------------------------
// Song copyright metadata — LEGAL_AND_CONTENT.md row 4
// ---------------------------------------------------------------------------

describe('computePreflight — songs missing copyright metadata', () => {
  const complete: PreflightSong = {
    title: 'A Hymn',
    author: 'A. Author',
    ccliSongNumber: '7654321',
    publisher: 'A Publisher'
  }

  it('reports nothing when every queued song is fully attributed', () => {
    expect(computePreflight(readyInput({ songs: [complete, complete] }))).toEqual([])
  })

  it('reports nothing when Phase 6 has not supplied a song list yet', () => {
    expect(computePreflight(readyInput({ songs: [] }))).toEqual([])
    expect(computePreflight(readyInput())).toEqual([])
  })

  it('warns once per song, naming the song', () => {
    const issues = computePreflight(
      readyInput({ songs: [complete, { title: 'Mystery Song' }, { title: 'Another Mystery' }] })
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]?.message).toContain('"Mystery Song"')
    expect(issues[1]?.message).toContain('"Another Mystery"')
  })

  it('names exactly which fields are missing', () => {
    const issues = computePreflight(
      readyInput({ songs: [{ title: 'Half Known', author: 'A. Author' }] })
    )
    expect(issues[0]?.message).toContain('a CCLI song number and a publisher')
    expect(issues[0]?.message).not.toContain('an author')
  })

  it('handles a song with no title at all', () => {
    const issues = computePreflight(readyInput({ songs: [{}] }))
    expect(issues[0]?.message).toContain('an untitled song')
  })

  it('treats a blank field as missing', () => {
    const issues = computePreflight(
      readyInput({ songs: [{ ...complete, ccliSongNumber: '   ' }] })
    )
    expect(issues[0]?.message).toContain('a CCLI song number')
  })

  it('treats an explicit null the same as absent', () => {
    expect(missingCopyrightFields({ author: null, ccliSongNumber: null, publisher: null })).toEqual([
      'an author',
      'a CCLI song number',
      'a publisher'
    ])
  })

  it('warns rather than blocks — the operator may still have the rights', () => {
    const issues = computePreflight(readyInput({ songs: [{ title: 'Mystery Song' }] }))
    expect(severityOf(issues, PreflightCode.SONG_MISSING_COPYRIGHT)).toBe('warning')
    expect(preflightBlocks(issues)).toBe(false)
  })

  it('explains why it matters — attribution cannot be composed without the metadata', () => {
    const issues = computePreflight(readyInput({ songs: [{ title: 'Mystery Song' }] }))
    expect(issues[0]?.message).toMatch(/attribution/i)
  })
})

// ---------------------------------------------------------------------------
// The public-privacy speed bump
// ---------------------------------------------------------------------------

describe('computePreflight — public privacy', () => {
  const publicTemplate: BroadcastTemplate = { ...defaultBroadcastTemplate(), privacy: 'public' }

  it('warns every time the template is public', () => {
    const issues = computePreflight(readyInput({ template: publicTemplate }))
    expect(codes(issues)).toContain(PreflightCode.PRIVACY_PUBLIC)
    expect(severityOf(issues, PreflightCode.PRIVACY_PUBLIC)).toBe('warning')
  })

  it('says why it is not recoverable', () => {
    const issues = computePreflight(readyInput({ template: publicTemplate }))
    const message = issues.find((issue) => issue.code === PreflightCode.PRIVACY_PUBLIC)?.message
    expect(message).toMatch(/PUBLIC/)
    expect(message).toMatch(/cannot be un-published/i)
  })

  it('is silent for unlisted and private', () => {
    for (const privacy of ['unlisted', 'private'] as const) {
      const issues = computePreflight(
        readyInput({ template: { ...defaultBroadcastTemplate(), privacy } })
      )
      expect(codes(issues)).not.toContain(PreflightCode.PRIVACY_PUBLIC)
    }
  })
})

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('computePreflight — quota awareness', () => {
  it('says nothing when usage is unknown', () => {
    expect(codes(computePreflight(readyInput()))).not.toContain(
      PreflightCode.QUOTA_NEARLY_EXHAUSTED
    )
  })

  it('says nothing at a comfortable level — a few services a day is fine', () => {
    const issues = computePreflight(readyInput({ quotaUnitsUsed: 1200 }))
    expect(codes(issues)).not.toContain(PreflightCode.QUOTA_NEARLY_EXHAUSTED)
  })

  it('warns once four-fifths of the daily allowance is spent', () => {
    const issues = computePreflight(
      readyInput({ quotaUnitsUsed: DEFAULT_DAILY_QUOTA_UNITS * 0.8 })
    )
    expect(codes(issues)).toContain(PreflightCode.QUOTA_NEARLY_EXHAUSTED)
    expect(severityOf(issues, PreflightCode.QUOTA_NEARLY_EXHAUSTED)).toBe('warning')
  })

  it('honours a project with a raised allowance', () => {
    const issues = computePreflight(
      readyInput({ quotaUnitsUsed: 9000, quotaUnitsPerDay: 1_000_000 })
    )
    expect(codes(issues)).not.toContain(PreflightCode.QUOTA_NEARLY_EXHAUSTED)
  })

  it('does not divide by a nonsensical allowance', () => {
    expect(() =>
      computePreflight(readyInput({ quotaUnitsUsed: 5, quotaUnitsPerDay: 0 }))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('computePreflight — ordering', () => {
  it('puts every error before every warning', () => {
    const issues = computePreflight({
      auth: auth('signed-out'),
      stream: null,
      broadcast: null,
      template: { ...defaultBroadcastTemplate(), privacy: 'public' },
      songs: [{ title: 'Mystery Song' }],
      ccliStreamingLicenceNumber: null
    })

    const firstWarning = issues.findIndex((issue) => issue.severity === 'warning')
    const lastError = issues.map((issue) => issue.severity).lastIndexOf('error')
    expect(lastError).toBeLessThan(firstWarning)
  })

  it('reports every problem at once rather than one at a time', () => {
    const issues = computePreflight({
      auth: auth('signed-out'),
      stream: null,
      broadcast: null,
      template: { ...defaultBroadcastTemplate(), privacy: 'public' },
      songs: [{ title: 'Mystery Song' }],
      ccliStreamingLicenceNumber: null
    })

    expect(codes(issues)).toEqual([
      PreflightCode.SIGNED_OUT,
      PreflightCode.NO_PERSISTENT_STREAM,
      PreflightCode.CCLI_LICENCE_MISSING,
      PreflightCode.SONG_MISSING_COPYRIGHT,
      PreflightCode.PRIVACY_PUBLIC
    ])
  })
})
