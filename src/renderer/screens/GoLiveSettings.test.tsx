/**
 * Go Live settings' contract.
 *
 * The two properties that matter most are the ones that bite in production rather than in a demo:
 *
 *  - **With no Google credentials the screen is genuinely useful and genuinely inert.** It says
 *    what to do, points at HUMAN_TASKS.md, and every control is disabled. That is the state this
 *    build is actually in, so it is tested first and hardest.
 *  - **The RTMP stream key is nowhere on this screen.** Asserted negatively — no control is
 *    labelled as a key, and none of the rendered values looks like one — because the failure mode
 *    is a well-meaning future change adding a "handy" read-only field.
 *
 * Everything runs against `createMockVergerApi`. No test here makes a network call.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode, err, ok } from '@shared/result'
import type { YouTubeStatus } from '@shared/youtube'
import { defaultBroadcastTemplate, expandTitleTemplate } from '@shared/youtube'

import '../i18n'
import { resetYouTubeStore } from '../store/youtubeStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_PREFLIGHT_CCLI,
  MOCK_PREFLIGHT_METADATA,
  MOCK_YOUTUBE_CHANNEL,
  installMockVergerApi,
  mockBroadcast,
  mockNotConfiguredYouTubeStatus,
  mockPersistentStream,
  mockSignedInYouTubeStatus,
} from '../test/mockVergerApi'
import { GoLiveSettings, localeForTitles, previewDate, scheduledStartToIso } from './GoLiveSettings'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Configured, but nobody has consented yet. */
function signedOutStatus(): YouTubeStatus {
  return mockNotConfiguredYouTubeStatus({
    auth: { state: 'signed-out', channel: null, lastError: null },
  })
}

/** Every form control on the screen, so a negative assertion can sweep all of them. */
function formControls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('input, textarea, select')].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )
}

describe('GoLiveSettings with no Google credentials', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    // The fake's default is not-configured, which is what this machine really is.
    installed = installMockVergerApi()
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('explains exactly how to set up the OAuth client, in order', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /youtube is not set up yet/i })

    const steps = screen.getByRole('list', { name: /how to set it up/i })
    const items = within(steps).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent(/google cloud console/i)
    expect(items[1]).toHaveTextContent(/youtube data api v3/i)
    expect(items[2]).toHaveTextContent(/desktop app/i)
    expect(items[3]).toHaveTextContent(/GOOGLE_CLIENT_ID/)
    expect(items[3]).toHaveTextContent(/GOOGLE_CLIENT_SECRET/)
  })

  it('points at HUMAN_TASKS.md and says the rest of the app is unaffected', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByText(/HUMAN_TASKS\.md/)
    expect(screen.getByText(/obs keeps streaming and recording/i)).toBeInTheDocument()
  })

  it('disables every control instead of hiding them', async () => {
    const { container } = render(<GoLiveSettings />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /youtube is not set up yet/i })

    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /save template/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /create the broadcast/i })).toBeDisabled()

    const controls = formControls(container)
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      expect(control).toBeDisabled()
    }
  })

  it('never crashes and still renders the template it would use', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    const titleField = await screen.findByLabelText(/title template/i)
    expect(titleField).toHaveValue(defaultBroadcastTemplate().titleTemplate)
    expect(screen.getByRole('heading', { name: /go live settings/i })).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<GoLiveSettings />, { wrapper: Landmark })
    await screen.findByRole('region', { name: /youtube is not set up yet/i })

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('GoLiveSettings when the bridge never loaded', () => {
  beforeEach(() => {
    delete window.verger
    resetYouTubeStore()
  })

  it('explains the missing bridge rather than rendering a blank screen', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /the privileged bridge did not load/i })
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeDisabled()
  })
})

describe('GoLiveSettings sign-in', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ youtubeGetStatus: ok(signedOutStatus()) })
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('calls through to the bridge when Sign in is pressed', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const button = await screen.findByRole('button', { name: /sign in with google/i })
    await waitFor(() => {
      expect(button).toBeEnabled()
    })
    await user.click(button)

    await waitFor(() => {
      expect(installed.mock.calls.youtubeSignIn).toHaveLength(1)
    })
  })

  it('shows the setup guidance no longer, once an OAuth client exists', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })
    await screen.findByRole('button', { name: /sign in with google/i })

    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: /youtube is not set up yet/i }),
      ).not.toBeInTheDocument()
    })
  })

  it('surfaces a refused sign-in rather than claiming it worked', async () => {
    const user = userEvent.setup()
    installed.mock.responses.youtubeSignIn = err(ErrorCode.TIMEOUT, 'consent window timed out')

    render(<GoLiveSettings />, { wrapper: Landmark })
    const button = await screen.findByRole('button', { name: /sign in with google/i })
    await waitFor(() => {
      expect(button).toBeEnabled()
    })
    await user.click(button)

    await screen.findByText(/consent window timed out/i)
    expect(screen.queryByText(MOCK_YOUTUBE_CHANNEL.title)).not.toBeInTheDocument()
  })
})

describe('GoLiveSettings when signed in', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({ youtubeGetStatus: ok(mockSignedInYouTubeStatus()) })
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('names the channel it is about to broadcast to, and says to check it', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByText(MOCK_YOUTUBE_CHANNEL.title)
    expect(screen.getByText(/connected as/i)).toBeInTheDocument()
    expect(screen.getByText(/check this is the right channel/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeEnabled()
  })

  it('expands {date} in the live title preview', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const titleField = await screen.findByLabelText(/title template/i)
    await waitFor(() => {
      expect(titleField).toBeEnabled()
    })

    // A fixed scheduled start makes the expansion deterministic: the preview is *for that day*.
    fireEvent.change(screen.getByLabelText(/scheduled start/i), {
      target: { value: '2024-03-03T10:00' },
    })
    await user.clear(titleField)
    await user.type(titleField, 'Sunday Service — {{date}')

    const expected = expandTitleTemplate(
      'Sunday Service — {date}',
      new Date('2024-03-03T10:00'),
      localeForTitles(i18n.language),
    )
    await waitFor(() => {
      expect(screen.getByTestId('title-preview')).toHaveTextContent(expected)
    })
    expect(screen.getByTestId('title-preview')).not.toHaveTextContent('{date}')
    expect(expected).not.toContain('{date}')
  })

  it('warns, immediately and in words, when privacy is set to public', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const privacy = await screen.findByLabelText(/privacy/i)
    await waitFor(() => {
      expect(privacy).toBeEnabled()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.selectOptions(privacy, 'public')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/this broadcast will be public/i)
    expect(alert).toHaveTextContent(/cannot be taken back/i)

    // And it goes away again when the operator backs out, rather than sticking around as noise.
    await user.selectOptions(privacy, 'unlisted')
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('saves the template through the bridge', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const description = await screen.findByLabelText(/description/i)
    await waitFor(() => {
      expect(description).toBeEnabled()
    })
    await user.type(description, 'Services at 11:00.')
    await user.click(screen.getByRole('button', { name: /save template/i }))

    await waitFor(() => {
      expect(installed.mock.calls.youtubeSetTemplate).toHaveLength(1)
    })
    expect(installed.mock.calls.youtubeSetTemplate[0]?.description).toBe('Services at 11:00.')
    await screen.findByText(/template saved/i)
  })

  it('refuses an empty title template before it reaches the bridge', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const titleField = await screen.findByLabelText(/title template/i)
    await waitFor(() => {
      expect(titleField).toBeEnabled()
    })
    await user.clear(titleField)
    await user.click(screen.getByRole('button', { name: /save template/i }))

    await screen.findByText(/a title is required/i)
    expect(installed.mock.calls.youtubeSetTemplate).toEqual([])
    expect(screen.queryByText(/template saved/i)).not.toBeInTheDocument()
  })

  it('creates a broadcast with the chosen scheduled start', async () => {
    const user = userEvent.setup()
    render(<GoLiveSettings />, { wrapper: Landmark })

    const create = await screen.findByRole('button', { name: /create the broadcast/i })
    await waitFor(() => {
      expect(create).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText(/scheduled start/i), {
      target: { value: '2024-03-03T10:00' },
    })
    await user.click(create)

    await waitFor(() => {
      expect(installed.mock.calls.youtubeCreateBroadcast).toHaveLength(1)
    })
    expect(installed.mock.calls.youtubeCreateBroadcast[0]?.scheduledStartTime).toBe(
      new Date('2024-03-03T10:00').toISOString(),
    )
  })

  it('reports the persistent stream and its health, and never a key', async () => {
    const { container } = render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /persistent stream/i })
    expect(screen.getByText(mockPersistentStream().title)).toBeInTheDocument()
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument()

    // The negative assertion this screen exists to keep true.
    expect(screen.queryByLabelText(/key/i)).not.toBeInTheDocument()
    for (const control of formControls(container)) {
      const name = control.getAttribute('aria-label') ?? control.id
      const label =
        control.id.length > 0
          ? (container.querySelector(`label[for="${control.id}"]`)?.textContent ?? '')
          : ''
      expect(`${name} ${label}`).not.toMatch(/key|secret|비밀/i)
    }
    // And the screen says so, so nobody goes looking for a field that was never there.
    expect(screen.getByText(/deliberately not shown here/i)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<GoLiveSettings />, { wrapper: Landmark })
    await screen.findByText(MOCK_YOUTUBE_CHANNEL.title)

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('GoLiveSettings pre-flight', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi({
      youtubeGetStatus: ok(
        mockSignedInYouTubeStatus({
          preflight: [MOCK_PREFLIGHT_CCLI, MOCK_PREFLIGHT_METADATA],
          broadcast: mockBroadcast(),
        }),
      ),
    })
    resetYouTubeStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('distinguishes a blocking error from a warning in words, not only in colour', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    const list = await screen.findByRole('list', { name: /pre-flight problems/i })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)

    // Errors first, and each carries its own visible severity word.
    expect(items[0]).toHaveAttribute('data-preflight-severity', 'error')
    expect(items[0]).toHaveTextContent(/blocks going live/i)
    expect(items[0]).toHaveTextContent(/CCLI Streaming Licence/i)

    expect(items[1]).toHaveAttribute('data-preflight-severity', 'warning')
    expect(items[1]).toHaveTextContent(/warning/i)
    expect(items[1]).toHaveTextContent(/CCLI song number/i)

    expect(screen.getByText(/has to be fixed before the GO LIVE button will run/i)).toBeVisible()
  })

  it('keeps the CCLI streaming-licence gate on screen as a legal requirement', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /pre-flight/i })
    expect(screen.getByText(/legal gate, not a reminder/i)).toBeInTheDocument()
  })

  it('blocks creating a broadcast while an error stands', async () => {
    render(<GoLiveSettings />, { wrapper: Landmark })

    const create = await screen.findByRole('button', { name: /create the broadcast/i })
    await waitFor(() => {
      expect(create).toBeDisabled()
    })
    expect(installed.mock.calls.youtubeCreateBroadcast).toEqual([])
  })

  it('says so plainly when there is nothing to fix', async () => {
    installed.mock.responses.youtubeGetStatus = ok(mockSignedInYouTubeStatus())
    resetYouTubeStore()

    render(<GoLiveSettings />, { wrapper: Landmark })

    await screen.findByText(/no pre-flight problems/i)
    expect(screen.queryByRole('list', { name: /pre-flight problems/i })).not.toBeInTheDocument()
  })

  it('has no axe violations while showing pre-flight problems', async () => {
    const { container } = render(<GoLiveSettings />, { wrapper: Landmark })
    await screen.findByRole('list', { name: /pre-flight problems/i })

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('GoLiveSettings helpers', () => {
  it('previews against the scheduled day when one is chosen, otherwise today', () => {
    const now = new Date('2024-01-01T00:00:00Z')
    expect(previewDate('', now)).toBe(now)
    expect(previewDate('not a date', now)).toBe(now)
    expect(previewDate('2024-03-03T10:00', now).getFullYear()).toBe(2024)
  })

  it('converts a datetime-local value to an ISO instant, and a blank to null', () => {
    expect(scheduledStartToIso('')).toBeNull()
    expect(scheduledStartToIso('   ')).toBeNull()
    expect(scheduledStartToIso('nonsense')).toBeNull()
    expect(scheduledStartToIso('2024-03-03T10:00')).toBe(new Date('2024-03-03T10:00').toISOString())
  })

  it('uses an unambiguous date form for English and a Korean one for Korean', () => {
    expect(localeForTitles('en-US')).toBe('en-CA')
    expect(localeForTitles('ko')).toBe('ko-KR')
    expect(localeForTitles('ko-KR')).toBe('ko-KR')
  })
})
