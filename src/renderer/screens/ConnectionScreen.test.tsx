import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { initialObsStatus } from '@shared/obs'
import { ErrorCode, err, ok } from '@shared/result'

import '../i18n'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_NOW,
  installMockVergerApi,
  mockConnectedStatus,
  mockSceneList,
} from '../test/mockVergerApi'
import { resetObsStore } from '../store/obsStore'
import { ConnectionScreen, DEFAULT_OBS_URL } from './ConnectionScreen'

/** The screen lives inside `<main>` in App.tsx; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

describe('ConnectionScreen', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetObsStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('explains what to do when OBS is not configured, and points at HUMAN_TASKS.md', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('not-configured', MOCK_NOW))
    render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText(/OBS is not set up yet/i)
    const callout = screen.getByRole('region', { name: /OBS is not set up yet/i })

    expect(within(callout).getByText(/Install OBS Studio 30 or newer/i)).toBeInTheDocument()
    // The exact OBS menu path — an operator should not have to hunt for it.
    expect(within(callout).getByText(/Tools → WebSocket Server Settings/i)).toBeInTheDocument()
    expect(within(callout).getByText(/HUMAN_TASKS\.md/)).toBeInTheDocument()
  })

  it('says the password was rejected AND that retrying is disabled deliberately', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('auth-failed', MOCK_NOW))
    render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText(/OBS rejected the password/i)
    expect(screen.getByText(/deliberately stopped retrying/i)).toBeInTheDocument()
  })

  it('submits the typed configuration to the bridge', async () => {
    const user = userEvent.setup()
    render(<ConnectionScreen />, { wrapper: Landmark })

    const url = screen.getByLabelText(/OBS WebSocket address/i)
    expect(url).toHaveValue(DEFAULT_OBS_URL)

    await user.clear(url)
    await user.type(url, 'ws://10.0.0.7:4455')
    await user.type(screen.getByLabelText(/^Password$/i), 'hunter2')
    await user.click(screen.getByRole('button', { name: /^Connect$/i }))

    await waitFor(() => {
      expect(installed.mock.calls.connect).toEqual([
        { url: 'ws://10.0.0.7:4455', password: 'hunter2' },
      ])
    })
  })

  it('sends password: null when the field is left blank (OBS auth disabled)', async () => {
    const user = userEvent.setup()
    render(<ConnectionScreen />, { wrapper: Landmark })

    await user.click(screen.getByRole('button', { name: /^Connect$/i }))

    await waitFor(() => {
      expect(installed.mock.calls.connect).toEqual([{ url: DEFAULT_OBS_URL, password: null }])
    })
  })

  it('rejects a non-websocket URL locally instead of dialling', async () => {
    const user = userEvent.setup()
    render(<ConnectionScreen />, { wrapper: Landmark })

    const url = screen.getByLabelText(/OBS WebSocket address/i)
    await user.clear(url)
    await user.type(url, 'http://127.0.0.1:4455')
    await user.click(screen.getByRole('button', { name: /^Connect$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/ws:\/\/ or wss:\/\//i)
    expect(installed.mock.calls.connect).toHaveLength(0)
  })

  it('reveals the password with an accessibly-labelled toggle', async () => {
    const user = userEvent.setup()
    render(<ConnectionScreen />, { wrapper: Landmark })

    const password = screen.getByLabelText(/^Password$/i)
    expect(password).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: /hide password/i })).toBeInTheDocument()
  })

  it('shows the OBS versions and live scene list once connected', async () => {
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.getSceneList = ok(mockSceneList())

    render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText('30.2.3')
    expect(screen.getByText('5.5.4')).toBeInTheDocument()

    const scenes = screen.getByRole('region', { name: /^Scenes$/i })
    expect(within(scenes).getByText('Wide')).toBeInTheDocument()
    expect(within(scenes).getByText('Pulpit')).toBeInTheDocument()
    expect(within(scenes).getByText('Welcome loop')).toBeInTheDocument()
    expect(within(scenes).getByText('Program')).toBeInTheDocument()
  })

  it('reacts to a status pushed from the main process', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('idle', MOCK_NOW))
    render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText('Idle')

    // `act` because this is the main process pushing into React from outside an event handler —
    // exactly what the real IPC listener does.
    act(() => {
      installed.mock.emit(IpcEvent.obsStatus, initialObsStatus('reconnecting', Date.now()))
    })
    await screen.findByText('Reconnecting')
  })

  it('degrades to an explainer when the preload bridge is absent', async () => {
    installed.restore()
    delete window.verger
    resetObsStore()

    render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText(/privileged bridge did not load/i)
    // Reinstall so afterEach's restore has something coherent to undo.
    installed = installMockVergerApi()
  })

  it('records a refused connection without inventing a state change', async () => {
    const user = userEvent.setup()
    installed.mock.responses.getStatus = ok(initialObsStatus('idle', MOCK_NOW))
    installed.mock.responses.connect = err(ErrorCode.OBS_ERROR, 'connection refused')

    render(<ConnectionScreen />, { wrapper: Landmark })
    await screen.findByText('Idle')

    await user.click(screen.getByRole('button', { name: /^Connect$/i }))

    await screen.findByText(/connection refused/)
    expect(screen.getByText('Idle')).toBeInTheDocument()
  })

  it('has no axe violations when not configured', async () => {
    installed.mock.responses.getStatus = ok(initialObsStatus('not-configured', MOCK_NOW))
    const { container } = render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText(/OBS is not set up yet/i)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations when connected with a scene list', async () => {
    installed.mock.responses.getStatus = ok(mockConnectedStatus())
    installed.mock.responses.getSceneList = ok(mockSceneList())
    const { container } = render(<ConnectionScreen />, { wrapper: Landmark })

    await screen.findByText('30.2.3')
    expect(await axe(container)).toHaveNoViolations()
  })
})
