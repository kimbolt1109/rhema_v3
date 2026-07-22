/**
 * Camera setup's contract.
 *
 * The property that matters most is negative: **the operator cannot create a button that fires at
 * a scene OBS does not have.** So the scene control is asserted to be a `<select>` whose options
 * come from the live scene list, an out-of-range duration is asserted to be refused *before* it
 * reaches the bridge, and a mapping saved while OBS is down is asserted to survive rather than be
 * silently blanked by a picker that lost its option.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CameraSlot } from '@shared/camera'
import { ErrorCode, err, ok } from '@shared/result'

import '../i18n'
import { resetCameraStore } from '../store/cameraStore'
import { resetObsStore } from '../store/obsStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_CAMERA_SCENES,
  installMockVergerApi,
  mockCameraConfig,
  mockCameraState,
  mockConnectedStatus,
  mockSceneList,
} from '../test/mockVergerApi'
import { CameraSettings, parseTransitionDuration } from './CameraSettings'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** The scenes a stock rig reports, including one bound to no button. */
const SCENES = mockSceneList({
  scenes: [
    { name: MOCK_CAMERA_SCENES.cam1, index: 0 },
    { name: MOCK_CAMERA_SCENES.cam2, index: 1 },
    { name: MOCK_CAMERA_SCENES.wide, index: 2 },
    { name: MOCK_CAMERA_SCENES.pulpit, index: 3 },
    { name: 'Welcome loop', index: 4 },
  ],
  currentProgramScene: MOCK_CAMERA_SCENES.cam1,
})

function sceneSelect(slot: CameraSlot, camera: RegExp): HTMLSelectElement {
  const field = screen.getByLabelText(camera)
  if (!(field instanceof HTMLSelectElement)) {
    throw new Error(`expected a <select> for ${slot}`)
  }
  return field
}

/** The single saved configuration, as the bridge received it. */
function savedSceneFor(installed: InstalledMockVergerApi, slot: CameraSlot): string | null {
  const config = installed.mock.calls.cameraSetConfig.at(-1)
  if (config === undefined) throw new Error('setConfig was never called')
  return config.bindings.find((binding) => binding.slot === slot)?.sceneName ?? null
}

describe('CameraSettings', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.getSceneList = ok(SCENES)
    resetCameraStore()
    resetObsStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('populates every scene picker from the live OBS scene list, never a text field', async () => {
    render(<CameraSettings />, { wrapper: Landmark })

    const select = await screen.findByLabelText(/cam 1 scene/i)
    await waitFor(() => {
      expect(within(select).getAllByRole('option').length).toBeGreaterThan(1)
    })

    const names = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).toContain(MOCK_CAMERA_SCENES.cam1)
    expect(names).toContain('Welcome loop')
    // The "not mapped" escape hatch is an option, not a blank the operator has to guess at.
    expect(names).toContain('— not mapped —')

    expect(sceneSelect('cam1', /cam 1 scene/i).value).toBe(MOCK_CAMERA_SCENES.cam1)
  })

  it('offers the transitions OBS reported, plus an explicit "use whatever OBS is set to"', async () => {
    render(<CameraSettings />, { wrapper: Landmark })

    const select = await screen.findByLabelText(/^wide transition$/i)
    await waitFor(() => {
      expect(within(select).getAllByRole('option').length).toBeGreaterThan(1)
    })
    const names = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names[0]).toMatch(/use whatever obs is set to/i)
    expect(names).toContain('Fade')
    expect(screen.getAllByText(/blank means verger changes nothing/i).length).toBeGreaterThan(0)
  })

  it('saves the mapping through setConfig, with a blank transition meaning "leave OBS alone"', async () => {
    const user = userEvent.setup()
    render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/pulpit scene/i)
    await waitFor(() => {
      expect(within(sceneSelect('pulpit', /pulpit scene/i)).getAllByRole('option').length).toBe(6)
    })

    await user.selectOptions(screen.getByLabelText(/pulpit scene/i), 'Welcome loop')
    await user.selectOptions(screen.getByLabelText(/^pulpit transition$/i), 'Fade')
    await user.type(screen.getByLabelText(/pulpit transition duration/i), '350')
    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cameraSetConfig).toHaveLength(1)
    })
    const config = installed.mock.calls.cameraSetConfig[0]
    expect(config?.bindings.find((binding) => binding.slot === 'pulpit')).toEqual({
      slot: 'pulpit',
      label: 'PULPIT',
      sceneName: 'Welcome loop',
      transition: 'Fade',
      transitionDurationMs: 350,
    })
    // Every other slot keeps its mapping, and a transition nobody touched stays null — which the
    // contract spells "use whatever OBS is set to", not "cut".
    expect(config?.bindings.find((binding) => binding.slot === 'cam1')).toEqual({
      slot: 'cam1',
      label: 'CAM 1',
      sceneName: MOCK_CAMERA_SCENES.cam1,
      transition: null,
      transitionDurationMs: null,
    })
    await screen.findByText(/camera mapping saved/i)
  })

  it('records an unmapped slot as null when the operator picks "not mapped"', async () => {
    const user = userEvent.setup()
    render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/cam 2 scene/i)
    await waitFor(() => {
      expect(sceneSelect('cam2', /cam 2 scene/i).value).toBe(MOCK_CAMERA_SCENES.cam2)
    })

    await user.selectOptions(screen.getByLabelText(/cam 2 scene/i), '')
    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))

    await waitFor(() => {
      expect(installed.mock.calls.cameraSetConfig).toHaveLength(1)
    })
    expect(savedSceneFor(installed, 'cam2')).toBeNull()
  })

  it('refuses an out-of-range duration before it reaches the bridge', async () => {
    const user = userEvent.setup()
    render(<CameraSettings />, { wrapper: Landmark })
    const duration = await screen.findByLabelText(/cam 1 transition duration/i)

    await user.clear(duration)
    await user.type(duration, '99999')
    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/whole number of milliseconds from 0 to 20000/i)
    expect(duration).toHaveAttribute('aria-invalid', 'true')
    expect(installed.mock.calls.cameraSetConfig).toEqual([])
    expect(screen.queryByText(/camera mapping saved/i)).not.toBeInTheDocument()
  })

  it('refuses text in the duration field, and keeps what was typed on screen', async () => {
    const user = userEvent.setup()
    render(<CameraSettings />, { wrapper: Landmark })
    const duration = await screen.findByLabelText(/wide transition duration/i)

    await user.type(duration, '2 seconds')
    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))

    await screen.findByRole('alert')
    expect(duration).toHaveValue('2 seconds')
    expect(installed.mock.calls.cameraSetConfig).toEqual([])
  })

  it('says scenes cannot be listed until OBS connects, instead of showing empty pickers', async () => {
    installed.mock.responses.getStatus = ok(mockConnectedStatus({ state: 'disconnected' }))
    installed.mock.responses.getSceneList = err(ErrorCode.NOT_CONNECTED, 'not connected')

    render(<CameraSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /scenes cannot be listed until obs connects/i })
    expect(screen.getByText(/verger only offers scenes that obs has reported/i)).toBeInTheDocument()
  })

  it('keeps an already-saved scene selectable while OBS is down, so saving cannot blank the map', async () => {
    const user = userEvent.setup()
    installed.mock.responses.getSceneList = err(ErrorCode.NOT_CONNECTED, 'not connected')
    installed.mock.responses.cameraGetConfig = ok(mockCameraConfig())

    render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/wide scene/i)

    await waitFor(() => {
      expect(sceneSelect('wide', /wide scene/i).value).toBe(MOCK_CAMERA_SCENES.wide)
    })

    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))
    await waitFor(() => {
      expect(installed.mock.calls.cameraSetConfig).toHaveLength(1)
    })
    expect(savedSceneFor(installed, 'wide')).toBe(MOCK_CAMERA_SCENES.wide)
  })

  it('surfaces a refused save rather than claiming it worked', async () => {
    const user = userEvent.setup()
    installed.mock.responses.cameraSetConfig = err(ErrorCode.IO_ERROR, 'disk full')

    render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/cam 1 scene/i)

    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))

    await screen.findByText(/disk full/i)
    expect(screen.queryByText(/camera mapping saved/i)).not.toBeInTheDocument()
  })

  it('notes when OBS has reported no transitions at all', async () => {
    installed.mock.responses.cameraGetState = ok(mockCameraState({ availableTransitions: [] }))

    render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/cam 1 scene/i)

    await waitFor(() => {
      expect(screen.getAllByText(/obs has not reported any transitions/i)).toHaveLength(4)
    })
  })

  it('has no axe violations', async () => {
    const { container } = render(<CameraSettings />, { wrapper: Landmark })
    await screen.findByLabelText(/cam 1 scene/i)
    await waitFor(() => {
      expect(within(sceneSelect('cam1', /cam 1 scene/i)).getAllByRole('option').length).toBe(6)
    })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations while showing a validation error', async () => {
    const user = userEvent.setup()
    const { container } = render(<CameraSettings />, { wrapper: Landmark })
    await user.type(await screen.findByLabelText(/cam 1 transition duration/i), 'x')
    await user.click(screen.getByRole('button', { name: /save camera mapping/i }))
    await screen.findByRole('alert')

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('parseTransitionDuration', () => {
  it('reads a blank field as "use OBS\'s own duration"', () => {
    expect(parseTransitionDuration('')).toBeNull()
    expect(parseTransitionDuration('   ')).toBeNull()
  })

  it('accepts whole milliseconds inside the schema range', () => {
    expect(parseTransitionDuration('0')).toBe(0)
    expect(parseTransitionDuration('350')).toBe(350)
    expect(parseTransitionDuration('20000')).toBe(20_000)
  })

  it('rejects everything the schema would reject', () => {
    expect(parseTransitionDuration('20001')).toBe('invalid')
    expect(parseTransitionDuration('-1')).toBe('invalid')
    expect(parseTransitionDuration('1.5')).toBe('invalid')
    expect(parseTransitionDuration('fast')).toBe('invalid')
    expect(parseTransitionDuration('1e3')).toBe('invalid')
  })
})
