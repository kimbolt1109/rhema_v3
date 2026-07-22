/**
 * The Bible translation catalogue — what Verger is allowed to resolve verse text against.
 *
 * ## Standing Rule 4 governs this file
 *
 * **There is no verse text here, and there never may be.** This module holds *metadata only*:
 * a code, a name, a licence, an attribution string and a pinned HTTPS source URL. Text arrives at
 * runtime, either from a public-domain file the operator downloaded from the pinned URL or from a
 * licensed API called with the operator's own key. Nothing is bundled.
 *
 * The shape is modelled on the prior project's curated catalogue
 * (`C:\ClaudeFlow\projects\rhema\resources\bibles\catalog.json`), which is explicit that
 * "copyrighted modern translations (ESV/NIV/etc.) are NEVER listed here — they stay API-only".
 * That separation is preserved: {@link TranslationProvider} `'public-domain'` entries carry a
 * download URL, licensed entries carry none and are unusable without a key.
 *
 * ## The quarantine rule
 *
 * `docs/v2-notes/LEGAL_AND_CONTENT.md` §3 records the one seed that forced this process into
 * existence: the Korean 개역한글 1961 ("KRV"), whose public-domain status **in Korea is contested**
 * and which is under owner legal review. The v2 mechanism — an exclusion list checked at load
 * time, the file kept on disk, the translation picker no longer offering it, and a standing
 * regression test asserting it never appears in the loaded set — is reproduced here as
 * {@link LEGAL_HOLD_TRANSLATION_CODES} plus the filter inside {@link listTranslations}.
 *
 * Two properties matter and are tested:
 *
 *  1. the quarantined entry stays in {@link TRANSLATION_CATALOGUE} (auditable, re-enableable
 *     later without re-shipping data) with `verified: false`; and
 *  2. it is **never** returned by {@link listTranslations}, which is what the picker and the
 *     resolver both consume — so the gate holds at the data layer, not only in the UI.
 *
 * Node-global free by construction (it is pure data plus pure functions), though it lives under
 * `src/main` because only the main process resolves scripture.
 */

import type { ScriptureSourceKind, TranslationSource } from '@shared/scripture'

// ---------------------------------------------------------------------------
// Catalogue shape
// ---------------------------------------------------------------------------

/** Where a translation's text can come from. */
export type TranslationProvider =
  /** A verified public-domain file, downloaded on demand from the pinned {@link TranslationCatalogueEntry.sourceUrl}. */
  | 'public-domain'
  /** Crossway's ESV API, called with the operator's own `ESV_API_KEY`. */
  | 'esv'
  /** API.Bible, called with the operator's own `API_BIBLE_KEY` and their chosen bible id. */
  | 'api-bible'

/** Parser the downloader/PD store needs for a public-domain file. `null` for API-served entries. */
export type PublicDomainFormat = 'getbible-json' | 'bsb-tsv'

/**
 * One catalogue row. Metadata only — see the module docblock.
 */
export interface TranslationCatalogueEntry {
  /** Stable selection key, e.g. `KJV`. Matches `CueEngineSettings.translation`. */
  readonly code: string
  readonly name: string
  /** BCP-47-ish language tag. */
  readonly language: string
  readonly textDirection: 'ltr' | 'rtl'
  /** Licence, verbatim as recorded during verification. */
  readonly license: string
  /** The citation establishing that licence. `docs/v2-notes/LEGAL_AND_CONTENT.md` §2 step 3:
   *  "a vague 'believed to be public domain' is not a citation". */
  readonly licenseUrl: string | null
  /** Rendered on the overlay whenever present; required by most licences. */
  readonly attribution: string | null
  /**
   * Providers to try, **in preference order**.
   *
   * A local public-domain file always precedes a network call: it is faster, it costs nothing,
   * and — the reason that actually matters — it still works when the building's internet drops
   * ninety seconds into the sermon.
   */
  readonly providers: readonly TranslationProvider[]
  /** Pinned HTTPS download URL for a public-domain file; `null` for API-served entries. */
  readonly sourceUrl: string | null
  readonly format: PublicDomainFormat | null
  /**
   * False while public-domain status is unconfirmed.
   *
   * An unverified translation is **never selectable** — see {@link listTranslations}.
   */
  readonly verified: boolean
  /** Why the entry is quarantined, when it is. `null` for cleared entries. */
  readonly legalHold: string | null
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

/**
 * Translations excluded from selection pending owner legal review.
 *
 * Mirrors v2's `LEGAL_HOLD_SEED_FILES` (`docs/v2-notes/LEGAL_AND_CONTENT.md` §3). The entry stays
 * in {@link TRANSLATION_CATALOGUE} so the decision is auditable and reversible; this list is what
 * keeps it out of every consumer. Tracked in `HUMAN_TASKS.md`.
 */
export const LEGAL_HOLD_TRANSLATION_CODES: readonly string[] = ['KRV']

/**
 * Hosts a public-domain file may be downloaded from.
 *
 * An SSRF allow-list, carried over from the prior catalogue's importer notes. A catalogue is data;
 * data can be edited; an edited `sourceUrl` must not be able to make the app fetch an arbitrary
 * host. {@link isAllowedSourceUrl} is the check.
 */
export const PD_SOURCE_HOSTS: readonly string[] = [
  'api.getbible.net',
  'bereanbible.com',
  'ebible.org',
]

/** Whether a URL is an HTTPS URL on a pinned {@link PD_SOURCE_HOSTS} host. Never throws. */
export function isAllowedSourceUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return PD_SOURCE_HOSTS.includes(parsed.hostname)
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every translation Verger knows about, verified or not.
 *
 * Public-domain rows are transcribed from the prior project's verified catalogue; the licensed
 * rows are API-only by design and carry no `sourceUrl`, because Verger must never sit in the
 * distribution chain for copyrighted verse text (`docs/v2-notes/LEGAL_AND_CONTENT.md` §4).
 *
 * Consumers should use {@link listTranslations}, not this constant — it deliberately still
 * contains the quarantined row.
 */
export const TRANSLATION_CATALOGUE: readonly TranslationCatalogueEntry[] = [
  {
    code: 'KJV',
    name: 'King James Version',
    language: 'en',
    textDirection: 'ltr',
    license: 'Public Domain',
    licenseUrl: 'https://en.wikipedia.org/wiki/King_James_Version#Copyright_status',
    attribution: 'King James Version (Public Domain)',
    // Also served by API.Bible, so a church with a key but no downloaded file yet is not
    // stranded — but only once the operator has mapped KJV to a bible id. The local file wins
    // whenever it exists.
    providers: ['public-domain', 'api-bible'],
    sourceUrl: 'https://api.getbible.net/v2/kjv.json',
    format: 'getbible-json',
    verified: true,
    legalHold: null,
  },
  {
    code: 'ASV',
    name: 'American Standard Version',
    language: 'en',
    textDirection: 'ltr',
    license: 'Public Domain',
    licenseUrl: 'https://en.wikipedia.org/wiki/American_Standard_Version#Copyright_status',
    attribution: 'American Standard Version (Public Domain)',
    providers: ['public-domain'],
    sourceUrl: 'https://api.getbible.net/v2/asv.json',
    format: 'getbible-json',
    verified: true,
    legalHold: null,
  },
  {
    code: 'WEB',
    name: 'World English Bible',
    language: 'en',
    textDirection: 'ltr',
    license: 'Public Domain',
    licenseUrl: 'https://worldenglish.bible/',
    attribution: 'World English Bible (Public Domain)',
    providers: ['public-domain'],
    sourceUrl: 'https://api.getbible.net/v2/web.json',
    format: 'getbible-json',
    verified: true,
    legalHold: null,
  },
  {
    code: 'BSB',
    name: 'Berean Standard Bible',
    language: 'en',
    textDirection: 'ltr',
    license: 'CC0 1.0 (Public Domain Dedication)',
    licenseUrl: 'https://berean.bible/licensing.htm',
    attribution: 'Berean Standard Bible (BSB) — public domain, BereanBible.com',
    providers: ['public-domain'],
    sourceUrl: 'https://bereanbible.com/bsb.txt',
    format: 'bsb-tsv',
    verified: true,
    legalHold: null,
  },
  {
    code: 'RV1909',
    name: 'Reina-Valera 1909',
    language: 'es',
    textDirection: 'ltr',
    license: 'Public Domain',
    licenseUrl: 'https://es.wikipedia.org/wiki/Reina-Valera',
    attribution: 'Reina-Valera 1909 (Dominio Público)',
    providers: ['public-domain'],
    sourceUrl: 'https://api.getbible.net/v2/valera.json',
    format: 'getbible-json',
    verified: true,
    legalHold: null,
  },
  {
    code: 'LUTHER1545',
    name: 'Lutherbibel 1545',
    language: 'de',
    textDirection: 'ltr',
    license: 'Public Domain',
    licenseUrl: 'https://de.wikipedia.org/wiki/Lutherbibel',
    attribution: 'Lutherbibel 1545 (Gemeinfrei)',
    providers: ['public-domain'],
    sourceUrl: 'https://api.getbible.net/v2/luther1545.json',
    format: 'getbible-json',
    verified: true,
    legalHold: null,
  },
  {
    // QUARANTINED — do not clear this row without a signed-off verification.
    //
    // `docs/v2-notes/LEGAL_AND_CONTENT.md` §3: the Korean 개역한글 1961 seed was added in the prior
    // project without the per-language public-domain verification process, and its PD status in
    // Korea is contested. It remains under owner legal review (HUMAN_TASKS.md). The row is kept so
    // the exclusion is visible and reversible; `verified: false` is what actually gates it.
    code: 'KRV',
    name: '개역한글 (Korean Revised Version, 1961)',
    language: 'ko',
    textDirection: 'ltr',
    license: 'Contested — public-domain status in Korea unconfirmed',
    licenseUrl: null,
    attribution: null,
    providers: [],
    sourceUrl: null,
    format: null,
    verified: false,
    legalHold:
      'Public-domain status contested in Korea; awaiting owner legal review. See ' +
      'docs/v2-notes/LEGAL_AND_CONTENT.md section 3 and HUMAN_TASKS.md.',
  },
  {
    code: 'ESV',
    name: 'English Standard Version',
    language: 'en',
    textDirection: 'ltr',
    license: 'Copyright © Crossway — fetched live under the operator’s own ESV API licence',
    licenseUrl: 'https://api.esv.org/',
    // Metadata only. The exact publisher-required notice must be confirmed against Crossway's
    // API terms before public distribution — tracked in HUMAN_TASKS.md, not invented here.
    attribution: 'English Standard Version (ESV), Crossway',
    providers: ['esv'],
    sourceUrl: null,
    format: null,
    verified: true,
    legalHold: null,
  },
  {
    // A deliberately generic row for whichever translation the operator maps this code to on
    // API.Bible. It names no publisher and invents no bible id; the attribution the API returns
    // on the response is what the overlay renders.
    code: 'API_BIBLE',
    name: 'API.Bible (operator-configured translation)',
    language: 'und',
    textDirection: 'ltr',
    license: 'Per the selected translation’s publisher; fetched live under the operator’s own key',
    licenseUrl: 'https://scripture.api.bible/',
    attribution: null,
    providers: ['api-bible'],
    sourceUrl: null,
    format: null,
    verified: true,
    legalHold: null,
  },
]

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** What the caller knows about this machine's configuration. Everything defaults to "no". */
export interface TranslationAvailability {
  /** `ESV_API_KEY` is present and non-empty. */
  readonly esvKeyConfigured?: boolean
  /** `API_BIBLE_KEY` is present and non-empty. */
  readonly apiBibleKeyConfigured?: boolean
  /**
   * Catalogue codes the operator has mapped to an API.Bible bible id.
   *
   * Per-code rather than a single id on purpose. API.Bible serves hundreds of translations behind
   * one key; a single global id would mean a request for `KJV` could be answered with whatever
   * that id happens to be. A translation swap nobody in the room can detect is exactly the class
   * of failure this module exists to prevent, so a code is only API-servable once the operator has
   * said which bible id *is* that translation.
   */
  readonly apiBibleCodes?: readonly string[]
  /** Codes whose public-domain file is downloaded and readable on this machine. */
  readonly downloadedCodes?: readonly string[]
}

/**
 * Whether a catalogue row is offerable at all.
 *
 * The quarantine gate, in one place. Both {@link listTranslations} and the resolver go through
 * it, so a translation cannot be reached by asking for it directly either.
 */
export function isSelectable(entry: TranslationCatalogueEntry): boolean {
  if (!entry.verified) return false
  if (LEGAL_HOLD_TRANSLATION_CODES.includes(entry.code)) return false
  return entry.providers.length > 0
}

/**
 * Which provider (if any) could serve this entry right now, in preference order.
 *
 * Empty means "listed, but nothing on this machine can supply it yet" — a normal resting state
 * on a fresh install, not a failure.
 */
export function usableProviders(
  entry: TranslationCatalogueEntry,
  availability: TranslationAvailability = {},
): readonly TranslationProvider[] {
  if (!isSelectable(entry)) return []
  const downloaded = availability.downloadedCodes ?? []
  return entry.providers.filter((provider) => {
    if (provider === 'public-domain') return downloaded.includes(entry.code)
    if (provider === 'esv') return availability.esvKeyConfigured === true
    const mapped = availability.apiBibleCodes ?? []
    return availability.apiBibleKeyConfigured === true && mapped.includes(entry.code)
  })
}

/** The {@link ScriptureSourceKind} the UI should show for an entry, given availability. */
export function sourceKindFor(
  entry: TranslationCatalogueEntry,
  availability: TranslationAvailability = {},
): ScriptureSourceKind {
  const usable = usableProviders(entry, availability)
  const first = usable[0]
  if (first === undefined) return 'unavailable'
  return first === 'public-domain' ? 'public-domain' : 'licensed-api'
}

/** Project a catalogue row down to the IPC-safe {@link TranslationSource}. */
export function toTranslationSource(
  entry: TranslationCatalogueEntry,
  availability: TranslationAvailability = {},
): TranslationSource {
  return {
    code: entry.code,
    name: entry.name,
    language: entry.language,
    kind: sourceKindFor(entry, availability),
    license: entry.license,
    attribution: entry.attribution,
    verified: entry.verified,
  }
}

/**
 * The translations the operator may select, with each one's current availability.
 *
 * This is what the picker renders and what the resolver validates against. A quarantined or
 * otherwise unverified translation is **absent**, not greyed out — v2's lesson is that a
 * translation must be excluded at the data layer, because a renderer-side filter is one bug away
 * from being bypassed.
 *
 * Entries whose key is unconfigured or whose public-domain file has not been downloaded are still
 * listed, with `kind: 'unavailable'`, so the UI can say *why* nothing resolves rather than
 * presenting an empty list on a fresh install.
 */
export function listTranslations(
  availability: TranslationAvailability = {},
): readonly TranslationSource[] {
  return TRANSLATION_CATALOGUE.filter(isSelectable).map((entry) =>
    toTranslationSource(entry, availability),
  )
}

/**
 * Every row including the quarantined ones, for audit screens and the legal tracker.
 *
 * Deliberately a separate, awkwardly-named function: nothing that drives resolution or the picker
 * should be able to reach a quarantined translation by accident.
 */
export function listTranslationsIncludingQuarantined(
  availability: TranslationAvailability = {},
): readonly TranslationSource[] {
  return TRANSLATION_CATALOGUE.map((entry) => toTranslationSource(entry, availability))
}

/** The catalogue row for a code, quarantine ignored. Use {@link findSelectableEntry} to resolve. */
export function findCatalogueEntry(code: string): TranslationCatalogueEntry | null {
  const wanted = code.trim().toUpperCase()
  return TRANSLATION_CATALOGUE.find((entry) => entry.code.toUpperCase() === wanted) ?? null
}

/** The catalogue row for a code, or `null` when it is unknown **or not selectable**. */
export function findSelectableEntry(code: string): TranslationCatalogueEntry | null {
  const entry = findCatalogueEntry(code)
  if (entry === null) return null
  return isSelectable(entry) ? entry : null
}

/** Pinned download URL for a public-domain translation, or `null`. Host-checked. */
export function publicDomainSourceUrl(code: string): string | null {
  const entry = findSelectableEntry(code)
  if (entry === null || entry.sourceUrl === null) return null
  return isAllowedSourceUrl(entry.sourceUrl) ? entry.sourceUrl : null
}
