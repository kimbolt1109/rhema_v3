/**
 * The Overlay panel's contract, asserted at the UI level.
 *
 * The load-bearing test here is **layer independence**: `src/main/overlay/reducer.test.ts` proves
 * the reducer never lets one layer touch another, but a reducer cannot stop a *button* from firing
 * two commands. BLUEPRINT.md §6's guarantee only holds if the control surface also keeps them
 * apart, so "Hide lower third sends nothing about scripture or slide" is asserted here, against
 * the real command log.
 *
 * Standing Rule 4: no verse text is authored anywhere in this repo, fixtures included. Where a
 * test needs a verse body it uses an obvious placeholder.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcEvent } from '@shared/ipc'
import { overlayPageUrl } from '@shared/net'
import { emptyOverlayState } from '@shared/overlay'
import { ok } from '@shared/result'

import '../i18n'
import { resetOverlayStore } from '../store/overlayStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  installMockVergerApi,
  mockOverlayServerInfo,
  mockOverlayState,
} from '../test/mockVergerApi'
import { CLEAR_ALL_HOLD_MS, OverlayPanel } from './OverlayPanel'

/** The panel lives inside `<main>` in App.tsx; axe's `region` rule expects a landmark. */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Just the command names the UI sent, in order. */
function sentNames(installed: InstalledMockVergerApi): string[] {
  return installed.mock.calls.overlaySend.map((command) => command.name)
}

describe('OverlayPanel', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetOverlayStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('renders the exact URL to paste into an OBS Browser Source, with a copy button', async () => {
    render(<OverlayPanel />, { wrapper: Landmark })

    await screen.findByText(/paste this into an obs browser source/i)
    // The URL comes from OverlayServerInfo.pageUrl — never string-built in the component.
    expect(screen.getByTestId('overlay-page-url')).toHaveTextContent(overlayPageUrl())
    expect(screen.getByRole('button', { name: /copy url/i })).toBeInTheDocument()
  })

  it('shows the bound address, the running state and the attached-overlay count', async () => {
    installed.mock.responses.overlayGetServerInfo = ok(mockOverlayServerInfo({ clients: 2 }))
    render(<OverlayPanel />, { wrapper: Landmark })

    const block = await screen.findByRole('region', { name: /overlay server/i })
    expect(within(block).getByText('Running')).toBeInTheDocument()
    expect(within(block).getByText('127.0.0.1:7320')).toBeInTheDocument()
    expect(within(block).getByText('2')).toBeInTheDocument()
  })

  it('sends exactly one lowerThird.show with the typed lines and chosen template', async () => {
    const user = userEvent.setup()
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    await user.type(screen.getByLabelText(/^Line 1$/i), 'Jane Doe')
    await user.type(screen.getByLabelText(/^Line 2$/i), 'Worship leader')
    await user.click(screen.getByRole('radio', { name: /boxed/i }))
    await user.click(screen.getByRole('button', { name: /show lower third/i }))

    await waitFor(() => {
      expect(installed.mock.calls.overlaySend).toEqual([
        {
          channel: 'command',
          name: 'lowerThird.show',
          payload: { line1: 'Jane Doe', line2: 'Worship leader', template: 'boxed' },
        },
      ])
    })
  })

  it('hiding the lower third touches NO other layer — the independence guarantee, at the UI', async () => {
    const user = userEvent.setup()
    installed.mock.responses.overlayGetState = ok(
      mockOverlayState({
        scripture: {
          visible: true,
          reference: '요한복음 3:16',
          text: 'VERSE TEXT PLACEHOLDER',
          translation: '개역개정',
          attribution: 'PLACEHOLDER ATTRIBUTION',
        },
        slide: { visible: true, src: 'slides/point1.png' },
      }),
    )
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    await user.click(screen.getByRole('button', { name: /hide lower third/i }))

    await waitFor(() => {
      expect(sentNames(installed)).toEqual(['lowerThird.hide'])
    })
    // Nothing about scripture or slide left the control surface at all.
    expect(sentNames(installed).some((name) => name.startsWith('scripture.'))).toBe(false)
    expect(sentNames(installed).some((name) => name.startsWith('slide.'))).toBe(false)
    expect(sentNames(installed)).not.toContain('clearAll')
  })

  it('showing a slide touches no other layer either', async () => {
    const user = userEvent.setup()
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    await user.type(screen.getByLabelText(/image url or path/i), 'slides/point1.png')
    await user.click(screen.getByRole('button', { name: /show slide/i }))

    await waitFor(() => {
      expect(sentNames(installed)).toEqual(['slide.show'])
    })
  })

  it('sends a null attribution when the field is blank, never an empty credit line', async () => {
    const user = userEvent.setup()
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    await user.type(screen.getByLabelText(/^Reference$/i), '요한복음 3:16')
    await user.type(screen.getByLabelText(/verse text/i), 'VERSE TEXT PLACEHOLDER')
    await user.click(screen.getByRole('button', { name: /show scripture/i }))

    await waitFor(() => {
      expect(installed.mock.calls.overlaySend).toEqual([
        {
          channel: 'command',
          name: 'scripture.show',
          payload: {
            reference: '요한복음 3:16',
            text: 'VERSE TEXT PLACEHOLDER',
            translation: '',
            attribution: null,
          },
        },
      ])
    })
  })

  it('labels the verse-text field as supplied at runtime — Verger never ships verse text', async () => {
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    expect(screen.getByLabelText(/verse text \(supplied at runtime\)/i)).toBeInTheDocument()
    expect(screen.getByText(/verger never ships verse text/i)).toBeInTheDocument()
  })

  it('reads out what is on screen, including the revision', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState({ revision: 12 }))
    render(<OverlayPanel />, { wrapper: Landmark })

    const readout = await screen.findByRole('region', { name: /on screen now/i })
    await within(readout).findByText(/revision 12/i)

    const lowerThirdRow = readout.querySelector('[data-layer="lowerThird"]')
    expect(lowerThirdRow).not.toBeNull()
    expect(lowerThirdRow).toHaveAttribute('data-layer-visible', 'true')
    expect(readout.querySelector('[data-layer="slide"]')).toHaveAttribute(
      'data-layer-visible',
      'false',
    )
  })

  it('re-renders from a pushed snapshot rather than from local guesses', async () => {
    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /on screen now/i })

    act(() => {
      installed.mock.emit(IpcEvent.overlayState, mockOverlayState({ revision: 30 }))
    })
    await screen.findByText(/revision 30/i)

    act(() => {
      installed.mock.emit(IpcEvent.overlayState, emptyOverlayState())
    })
    await screen.findByText(/revision 0/i)
  })

  it('warns loudly when a layer is visible but no overlay is attached', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState())
    installed.mock.responses.overlayGetServerInfo = ok(mockOverlayServerInfo({ clients: 0 }))

    render(<OverlayPanel />, { wrapper: Landmark })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/no overlay is attached/i)
    expect(alert).toHaveTextContent(/nothing is actually on screen/i)
  })

  it('does not warn when nothing is visible — an idle overlay with no client is normal', async () => {
    installed.mock.responses.overlayGetState = ok(emptyOverlayState())
    installed.mock.responses.overlayGetServerInfo = ok(mockOverlayServerInfo({ clients: 0 }))

    render(<OverlayPanel />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /overlay server/i })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    installed.mock.responses.overlayGetState = ok(mockOverlayState())
    const { container } = render(<OverlayPanel />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /overlay server/i })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('OverlayPanel CLEAR ALL', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    vi.useFakeTimers()
    installed = installMockVergerApi()
    resetOverlayStore()
  })

  afterEach(() => {
    installed.restore()
    vi.useRealTimers()
  })

  /** Let `hydrate()`'s promises settle without leaving fake timers. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('fires nothing on a tap and only clears after a full hold', async () => {
    render(<OverlayPanel />, { wrapper: Landmark })
    await settle()

    const clear = screen.getByRole('button', { name: /clear all overlays/i })
    // The accessible name has to say it is a hold, not a tap.
    expect(clear).toHaveAccessibleName(/hold for 2 seconds/i)

    // A tap, and a hold that stops short, both do nothing at all.
    fireEvent.pointerDown(clear)
    fireEvent.pointerUp(clear)
    fireEvent.pointerDown(clear)
    act(() => {
      vi.advanceTimersByTime(CLEAR_ALL_HOLD_MS - 300)
    })
    fireEvent.pointerUp(clear)
    await settle()
    expect(sentNames(installed)).toEqual([])

    // A complete hold does.
    fireEvent.pointerDown(clear)
    act(() => {
      vi.advanceTimersByTime(CLEAR_ALL_HOLD_MS + 200)
    })
    fireEvent.pointerUp(clear)
    await settle()

    expect(sentNames(installed)).toEqual(['clearAll'])
    expect(installed.mock.calls.overlaySend[0]?.payload).toEqual({})
  })
})
