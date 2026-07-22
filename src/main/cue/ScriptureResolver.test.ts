/**
 * Tests for verse-text resolution and the translation catalogue.
 *
 * ## Standing Rule 4 applies to this file as hard as to the source
 *
 * **Every fixture is a placeholder.** No verse text appears here, in any translation, in any
 * language. Where a test needs "the text a provider returned" it returns the literal
 * {@link PLACEHOLDER_TEXT}. `does not contain verse text` at the bottom of this file scans the two
 * source modules and fails if either grows a long quoted string — the standing regression guard
 * against someone "helpfully" pasting a verse in as an example.
 *
 * There is **zero network here**: `fetch` is injected in every test, and the default
 * `globalThis.fetch` is never reachable because no test constructs a resolver without one except
 * the not-configured cases, which return before any transport is touched.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import type { AppConfig, EnvKey } from '@shared/config'
import { ErrorCode } from '@shared/result'
import type { ScriptureReference } from '@shared/scripture'

import {
  DEFAULT_TRANSLATION,
  ScriptureResolver,
  apiBiblePassageId,
  cacheKey,
  createScriptureCache,
  usfmBookId,
} from './ScriptureResolver'
import type { FetchLike, FetchLikeResponse, PublicDomainStore } from './ScriptureResolver'
import {
  LEGAL_HOLD_TRANSLATION_CODES,
  TRANSLATION_CATALOGUE,
  isAllowedSourceUrl,
  listTranslations,
  listTranslationsIncludingQuarantined,
  publicDomainSourceUrl,
} from './translations'

// ---------------------------------------------------------------------------
// Fixtures — invented placeholders only
// ---------------------------------------------------------------------------

/** Stands in for whatever a provider returned. Never a verse. */
const PLACEHOLDER_TEXT = 'VERSE TEXT PLACEHOLDER'
const PLACEHOLDER_ATTRIBUTION = 'PLACEHOLDER ATTRIBUTION'
const PLACEHOLDER_COPYRIGHT = 'PLACEHOLDER PUBLISHER NOTICE'

function reference(verse: number): ScriptureReference {
  return {
    book: 'John',
    spokenBook: 'John',
    chapter: 3,
    verse,
    verseEnd: null,
    confidence: 0.95,
    band: 'exact',
    sourceText: 'PLACEHOLDER TRANSCRIPT SPAN',
  }
}

const NOTHING_CONFIGURED: Record<EnvKey, boolean> = {
  OBS_WEBSOCKET_URL: false,
  OBS_WEBSOCKET_PASSWORD: false,
  GOOGLE_CLIENT_ID: false,
  GOOGLE_CLIENT_SECRET: false,
  DEEPGRAM_API_KEY: false,
  ESV_API_KEY: false,
  API_BIBLE_KEY: false,
  SENTRY_DSN: false,
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  const configured: Record<EnvKey, boolean> = { ...NOTHING_CONFIGURED }
  return {
    obs: null,
    google: null,
    deepgramApiKey: null,
    esvApiKey: null,
    apiBibleKey: null,
    sentryDsn: null,
    configured,
    warnings: [],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** A fetch that must never be called. Any call fails the test loudly. */
function forbiddenFetch(): FetchLike & { readonly mock: { calls: unknown[] } } {
  const impl = vi.fn(async () => {
    throw new Error('network was used')
  })
  return impl as unknown as FetchLike & { readonly mock: { calls: unknown[] } }
}

function pdStore(codes: readonly string[], text: string | null): PublicDomainStore {
  return {
    availableCodes: () => codes,
    lookup: async () =>
      text === null ? null : { text, attribution: PLACEHOLDER_ATTRIBUTION },
  }
}

// ---------------------------------------------------------------------------
// Catalogue + quarantine
// ---------------------------------------------------------------------------

describe('translation catalogue', () => {
  it('never offers the quarantined KRV translation', () => {
    const offered = listTranslations({
      esvKeyConfigured: true,
      apiBibleKeyConfigured: true,
      downloadedCodes: ['KJV', 'KRV'],
    })
    expect(offered.some((entry) => entry.code === 'KRV')).toBe(false)
    expect(offered.some((entry) => entry.code === 'KJV')).toBe(true)
  })

  it('keeps the quarantined row on file, marked unverified, so the exclusion is auditable', () => {
    const all = listTranslationsIncludingQuarantined()
    const krv = all.find((entry) => entry.code === 'KRV')
    expect(krv).toBeDefined()
    expect(krv?.verified).toBe(false)
    expect(krv?.kind).toBe('unavailable')
  })

  it('holds KRV on the legal-hold list (standing regression guard)', () => {
    // Mirrors v2's `assert!(LEGAL_HOLD_SEED_FILES.contains(...))`. If someone clears this list
    // without a signed-off verification, this test is the tripwire.
    expect(LEGAL_HOLD_TRANSLATION_CODES).toContain('KRV')
    const row = TRANSLATION_CATALOGUE.find((entry) => entry.code === 'KRV')
    expect(row?.verified).toBe(false)
    expect(row?.legalHold).toBeTruthy()
  })

  it('lists every verified translation, marking unconfigured ones unavailable rather than hiding them', () => {
    const offered = listTranslations()
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((entry) => entry.verified)).toBe(true)
    expect(offered.every((entry) => entry.kind === 'unavailable')).toBe(true)
  })

  it('marks a licensed translation available only once its key is configured', () => {
    const without = listTranslations().find((entry) => entry.code === 'ESV')
    expect(without?.kind).toBe('unavailable')
    const withKey = listTranslations({ esvKeyConfigured: true }).find(
      (entry) => entry.code === 'ESV',
    )
    expect(withKey?.kind).toBe('licensed-api')
  })

  it('marks a public-domain translation available only once its file is downloaded', () => {
    const before = listTranslations().find((entry) => entry.code === 'WEB')
    expect(before?.kind).toBe('unavailable')
    const after = listTranslations({ downloadedCodes: ['WEB'] }).find(
      (entry) => entry.code === 'WEB',
    )
    expect(after?.kind).toBe('public-domain')
  })

  it('pins public-domain downloads to an allow-listed HTTPS host', () => {
    expect(publicDomainSourceUrl('KJV')).toMatch(/^https:\/\//)
    expect(publicDomainSourceUrl('KRV')).toBeNull()
    expect(isAllowedSourceUrl('http://api.getbible.net/v2/kjv.json')).toBe(false)
    expect(isAllowedSourceUrl('https://example.invalid/kjv.json')).toBe(false)
    expect(isAllowedSourceUrl('not a url')).toBe(false)
  })

  it('carries an attribution for every public-domain entry it offers', () => {
    for (const entry of listTranslations({ downloadedCodes: ['KJV', 'ASV', 'WEB', 'BSB'] })) {
      if (entry.kind === 'public-domain') expect(entry.attribution).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('ScriptureResolver', () => {
  it('returns NOT_CONFIGURED with a renderable message when nothing is set up', async () => {
    const resolver = new ScriptureResolver({ config: config(), fetchImpl: forbiddenFetch() })
    const result = await resolver.resolve(reference(16))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(result.error.message).toContain(DEFAULT_TRANSLATION)
    expect(result.error.message.length).toBeGreaterThan(20)
  })

  it('refuses a quarantined translation even when asked for it directly', async () => {
    const fetchImpl = forbiddenFetch()
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key', apiBibleKey: 'test-key' }),
      fetchImpl,
      pdStore: pdStore(['KRV'], PLACEHOLDER_TEXT),
    })

    const result = await resolver.resolve(reference(16), 'KRV')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(result.error.message).toContain('unverified')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an unknown translation rather than substituting another', async () => {
    const resolver = new ScriptureResolver({ config: config(), fetchImpl: forbiddenFetch() })
    const result = await resolver.resolve(reference(16), 'NOT_A_TRANSLATION')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('rejects a malformed reference', async () => {
    const resolver = new ScriptureResolver({ config: config(), fetchImpl: forbiddenFetch() })
    const broken = { ...reference(16), chapter: 0 }
    const result = await resolver.resolve(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
  })

  it('prefers the local public-domain file over the API when both are available', async () => {
    const fetchImpl = forbiddenFetch()
    const resolver = new ScriptureResolver({
      config: config({ apiBibleKey: 'test-key' }),
      apiBibleIds: { KJV: 'placeholder-bible-id' },
      pdStore: pdStore(['KJV'], PLACEHOLDER_TEXT),
      fetchImpl,
    })

    const result = await resolver.resolve(reference(16), 'KJV')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toBe(PLACEHOLDER_TEXT)
    expect(result.value.translation).toBe('KJV')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('carries the public-domain attribution through to the resolved verse', async () => {
    const resolver = new ScriptureResolver({
      config: config(),
      pdStore: pdStore(['WEB'], PLACEHOLDER_TEXT),
      fetchImpl: forbiddenFetch(),
    })
    const result = await resolver.resolve(reference(16), 'WEB')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.attribution).toBe(PLACEHOLDER_ATTRIBUTION)
  })

  it('reports NOT_FOUND when the downloaded translation lacks the verse, and invents nothing', async () => {
    const resolver = new ScriptureResolver({
      config: config(),
      pdStore: pdStore(['WEB'], null),
      fetchImpl: forbiddenFetch(),
    })
    const result = await resolver.resolve(reference(16), 'WEB')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('caches a resolved verse so the same reference is fetched once', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ passages: [PLACEHOLDER_TEXT] }))
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl,
    })

    const first = await resolver.resolve(reference(16), 'ESV')
    const second = await resolver.resolve(reference(16), 'ESV')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.text).toBe(PLACEHOLDER_TEXT)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends the ESV key in a header and never in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ passages: [PLACEHOLDER_TEXT] }))
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl,
    })

    await resolver.resolve(reference(16), 'ESV')

    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('api.esv.org')
    expect(url).not.toContain('test-key')
    expect(init.headers['Authorization']).toBe('Token test-key')
  })

  it('carries the API.Bible publisher notice through as the attribution', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { content: PLACEHOLDER_TEXT, copyright: PLACEHOLDER_COPYRIGHT } }),
    )
    const resolver = new ScriptureResolver({
      config: config({ apiBibleKey: 'test-key' }),
      apiBibleIds: { API_BIBLE: 'placeholder-bible-id' },
      fetchImpl,
    })

    const result = await resolver.resolve(reference(16), 'API_BIBLE')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toBe(PLACEHOLDER_TEXT)
    expect(result.value.attribution).toBe(PLACEHOLDER_COPYRIGHT)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toContain('JHN.3.16')
    expect(url).not.toContain('test-key')
    expect(init.headers['api-key']).toBe('test-key')
  })

  it('maps a 401 to a clear coded error and does not retry the provider', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401))
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'wrong-key' }),
      fetchImpl,
    })

    const first = await resolver.resolve(reference(16), 'ESV')
    const second = await resolver.resolve(reference(17), 'ESV')

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (first.ok || second.ok) return
    expect(first.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(first.error.message).toContain('rejected')
    expect(second.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    // The whole point: one wrong key must not become a request storm mid-service.
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    resolver.clearAuthFailures()
    await resolver.resolve(reference(18), 'ESV')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('maps a 429 to RATE_LIMITED and a 404 to NOT_FOUND', async () => {
    const rateLimited = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => jsonResponse({}, 429)),
    })
    const missing = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => jsonResponse({}, 404)),
    })

    const a = await rateLimited.resolve(reference(16), 'ESV')
    const b = await missing.resolve(reference(16), 'ESV')
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (a.ok || b.ok) return
    expect(a.error.code).toBe(ErrorCode.RATE_LIMITED)
    expect(b.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('treats an empty passage list as NOT_FOUND rather than empty text', async () => {
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => jsonResponse({ passages: [] })),
    })
    const result = await resolver.resolve(reference(16), 'ESV')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('bounds a request with a timeout', async () => {
    // Never settles on its own; only the resolver's abort can end it.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, rejectRequest) => {
        init.signal.addEventListener('abort', () => {
          rejectRequest(new Error('aborted'))
        })
      })

    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl,
      timeoutMs: 15,
    })

    const result = await resolver.resolve(reference(16), 'ESV')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.TIMEOUT)
    expect(resolver.inFlight).toBe(0)
  })

  it('maps a transport failure to NOT_CONNECTED', async () => {
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    const result = await resolver.resolve(reference(16), 'ESV')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
  })

  it('caps concurrent in-flight requests so a burst cannot hammer the API', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const fetchImpl = vi.fn(async () => {
      await gate
      return jsonResponse({ passages: [PLACEHOLDER_TEXT] })
    })

    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      fetchImpl,
      maxConcurrentRequests: 2,
    })

    const first = resolver.resolve(reference(16), 'ESV')
    const second = resolver.resolve(reference(17), 'ESV')
    expect(resolver.inFlight).toBe(2)

    const third = await resolver.resolve(reference(18), 'ESV')
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.error.code).toBe(ErrorCode.RATE_LIMITED)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    release()
    await Promise.all([first, second])
    expect(resolver.inFlight).toBe(0)
  })

  it('survives a public-domain store that throws', async () => {
    const throwingStore: PublicDomainStore = {
      availableCodes: () => ['WEB'],
      lookup: async () => {
        throw new Error('corrupt file')
      },
    }
    const resolver = new ScriptureResolver({
      config: config(),
      pdStore: throwingStore,
      fetchImpl: forbiddenFetch(),
    })
    const result = await resolver.resolve(reference(16), 'WEB')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCode.IO_ERROR)
  })

  it('exposes only selectable translations through the instance listing', () => {
    const resolver = new ScriptureResolver({
      config: config({ esvApiKey: 'test-key' }),
      pdStore: pdStore(['KJV', 'KRV'], PLACEHOLDER_TEXT),
      fetchImpl: forbiddenFetch(),
    })
    const listed = resolver.listTranslations()
    expect(listed.some((entry) => entry.code === 'KRV')).toBe(false)
    expect(listed.find((entry) => entry.code === 'KJV')?.kind).toBe('public-domain')
    expect(listed.find((entry) => entry.code === 'ESV')?.kind).toBe('licensed-api')
  })
})

// ---------------------------------------------------------------------------
// Small pure pieces
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('maps canonical book names to USFM ids and refuses unknown ones', () => {
    expect(usfmBookId('John')).toBe('JHN')
    expect(usfmBookId('  1 corinthians ')).toBe('1CO')
    expect(usfmBookId('Book Of Nowhere')).toBeNull()
  })

  it('builds verse, range and whole-chapter passage ids', () => {
    expect(apiBiblePassageId(reference(16))).toBe('JHN.3.16')
    expect(apiBiblePassageId({ ...reference(16), verseEnd: 18 })).toBe('JHN.3.16-JHN.3.18')
    expect(apiBiblePassageId({ ...reference(16), verse: null })).toBe('JHN.3')
    expect(apiBiblePassageId({ ...reference(16), book: 'Nowhere' })).toBeNull()
  })

  it('keys the cache per translation so two translations never collide', () => {
    expect(cacheKey('KJV', reference(16))).not.toBe(cacheKey('WEB', reference(16)))
    expect(cacheKey('kjv', reference(16))).toBe(cacheKey('KJV', reference(16)))
  })

  it('evicts the least recently used entry', () => {
    const cache = createScriptureCache(2)
    const entry = (translation: string) => ({
      reference: reference(16),
      text: PLACEHOLDER_TEXT,
      translation,
      attribution: null,
    })
    cache.set('a', entry('A'))
    cache.set('b', entry('B'))
    cache.get('a')
    cache.set('c', entry('C'))

    expect(cache.size).toBe(2)
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).not.toBeNull()
    expect(cache.get('c')).not.toBeNull()

    cache.clear()
    expect(cache.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Standing Rule 4 regression guard
// ---------------------------------------------------------------------------

/**
 * Every string literal in a source file, comments stripped.
 *
 * Deliberately a small hand-rolled scanner rather than a regex: template literals span lines, and
 * a multi-line template is precisely how pasted verse text would arrive.
 */
function stringLiterals(source: string): readonly string[] {
  const found: string[] = []
  let index = 0
  let inLineComment = false
  let inBlockComment = false

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (inLineComment) {
      if (char === '\n') inLineComment = false
      index += 1
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      const multiline = quote === '`'
      index += 1
      let buffer = ''
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          buffer += source[index + 1] ?? ''
          index += 2
          continue
        }
        if (inner === quote) {
          index += 1
          break
        }
        if (!multiline && inner === '\n') break
        buffer += inner ?? ''
        index += 1
      }
      found.push(buffer)
      continue
    }
    index += 1
  }
  return found
}

describe('Standing Rule 4', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const files = ['ScriptureResolver.ts', 'translations.ts']

  it.each(files)('%s contains no quoted string long enough to be verse text', (file) => {
    const source = readFileSync(join(here, file), 'utf8')
    const offenders = stringLiterals(source).filter((literal) => literal.length > 200)
    expect(offenders).toEqual([])
  })

  it.each(files)('%s is not a Bible: no source file ships verse data', (file) => {
    const source = readFileSync(join(here, file), 'utf8')
    // A verse-text payload would be orders of magnitude larger than a metadata catalogue. This is
    // a blunt size ceiling, and blunt is the point — it fails loudly before anyone can argue.
    expect(source.length).toBeLessThan(60_000)
  })

  it('the scanner it relies on actually finds long literals', () => {
    const sample = ['const a = `', 'x'.repeat(250), '`'].join('')
    const literals = stringLiterals(sample)
    expect(literals.some((literal) => literal.length > 200)).toBe(true)
    expect(stringLiterals("// 'not a literal'\nconst b = 'short'")).toEqual(['short'])
  })
})
