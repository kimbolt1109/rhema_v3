/**
 * Google OAuth for YouTube Live — the "sign in once, go live silently forever after" half of
 * BLUEPRINT.md §5.
 *
 * ## Why the loopback flow
 *
 * Verger is an *installed application*, so it uses the loopback redirect: a short-lived
 * `node:http` server bound to `127.0.0.1` on an **ephemeral** port, whose address is handed to
 * Google as the `redirect_uri`. The consent page opens in the operator's real browser (where they
 * are already signed in to the church's Google account) and Google redirects back to that local
 * port with the authorisation code.
 *
 * The alternative — the out-of-band flow (`urn:ietf:wg:oauth:2.0:oob`), where the operator copies
 * a code out of the browser and pastes it into the app — is **switched off by Google** and would
 * simply fail. Embedding a login form inside an Electron `BrowserWindow` is also refused by
 * Google ("disallowed_useragent") and would be a phishing-shaped pattern besides.
 *
 * ## Security properties, deliberately
 *
 *  - **`state` is generated per attempt and verified on the callback.** A callback whose `state`
 *    does not match is rejected without ever exchanging the code. Without this, any page the
 *    operator visits during the flow could POST a code from a *different* Google account into our
 *    open port and silently bind Verger to the attacker's channel.
 *  - **The server binds `127.0.0.1` only** (Standing Rule 7), so nothing on the LAN can reach it.
 *  - **The whole flow is bounded** ({@link DEFAULT_SIGN_IN_TIMEOUT_MS}). An operator who wanders
 *    off mid-consent must not leave a listening socket behind. The server is closed on **every**
 *    exit path — success, denial, CSRF rejection, timeout, and thrown seam alike.
 *  - **Only the refresh token is persisted**, through `@main/secrets/secrets` (Electron
 *    `safeStorage`). It never reaches `.env`, a plain file, IPC, or a log line. This module logs
 *    the *fact* of a token (`hasRefreshToken: true`) and never its value; the logger's key-based
 *    redaction is a second line of defence, not the first.
 *  - **The response page never echoes a query parameter back.** The served HTML is a constant, so
 *    a crafted callback URL cannot reflect script into the operator's browser, and the code never
 *    appears in the page (or in a screenshot of it).
 *
 * ## Not configured is a resting state (Standing Rule 5)
 *
 * With no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `AppConfig.google` is `null`, the state is
 * `not-configured`, and `signIn()` returns `Err(NOT_CONFIGURED)` **without opening a socket or a
 * browser**. Nothing here throws; everything returns a {@link Result}.
 *
 * ## Everything is injected
 *
 * The OAuth client, the loopback server, the browser opener, the secrets store, the clock and the
 * state generator are all seams. Consequently the unit tests need no network, no browser, no
 * Google account and no Electron — which is the only way this file could be written at all, since
 * no credentials exist on the build machine. The production defaults are imported *lazily*, inside
 * the functions that need them, so merely importing this module pulls in neither `electron` nor
 * the (very large) `googleapis` package.
 */

import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import type { GoogleConfig } from '@shared/config'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import type { YouTubeAuthState, YouTubeAuthStatus, YouTubeChannel } from '@shared/youtube'

import { loadConfigFromDisk } from '@main/config/env'
import { createNullLogger } from '@main/logging/logger'
import type { SecretsStore } from '@main/secrets/secrets'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The scopes Verger asks for.
 *
 * `youtube` covers creating and binding broadcasts; `youtube.force-ssl` is the one YouTube
 * requires for the live-streaming write calls. Nothing broader is requested — no `youtube.upload`,
 * no account or contact scope — because a consent screen that asks for more than it needs is how
 * an operator learns to click through consent screens without reading them.
 */
export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl'
] as const

/** Key the refresh token is stored under in the {@link SecretsStore}. */
export const REFRESH_TOKEN_SECRET_KEY = 'google.refreshToken'

/**
 * How long the loopback server may wait for the callback. Three minutes is long enough to pick an
 * account and read the consent screen, short enough that an abandoned flow cannot leave a socket
 * listening for the rest of the service.
 */
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000

/** Standing Rule 7: loopback only. Never `0.0.0.0`, never a LAN address. */
export const LOOPBACK_HOST = '127.0.0.1'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The `AppConfig` slice this service reads. `AppConfig` itself satisfies it. */
export interface OAuthConfigLike {
  readonly google: GoogleConfig | null
}

/** The token bundle Google returns. Mirrors `google-auth-library`'s `Credentials`. */
export interface OAuthTokens {
  readonly refresh_token?: string | null
  readonly access_token?: string | null
  readonly expiry_date?: number | null
  readonly token_type?: string | null
  readonly id_token?: string | null
  readonly scope?: string
}

/**
 * Options for {@link OAuthClientLike.generateAuthUrl}.
 *
 * The index signature is not decoration: `google-auth-library`'s `GenerateAuthUrlOpts` declares
 * one (its extra keys become query parameters), and without a compatible one here the real
 * `OAuth2Client` is not assignable to {@link OAuthClientLike}.
 */
export interface AuthUrlOptions {
  readonly [key: string]: string | number | boolean | readonly string[] | undefined
  readonly access_type: string
  readonly prompt?: string
  readonly scope: string[]
  readonly state: string
  readonly include_granted_scopes?: boolean
}

/**
 * The slice of `google.auth.OAuth2` used here.
 *
 * Structural rather than the concrete class so the tests can supply a twenty-line fake. The
 * production factory returns a genuine `OAuth2Client`, which satisfies this shape.
 */
export interface OAuthClientLike {
  generateAuthUrl(options: AuthUrlOptions): string
  getToken(code: string): Promise<{ tokens: OAuthTokens }>
  setCredentials(credentials: OAuthTokens): void
  /** Best-effort revocation on sign-out. Optional: not every fake implements it. */
  revokeCredentials?(): Promise<unknown>
}

/** Client credentials plus the redirect URI for this attempt. */
export interface OAuthClientFactoryOptions {
  readonly clientId: string
  readonly clientSecret: string
  /** Omitted for the silent refresh path, which needs no redirect. */
  readonly redirectUri?: string
}

/** Builds an OAuth client. Async so the default can import `googleapis` lazily. */
export type OAuthClientFactory = (
  options: OAuthClientFactoryOptions
) => Promise<OAuthClientLike> | OAuthClientLike

/** The bit of `http.IncomingMessage` the callback handler reads. */
export interface LoopbackRequest {
  readonly url?: string | undefined
}

/** The bit of `http.ServerResponse` the callback handler writes. */
export interface LoopbackResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** Handles one request to the loopback server. Must never throw. */
export type LoopbackHandler = (request: LoopbackRequest, response: LoopbackResponse) => void

/** A started-on-demand loopback listener. */
export interface LoopbackServer {
  /** Bind `127.0.0.1` on an ephemeral port; resolves with the port actually bound. */
  listen(): Promise<number>
  /** Idempotent. Must resolve even if the server never listened. */
  close(): Promise<void>
}

/** Builds a loopback server around a handler. */
export type LoopbackServerFactory = (handler: LoopbackHandler) => LoopbackServer

/** Constructor dependencies. Only `config` and `logger` are required. */
export interface OAuthServiceOptions {
  readonly config: OAuthConfigLike
  readonly logger: Logger
  /** Defaults to the process-wide `getSecretsStore()`, imported lazily on first use. */
  readonly secrets?: SecretsStore
  /** Defaults to Electron's `shell.openExternal`, imported lazily. */
  readonly openExternal?: (url: string) => Promise<void>
  /** Defaults to a real `node:http` server on `127.0.0.1:0`. */
  readonly createServer?: LoopbackServerFactory
  /** Defaults to `new google.auth.OAuth2(...)`, with `googleapis` imported lazily. */
  readonly oauthFactory?: OAuthClientFactory
  readonly now?: () => Date
  /** Defaults to 24 random bytes, base64url. */
  readonly randomState?: () => string
  /** Overall deadline for one sign-in. Defaults to {@link DEFAULT_SIGN_IN_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

// ---------------------------------------------------------------------------
// The pages served on the loopback port
// ---------------------------------------------------------------------------

const PAGE_STYLE =
  'font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0f14;color:#e6edf3'

/**
 * Constant HTML — never interpolated with anything from the request. See the module docblock.
 */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="${PAGE_STYLE}"><main><h1 style="font-size:20px">${title}</h1><p>${body}</p></main></body></html>`
}

const SUCCESS_PAGE = page('Verger is connected', 'You can close this tab and return to Verger.')
const DENIED_PAGE = page('Sign-in cancelled', 'Verger was not connected. You can close this tab.')
const REJECTED_PAGE = page(
  'Sign-in could not be verified',
  'Verger rejected this response and did not connect. Close this tab and try again from Verger.'
)
const IGNORED_PAGE = page('Nothing here', 'This is Verger&rsquo;s one-time sign-in listener.')

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class OAuthService {
  private readonly config: OAuthConfigLike
  private readonly log: Logger
  private readonly openExternal: (url: string) => Promise<void>
  private readonly createServer: LoopbackServerFactory
  private readonly oauthFactory: OAuthClientFactory
  private readonly now: () => Date
  private readonly randomState: () => string
  private readonly timeoutMs: number
  private readonly subscribers = new Set<(status: YouTubeAuthStatus) => void>()

  private secrets: SecretsStore | null
  private client: OAuthClientLike | null = null
  private channel: YouTubeChannel | null = null
  private lastError: string | null = null
  private state: YouTubeAuthState
  private signingIn = false

  constructor(options: OAuthServiceOptions) {
    // Defensive despite the type: this class is constructed by wiring code that another slice
    // owns, and a missing `config` must degrade to "not configured" rather than throw a
    // TypeError out of a constructor and take the YouTube panel down with it.
    this.config = (options.config as OAuthConfigLike | undefined) ?? { google: null }
    this.log = options.logger.child('youtube:oauth')
    this.secrets = options.secrets ?? null
    this.openExternal = options.openExternal ?? defaultOpenExternal
    this.createServer = options.createServer ?? createNodeLoopbackServer
    this.oauthFactory = options.oauthFactory ?? defaultOAuthClientFactory
    this.now = options.now ?? ((): Date => new Date())
    this.randomState = options.randomState ?? defaultRandomState
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS
    this.state = this.config.google === null ? 'not-configured' : 'signed-out'
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** The current auth status. Carries no token — safe to hand straight to IPC. */
  getStatus(): YouTubeAuthStatus {
    return { state: this.state, channel: this.channel, lastError: this.lastError }
  }

  /** Subscribe to auth-status changes. Returns an unsubscribe function. */
  onStatus(callback: (status: YouTubeAuthStatus) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Record which channel we are signed in as.
   *
   * Naming the channel needs a `channels.list` call, which belongs to the YouTube API service, not
   * to auth. That service calls this once it knows, so "connected as <channel>" can render.
   */
  setChannel(channel: YouTubeChannel | null): void {
    if (sameChannel(this.channel, channel)) return
    this.channel = channel
    this.publish()
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  /**
   * Run the loopback consent flow.
   *
   * Ordering is deliberate: the server is bound *before* the consent URL is generated, because the
   * redirect URI must contain the port that was actually assigned. Everything after the bind lives
   * inside a `try`/`finally` whose `finally` closes the server — there is no path out of this
   * method that leaves a listening socket.
   */
  async signIn(): Promise<Result<YouTubeAuthStatus>> {
    const google = this.config.google
    if (google === null) {
      // Not an error worth a state change: `not-configured` is where we already are.
      return err(
        ErrorCode.NOT_CONFIGURED,
        'Google sign-in is not configured',
        'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env'
      )
    }
    if (this.signingIn) {
      return err(ErrorCode.INVALID_ARG, 'a sign-in is already in progress')
    }

    this.signingIn = true
    this.setState('authorizing', null)

    const startedAt = this.now().getTime()
    const expectedState = this.safeRandomState()
    let settled = false
    let settle: ((result: Result<string>) => void) | null = null
    const callback = new Promise<Result<string>>((resolve) => {
      settle = resolve
    })
    const finish = (result: Result<string>): void => {
      if (settled) return
      settled = true
      settle?.(result)
    }

    const server = this.createServer((request, response) => {
      // A throw here would surface as an uncaught exception inside the http server, which in the
      // main process means a dead app mid-service. Nothing escapes.
      try {
        this.handleCallback(request, response, expectedState, finish)
      } catch (cause) {
        this.log.error('the loopback handler failed', { cause })
        finish(err(ErrorCode.INTERNAL, 'the sign-in callback could not be handled'))
      }
    })

    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      const port = await server.listen()
      const redirectUri = `http://${LOOPBACK_HOST}:${String(port)}`

      timer = setTimeout(() => {
        finish(
          err(
            ErrorCode.TIMEOUT,
            'the sign-in was not completed in time',
            `no callback within ${String(this.timeoutMs)}ms`
          )
        )
      }, this.timeoutMs)

      const client = await this.oauthFactory({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        redirectUri
      })

      const url = client.generateAuthUrl({
        // `offline` + `consent` is what actually produces a refresh token. Without them Google may
        // return an access token only, and every future go-live would need a browser round-trip —
        // precisely the friction this feature exists to remove.
        access_type: 'offline',
        prompt: 'consent',
        scope: [...YOUTUBE_OAUTH_SCOPES],
        state: expectedState,
        include_granted_scopes: true
      })

      this.log.info('opening the Google consent page', { port })
      await this.openExternal(url)

      const code = await callback
      if (!code.ok) return this.failSignIn(code.error.message, code.error.code, code.error.detail)

      const exchanged = await client.getToken(code.value)
      client.setCredentials(exchanged.tokens)
      this.client = client

      const refreshToken = exchanged.tokens.refresh_token
      if (typeof refreshToken === 'string' && refreshToken.length > 0) {
        this.storeRefreshToken(refreshToken)
      } else {
        // Not fatal: this session works. Google withholds a refresh token when the account has
        // already consented and the prompt was suppressed upstream.
        this.log.warn(
          'Google returned no refresh token; sign-in will be needed again after a restart'
        )
      }

      this.setState('signed-in', null)
      this.log.info('signed in to Google', {
        hasRefreshToken: typeof refreshToken === 'string' && refreshToken.length > 0,
        elapsedMs: this.now().getTime() - startedAt
      })
      return ok(this.getStatus())
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return this.failSignIn(message, ErrorCode.INTERNAL, 'sign-in threw')
    } finally {
      if (timer !== null) clearTimeout(timer)
      finish(err(ErrorCode.INTERNAL, 'the sign-in ended'))
      await closeQuietly(server, this.log)
      this.signingIn = false
    }
  }

  // -------------------------------------------------------------------------
  // Sign out
  // -------------------------------------------------------------------------

  /**
   * Forget the stored refresh token.
   *
   * Deliberately works even when `google` is `null`: if the operator strips the client id out of
   * `.env`, the token they granted earlier should still be removable. Revocation at Google is
   * attempted but never waited on — a hung HTTPS call must not make "sign out" appear broken.
   */
  async signOut(): Promise<Result<YouTubeAuthStatus>> {
    const client = this.client
    this.client = null

    if (client?.revokeCredentials !== undefined) {
      void Promise.resolve()
        .then(() => client.revokeCredentials?.())
        .catch((cause: unknown) => {
          this.log.warn('revoking the Google token failed; it was still forgotten locally', {
            cause
          })
        })
    }

    const secrets = await this.resolveSecrets()
    if (secrets !== null) {
      const deleted = secrets.deleteSecret(REFRESH_TOKEN_SECRET_KEY)
      if (!deleted.ok && deleted.error.code !== 'NOT_FOUND') {
        this.log.warn('the stored refresh token could not be deleted', {
          code: deleted.error.code
        })
      }
    }

    this.channel = null
    this.setState(this.config.google === null ? 'not-configured' : 'signed-out', null)
    this.log.info('signed out of Google')
    return ok(this.getStatus())
  }

  // -------------------------------------------------------------------------
  // Silent restore
  // -------------------------------------------------------------------------

  /**
   * Restore the session from the stored refresh token, opening no browser.
   *
   * Called at startup by the wiring so the Go Live screen can show "connected as …" without the
   * operator touching anything. `Err(NOT_CONNECTED)` simply means "sign in once".
   */
  async restore(): Promise<Result<YouTubeAuthStatus>> {
    const client = await this.getAuthorizedClient()
    if (!client.ok) return { ok: false, error: client.error }
    return ok(this.getStatus())
  }

  /**
   * An OAuth client carrying usable credentials, for the YouTube API service.
   *
   * Returns the live client if this process already signed in; otherwise rebuilds one from the
   * stored refresh token **without any user interaction**. The library exchanges that refresh
   * token for an access token on the first API call, so nothing here touches the network either.
   */
  async getAuthorizedClient(): Promise<Result<OAuthClientLike>> {
    const google = this.config.google
    if (google === null) {
      return err(
        ErrorCode.NOT_CONFIGURED,
        'Google sign-in is not configured',
        'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env'
      )
    }
    if (this.client !== null) return ok(this.client)

    const secrets = await this.resolveSecrets()
    if (secrets === null) {
      return err(ErrorCode.NOT_CONNECTED, 'sign in to YouTube first', 'no secret storage')
    }

    const stored = secrets.getSecret(REFRESH_TOKEN_SECRET_KEY)
    if (!stored.ok) {
      // NOT_FOUND (never signed in) and NOT_CONFIGURED (safeStorage unavailable) are the same
      // thing to the caller: there is no remembered session.
      return err(ErrorCode.NOT_CONNECTED, 'sign in to YouTube first', stored.error.code)
    }

    try {
      const client = await this.oauthFactory({
        clientId: google.clientId,
        clientSecret: google.clientSecret
      })
      client.setCredentials({ refresh_token: stored.value })
      this.client = client
      this.setState('signed-in', null)
      this.log.info('restored the Google session from the stored refresh token')
      return ok(client)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.setState('auth-error', message)
      return err(ErrorCode.INTERNAL, 'the stored Google session could not be restored', message)
    }
  }

  /**
   * Alias for {@link getAuthorizedClient}, under the name the YouTube API service asks for.
   *
   * Two slices of Phase 4 were built in parallel against each other's docblocks; keeping both
   * spellings costs one line and removes a whole class of integration failure.
   */
  getAuthClient(): Promise<Result<OAuthClientLike>> {
    return this.getAuthorizedClient()
  }

  /**
   * Told by the API layer that Google rejected our credentials.
   *
   * A refresh token can be revoked from the account's security page at any time, and the only
   * place that becomes visible is the next API call. The cached client is dropped so the next
   * attempt re-reads the stored token, and the UI is moved to `auth-error` with a reason.
   */
  reportAuthFailure(message: string): void {
    this.client = null
    this.setState('auth-error', message)
    this.log.warn('the YouTube API rejected our credentials')
  }

  /** Drop subscribers and the in-memory client. Any in-flight flow closes its own server. */
  dispose(): void {
    this.subscribers.clear()
    this.client = null
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleCallback(
    request: LoopbackRequest,
    response: LoopbackResponse,
    expectedState: string,
    finish: (result: Result<string>) => void
  ): void {
    const parsed = parseCallback(request.url)

    // Browsers ask for /favicon.ico on the way through. Anything that is not a callback is simply
    // not a callback: answer it and keep waiting.
    if (parsed === null) {
      respond(response, 404, IGNORED_PAGE)
      return
    }

    if (parsed.error !== null) {
      respond(response, 400, DENIED_PAGE)
      this.log.warn('Google refused the sign-in', { reason: parsed.error })
      finish(
        err(ErrorCode.NOT_CONNECTED, 'Google did not grant access', `google said: ${parsed.error}`)
      )
      return
    }

    if (parsed.state !== expectedState) {
      respond(response, 400, REJECTED_PAGE)
      this.log.warn('rejected a sign-in callback whose state did not match')
      finish(
        err(
          ErrorCode.INVALID_ARG,
          'the sign-in response failed its security check',
          'state parameter mismatch'
        )
      )
      return
    }

    if (parsed.code === null) {
      respond(response, 400, REJECTED_PAGE)
      finish(err(ErrorCode.INVALID_ARG, 'the sign-in response carried no code'))
      return
    }

    respond(response, 200, SUCCESS_PAGE)
    finish(ok(parsed.code))
  }

  /** Persist the refresh token; a storage failure degrades to "this session only". */
  private storeRefreshToken(refreshToken: string): void {
    const secrets = this.secrets
    if (secrets === null) {
      // `resolveSecrets` is async and we are on a hot path; schedule it instead of blocking.
      void this.resolveSecrets().then((resolved) => {
        if (resolved !== null) this.writeToken(resolved, refreshToken)
      })
      return
    }
    this.writeToken(secrets, refreshToken)
  }

  private writeToken(secrets: SecretsStore, refreshToken: string): void {
    const stored = secrets.setSecret(REFRESH_TOKEN_SECRET_KEY, refreshToken)
    if (stored.ok) {
      this.log.info('the Google refresh token was stored', { hasRefreshToken: true })
      return
    }
    this.log.warn(
      'the Google refresh token could not be stored; sign-in will be needed again next launch',
      { code: stored.error.code }
    )
  }

  private async resolveSecrets(): Promise<SecretsStore | null> {
    if (this.secrets !== null) return this.secrets
    try {
      // Relative rather than aliased, and lazy, so importing this module does not pull Electron
      // into the graph — which is what lets the tests run with no Electron at all.
      const secretsModule = await import('../secrets/secrets')
      this.secrets = secretsModule.getSecretsStore()
      return this.secrets
    } catch (cause) {
      this.log.warn('secret storage is unavailable; the session will not be remembered', { cause })
      return null
    }
  }

  private failSignIn(
    message: string,
    code: ErrorCode,
    detail?: string
  ): Result<YouTubeAuthStatus> {
    this.setState('auth-error', message)
    this.log.warn('Google sign-in failed', { code, detail: detail ?? null })
    return detail === undefined ? err(code, message) : err(code, message, detail)
  }

  private safeRandomState(): string {
    try {
      const value = this.randomState()
      if (value.length > 0) return value
    } catch (cause) {
      this.log.error('the state generator threw; falling back', { cause })
    }
    return defaultRandomState()
  }

  private setState(state: YouTubeAuthState, lastError: string | null): void {
    if (this.state === state && this.lastError === lastError) return
    this.state = state
    this.lastError = lastError
    this.publish()
  }

  private publish(): void {
    const status = this.getStatus()
    for (const subscriber of this.subscribers) {
      try {
        subscriber(status)
      } catch (cause) {
        this.log.error('a YouTube auth status subscriber threw', { cause })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Every dependency optional; each one has a production default. */
export interface CreateOAuthServiceOptions
  extends Partial<Omit<OAuthServiceOptions, 'config' | 'logger'>> {
  /** Defaults to the resolved `.env` configuration. */
  readonly config?: OAuthConfigLike
  /** Defaults to the null logger. */
  readonly logger?: Logger
}

/**
 * Build an {@link OAuthService} with production defaults.
 *
 * The wiring in `src/main/youtube/index.ts` reaches for a factory of this shape. Config defaults
 * to a fresh read of `.env`, which with no `GOOGLE_*` keys yields `google: null` — i.e. a service
 * that reports `not-configured` and does nothing else. That is the intended empty-`.env` outcome,
 * not a failure.
 */
export function createOAuthService(options: CreateOAuthServiceOptions = {}): OAuthService {
  const { config, logger, ...rest } = options
  return new OAuthService({
    ...rest,
    config: config ?? loadConfigFromDisk(),
    logger: logger ?? createNullLogger()
  })
}

// ---------------------------------------------------------------------------
// Callback parsing
// ---------------------------------------------------------------------------

interface ParsedCallback {
  readonly code: string | null
  readonly state: string | null
  readonly error: string | null
}

/**
 * Pull `code` / `state` / `error` out of a callback URL.
 *
 * `null` means "this request is not a callback at all" — a favicon probe, a stray refresh — which
 * must neither settle nor fail the flow.
 */
export function parseCallback(url: string | undefined): ParsedCallback | null {
  if (url === undefined || url.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(url, `http://${LOOPBACK_HOST}`)
  } catch {
    return null
  }
  const code = parsed.searchParams.get('code')
  const error = parsed.searchParams.get('error')
  if (code === null && error === null) return null
  return { code, error, state: parsed.searchParams.get('state') }
}

function respond(response: LoopbackResponse, status: number, body: string): void {
  try {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The page is static, but the browser has just been redirected here carrying a credential in
      // its URL — deny it any chance to be framed or to leak the referrer onward.
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    })
    response.end(body)
  } catch {
    /* the browser hung up; the flow is settled elsewhere */
  }
}

async function closeQuietly(server: LoopbackServer, log: Logger): Promise<void> {
  try {
    await server.close()
  } catch (cause) {
    log.warn('the loopback server did not close cleanly', { cause })
  }
}

function sameChannel(a: YouTubeChannel | null, b: YouTubeChannel | null): boolean {
  if (a === null || b === null) return a === b
  return a.id === b.id && a.title === b.title && a.customUrl === b.customUrl
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

/** 192 bits of CSPRNG output, URL-safe. Far beyond what a CSRF nonce needs. */
function defaultRandomState(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * A real loopback server.
 *
 * Bound to `127.0.0.1` with port `0` — the OS picks a free ephemeral port, which is both what
 * Google's installed-app flow expects and the only way to avoid colliding with whatever else the
 * booth machine is running.
 */
export function createNodeLoopbackServer(handler: LoopbackHandler): LoopbackServer {
  const server = createHttpServer((request, response) => {
    handler(
      { url: request.url },
      {
        writeHead: (status, headers) => {
          response.writeHead(status, headers)
        },
        end: (body) => {
          response.end(body)
        }
      }
    )
  })

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, LOOPBACK_HOST, () => {
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('the loopback server did not report a port'))
            return
          }
          resolve(address.port)
        })
      }),
    close: () =>
      new Promise<void>((resolve) => {
        try {
          // A browser keep-alive connection would otherwise hold `close()` open indefinitely.
          server.closeAllConnections()
        } catch {
          /* older runtimes, or never listened */
        }
        try {
          server.close(() => {
            resolve()
          })
        } catch {
          resolve()
        }
      })
  }
}

/** Opens the consent page in the operator's own browser. Electron is imported lazily. */
async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

/** `googleapis` is ~40 MB of generated surface; import it only when a real client is needed. */
async function defaultOAuthClientFactory(
  options: OAuthClientFactoryOptions
): Promise<OAuthClientLike> {
  const { google } = await import('googleapis')
  return new google.auth.OAuth2({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri })
  })
}
