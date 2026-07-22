/**
 * Verse-text resolution — turning a detected {@link ScriptureReference} into a
 * {@link ResolvedScripture}.
 *
 * ## Standing Rule 4 governs this file
 *
 * **No verse text is authored here, ever.** Not in code, not in a comment, not as an example, not
 * in a fixture. The detector produces a *reference*; this module fetches the *text* at runtime
 * from a verified public-domain file the operator downloaded, or from a licensed API called with
 * the operator's own key. `ScriptureResolver.test.ts` asserts this file's own source contains no
 * long quoted string, as a standing regression guard.
 *
 * `docs/v2-notes/LEGAL_AND_CONTENT.md` §6 records why the rule is architectural rather than
 * editorial: the EULA promises the congregation that "detected scripture references are resolved
 * against your locally configured Bible database and are never generated from a language model's
 * memory; when a reference cannot be resolved, only the reference is shown, never invented verse
 * text." This module is where that promise is either kept or broken.
 *
 * ## Failure is normal, and must be quiet
 *
 * A resolution failure returns `Err`. The caller renders the *reference* plus "text unavailable",
 * never an empty card and never a substitute verse. There is deliberately **no fallback to a
 * different translation and no fallback to a different reference** — showing the congregation
 * something adjacent to what the pastor asked for is worse than showing nothing, because nobody
 * in the room can tell it happened.
 *
 * This also feeds `canAutoShow()` in `@shared/scripture`: an unresolved reference can never
 * auto-show, whatever the confidence. Confidence in the reference says nothing about the text.
 *
 * ## Resolution order
 *
 *  1. **In-memory LRU cache.** The same verse is commonly shown twice in one service (read, then
 *     returned to in the sermon). A cache hit performs no I/O at all.
 *  2. **A verified public-domain local file**, via the injected {@link PublicDomainStore}. Faster,
 *     free, and — the reason that matters — it still works when the building's internet drops
 *     mid-sermon.
 *  3. **A licensed API**, only when its key is configured. ESV or API.Bible.
 *
 * ## Bounded, because a live service cannot wait
 *
 *  - every request has a deadline ({@link DEFAULT_TIMEOUT_MS});
 *  - concurrent network requests are capped ({@link DEFAULT_MAX_CONCURRENT_REQUESTS}) so a burst
 *    of detections during a rapid-fire reading cannot hammer the API;
 *  - a `401`/`403` disables that provider for the rest of the session instead of retrying. One
 *    wrong key must not become a request storm ten minutes into the service.
 *
 * ## The key never gets logged
 *
 * Keys travel in request headers only; nothing in this file writes a key, a header map, or a
 * response body to the logger. Failure detail is the HTTP status and nothing else.
 *
 * Everything is injected — config, logger, fetch, cache, store — so the tests need no network,
 * no key and no Electron. There is no code path here that throws.
 */

import type { AppConfig } from '@shared/config'
import type { Logger } from '@shared/log'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import { formatReference, scriptureReferenceSchema } from '@shared/scripture'
import type { ResolvedScripture, ScriptureReference, TranslationSource } from '@shared/scripture'

import {
  findCatalogueEntry,
  findSelectableEntry,
  listTranslations,
  usableProviders,
} from './translations'
import type { TranslationAvailability, TranslationProvider } from './translations'

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Per-request deadline.
 *
 * Four seconds. A verse that arrives later than this has missed the moment it was for — the
 * operator has already reached for the manual control — and an unbounded request would keep a
 * slot in the concurrency cap occupied while it fails.
 */
export const DEFAULT_TIMEOUT_MS = 4_000

/**
 * Maximum simultaneous network resolutions.
 *
 * Three. A responsive reading or a rapid list of cross-references can produce detections faster
 * than any API will answer them; without a cap, a single minute of the service can queue dozens
 * of requests, and the ones that matter arrive last. Requests over the cap fail fast with
 * `RATE_LIMITED` rather than queueing, because a queued request is already too late to be useful
 * and a queue is exactly the hammering this prevents.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 3

/** Verses retained in the LRU. Small: one service reuses a handful of references, not hundreds. */
export const DEFAULT_CACHE_SIZE = 64

/** Fallback translation when none is chosen — matches `defaultCueEngineSettings()`. */
export const DEFAULT_TRANSLATION = 'KJV'

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** The slice of a `fetch` response this module uses. Narrow on purpose, so tests can fake it. */
export interface FetchLikeResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Request options passed to {@link FetchLike}. */
export interface FetchLikeInit {
  readonly signal: AbortSignal
  readonly headers: Record<string, string>
}

/** The `fetch` surface this module uses. `globalThis.fetch` satisfies it structurally. */
export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>

/** What a public-domain lookup yields. Text arrives from a downloaded file, never from here. */
export interface PublicDomainVerseText {
  readonly text: string
  readonly attribution: string | null
}

/**
 * The local, verified public-domain store.
 *
 * Implemented elsewhere (the downloader/importer owns the file format). This module only needs to
 * ask "do you have this translation" and "give me this reference". A store that has the
 * translation but not the verse returns `null` — that is a {@link ErrorCode.NOT_FOUND}, not a
 * licence to try a different verse.
 */
export interface PublicDomainStore {
  /** Codes whose verified public-domain file is downloaded and readable on this machine. */
  availableCodes(): readonly string[]
  /** Verse text, or `null` when this store cannot supply that exact reference. */
  lookup(code: string, reference: ScriptureReference): Promise<PublicDomainVerseText | null>
}

/** The cache interface. A default LRU is built by {@link createScriptureCache}. */
export interface ScriptureCache {
  get(key: string): ResolvedScripture | null
  set(key: string, value: ResolvedScripture): void
  clear(): void
  readonly size: number
}

/**
 * A least-recently-used cache over `Map` insertion order.
 *
 * `Map` iterates in insertion order, so re-inserting on read moves an entry to the back and the
 * first key is always the least recently used. Sixty-four entries of short strings is nothing;
 * the bound exists so a long service cannot grow it without limit.
 */
export function createScriptureCache(max: number = DEFAULT_CACHE_SIZE): ScriptureCache {
  const limit = Math.max(1, Math.floor(max))
  const entries = new Map<string, ResolvedScripture>()
  return {
    get(key: string): ResolvedScripture | null {
      const found = entries.get(key)
      if (found === undefined) return null
      entries.delete(key)
      entries.set(key, found)
      return found
    },
    set(key: string, value: ResolvedScripture): void {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, value)
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
    clear(): void {
      entries.clear()
    },
    get size(): number {
      return entries.size
    },
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface ScriptureResolverDeps {
  /** Resolved `.env`. Supplies the ESV / API.Bible keys, or `null` for each when unset. */
  readonly config: AppConfig
  readonly logger?: Logger
  /** Defaults to `globalThis.fetch` when one exists, otherwise resolution is API-less. */
  readonly fetchImpl?: FetchLike
  readonly cache?: ScriptureCache
  readonly pdStore?: PublicDomainStore
  /** Translation used when the caller does not name one. Default {@link DEFAULT_TRANSLATION}. */
  readonly defaultTranslation?: string
  /**
   * Catalogue code → API.Bible bible id, as the operator mapped them.
   *
   * Per-code, never a single global id: API.Bible serves hundreds of translations behind one key,
   * and answering a request for one translation with the text of another is undetectable from the
   * congregation's seat. A code with no mapping is simply not API-servable.
   */
  readonly apiBibleIds?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxConcurrentRequests?: number
}

// ---------------------------------------------------------------------------
// USFM book identifiers (API.Bible passage ids)
// ---------------------------------------------------------------------------

/**
 * Canonical English book name → USFM book id, as API.Bible passage ids use them.
 *
 * Identifiers only. A book absent from this map yields `INVALID_ARG` rather than a guess, because
 * a guessed passage id resolves to *some other passage*, which is the one failure mode this whole
 * module exists to prevent.
 */
const USFM_BOOK_IDS: Readonly<Record<string, string>> = {
  genesis: 'GEN',
  exodus: 'EXO',
  leviticus: 'LEV',
  numbers: 'NUM',
  deuteronomy: 'DEU',
  joshua: 'JOS',
  judges: 'JDG',
  ruth: 'RUT',
  '1 samuel': '1SA',
  '2 samuel': '2SA',
  '1 kings': '1KI',
  '2 kings': '2KI',
  '1 chronicles': '1CH',
  '2 chronicles': '2CH',
  ezra: 'EZR',
  nehemiah: 'NEH',
  esther: 'EST',
  job: 'JOB',
  psalms: 'PSA',
  psalm: 'PSA',
  proverbs: 'PRO',
  ecclesiastes: 'ECC',
  'song of solomon': 'SNG',
  'song of songs': 'SNG',
  isaiah: 'ISA',
  jeremiah: 'JER',
  lamentations: 'LAM',
  ezekiel: 'EZK',
  daniel: 'DAN',
  hosea: 'HOS',
  joel: 'JOL',
  amos: 'AMO',
  obadiah: 'OBA',
  jonah: 'JON',
  micah: 'MIC',
  nahum: 'NAM',
  habakkuk: 'HAB',
  zephaniah: 'ZEP',
  haggai: 'HAG',
  zechariah: 'ZEC',
  malachi: 'MAL',
  matthew: 'MAT',
  mark: 'MRK',
  luke: 'LUK',
  john: 'JHN',
  acts: 'ACT',
  romans: 'ROM',
  '1 corinthians': '1CO',
  '2 corinthians': '2CO',
  galatians: 'GAL',
  ephesians: 'EPH',
  philippians: 'PHP',
  colossians: 'COL',
  '1 thessalonians': '1TH',
  '2 thessalonians': '2TH',
  '1 timothy': '1TI',
  '2 timothy': '2TI',
  titus: 'TIT',
  philemon: 'PHM',
  hebrews: 'HEB',
  james: 'JAS',
  '1 peter': '1PE',
  '2 peter': '2PE',
  '1 john': '1JN',
  '2 john': '2JN',
  '3 john': '3JN',
  jude: 'JUD',
  revelation: 'REV',
}

/** USFM id for a canonical English book name, or `null` when unknown. */
export function usfmBookId(book: string): string | null {
  // Single normalising pass, no nested quantifiers — this runs against detector output on a live
  // transcript, and a backtracking regex here would stall the main process.
  const normalised = book.trim().toLowerCase().replace(/\s+/g, ' ')
  return USFM_BOOK_IDS[normalised] ?? null
}

/** `JHN.3.16`, `JHN.3.16-JHN.3.18`, or `JHN.3` for a whole chapter. */
export function apiBiblePassageId(reference: ScriptureReference): string | null {
  const bookId = usfmBookId(reference.book)
  if (bookId === null) return null
  if (reference.verse === null) return `${bookId}.${reference.chapter}`
  const start = `${bookId}.${reference.chapter}.${reference.verse}`
  if (reference.verseEnd === null || reference.verseEnd <= reference.verse) return start
  return `${start}-${bookId}.${reference.chapter}.${reference.verseEnd}`
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

const NULL_LOGGER: Logger = (() => {
  const noop = (): void => {}
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger
})()

/** Resolves references to text, or explains why it cannot. Never throws. */
export class ScriptureResolver {
  private readonly config: AppConfig
  private readonly logger: Logger
  private readonly fetchImpl: FetchLike | null
  private readonly cache: ScriptureCache
  private readonly pdStore: PublicDomainStore | null
  private readonly defaultTranslation: string
  private readonly apiBibleIds: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly maxConcurrentRequests: number

  private inFlightCount = 0

  /**
   * Providers whose configured key was rejected this session.
   *
   * A `401` is not transient. Retrying it once per detection turns one wrong key into a steady
   * stream of failed requests for the whole service; the operator sees the same error either way,
   * so the second attempt buys nothing and costs a request slot.
   */
  private readonly authRejected = new Set<TranslationProvider>()

  constructor(deps: ScriptureResolverDeps) {
    this.config = deps.config
    this.logger = (deps.logger ?? NULL_LOGGER).child('scripture')
    this.fetchImpl = deps.fetchImpl ?? defaultFetch()
    this.cache = deps.cache ?? createScriptureCache()
    this.pdStore = deps.pdStore ?? null
    this.defaultTranslation = deps.defaultTranslation ?? DEFAULT_TRANSLATION
    this.apiBibleIds = deps.apiBibleIds ?? {}
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxConcurrentRequests = Math.max(
      1,
      deps.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    )
  }

  /** Network requests currently outstanding. Exposed for the settings panel and the tests. */
  get inFlight(): number {
    return this.inFlightCount
  }

  /** What this machine can currently offer. Quarantined translations are absent, not disabled. */
  listTranslations(): readonly TranslationSource[] {
    return listTranslations(this.availability())
  }

  /** Drop every cached verse — used when the operator changes translation. */
  clearCache(): void {
    this.cache.clear()
  }

  /** Re-enable providers disabled by a rejected key, after the operator edits `.env`. */
  clearAuthFailures(): void {
    this.authRejected.clear()
  }

  /**
   * Resolve a reference to text.
   *
   * Returns `Err` on every failure, including the ordinary ones: nothing configured, verse absent
   * from the chosen translation, network down. The caller shows the reference with a "text
   * unavailable" note. It never returns text from a translation other than the one requested.
   */
  async resolve(
    reference: ScriptureReference,
    translationCode?: string,
  ): Promise<Result<ResolvedScripture>> {
    const parsed = scriptureReferenceSchema.safeParse(reference)
    if (!parsed.success) {
      return err(ErrorCode.INVALID_ARG, 'Scripture reference failed validation.')
    }

    const requested = (translationCode ?? this.defaultTranslation).trim()
    const entry = findSelectableEntry(requested)
    if (entry === null) {
      const known = findCatalogueEntry(requested)
      if (known !== null && !known.verified) {
        // The quarantine gate, reached by asking for the translation directly rather than picking
        // it. `docs/v2-notes/LEGAL_AND_CONTENT.md` §3: the exclusion has to hold at the data
        // layer, not only in the picker.
        this.logger.warn('refused quarantined translation', {
          translation: known.code,
          legalHold: known.legalHold,
        })
        return err(
          ErrorCode.INVALID_ARG,
          `${known.name} is not available: its public-domain status is unverified.`,
          known.legalHold ?? undefined,
        )
      }
      return err(ErrorCode.NOT_FOUND, `Unknown translation "${requested}".`)
    }

    const key = cacheKey(entry.code, reference)
    const cached = this.cache.get(key)
    if (cached !== null) return ok(cached)

    const providers = usableProviders(entry, this.availability())
    if (providers.length === 0) {
      return err(ErrorCode.NOT_CONFIGURED, notConfiguredMessage(entry.code))
    }

    let lastError: Result<ResolvedScripture> | null = null
    for (const provider of providers) {
      if (this.authRejected.has(provider)) {
        lastError = err(
          ErrorCode.NOT_CONFIGURED,
          `The ${providerLabel(provider)} key was rejected. Check it in Settings, then try again.`,
        )
        continue
      }

      const attempt = await this.tryProvider(provider, entry.code, reference)
      if (attempt.ok) {
        const resolved: ResolvedScripture = {
          reference,
          text: attempt.value.text,
          translation: entry.code,
          // The provider's own notice wins — API.Bible returns the publisher's required wording on
          // the response, and that is the wording the overlay must render.
          attribution: attempt.value.attribution ?? entry.attribution,
        }
        this.cache.set(key, resolved)
        this.logger.debug('resolved scripture', {
          translation: entry.code,
          provider,
          reference: formatReference(reference),
        })
        return ok(resolved)
      }
      lastError = attempt
    }

    return lastError ?? err(ErrorCode.NOT_CONFIGURED, notConfiguredMessage(entry.code))
  }

  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  private async tryProvider(
    provider: TranslationProvider,
    code: string,
    reference: ScriptureReference,
  ): Promise<Result<PublicDomainVerseText>> {
    if (provider === 'public-domain') return this.fromPublicDomain(code, reference)
    if (provider === 'esv') return this.withSlot(() => this.fromEsv(reference))
    return this.withSlot(() => this.fromApiBible(code, reference))
  }

  /** Local file. No network, no slot, no timeout — it is a disk read the store already bounded. */
  private async fromPublicDomain(
    code: string,
    reference: ScriptureReference,
  ): Promise<Result<PublicDomainVerseText>> {
    const store = this.pdStore
    if (store === null) return err(ErrorCode.NOT_CONFIGURED, notConfiguredMessage(code))
    try {
      const found = await store.lookup(code, reference)
      if (found === null || found.text.trim().length === 0) {
        return err(
          ErrorCode.NOT_FOUND,
          `${formatReference(reference)} is not in the downloaded ${code} text.`,
        )
      }
      return ok({ text: found.text.trim(), attribution: found.attribution })
    } catch (cause) {
      // A store that throws is a bug in the store, not a reason to take the service down.
      this.logger.warn('public-domain lookup failed', { translation: code, cause: String(cause) })
      return err(ErrorCode.IO_ERROR, `Could not read the downloaded ${code} text.`)
    }
  }

  private async fromEsv(reference: ScriptureReference): Promise<Result<PublicDomainVerseText>> {
    const apiKey = this.config.esvApiKey
    if (apiKey === null) return err(ErrorCode.NOT_CONFIGURED, notConfiguredMessage('ESV'))

    const query = encodeURIComponent(formatReference(reference))
    const url =
      'https://api.esv.org/v3/passage/text/?q=' +
      query +
      '&include-passage-references=false&include-verse-numbers=false' +
      '&include-first-verse-numbers=false&include-footnotes=false&include-headings=false' +
      '&include-short-copyright=false&include-selahs=false'

    // The key travels in this header and nowhere else. It is never logged, never placed in a URL
    // (URLs reach proxies and crash reports), and never copied into an error detail.
    const response = await this.request('esv', url, { Authorization: `Token ${apiKey}` })
    if (!response.ok) return response

    const passages = readStringArray(response.value, 'passages')
    const text = passages.join('\n').trim()
    if (text.length === 0) {
      return err(
        ErrorCode.NOT_FOUND,
        `The ESV API returned no passage for ${formatReference(reference)}.`,
      )
    }
    return ok({ text, attribution: null })
  }

  private async fromApiBible(
    code: string,
    reference: ScriptureReference,
  ): Promise<Result<PublicDomainVerseText>> {
    const apiKey = this.config.apiBibleKey
    const bibleId = this.apiBibleIds[code] ?? null
    if (apiKey === null || bibleId === null || bibleId.length === 0) {
      return err(ErrorCode.NOT_CONFIGURED, notConfiguredMessage(code))
    }

    const passageId = apiBiblePassageId(reference)
    if (passageId === null) {
      return err(
        ErrorCode.INVALID_ARG,
        `API.Bible has no passage id for the book "${reference.book}".`,
      )
    }

    const url =
      `https://api.scripture.api.bible/v1/bibles/${encodeURIComponent(bibleId)}` +
      `/passages/${encodeURIComponent(passageId)}` +
      '?content-type=text&include-notes=false&include-titles=false' +
      '&include-chapter-numbers=false&include-verse-numbers=false&include-verse-spans=false'

    const response = await this.request('api-bible', url, { 'api-key': apiKey })
    if (!response.ok) return response

    const data = readRecord(response.value, 'data')
    const text = readString(data, 'content').trim()
    if (text.length === 0) {
      return err(
        ErrorCode.NOT_FOUND,
        `API.Bible returned no passage for ${formatReference(reference)}.`,
      )
    }
    // Carried through verbatim: most licences require the publisher's own notice to be displayed,
    // and the overlay renders whatever lands here.
    const copyright = readString(data, 'copyright').trim()
    return ok({ text, attribution: copyright.length === 0 ? null : copyright })
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Runs `work` only if a concurrency slot is free; otherwise fails fast. */
  private async withSlot<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.inFlightCount >= this.maxConcurrentRequests) {
      return err(
        ErrorCode.RATE_LIMITED,
        'Too many scripture lookups at once — try again in a moment.',
      )
    }
    this.inFlightCount += 1
    try {
      return await work()
    } finally {
      this.inFlightCount -= 1
    }
  }

  /** One bounded request. No retries: see {@link ScriptureResolver.authRejected}. */
  private async request(
    provider: TranslationProvider,
    url: string,
    headers: Record<string, string>,
  ): Promise<Result<unknown>> {
    const fetchImpl = this.fetchImpl
    if (fetchImpl === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'No network client is available in this build.')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers })
      if (!response.ok) return this.mapHttpFailure(provider, response.status)
      const body = await response.json()
      return ok(body)
    } catch (cause) {
      if (controller.signal.aborted) {
        this.logger.warn('scripture lookup timed out', { provider, timeoutMs: this.timeoutMs })
        return err(ErrorCode.TIMEOUT, 'The Bible service did not answer in time.')
      }
      this.logger.warn('scripture lookup failed', { provider, cause: String(cause) })
      return err(ErrorCode.NOT_CONNECTED, 'Could not reach the Bible service.')
    } finally {
      clearTimeout(timer)
    }
  }

  private mapHttpFailure(provider: TranslationProvider, status: number): Result<never> {
    const label = providerLabel(provider)
    if (status === 401 || status === 403) {
      // Disabled for the session. One wrong key must not become a request storm mid-service.
      this.authRejected.add(provider)
      this.logger.error('bible api rejected the configured key', { provider, status })
      return err(
        ErrorCode.NOT_CONFIGURED,
        `The ${label} key was rejected. Check it in Settings, then try again.`,
        `HTTP ${status}`,
      )
    }
    if (status === 404) {
      return err(ErrorCode.NOT_FOUND, `${label} has no text for that reference.`, `HTTP ${status}`)
    }
    if (status === 429) {
      return err(ErrorCode.RATE_LIMITED, `${label} is rate limiting Verger.`, `HTTP ${status}`)
    }
    this.logger.warn('bible api returned an error', { provider, status })
    return err(ErrorCode.INTERNAL, `${label} returned an error.`, `HTTP ${status}`)
  }

  private availability(): TranslationAvailability {
    const downloaded = this.pdStore === null ? [] : safeAvailableCodes(this.pdStore, this.logger)
    const mapped = Object.entries(this.apiBibleIds)
      .filter(([, id]) => id.length > 0)
      .map(([code]) => code)
    return {
      esvKeyConfigured: this.config.esvApiKey !== null,
      apiBibleKeyConfigured: this.config.apiBibleKey !== null,
      apiBibleCodes: mapped,
      downloadedCodes: downloaded,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cache key. Includes the translation, so two translations never share an entry. */
export function cacheKey(translationCode: string, reference: ScriptureReference): string {
  return `${translationCode.toUpperCase()}::${reference.book}::${reference.chapter}::${
    reference.verse ?? '*'
  }::${reference.verseEnd ?? '*'}`
}

/** The message the UI renders when this machine has no source for a translation. */
export function notConfiguredMessage(code: string): string {
  return (
    `No Bible source is configured for ${code}. ` +
    'Download a public-domain translation, or add an ESV or API.Bible key in Settings.'
  )
}

function providerLabel(provider: TranslationProvider): string {
  if (provider === 'esv') return 'ESV API'
  if (provider === 'api-bible') return 'API.Bible'
  return 'the downloaded translation'
}

function safeAvailableCodes(store: PublicDomainStore, logger: Logger): readonly string[] {
  try {
    return store.availableCodes()
  } catch (cause) {
    logger.warn('public-domain store could not list its translations', { cause: String(cause) })
    return []
  }
}

function defaultFetch(): FetchLike | null {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  return typeof candidate === 'function' ? (candidate as FetchLike) : null
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  const found = (value as Record<string, unknown>)[key]
  if (typeof found !== 'object' || found === null || Array.isArray(found)) return {}
  return found as Record<string, unknown>
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : ''
}

function readStringArray(value: unknown, key: string): readonly string[] {
  if (typeof value !== 'object' || value === null) return []
  const found = (value as Record<string, unknown>)[key]
  if (!Array.isArray(found)) return []
  return found.filter((item): item is string => typeof item === 'string')
}
