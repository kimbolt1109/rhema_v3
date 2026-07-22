/**
 * The GO LIVE panel's contract — the safety assertions of Phase 5.
 *
 * Five of these tests are load-bearing rather than descriptive:
 *
 *  - **END only fires after a hold.** A short press must produce *zero* `goLive.end` calls. Ending
 *    a service by mis-click is unrecoverable; `HoldButton` guarantees the timing and this asserts
 *    the panel actually used it rather than a plain button.
 *  - **`partial` renders its own explanation and a retry.** Not "live", not "failed" — the panel
 *    has to say that OBS is streaming and recording *and* that the broadcast is not public, and
 *    offer a retry that goes back through `start` rather than a second GO LIVE.
 *  - **`reattached` says so.** Including that the elapsed clock is OBS's, not the button's.
 *  - **The recording indicator is independent of the live one.** Asserted in both directions, so a
 *    regression that derives one from the other fails here.
 *  - **A disabled GO LIVE states its reason.** As the button's accessible description, not as
 *    nearby decoration.
 *
 * Everything runs against `createMockVergerApi`: no OBS, no Google, no network.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { ok } from '@shared/result'

import '../i18n'
import { DEFAULT_HOLD_MS } from '../components/HoldButton'
import { resetGoLiveStore } from '../store/goLiveStore'
import { resetObsStore } from '../store/obsStore'
import { resetYouTubeStore } from '../store/youtubeStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_RECORDING_PATH,
  installMockVergerApi,
  mockConnectedStatus,
  mockFailedGoLiveState,
  mockLiveGoLiveState,
  mockObsOutputState,
  mockPartialGoLiveState,
  mockReattachedGoLiveState,
  mockSignedInYouTubeStatus,
  mockStartingGoLiveState,
  mockStreamingObsOutputState,
} from '../test/mockVergerApi'
import { GoLivePanel } from './GoLivePanel'

/** The panel lives inside `<main>` in App.tsx; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Wait until the panel has hydrated, so assertions never race the initial reads. */
async function ready(): Promise<HTMLElement> {
  return screen.findByTestId('go-live-button')
}

/** The two indicators, read as the operator reads them: by their words. */
function streamState(): string {
  return screen.getByTestId('live-indicator').getAttribute('data-stream-state') ?? ''
}

function recordState(): string {
  return screen.getByTestId('recording-indicator').getAttribute('data-record-state') ?? ''
}

describe('GoLivePanel', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    // Every test starts from a connected OBS; the disconnected case is asserted explicitly.
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    resetGoLiveStore()
    resetObsStore()
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('presses GO LIVE once and asks the main process to start — nothing more', async () => {
    const user = userEvent.setup()
    render(<GoLivePanel />, { wrapper: Landmark })
    const button = await ready()
    await waitFor(() => {
      expect(button).toBeEnabled()
    })

    await user.click(button)

    await waitFor(() => {
      expect(installed.mock.calls.goLiveStart).toHaveLength(1)
    })
    // Going live must not move a camera or touch an overlay layer.
    expect(installed.mock.calls.goLiveEnd).toEqual([])
    expect(installed.mock.calls.cameraSelect).toEqual([])
    expect(installed.mock.calls.overlaySend).toEqual([])
  })

  it('starts the local recording alongside the stream — Standing Rule 3, through the UI', async () => {
    const user = userEvent.setup()
    render(<GoLivePanel />, { wrapper: Landmark })
    const button = await ready()
    await waitFor(() => {
      expect(button).toBeEnabled()
    })

    await user.click(button)

    await waitFor(() => {
      expect(recordState()).toBe('recording')
    })
    expect(streamState()).toBe('live')
  })

  it('shows WHICH step is running while starting, not a spinner', async () => {
    installed.mock.responses.goLiveGetState = ok(mockStartingGoLiveState('record'))
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    const list = await screen.findByRole('list', { name: /go live steps/i })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(5)

    await waitFor(() => {
      expect(list.querySelector('[data-step="record"]')).toHaveAttribute(
        'data-step-state',
        'running',
      )
    })
    expect(list.querySelector('[data-step="broadcast"]')).toHaveAttribute('data-step-state', 'done')
    expect(list.querySelector('[data-step="health"]')).toHaveAttribute('data-step-state', 'pending')
    // The step is named in words, in the row and in the announcement.
    expect(within(list).getByText(/start the local recording/i)).toBeInTheDocument()
    expect(
      screen.getByText(/step in progress: start the local recording/i),
    ).toBeInTheDocument()
  })

  it('names the failed step after a failure, and says nothing was stopped in response', async () => {
    installed.mock.responses.goLiveGetState = ok(mockFailedGoLiveState())
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    await screen.findByRole('alert', { name: /go live did not finish/i })
    const list = screen.getByRole('list', { name: /go live steps/i })
    expect(list.querySelector('[data-step="stream"]')).toHaveAttribute('data-step-state', 'failed')
    expect(within(list).getByText('OBS refused StartStream.')).toBeInTheDocument()
    expect(screen.getByText(/verger has not stopped anything in response/i)).toBeInTheDocument()
  })

  it('renders the partial phase as its own thing, with a retry that starts nothing new', async () => {
    const user = userEvent.setup()
    installed.mock.responses.goLiveGetState = ok(mockPartialGoLiveState())
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    // Both true things, said plainly, in one place.
    const panel = await screen.findByRole('alert', { name: /not public on youtube/i })
    expect(within(panel).getByText(/still running/i)).toBeInTheDocument()
    expect(within(panel).getByText(/not happening: the broadcast is not public/i)).toBeInTheDocument()
    // The indicator refuses to say plain "LIVE" here.
    expect(streamState()).toBe('not-public')
    expect(screen.getByTestId('live-indicator')).toHaveTextContent(/streaming — not public/i)
    // …while the recording indicator still, correctly, says RECORDING.
    expect(recordState()).toBe('recording')

    // GO LIVE itself is off — pressing it again would push a second stream — and says why.
    const goLive = screen.getByTestId('go-live-button')
    expect(goLive).toBeDisabled()
    expect(goLive).toHaveAccessibleDescription(/would push a second stream/i)

    await user.click(within(panel).getByRole('button', { name: /retry the youtube transition/i }))
    await waitFor(() => {
      expect(installed.mock.calls.goLiveStart).toHaveLength(1)
    })
    expect(installed.mock.calls.goLiveEnd).toEqual([])
  })

  it('says it re-attached, and that the clock is OBS’s rather than the button’s', async () => {
    installed.mock.responses.goLiveGetState = ok(mockReattachedGoLiveState())
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    await screen.findByRole('region', { name: /re-attached to a stream already in progress/i })
    expect(screen.getByText(/adopted that service instead of beginning a second one/i)).toBeInTheDocument()
    expect(
      screen.getAllByText(/the elapsed time above comes from obs/i).length,
    ).toBeGreaterThan(0)
    // Nothing was started by this render.
    expect(installed.mock.calls.goLiveStart).toEqual([])
  })

  it('shows the recording indicator independently of the live one, in both directions', async () => {
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    // Recording with no stream: the local backup is running and the panel says so.
    act(() => {
      installed.mock.emit(
        IpcEvent.goLiveState,
        mockLiveGoLiveState({
          phase: 'idle',
          liveSince: null,
          obs: mockObsOutputState({ recording: true, recordTimecodeMs: 65_000 }),
        }),
      )
    })
    await waitFor(() => {
      expect(recordState()).toBe('recording')
    })
    expect(streamState()).toBe('off')
    expect(screen.getByTestId('record-elapsed')).toHaveTextContent('1:05')

    // The mirror image, which must never happen: streaming with no recording. It is called out
    // loudly rather than shrugged off, and the stream is emphatically not stopped over it.
    act(() => {
      installed.mock.emit(
        IpcEvent.goLiveState,
        mockLiveGoLiveState({ obs: mockStreamingObsOutputState({ recording: false }) }),
      )
    })
    await waitFor(() => {
      expect(recordState()).toBe('off')
    })
    expect(streamState()).toBe('live')
    await screen.findByRole('alert', { name: /nothing is being recorded/i })
    expect(installed.mock.calls.goLiveEnd).toEqual([])
  })

  it('shows the recording file path once OBS reports it', async () => {
    installed.mock.responses.goLiveGetState = ok(mockLiveGoLiveState())
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(screen.getByTestId('recording-path')).toHaveTextContent(MOCK_RECORDING_PATH)
    })
    expect(screen.getByText(/this file is your backup/i)).toBeInTheDocument()
  })

  it('reports dropped frames and the daily-quota note', async () => {
    installed.mock.responses.goLiveGetState = ok(
      mockLiveGoLiveState({
        obs: mockStreamingObsOutputState({ skippedFrames: 50, totalFrames: 1000 }),
      }),
    )
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(screen.getByTestId('dropped-frames')).toHaveTextContent('50 of 1000 (5.0%)')
    })
    expect(screen.getByText(/a few services a day sits comfortably inside it/i)).toBeInTheDocument()
  })

  it('explains that YouTube is not set up and what GO LIVE will still do', async () => {
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    // The fake's default is a machine with no GOOGLE_CLIENT_ID. That is this machine.
    const panel = await screen.findByRole('region', {
      name: /youtube is not set up — go live will stream and record, but publish nothing/i,
    })
    expect(within(panel).getByText(/tell obs to start the local recording/i)).toBeInTheDocument()
    expect(within(panel).getByText(/create a broadcast on youtube/i)).toBeInTheDocument()
    expect(within(panel).getByText(/no watch link is produced/i)).toBeInTheDocument()
    // And GO LIVE is still usable: it streams and records, it just publishes nothing.
    expect(screen.getByTestId('go-live-button')).toBeEnabled()
  })

  it('drops the not-configured notice once YouTube is signed in', async () => {
    installed.mock.responses.youtubeGetStatus = ok(mockSignedInYouTubeStatus())
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: /youtube is not set up/i }),
      ).not.toBeInTheDocument()
    })
  })

  it('disables GO LIVE with a stated reason when OBS is not connected', async () => {
    const user = userEvent.setup()
    installed.mock.responses.getStatus = ok(mockConnectedStatus({ state: 'disconnected' }))
    render(<GoLivePanel />, { wrapper: Landmark })
    const button = await ready()

    await waitFor(() => {
      expect(button).toBeDisabled()
    })
    expect(button).toHaveAccessibleDescription(/not connected to obs/i)
    expect(screen.getByTestId('go-live-disabled-reason')).toHaveTextContent(
      /open the connection screen and connect/i,
    )

    // A disabled button cannot be clicked into a request.
    await user.click(button)
    expect(installed.mock.calls.goLiveStart).toEqual([])
  })

  it('disables GO LIVE with a reason when the preload bridge is missing', async () => {
    installed.restore()
    delete window.verger
    resetGoLiveStore()
    resetObsStore()
    resetYouTubeStore()

    render(<GoLivePanel />, { wrapper: Landmark })
    const button = await ready()

    await screen.findByRole('region', { name: /privileged bridge did not load/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(/cannot reach its own main process/i)

    installed = installMockVergerApi()
  })
})

/**
 * END, on fake timers.
 *
 * Separated into its own describe so the one-second elapsed clock and the hold timer are both
 * driven deliberately. `fireEvent` rather than `userEvent` for the same reason `HoldButton`'s own
 * suite uses it: a real 1.5-second wait is slow and flaky, and the component accumulates elapsed
 * time from interval ticks precisely so it is deterministic under fake timers.
 */
describe('GoLivePanel END', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.goLiveGetState = ok(mockLiveGoLiveState())
    resetGoLiveStore()
    resetObsStore()
    resetYouTubeStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    installed.restore()
  })

  /** Advance fake timers inside `act`, so the interval's state updates are flushed. */
  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  async function renderLive(): Promise<HTMLElement> {
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()
    const end = await screen.findByRole('button', { name: /end the service/i })
    await waitFor(() => {
      expect(end).toBeEnabled()
    })
    return end
  }

  it('does NOTHING on a short press — a mis-click cannot end a service', async () => {
    const end = await renderLive()
    vi.useFakeTimers()

    fireEvent.pointerDown(end)
    advance(DEFAULT_HOLD_MS - 200)
    fireEvent.pointerUp(end)
    advance(5000)

    expect(installed.mock.calls.goLiveEnd).toEqual([])
  })

  it('ends the service only after the full hold', async () => {
    const end = await renderLive()
    vi.useFakeTimers()

    fireEvent.pointerDown(end)
    advance(DEFAULT_HOLD_MS - 100)
    expect(installed.mock.calls.goLiveEnd).toEqual([])

    advance(200)
    expect(installed.mock.calls.goLiveEnd).toHaveLength(1)
  })

  it('says in its accessible name that END must be held', async () => {
    const end = await renderLive()
    expect(end).toHaveAccessibleName(/hold for 1\.5 seconds/i)
  })

  it('is disabled, with a reason, when there is nothing to end', async () => {
    installed.mock.responses.goLiveGetState = ok(
      // Idle: nothing streaming, nothing recording.
      mockLiveGoLiveState({ phase: 'idle', liveSince: null, obs: mockObsOutputState() }),
    )
    resetGoLiveStore()
    render(<GoLivePanel />, { wrapper: Landmark })
    await ready()

    const end = await screen.findByRole('button', { name: /end the service/i })
    await waitFor(() => {
      expect(end).toBeDisabled()
    })
    expect(screen.getByText(/nothing is streaming or recording, so there is nothing to end/i))
      .toBeInTheDocument()
  })
})

describe('GoLivePanel accessibility', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    resetGoLiveStore()
    resetObsStore()
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('has no axe violations while idle and not configured', async () => {
    const { container } = render(<GoLivePanel />, { wrapper: Landmark })
    await ready()
    await screen.findByRole('region', { name: /youtube is not set up/i })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations in the partial phase, which is the busiest one', async () => {
    installed.mock.responses.goLiveGetState = ok(mockPartialGoLiveState())
    const { container } = render(<GoLivePanel />, { wrapper: Landmark })
    await ready()
    await screen.findByRole('alert', { name: /not public on youtube/i })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations while live and re-attached', async () => {
    installed.mock.responses.goLiveGetState = ok(mockReattachedGoLiveState())
    const { container } = render(<GoLivePanel />, { wrapper: Landmark })
    await ready()
    await screen.findByRole('region', { name: /re-attached/i })

    expect(await axe(container)).toHaveNoViolations()
  })
})
