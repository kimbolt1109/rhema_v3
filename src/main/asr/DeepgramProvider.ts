/**
 * The Deepgram cloud ASR adapter — Verger's default set of ears.
 *
 * BLUEPRINT.md §8: cloud ASR is the lowest-latency option and much the best at Korean, and it is
 * the only one that offers real custom-vocabulary boosting. That last point is why this file
 * exists at all rather than deferring to the local adapter: the pastor's name, the church name and
 * the hymn titles are proper nouns a generic model has never seen, and boosting them is what turns
 * an amusing transcript into a usable one.
 *
 * ## What this file guarantees
 *
 * - **Nothing throws across a boundary.** Every public method returns a {@link Result}; every
 *   socket callback and every listener invocation is wrapped. A dead transcriber must never take
 *   the booth UI down (Standing Rule 1) — it goes red and the operator runs manual.
 * - **An absent key is a resting state, not a failure** (Standing Rule 5). With
 *   `DEEPGRAM_API_KEY` empty the provider reports `not-configured`, {@link start} returns
 *   `NOT_CONFIGURED`, and no socket is ever opened.
 * - **The key is never logged.** Only its presence, as a boolean. The provider also never logs raw
 *   audio — only byte counts.
 * - **Memory is bounded.** A slow or wedged socket cannot grow the outbound queue without limit:
 *   past {@link DEFAULT_MAX_BUFFERED_BYTES} the *oldest* audio is dropped and the drop is logged.
 *   Losing half a second of the sermon is survivable; an OOM in the transcriber during a live
 *   service is not.
 * - **Reconnection is exponential with jitter**, reusing the pure `computeBackoffDelay` helper
 *   the OBS client already uses (`@shared/obs`) rather than growing a second implementation of
 *   the same arithmetic.
 *
 * ## The draft/final contract
 *
 * Deepgram streams many `is_final: false` results for one span of speech, each superseding the
 * last, then one `is_final: true` result that closes the span. This adapter assigns a **span id**
 * that is stable across all of those and rotates it only once the final has been emitted — so a
 * consumer keying on {@link TranscriptSegment.id} replaces in place and never appends partial
 * gibberish (see `src/shared/asr.ts`). `isDraft` is always `false` here: drafts are the local
 * two-tier scheduler's concept, not the cloud's.
 *
 * ## State reported by this provider
 *
 * `not-configured` → `idle` → `starting` → `listening`, plus `failed`. It never reports
 * `degraded`: "a transcript is arriving, but from the fallback provider" is a judgement only the
 * owning service can make, because only it can see both providers. Collapsing the two would hide
 * a fallback the operator needs to know about.
 *
 * ## Verified against @deepgram/sdk 5.7.0
 *
 * The v5 live API is not the v3/v4 one. Read from the shipped `.d.ts`:
 * `new DeepgramClient({ apiKey })` → `client.listen.v1.connect(args) : Promise<V1Socket>`;
 * `V1Socket.on('open' | 'message' | 'close' | 'error', cb)`, `sendMedia(ArrayBufferView)`,
 * `sendKeepAlive({ type: 'KeepAlive' })`, `sendCloseStream({ type: 'CloseStream' })`, `close()`;
 * results arrive as `ListenV1Results` (`type: 'Results'`, `is_final`, `start`, `duration`,
 * `channel.alternatives[].transcript` / `.confidence`). Key-term boosting is the `keyterm`
 * connect arg, documented in the types as *"Only compatible with Nova-3"*; older models take
 * `keywords` instead — hence {@link supportsKeyterm}.
 */

import { ASR_BITS_PER_SAMPLE, ASR_CHANNELS, ASR_SAMPLE_RATE } from '@shared/asr'
import type { AsrLanguage, AsrProviderId, AsrState, TranscriptSegment } from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { computeBackoffDelay } from '@shared/obs'
import type { ReconnectPolicy } from '@shared/obs'
import { ErrorCode, err, ok, toAppError } from '@shared/result'
import type { AppError, Result } from '@shared/result'

import type {
  AsrErrorListener,
  AsrProvider,
  AsrSegmentListener,
  AsrStartOptions
} from './AsrProvider'

// ---------------------------------------------------------------------------
// The SDK seam
// ---------------------------------------------------------------------------

/**
 * The connect arguments this adapter sends.
 *
 * A hand-written subset of `V1Client.ConnectArgs` rather than the SDK's own type: the tests assert
 * on this object structurally, and most of the SDK's option types are declared as bare `unknown`
 * (`ListenV1Language`, `ListenV1SampleRate`, `ListenV1Keyterm`, …), which would make an assertion
 * against them worthless. Every field below is assignable to its `ConnectArgs` counterpart.
 */
export interface DeepgramConnectArgs {
  readonly model: string
  readonly language: AsrLanguage
  /** The SDK types the booleans as the strings `'true' | 'false'`. */
  readonly interim_results: 'true' | 'false'
  readonly punctuate: 'true' | 'false'
  readonly smart_format: 'true' | 'false'
  /** Milliseconds of silence before Deepgram finalises the current span. */
  readonly endpointing: number
  readonly encoding: string
  readonly sample_rate: number
  readonly channels: number
  /** Nova-3 boosting. Present only when the model supports it and the vocabulary is non-empty. */
  readonly keyterm?: readonly string[]
  /** Pre-Nova-3 boosting. Mutually exclusive with {@link keyterm}. */
  readonly keywords?: readonly string[]
  /** Zero disables the SDK's own retry loop — this adapter owns reconnection (see the docblock). */
  readonly reconnectAttempts: number
}

/** The close payload. Mirrors the SDK's `core.CloseEvent`, narrowed to what is used. */
export interface DeepgramCloseEvent {
  readonly code: number
  readonly reason: string
}

/**
 * The slice of the SDK's `V1Socket` this adapter touches.
 *
 * Declared structurally so the whole test suite runs against a thirty-line fake with no
 * `@deepgram/sdk`, no `ws`, and — critically — no network.
 */
export interface DeepgramLiveSocketLike {
  on(event: 'open', callback: () => void): void
  on(event: 'message', callback: (message: unknown) => void): void
  on(event: 'close', callback: (event: DeepgramCloseEvent) => void): void
  on(event: 'error', callback: (error: Error) => void): void
  /** Throws if the socket is not open — the SDK asserts before sending. Always call inside a try. */
  sendMedia(data: ArrayBufferView): void
  sendKeepAlive(message: { readonly type: string }): void
  sendCloseStream(message: { readonly type: string }): void
  close(): void
}

/** The one method this adapter needs from a Deepgram client. */
export interface DeepgramListenClientLike {
  connect(args: DeepgramConnectArgs): Promise<DeepgramLiveSocketLike>
}

/**
 * Builds a live-listen client for a key.
 *
 * Injected rather than `vi.mock`ed: an explicit seam keeps the production wiring honest (there is
 * exactly one place the real SDK is constructed, {@link createDeepgramListenClient}) and keeps the
 * tests readable.
 */
export type DeepgramClientFactory = (apiKey: string) => DeepgramListenClientLike

/** Opaque timer handle; `number` under jsdom, `Timeout` under Node. */
export type AsrTimerHandle = ReturnType<typeof setTimeout> | number

/** The timer surface, injected so reconnection and keepalive are driven by fake timers. */
export interface AsrTimers {
  setTimeout(handler: () => void, delayMs: number): AsrTimerHandle
  clearTimeout(handle: AsrTimerHandle): void
  setInterval(handler: () => void, delayMs: number): AsrTimerHandle
  clearInterval(handle: AsrTimerHandle): void
}

/** The real timers. Injected explicitly by the owning service; never reached for in a test. */
export const realAsrTimers: AsrTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  },
  setInterval: (handler, delayMs) => setInterval(handler, delayMs),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  }
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Model per language.
 *
 * Korean runs on `nova-2`, which has documented `ko` support and the lowest latency of the models
 * that do. English gets `nova-3`. Both are overridable — {@link DeepgramProviderOptions.model} —
 * because Deepgram ships new models faster than this app ships releases, and an operator should
 * not need a new build to try one.
 */
export const DEEPGRAM_MODEL_BY_LANGUAGE: Readonly<Record<AsrLanguage, string>> = {
  ko: 'nova-2',
  en: 'nova-3'
}

/**
 * Silence, in ms, before Deepgram closes off the current span.
 *
 * 300 ms is short enough that a cue fires while the sentence still matters and long enough that a
 * preacher pausing for breath mid-clause does not shatter one sentence into four segments.
 */
export const DEFAULT_ENDPOINTING_MS = 300

/**
 * How often to poke an idle socket.
 *
 * Deepgram drops a connection that has received nothing for ~10 s. During a silent prayer or a
 * hymn played from the desk, no audio flows — and losing the socket exactly then means the
 * transcript is missing for the first seconds of the sermon that follows. 8 s leaves headroom.
 */
export const DEFAULT_KEEPALIVE_MS = 8_000

/**
 * Outbound buffer ceiling: five seconds of 16 kHz mono 16-bit PCM (160 000 bytes).
 *
 * Deep enough to ride out a reconnect without losing speech, shallow enough that a socket wedged
 * for an hour costs 160 kB rather than a gigabyte.
 */
export const DEFAULT_MAX_BUFFERED_BYTES =
  ASR_SAMPLE_RATE * (ASR_BITS_PER_SAMPLE / 8) * ASR_CHANNELS * 5

/**
 * Cap on boosted terms sent per connection.
 *
 * The boost list travels in the websocket URL's query string, and an unbounded list from an
 * operator who pasted a hymnal would produce a URL the server rejects — which would look like
 * "ASR is broken" rather than "your vocabulary list is too long". Truncation is logged.
 */
export const MAX_BOOST_TERMS = 100

/**
 * Reconnect policy for the transcript socket.
 *
 * Faster off the mark than the OBS policy (250 ms vs 500 ms) because a dropped ASR socket is
 * invisible to the operator and every second of it is transcript they never get, and capped lower
 * (10 s vs 30 s) for the same reason. `maxAttempts: null` — never stop trying during a service.
 */
export const DEEPGRAM_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
  jitterRatio: 0.25,
  maxAttempts: null
}

/** A websocket close initiated by us or cleanly by the peer. Anything else is unexpected. */
export const WEBSOCKET_CLOSE_NORMAL = 1000

/** Sent to keep an idle connection alive. */
const KEEPALIVE_MESSAGE = { type: 'KeepAlive' } as const

/** Sent to ask Deepgram to flush and close. */
const CLOSE_STREAM_MESSAGE = { type: 'CloseStream' } as const

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether `model` takes the `keyterm` parameter rather than `keywords`.
 *
 * The SDK's own `ListenV1Keyterm` doc comment is the source: *"Key term prompting can boost
 * specialized terminology and brands. Only compatible with Nova-3"*. Sending `keyterm` to
 * `nova-2` is rejected, and sending neither silently loses the single highest-value accuracy win
 * available to this product — so the choice is made explicitly rather than by hoping.
 */
export function supportsKeyterm(model: string): boolean {
  return model.toLowerCase().startsWith('nova-3')
}

/**
 * Trim, drop blanks, de-duplicate case-insensitively, and cap at {@link MAX_BOOST_TERMS}.
 *
 * Pure, so the vocabulary handling is exhaustively testable without a socket.
 */
export function normaliseVocabulary(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of terms) {
    const trimmed = term.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= MAX_BOOST_TERMS) break
  }
  return out
}

/** Deepgram's `Results` payload, narrowed to the fields this adapter reads. */
interface DeepgramResultsMessage {
  readonly type: string
  readonly is_final?: boolean
  readonly start?: number
  readonly duration?: number
  readonly channel?: {
    readonly alternatives?: readonly {
      readonly transcript?: string
      readonly confidence?: number
    }[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Recognise a `Results` message.
 *
 * The socket also delivers `Metadata`, `UtteranceEnd` and `SpeechStarted`, and — since the payload
 * arrives as parsed JSON off a network — could deliver anything at all. Everything that is not a
 * transcript is ignored rather than trusted.
 */
export function asResultsMessage(message: unknown): DeepgramResultsMessage | null {
  if (!isRecord(message)) return null
  if (message['type'] !== 'Results') return null
  return message as unknown as DeepgramResultsMessage
}

/** Clamp a reported confidence into `[0, 1]`, mapping anything non-finite to `null`. */
export function normaliseConfidence(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Emitted on every state transition; `error` is non-null only for `failed`. */
export type AsrStateListener = (state: AsrState, error: AppError | null) => void

/** Constructor dependencies. Only `apiKey` has no sensible default. */
export interface DeepgramProviderOptions {
  /** The raw `DEEPGRAM_API_KEY`. `null` or blank ⇒ the provider is `not-configured`. */
  readonly apiKey: string | null
  /** Builds a client per connection attempt. Defaults to the real SDK. */
  readonly createClient?: DeepgramClientFactory
  readonly timers?: AsrTimers
  /** Epoch-ms clock, for session-relative timestamps. */
  readonly now?: () => number
  readonly logger?: Logger
  readonly policy?: ReconnectPolicy
  /** Jitter source in `[0, 1)`. Same contract as `Math.random`. */
  readonly random?: () => number
  readonly keepAliveIntervalMs?: number
  readonly maxBufferedBytes?: number
  /** Override the per-language model choice. */
  readonly model?: string
  readonly endpointingMs?: number
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

interface QueuedChunk {
  readonly bytes: Uint8Array
}

/**
 * Streaming Deepgram transcription behind the Phase 7 provider shape.
 *
 * Construction opens nothing and schedules nothing: it is inert until {@link start}.
 */
export class DeepgramProvider implements AsrProvider {
  /** Which engine this is. Surfaced on every segment so a fallback is visible in the UI. */
  readonly id: AsrProviderId = 'deepgram'

  private readonly apiKey: string | null
  private readonly createClient: DeepgramClientFactory
  private readonly timers: AsrTimers
  private readonly now: () => number
  private readonly logger: Logger
  private readonly policy: ReconnectPolicy
  private readonly random: () => number
  private readonly keepAliveIntervalMs: number
  private readonly maxBufferedBytes: number
  private readonly modelOverride: string | null
  private readonly endpointingMs: number

  private state: AsrState
  private lastError: AppError | null = null

  private socket: DeepgramLiveSocketLike | null = null
  /** True between a successful {@link start} and {@link stop}. Gates all reconnection. */
  private running = false
  private startOptions: AsrStartOptions | null = null

  private sessionStartedAt: number | null = null
  /** Deepgram's `start` is relative to *this* socket; this shifts it onto the session clock. */
  private connectionOffsetMs = 0

  private reconnectAttempt = 0
  private reconnectHandle: AsrTimerHandle | null = null
  private keepAliveHandle: AsrTimerHandle | null = null

  private queue: QueuedChunk[] = []
  private queuedBytes = 0
  private droppedChunks = 0
  private droppedBytes = 0

  private spanCounter = 0
  private spanId: string | null = null

  private readonly segmentListeners = new Set<AsrSegmentListener>()
  private readonly errorListeners = new Set<AsrErrorListener>()
  private readonly stateListeners = new Set<AsrStateListener>()

  constructor(options: DeepgramProviderOptions) {
    const trimmedKey = options.apiKey === null ? '' : options.apiKey.trim()
    this.apiKey = trimmedKey.length === 0 ? null : trimmedKey
    this.createClient = options.createClient ?? createDeepgramListenClient
    this.timers = options.timers ?? realAsrTimers
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? nullLogger()
    this.policy = options.policy ?? DEEPGRAM_RECONNECT_POLICY
    this.random = options.random ?? Math.random
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_MS
    this.maxBufferedBytes = Math.max(0, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES)
    this.modelOverride = options.model ?? null
    this.endpointingMs = options.endpointingMs ?? DEFAULT_ENDPOINTING_MS
    this.state = this.apiKey === null ? 'not-configured' : 'idle'
  }

  // -- Introspection --------------------------------------------------------

  /** Part of the `AsrProvider` contract; the same value as {@link id}. */
  getId(): AsrProviderId {
    return this.id
  }

  /** False when `DEEPGRAM_API_KEY` is absent or blank. {@link start} then opens no socket. */
  isConfigured(): boolean {
    return this.apiKey !== null
  }

  getState(): AsrState {
    return this.state
  }

  getLastError(): AppError | null {
    return this.lastError
  }

  /** Bytes currently waiting to go out. Exposed for the status readout and for tests. */
  getBufferedBytes(): number {
    return this.queuedBytes
  }

  /** Total chunks discarded to keep the buffer bounded, for the whole process lifetime. */
  getDroppedChunkCount(): number {
    return this.droppedChunks
  }

  // -- Subscriptions --------------------------------------------------------

  onSegment(listener: AsrSegmentListener): Unsubscribe {
    this.segmentListeners.add(listener)
    return () => {
      this.segmentListeners.delete(listener)
    }
  }

  /**
   * Trouble while running: a refused connection, a socket that dropped, a reconnect loop that
   * gave up. One call is not a reason to change providers — `AsrService` debounces these.
   */
  onError(listener: AsrErrorListener): Unsubscribe {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  onStateChange(listener: AsrStateListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Open the transcript socket.
   *
   * Returns `NOT_CONFIGURED` — having touched nothing — when there is no key. A failure of the
   * *first* connection attempt is reported as `NOT_CONNECTED` and leaves the provider stopped
   * with no timers pending: the owning service decides whether to fall back to the local adapter
   * or retry, because only it can see both providers. Reconnection with backoff applies to
   * sockets that drop *mid-session*, which is the case where retrying silently is right.
   */
  async start(options: AsrStartOptions): Promise<Result<void>> {
    if (this.apiKey === null) {
      this.setState('not-configured', null)
      this.logger.info('deepgram: not configured, no socket opened', { hasApiKey: false })
      return err(
        ErrorCode.NOT_CONFIGURED,
        'DEEPGRAM_API_KEY is not set; the Deepgram provider is unavailable'
      )
    }
    if (this.running) return ok(undefined)

    this.running = true
    this.startOptions = options
    this.sessionStartedAt = this.now()
    this.connectionOffsetMs = 0
    this.reconnectAttempt = 0
    this.lastError = null
    this.resetQueue()
    this.spanId = null

    const connected = await this.openSocket()
    if (!connected.ok) {
      this.running = false
      this.startOptions = null
      this.sessionStartedAt = null
      this.setState('failed', connected.error)
      this.emitError(connected.error)
      return connected
    }
    return ok(undefined)
  }

  /**
   * Hand a chunk of 16 kHz mono 16-bit PCM to the transcriber.
   *
   * Audio is captured in the renderer (only it has `getUserMedia`) and arrives here over the
   * `asr:push-audio` IPC channel as an `ArrayBuffer`. Chunks are queued and flushed, so audio that
   * arrives while a reconnect is in flight is not silently lost — up to the buffer ceiling, past
   * which the oldest is dropped.
   */
  pushAudio(chunk: ArrayBuffer | ArrayBufferView): Result<void> {
    if (this.apiKey === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'DEEPGRAM_API_KEY is not set')
    }
    if (!this.running) {
      return err(ErrorCode.NOT_CONNECTED, 'Deepgram provider is not started')
    }

    const bytes = toBytes(chunk)
    if (bytes.byteLength === 0) return ok(undefined)

    this.enqueue(bytes)
    this.flushQueue()
    return ok(undefined)
  }

  /**
   * Close the socket and cancel every timer.
   *
   * Idempotent, and safe to call from a shutdown path: it never throws and never waits on the
   * network.
   */
  async stop(): Promise<Result<void>> {
    this.running = false
    this.startOptions = null
    this.cancelReconnect()
    this.stopKeepAlive()

    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      // Ask Deepgram to flush what it has before the socket goes away, then close regardless.
      // Both calls throw if the socket is already gone, which on a stop path is not a problem.
      try {
        socket.sendCloseStream(CLOSE_STREAM_MESSAGE)
      } catch {
        /* already closed */
      }
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    }

    this.resetQueue()
    this.spanId = null
    this.sessionStartedAt = null
    this.connectionOffsetMs = 0
    this.reconnectAttempt = 0
    this.setState(this.apiKey === null ? 'not-configured' : 'idle', null)
    return Promise.resolve(ok(undefined))
  }

  /** Stop, then drop every listener. For app shutdown and for test teardown. */
  async dispose(): Promise<void> {
    await this.stop()
    this.segmentListeners.clear()
    this.errorListeners.clear()
    this.stateListeners.clear()
  }

  // -- Connection -----------------------------------------------------------

  private buildConnectArgs(options: AsrStartOptions): DeepgramConnectArgs {
    const model = this.modelOverride ?? DEEPGRAM_MODEL_BY_LANGUAGE[options.language]
    const vocabulary = normaliseVocabulary(options.customVocabulary)
    if (options.customVocabulary.length > vocabulary.length) {
      this.logger.warn('deepgram: custom vocabulary truncated', {
        supplied: options.customVocabulary.length,
        sent: vocabulary.length,
        limit: MAX_BOOST_TERMS
      })
    }

    const base: DeepgramConnectArgs = {
      model,
      language: options.language,
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: this.endpointingMs,
      encoding: 'linear16',
      sample_rate: ASR_SAMPLE_RATE,
      channels: ASR_CHANNELS,
      // The SDK's ReconnectingWebSocket would otherwise retry 30 times on its own schedule,
      // racing this class's backoff loop and producing duplicate sockets.
      reconnectAttempts: 0
    }
    if (vocabulary.length === 0) return base
    return supportsKeyterm(model)
      ? { ...base, keyterm: vocabulary }
      : { ...base, keywords: vocabulary }
  }

  /** One connection attempt. Never throws; failure is a `Result`. */
  private async openSocket(): Promise<Result<void>> {
    const options = this.startOptions
    const apiKey = this.apiKey
    if (options === null || apiKey === null) {
      return err(ErrorCode.NOT_CONNECTED, 'Deepgram provider is not started')
    }

    this.setState('starting', null)
    const args = this.buildConnectArgs(options)
    this.logger.info('deepgram: connecting', {
      // Presence only. The key itself never reaches the logger.
      hasApiKey: true,
      model: args.model,
      language: args.language,
      boostedTerms: (args.keyterm ?? args.keywords ?? []).length,
      boostParam: args.keyterm === undefined ? 'keywords' : 'keyterm'
    })

    let socket: DeepgramLiveSocketLike
    try {
      socket = await this.createClient(apiKey).connect(args)
    } catch (cause) {
      const appError = toAppError(cause, ErrorCode.NOT_CONNECTED)
      this.lastError = appError
      this.logger.error('deepgram: connect failed', {
        code: appError.code,
        message: appError.message
      })
      return err(appError.code, appError.message, appError.detail)
    }

    this.socket = socket
    this.connectionOffsetMs = this.sessionStartedAt === null ? 0 : this.now() - this.sessionStartedAt
    this.attachHandlers(socket)
    return ok(undefined)
  }

  private attachHandlers(socket: DeepgramLiveSocketLike): void {
    const guard = (body: () => void): void => {
      // A throw here would surface inside the websocket library's event dispatch, where nothing
      // can handle it. Contain it.
      try {
        body()
      } catch (cause) {
        this.logger.error('deepgram: handler threw', { message: String(cause) })
      }
    }

    socket.on('open', () => {
      guard(() => {
        if (this.socket !== socket) return
        this.reconnectAttempt = 0
        this.lastError = null
        this.setState('listening', null)
        this.startKeepAlive()
        this.flushQueue()
        this.logger.info('deepgram: socket open')
      })
    })

    socket.on('message', (message) => {
      guard(() => {
        if (this.socket !== socket) return
        this.handleMessage(message)
      })
    })

    socket.on('error', (error) => {
      guard(() => {
        if (this.socket !== socket) return
        const appError = toAppError(error, ErrorCode.INTERNAL)
        this.lastError = appError
        // Deepgram follows an error with a close; the close handler owns the reconnect.
        this.logger.warn('deepgram: socket error', { message: error.message })
        this.emitError(appError)
      })
    })

    socket.on('close', (event) => {
      guard(() => {
        if (this.socket !== socket) return
        this.socket = null
        this.stopKeepAlive()
        if (!this.running) return

        this.logger.warn('deepgram: socket closed unexpectedly', {
          code: event.code,
          reason: event.reason
        })
        const appError: AppError = {
          code: ErrorCode.NOT_CONNECTED,
          message: `Deepgram socket closed (${String(event.code)})`
        }
        this.lastError = appError
        this.emitError(appError)
        this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.policy.maxAttempts
    if (maxAttempts !== null && this.reconnectAttempt >= maxAttempts) {
      this.logger.error('deepgram: giving up reconnecting', { attempts: this.reconnectAttempt })
      this.running = false
      const appError: AppError = this.lastError ?? {
        code: ErrorCode.NOT_CONNECTED,
        message: 'Deepgram reconnection attempts exhausted'
      }
      this.setState('failed', appError)
      this.emitError(appError)
      return
    }

    const delayMs = computeBackoffDelay(this.reconnectAttempt, this.policy, this.random)
    this.reconnectAttempt += 1
    this.setState('starting', null)
    this.logger.info('deepgram: reconnecting', { attempt: this.reconnectAttempt, delayMs })

    this.cancelReconnect()
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null
      if (!this.running) return
      void this.openSocket().then((result) => {
        if (!result.ok && this.running) this.scheduleReconnect()
      })
    }, delayMs)
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle === null) return
    this.timers.clearTimeout(this.reconnectHandle)
    this.reconnectHandle = null
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveHandle = this.timers.setInterval(() => {
      const socket = this.socket
      if (socket === null) return
      try {
        socket.sendKeepAlive(KEEPALIVE_MESSAGE)
      } catch {
        // The socket went away between the tick and the send; the close handler will react.
      }
    }, this.keepAliveIntervalMs)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveHandle === null) return
    this.timers.clearInterval(this.keepAliveHandle)
    this.keepAliveHandle = null
  }

  // -- Outbound audio -------------------------------------------------------

  private resetQueue(): void {
    this.queue = []
    this.queuedBytes = 0
  }

  /**
   * Append a chunk, evicting the oldest until the ceiling is respected.
   *
   * Oldest-first eviction is the deliberate choice: the newest audio is the audio the operator is
   * about to need a cue for, and stale audio transcribed ten seconds late is worse than useless —
   * it would fire cues against speech that has already finished.
   */
  private enqueue(bytes: Uint8Array): void {
    if (this.maxBufferedBytes === 0) return

    this.queue.push({ bytes })
    this.queuedBytes += bytes.byteLength

    let dropped = 0
    let droppedBytes = 0
    while (this.queuedBytes > this.maxBufferedBytes && this.queue.length > 0) {
      const oldest = this.queue.shift()
      if (oldest === undefined) break
      this.queuedBytes -= oldest.bytes.byteLength
      dropped += 1
      droppedBytes += oldest.bytes.byteLength
    }

    if (dropped === 0) return
    this.droppedChunks += dropped
    this.droppedBytes += droppedBytes
    // Logged every time, but the message is cheap and the situation is rare and important:
    // silently discarding a preacher's words is exactly the sort of thing that must show up in
    // the service-day log.
    this.logger.warn('deepgram: outbound audio buffer full, dropped oldest chunks', {
      droppedChunks: dropped,
      droppedBytes,
      droppedChunksTotal: this.droppedChunks,
      droppedBytesTotal: this.droppedBytes,
      bufferedBytes: this.queuedBytes,
      maxBufferedBytes: this.maxBufferedBytes
    })
  }

  private flushQueue(): void {
    const socket = this.socket
    if (socket === null || this.state !== 'listening') return

    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (next === undefined) break
      try {
        socket.sendMedia(next.bytes)
      } catch {
        // Socket not open (the SDK asserts before sending). Leave the chunk at the head of the
        // queue so it goes out once the connection is back, and stop draining.
        return
      }
      this.queue.shift()
      this.queuedBytes -= next.bytes.byteLength
    }
    if (this.queue.length === 0) this.queuedBytes = 0
  }

  // -- Inbound transcript ---------------------------------------------------

  private handleMessage(message: unknown): void {
    const results = asResultsMessage(message)
    if (results === null) return

    const alternative = results.channel?.alternatives?.[0]
    const text = alternative?.transcript?.trim() ?? ''
    const isFinal = results.is_final === true

    // Deepgram emits empty-transcript results constantly during silence. They carry no speech, so
    // they are not transcript — but an empty *final* still closes the span, so the next utterance
    // must start a fresh id.
    if (text.length === 0) {
      if (isFinal) this.spanId = null
      return
    }

    const id = this.currentSpanId()
    const startMs = Math.round(finiteOrZero(results.start) * 1000) + this.connectionOffsetMs
    const endMs =
      Math.round((finiteOrZero(results.start) + finiteOrZero(results.duration)) * 1000) +
      this.connectionOffsetMs

    const segment: TranscriptSegment = {
      id,
      text,
      isFinal,
      tsStart: Math.max(0, startMs),
      tsEnd: Math.max(Math.max(0, startMs), endMs),
      confidence: normaliseConfidence(alternative?.confidence),
      provider: 'deepgram',
      // Drafts are the local two-tier scheduler's concept; every cloud partial is a real partial.
      isDraft: false
    }

    // Rotate *after* the final is emitted, so the final carries the same id as the partials it
    // supersedes and a consumer replaces rather than appends.
    if (isFinal) this.spanId = null

    this.emitSegment(segment)
  }

  private currentSpanId(): string {
    const existing = this.spanId
    if (existing !== null) return existing
    this.spanCounter += 1
    const id = `dg-${String(this.sessionStartedAt ?? 0)}-${String(this.spanCounter)}`
    this.spanId = id
    return id
  }

  // -- Emission -------------------------------------------------------------

  private emitSegment(segment: TranscriptSegment): void {
    for (const listener of this.segmentListeners) {
      try {
        listener(segment)
      } catch (cause) {
        this.logger.error('deepgram: transcript listener threw', { message: String(cause) })
      }
    }
  }

  private emitError(error: AppError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error)
      } catch (cause) {
        this.logger.error('deepgram: error listener threw', { message: String(cause) })
      }
    }
  }

  private setState(next: AsrState, error: AppError | null): void {
    if (error !== null) this.lastError = error
    if (this.state === next) return
    this.state = next
    for (const listener of this.stateListeners) {
      try {
        listener(next, error)
      } catch (cause) {
        this.logger.error('deepgram: state listener threw', { message: String(cause) })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Real SDK wiring — the only place `@deepgram/sdk` is constructed
// ---------------------------------------------------------------------------

/**
 * Adapt the real `@deepgram/sdk` v5 client onto {@link DeepgramListenClientLike}.
 *
 * Everything version-specific lives here: `new DeepgramClient({ apiKey })` and
 * `client.listen.v1.connect(args)`. The rest of the file — and the whole test suite — sees only
 * the two-method structural interface above.
 *
 * The `require` is deliberately lazy. Constructing this module pulls in the SDK's websocket
 * transport, and neither the unit tests nor a Verger install without a Deepgram key should pay
 * for that, nor fail if the optional dependency is missing.
 */
export const createDeepgramListenClient: DeepgramClientFactory = (apiKey: string) => ({
  connect: async (args: DeepgramConnectArgs): Promise<DeepgramLiveSocketLike> => {
    const sdk = (await import('@deepgram/sdk')) as unknown as {
      DeepgramClient: new (options: { apiKey: string }) => {
        listen: { v1: { connect(connectArgs: unknown): Promise<unknown> } }
      }
    }
    const client = new sdk.DeepgramClient({ apiKey })
    const socket = await client.listen.v1.connect(args)
    return socket as DeepgramLiveSocketLike
  }
})

/** A logger that discards everything, so no code path has to branch on "do I have a logger". */
function nullLogger(): Logger {
  const noop = (): void => {}
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger
  }
  return logger
}

/** Normalise the two shapes the IPC layer and the tests hand us into a byte view. */
function toBytes(chunk: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return new Uint8Array(chunk)
}
