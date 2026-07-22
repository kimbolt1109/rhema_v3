/**
 * Confidence tuning's contract.
 *
 * Three things are asserted harder than the rest, because they are the three that stop an operator
 * quietly disarming the safety story on a Tuesday:
 *
 *  1. **The sliders read the real constants.** `CONFIDENCE_EXACT`, `CONFIDENCE_FUZZY`,
 *     `ANCHOR_MATCH_THRESHOLD` and `MIN_AUTO_FIRE_GAP_MS` are imported here and compared against
 *     what is rendered. If a threshold moves in `@shared`, this screen moves with it or this test
 *     fails — nothing is retyped in the component.
 *  2. **Every confidence control is bounded to `[0, 1]`**, in the DOM and in `clampConfidence`, so
 *     no drag, paste or `NaN` can produce a save the main process would refuse.
 *  3. **Anything looser than recommended says so, in place.** For the service default and for each
 *     per-cue override. `confirmAlways` is never flagged: it can only make a cue safer.
 *
 * Every fixture label is a placeholder. Standing Rule 4: no verse text, no lyrics, anywhere.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ANCHOR_MATCH_THRESHOLD,
  MIN_AUTO_FIRE_GAP_MS,
  defaultCueEngineSettings,
} from '@shared/cue'
import type { Cue } from '@shared/plan'
import { ErrorCode, err } from '@shared/result'
import { CONFIDENCE_EXACT, CONFIDENCE_FUZZY } from '@shared/scripture'

import '../i18n'
import { resetCueStore } from '../store/cueStore'
import { resetPlanStore, usePlanStore } from '../store/planStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import { installMockVergerApi, mockCue, mockServicePlan } from '../test/mockVergerApi'
import {
  MAX_AUTO_FIRE_GAP_MS,
  RECOMMENDED_TUNING,
  TuningSettings,
  clampConfidence,
  collectCueOverrides,
  formatConfidence,
  isLooserThanRecommended,
} from './TuningSettings'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

const RECOMMENDED = defaultCueEngineSettings().autoFireThreshold

/** A plan whose cues disagree with the service default in both directions. */
function planWithOverrides(): void {
  const cues: readonly Cue[] = [
    mockCue({ id: 'cue-plain', label: 'PLACEHOLDER TITLE' }),
    mockCue({
      id: 'cue-loose',
      label: 'PLACEHOLDER LOOSE CUE',
      options: { autoFireThreshold: 0.4 },
    }),
    mockCue({
      id: 'cue-strict',
      label: 'PLACEHOLDER STRICT CUE',
      options: { autoFireThreshold: 0.99, confirmAlways: true },
    }),
    mockCue({
      id: 'cue-confirm',
      label: 'PLACEHOLDER CONFIRM CUE',
      options: { confirmAlways: true },
    }),
  ]
  usePlanStore.setState({ plan: mockServicePlan({ cues }) })
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('RECOMMENDED_TUNING', () => {
  it('is read from the shared constants, not retyped', () => {
    expect(RECOMMENDED_TUNING).toEqual({
      autoFireThreshold: defaultCueEngineSettings().autoFireThreshold,
      scriptureExact: CONFIDENCE_EXACT,
      scriptureFuzzy: CONFIDENCE_FUZZY,
      anchorMatch: ANCHOR_MATCH_THRESHOLD,
      minAutoFireGapMs: MIN_AUTO_FIRE_GAP_MS,
    })
  })

  it('keeps the bands in the order the contract states', () => {
    expect(RECOMMENDED_TUNING.scriptureExact).toBeGreaterThan(RECOMMENDED_TUNING.scriptureFuzzy)
    // A mis-fired slide is more disruptive than a mis-offered verse — `@shared/cue` says so.
    expect(RECOMMENDED_TUNING.anchorMatch).toBeGreaterThan(RECOMMENDED_TUNING.scriptureFuzzy)
  })
})

describe('clampConfidence', () => {
  it('clamps into [0, 1]', () => {
    expect(clampConfidence(-4)).toBe(0)
    expect(clampConfidence(0)).toBe(0)
    expect(clampConfidence(0.42)).toBe(0.42)
    expect(clampConfidence(1)).toBe(1)
    expect(clampConfidence(9)).toBe(1)
  })

  it('resolves an unreadable value to the recommended one, never to zero', () => {
    // Zero would mean "fire on anything", which is the worst possible reading of an empty field.
    expect(clampConfidence(Number.NaN)).toBe(RECOMMENDED)
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(RECOMMENDED)
  })
})

describe('isLooserThanRecommended', () => {
  it('is true only below the recommended value', () => {
    expect(isLooserThanRecommended(RECOMMENDED - 0.01, RECOMMENDED)).toBe(true)
    expect(isLooserThanRecommended(RECOMMENDED, RECOMMENDED)).toBe(false)
    expect(isLooserThanRecommended(RECOMMENDED + 0.01, RECOMMENDED)).toBe(false)
  })
})

describe('formatConfidence', () => {
  it('reads as a percentage', () => {
    expect(formatConfidence(CONFIDENCE_EXACT)).toBe('95%')
    expect(formatConfidence(CONFIDENCE_FUZZY)).toBe('65%')
  })
})

describe('collectCueOverrides', () => {
  const cues: readonly Cue[] = [
    mockCue({ id: 'a', label: 'A' }),
    mockCue({ id: 'b', label: 'B', options: { autoFireThreshold: 0.4 } }),
    mockCue({ id: 'c', label: 'C', options: { confirmAlways: true } }),
  ]

  it('lists only cues that override something', () => {
    expect(collectCueOverrides(cues, RECOMMENDED).map((row) => row.id)).toEqual(['b', 'c'])
  })

  it('flags a threshold below the service default', () => {
    const rows = collectCueOverrides(cues, RECOMMENDED)
    expect(rows[0]).toEqual({
      id: 'b',
      label: 'B',
      autoFireThreshold: 0.4,
      confirmAlways: false,
      looser: true,
    })
  })

  it('never flags confirmAlways — it can only make a cue safer', () => {
    const rows = collectCueOverrides(cues, RECOMMENDED)
    expect(rows[1]).toEqual({
      id: 'c',
      label: 'C',
      autoFireThreshold: null,
      confirmAlways: true,
      looser: false,
    })
  })
})

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe('TuningSettings', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCueStore()
    resetPlanStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('seeds every slider from the real shared constants', async () => {
    render(<TuningSettings />, { wrapper: Landmark })

    const autoFire = (await screen.findByLabelText(/default auto-fire threshold/i)) as HTMLInputElement
    expect(autoFire.value).toBe(String(RECOMMENDED))

    expect((screen.getByLabelText(/exact reference band/i) as HTMLInputElement).value).toBe(
      String(CONFIDENCE_EXACT),
    )
    expect((screen.getByLabelText(/offered reference band/i) as HTMLInputElement).value).toBe(
      String(CONFIDENCE_FUZZY),
    )
    expect((screen.getByLabelText(/anchor match threshold/i) as HTMLInputElement).value).toBe(
      String(ANCHOR_MATCH_THRESHOLD),
    )
    expect((screen.getByLabelText(/minimum gap between auto-fires/i) as HTMLInputElement).value).toBe(
      String(MIN_AUTO_FIRE_GAP_MS),
    )
  })

  it('bounds every confidence slider to [0, 1]', async () => {
    render(<TuningSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/default auto-fire threshold/i)

    for (const name of [
      /default auto-fire threshold/i,
      /exact reference band/i,
      /offered reference band/i,
      /anchor match threshold/i,
    ]) {
      const slider = screen.getByLabelText(name) as HTMLInputElement
      expect(slider.type).toBe('range')
      expect(slider.min).toBe('0')
      expect(slider.max).toBe('1')
    }

    // The dwell floor is a duration, not a confidence, so it gets its own bound.
    const gap = screen.getByLabelText(/minimum gap between auto-fires/i) as HTMLInputElement
    expect(gap.min).toBe('0')
    expect(gap.max).toBe(String(MAX_AUTO_FIRE_GAP_MS))
  })

  it('explains each number in plain language and states the cost of lowering it', async () => {
    render(<TuningSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/default auto-fire threshold/i)

    // The same phrase on every control, deliberately.
    expect(screen.getAllByText(/act on less certainty/i).length).toBeGreaterThanOrEqual(4)
    expect(screen.getByText(/more cues fire without you/i)).toBeInTheDocument()
    expect(screen.getByText(/wrong passage can go up/i)).toBeInTheDocument()
    expect(screen.getByText(/three slides ahead of the preacher/i)).toBeInTheDocument()
    expect(screen.getByText(/faster than you can stop it/i)).toBeInTheDocument()
  })

  it('says plainly which numbers this build can actually save', async () => {
    render(<TuningSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /what this screen changes/i })
    expect(screen.getByText(/only the default auto-fire threshold is saved/i)).toBeInTheDocument()
    expect(screen.getAllByText(/changing it is a code change, not a setting/i).length).toBe(4)
  })

  it('renders the compiled-in sliders read-only and the tunable one live', async () => {
    render(<TuningSettings />, { wrapper: Landmark })

    expect(await screen.findByLabelText(/default auto-fire threshold/i)).toBeEnabled()
    expect(screen.getByLabelText(/exact reference band/i)).toBeDisabled()
    expect(screen.getByLabelText(/offered reference band/i)).toBeDisabled()
    expect(screen.getByLabelText(/anchor match threshold/i)).toBeDisabled()
    expect(screen.getByLabelText(/minimum gap between auto-fires/i)).toBeDisabled()
  })

  it('warns visibly once the default threshold is looser than recommended', async () => {
    render(<TuningSettings />, { wrapper: Landmark })

    const slider = await screen.findByLabelText(/default auto-fire threshold/i)
    expect(screen.queryByTestId('tuning-loose-warning')).not.toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '0.4' } })

    const warning = await screen.findByTestId('tuning-loose-warning')
    expect(warning).toHaveTextContent(/looser than recommended/i)
    expect(warning).toHaveTextContent(/act on less certainty/i)
    expect(screen.getByTestId('tuning-auto-fire-threshold-readout')).toHaveTextContent('40%')
  })

  it('drops the warning again when the threshold is raised back', async () => {
    render(<TuningSettings />, { wrapper: Landmark })

    const slider = await screen.findByLabelText(/default auto-fire threshold/i)
    fireEvent.change(slider, { target: { value: '0.4' } })
    await screen.findByTestId('tuning-loose-warning')

    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => {
      expect(screen.queryByTestId('tuning-loose-warning')).not.toBeInTheDocument()
    })
  })

  it('saves the threshold through the bridge', async () => {
    const user = userEvent.setup()
    render(<TuningSettings />, { wrapper: Landmark })

    const slider = await screen.findByLabelText(/default auto-fire threshold/i)
    fireEvent.change(slider, { target: { value: '0.6' } })
    await user.click(screen.getByRole('button', { name: /save tuning/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cueSetSettings).toHaveLength(1)
    })
    expect(installed.mock.calls.cueSetSettings[0]?.autoFireThreshold).toBe(0.6)
    // Nothing else in the settings is disturbed by a tuning save.
    expect(installed.mock.calls.cueSetSettings[0]?.mode).toBe(defaultCueEngineSettings().mode)
    await screen.findByText(/tuning saved/i)
  })

  it('resets to the recommended value and saves it', async () => {
    const user = userEvent.setup()
    render(<TuningSettings />, { wrapper: Landmark })

    const slider = await screen.findByLabelText(/default auto-fire threshold/i)
    fireEvent.change(slider, { target: { value: '0.1' } })
    await screen.findByTestId('tuning-loose-warning')

    await user.click(screen.getByRole('button', { name: /reset to recommended/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cueSetSettings).toHaveLength(1)
    })
    expect(installed.mock.calls.cueSetSettings[0]?.autoFireThreshold).toBe(RECOMMENDED)
    expect((slider as HTMLInputElement).value).toBe(String(RECOMMENDED))
    await waitFor(() => {
      expect(screen.queryByTestId('tuning-loose-warning')).not.toBeInTheDocument()
    })
  })

  it('surfaces a refused save rather than claiming it worked', async () => {
    const user = userEvent.setup()
    installed.mock.responses.cueSetSettings = err(ErrorCode.IO_ERROR, 'settings file is read-only')

    render(<TuningSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/default auto-fire threshold/i)
    await user.click(screen.getByRole('button', { name: /save tuning/i }))

    await screen.findByText(/settings file is read-only/i)
    expect(screen.queryByText(/tuning saved/i)).not.toBeInTheDocument()
  })

  it('lists the per-cue overrides in the loaded plan and flags the loose one', async () => {
    planWithOverrides()
    render(<TuningSettings />, { wrapper: Landmark })

    const list = await screen.findByRole('list', { name: /cues with their own rules/i })
    const items = within(list).getAllByRole('listitem')
    // The cue with no options at all is not an override and is not listed.
    expect(items).toHaveLength(3)
    expect(list).not.toHaveTextContent('PLACEHOLDER TITLE')

    expect(screen.getByTestId('tuning-override-cue-loose')).toHaveAttribute('data-looser', 'true')
    expect(screen.getByTestId('tuning-override-cue-loose')).toHaveTextContent(/40%/)
    expect(screen.getByTestId('tuning-override-cue-loose')).toHaveTextContent(
      /looser than the service default/i,
    )

    expect(screen.getByTestId('tuning-override-cue-strict')).toHaveAttribute('data-looser', 'false')
    // `confirmAlways` only ever makes a cue safer, so it is described and never warned about.
    const confirmOnly = screen.getByTestId('tuning-override-cue-confirm')
    expect(confirmOnly).toHaveAttribute('data-looser', 'false')
    expect(confirmOnly).toHaveTextContent(/can never fire on its own/i)
  })

  it('says so when no cue overrides anything', async () => {
    usePlanStore.setState({ plan: mockServicePlan() })
    render(<TuningSettings />, { wrapper: Landmark })

    await screen.findByText(/no cue in this plan overrides the service default/i)
    expect(screen.queryByRole('list', { name: /cues with their own rules/i })).not.toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    planWithOverrides()
    const { container } = render(<TuningSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/default auto-fire threshold/i)

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations with the looser-than-default warning showing', async () => {
    planWithOverrides()
    const { container } = render(<TuningSettings />, { wrapper: Landmark })

    const slider = await screen.findByLabelText(/default auto-fire threshold/i)
    fireEvent.change(slider, { target: { value: '0.2' } })
    await screen.findByTestId('tuning-loose-warning')

    expect(await axe(container)).toHaveNoViolations()
  })
})
