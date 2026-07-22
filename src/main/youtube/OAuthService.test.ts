/**
 * OAuthService tests — every one of them runs with **no network, no browser, no Google account
 * and no Electron**.
 *
 * That is not a convenience: there are no Google credentials on this machine and there never will
 * be, so if this flow were only exercisable against the real thing it would be untested code
 * shipped into a Sunday morning. Every seam (`createServer`, `openExternal`, `oauthFactory`,
 * `secrets`, `randomState`, the clock) is injected here, and the fake "browser" is an
 * `openExternal` that reads the `state` out of the consent URL and calls the loopback handler back
 * — which is exactly the shape of the real round-trip, including the parts that can go wrong.
 *
 * Note the import list: nothing here imports `googleapis` or `electron`, because `OAuthService`
 * imports both lazily, inside the functions that need them.
 */

import { describe, expect, it, vi } from 'vitest'

import type { LogFields, Logger } from '@shared/log'
import { err, ok } from '@shared/result'
import type { Result } from '@shared/result'

import type { SecretsStore } from '@main/secrets/secrets'

import {
  OAuthService,
  REFRESH_TOKEN_SECRET_KEY,
  YOUTUBE_OAUTH_SCOPES,
  createNodeLoopbackServer,
  createOAuthService,
  parseCallback
} from './OAuthService'
import type {
  AuthUrlOptions,
  LoopbackHandler,
  LoopbackResponse,
  LoopbackServer,
  LoopbackServerFactory,
  OAuthClientLike,
  OAuthTokens
} from './OAuthService'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const GOOGLE = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' }
const REFRESH_TOKEN = 'refresh-token-1//abcdefghijklmnop'
const STATE = 'state-token-under-test'

interface LogCall {
  readonly level: string
  readonly message: string
  readonly fields: LogFields | undefined
}

function createRecordingLogger(): { readonly logger: Logger; readonly calls: LogCall[] } {
  const calls: LogCall[] = []
  const push =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      calls.push({ level, message, fields })
    }
  const make = (): Logger => ({
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => make()
  })
  return { logger: make(), calls }
}

interface FakeSecrets extends SecretsStore {
  readonly values: Map<string, string>
  readonly deleted: string[]
}

/** `available: false` models a machine where `safeStorage` refuses to encrypt. */
function createFakeSecrets(
  initial: Readonly<Record<string, string>> = {},
  available = true
): FakeSecrets {
  const values = new Map<string, string>(Object.entries(initial))
  const deleted: string[] = []
  return {
    values,
    deleted,
    isAvailable: () => ok(available),
    setSecret: (key, value): Result<void> => {
      if (!available) return err('NOT_CONFIGURED', 'encryption unavailable')
      values.set(key, value)
      return ok(undefined)
    },
    getSecret: (key): Result<string> => {
      const value = values.get(key)
      return value === undefined ? err('NOT_FOUND', 'no such secret') : ok(value)
    },
    deleteSecret: (key): Result<void> => {
      deleted.push(key)
      values.delete(key)
      return ok(undefined)
    }
  }
}

interface FakeServer {
  handler: LoopbackHandler
  listens: number
  closes: number
}

function createFakeServerFactory(port = 51987): {
  readonly factory: LoopbackServerFactory
  readonly servers: FakeServer[]
} {
  const servers: FakeServer[] = []
  const factory: LoopbackServerFactory = (handler): LoopbackServer => {
    const record: FakeServer = { handler, listens: 0, closes: 0 }
    servers.push(record)
    return {
      listen: async (): Promise<number> => {
        record.listens += 1
        return port
      },
      close: async (): Promise<void> => {
        record.closes += 1
      }
    }
  }
  return { factory, servers }
}

interface CapturedResponse extends LoopbackResponse {
  readonly sent: { status: number; headers: Record<string, string>; body: string }
}

function createResponse(): CapturedResponse {
  const sent = { status: 0, headers: {} as Record<string, string>, body: '' }
  return {
    sent,
    writeHead: (status, headers) => {
      sent.status = status
      sent.headers = headers
    },
    end: (body) => {
      sent.body = body ?? ''
    }
  }
}

interface FakeClient extends OAuthClientLike {
  readonly authUrls: string[]
  readonly exchangedCodes: string[]
  readonly credentials: OAuthTokens[]
  readonly authOptions: AuthUrlOptions[]
  revocations: number
}

function createFakeClient(tokens: OAuthTokens = { refresh_token: REFRESH_TOKEN }): FakeClient {
  const authUrls: string[] = []
  const exchangedCodes: string[] = []
  const credentials: OAuthTokens[] = []
  const authOptions: AuthUrlOptions[] = []
  const client: FakeClient = {
    authUrls,
    exchangedCodes,
    credentials,
    authOptions,
    revocations: 0,
    generateAuthUrl: (options) => {
      authOptions.push(options)
      const url = `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(
        options.state
      )}&access_type=${options.access_type}&scope=${encodeURIComponent(options.scope.join(' '))}`
      authUrls.push(url)
      return url
    },
    getToken: async (code) => {
      exchangedCodes.push(code)
      return { tokens }
    },
    setCredentials: (value) => {
      credentials.push(value)
    },
    revokeCredentials: async () => {
      client.revocations += 1
      return undefined
    }
  }
  return client
}

interface Harness {
  readonly service: OAuthService
  readonly servers: FakeServer[]
  readonly client: FakeClient
  readonly secrets: FakeSecrets
  readonly logs: LogCall[]
  readonly openExternal: ReturnType<typeof vi.fn>
  readonly responses: CapturedResponse[]
  readonly factoryCalls: { clientId: string; redirectUri: string | undefined }[]
}

interface HarnessOptions {
  readonly google?: { clientId: string; clientSecret: string } | null
  readonly tokens?: OAuthTokens
  readonly stored?: Readonly<Record<string, string>>
  readonly secretsAvailable?: boolean
  readonly timeoutMs?: number
  /** What the fake browser does with the consent URL. Default: a correct, successful callback. */
  readonly browser?: (url: string, harness: Harness) => void | Promise<void>
}

function createHarness(options: HarnessOptions = {}): Harness {
  const { factory, servers } = createFakeServerFactory()
  const client = createFakeClient(options.tokens ?? { refresh_token: REFRESH_TOKEN })
  const secrets = createFakeSecrets(options.stored ?? {}, options.secretsAvailable ?? true)
  const { logger, calls } = createRecordingLogger()
  const responses: CapturedResponse[] = []
  const factoryCalls: { clientId: string; redirectUri: string | undefined }[] = []

  const harness: Partial<Harness> = {}

  const browser =
    options.browser ??
    ((url: string): void => {
      const state = new URL(url).searchParams.get('state') ?? ''
      deliver(harness as Harness, `/?code=auth-code-xyz&state=${encodeURIComponent(state)}`)
    })

  const openExternal = vi.fn(async (url: string): Promise<void> => {
    await browser(url, harness as Harness)
  })

  const service = new OAuthService({
    config: { google: options.google === undefined ? GOOGLE : options.google },
    logger,
    secrets,
    openExternal,
    createServer: factory,
    oauthFactory: (opts) => {
      factoryCalls.push({ clientId: opts.clientId, redirectUri: opts.redirectUri })
      return client
    },
    randomState: () => STATE,
    now: () => new Date('2026-07-23T09:00:00.000Z'),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })

  Object.assign(harness, {
    service,
    servers,
    client,
    secrets,
    logs: calls,
    openExternal,
    responses,
    factoryCalls
  })
  return harness as Harness
}

/** Play the browser's redirect back into the loopback handler and keep the response. */
function deliver(harness: Harness, url: string): CapturedResponse {
  const response = createResponse()
  harness.responses.push(response)
  const server = harness.servers[0]
  expect(server).toBeDefined()
  server?.handler({ url }, response)
  return response
}

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------

describe('OAuthService — not configured', () => {
  it('rests in "not-configured" when there is no Google client', () => {
    const harness = createHarness({ google: null })
    expect(harness.service.getStatus()).toEqual({
      state: 'not-configured',
      channel: null,
      lastError: null
    })
  })

  it('refuses to sign in without opening a server or a browser', async () => {
    const harness = createHarness({ google: null })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_CONFIGURED')
    expect(harness.servers).toHaveLength(0)
    expect(harness.openExternal).not.toHaveBeenCalled()
    // The state must not move: "not configured" is a resting state, not a failure.
    expect(harness.service.getStatus().state).toBe('not-configured')
  })

  it('reports NOT_CONFIGURED rather than NOT_CONNECTED from getAuthorizedClient', async () => {
    const harness = createHarness({ google: null, stored: { [REFRESH_TOKEN_SECRET_KEY]: 'x' } })

    const result = await harness.service.getAuthorizedClient()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_CONFIGURED')
  })
})

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('OAuthService — successful sign-in', () => {
  it('completes the loopback flow and stores only the refresh token', async () => {
    const harness = createHarness()

    const result = await harness.service.signIn()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.state).toBe('signed-in')
    expect(harness.service.getStatus().state).toBe('signed-in')

    // The code was exchanged exactly once, and the refresh token persisted under the one key.
    expect(harness.client.exchangedCodes).toEqual(['auth-code-xyz'])
    expect(harness.secrets.values.get(REFRESH_TOKEN_SECRET_KEY)).toBe(REFRESH_TOKEN)
    expect([...harness.secrets.values.keys()]).toEqual([REFRESH_TOKEN_SECRET_KEY])

    // The server is always closed.
    expect(harness.servers).toHaveLength(1)
    expect(harness.servers[0]?.closes).toBe(1)
  })

  it('asks for offline access, forced consent, and exactly the two YouTube scopes', async () => {
    const harness = createHarness()

    await harness.service.signIn()

    const options = harness.client.authOptions[0]
    expect(options?.access_type).toBe('offline')
    expect(options?.prompt).toBe('consent')
    expect(options?.state).toBe(STATE)
    expect(options?.scope).toEqual([...YOUTUBE_OAUTH_SCOPES])
  })

  it('redirects to an ephemeral loopback port on 127.0.0.1 only', async () => {
    const harness = createHarness()

    await harness.service.signIn()

    expect(harness.factoryCalls[0]?.redirectUri).toBe('http://127.0.0.1:51987')
  })

  it('serves a closing page that never echoes the code back to the browser', async () => {
    const harness = createHarness()

    await harness.service.signIn()

    const response = harness.responses[0]
    expect(response?.sent.status).toBe(200)
    expect(response?.sent.body).toContain('You can close this tab')
    expect(response?.sent.body).not.toContain('auth-code-xyz')
    expect(response?.sent.body).not.toContain(STATE)
    expect(response?.sent.headers['Cache-Control']).toBe('no-store')
  })

  it('notifies status subscribers and stops on unsubscribe', async () => {
    const harness = createHarness()
    const seen: string[] = []
    const unsubscribe = harness.service.onStatus((status) => {
      seen.push(status.state)
    })

    await harness.service.signIn()
    unsubscribe()
    await harness.service.signOut()

    expect(seen).toEqual(['authorizing', 'signed-in'])
  })

  it('still succeeds when safeStorage cannot remember the token, and warns', async () => {
    const harness = createHarness({ secretsAvailable: false })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(true)
    expect(harness.service.getStatus().state).toBe('signed-in')
    expect(harness.secrets.values.size).toBe(0)
    expect(harness.logs.some((call) => call.level === 'warn')).toBe(true)
  })

  it('warns but succeeds when Google returns no refresh token', async () => {
    const harness = createHarness({ tokens: { access_token: 'access-only' } })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(true)
    expect(harness.secrets.values.size).toBe(0)
    expect(
      harness.logs.some((call) => call.level === 'warn' && call.message.includes('no refresh token'))
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Hostile and unhappy callbacks
// ---------------------------------------------------------------------------

describe('OAuthService — rejected callbacks', () => {
  it('rejects a callback whose state does not match and never exchanges the code', async () => {
    const harness = createHarness({
      browser: (_url, self) => {
        deliver(self, '/?code=attacker-code&state=some-other-state')
      }
    })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARG')
      expect(result.error.detail).toBe('state parameter mismatch')
    }
    expect(harness.client.exchangedCodes).toEqual([])
    expect(harness.secrets.values.size).toBe(0)
    expect(harness.service.getStatus().state).toBe('auth-error')
    expect(harness.servers[0]?.closes).toBe(1)
    expect(harness.responses[0]?.sent.status).toBe(400)
    expect(harness.responses[0]?.sent.body).not.toContain('attacker-code')
  })

  it('handles error=access_denied without exchanging anything', async () => {
    const harness = createHarness({
      browser: (url, self) => {
        const state = new URL(url).searchParams.get('state') ?? ''
        deliver(self, `/?error=access_denied&state=${encodeURIComponent(state)}`)
      }
    })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_CONNECTED')
      expect(result.error.detail).toContain('access_denied')
    }
    expect(harness.client.exchangedCodes).toEqual([])
    expect(harness.service.getStatus().state).toBe('auth-error')
    expect(harness.service.getStatus().lastError).not.toBeNull()
    expect(harness.servers[0]?.closes).toBe(1)
    expect(harness.responses[0]?.sent.status).toBe(400)
  })

  it('ignores a favicon probe and keeps waiting for the real callback', async () => {
    const harness = createHarness({
      browser: (url, self) => {
        const favicon = deliver(self, '/favicon.ico')
        expect(favicon.sent.status).toBe(404)
        const state = new URL(url).searchParams.get('state') ?? ''
        deliver(self, `/?code=auth-code-xyz&state=${encodeURIComponent(state)}`)
      }
    })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(true)
    expect(harness.client.exchangedCodes).toEqual(['auth-code-xyz'])
  })

  it('times out, closes the server, and reports TIMEOUT', async () => {
    const harness = createHarness({
      timeoutMs: 20,
      browser: () => {
        /* the operator wandered off; the callback never arrives */
      }
    })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TIMEOUT')
    expect(harness.servers[0]?.closes).toBe(1)
    expect(harness.service.getStatus().state).toBe('auth-error')
  })

  it('closes the loopback server even when a seam throws', async () => {
    const harness = createHarness({
      browser: () => {
        throw new Error('no browser on this machine')
      }
    })

    const result = await harness.service.signIn()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INTERNAL')
    expect(harness.servers).toHaveLength(1)
    expect(harness.servers[0]?.closes).toBe(1)
  })

  it('refuses a second concurrent sign-in rather than opening a second port', async () => {
    const harness = createHarness({ timeoutMs: 20, browser: () => undefined })

    const first = harness.service.signIn()
    const second = await harness.service.signIn()

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('INVALID_ARG')
    await first
    expect(harness.servers).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Silent restore and sign-out
// ---------------------------------------------------------------------------

describe('OAuthService — silent restore', () => {
  it('restores from the stored refresh token without opening a browser', async () => {
    const harness = createHarness({ stored: { [REFRESH_TOKEN_SECRET_KEY]: REFRESH_TOKEN } })

    const result = await harness.service.restore()

    expect(result.ok).toBe(true)
    expect(harness.service.getStatus().state).toBe('signed-in')
    expect(harness.client.credentials).toEqual([{ refresh_token: REFRESH_TOKEN }])
    // No consent page, no loopback socket: that is the whole point of remembering the token.
    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(harness.servers).toHaveLength(0)
    // A silent refresh needs no redirect URI.
    expect(harness.factoryCalls[0]?.redirectUri).toBeUndefined()
  })

  it('returns NOT_CONNECTED when nothing is stored', async () => {
    const harness = createHarness()

    const result = await harness.service.getAuthorizedClient()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_CONNECTED')
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('reuses the client from this session instead of re-reading the secret', async () => {
    const harness = createHarness()
    await harness.service.signIn()

    const first = await harness.service.getAuthorizedClient()
    const second = await harness.service.getAuthorizedClient()

    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(first.value).toBe(second.value)
  })
})

describe('OAuthService — sign out', () => {
  it('deletes the stored refresh token and drops back to signed-out', async () => {
    const harness = createHarness()
    await harness.service.signIn()
    expect(harness.secrets.values.get(REFRESH_TOKEN_SECRET_KEY)).toBe(REFRESH_TOKEN)

    const result = await harness.service.signOut()

    expect(result.ok).toBe(true)
    expect(harness.secrets.deleted).toContain(REFRESH_TOKEN_SECRET_KEY)
    expect(harness.secrets.values.has(REFRESH_TOKEN_SECRET_KEY)).toBe(false)
    expect(harness.service.getStatus()).toEqual({
      state: 'signed-out',
      channel: null,
      lastError: null
    })

    const after = await harness.service.getAuthorizedClient()
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.code).toBe('NOT_CONNECTED')
  })

  it('still forgets the token when the Google client config has been removed', async () => {
    const harness = createHarness({
      google: null,
      stored: { [REFRESH_TOKEN_SECRET_KEY]: REFRESH_TOKEN }
    })

    const result = await harness.service.signOut()

    expect(result.ok).toBe(true)
    expect(harness.secrets.values.has(REFRESH_TOKEN_SECRET_KEY)).toBe(false)
    expect(harness.service.getStatus().state).toBe('not-configured')
  })
})

// ---------------------------------------------------------------------------
// The token must never reach the log
// ---------------------------------------------------------------------------

describe('OAuthService — secrecy', () => {
  it('never passes the refresh token to the logger, in any argument', async () => {
    const harness = createHarness()

    await harness.service.signIn()
    await harness.service.restore()
    await harness.service.signOut()

    expect(harness.logs.length).toBeGreaterThan(0)
    for (const call of harness.logs) {
      const serialised = JSON.stringify({ message: call.message, fields: call.fields ?? {} })
      expect(serialised).not.toContain(REFRESH_TOKEN)
      expect(serialised).not.toContain(GOOGLE.clientSecret)
      expect(serialised).not.toContain('auth-code-xyz')
    }
  })

  it('logs the fact of a token as a boolean, which survives redaction', async () => {
    const harness = createHarness()

    await harness.service.signIn()

    const stored = harness.logs.find((call) => call.fields?.['hasRefreshToken'] !== undefined)
    expect(stored?.fields?.['hasRefreshToken']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration surface used by the rest of Phase 4
// ---------------------------------------------------------------------------

describe('OAuthService — integration surface', () => {
  it('degrades to not-configured instead of throwing when constructed without config', () => {
    // The wiring in `index.ts` duck-types this constructor. A missing `config` must not throw a
    // TypeError out of a constructor mid-startup, so the cast here is deliberate.
    const { logger } = createRecordingLogger()
    const service = new OAuthService({ logger } as unknown as ConstructorParameters<
      typeof OAuthService
    >[0])

    expect(service.getStatus().state).toBe('not-configured')
  })

  it('exposes getAuthClient as an alias of getAuthorizedClient', async () => {
    const harness = createHarness({ stored: { [REFRESH_TOKEN_SECRET_KEY]: REFRESH_TOKEN } })

    const aliased = await harness.service.getAuthClient()

    expect(aliased.ok).toBe(true)
    if (aliased.ok) expect(aliased.value).toBe(harness.client)
  })

  it('drops the cached client and shows auth-error when the API reports a rejection', async () => {
    const harness = createHarness()
    await harness.service.signIn()

    harness.service.reportAuthFailure('the token was revoked')

    expect(harness.service.getStatus()).toEqual({
      state: 'auth-error',
      channel: null,
      lastError: 'the token was revoked'
    })
    // The next attempt re-reads the stored token rather than reusing a dead client.
    const next = await harness.service.getAuthorizedClient()
    expect(next.ok).toBe(true)
  })

  it('remembers the channel the YouTube service reports', () => {
    const harness = createHarness()
    const channel = { id: 'UC123', title: 'Grace Chapel', customUrl: '@gracechapel' }

    harness.service.setChannel(channel)

    expect(harness.service.getStatus().channel).toEqual(channel)
  })

  it('createOAuthService builds a working service from injected parts', async () => {
    const { factory, servers } = createFakeServerFactory()
    const { logger } = createRecordingLogger()
    const client = createFakeClient()
    const secrets = createFakeSecrets()

    const service = createOAuthService({
      config: { google: GOOGLE },
      logger,
      secrets,
      createServer: factory,
      oauthFactory: () => client,
      randomState: () => STATE,
      openExternal: async (url: string) => {
        const state = new URL(url).searchParams.get('state') ?? ''
        servers[0]?.handler(
          { url: `/?code=auth-code-xyz&state=${encodeURIComponent(state)}` },
          createResponse()
        )
        return Promise.resolve()
      }
    })

    expect(service.getStatus().state).toBe('signed-out')
    const result = await service.signIn()
    expect(result.ok).toBe(true)
    expect(secrets.values.get(REFRESH_TOKEN_SECRET_KEY)).toBe(REFRESH_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// The real loopback server
// ---------------------------------------------------------------------------

/**
 * The one place the production `node:http` adapter is exercised. No internet is involved — this is
 * 127.0.0.1 talking to itself, the same convention `OverlayServer.test.ts` uses — but it is the
 * only way to prove that port 0 really yields an ephemeral port, that the request/response shims
 * line up with `IncomingMessage`/`ServerResponse`, and that `close()` actually resolves.
 */
describe('createNodeLoopbackServer', () => {
  it('binds an ephemeral port on 127.0.0.1, serves the handler, and closes', async () => {
    const seen: (string | undefined)[] = []
    const server = createNodeLoopbackServer((request, response) => {
      seen.push(request.url)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<p>ok</p>')
    })

    const port = await server.listen()
    expect(port).toBeGreaterThan(0)

    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/?code=abc&state=xyz`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('<p>ok</p>')
      expect(seen).toEqual(['/?code=abc&state=xyz'])
    } finally {
      await server.close()
    }

    // A closed port refuses further connections.
    await expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Callback parsing
// ---------------------------------------------------------------------------

describe('parseCallback', () => {
  it('returns null for anything that is not an OAuth callback', () => {
    expect(parseCallback(undefined)).toBeNull()
    expect(parseCallback('')).toBeNull()
    expect(parseCallback('/favicon.ico')).toBeNull()
    expect(parseCallback('/?state=only-state')).toBeNull()
  })

  it('pulls code, state and error out of the query', () => {
    expect(parseCallback('/?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      error: null
    })
    expect(parseCallback('/?error=access_denied&state=xyz')).toEqual({
      code: null,
      state: 'xyz',
      error: 'access_denied'
    })
  })
})
