/**
 * The bottom bar's contract — the only chrome left on the operating surface after the TASK 2
 * redesign, and therefore the only place some facts are visible at all.
 *
 * Two assertions in this file are the load-bearing ones:
 *
 *  1. **`percent: null` is not `0%`.** The bar's fill *is* the cue engine's match confidence, so
 *     "the engine has nothing pending" and "the engine reported almost no confidence" must not
 *     render identically. The honest readout is an em dash, an empty fill, and — the part a
 *     screen reader depends on — **no `aria-valuenow` attribute at all**, because an indeterminate
 *     progressbar that claims `0` is lying about a measurement it never took. An operator who
 *     learns that the big number sometimes means nothing stops reading the big number.
 *  2. **A single tap cannot end a live service.** Standing Rule 6: high-stakes actions get a
 *     deliberate hold, never a tap. Ending stops the stream *and* the always-on local recording,
 *     so `endNeedsHold` swaps the plain END for a {@link HoldButton} and a click must be inert.
 *     An absence cannot be seen on a screenshot, so it is asserted against a recording fake.
 *
 * Standing Rule 3's `No rec` alert is the third: streaming-without-recording is the one failure
 * the operator has to see instantly, because no amount of fixing it afterwards gets the service
 * back. It is a `role="alert"`, and it is asserted to be mutually exclusive with the quiet `Rec`
 * pill so a fault can never be mistaken for the healthy state.
 *
 * ## Why a fixed model rather than nine stores
 *
 * `BottomBar` takes optional `model`/`actions` props precisely so a test can inject a
 * {@link BottomBarModel} and a recording {@link BottomBarActions}. Driving this through
 * `cueStore` + `goLiveStore` + `obsStore` + `overlayStore` + `cameraStore` + `planStore` would
 * test those stores' projections, not the bar's rendering, and would couple this file to six
 * modules other agents own. The store-backed projection (`useBottomBarModel`) is exercised by
 * `tallyTone` and `confidenceToPercent` directly, which is where its only real logic lives.
 *
 * `now` is pinned on every render: the bar's 1-second clock would otherwise leave a live interval
 * behind and its elapsed readout would depend on wall time.
 *
 * ## Fixtures
 *
 * Standing Rule 4: obvious placeholders only — "SLIDE 1", "SLIDE 2". No verse text, no lyrics,
 * no sermon prose anywhere in this file.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CameraSlot } from '@shared/camera'

import '../i18n'
import { resetAsrStore } from '../store/asrStore'
import { cameraButtons, resetCameraStore } from '../store/cameraStore'
import { resetCueStore } from '../store/cueStore'
import { resetGoLiveStore } from '../store/goLiveStore'
import { resetHealthStore } from '../store/healthStore'
import { resetObsStore } from '../store/obsStore'
import { resetOverlayStore } from '../store/overlayStore'
import { resetPlanStore } from '../store/planStore'
import { resetYouTubeStore } from '../store/youtubeStore'
import { MOCK_NOW, mockCameraConfig, mockCameraState } from '../test/mockVergerApi'
import { BottomBar, confidenceToPercent, tallyTone } from './BottomBar'
import type { BottomBarActions, BottomBarModel } from './BottomBar'
import { DEFAULT_HOLD_MS } from './HoldButton'

// --- Fixtures. Placeholders only, per Standing Rule 4. ------------------------------------------

/** Four bound buttons with CAM 1 live — a *usable* console is the ordinary case. */
const READY_CAMERAS = cameraButtons(mockCameraConfig(), mockCameraState())

/** PULPIT has no scene bound: that button must be disabled rather than firing at nothing. */
const PARTLY_BOUND_CAMERAS = cameraButtons(mockCameraConfig({ pulpit: null }), mockCameraState())

/**
 * The bar at rest: OBS idle, nothing live, nothing pending, no lower third authored.
 *
 * Deliberately the *degraded* resting state rather than a happy one, so every test has to name the
 * capability it is asserting instead of inheriting it.
 */
function baseModel(overrides: Partial<BottomBarModel> = {}): BottomBarModel {
  return {
    percent: null,
    tally: 'offline',
    phase: 'idle',
    obsState: 'idle',
    recording: false,
    recordingMissing: false,
    elapsed: null,
    nowLabel: null,
    nextLabel: null,
    cameras: READY_CAMERAS,
    lowerThirdVisible: false,
    lowerThirdReady: false,
    canGoLive: false,
    isLive: false,
    endNeedsHold: false,
    busy: false,
    ...overrides,
  }
}

/** Everything the bar asked for. Assert against this, not on spies. */
interface BarCalls {
  readonly selectCamera: CameraSlot[]
  readonly toggleLowerThird: number[]
  readonly goLive: number[]
  /** Every completed END. A tap on a hold-guarded END must never appear here. */
  readonly end: number[]
  readonly openSettings: number[]
}

interface FakeActions {
  readonly actions: BottomBarActions
  readonly calls: BarCalls
}

function makeActions(): FakeActions {
  const calls: BarCalls = {
    selectCamera: [],
    toggleLowerThird: [],
    goLive: [],
    end: [],
    openSettings: [],
  }
  const actions: BottomBarActions = {
    selectCamera: (slot) => {
      calls.selectCamera.push(slot)
    },
    toggleLowerThird: () => {
      calls.toggleLowerThird.push(calls.toggleLowerThird.length)
    },
    goLive: () => {
      calls.goLive.push(calls.goLive.length)
    },
    end: () => {
      calls.end.push(calls.end.length)
    },
    openSettings: () => {
      calls.openSettings.push(calls.openSettings.length)
    },
  }
  return { actions, calls }
}

function renderBar(model: BottomBarModel, actions?: BottomBarActions): { container: HTMLElement } {
  const { container } = render(
    <BottomBar
      model={model}
      {...(actions === undefined ? {} : { actions })}
      // Pinned: an unpinned bar starts a 1-second interval and reads the wall clock.
      now={MOCK_NOW}
    />,
  )
  return { container }
}

describe('BottomBar', () => {
  // The bar's *default* model comes from nine module-singleton stores, and it builds that fallback
  // model even when a test injects one. A `busy: true` leaked from another file would then be read
  // by nothing here — but a store left mid-flight can still throw inside a selector, so they all
  // start from a known resting state.
  beforeEach(() => {
    resetPlanStore()
    resetCueStore()
    resetObsStore()
    resetOverlayStore()
    resetCameraStore()
    resetGoLiveStore()
    resetAsrStore()
    resetYouTubeStore()
    resetHealthStore()
  })

  describe('the bar is the progress indicator', () => {
    it('sets the fill width, aria-valuenow and the big readout from one percentage', () => {
      renderBar(baseModel({ percent: 87 }))

      const progress = screen.getByTestId('bottom-bar-progress')
      // The width is the readout. Not a separate widget somewhere else on the surface.
      expect(progress.style.width).toBe('87%')
      expect(progress).toHaveAttribute('aria-valuenow', '87')
      expect(progress).toHaveAttribute('aria-valuemin', '0')
      expect(progress).toHaveAttribute('aria-valuemax', '100')
      expect(screen.getByTestId('bottom-bar-percent').textContent).toBe('87%')
    })

    it('is the same element the accessibility tree sees as a progressbar', () => {
      renderBar(baseModel({ percent: 42 }))

      const progress = screen.getByRole('progressbar', { name: /match/i })
      expect(progress).toBe(screen.getByTestId('bottom-bar-progress'))
      expect(progress).toHaveAttribute('data-percent', '42')
    })

    it('reports 0% as a measured zero: an empty fill that still claims aria-valuenow="0"', () => {
      renderBar(baseModel({ percent: 0 }))

      const progress = screen.getByTestId('bottom-bar-progress')
      expect(progress.style.width).toBe('0%')
      expect(progress).toHaveAttribute('aria-valuenow', '0')
      expect(screen.getByTestId('bottom-bar-percent').textContent).toBe('0%')
    })

    it('says it does not know with an em dash and NO aria-valuenow, never 0%', () => {
      renderBar(baseModel({ percent: null }))

      const readout = screen.getByTestId('bottom-bar-percent')
      // The whole reason this test exists: "nothing pending" must not read as "no confidence".
      expect(readout.textContent).toBe('—')
      expect(readout.textContent).not.toBe('0%')

      const progress = screen.getByTestId('bottom-bar-progress')
      expect(progress.style.width).toBe('0%')
      // An indeterminate progressbar must omit the attribute rather than claim a value it never
      // measured — a screen reader announcing "0 percent" here would be a fabrication.
      expect(progress).not.toHaveAttribute('aria-valuenow')
      expect(progress).toHaveAttribute('data-percent', '')
    })
  })

  describe('the tally', () => {
    it('shows Live, and marks the whole bar live', () => {
      const { container } = renderBar(baseModel({ tally: 'live' }))

      const bar = screen.getByTestId('bottom-bar')
      expect(bar).toHaveAttribute('data-tally', 'live')
      expect(within(bar).getByText('Live')).toBeInTheDocument()
      expect(container.querySelector('[data-testid="bottom-bar-tally"]')).not.toBeNull()
    })

    it('shows Standby while something is mid-transition', () => {
      renderBar(baseModel({ tally: 'transitioning' }))

      const bar = screen.getByTestId('bottom-bar')
      expect(bar).toHaveAttribute('data-tally', 'transitioning')
      expect(within(bar).getByText('Standby')).toBeInTheDocument()
      expect(within(bar).queryByText('Live')).toBeNull()
    })

    it('shows Off air when nothing is going out', () => {
      renderBar(baseModel({ tally: 'offline' }))

      const bar = screen.getByTestId('bottom-bar')
      expect(bar).toHaveAttribute('data-tally', 'offline')
      expect(within(bar).getByText('Off air')).toBeInTheDocument()
    })
  })

  describe('Standing Rule 3 — recording always accompanies streaming', () => {
    it('raises an alert saying No rec when streaming without a recording', () => {
      renderBar(baseModel({ tally: 'live', recording: false, recordingMissing: true }))

      const alert = screen.getByRole('alert')
      expect(alert).toBe(screen.getByTestId('bottom-bar-no-recording'))
      expect(alert).toHaveTextContent('No rec')
      // The quiet pill must not be up at the same time; two contradictory readouts is worse than
      // either one alone.
      expect(screen.queryByTestId('bottom-bar-recording')).toBeNull()
    })

    it('shows the quiet Rec pill, and no alert, when the recording is running', () => {
      renderBar(baseModel({ tally: 'live', recording: true, recordingMissing: false }))

      expect(screen.getByTestId('bottom-bar-recording')).toHaveTextContent('Rec')
      expect(screen.queryByTestId('bottom-bar-no-recording')).toBeNull()
      // Nothing is wrong, so nothing may interrupt.
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('prefers the alert over the pill when a model claims both', () => {
      renderBar(baseModel({ tally: 'live', recording: true, recordingMissing: true }))

      expect(screen.getByTestId('bottom-bar-no-recording')).toBeInTheDocument()
      expect(screen.queryByTestId('bottom-bar-recording')).toBeNull()
    })

    it('shows neither when nothing is running', () => {
      renderBar(baseModel())

      expect(screen.queryByTestId('bottom-bar-recording')).toBeNull()
      expect(screen.queryByTestId('bottom-bar-no-recording')).toBeNull()
    })
  })

  describe('the elapsed clock and the context line', () => {
    it('prints the model’s elapsed string verbatim', () => {
      renderBar(baseModel({ tally: 'live', elapsed: '1:00:00' }))

      expect(screen.getByTestId('bottom-bar-elapsed').textContent).toBe('1:00:00')
    })

    it('falls back to an em dash when nothing is live', () => {
      renderBar(baseModel({ elapsed: null }))

      expect(screen.getByTestId('bottom-bar-elapsed').textContent).toBe('—')
    })

    it('names the current and next cue', () => {
      renderBar(baseModel({ nowLabel: 'SLIDE 1', nextLabel: 'SLIDE 2' }))

      expect(screen.getByTestId('bottom-bar-context')).toHaveTextContent('SLIDE 1 → SLIDE 2')
    })

    it('says the plan has not started when nothing has fired', () => {
      renderBar(baseModel({ nowLabel: null }))

      expect(screen.getByTestId('bottom-bar-context')).toHaveTextContent(/not started/i)
    })

    it('says so at the end of the plan rather than inventing a next cue', () => {
      renderBar(baseModel({ nowLabel: 'SLIDE 2', nextLabel: null }))

      const context = screen.getByTestId('bottom-bar-context')
      expect(context).toHaveTextContent(/end of the plan/i)
      expect(context).toHaveTextContent('SLIDE 2')
    })

    it('borrows the connection screen’s own vocabulary for the OBS state', () => {
      renderBar(baseModel({ obsState: 'connected' }))

      expect(screen.getByTestId('bottom-bar-obs')).toHaveTextContent('OBS: Connected')
    })
  })

  describe('the camera buttons', () => {
    it('renders one button per slot, numbered, with the live one marked', () => {
      const { container } = renderBar(baseModel())

      const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-slot]')
      expect(buttons).toHaveLength(4)
      expect(Array.from(buttons, (button) => button.getAttribute('data-slot'))).toEqual([
        'cam1',
        'cam2',
        'wide',
        'pulpit',
      ])
      // OBS's program scene is CAM 1's, so exactly one button may read as live.
      expect(container.querySelector('button[data-slot="cam1"]')).toHaveAttribute(
        'data-live',
        'true',
      )
      expect(container.querySelector('button[data-slot="cam2"]')).toHaveAttribute(
        'data-live',
        'false',
      )
      expect(container.querySelectorAll('button[data-slot][data-live="true"]')).toHaveLength(1)
    })

    it('disables a slot with no scene bound', () => {
      const { container } = renderBar(baseModel({ cameras: PARTLY_BOUND_CAMERAS }))

      expect(container.querySelector('button[data-slot="pulpit"]')).toBeDisabled()
      expect(container.querySelector('button[data-slot="wide"]')).toBeEnabled()
    })

    it('asks for the slot the operator pressed, and only that slot', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel(), actions)

      await user.click(screen.getByRole('button', { name: 'Camera 2: CAM 2' }))

      expect(calls.selectCamera).toEqual(['cam2'])
      // A camera switch may never disturb another layer — nothing else was asked for.
      expect(calls.toggleLowerThird).toHaveLength(0)
      expect(calls.goLive).toHaveLength(0)
      expect(calls.end).toHaveLength(0)
    })
  })

  describe('the lower-third toggle', () => {
    it('is disabled when there is no text to show yet', () => {
      renderBar(baseModel({ lowerThirdVisible: false, lowerThirdReady: false }))

      const button = screen.getByTestId('bottom-bar-lower-third')
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-pressed', 'false')
    })

    it('is enabled once a line has been authored', () => {
      renderBar(baseModel({ lowerThirdVisible: false, lowerThirdReady: true }))

      const button = screen.getByTestId('bottom-bar-lower-third')
      expect(button).toBeEnabled()
      expect(button).toHaveAttribute('aria-pressed', 'false')
    })

    it('stays enabled while visible so it can always be turned off', () => {
      // The dangerous regression: an overlay that is up but whose only OFF switch is disabled
      // because the store no longer considers the text "ready".
      renderBar(baseModel({ lowerThirdVisible: true, lowerThirdReady: false }))

      const button = screen.getByTestId('bottom-bar-lower-third')
      expect(button).toBeEnabled()
      expect(button).toHaveAttribute('aria-pressed', 'true')
    })

    it('toggles on press', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel({ lowerThirdVisible: true, lowerThirdReady: true }), actions)

      await user.click(screen.getByTestId('bottom-bar-lower-third'))

      expect(calls.toggleLowerThird).toHaveLength(1)
      expect(calls.selectCamera).toHaveLength(0)
    })
  })

  describe('GO LIVE and END', () => {
    it('offers GO LIVE when nothing is live, and starts on press', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel({ canGoLive: true }), actions)

      const goLive = screen.getByTestId('bottom-bar-go-live')
      expect(goLive).toHaveTextContent('GO LIVE')
      expect(goLive).toBeEnabled()
      expect(screen.queryByTestId('bottom-bar-end')).toBeNull()

      await user.click(goLive)
      expect(calls.goLive).toHaveLength(1)
    })

    it('disables GO LIVE when pressing it could not possibly work', () => {
      renderBar(baseModel({ canGoLive: false }))

      const goLive = screen.getByTestId('bottom-bar-go-live')
      expect(goLive).toBeDisabled()
      // …and says why, rather than being inertly grey.
      expect(goLive).toHaveAttribute('title', 'GO LIVE needs a live OBS connection.')
    })

    it('offers a plain END, which ends on press, when a hold is not required', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel({ isLive: true, endNeedsHold: false }), actions)

      const end = screen.getByTestId('bottom-bar-end')
      expect(end).toHaveTextContent('END')
      expect(screen.queryByTestId('bottom-bar-go-live')).toBeNull()

      await user.click(end)
      expect(calls.end).toEqual([0])
    })

    it('swaps END for a hold, and a single tap does not end the service', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel({ isLive: true, endNeedsHold: true }), actions)

      // The HoldButton carries the id, not the test id — it is a different component by design.
      const hold = screen.getByRole('button', { name: /end .*hold for 1\.5 seconds/i })
      expect(hold).toHaveAttribute('id', 'bottom-bar-end')
      expect(screen.queryByTestId('bottom-bar-end')).toBeNull()

      await user.click(hold)

      // Standing Rule 6. Ending stops the stream AND the always-on local recording; a tap may not.
      expect(calls.end).toHaveLength(0)
    })

    it('ends the service after a full deliberate hold', () => {
      const { actions, calls } = makeActions()
      renderBar(baseModel({ isLive: true, endNeedsHold: true }), actions)
      const hold = screen.getByRole('button', { name: /hold for 1\.5 seconds/i })

      // Fake timers only inside this test: the bar's own clock is pinned, so the only interval
      // running is the hold's.
      vi.useFakeTimers()
      try {
        fireEvent.pointerDown(hold)
        act(() => {
          vi.advanceTimersByTime(DEFAULT_HOLD_MS - 100)
        })
        expect(calls.end).toHaveLength(0)

        act(() => {
          vi.advanceTimersByTime(200)
        })
        expect(calls.end).toEqual([0])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('busy', () => {
    it('disables the controls while a start, an end, or a plan action is in flight', () => {
      const { container } = renderBar(baseModel({ canGoLive: true, busy: true }))

      for (const button of container.querySelectorAll<HTMLButtonElement>('button[data-slot]')) {
        expect(button).toBeDisabled()
      }
      expect(screen.getByTestId('bottom-bar-lower-third')).toBeDisabled()
      expect(screen.getByTestId('bottom-bar-go-live')).toBeDisabled()
    })

    it('currently disables the lower-third OFF switch too, even with an overlay up', () => {
      // Documenting today's behaviour, not endorsing it: `busy` covers a GO LIVE sequence and any
      // in-flight plan action, and while it is set an overlay that is already on the congregation
      // screen cannot be taken down from the bar. Standing Rule 1 says every automated action is
      // overridable in one tap, so if this ever changes to stay enabled, change this assertion —
      // it is here so the change is deliberate rather than accidental.
      renderBar(baseModel({ lowerThirdVisible: true, lowerThirdReady: true, busy: true }))

      expect(screen.getByTestId('bottom-bar-lower-third')).toBeDisabled()
    })

    it('disables END while busy', () => {
      renderBar(baseModel({ isLive: true, endNeedsHold: false, busy: true }))

      expect(screen.getByTestId('bottom-bar-end')).toBeDisabled()
    })

    it('leaves the way into settings open even while busy', () => {
      // Human always wins: whatever the app thinks it is doing, the operator can still get at the
      // screen that would let them fix it.
      renderBar(baseModel({ busy: true }))

      expect(screen.getByTestId('bottom-bar-settings')).toBeEnabled()
    })
  })

  describe('settings', () => {
    it('opens the drawer on press', async () => {
      const user = userEvent.setup()
      const { actions, calls } = makeActions()
      renderBar(baseModel(), actions)

      const settings = screen.getByTestId('bottom-bar-settings')
      expect(settings).toHaveAccessibleName('Setup & settings')

      await user.click(settings)
      expect(calls.openSettings).toEqual([0])
    })
  })

  describe('confidenceToPercent', () => {
    it('rounds a 0..1 confidence to whole percent', () => {
      expect(confidenceToPercent(0.86)).toBe(86)
      expect(confidenceToPercent(0.874)).toBe(87)
      expect(confidenceToPercent(0.8749)).toBe(87)
      expect(confidenceToPercent(0.875)).toBe(88)
      expect(confidenceToPercent(0)).toBe(0)
      expect(confidenceToPercent(1)).toBe(100)
    })

    it('clamps rather than rendering a bar wider than the bar', () => {
      expect(confidenceToPercent(1.4)).toBe(100)
      expect(confidenceToPercent(-0.5)).toBe(0)
      expect(confidenceToPercent(-0)).toBe(0)
    })

    it('survives a non-finite confidence instead of writing NaN% into the layout', () => {
      // A detector that divides by zero must not be able to break the bar's geometry.
      expect(confidenceToPercent(Number.NaN)).toBe(0)
      expect(confidenceToPercent(Number.POSITIVE_INFINITY)).toBe(0)
      expect(confidenceToPercent(Number.NEGATIVE_INFINITY)).toBe(0)
    })
  })

  describe('tallyTone', () => {
    it('reads live when OBS is streaming, whatever the phase says', () => {
      expect(tallyTone('idle', true, false, 'connected')).toBe('live')
      expect(tallyTone('failed', true, false, 'disconnected')).toBe('live')
    })

    it('reads live for the live and partial phases', () => {
      // `partial` is OBS streaming and recording with YouTube never transitioned. The feed is
      // going out, so the tally is red even though the broadcast is not public.
      expect(tallyTone('live', false, false, 'connected')).toBe('live')
      expect(tallyTone('partial', false, false, 'connected')).toBe('live')
    })

    it('reads transitioning while anything is mid-flight', () => {
      expect(tallyTone('starting', false, false, 'connected')).toBe('transitioning')
      expect(tallyTone('ending', false, false, 'connected')).toBe('transitioning')
      expect(tallyTone('idle', false, true, 'connected')).toBe('transitioning')
      expect(tallyTone('idle', false, false, 'connecting')).toBe('transitioning')
      expect(tallyTone('idle', false, false, 'reconnecting')).toBe('transitioning')
    })

    it('reads offline when nothing is going out and nothing is in flight', () => {
      expect(tallyTone('idle', false, false, 'idle')).toBe('offline')
      expect(tallyTone('idle', false, false, 'not-configured')).toBe('offline')
      expect(tallyTone('failed', false, false, 'disconnected')).toBe('offline')
      expect(tallyTone('failed', false, false, 'auth-failed')).toBe('offline')
    })

    it('lets streaming win over a transitioning signal', () => {
      // The RTMP link is flapping and OBS is still pushing. The congregation is still being
      // broadcast to, so the light must not de-escalate to amber.
      expect(tallyTone('ending', true, true, 'reconnecting')).toBe('live')
    })
  })

  describe('accessibility', () => {
    it('has no axe violations mid-service', async () => {
      const { container } = renderBar(
        baseModel({
          percent: 87,
          tally: 'live',
          elapsed: '1:00:00',
          recording: true,
          obsState: 'connected',
          nowLabel: 'SLIDE 1',
          nextLabel: 'SLIDE 2',
          lowerThirdVisible: true,
          lowerThirdReady: true,
          isLive: true,
          endNeedsHold: true,
        }),
      )

      await expect(axe(container)).resolves.toHaveNoViolations()
    })

    it('has no axe violations at rest, with an indeterminate match and disabled controls', async () => {
      const { container } = renderBar(baseModel({ cameras: PARTLY_BOUND_CAMERAS }))

      await expect(axe(container)).resolves.toHaveNoViolations()
    })
  })
})
