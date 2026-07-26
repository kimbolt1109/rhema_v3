/**
 * Theme drift guards.
 *
 * The seven-step type scale and the single focus outline are both the kind of invariant that is
 * true the day it lands and quietly false six features later, because nothing stops a new
 * component from reaching for `text-sm` or re-declaring its own ring. These tests are that stop.
 *
 * Source is read through Vite's `?raw` glob rather than `node:fs` on purpose. The renderer's
 * tsconfig is DOM-only — `@main/*` is unmapped and Node types are absent, because "the renderer
 * never touches Node" is an architecture invariant, not an accident. A guard that forced
 * `@types/node` into `tsconfig.web.json` would erode the very boundary it is meant to protect.
 */

import { describe, expect, it } from 'vitest'

/**
 * Every non-test source file in the renderer — the same set Tailwind scans.
 * Eager so the contents are plain strings at assertion time.
 */
const SOURCES = import.meta.glob<string>(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
)

/**
 * Blank out comments so prose cannot trip a rule about classes.
 *
 * A comment explaining "this used to be 0.65rem, which was under the floor" is exactly the note
 * worth keeping, and it must not read as a violation. Block comments collapse to spaces rather
 * than vanishing, so reported line numbers stay truthful. Line comments are only stripped when
 * `//` is not preceded by `:`, so a `http://127.0.0.1` inside a string survives and the rest of
 * that line is still scanned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** `file:line  offending-token` for every match, so a failure names the site to fix. */
function offenders(pattern: RegExp): readonly string[] {
  const hits: string[] = []
  for (const [path, source] of Object.entries(SOURCES)) {
    stripComments(source)
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          hits.push(`${path.replace(/^\.\.\//, '')}:${String(index + 1)}  ${match[0]}`)
        }
      })
  }
  return hits
}

describe('the type scale', () => {
  it('is scanning the renderer it thinks it is', () => {
    // Without this, a glob that silently matched nothing would turn every guard below into a
    // vacuous pass — the worst possible failure mode for a drift test.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(40)
    expect(Object.keys(SOURCES)).toContain('../App.tsx')
    // And prove comment-stripping left the code itself intact, so the guards below are looking at
    // real class lists rather than blanked-out files.
    expect(
      offenders(/\btext-(?:micro|meta|body|label|title|readout|metric)\b/g).length,
    ).toBeGreaterThan(200)
  })

  it("uses none of Tailwind's default font sizes", () => {
    // `fontSize` in tailwind.config.js replaces the default scale wholesale, so a `text-sm` left
    // in a component is not merely off-scale — it emits no font-size rule at all and the element
    // silently falls back to whatever it inherits.
    expect(offenders(/\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/g)).toEqual([])
  })

  it('declares no ad-hoc pixel or rem font size', () => {
    // 11px is the floor (see the fontSize note in tailwind.config.js); anything smaller is
    // unreadable in a dark booth at arm's length whatever its contrast.
    expect(offenders(/\btext-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g)).toEqual([])
  })
})

describe('the focus ring', () => {
  it('is never re-declared per component', () => {
    // A local `focus-visible:outline-none` + box-shadow ring is self-defeating: the outline-none
    // half suppresses the global outline, so any component that forgets the second half ships
    // with no ring at all. That is the exact defect v2 logged as focus-visible "not yet
    // standardized" (docs/v2-notes/SHORTCUTS_AND_A11Y.md §9.5).
    expect(offenders(/\bfocus-visible:ring-(?:2|ring|panic|inset|offset-\w+)/g)).toEqual([])
  })

  // The other half of this invariant — that `index.css` still DEFINES the one outline, so removing
  // it cannot silently strip the ring from every control — is asserted in `e2e/service-day.spec.ts`
  // against the packaged app. It cannot live here: this project runs with `css: false`, so a
  // `?raw` import of the stylesheet yields an empty string, and reaching for `node:fs` instead
  // would force Node types into the DOM-only renderer tsconfig and erode the boundary that keeps
  // main-process code out of the renderer. Measuring a real focused control is better evidence
  // than regexing stylesheet text anyway.
})
