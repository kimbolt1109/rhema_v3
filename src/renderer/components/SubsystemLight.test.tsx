/**
 * One light's contract.
 *
 * The assertions are all variations on one rule: **colour is never the only signal.** A booth is
 * dark, the screen is dimmed for the room, the operator is looking at it sideways, and roughly one
 * man in twelve cannot separate the red from the green at all. So:
 *
 *  1. Every {@link HealthLevel} has its own words *and* its own glyph, and no two share either.
 *  2. `not-configured` is visually and textually distinct from `degraded`. Collapsing them is how a
 *     console ends up permanently amber, which teaches its operator to ignore amber.
 *  3. `degraded` and `down` say how long they have been like that. "Reconnecting" is a different
 *     problem after four minutes than after four seconds.
 *  4. Axe is clean.
 */

import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { HealthLevel } from '@shared/health'

import '../i18n'
import { MOCK_NOW, mockSubsystemHealth } from '../test/mockVergerApi'
import { SubsystemLight, showsDuration } from './SubsystemLight'

const LEVELS: readonly HealthLevel[] = ['ok', 'not-configured', 'degraded', 'down']

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

describe('SubsystemLight', () => {
  it('gives every level its own words and its own glyph — never colour alone', () => {
    const labels = new Set<string>()
    const glyphs = new Set<string>()

    for (const level of LEVELS) {
      const { unmount } = render(
        <SubsystemLight
          subsystem={mockSubsystemHealth('obs', { level, detail: `detail for ${level}` })}
          now={MOCK_NOW}
        />,
        { wrapper: Landmark },
      )

      const light = screen.getByRole('group')
      expect(light).toHaveAttribute('data-health-level', level)

      const name = light.getAttribute('aria-label')
      expect(name).not.toBeNull()
      // The accessible name is a whole sentence: subsystem, state, and what is actually happening.
      expect(name).toContain('OBS')
      expect(name).toContain(`detail for ${level}`)
      labels.add(name ?? '')

      const glyph = light.getAttribute('data-health-icon')
      expect(glyph).not.toBeNull()
      glyphs.add(glyph ?? '')

      // The state is in text, on screen, not only in the aria-label.
      expect(screen.getByTestId('health-level-obs').textContent?.trim().length ?? 0).toBeGreaterThan(0)

      unmount()
    }

    expect(labels.size).toBe(LEVELS.length)
    expect(glyphs.size).toBe(LEVELS.length)
  })

  it('keeps not-configured plainly distinct from degraded', () => {
    const { unmount } = render(
      <SubsystemLight
        subsystem={mockSubsystemHealth('asr', { level: 'not-configured', detail: 'no key set' })}
        now={MOCK_NOW}
      />,
      { wrapper: Landmark },
    )
    const resting = screen.getByRole('group')
    const restingGlyph = resting.getAttribute('data-health-icon')
    const restingText = screen.getByTestId('health-level-asr').textContent
    unmount()

    render(
      <SubsystemLight
        subsystem={mockSubsystemHealth('asr', {
          level: 'degraded',
          detail: 'on the local model',
          stillWorks: 'a transcript is still arriving',
        })}
        now={MOCK_NOW}
      />,
      { wrapper: Landmark },
    )
    const degraded = screen.getByRole('group')

    expect(degraded.getAttribute('data-health-icon')).not.toBe(restingGlyph)
    expect(screen.getByTestId('health-level-asr').textContent).not.toBe(restingText)
    expect(degraded.getAttribute('aria-label')).not.toBe(resting.getAttribute('aria-label'))
  })

  it('shows how long a fault has lasted, and does not clutter a resting light with one', () => {
    const { unmount } = render(
      <SubsystemLight
        subsystem={mockSubsystemHealth('stream', {
          level: 'degraded',
          detail: 'reconnecting (attempt 3)',
          since: MOCK_NOW - 4 * 60_000,
        })}
        now={MOCK_NOW}
      />,
      { wrapper: Landmark },
    )
    expect(screen.getByRole('group').textContent).toContain('4m')
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('4m')
    unmount()

    render(
      <SubsystemLight
        subsystem={mockSubsystemHealth('stream', { since: MOCK_NOW - 4 * 60_000 })}
        now={MOCK_NOW}
      />,
      { wrapper: Landmark },
    )
    expect(screen.getByRole('group').textContent).not.toContain('4m')
  })

  it('only the two fault levels carry a duration', () => {
    expect(showsDuration('degraded')).toBe(true)
    expect(showsDuration('down')).toBe(true)
    expect(showsDuration('ok')).toBe(false)
    expect(showsDuration('not-configured')).toBe(false)
  })

  it('prints the detail in the large variant, where there is room for it', () => {
    render(
      <SubsystemLight
        subsystem={mockSubsystemHealth('obs', {
          level: 'down',
          detail: 'obs-websocket went away',
          stillWorks: 'OBS keeps streaming',
        })}
        size="lg"
        now={MOCK_NOW}
      />,
      { wrapper: Landmark },
    )
    expect(screen.getByText('obs-websocket went away')).toBeInTheDocument()
  })

  it('is axe clean at every level', async () => {
    for (const level of LEVELS) {
      const { container, unmount } = render(
        <SubsystemLight
          subsystem={mockSubsystemHealth('recording', { level, detail: 'detail' })}
          size="lg"
          now={MOCK_NOW}
        />,
        { wrapper: Landmark },
      )
      expect(await axe(container)).toHaveNoViolations()
      unmount()
    }
  })
})
