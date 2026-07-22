import { render, screen, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { ObsConnectionState, ObsStatus } from '@shared/obs'
import { initialObsStatus } from '@shared/obs'
import { ErrorCode } from '@shared/result'

import '../i18n'
import { MOCK_NOW } from '../test/mockVergerApi'
import { StatusIndicator } from './StatusIndicator'

/**
 * axe's `region` best-practice rule flags content that sits outside a landmark. In the real app
 * this component lives inside `<main>`; rendering it bare would produce a violation that says
 * nothing about the component.
 */
function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

const ALL_STATES: readonly ObsConnectionState[] = [
  'not-configured',
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'auth-failed',
]

function statusFor(state: ObsConnectionState, overrides: Partial<ObsStatus> = {}): ObsStatus {
  return { ...initialObsStatus(state, MOCK_NOW), ...overrides }
}

describe('StatusIndicator', () => {
  it('renders a distinct visible text label for every connection state', () => {
    const labels = new Set<string>()

    for (const state of ALL_STATES) {
      const { unmount } = render(<StatusIndicator status={statusFor(state)} />, {
        wrapper: Landmark,
      })
      const region = screen.getByRole('region', { name: /OBS connection/i })
      const label = region.querySelector('p')?.textContent ?? ''

      expect(label.length).toBeGreaterThan(0)
      // Colour is never the only signal: there is always readable text.
      labels.add(label)
      unmount()
    }

    expect(labels.size).toBe(ALL_STATES.length)
  })

  it('renders a distinct icon for every connection state', () => {
    const icons = new Set<string>()

    for (const state of ALL_STATES) {
      const { container, unmount } = render(<StatusIndicator status={statusFor(state)} />, {
        wrapper: Landmark,
      })
      const region = container.querySelector('[data-obs-state]')
      expect(region?.getAttribute('data-obs-state')).toBe(state)

      const icon = region?.getAttribute('data-obs-icon') ?? ''
      expect(icon.length).toBeGreaterThan(0)
      icons.add(icon)
      unmount()
    }

    expect(icons.size).toBe(ALL_STATES.length)
  })

  it('exposes a polite live region carrying the state, not just a colour', () => {
    render(<StatusIndicator status={statusFor('connected')} />, { wrapper: Landmark })

    const live = screen.getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live.textContent).toContain('Connected')
  })

  it('shows the attempt count and a countdown while reconnecting', () => {
    render(
      <StatusIndicator
        status={statusFor('reconnecting', {
          attempt: 7,
          since: Date.now(),
          nextRetryInMs: 12_000,
        })}
      />,
      { wrapper: Landmark },
    )

    const region = screen.getByRole('region', { name: /OBS connection/i })
    expect(within(region).getByText(/Attempt 7/)).toBeInTheDocument()
    expect(within(region).getByText(/Next try in \d+s/)).toBeInTheDocument()
  })

  it('does not render retry chrome when no retry is scheduled', () => {
    render(<StatusIndicator status={statusFor('disconnected')} />, { wrapper: Landmark })
    expect(screen.queryByText(/Next try in/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Attempt/)).not.toBeInTheDocument()
  })

  it('surfaces the last error with its code', () => {
    render(
      <StatusIndicator
        status={statusFor('auth-failed', {
          lastError: { code: ErrorCode.OBS_ERROR, message: 'authentication failed' },
        })}
      />,
      { wrapper: Landmark },
    )

    expect(screen.getByText(/OBS refused the request/)).toBeInTheDocument()
    expect(screen.getByText(/authentication failed/)).toBeInTheDocument()
  })

  it('has no axe violations in any state', async () => {
    for (const state of ALL_STATES) {
      const { container, unmount } = render(
        <StatusIndicator status={statusFor(state, { attempt: 3, nextRetryInMs: 5_000 })} />,
        { wrapper: Landmark },
      )
      expect(await axe(container)).toHaveNoViolations()
      unmount()
    }
  })
})
