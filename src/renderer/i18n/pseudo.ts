/**
 * `en-XA` — the pseudo-locale.
 *
 * A pseudo-locale is not a translation. It is a **layout and extraction test** built by
 * mechanically deforming the English bundle at runtime:
 *
 *   `Camera setup`  →  `⟦Çáɱéŕá šéţúþ ···⟧`
 *
 * Three properties, and each one catches a different class of bug:
 *
 * 1. **Brackets.** Every string that came out of `t()` is wrapped in `⟦…⟧`. So any text visible
 *    on screen during a pseudo run that is *not* bracketed is, provably, a hard-coded English
 *    literal that never went through i18next. That is the whole manual QA method, and it is the
 *    only check that finds a string `scripts/i18n-audit.mjs` cannot see — one built by
 *    concatenation, or read out of a `.json` fixture, or produced by a library.
 *
 * 2. **Accents.** A lookalike-accented `Çáɱéŕá` proves the string was transformed, rather than
 *    merely resembling the English source. It also smokes out any component that byte-compares
 *    a translated string, and any font stack that cannot render Latin-1 Supplement.
 *
 * 3. **Padding, ~30%.** Real translations run longer than English. Verger's own second locale
 *    does *not*: Korean is usually shorter, so an EN/KO-only UI can pass both locales while
 *    still being one German or Portuguese string away from a clipped booth button. Padding to
 *    ~130% is the cheap stand-in for the long language this build does not have.
 *
 * Interpolation tokens (`{{name}}`) and nesting tokens (`$t(key)`) are held out of the
 * transform byte-for-byte, so a pseudo-localised screen still renders live values correctly
 * and a missing placeholder shows up as a missing *value*, not as mangled syntax.
 *
 * ## Wiring — READ THIS
 *
 * This module is inert on its own. Nothing imports it in the app entry, by design: it is owned
 * separately from `./index.ts` and it must never be reachable in a normal production run. To
 * turn it on, `src/renderer/i18n/index.ts` needs three lines at the end of `initI18n()`:
 *
 * ```ts
 * import { installPseudoLocale, isPseudoRequested, PSEUDO_LOCALE } from './pseudo'
 * // …inside initI18n(), after .init():
 * if (isPseudoRequested()) void installPseudoLocale(i18n, commonEn, DEFAULT_NAMESPACE)
 * ```
 *
 * `installPseudoLocale` widens `supportedLngs` itself, so `index.ts` needs no other change.
 * Until that edit lands the pseudo build is available to tests and to any caller, but not to
 * the running app — see the STATUS entry for this phase rather than assuming it is live.
 *
 * ## How it is requested
 *
 * - **CI / scripted build:** `VITE_PSEUDO_LOCALE=1 npm run build`. Deliberate, build-time, and
 *   therefore allowed in a production build — that *is* the pseudo build.
 * - **Ad hoc, dev only:** append `?pseudo=1` to the renderer URL. Gated on `import.meta.env.DEV`
 *   so a query string can never flip a shipped installer into pseudo mode mid-service.
 */

/** The BCP-47 code. `XA` is the standard private-use region for an accented pseudo-locale. */
export const PSEUDO_LOCALE = 'en-XA'

/** Roughly how much longer a pseudo string gets, before the cap. */
export const PSEUDO_PAD_RATIO = 0.3

/**
 * Ceiling on filler characters. Without it a three-paragraph help panel would grow a wall of
 * dots that hides the very layout it is meant to test; short labels — where clipping actually
 * happens — never reach the cap.
 */
export const PSEUDO_PAD_MAX = 24

/** The filler character. A middot is visible, narrow, and unmistakably not a real letter. */
const PAD_CHAR = '·'

export const PSEUDO_OPEN = '⟦'
export const PSEUDO_CLOSE = '⟧'

/**
 * a-z / A-Z → a diacritic or lookalike. Chosen to stay legible: an operator eyeballing a
 * pseudo build has to be able to read the label well enough to tell whether it is the right
 * one, otherwise the run tests nothing but the font.
 */
const ACCENT_MAP: Readonly<Record<string, string>> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ',
  l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ',
  w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ',
  L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ',
  W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
}

/**
 * Splits on i18next's two runtime token shapes. The capturing group makes `String.prototype
 * .split` keep the delimiters, so the tokens survive into the output untouched.
 */
const TOKEN_RE = /(\{\{[^}]*\}\}|\$t\([^)]*\))/g

/** True for a segment that is an interpolation or nesting token rather than prose. */
function isToken(segment: string): boolean {
  return segment.startsWith('{{') || segment.startsWith('$t(')
}

/**
 * Accent, pad and bracket a single string.
 *
 * Empty input is returned unchanged: inventing `⟦ ·⟧` out of `''` would put filler on screen
 * where the product deliberately shows nothing.
 */
export function pseudoString(value: string): string {
  if (value === '') return ''

  const segments = value.split(TOKEN_RE)

  let accented = ''
  let visibleLength = 0
  for (const segment of segments) {
    if (segment === '') continue
    if (isToken(segment)) {
      accented += segment
      continue
    }
    for (const char of segment) {
      accented += ACCENT_MAP[char] ?? char
      if (!/\s/.test(char)) visibleLength += 1
    }
  }

  const padCount = Math.min(PSEUDO_PAD_MAX, Math.max(1, Math.round(visibleLength * PSEUDO_PAD_RATIO)))
  return `${PSEUDO_OPEN}${accented} ${PAD_CHAR.repeat(padCount)}${PSEUDO_CLOSE}`
}

/** Any JSON-shaped resource value. */
export type ResourceNode = string | number | boolean | null | ResourceNode[] | ResourceTree

/** A namespace bundle: the shape of `locales/en/common.json`. */
export interface ResourceTree {
  readonly [key: string]: ResourceNode
}

/**
 * Deep-transform every string leaf of a resource tree, preserving structure and every
 * non-string leaf. Pure — the input is never mutated, so the real `en` bundle stays intact
 * even though pseudo mode reads from it.
 */
export function pseudoLocalize<T extends ResourceNode>(node: T): ResourceNode {
  if (typeof node === 'string') return pseudoString(node)
  if (Array.isArray(node)) return node.map((child) => pseudoLocalize(child))
  if (node !== null && typeof node === 'object') {
    const out: Record<string, ResourceNode> = {}
    for (const [key, value] of Object.entries(node)) out[key] = pseudoLocalize(value)
    return out
  }
  return node
}

/**
 * Whether this run should be pseudo-localised.
 *
 * Two independent switches, with deliberately different trust levels:
 *
 * - `VITE_PSEUDO_LOCALE=1` — a **build-time** decision, honoured in any build. Setting it is
 *   already deliberate, and CI needs it to produce a pseudo artefact from a production build.
 * - `?pseudo=1` — a **runtime** query string, honoured only when `import.meta.env.DEV`. A URL
 *   is attacker-supplied in spirit: an operator could paste one mid-service, and a booth full
 *   of `⟦…⟧` during a live broadcast is a worse outcome than a slightly less convenient
 *   debugging flow.
 */
export function isPseudoRequested(): boolean {
  const env: Record<string, unknown> | undefined =
    typeof import.meta !== 'undefined' ? (import.meta.env as Record<string, unknown> | undefined) : undefined

  if (env?.['VITE_PSEUDO_LOCALE'] === '1' || env?.['VITE_PSEUDO_LOCALE'] === true) return true

  if (env?.['DEV'] !== true) return false
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('pseudo') === '1'
  } catch {
    return false
  }
}

/**
 * The minimum surface of i18next this module needs.
 *
 * Declared structurally rather than importing i18next's `i18n` type so the transform stays
 * testable against a hand-rolled stub, and so this file never drags the i18next singleton into
 * a test that only wants `pseudoString`.
 */
export interface PseudoI18nTarget {
  options: { supportedLngs?: readonly string[] | false | undefined }
  addResourceBundle(
    lng: string,
    ns: string,
    resources: unknown,
    deep?: boolean,
    overwrite?: boolean,
  ): unknown
  changeLanguage(lng: string): Promise<unknown>
  services?: {
    languageUtils?: {
      /**
       * i18next's `LanguageUtils` copies `options.supportedLngs` into its own field at
       * construction (`this.supportedLngs = this.options.supportedLngs || false`) and
       * `isSupportedCode` reads *that* copy, not the options object. Widening only
       * `options.supportedLngs` therefore looks like it worked and silently does nothing.
       */
      supportedLngs?: readonly string[] | false
      options?: { supportedLngs?: readonly string[] | false }
    }
  }
}

/**
 * Register the pseudo bundle on an i18next instance and switch to it.
 *
 * `supportedLngs` is widened first, in both places i18next reads it from. i18next resolves a
 * requested language against that list *before* looking at the resource store, so adding the
 * bundle without widening the list leaves `changeLanguage(PSEUDO_LOCALE)` silently falling
 * back to `en` — the failure mode being that pseudo mode appears to work, shows plain English,
 * and reports every string as un-extracted.
 *
 * Never throws: a pseudo run is a diagnostic, and a diagnostic that can take the booth UI down
 * is worse than no diagnostic. Returns whether the switch actually happened.
 */
export async function installPseudoLocale(
  instance: PseudoI18nTarget,
  englishBundle: ResourceTree,
  namespace: string,
): Promise<boolean> {
  try {
    const current = instance.options.supportedLngs
    if (Array.isArray(current) && !current.includes(PSEUDO_LOCALE)) {
      const widened = [PSEUDO_LOCALE, ...current]
      instance.options.supportedLngs = widened
      const languageUtils = instance.services?.languageUtils
      if (languageUtils !== undefined) {
        languageUtils.supportedLngs = widened
        if (languageUtils.options !== undefined) languageUtils.options.supportedLngs = widened
      }
    }

    instance.addResourceBundle(PSEUDO_LOCALE, namespace, pseudoLocalize(englishBundle), true, true)
    await instance.changeLanguage(PSEUDO_LOCALE)
    return true
  } catch {
    return false
  }
}
