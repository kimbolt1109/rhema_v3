/**
 * The suggestion panel's contract.
 *
 * This is the surface an operator judges in about a second, so the assertions are about what is
 * legible and what is refused, in that order:
 *
 *  1. A pending suggestion states WHAT would happen, WHY, how confident, and which detector said
 *     so — all four, always.
 *  2. CONFIRM and DISMISS call through, and both are reachable from the keyboard actions that
 *     already exist in `@shared/actions` (Y / N).
 *  3. **An unresolved scripture suggestion says "text unavailable" and does not present itself as
 *     auto-firing**, even in auto mode with a suggestion the engine marked fireable. This is the
 *     never-auto-show-unless-resolved gate, re-asserted on the renderer's side.
 *  4. With nothing pending there is no large empty box — a compact readout instead.
 *  5. No axe violations, pending or idle.
 *
 * Every fixture is a placeholder. No verse text and no sermon text appears in this file
 * (Standing Rule 4).
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ActionId } from '@shared/actions'
import type { CueEngineState } from '@shared/cue'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import '../i18n'
import { createActionDispatcher } from '../input/ActionDispatcher'
import { resetCueStore, useCueStore } from '../store/cueStore'
import { resetPlanStore, usePlanStore } from '../store/planStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_VERSE_TEXT_PLACEHOLDER,
  installMockVergerApi,
  mockCueSuggestion,
  mockHotPhraseSuggestion,
  mockPendingCueEngineState,
  mockPlanState,
  mockScriptureSuggestion,
} from '../test/mockVergerApi'
import { SuggestionPanel, confidencePercent } from './SuggestionPanel'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Hydrate both stores the way the shell does, and wait for any verse fetch to settle. */
async function boot(installed: InstalledMockVergerApi, state: CueEngineState): Promise<void> {
  installed.mock.responses.planGetState = ok(mockPlanState())
  installed.mock.responses.cueGetState = ok(state)
  await usePlanStore.getState().hydrate()
  await useCueStore.getState().hydrate()
  await waitFor(() => {
    expect(useCueStore.getState().resolving).toBe(false)
  })
}

describe('confidencePercent', () => {
  it('rounds once, so every readout agrees', () => {
    expect(confidencePercent(0.865)).toBe(87)
    expect(confidencePercent(0.95)).toBe(95)
    expect(confidencePercent(1)).toBe(100)
  })
})

describe('SuggestionPanel', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCueStore()
    resetPlanStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('states what would happen, why, how sure, and which detector said so', async () => {
    await boot(installed, mockPendingCueEngineState(mockCueSuggestion()))
    render(<SuggestionPanel />, { wrapper: Landmark })

    const panel = await screen.findByRole('region', { name: /suggested next action/i })
    expect(panel).toHaveAttribute('data-detector', 'plan')
    // The cue's own label, not its id: the operator reads the plan, not the database.
    expect(within(panel).getByTestId('cue-suggestion-what')).toHaveTextContent(/SLIDE 1/)
    expect(within(panel).getByTestId('cue-suggestion-why')).toHaveTextContent(
      /PLACEHOLDER ANCHOR PHRASE/,
    )
    expect(within(panel).getByTestId('cue-suggestion-confidence')).toHaveTextContent('86%')
    expect(within(panel).getByTestId('cue-suggestion-detector')).toHaveTextContent(/service plan/i)
  })

  it('names the detector for a hot phrase too, so the two are never confused', async () => {
    await boot(installed, mockPendingCueEngineState(mockHotPhraseSuggestion()))
    render(<SuggestionPanel />, { wrapper: Landmark })

    const panel = await screen.findByRole('region', { name: /suggested next action/i })
    expect(panel).toHaveAttribute('data-detector', 'hotphrase')
    expect(within(panel).getByTestId('cue-suggestion-detector')).toHaveTextContent(/hot phrase/i)
  })

  it('confirms through the bridge when CONFIRM is pressed', async () => {
    const user = userEvent.setup()
    await boot(installed, mockPendingCueEngineState(mockCueSuggestion()))
    render(<SuggestionPanel />, { wrapper: Landmark })

    await user.click(await screen.findByRole('button', { name: /confirm/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cueConfirm).toEqual([{ suggestionId: 'suggestion-1' }])
    })
  })

  it('dismisses through the bridge when DISMISS is pressed, and the card goes at once', async () => {
    const user = userEvent.setup()
    await boot(installed, mockPendingCueEngineState(mockCueSuggestion()))
    render(<SuggestionPanel />, { wrapper: Landmark })

    await user.click(await screen.findByRole('button', { name: /dismiss/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cueDismiss).toEqual([{ suggestionId: 'suggestion-1' }])
    })
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument()
  })

  it('answers to the Y and N actions, so a pedal works with no extra wiring', async () => {
    const dispatcher = createActionDispatcher()
    await boot(installed, mockPendingCueEngineState(mockCueSuggestion()))
    // The shell owns the subscription, so the test stands in for it.
    const unsubscribe = useCueStore.getState().subscribe()
    render(<SuggestionPanel dispatcher={dispatcher} />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /suggested next action/i })

    dispatcher.dispatch(ActionId.confirm, undefined, 'keyboard')
    await waitFor(() => {
      expect(installed.mock.calls.cueConfirm).toHaveLength(1)
    })

    installed.mock.emit(IpcEvent.cueSuggestion, mockCueSuggestion({ id: 'suggestion-2' }))
    await waitFor(() => {
      expect(useCueStore.getState().state.pending?.id).toBe('suggestion-2')
    })

    dispatcher.dispatch(ActionId.dismiss, undefined, 'keyboard')
    await waitFor(() => {
      expect(installed.mock.calls.cueDismiss).toEqual([{ suggestionId: 'suggestion-2' }])
    })
    unsubscribe()
  })

  it('shows the reference, the translation and the attribution once the text resolves', async () => {
    await boot(
      installed,
      mockPendingCueEngineState(mockScriptureSuggestion(), { mode: 'auto' }),
    )
    render(<SuggestionPanel />, { wrapper: Landmark })

    const detail = await screen.findByTestId('cue-scripture-detail')
    expect(detail).toHaveAttribute('data-resolution', 'resolved')
    expect(within(detail).getByText('John 3:16')).toBeInTheDocument()
    expect(within(detail).getByText(/요한복음 3:16/)).toBeInTheDocument()
    expect(within(detail).getByTestId('cue-scripture-translation')).toHaveTextContent('KJV')
    expect(within(detail).getByTestId('cue-scripture-attribution')).toHaveTextContent(
      /king james version/i,
    )
    // The card renders whatever text the provider supplied; it never authors any.
    expect(useCueStore.getState().resolved?.text).toBe(MOCK_VERSE_TEXT_PLACEHOLDER)
  })

  it('says TEXT UNAVAILABLE and refuses to look like it will auto-show', async () => {
    installed.mock.responses.cueResolveScripture = err(
      ErrorCode.NOT_CONFIGURED,
      'No Bible source is configured.',
    )
    // The worst case on purpose: auto mode, and a suggestion the engine itself marked fireable.
    await boot(
      installed,
      mockPendingCueEngineState(mockScriptureSuggestion({ canAutoFire: true }), { mode: 'auto' }),
    )
    render(<SuggestionPanel />, { wrapper: Landmark })

    const panel = await screen.findByRole('region', { name: /suggested next action/i })
    expect(await screen.findByTestId('cue-scripture-detail')).toHaveAttribute(
      'data-resolution',
      'unavailable',
    )
    expect(screen.getAllByText(/text unavailable/i).length).toBeGreaterThan(0)
    expect(screen.getByTestId('cue-no-auto-show')).toHaveTextContent(
      /will NOT be shown automatically/i,
    )
    expect(screen.getByText(/no bible source is configured/i)).toBeInTheDocument()

    // The claim that matters: nothing here says this is about to happen by itself.
    expect(panel).toHaveAttribute('data-auto-fire', 'false')
    expect(screen.getByTestId('cue-suggestion-consequence')).toHaveTextContent(
      /nothing happens until you confirm/i,
    )
    expect(screen.queryByText(/will fire by itself/i)).not.toBeInTheDocument()
  })

  it('does say so, plainly, when something really is about to fire by itself', async () => {
    await boot(
      installed,
      mockPendingCueEngineState(mockCueSuggestion({ canAutoFire: true }), { mode: 'auto' }),
    )
    render(<SuggestionPanel />, { wrapper: Landmark })

    const panel = await screen.findByRole('region', { name: /suggested next action/i })
    expect(panel).toHaveAttribute('data-auto-fire', 'true')
    expect(screen.getByTestId('cue-suggestion-consequence')).toHaveTextContent(
      /will fire by itself/i,
    )
  })

  it('refuses to confirm a suggestion whose cue has left the plan, and says why', async () => {
    await boot(
      installed,
      mockPendingCueEngineState(mockCueSuggestion({ cueId: 'cue-deleted-by-the-operator' })),
    )
    render(<SuggestionPanel />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /suggested next action/i })
    expect(screen.getByRole('alert')).toHaveTextContent(/not in the plan any more/i)
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled()
    // Dismiss still works — the operator must always be able to clear the card.
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeEnabled()
  })

  it('offers a one-tap BACK for the last fired suggestion', async () => {
    const user = userEvent.setup()
    await boot(
      installed,
      mockPendingCueEngineState(mockCueSuggestion({ id: 'suggestion-2' }), {
        recent: [mockCueSuggestion({ id: 'suggestion-1', cueId: 'cue-welcome' })],
      }),
    )
    render(<SuggestionPanel />, { wrapper: Landmark })

    await user.click(await screen.findByTestId('cue-undo'))

    await waitFor(() => {
      expect(installed.mock.calls.planBack).toHaveLength(1)
    })
  })

  it('renders a compact readout, not a large empty box, with nothing pending', async () => {
    await boot(installed, mockPendingCueEngineState(null, { position: 1 }))
    render(<SuggestionPanel />, { wrapper: Landmark })

    const panel = await screen.findByTestId('cue-suggestion-panel')
    expect(panel).toHaveAttribute('data-pending', 'false')
    expect(within(panel).getByTestId('cue-idle-mode')).toHaveTextContent(/assist/i)
    expect(within(panel).getByTestId('cue-idle-alignment')).toHaveTextContent(/following the plan/i)
    expect(within(panel).getByTestId('cue-idle-position')).toHaveTextContent(/SLIDE 1/)
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument()
  })

  it('shows HALTED rather than a mode when automation is panicked', async () => {
    await boot(installed, mockPendingCueEngineState(null, { panicked: true }))
    render(<SuggestionPanel />, { wrapper: Landmark })

    expect(await screen.findByTestId('cue-idle-mode')).toHaveTextContent(/halted/i)
  })

  it('has no axe violations with a suggestion pending', async () => {
    await boot(installed, mockPendingCueEngineState(mockCueSuggestion()))
    const { container } = render(<SuggestionPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /suggested next action/i })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations with an unresolvable scripture suggestion', async () => {
    installed.mock.responses.cueResolveScripture = err(ErrorCode.NOT_FOUND, 'not found')
    await boot(installed, mockPendingCueEngineState(mockScriptureSuggestion()))
    const { container } = render(<SuggestionPanel />, { wrapper: Landmark })
    await screen.findByTestId('cue-no-auto-show')

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations while idle', async () => {
    await boot(installed, mockPendingCueEngineState(null))
    const { container } = render(<SuggestionPanel />, { wrapper: Landmark })
    await screen.findByTestId('cue-suggestion-panel')

    expect(await axe(container)).toHaveNoViolations()
  })
})
