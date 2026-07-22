/**
 * The trust dial's contract, and the hot-phrase editor's.
 *
 * The dial is where an operator decides how much this app may do without asking, so the assertions
 * are about persuasion as much as behaviour:
 *
 *  1. **Assist is visibly the default and the recommendation**, in words, not by position.
 *  2. **Auto carries a plainly worded caution** that a cue reaches the congregation screen before
 *     they are asked.
 *  3. **PANIC cannot be clicked into.** It takes a deliberate hold, and its label and group name
 *     both state the non-effects — the stream, the recording and the screen are untouched — because
 *     that reassurance is the only reason an operator will dare press it mid-service.
 *  4. **A panicked engine is unmistakable and stays panicked** until an explicit RESUME.
 *
 * The hot-phrase editor is exercised here rather than in a file of its own because Phase 8's file
 * allocation gives it no test file; its two load-bearing behaviours — the short-phrase warning and
 * binding to a cue — are asserted at the bottom, along with its axe pass.
 *
 * All fixtures are placeholders (Standing Rule 4).
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCueEngineSettings } from '@shared/cue'
import { ok } from '@shared/result'

import '../i18n'
import { HotPhraseEditor, isRiskilyShort, rejectHotPhrase } from '../screens/HotPhraseEditor'
import { resetCueStore, useCueStore } from '../store/cueStore'
import { resetPlanStore, usePlanStore } from '../store/planStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  installMockVergerApi,
  mockHotPhrase,
  mockPanickedCueEngineState,
  mockPlanState,
} from '../test/mockVergerApi'
import { DEFAULT_HOLD_MS } from './HoldButton'
import { TrustDial } from './TrustDial'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Advance fake timers inside `act`, so the hold interval's state updates flush. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('TrustDial', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCueStore()
    resetPlanStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('marks assist as both the default and the recommended mode', async () => {
    await useCueStore.getState().hydrate()
    render(<TrustDial />, { wrapper: Landmark })

    const assist = await screen.findByTestId('trust-mode-assist')
    expect(assist).toHaveAttribute('data-recommended', 'true')
    expect(assist).toHaveAttribute('aria-checked', 'true')
    expect(within(assist).getByText(/^default$/i)).toBeInTheDocument()
    expect(within(assist).getByText(/^recommended$/i)).toBeInTheDocument()

    for (const mode of ['auto', 'manual']) {
      const option = screen.getByTestId(`trust-mode-${mode}`)
      expect(option).toHaveAttribute('data-recommended', 'false')
      expect(within(option).queryByText(/^recommended$/i)).not.toBeInTheDocument()
    }
  })

  it('cautions plainly that Auto acts before it asks', async () => {
    await useCueStore.getState().hydrate()
    render(<TrustDial />, { wrapper: Landmark })

    const caution = await screen.findByTestId('trust-auto-caution')
    expect(caution).toHaveTextContent(/without asking you first/i)
    expect(caution).toHaveTextContent(/veto/i)
  })

  it('changes the mode through the bridge', async () => {
    const user = userEvent.setup()
    await useCueStore.getState().hydrate()
    render(<TrustDial />, { wrapper: Landmark })

    await user.click(await screen.findByTestId('trust-mode-auto'))

    await waitFor(() => {
      expect(installed.mock.calls.cueSetMode).toEqual(['auto'])
    })
    expect(await screen.findByTestId('trust-dial')).toHaveAttribute('data-mode', 'auto')
  })

  it('states, on the control itself, what PANIC does NOT do', async () => {
    await useCueStore.getState().hydrate()
    render(<TrustDial />, { wrapper: Landmark })

    const group = await screen.findByTestId('panic-control')
    // The group's accessible name carries the whole promise, so a screen-reader user hears it
    // before they reach the button rather than after.
    expect(group).toHaveAccessibleName(/halts automation only/i)
    expect(group).toHaveAccessibleName(/does not stop the stream/i)
    expect(group).toHaveAccessibleName(/does not stop the recording/i)
    expect(group).toHaveAccessibleName(/does not clear the screen/i)

    expect(within(group).getByText(/it does not stop the stream/i)).toBeInTheDocument()
    expect(within(group).getByText(/it does not stop the local recording/i)).toBeInTheDocument()
    expect(within(group).getByText(/it does not clear the congregation screen/i)).toBeInTheDocument()

    // And the button's own label says what it stops and what it does not.
    expect(within(group).getByRole('button')).toHaveAccessibleName(
      /stop automation, not the stream/i,
    )
  })

  it('cannot be clicked into PANIC — it takes a deliberate hold', async () => {
    vi.useFakeTimers()
    try {
      await useCueStore.getState().hydrate()
      render(<TrustDial />, { wrapper: Landmark })

      const button = within(screen.getByTestId('panic-control')).getByRole('button')

      fireEvent.click(button)
      expect(installed.mock.calls.cuePanic).toHaveLength(0)

      // A hold that is released early is also nothing at all.
      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS - 300)
      fireEvent.pointerUp(button)
      advance(2000)
      expect(installed.mock.calls.cuePanic).toHaveLength(0)

      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS + 100)
      expect(installed.mock.calls.cuePanic).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('halts automation locally the instant the hold completes', async () => {
    vi.useFakeTimers()
    try {
      await useCueStore.getState().hydrate()
      render(<TrustDial />, { wrapper: Landmark })

      const button = within(screen.getByTestId('panic-control')).getByRole('button')
      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS + 100)

      expect(useCueStore.getState().state.panicked).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a panicked engine unmistakably and requires an explicit resume', async () => {
    const user = userEvent.setup()
    installed.mock.responses.cueGetState = ok(mockPanickedCueEngineState())
    await useCueStore.getState().hydrate()
    render(<TrustDial />, { wrapper: Landmark })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/automation halted/i)
    expect(alert).toHaveTextContent(/stream, the local recording and the congregation screen are/i)

    // The dial is locked: choosing a mode is not a way back.
    for (const mode of ['assist', 'auto', 'manual']) {
      expect(screen.getByTestId(`trust-mode-${mode}`)).toBeDisabled()
    }
    expect(screen.getByTestId('trust-current')).toHaveTextContent(/locked while automation is halted/i)
    // And PANIC itself is spent — holding it again would do nothing.
    expect(within(screen.getByTestId('panic-control')).getByRole('button')).toBeDisabled()

    await user.click(screen.getByTestId('panic-resume'))

    await waitFor(() => {
      expect(installed.mock.calls.cueResume).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('panic-active')).not.toBeInTheDocument()
    })
  })

  it('has no axe violations at rest', async () => {
    await useCueStore.getState().hydrate()
    const { container } = render(<TrustDial />, { wrapper: Landmark })
    await screen.findByTestId('trust-dial')

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations while panicked', async () => {
    installed.mock.responses.cueGetState = ok(mockPanickedCueEngineState())
    await useCueStore.getState().hydrate()
    const { container } = render(<TrustDial />, { wrapper: Landmark })
    await screen.findByTestId('panic-active')

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('rejectHotPhrase / isRiskilyShort', () => {
  it('warns about anything short enough to turn up inside ordinary speech', () => {
    expect(isRiskilyShort('go')).toBe(true)
    expect(isRiskilyShort('기도')).toBe(true)
    expect(isRiskilyShort('pray')).toBe(false)
    expect(isRiskilyShort('')).toBe(false)
  })

  it('refuses what the settings schema would refuse anyway', () => {
    expect(rejectHotPhrase('a', [])).toBe('too-short')
    expect(rejectHotPhrase('  ', [])).toBe('too-short')
    expect(rejectHotPhrase('let us pray', [mockHotPhrase({ phrase: 'LET US PRAY' })])).toBe(
      'duplicate',
    )
    expect(rejectHotPhrase('let us pray', [])).toBeNull()
  })
})

describe('HotPhraseEditor', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCueStore()
    resetPlanStore()
  })

  afterEach(() => {
    installed.restore()
  })

  async function boot(): Promise<void> {
    installed.mock.responses.planGetState = ok(mockPlanState())
    await usePlanStore.getState().hydrate()
    await useCueStore.getState().hydrate()
  }

  it('warns while a dangerously short phrase is still being typed', async () => {
    const user = userEvent.setup()
    await boot()
    render(<HotPhraseEditor />, { wrapper: Landmark })

    await user.type(screen.getByLabelText(/^phrase$/i), 'go')

    expect(await screen.findByTestId('hot-phrase-draft-warning')).toHaveTextContent(
      /fire when nobody meant it to/i,
    )
  })

  it('adds a phrase bound to a cue and saves it through the bridge', async () => {
    const user = userEvent.setup()
    await boot()
    render(<HotPhraseEditor />, { wrapper: Landmark })

    await user.type(screen.getByLabelText(/^phrase$/i), 'PLACEHOLDER SPOKEN PHRASE')
    await user.click(screen.getByTestId('hot-phrase-add'))

    await waitFor(() => {
      expect(installed.mock.calls.cueSetSettings).toHaveLength(1)
    })
    const saved = installed.mock.calls.cueSetSettings[0]?.hotPhrases[0]
    expect(saved?.phrase).toBe('PLACEHOLDER SPOKEN PHRASE')
    expect(saved?.cueId).toBe('cue-welcome')
    expect(saved?.enabled).toBe(true)
  })

  it('refuses a phrase too short for the settings schema, and says so', async () => {
    const user = userEvent.setup()
    await boot()
    render(<HotPhraseEditor />, { wrapper: Landmark })

    await user.type(screen.getByLabelText(/^phrase$/i), 'a')
    await user.click(screen.getByTestId('hot-phrase-add'))

    expect(await screen.findByTestId('hot-phrase-rejection')).toHaveTextContent(/too short/i)
    expect(installed.mock.calls.cueSetSettings).toHaveLength(0)
  })

  it('flags an already-saved short phrase, and can disable or remove it', async () => {
    const user = userEvent.setup()
    installed.mock.responses.cueGetSettings = ok({
      ...defaultCueEngineSettings(),
      hotPhrases: [mockHotPhrase({ id: 'short-one', phrase: '기도', cueId: 'cue-welcome' })],
    })
    await boot()
    render(<HotPhraseEditor />, { wrapper: Landmark })

    const row = await screen.findByTestId('hot-phrase-short-one')
    expect(row).toHaveAttribute('data-short', 'true')

    await user.click(within(row).getByRole('checkbox'))
    await waitFor(() => {
      expect(installed.mock.calls.cueSetSettings).toHaveLength(1)
    })
    expect(installed.mock.calls.cueSetSettings[0]?.hotPhrases[0]?.enabled).toBe(false)
  })

  it('says there is nothing to bind to rather than offering an empty picker', async () => {
    await useCueStore.getState().hydrate()
    render(<HotPhraseEditor />, { wrapper: Landmark })

    expect(await screen.findByText(/no cues to bind to yet/i)).toBeInTheDocument()
    expect(screen.getByTestId('hot-phrase-add')).toBeDisabled()
  })

  it('has no axe violations with a phrase list on screen', async () => {
    installed.mock.responses.cueGetSettings = ok({
      ...defaultCueEngineSettings(),
      hotPhrases: [
        mockHotPhrase({ id: 'phrase-a', phrase: 'PLACEHOLDER PHRASE A' }),
        mockHotPhrase({ id: 'phrase-b', phrase: '기도' }),
      ],
    })
    await boot()
    const { container } = render(<HotPhraseEditor />, { wrapper: Landmark })
    await screen.findByTestId('hot-phrase-phrase-a')

    expect(await axe(container)).toHaveNoViolations()
  })
})
