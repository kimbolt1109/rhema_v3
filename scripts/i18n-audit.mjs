#!/usr/bin/env node
/**
 * i18n audit — Verger.
 *
 * A dependency-free Node script that answers four questions about the operator-UI locales:
 *
 *   1. MISSING     — a key a component asks `t()` for that no locale defines.
 *   2. UNUSED      — a key a locale defines that nothing in `src/renderer` ever asks for.
 *   3. DIVERGENT   — a key present in `en` but not `ko`, or vice versa.
 *   4. HARDCODED?  — a JSX text node of two or more words that never went through `t()`.
 *
 * Only (1) and (3) are build-breaking. (2) and (4) are heuristics and are reported, never
 * enforced: a genuinely un-referenced key is cheap, and the hardcoded-string heuristic
 * cannot tell a sentence from a class name with total confidence.
 *
 * Why a hand-rolled scanner rather than `i18next-parser`:
 *   - No new dependency for a check that has to run in CI on a machine that may be offline.
 *   - Verger's real call sites are not all `t('literal')`. Three other shapes exist in this
 *     tree and a naive extractor silently reports every one of them as an unused key:
 *       a) `t(\`health.subsystem.${id}\`)`      — dynamic suffix on a literal prefix
 *       b) `{ labelKey: 'app.section.plan' }`   — the key stored on a module-level constant
 *       c) `t(elapsed.key)`                     — the key computed elsewhere entirely
 *     (a) is resolved by prefix. (b) is resolved by matching `*Key` properties. (c) cannot be
 *     resolved from the call site at all, so the scanner also collects every bare dot-path
 *     string literal in the renderer and treats those as *weak* references — enough to keep a
 *     legitimately-used key off the UNUSED list, but never enough to claim a key is MISSING.
 *
 * Plural handling: i18next appends a CLDR suffix (`_one`, `_other`, …) to plural keys. English
 * needs `one` + `other`; Korean has a single plural category and needs only `other`. So a bare
 * `_one` in `en` with no `_one` in `ko` is CORRECT, not divergence. All three checks therefore
 * compare *base* keys with the suffix stripped, and a separate check asserts every plural
 * family has an `_other` form in both locales — the one form no locale may omit.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs            # human-readable report
 *   node scripts/i18n-audit.mjs --json     # machine-readable, for a CI annotation
 *   node scripts/i18n-audit.mjs --quiet    # counts + failures only
 *
 * Exit code: 1 if any key is MISSING or the locales are structurally DIVERGENT, else 0.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const RENDERER_DIR = join(ROOT, 'src', 'renderer')
const LOCALES_DIR = join(RENDERER_DIR, 'i18n', 'locales')

/** The locales that must stay in lockstep. Order matters only for report readability. */
const LOCALES = ['en', 'ko']

/** The single i18next namespace Verger uses. One file per locale. */
const NAMESPACE = 'common'

/**
 * CLDR plural suffixes i18next appends. `_other` is the only one every language has, which is
 * why it is the only one this script insists on.
 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`)

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const quiet = args.has('--quiet')

// ---------------------------------------------------------------------------
// Locale files
// ---------------------------------------------------------------------------

/** Flatten a nested resource tree into `a.b.c` -> string. Non-string leaves are an error. */
function flatten(node, prefix, out, problems) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out, problems)
    } else if (typeof value === 'string') {
      out.set(path, value)
    } else {
      problems.push(`${path} is a ${Array.isArray(value) ? 'array' : typeof value}, not a string`)
    }
  }
  return out
}

function loadLocale(code) {
  const file = join(LOCALES_DIR, code, `${NAMESPACE}.json`)
  const problems = []
  const tree = JSON.parse(readFileSync(file, 'utf8'))
  const flat = flatten(tree, '', new Map(), problems)
  return { code, file, flat, problems }
}

/** `status.attempt_one` -> `status.attempt`. Everything else is returned unchanged. */
function baseKey(key) {
  return key.replace(PLURAL_RE, '')
}

/** The `{{name}}` placeholders in a string, deduplicated and sorted. */
function placeholders(value) {
  const found = new Set()
  for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    // `{{count, number}}` and `{{name, uppercase}}` name the same variable as `{{count}}`.
    found.add(match[1].split(',')[0].trim())
  }
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(tsx?|jsx?)$/
const IS_TEST = /\.test\.(tsx?|jsx?)$/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue
      walk(full, out)
    } else if (SOURCE_EXT.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Strip `//` line comments and `/* *\/` block comments so commented-out JSX does not show up
 * as a hardcoded string. Deliberately naive — it does not understand strings containing `//`,
 * which for this heuristic costs nothing.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** A key-looking dot path: two or more dot-separated identifier-ish segments. */
const KEY_PATH_RE = /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9_-]+)+$/

/**
 * What a `t()` argument has to look like before it is believed.
 *
 * Without this, `segment.startsWith('$t(')` in `src/renderer/i18n/pseudo.ts` reads as a call to
 * `t` with the key `)`, and the whole audit reports 38 phantom missing keys. Keys in this repo
 * are dot paths of identifier segments and nothing else, so anything containing a space, a
 * bracket or a newline is a false positive rather than a key.
 */
const KEY_SHAPE_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/

const scan = {
  /** Keys we are confident are passed to `t()` / `i18nKey` / a `*Key` property. */
  strong: new Map(), // key -> Set<"file:line">
  /** Literal prefixes of dynamic keys: `t(`health.subsystem.${id}`)` -> `health.subsystem.` */
  prefixes: new Map(), // prefix -> Set<"file:line">
  /** Dot-paths seen as plain string literals anywhere. Enough to excuse a key from UNUSED. */
  weak: new Set(),
  /** `t(someVariable)` — unresolvable from the call site. Counted so the report stays honest. */
  unresolvable: [],
  /** Suspected un-extracted UI text. */
  hardcoded: [],
}

function note(map, key, where) {
  const existing = map.get(key)
  if (existing) existing.add(where)
  else map.set(key, new Set([where]))
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1
  return line
}

function scanFile(file) {
  const raw = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).split(sep).join('/')
  const code = stripComments(raw)
  const isTest = IS_TEST.test(file)

  // --- t('literal') and the local text('literal', fallback) wrapper -------------------------
  // `text(key, fallback)` is a house wrapper around `t` (see `ShortcutSettings.tsx`) used by a
  // slice that shipped ahead of its locale entries. It is a real call site and has to be audited
  // as one — otherwise a whole screen is invisible to this script precisely because it is the
  // screen that is still un-translated.
  for (const m of code.matchAll(/\b(?:t|text)\(\s*(['"`])([^'"`$\\\n]+)\1/g)) {
    if (!KEY_SHAPE_RE.test(m[2])) continue
    note(scan.strong, m[2], `${rel}:${lineOf(code, m.index)}`)
  }

  // --- t(`literal.prefix.${expr}`) ----------------------------------------------------------
  for (const m of code.matchAll(/\b(?:t|text)\(\s*`([^`$\n]*)\$\{/g)) {
    const prefix = m[1]
    // A key that *starts* with an expression cannot be attributed to anything. Recording it
    // would mark the entire locale as used, so drop it and say so.
    if (prefix === '') {
      scan.unresolvable.push(`${rel}:${lineOf(code, m.index)} (template starts with an expression)`)
      continue
    }
    note(scan.prefixes, prefix, `${rel}:${lineOf(code, m.index)}`)
  }

  // --- <Trans i18nKey="..."> ----------------------------------------------------------------
  for (const m of code.matchAll(/\bi18nKey\s*=\s*["']([^"'\n]+)["']/g)) {
    if (!KEY_SHAPE_RE.test(m[1])) continue
    note(scan.strong, m[1], `${rel}:${lineOf(code, m.index)}`)
  }

  // --- the house `labelKey` / `titleKey` convention ------------------------------------------
  for (const m of code.matchAll(/\b[a-zA-Z]*Key\s*[:=]\s*["'`]([^"'`\n]+)["'`]/g)) {
    if (KEY_PATH_RE.test(m[1])) note(scan.strong, m[1], `${rel}:${lineOf(code, m.index)}`)
  }

  // --- t(identifier) — cannot be resolved here ----------------------------------------------
  for (const m of code.matchAll(/\b(?:t|text)\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*[,)]/g)) {
    scan.unresolvable.push(`${rel}:${lineOf(code, m.index)} (t(${m[1]}))`)
  }

  // --- weak references: any dot-path string literal ------------------------------------------
  for (const m of code.matchAll(/["'`]([a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9_-]+)+)["'`]/g)) {
    scan.weak.add(m[1])
  }

  // --- hardcoded-string heuristic (report only) ---------------------------------------------
  // Test files are excluded: assertions legitimately contain English prose.
  if (!isTest && file.endsWith('.tsx')) {
    // The lookbehind keeps a `>` that closes a JSX tag and rejects a `>` used as
    // greater-than: `{slidesTotal > 0 ? …}` has a space before the operator, whereas a tag
    // always closes on a quote, an identifier character, a `}` or a self-closing `/`.
    for (const m of code.matchAll(/(?<=["'\w}\/])>\s*([^<>{}\n]{4,}?)\s*</g)) {
      const text = m[1].trim()
      if (!looksLikeProse(text)) continue
      scan.hardcoded.push({ file: rel, line: lineOf(code, m.index), text })
    }
  }
}

/** Two or more words, each with a letter, and not obviously code/punctuation/an entity. */
function looksLikeProse(text) {
  if (!/[A-Za-z가-힣]/.test(text)) return false
  if (text.startsWith('&')) return false
  // Operators and bracket noise mean this is an expression the regex clipped, not prose.
  if (/[()[\]=;`$]|\?|&&|\|\||:\s|=>|:\/\//.test(text)) return false
  const words = text.split(/\s+/).filter((w) => /[A-Za-z가-힣]/.test(w))
  return words.length >= 2
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const locales = LOCALES.map(loadLocale)
const byCode = new Map(locales.map((l) => [l.code, l]))

for (const file of walk(RENDERER_DIR)) scanFile(file)

/** Union of every base key defined by any locale. */
const definedBases = new Set()
for (const locale of locales) for (const key of locale.flat.keys()) definedBases.add(baseKey(key))

/** A key is "defined" in a locale if it, or any plural form of it, is present. */
function definedIn(locale, base) {
  if (locale.flat.has(base)) return true
  return PLURAL_SUFFIXES.some((suffix) => locale.flat.has(`${base}_${suffix}`))
}

// --- 1. missing --------------------------------------------------------------------------
const missing = []
for (const [key, sites] of scan.strong) {
  const base = baseKey(key)
  const absentFrom = locales.filter((l) => !definedIn(l, base)).map((l) => l.code)
  if (absentFrom.length > 0) missing.push({ key, absentFrom, sites: [...sites].sort() })
}

/** Dynamic prefixes that match nothing at all — an entire key family that was never authored. */
const emptyPrefixes = []
for (const [prefix, sites] of scan.prefixes) {
  const any = [...definedBases].some((k) => k.startsWith(prefix))
  if (!any) emptyPrefixes.push({ prefix, sites: [...sites].sort() })
}

// --- 2. unused ---------------------------------------------------------------------------
const strongBases = new Set([...scan.strong.keys()].map(baseKey))
const weakBases = new Set([...scan.weak].map(baseKey))
const prefixList = [...scan.prefixes.keys()]

const unused = []
for (const base of [...definedBases].sort()) {
  if (strongBases.has(base) || weakBases.has(base)) continue
  if (prefixList.some((p) => base.startsWith(p))) continue
  unused.push(base)
}

// --- 3. divergence -----------------------------------------------------------------------
const divergent = []
for (const base of [...definedBases].sort()) {
  const present = locales.filter((l) => definedIn(l, base)).map((l) => l.code)
  if (present.length !== locales.length) {
    divergent.push({ key: base, present, absent: LOCALES.filter((c) => !present.includes(c)) })
  }
}

/** Every plural family needs an `_other` in both locales — no language may omit that form. */
const pluralGaps = []
for (const base of [...definedBases].sort()) {
  const isPlural = locales.some((l) =>
    PLURAL_SUFFIXES.some((s) => l.flat.has(`${base}_${s}`)),
  )
  if (!isPlural) continue
  for (const locale of locales) {
    if (!locale.flat.has(`${base}_other`)) {
      pluralGaps.push({ key: `${base}_other`, locale: locale.code })
    }
  }
}

// --- extra structural checks --------------------------------------------------------------
const empties = []
const placeholderMismatches = []
const reference = byCode.get(LOCALES[0])
for (const locale of locales) {
  for (const [key, value] of locale.flat) {
    if (value.trim() === '') empties.push({ key, locale: locale.code })
  }
  for (const problem of locale.problems) empties.push({ key: problem, locale: locale.code })
}
for (const [key, value] of reference.flat) {
  const expected = placeholders(value)
  for (const locale of locales) {
    if (locale.code === reference.code) continue
    const other = locale.flat.get(key)
    if (other === undefined) continue
    const actual = placeholders(other)
    if (expected.join('|') !== actual.join('|')) {
      placeholderMismatches.push({ key, [reference.code]: expected, [locale.code]: actual })
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed =
  missing.length > 0 ||
  emptyPrefixes.length > 0 ||
  divergent.length > 0 ||
  pluralGaps.length > 0 ||
  empties.length > 0 ||
  placeholderMismatches.length > 0

const summary = {
  keysDefined: Object.fromEntries(locales.map((l) => [l.code, l.flat.size])),
  baseKeys: definedBases.size,
  strongReferences: scan.strong.size,
  dynamicPrefixes: scan.prefixes.size,
  unresolvableCallSites: scan.unresolvable.length,
  missing: missing.length,
  emptyPrefixes: emptyPrefixes.length,
  unused: unused.length,
  divergent: divergent.length,
  pluralGaps: pluralGaps.length,
  emptyValues: empties.length,
  placeholderMismatches: placeholderMismatches.length,
  suspectedHardcoded: scan.hardcoded.length,
}

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      { summary, missing, emptyPrefixes, unused, divergent, pluralGaps, empties, placeholderMismatches, hardcoded: scan.hardcoded, unresolvable: scan.unresolvable },
      null,
      2,
    )}\n`,
  )
} else {
  const say = (line = '') => process.stdout.write(`${line}\n`)

  say('i18n audit — src/renderer against locales ' + LOCALES.join(', '))
  say('='.repeat(72))
  for (const locale of locales) say(`  ${locale.code}: ${locale.flat.size} keys  (${relative(ROOT, locale.file).split(sep).join('/')})`)
  say(`  ${definedBases.size} distinct keys after collapsing plural forms`)
  say(
    `  ${scan.strong.size} literal call sites, ${scan.prefixes.size} dynamic prefixes, ` +
      `${scan.unresolvable.length} unresolvable`,
  )
  say()

  const section = (title, items, render) => {
    if (items.length === 0) {
      if (!quiet) say(`OK   ${title}: none`)
      return
    }
    say(`>>>  ${title}: ${items.length}`)
    for (const item of items) say(`       ${render(item)}`)
    say()
  }

  section('MISSING keys (referenced but never defined)', missing, (m) =>
    `${m.key}  — absent from [${m.absentFrom.join(', ')}]  @ ${m.sites.join(', ')}`,
  )
  section('MISSING key families (dynamic prefix matches nothing)', emptyPrefixes, (p) =>
    `${p.prefix}*  @ ${p.sites.join(', ')}`,
  )
  section('DIVERGENT keys (present in one locale only)', divergent, (d) =>
    `${d.key}  — in [${d.present.join(', ')}], absent from [${d.absent.join(', ')}]`,
  )
  section('PLURAL gaps (no _other form)', pluralGaps, (p) => `${p.key} in ${p.locale}`)
  section('EMPTY values', empties, (e) => `${e.key} in ${e.locale}`)
  section('PLACEHOLDER mismatches', placeholderMismatches, (p) =>
    `${p.key}: en={{${p.en.join('}}, {{')}}} vs ko={{${p.ko.join('}}, {{')}}}`,
  )
  section('UNUSED keys (defined, never referenced) — advisory', unused, (k) => k)

  if (scan.hardcoded.length > 0) {
    say(`>>>  SUSPECTED hardcoded UI text: ${scan.hardcoded.length} — advisory, heuristic`)
    for (const h of scan.hardcoded) say(`       ${h.file}:${h.line}  "${h.text}"`)
    say()
  } else if (!quiet) {
    say('OK   SUSPECTED hardcoded UI text: none')
  }

  if (!quiet && scan.unresolvable.length > 0) {
    say()
    say(`note: ${scan.unresolvable.length} call site(s) pass a computed key, so UNUSED is a`)
    say('      best effort. Those keys are matched by their string literal instead:')
    for (const site of scan.unresolvable) say(`       ${site}`)
  }

  say()
  say(failed ? 'FAIL — fix the entries marked >>> above (advisory sections do not fail).' : 'PASS')
}

process.exit(failed ? 1 : 0)
