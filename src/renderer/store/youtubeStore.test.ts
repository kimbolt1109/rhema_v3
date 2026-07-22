/**
 * The YouTube store's contract.
 *
 * Three properties carry most of the weight:
 *
 *  - **No credentials is a resting state.** With no `GOOGLE_CLIENT_ID` the store settles into
 *    `not-configured` and every action returns an `Err`. Nothing throws, ever.
 *  - **Nothing is predicted.** A refused sign-in does not leave a channel on screen; a refused
 *    template save does not change the mirrored template.
 *  - **Layer independence holds here too.** Signing in, saving a template and creating a broadcast
 *    produce zero overlay commands and zero camera calls.
 *
 * No test here touches the network: the whole surface runs against `createMockVergerApi`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'
import type { PreflightIssue, YouTubeStatus } from '@shared/youtube'
import { defaultBroadcastTemplate } from '@shared/youtube'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_PREFLIGHT_CCLI,
  MOCK_PREFLIGHT_METADATA,
  MOCK_YOUTUBE_CHANNEL,
  installMockVergerApi,
  mockBroadcast,
  mockNotConfiguredYouTubeStatus,
  mockPersistentStream,
  mockSignedInYouTubeStatus,
} from '../test/mockVergerApi'
import {
  YOUTUBE_BRIDGE_UNAVAILABLE_MESSAGE,
  isYouTubeConfigured,
  resetYouTubeStore,
  summarisePreflight,
  useYouTubeStore,
} from './youtubeStore'

/** A signed-out (but configured) status: there *is* an OAuth client, nobody has consented yet. */
function signedOutStatus(): YouTubeStatus {
  return mockNotConfiguredYouTubeStatus({
    auth: { state: 'signed-out', channel: null, lastError: null },
  })
}

describe('youtubeStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetYouTubeStore()
  })

  it('settles into not-configured instead of throwing', async () => {
    await useYouTubeStore.getState().hydrate()

    const store = useYouTubeStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.status.auth.state).toBe('not-configured')
    expect(store.status.auth.channel).toBeNull()
    expect(store.status.broadcast).toBeNull()
    expect(store.status.stream).toBeNull()
    expect(store.status.template).toEqual(defaultBroadcastTemplate())
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.lastError?.message).toBe(YOUTUBE_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from every action rather than dereferencing undefined', async () => {
    const signIn = await useYouTubeStore.getState().signIn()
    const signOut = await useYouTubeStore.getState().signOut()
    const template = await useYouTubeStore.getState().setTemplate(defaultBroadcastTemplate())
    const broadcast = await useYouTubeStore.getState().createBroadcast()

    for (const result of [signIn, signOut, template, broadcast]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    }

    const store = useYouTubeStore.getState()
    expect(store.authorizing).toBe(false)
    expect(store.saving).toBe(false)
    expect(store.creating).toBe(false)
  })

  it('subscribe() returns a no-op unsubscribe that is safe to call', () => {
    const unsubscribe = useYouTubeStore.getState().subscribe()
    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(useYouTubeStore.getState().bridgeAvailable).toBe(false)
  })
})

describe('youtubeStore with no Google credentials', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    // The fake's default. This is the state this machine is genuinely in.
    installed = installMockVergerApi()
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates to not-configured with no error — an absent client is not a fault', async () => {
    await useYouTubeStore.getState().hydrate()

    const store = useYouTubeStore.getState()
    expect(store.bridgeAvailable).toBe(true)
    expect(store.hydrated).toBe(true)
    expect(store.status.auth.state).toBe('not-configured')
    expect(store.lastError).toBeNull()
  })

  it('refuses a sign-in and stays signed out rather than inventing a channel', async () => {
    await useYouTubeStore.getState().hydrate()

    const result = await useYouTubeStore.getState().signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    const store = useYouTubeStore.getState()
    expect(store.status.auth.channel).toBeNull()
    expect(store.status.auth.state).toBe('not-configured')
    expect(store.authorizing).toBe(false)
  })
})

describe('youtubeStore with a configured bridge', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ youtubeGetStatus: ok(signedOutStatus()) })
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('signs in and adopts the channel the main process reported', async () => {
    await useYouTubeStore.getState().hydrate()

    const result = await useYouTubeStore.getState().signIn()

    expect(installed.mock.calls.youtubeSignIn).toHaveLength(1)
    expect(result.ok).toBe(true)
    const store = useYouTubeStore.getState()
    expect(store.status.auth.state).toBe('signed-in')
    expect(store.status.auth.channel).toEqual(MOCK_YOUTUBE_CHANNEL)
    expect(store.authorizing).toBe(false)
    expect(store.lastError).toBeNull()
  })

  it('signs out and drops the channel', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()

    const result = await useYouTubeStore.getState().signOut()

    expect(result.ok).toBe(true)
    const store = useYouTubeStore.getState()
    expect(store.status.auth.state).toBe('signed-out')
    expect(store.status.auth.channel).toBeNull()
  })

  it('keeps the last known status when a sign-in is refused', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()
    installed.mock.responses.youtubeSignOut = err(ErrorCode.TIMEOUT, 'google did not answer')

    const result = await useYouTubeStore.getState().signOut()

    expect(result.ok).toBe(false)
    const store = useYouTubeStore.getState()
    // Still signed in: the refusal did not revoke anything, so claiming otherwise would be a lie.
    expect(store.status.auth.state).toBe('signed-in')
    expect(store.lastError?.code).toBe(ErrorCode.TIMEOUT)
    expect(store.authorizing).toBe(false)
  })

  it('forwards the exact template and adopts what the main process stored', async () => {
    await useYouTubeStore.getState().hydrate()
    const next = { ...defaultBroadcastTemplate(), titleTemplate: '주일예배 — {date}' }

    const result = await useYouTubeStore.getState().setTemplate(next)

    expect(installed.mock.calls.youtubeSetTemplate).toEqual([next])
    expect(result.ok).toBe(true)
    expect(useYouTubeStore.getState().status.template.titleTemplate).toBe('주일예배 — {date}')
    expect(useYouTubeStore.getState().saving).toBe(false)
  })

  it('keeps the previous template when a save is refused', async () => {
    await useYouTubeStore.getState().hydrate()
    installed.mock.responses.youtubeSetTemplate = err(ErrorCode.IO_ERROR, 'disk full')

    const result = await useYouTubeStore
      .getState()
      .setTemplate({ ...defaultBroadcastTemplate(), titleTemplate: 'Wrecked' })

    expect(result.ok).toBe(false)
    const store = useYouTubeStore.getState()
    expect(store.status.template).toEqual(defaultBroadcastTemplate())
    expect(store.lastError?.code).toBe(ErrorCode.IO_ERROR)
    expect(store.saving).toBe(false)
  })

  it('creates a broadcast, forwarding the scheduled start verbatim', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()

    const result = await useYouTubeStore
      .getState()
      .createBroadcast({ scheduledStartTime: '2024-03-03T01:00:00.000Z' })

    expect(installed.mock.calls.youtubeCreateBroadcast).toEqual([
      { scheduledStartTime: '2024-03-03T01:00:00.000Z' },
    ])
    expect(result.ok).toBe(true)
    const store = useYouTubeStore.getState()
    expect(store.status.broadcast?.scheduledStartTime).toBe('2024-03-03T01:00:00.000Z')
    expect(store.status.broadcast?.boundStreamId).not.toBeNull()
    expect(store.creating).toBe(false)
  })

  it('omits scheduledStartTime entirely when none was chosen', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()

    await useYouTubeStore.getState().createBroadcast()

    expect(installed.mock.calls.youtubeCreateBroadcast).toEqual([{}])
  })

  it('leaves the mirrored broadcast alone when creation is refused', async () => {
    await useYouTubeStore.getState().hydrate()
    installed.mock.responses.youtubeCreateBroadcast = err(
      ErrorCode.RATE_LIMITED,
      'daily quota exhausted',
    )

    const result = await useYouTubeStore.getState().createBroadcast()

    expect(result.ok).toBe(false)
    const store = useYouTubeStore.getState()
    expect(store.status.broadcast).toBeNull()
    expect(store.lastError?.code).toBe(ErrorCode.RATE_LIMITED)
    expect(store.creating).toBe(false)
  })

  it('applies a pushed status and stops listening after unsubscribe', () => {
    const unsubscribe = useYouTubeStore.getState().subscribe()

    installed.mock.emit(
      IpcEvent.youtubeStatus,
      mockSignedInYouTubeStatus({
        stream: mockPersistentStream({ health: 'good' }),
        broadcast: mockBroadcast(),
        preflight: [MOCK_PREFLIGHT_CCLI],
      }),
    )

    const store = useYouTubeStore.getState()
    expect(store.status.auth.channel?.title).toBe(MOCK_YOUTUBE_CHANNEL.title)
    expect(store.status.stream?.health).toBe('good')
    expect(store.status.preflight).toHaveLength(1)

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.youtubeStatus)).toBe(0)
  })

  it('clears the in-flight flag when a pushed status settles the sign-in', async () => {
    useYouTubeStore.getState().subscribe()
    const pending = useYouTubeStore.getState().signIn()

    installed.mock.emit(IpcEvent.youtubeStatus, mockSignedInYouTubeStatus())
    expect(useYouTubeStore.getState().authorizing).toBe(false)

    await pending
  })

  it('keeps the last known status when the status read fails', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()
    installed.mock.responses.youtubeGetStatus = err(ErrorCode.INTERNAL, 'handler blew up')

    await useYouTubeStore.getState().hydrate()

    const store = useYouTubeStore.getState()
    expect(store.status.auth.state).toBe('signed-in')
    expect(store.lastError?.code).toBe(ErrorCode.INTERNAL)
    expect(store.hydrated).toBe(true)
  })

  it('converts a rejected bridge promise into an Err instead of propagating it', async () => {
    window.verger = {
      ...installed.mock.api,
      youtube: {
        ...installed.mock.api.youtube,
        signIn: () => Promise.reject(new Error('bridge exploded')),
      },
    }

    const result = await useYouTubeStore.getState().signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL)
      expect(result.error.message).toBe('bridge exploded')
    }
    expect(useYouTubeStore.getState().authorizing).toBe(false)
  })

  it('never touches the overlay or the cameras, whatever it is asked to do', async () => {
    await useYouTubeStore.getState().hydrate()
    await useYouTubeStore.getState().signIn()
    await useYouTubeStore.getState().setTemplate(defaultBroadcastTemplate())
    await useYouTubeStore.getState().createBroadcast()
    await useYouTubeStore.getState().signOut()

    expect(installed.mock.calls.overlaySend).toEqual([])
    expect(installed.mock.calls.overlayGetState).toEqual([])
    expect(installed.mock.calls.cameraSelect).toEqual([])
    expect(installed.mock.calls.cameraSetConfig).toEqual([])
  })
})

describe('summarisePreflight', () => {
  it('reports nothing blocking for an empty list', () => {
    const summary = summarisePreflight([])
    expect(summary.errors).toEqual([])
    expect(summary.warnings).toEqual([])
    expect(summary.blocking).toBe(false)
  })

  it('separates errors from warnings and blocks only on errors', () => {
    const summary = summarisePreflight([MOCK_PREFLIGHT_METADATA, MOCK_PREFLIGHT_CCLI])

    expect(summary.errors).toEqual([MOCK_PREFLIGHT_CCLI])
    expect(summary.warnings).toEqual([MOCK_PREFLIGHT_METADATA])
    expect(summary.blocking).toBe(true)
  })

  it('does not block on warnings alone — that judgement is the operator’s', () => {
    const warnings: readonly PreflightIssue[] = [MOCK_PREFLIGHT_METADATA]
    expect(summarisePreflight(warnings).blocking).toBe(false)
  })
})

describe('isYouTubeConfigured', () => {
  it('is false only for not-configured', () => {
    expect(isYouTubeConfigured('not-configured')).toBe(false)
    expect(isYouTubeConfigured('signed-out')).toBe(true)
    expect(isYouTubeConfigured('authorizing')).toBe(true)
    expect(isYouTubeConfigured('signed-in')).toBe(true)
    expect(isYouTubeConfigured('auth-error')).toBe(true)
  })
})
