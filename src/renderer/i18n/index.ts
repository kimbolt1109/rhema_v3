/**
 * Operator-UI localisation.
 *
 * Scope note, carried straight from `docs/v2-notes/I18N.md`: this is the **operator chrome**
 * locale and nothing else. The language of the *service* — captions, scripture, song text — is a
 * separate subsystem with separate settings. rhema_v2 conflated the two and the note flags it as
 * a risk; keep them apart.
 *
 * The Korean bundle here is **authored, not ported.** v2 never shipped a `ko` UI locale (its
 * `SUPPORTED_LOCALES` were `en`/`ar`/`he`, and only `en` ever had a resource file), so there was
 * nothing to copy. Strings are deliberately short: a Korean label has to fit the same 44px booth
 * button as its English counterpart, and an operator glancing at it in the dark has no time to
 * read a sentence.
 *
 * Design decisions, and why:
 *
 * - **Bundled resources, no HTTP backend.** Verger is an offline desktop app; a network fetch for
 *   UI strings would be a new failure mode for zero benefit, and the CSP in `index.html` would
 *   block it anyway.
 * - **A real namespace (`common`) rather than v2's single flat tree.** v2's own retrospective
 *   recommends splitting once the key count grows; starting namespaced costs nothing now and
 *   avoids a migration later.
 * - **`escapeValue: false`.** React already escapes interpolated values. Leaving i18next's
 *   escaping on double-escapes them.
 * - **`returnNull: false`.** A missing key must render as its key string, not as `null` crashing
 *   a `<div>{null}</div>` deeper in the tree.
 * - **Resources passed inline to `init()`.** i18next only defers initialisation to a later tick
 *   when it has to fetch (`if (this.options.resources || !this.options.initAsync)` in its
 *   `loadResources`). Supplying `resources` up front therefore makes `init()` complete
 *   synchronously, so a component rendered in the same tick as this module's import already has
 *   its strings and never flashes a raw key.
 */

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import commonEn from './locales/en/common.json'
import commonKo from './locales/ko/common.json'

/** localStorage key holding the operator's chosen UI language. */
export const LOCALE_STORAGE_KEY = 'verger-locale'

/** The only namespace Phase 1 needs. Later phases add e.g. `plan`, `cue`. */
export const DEFAULT_NAMESPACE = 'common'

export const FALLBACK_LOCALE = 'en'

/**
 * Languages with a complete bundle.
 *
 * Labels are **endonyms** — a Korean operator looks for `한국어`, not for the word "Korean"
 * written in a language they are trying to switch away from.
 */
export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['code']

/** Just the codes, for `supportedLngs` and for validating a stored preference. */
export const SUPPORTED_LOCALE_CODES: readonly SupportedLocale[] = SUPPORTED_LOCALES.map(
  (locale) => locale.code,
)

export const resources = {
  en: { [DEFAULT_NAMESPACE]: commonEn },
  ko: { [DEFAULT_NAMESPACE]: commonKo },
} as const

/**
 * Initialise the shared i18next singleton.
 *
 * Idempotent: importing this module twice (app entry + a test file) must not re-init and lose the
 * operator's current language.
 */
export function initI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n

  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      ns: [DEFAULT_NAMESPACE],
      defaultNS: DEFAULT_NAMESPACE,
      fallbackLng: FALLBACK_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALE_CODES],
      // So a browser reporting `ko-KR` or `en-GB` resolves to `ko` / `en` instead of falling
      // through to the fallback.
      nonExplicitSupportedLngs: true,
      interpolation: { escapeValue: false },
      returnNull: false,
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LOCALE_STORAGE_KEY,
        caches: ['localStorage'],
      },
    })

  return i18n
}

/** Returns true when `value` is a locale Verger actually has strings for. */
export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALE_CODES.includes(value as SupportedLocale)
}

/** Change the UI language, persisting it via the detector's localStorage cache. */
export async function setLocale(locale: SupportedLocale): Promise<void> {
  await i18n.changeLanguage(locale)
}

initI18n()

export default i18n
