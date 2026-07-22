/**
 * The Camera panel's contract — and the headline assertion of Phase 3.
 *
 * BLUEPRINT.md §6 promises that cameras and overlays are two independent controls. A service-level
 * test can prove the two state machines never read each other; it cannot prove a *button* does not
 * fire both. So the load-bearing tests here are the two mirror-image ones:
 *
 *  - pressing CAM 2 sends `camera.select('cam2')` and **zero** overlay commands;
 *  - hiding the lower third sends `lowerThird.hide` and **zero** camera selects.
 *
 * Both are asserted against the mock bridge's real call log, with the two panels mounted together,
 * which is the arrangement most likely to expose an accidental coupling.
 *
 * `OverlayPanel` is imported read-only for that second assertion — it is another agent's file, and
 * nothing here modifies it.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { ok } from '@shared/result'

import '../i18n'
import { resetCameraStore } from '../store/cameraStore'
import { resetObsStore } from '../store/obsStore'
import { resetOverlayStore } from '../store/overlayStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_CAMERA_SCENES,
  installMockVergerApi,
  mockCameraConfig,
  mockCameraState,
  mockConnectedStatus,
  mockOverlayState,
  mockSceneList,
} from '../test/mockVergerApi'
import { CameraPanel } from './CameraPanel'
import { OverlayPanel } from './OverlayPanel'

/** The panel lives inside `<main>` in App.tsx; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Wait until the panel has hydrated, so assertions never race the initial reads. */
async function ready(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /cam 1/i })
}

describe('CameraPanel', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    // Every test here starts from a connected OBS; the disconnected case is asserted explicitly.
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.getSceneList = ok(mockSceneList())
    resetCameraStore()
    resetObsStore()
    resetOverlayStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('switches the camera and sends NOT ONE overlay command — the decoupling guarantee', async () => {
    const user = userEvent.setup()
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    await user.click(screen.getByRole('button', { name: /cam 2/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cameraSelect).toEqual(['cam2'])
    })
    // The whole point of Phase 3: the lower third the congregation is reading does not move.
    expect(installed.mock.calls.overlaySend).toEqual([])

    await user.click(screen.getByRole('button', { name: /pulpit/i }))
    await waitFor(() => {
      expect(installed.mock.calls.cameraSelect).toEqual(['cam2', 'pulpit'])
    })
    expect(installed.mock.calls.overlaySend).toEqual([])
  })

  it('the mirror: hiding the lower third selects no camera', async () => {
    const user = userEvent.setup()
    installed.mock.responses.overlayGetState = ok(mockOverlayState())

    render(
      <>
        <CameraPanel />
        <OverlayPanel />
      </>,
      { wrapper: Landmark },
    )
    await ready()
    await screen.findByRole('region', { name: /overlay server/i })

    await user.click(screen.getByRole('button', { name: /hide lower third/i }))

    await waitFor(() => {
      expect(installed.mock.calls.overlaySend.map((command) => command.name)).toEqual([
        'lowerThird.hide',
      ])
    })
    expect(installed.mock.calls.cameraSelect).toEqual([])
  })

  it('marks exactly one button live, by text as well as by state', async () => {
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    await waitFor(() => {
      expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
    })
    const live = screen.getByRole('button', { pressed: true })
    expect(live).toHaveAttribute('data-slot', 'cam1')
    // Colour is never the only signal: the word LIVE is inside the button.
    expect(within(live).getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/cam 1 is live/i)
  })

  it('follows a scene switched inside OBS rather than the last button pressed', async () => {
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    act(() => {
      installed.mock.emit(IpcEvent.cameraState, mockCameraState({ activeSlot: 'wide' }))
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { pressed: true })).toHaveAttribute('data-slot', 'wide')
    })
  })

  it('lights NO button when the live scene maps to none of them, and says why', async () => {
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    act(() => {
      installed.mock.emit(
        IpcEvent.cameraState,
        mockCameraState({ currentProgramScene: 'Welcome loop', activeSlot: null }),
      )
    })

    await waitFor(() => {
      expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0)
    })
    expect(screen.getByTestId('camera-program-scene')).toHaveTextContent('Welcome loop')
    expect(screen.getByText(/none of these four buttons maps to/i)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/none of these four buttons is live/i)
  })

  it('shows the bound OBS scene name and the keyboard shortcut on every button', async () => {
    render(<CameraPanel />, { wrapper: Landmark })
    const cam1 = await ready()

    expect(within(cam1).getByText(MOCK_CAMERA_SCENES.cam1)).toBeInTheDocument()
    expect(within(cam1).getByText(/key 1/i)).toBeInTheDocument()
    const pulpit = screen.getByRole('button', { name: /pulpit/i })
    expect(within(pulpit).getByText(MOCK_CAMERA_SCENES.pulpit)).toBeInTheDocument()
    expect(within(pulpit).getByText(/key 4/i)).toBeInTheDocument()
  })

  it('disables an unmapped button and explains what to do, instead of firing at nothing', async () => {
    const user = userEvent.setup()
    installed.mock.responses.cameraGetConfig = ok(mockCameraConfig({ pulpit: null }))
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    const pulpit = await screen.findByRole('button', { name: /pulpit/i })
    await waitFor(() => {
      expect(pulpit).toBeDisabled()
    })
    expect(pulpit).toHaveAccessibleName(/no scene/i)
    expect(pulpit).toHaveAccessibleName(/assign a scene in camera setup/i)

    // A disabled button cannot be clicked into an error — nothing reaches the bridge.
    await user.click(pulpit)
    expect(installed.mock.calls.cameraSelect).toEqual([])

    // The other three are unaffected.
    expect(screen.getByRole('button', { name: /cam 1/i })).toBeEnabled()
  })

  it('disables the whole panel with a reason when OBS is not connected', async () => {
    installed.mock.responses.getStatus = ok(mockConnectedStatus({ state: 'disconnected' }))
    render(<CameraPanel />, { wrapper: Landmark })
    await ready()

    await screen.findByRole('region', { name: /not connected to obs/i })
    expect(screen.getByText(/camera switching needs a live obs-websocket connection/i)).toBeInTheDocument()

    for (const name of [/cam 1/i, /cam 2/i, /wide/i, /pulpit/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(installed.mock.calls.cameraSelect).toEqual([])
  })

  it('explains a missing preload bridge rather than rendering four dead buttons', async () => {
    installed.restore()
    delete window.verger
    resetCameraStore()
    resetObsStore()

    render(<CameraPanel />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /privileged bridge did not load/i })
    expect(screen.getByRole('button', { name: /cam 1/i })).toBeDisabled()

    installed = installMockVergerApi()
  })

  it('has no axe violations', async () => {
    const { container } = render(<CameraPanel />, { wrapper: Landmark })
    await ready()
    await waitFor(() => {
      expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
    })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations with an unmapped button and a disconnected OBS', async () => {
    installed.mock.responses.cameraGetConfig = ok(mockCameraConfig({ pulpit: null }))
    installed.mock.responses.getStatus = ok(mockConnectedStatus({ state: 'disconnected' }))
    const { container } = render(<CameraPanel />, { wrapper: Landmark })
    await ready()
    await screen.findByRole('region', { name: /not connected to obs/i })

    expect(await axe(container)).toHaveNoViolations()
  })
})
