/**
 * The regression lock for a shipped bug that nothing could see.
 *
 * `CuePreview.tsx` used to declare its own `PLAN_ASSET_PATH = '/plan-assets'` behind an
 * `ASSUMPTION:` comment about what the main process "is expected to" serve. The overlay server has
 * only ever served `OVERLAY_ASSET_PATH` (`/assets`, see `src/shared/net.ts` and
 * `src/main/overlay/OverlayServer.ts`), so **every slide thumbnail in the app was a 404** — in the
 * NOW/NEXT hero cards and in the pre-load strip BLUEPRINT.md §4 promises. Nothing failed loudly: a
 * broken `<img alt="">` is an empty box, and every existing unit test injected its own
 * `assetUrl` resolver, which left the default resolver as the one path nobody exercised.
 *
 * So the load-bearing assertion in this file is an *equality*: `defaultAssetUrl` must agree with
 * `overlayAssetUrl` from `@shared/net`, which is the single source of truth for every port and
 * path. This component is not allowed a second opinion about the route. The render tests
 * deliberately mount **without** an injected resolver for the same reason — injecting one is what
 * hid the bug for four phases.
 *
 * The rest of the file pins the guard rails around that route: a plan-relative asset resolves, a
 * traversal or absolute path degrades to a labelled placeholder rather than a broken image
 * (Standing Rule 5 — degrade, never crash), and a `scripture` cue renders a REFERENCE and nothing
 * that could hold a verse (Standing Rule 4, asserted as an absence because that is the only way an
 * absence can be asserted).
 *
 * ## Fixtures
 *
 * Standing Rule 4: obvious placeholders only — "SLIDE 1", "PLACEHOLDER TITLE". The scripture cue
 * carries `John 3:16` and a translation code, which is all `ScripturePayload` can hold by
 * construction.
 *
 * No `beforeEach` store reset here on purpose: `CuePreview` owns no state and reads no zustand
 * store, which is what makes it safe to mount twice on one screen. A reset would imply otherwise.
 */

import { render, screen, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { OVERLAY_ASSET_PATH, overlayAssetUrl } from '@shared/net'
import type { Cue, CuePayload } from '@shared/plan'

import '../i18n'
import { mockCue } from '../test/mockVergerApi'
import { CuePreview, defaultAssetUrl } from './CuePreview'

/** axe's `region` rule flags content outside a landmark; in the app this sits inside `<main>`. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/**
 * A payload the type system would refuse, cast in deliberately.
 *
 * The point of the malformed-cue and no-verse-text tests is that a payload which came off disk,
 * out of a hand-edited plan file or out of a deck importer is *not* trustworthy. Constructing one
 * that TypeScript already rejects is the only way to exercise the runtime re-validation that
 * `CuePreview` performs precisely because the compiler cannot correlate `cue.type` with
 * `cue.payload` across an object boundary.
 */
function untrusted(payload: Record<string, unknown>): CuePayload {
  return payload as unknown as CuePayload
}

const SLIDE_ASSET = 'slides/slide-001.png'

const CUE_SLIDE: Cue = mockCue({
  id: 'cue-slide-1',
  label: 'SLIDE 1',
  payload: { asset: SLIDE_ASSET, sourceSlide: 1 },
})

const CUE_SCRIPTURE: Cue = mockCue({
  id: 'cue-reading',
  type: 'scripture',
  label: 'PLACEHOLDER READING',
  // A REFERENCE and a translation code. `ScripturePayload` has no `text` field, deliberately.
  payload: { reference: 'John 3:16', translation: 'KJV' },
})

describe('defaultAssetUrl', () => {
  it('routes a plan-relative slide through the overlay server’s real asset path', () => {
    const url = defaultAssetUrl(SLIDE_ASSET)

    // THE assertion this file exists for: no second opinion about the route. If someone
    // reintroduces a locally declared path constant, this line fails immediately.
    expect(url).toBe(overlayAssetUrl(SLIDE_ASSET))
    expect(url).toContain(`${OVERLAY_ASSET_PATH}/`)
    expect(url).toContain('/assets/')
    // The exact wrong answer that shipped. Named literally so the regression is unmissable.
    expect(url).not.toContain('plan-assets')
  })

  it('agrees with @shared/net for a nested asset too, not just the happy filename', () => {
    expect(defaultAssetUrl('media/loops/PLACEHOLDER-LOOP.mp4')).toBe(
      overlayAssetUrl('media/loops/PLACEHOLDER-LOOP.mp4'),
    )
  })

  it.each([
    ['a leading slash', '/slides/slide-001.png'],
    ['a leading backslash (UNC share)', '\\\\PLACEHOLDER-SERVER\\share\\slide-001.png'],
    ['a parent-directory segment', '../../secrets/slide-001.png'],
    ['a parent-directory segment mid-path', 'slides/../../secrets/slide-001.png'],
    ['a current-directory segment', 'slides/./slide-001.png'],
    ['a Windows drive letter', 'C:\\Verger\\slides\\slide-001.png'],
    ['a drive letter without a separator', 'C:slide-001.png'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('refuses %s', (_why, asset) => {
    // `SlidePayload.asset` is documented as relative to the plan's asset folder. Anything else is
    // a mistake or a traversal attempt from an imported deck, and the honest answer on screen is
    // "this asset cannot be shown" — never a request that escapes the asset folder.
    expect(defaultAssetUrl(asset)).toBeNull()
  })

  it('passes an absolute http(s) URL through untouched', () => {
    // An importer may legitimately have written one; rewriting it would break a working asset.
    expect(defaultAssetUrl('http://placeholder.invalid/slide-001.png')).toBe(
      'http://placeholder.invalid/slide-001.png',
    )
    expect(defaultAssetUrl('https://placeholder.invalid/slide-001.png')).toBe(
      'https://placeholder.invalid/slide-001.png',
    )
    // Scheme matching is case-insensitive, so an upper-cased scheme is not silently refused.
    expect(defaultAssetUrl('HTTPS://placeholder.invalid/slide-001.png')).toBe(
      'HTTPS://placeholder.invalid/slide-001.png',
    )
  })

  it('percent-encodes each segment, so a space or Hangul filename actually resolves', () => {
    // A Korean church's exported deck routinely carries both. An unencoded space produces a URL
    // the overlay server never matches, and the failure mode is an invisible empty box.
    expect(defaultAssetUrl('slides/PLACEHOLDER slide 1.png')).toBe(
      'http://127.0.0.1:7320/assets/slides/PLACEHOLDER%20slide%201.png',
    )
    expect(defaultAssetUrl('slides/슬라이드 1.png')).toBe(
      'http://127.0.0.1:7320/assets/slides/%EC%8A%AC%EB%9D%BC%EC%9D%B4%EB%93%9C%201.png',
    )
    // The separator itself must survive as a separator, not become %2F.
    expect(defaultAssetUrl('slides/슬라이드 1.png')).toContain('/slides/')
  })

  it('normalises backslash separators a Windows-side importer may have written', () => {
    expect(defaultAssetUrl('slides\\slide-001.png')).toBe(overlayAssetUrl(SLIDE_ASSET))
  })

  it('trims surrounding whitespace rather than refusing a hand-edited path', () => {
    expect(defaultAssetUrl(`  ${SLIDE_ASSET}  `)).toBe(overlayAssetUrl(SLIDE_ASSET))
  })
})

describe('CuePreview', () => {
  describe('slide cues', () => {
    it('renders the slide image at the URL the overlay server actually serves', () => {
      // No injected resolver, on purpose. Injecting one is exactly what hid the 404 for four
      // phases, so this test mounts the component the way the app mounts it.
      render(<CuePreview cue={CUE_SLIDE} imageTestId="cue-preview-image" />, {
        wrapper: Landmark,
      })

      const image = screen.getByTestId('cue-preview-image')
      expect(image.tagName).toBe('IMG')
      expect(image).toHaveAttribute('src', overlayAssetUrl(SLIDE_ASSET))
      expect(image.getAttribute('src')).not.toContain('plan-assets')
      // `data-asset` is the plan-relative path, so a test can tell *which* slide was warmed.
      expect(image).toHaveAttribute('data-asset', SLIDE_ASSET)
      // The thumbnail is the pre-load (BLUEPRINT.md §4), so it must not be deferred.
      expect(image).toHaveAttribute('loading', 'eager')
    })

    it('stamps no data-testid when imageTestId is omitted, but still renders the image', () => {
      const { container } = render(<CuePreview cue={CUE_SLIDE} />, { wrapper: Landmark })

      const image = container.querySelector('img[data-cue-preview="slide-image"]')
      expect(image).not.toBeNull()
      expect(image?.hasAttribute('data-testid')).toBe(false)
    })

    it('shows the labelled placeholder instead of a broken image when the resolver refuses', () => {
      render(<CuePreview cue={CUE_SLIDE} assetUrl={() => null} imageTestId="cue-preview-image" />, {
        wrapper: Landmark,
      })

      // Real copy from `src/renderer/i18n/locales/en/common.json` — `plan.preview.slideUnavailable`.
      expect(screen.getByText('Slide image unavailable.')).toBeInTheDocument()
      expect(screen.queryByTestId('cue-preview-image')).toBeNull()
    })

    it('degrades to the placeholder for a traversal asset under the default resolver', () => {
      const traversal = mockCue({
        id: 'cue-traversal',
        label: 'SLIDE 1',
        payload: { asset: '../../secrets/slide-001.png' },
      })
      const { container } = render(<CuePreview cue={traversal} imageTestId="cue-preview-image" />, {
        wrapper: Landmark,
      })

      expect(screen.getByText('Slide image unavailable.')).toBeInTheDocument()
      expect(screen.queryByTestId('cue-preview-image')).toBeNull()
      expect(container.querySelector('img')).toBeNull()
      // The path is still printed, so the operator can see what to fix in the plan editor.
      expect(screen.getByText('../../secrets/slide-001.png')).toBeInTheDocument()
    })

    it('names the source slide number alongside the asset when the deck importer recorded one', () => {
      render(<CuePreview cue={CUE_SLIDE} />, { wrapper: Landmark })
      expect(screen.getByText(`#1 · ${SLIDE_ASSET}`)).toBeInTheDocument()
    })
  })

  describe('malformed payloads', () => {
    it('renders the malformed-cue note rather than throwing when the payload does not match', () => {
      // A `slide` cue carrying a scene payload — the shape a hand-edited plan file produces.
      // Standing Rule 5: degrade, never crash, and never mid-service.
      const mismatched: Cue = mockCue({
        id: 'cue-mismatched',
        type: 'slide',
        label: 'SLIDE 1',
        payload: { scene: 'Welcome loop' },
      })

      expect(() => render(<CuePreview cue={mismatched} />, { wrapper: Landmark })).not.toThrow()

      expect(screen.getByText(/do not match its type/i)).toBeInTheDocument()
      expect(screen.getByText(/Fix it in the plan editor/i)).toBeInTheDocument()
      // No image, and — critically — no guess at a URL from a payload we do not understand.
      expect(screen.queryByRole('img')).toBeNull()
      // The operator's own label still renders, so the row is identifiable in the list.
      expect(screen.getByText('SLIDE 1')).toBeInTheDocument()
    })

    it('renders the malformed-cue note for an empty slide asset', () => {
      const empty: Cue = mockCue({ id: 'cue-empty-asset', payload: { asset: '' } })
      render(<CuePreview cue={empty} />, { wrapper: Landmark })
      expect(screen.getByText(/do not match its type/i)).toBeInTheDocument()
    })
  })

  describe('scripture cues', () => {
    it('renders the reference and translation, and never verse text', () => {
      const { container } = render(<CuePreview cue={CUE_SCRIPTURE} />, { wrapper: Landmark })

      const card = within(container)
      expect(card.getByText('John 3:16')).toBeInTheDocument()
      expect(card.getByText('KJV')).toBeInTheDocument()
      // Real copy — `plan.preview.scriptureResolved`. Without it a reference-only preview reads
      // like a cue that failed to load.
      expect(card.getByText('Verse text is fetched when the cue fires.')).toBeInTheDocument()
    })

    it('drops a rogue `text` field rather than rendering it', () => {
      // Standing Rule 4 is why `ScripturePayload` has no `text` field. This asserts the *absence*
      // — the only way an absence can be asserted — against a payload that smuggled one in, which
      // is what a hand-edited plan file or a future importer bug would look like.
      const smuggled: Cue = mockCue({
        id: 'cue-smuggled',
        type: 'scripture',
        label: 'PLACEHOLDER READING',
        payload: untrusted({
          reference: 'John 3:16',
          translation: 'KJV',
          text: 'PLACEHOLDER VERSE TEXT THAT MUST NEVER REACH A SCREEN',
        }),
      })
      const { container } = render(<CuePreview cue={smuggled} />, { wrapper: Landmark })

      expect(screen.getByText('John 3:16')).toBeInTheDocument()
      expect(container.textContent).not.toContain('PLACEHOLDER VERSE TEXT')
      expect(screen.queryByText(/MUST NEVER REACH A SCREEN/)).toBeNull()
    })
  })

  describe('the empty state', () => {
    it('says nothing is here rather than rendering an empty box', () => {
      render(<CuePreview cue={null} />, { wrapper: Landmark })
      expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    })

    it('honours a caller-supplied empty label', () => {
      render(<CuePreview cue={null} emptyLabel="End of the plan. Nothing follows." />, {
        wrapper: Landmark,
      })
      expect(screen.getByText('End of the plan. Nothing follows.')).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has no axe violations for a slide, a scripture reference or an unservable asset', async () => {
      for (const cue of [CUE_SLIDE, CUE_SCRIPTURE]) {
        const { container, unmount } = render(<CuePreview cue={cue} />, { wrapper: Landmark })
        await expect(axe(container)).resolves.toHaveNoViolations()
        unmount()
      }

      const { container } = render(<CuePreview cue={CUE_SLIDE} assetUrl={() => null} />, {
        wrapper: Landmark,
      })
      await expect(axe(container)).resolves.toHaveNoViolations()
    })
  })
})
