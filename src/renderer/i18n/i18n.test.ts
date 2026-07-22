/**
 * Locale-integrity and pseudo-locale tests.
 *
 * These are the assertions that `scripts/i18n-audit.mjs` cannot make from outside the type
 * system, plus the ones that have to fail a *test run* rather than a CI script — the audit
 * gates `npm run build`, but a developer running `vitest` on a locale edit should find out
 * immediately, not at package time.
 *
 * The rule this file exists to enforce is the placeholder one. A Korean string that quietly
 * drops `{{name}}` does not crash, does not warn, and does not show up in any type check: it
 * renders a lower third with the speaker's name silently missing, live, in front of a
 * congregation. There is no cheaper place to catch that than here.
 *
 * Deliberately does NOT import `./index.ts`. That module boots the i18next singleton and a
 * `localStorage` language detector as an import side effect; pulling it in would make these
 * tests order-dependent on whatever else touched the singleton first.
 */

import { createInstance } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import commonEn from './locales/en/common.json'
import commonKo from './locales/ko/common.json'
import {
  installPseudoLocale,
  isPseudoRequested,
  PSEUDO_CLOSE,
  PSEUDO_LOCALE,
  PSEUDO_OPEN,
  PSEUDO_PAD_MAX,
  PSEUDO_PAD_RATIO,
  pseudoLocalize,
  pseudoString,
} from './pseudo'
import type { ResourceTree } from './pseudo'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * CLDR plural suffixes i18next appends to a key when `{ count }` is passed.
 *
 * English needs `one` and `other`; Korean has a single plural category and correctly ships
 * only `other`. So key sets must be compared with the suffix stripped — a naive set equality
 * would demand a bogus `_one` in Korean and make the locales *worse*.
 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`)

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function flatten(node: Json, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out.set(path, value)
    else flatten(value, path, out)
  }
  return out
}

function baseKey(key: string): string {
  return key.replace(PLURAL_RE, '')
}

/** `{{name}}` and `{{count, number}}` both name the variable `name` / `count`. */
function placeholders(value: string): string[] {
  const found = new Set<string>()
  for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const raw = match[1] ?? ''
    found.add((raw.split(',')[0] ?? '').trim())
  }
  return [...found].sort()
}

const en = flatten(commonEn as unknown as Json)
const ko = flatten(commonKo as unknown as Json)

const enBases = new Set([...en.keys()].map(baseKey))
const koBases = new Set([...ko.keys()].map(baseKey))

// ---------------------------------------------------------------------------
// Locale integrity
// ---------------------------------------------------------------------------

describe('locale bundles', () => {
  it('ships a non-trivial number of keys in both locales', () => {
    // A guard against the flattener silently returning nothing and every assertion below
    // passing vacuously.
    expect(en.size).toBeGreaterThan(500)
    expect(ko.size).toBeGreaterThan(500)
  })

  it('en and ko define exactly the same keys, ignoring plural suffixes', () => {
    const onlyEn = [...enBases].filter((key) => !koBases.has(key)).sort()
    const onlyKo = [...koBases].filter((key) => !enBases.has(key)).sort()

    expect({ onlyEn, onlyKo }).toEqual({ onlyEn: [], onlyKo: [] })
  })

  it('gives every plural family an `_other` form in both locales', () => {
    // `_other` is the one plural category every language has. A family missing it falls back
    // to the raw key string on screen the first time a count lands outside `_one`.
    const families = new Set<string>()
    for (const key of [...en.keys(), ...ko.keys()]) {
      if (PLURAL_RE.test(key)) families.add(baseKey(key))
    }

    const gaps: string[] = []
    for (const family of [...families].sort()) {
      if (!en.has(`${family}_other`)) gaps.push(`en:${family}_other`)
      if (!ko.has(`${family}_other`)) gaps.push(`ko:${family}_other`)
    }

    expect(gaps).toEqual([])
  })

  it('has no empty or whitespace-only values', () => {
    const empty: string[] = []
    for (const [locale, table] of [
      ['en', en],
      ['ko', ko],
    ] as const) {
      for (const [key, value] of table) {
        if (value.trim() === '') empty.push(`${locale}:${key}`)
      }
    }

    expect(empty).toEqual([])
  })

  it('uses the same interpolation placeholders in ko as in en, for every shared key', () => {
    // The load-bearing test. A dropped `{{name}}` in ko means a lower third goes out with the
    // speaker's name missing and nothing anywhere reports a fault.
    const mismatches: string[] = []
    for (const [key, value] of en) {
      const korean = ko.get(key)
      if (korean === undefined) continue
      const expected = placeholders(value)
      const actual = placeholders(korean)
      if (expected.join('|') !== actual.join('|')) {
        mismatches.push(`${key}: en=[${expected.join(', ')}] ko=[${actual.join(', ')}]`)
      }
    }

    expect(mismatches).toEqual([])
  })

  it('never leaves a lone `{` or `}` that would render as literal brace soup', () => {
    // `{{name}` and `{name}}` are the two typos i18next does not report; it just prints them.
    // `{date}` is exempt: the YouTube title template documents it as a literal the operator
    // types, and it is meant to survive to the screen verbatim.
    const suspect: string[] = []
    for (const [locale, table] of [
      ['en', en],
      ['ko', ko],
    ] as const) {
      for (const [key, value] of table) {
        const stripped = value.replace(/\{\{[^}]*\}\}/g, '').replace(/\{date\}/g, '')
        if (stripped.includes('{') || stripped.includes('}')) suspect.push(`${locale}:${key}`)
      }
    }

    expect(suspect).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Pseudo-locale transform
// ---------------------------------------------------------------------------

describe('pseudoString', () => {
  it('brackets, accents and pads a plain string', () => {
    const out = pseudoString('Camera setup')

    expect(out.startsWith(PSEUDO_OPEN)).toBe(true)
    expect(out.endsWith(PSEUDO_CLOSE)).toBe(true)
    expect(out).toContain('Çáɱéŕá')
    // The ASCII original must not survive verbatim, or the transform proves nothing.
    expect(out).not.toContain('Camera setup')
  })

  it('lengthens by roughly the pad ratio', () => {
    const source = 'Start listening'
    const out = pseudoString(source)

    // 14 non-whitespace characters -> round(14 * 0.3) = 4 pad characters.
    const visible = source.replace(/\s/g, '').length
    const expectedPad = Math.min(PSEUDO_PAD_MAX, Math.max(1, Math.round(visible * PSEUDO_PAD_RATIO)))

    expect(out).toContain('·'.repeat(expectedPad))
    expect(out).not.toContain('·'.repeat(expectedPad + 1))
    expect(out.length).toBeGreaterThan(source.length)
  })

  it('caps the padding so a long paragraph is not buried in filler', () => {
    const out = pseudoString('word '.repeat(200))

    expect(out).toContain('·'.repeat(PSEUDO_PAD_MAX))
    expect(out).not.toContain('·'.repeat(PSEUDO_PAD_MAX + 1))
  })

  it('preserves {{interpolation}} tokens byte-for-byte', () => {
    const out = pseudoString('{{subsystem}}: {{state}}')

    expect(out).toContain('{{subsystem}}')
    expect(out).toContain('{{state}}')
    expect(placeholders(out)).toEqual(['state', 'subsystem'])
  })

  it('preserves $t() nesting tokens byte-for-byte', () => {
    const out = pseudoString('See $t(actions.retry) below')

    expect(out).toContain('$t(actions.retry)')
  })

  it('still lengthens a string that is nothing but a placeholder', () => {
    const out = pseudoString('{{total}}')

    expect(out).toContain('{{total}}')
    expect(out.length).toBeGreaterThan('{{total}}'.length)
  })

  it('leaves an empty string empty rather than inventing filler', () => {
    expect(pseudoString('')).toBe('')
  })

  it('leaves Korean text unaccented but still brackets and pads it', () => {
    // Nothing renders the pseudo bundle from ko today, but the transform must not corrupt
    // non-Latin script if it ever does.
    const out = pseudoString('카메라 설정')

    expect(out).toContain('카메라 설정')
    expect(out.startsWith(PSEUDO_OPEN)).toBe(true)
  })
})

describe('pseudoLocalize', () => {
  it('transforms every string leaf and preserves structure and non-string leaves', () => {
    const tree = { a: 'One', b: { c: 'Two', d: 4, e: true, f: null }, g: ['Three', 5] }
    const out = pseudoLocalize(tree) as Record<string, Json>

    expect(out['a']).toBe(pseudoString('One'))
    expect((out['b'] as Record<string, Json>)['c']).toBe(pseudoString('Two'))
    expect((out['b'] as Record<string, Json>)['d']).toBe(4)
    expect((out['b'] as Record<string, Json>)['e']).toBe(true)
    expect((out['b'] as Record<string, Json>)['f']).toBeNull()
    expect(out['g']).toEqual([pseudoString('Three'), 5])
  })

  it('does not mutate the source bundle', () => {
    const before = JSON.stringify(commonEn)
    pseudoLocalize(commonEn as unknown as ResourceTree)

    expect(JSON.stringify(commonEn)).toBe(before)
  })

  it('lengthens every string in the real English bundle without losing a placeholder', () => {
    const pseudo = flatten(pseudoLocalize(commonEn as unknown as ResourceTree) as Json)
    const problems: string[] = []

    for (const [key, source] of en) {
      const transformed = pseudo.get(key)
      if (transformed === undefined) {
        problems.push(`${key}: missing from the pseudo bundle`)
        continue
      }
      if (transformed.length <= source.length) problems.push(`${key}: not lengthened`)
      const expected = placeholders(source).join('|')
      const actual = placeholders(transformed).join('|')
      if (expected !== actual) problems.push(`${key}: placeholders [${expected}] -> [${actual}]`)
    }

    expect(problems).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('isPseudoRequested', () => {
  it('is false by default under a normal test/dev run', () => {
    expect(isPseudoRequested()).toBe(false)
  })

  it('is true when VITE_PSEUDO_LOCALE=1', () => {
    vi.stubEnv('VITE_PSEUDO_LOCALE', '1')
    try {
      expect(isPseudoRequested()).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is true for ?pseudo=1 in a dev build', () => {
    const original = window.location.search
    window.history.replaceState({}, '', '?pseudo=1')
    try {
      // Vitest runs with import.meta.env.DEV === true, which is the gate the query obeys.
      expect(isPseudoRequested()).toBe(true)
    } finally {
      window.history.replaceState({}, '', original === '' ? '/' : original)
    }
  })
})

describe('installPseudoLocale', () => {
  it('registers en-XA on a live i18next instance and switches to it', async () => {
    const instance = createInstance()
    await instance.init({
      resources: { en: { common: commonEn } },
      ns: ['common'],
      defaultNS: 'common',
      lng: 'en',
      fallbackLng: 'en',
      // Mirrors `index.ts`: PSEUDO_LOCALE is absent on purpose, so this exercises the
      // supportedLngs widening rather than assuming it away.
      supportedLngs: ['en', 'ko'],
      interpolation: { escapeValue: false },
      returnNull: false,
    })

    expect(instance.t('app.tagline')).toBe('Live service control')

    const installed = await installPseudoLocale(instance, commonEn as unknown as ResourceTree, 'common')

    expect(installed).toBe(true)
    expect(instance.resolvedLanguage).toBe(PSEUDO_LOCALE)

    const tagline = instance.t('app.tagline')
    expect(tagline.startsWith(PSEUDO_OPEN)).toBe(true)
    expect(tagline.endsWith(PSEUDO_CLOSE)).toBe(true)
    expect(tagline).not.toContain('Live service control')
  })

  it('keeps interpolation working under the pseudo locale', async () => {
    const instance = createInstance()
    await instance.init({
      resources: { en: { common: commonEn } },
      ns: ['common'],
      defaultNS: 'common',
      lng: 'en',
      fallbackLng: 'en',
      supportedLngs: ['en', 'ko'],
      interpolation: { escapeValue: false },
      returnNull: false,
    })
    await installPseudoLocale(instance, commonEn as unknown as ResourceTree, 'common')

    // If the transform had mangled `{{subsystem}}` / `{{state}}`, these would come back as
    // literal braces instead of values — which is exactly the bug a pseudo run must not hide.
    const out = instance.t('status.shortLabel', { subsystem: 'OBS', state: 'Connected' })

    expect(out).toContain('OBS')
    expect(out).toContain('Connected')
    expect(out).not.toContain('{{')
  })

  it('reports false instead of throwing when the instance rejects the bundle', async () => {
    const broken = {
      options: { supportedLngs: ['en'] as string[] },
      addResourceBundle() {
        throw new Error('resource store is closed')
      },
      changeLanguage: async () => undefined,
    }

    await expect(
      installPseudoLocale(broken, commonEn as unknown as ResourceTree, 'common'),
    ).resolves.toBe(false)
  })
})
