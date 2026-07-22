/**
 * The status dashboard's contract.
 *
 * These assertions are about what the screen *says*, because on this screen the words are the
 * feature:
 *
 *  1. **OBS down with the stream fine still reads "the service is going out."** This is the whole
 *     point of `isServiceStillGoingOut` and of Standing Rule 2, and it is the assertion most likely
 *     to be broken by a well-meaning refactor that rolls the worst light up into the headline. If
 *     that ever happens, an operator sees a red banner mid-service and stops a broadcast that was
 *     going out perfectly well.
 *  2. **`stillWorks` is rendered for every degraded and down subsystem.** The reassurance is the
 *     reason it is safe to show the fault at all.
 *  3. **`not-configured` never appears as a problem.** A permanently amber console is worse than
 *     no console.
 *  4. **The checkpoint restore cannot be clicked into**, and it states its non-effects — the stream
 *     and the recording — in words, next to the control.
 *  5. Axe is clean, on the strip and on the full view.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { ok } from '@shared/result'

import '../i18n'
import { DEFAULT_HOLD_MS } from '../components/HoldButton'
import { resetHealthStore, useHealthStore } from '../store/healthStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_NOW,
  installMockVergerApi,
  mockHealthySnapshot,
  mockObsDownHealthSnapshot,
  mockOffAirHealthSnapshot,
  mockStreamReconnectingSnapshot,
} from '../test/mockVergerApi'
import { StatusDashboard, StatusStrip } from './StatusDashboard'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Advance fake timers inside `act`, so the hold interval's state updates flush. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('StatusDashboard', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetHealthStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('ANSWERS "THE SERVICE IS STILL GOING OUT" WHEN OBS IS DOWN BUT THE STREAM IS FINE', async () => {
    installed.mock.responses.healthGet = ok(mockObsDownHealthSnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    // The OBS light is genuinely down — the dashboard is not softening the fault…
    // (it appears twice: once in the strip of lights, once as a problem card).
    const obs = within(screen.getByRole('region', { name: /subsystem lights/i })).getByRole(
      'group',
      { name: /OBS/ },
    )
    expect(obs).toHaveAttribute('data-health-level', 'down')

    // …and the headline still says the congregation is being served.
    const answer = screen.getByTestId('service-answer')
    expect(answer).toHaveAttribute('data-going-out', 'true')
    expect(within(answer).getByText(/the service is still going out/i)).toBeInTheDocument()
    expect(within(answer).queryByText(/nothing is going out/i)).not.toBeInTheDocument()
    // In so many words: do not stop anything.
    expect(answer.textContent).toMatch(/do not stop anything/i)
  })

  it('says "no" only when neither the stream nor the recording is running', async () => {
    installed.mock.responses.healthGet = ok(mockOffAirHealthSnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    const answer = screen.getByTestId('service-answer')
    expect(answer).toHaveAttribute('data-going-out', 'false')
    expect(within(answer).getByText(/nothing is going out/i)).toBeInTheDocument()
  })

  it('prints the detail AND what still works for every degraded and down subsystem', async () => {
    installed.mock.responses.healthGet = ok(mockStreamReconnectingSnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    const stream = screen.getByTestId('health-problem-stream')
    expect(within(stream).getByText(/reconnecting \(attempt 3\)/i)).toBeInTheDocument()
    // The reassurance, verbatim. This is the sentence that stops somebody ending a service.
    expect(screen.getByTestId('health-still-works-stream').textContent).toContain(
      'The local recording is unaffected',
    )

    const asr = screen.getByTestId('health-problem-asr')
    expect(within(asr).getByText(/running on the local model/i)).toBeInTheDocument()
    expect(screen.getByTestId('health-still-works-asr').textContent).toContain(
      'still arriving, just from the fallback',
    )
  })

  it('never lists a not-configured subsystem as a problem', async () => {
    // The default snapshot is this machine's genuine state: nothing configured, nothing wrong.
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    const attention = screen.getByTestId('health-attention')
    expect(within(attention).getByText(/nothing needs attention/i)).toBeInTheDocument()
    expect(screen.queryByTestId('health-problem-youtube')).not.toBeInTheDocument()
    // But the light itself is still shown, resting.
    expect(screen.getByRole('group', { name: /YouTube/ })).toHaveAttribute(
      'data-health-level',
      'not-configured',
    )
  })

  it('reloads the overlays through the bridge', async () => {
    const user = userEvent.setup()
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    await user.click(screen.getByRole('button', { name: /reload the overlays/i }))

    await waitFor(() => {
      expect(installed.mock.calls.healthReloadOverlays).toHaveLength(1)
    })
    // And it did not go anywhere near the broadcast.
    expect(installed.mock.calls.goLiveStart).toHaveLength(0)
    expect(installed.mock.calls.goLiveEnd).toHaveLength(0)
  })

  it('states plainly that recovery cannot stop the stream or the recording', async () => {
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    expect(screen.getByTestId('recovery-no-broadcast-impact').textContent).toMatch(
      /nothing on this panel can stop the stream or the recording/i,
    )

    const nonEffects = screen.getByTestId('checkpoint-non-effects').textContent ?? ''
    expect(nonEffects).toMatch(/rewinds automation only/i)
    expect(nonEffects).toMatch(/does NOT touch the stream/i)
    expect(nonEffects).toMatch(/does NOT touch the recording/i)
  })

  it('CANNOT BE CLICKED INTO A CHECKPOINT RESTORE — it takes a deliberate hold', async () => {
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    vi.useFakeTimers()
    try {
      render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

      const button = screen.getByRole('button', { name: /rewind automation/i })
      // The hold duration is part of the accessible name, so nobody presses Enter and wonders.
      expect(button).toHaveAccessibleName(/hold for/i)

      fireEvent.click(button)
      expect(installed.mock.calls.healthRestoreCheckpoint).toHaveLength(0)

      // A hold released early is also nothing at all.
      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS - 300)
      fireEvent.pointerUp(button)
      advance(2_000)
      expect(installed.mock.calls.healthRestoreCheckpoint).toHaveLength(0)

      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS + 100)
      // Defaults to the newest checkpoint, which is what a bad cue wants undone.
      expect(installed.mock.calls.healthRestoreCheckpoint).toEqual([
        { checkpointId: 'checkpoint-3' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the checkpoint the operator picked, and leaves the broadcast alone', async () => {
    const user = userEvent.setup()
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })

    await user.click(within(screen.getByTestId('checkpoint-checkpoint-1')).getByRole('radio'))

    vi.useFakeTimers()
    try {
      const button = screen.getByRole('button', { name: /rewind automation/i })
      fireEvent.pointerDown(button)
      advance(DEFAULT_HOLD_MS + 100)
    } finally {
      vi.useRealTimers()
    }

    await waitFor(() => {
      expect(installed.mock.calls.healthRestoreCheckpoint).toEqual([
        { checkpointId: 'checkpoint-1' },
      ])
    })

    const snapshot = useHealthStore.getState().snapshot
    expect(snapshot.subsystems.find((entry) => entry.id === 'stream')?.level).toBe('ok')
    expect(snapshot.subsystems.find((entry) => entry.id === 'recording')?.level).toBe('ok')
    expect(installed.mock.calls.goLiveEnd).toHaveLength(0)
  })

  it('is axe clean', async () => {
    installed.mock.responses.healthGet = ok(mockObsDownHealthSnapshot())
    await useHealthStore.getState().hydrate()

    const { container } = render(<StatusDashboard now={MOCK_NOW} />, { wrapper: Landmark })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('StatusStrip', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetHealthStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('carries a light per subsystem plus the answer, always visible', async () => {
    installed.mock.responses.healthGet = ok(mockObsDownHealthSnapshot())
    await useHealthStore.getState().hydrate()

    render(<StatusStrip now={MOCK_NOW} />, { wrapper: Landmark })

    const lights = within(screen.getByRole('list', { name: /subsystem status/i })).getAllByRole(
      'group',
    )
    expect(lights).toHaveLength(useHealthStore.getState().snapshot.subsystems.length)

    const answer = screen.getByTestId('service-answer-compact')
    expect(answer).toHaveAttribute('data-going-out', 'true')
    expect(answer.textContent).toMatch(/still going out/i)
  })

  it('updates from a pushed snapshot without anyone opening the dashboard', async () => {
    await useHealthStore.getState().hydrate()

    function Wired(): React.JSX.Element {
      const subscribe = useHealthStore((state) => state.subscribe)
      useEffect(() => subscribe(), [subscribe])
      return <StatusStrip now={MOCK_NOW} />
    }

    render(<Wired />, { wrapper: Landmark })
    expect(screen.getByRole('group', { name: /OBS/ })).toHaveAttribute(
      'data-health-level',
      'not-configured',
    )

    act(() => {
      installed.mock.emit(IpcEvent.healthSnapshot, mockObsDownHealthSnapshot())
    })

    await waitFor(() => {
      expect(screen.getByRole('group', { name: /OBS/ })).toHaveAttribute('data-health-level', 'down')
    })
    // Still going out. A red OBS light is not a catastrophe on this strip either.
    expect(screen.getByTestId('service-answer-compact')).toHaveAttribute('data-going-out', 'true')
  })

  it('is axe clean', async () => {
    installed.mock.responses.healthGet = ok(mockStreamReconnectingSnapshot())
    await useHealthStore.getState().hydrate()

    const { container } = render(<StatusStrip now={MOCK_NOW} />, { wrapper: Landmark })
    expect(await axe(container)).toHaveNoViolations()
  })
})
