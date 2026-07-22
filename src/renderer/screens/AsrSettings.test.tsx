/**
 * Speech settings' contract.
 *
 * The custom vocabulary editor gets the most attention here because it is the highest-leverage
 * control in the subsystem (BLUEPRINT.md §8): the pastor's name, the church name and recurring
 * terms are exactly the words a general model gets wrong, and boosting them sharply improves
 * accuracy. So: terms can be added and removed, duplicates and blanks are refused *before* they
 * reach the bridge, and the screen explains what the list is for rather than presenting a bare box.
 *
 * The not-configured explanation is asserted too. `DEEPGRAM_API_KEY` is empty on this machine and
 * no key is coming, so the screen has to say what is missing and point at `HUMAN_TASKS.md` rather
 * than showing a fault (Standing Rule 5).
 *
 * Vocabulary fixtures are an invented church and an invented name — nothing copied from anywhere.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultAsrSettings } from '@shared/asr'
import { ErrorCode, err, ok } from '@shared/result'

import '../i18n'
import { resetAsrStore } from '../store/asrStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_AUDIO_INPUTS,
  installMockVergerApi,
  mockIdleAsrStatus,
} from '../test/mockVergerApi'
import {
  AsrSettings,
  LOCAL_MODEL_OPTIONS,
  addVocabularyTerm,
  removeVocabularyTerm,
} from './AsrSettings'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** Invented, on purpose: a placeholder church and a placeholder name. */
const CHURCH = '은혜한빛교회'
const PASTOR = '홍길동 목사'

const devices = () => Promise.resolve(ok(MOCK_AUDIO_INPUTS))

describe('addVocabularyTerm', () => {
  it('trims, collapses whitespace and appends', () => {
    expect(addVocabularyTerm([], '  은혜  한빛 ')).toEqual({
      terms: ['은혜 한빛'],
      rejected: null,
    })
  })

  it('refuses a blank', () => {
    expect(addVocabularyTerm([], '   ').rejected).toBe('blank')
  })

  it('refuses a duplicate, case-insensitively', () => {
    expect(addVocabularyTerm(['Grace Church'], 'grace church').rejected).toBe('duplicate')
    expect(addVocabularyTerm([CHURCH], CHURCH).rejected).toBe('duplicate')
  })

  it('refuses a term the shared schema would reject for length', () => {
    expect(addVocabularyTerm([], 'x'.repeat(81)).rejected).toBe('too-long')
    expect(addVocabularyTerm([], 'x'.repeat(80)).rejected).toBeNull()
  })
})

describe('removeVocabularyTerm', () => {
  it('removes the exact term and leaves the rest in order', () => {
    expect(removeVocabularyTerm([CHURCH, PASTOR, 'third'], PASTOR)).toEqual([CHURCH, 'third'])
  })
})

describe('AsrSettings', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetAsrStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('explains the missing Deepgram key and points at HUMAN_TASKS.md', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    await screen.findByRole('region', { name: /no speech provider is configured/i })
    expect(screen.getByText(/DEEPGRAM_API_KEY is empty/i)).toBeInTheDocument()
    expect(screen.getByText(/HUMAN_TASKS\.md/)).toBeInTheDocument()
    // Not a fault: the copy has to say the rest of the console is unaffected.
    expect(screen.getByText(/the rest of the console is unaffected/i)).toBeInTheDocument()
  })

  it('offers Cloud, Local and Auto, each with its own explanation', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    expect(await screen.findByRole('radio', { name: /cloud/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /local/i })).toBeInTheDocument()
    const auto = screen.getByRole('radio', { name: /auto/i })
    expect(auto).toBeChecked()
    expect(screen.getByText(/falling back to local the moment it is not/i)).toBeInTheDocument()
    expect(screen.getByText(/dies with the internet/i)).toBeInTheDocument()
  })

  it('offers both recognition languages', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    expect(await screen.findByRole('radio', { name: /^korean$/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^english$/i })).not.toBeChecked()
  })

  it('populates the device picker from what the renderer enumerated, and reports it to main', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const select = await screen.findByLabelText(/input device/i)
    await waitFor(() => {
      expect(within(select).getAllByRole('option').length).toBe(MOCK_AUDIO_INPUTS.length + 1)
    })
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(labels[0]).toMatch(/system default/i)
    expect(labels).toContain('Pulpit mic (Focusrite Scarlett Solo)')
    expect(installed.mock.calls.asrListDevices).toEqual([MOCK_AUDIO_INPUTS])
  })

  it('explains an absent device list instead of showing an empty picker', async () => {
    render(
      <AsrSettings
        listDevices={() =>
          Promise.resolve(err(ErrorCode.NOT_CONFIGURED, 'no navigator.mediaDevices'))
        }
      />,
      { wrapper: Landmark },
    )

    await screen.findByText(/did not report any audio inputs/i)
    expect(screen.getByText(/system default input will be used/i)).toBeInTheDocument()
  })

  it('offers the local model sizes, defaulting to one that fits 4 GB of VRAM', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const select = await screen.findByLabelText(/model size/i)
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual([...LOCAL_MODEL_OPTIONS])
    expect((select as HTMLSelectElement).value).toBe('small')
    expect(screen.getByText(/large-v3.{0,2} will not load/i)).toBeInTheDocument()
  })

  it('adds a vocabulary term and shows it in the list', async () => {
    const user = userEvent.setup()
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    await user.type(await screen.findByLabelText(/term to add/i), CHURCH)
    await user.click(screen.getByRole('button', { name: /add term/i }))

    const list = screen.getByRole('list', { name: /custom vocabulary terms/i })
    expect(within(list).getByText(CHURCH)).toBeInTheDocument()
    // The field clears so the operator can type the next name straight away.
    expect(screen.getByLabelText(/term to add/i)).toHaveValue('')
  })

  it('adds a term on Enter without saving the whole form', async () => {
    const user = userEvent.setup()
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    await user.type(await screen.findByLabelText(/term to add/i), `${PASTOR}{Enter}`)

    expect(screen.getByRole('list', { name: /custom vocabulary terms/i })).toHaveTextContent(PASTOR)
    expect(installed.mock.calls.asrSetSettings).toEqual([])
  })

  it('removes a term', async () => {
    const user = userEvent.setup()
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const field = await screen.findByLabelText(/term to add/i)
    await user.type(field, `${CHURCH}{Enter}`)
    await user.type(field, `${PASTOR}{Enter}`)

    await user.click(screen.getByRole('button', { name: new RegExp(`remove ${CHURCH}`, 'i') }))

    const list = screen.getByRole('list', { name: /custom vocabulary terms/i })
    expect(within(list).queryByText(CHURCH)).not.toBeInTheDocument()
    expect(within(list).getByText(PASTOR)).toBeInTheDocument()
  })

  it('refuses a duplicate term before it can reach the bridge', async () => {
    const user = userEvent.setup()
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const field = await screen.findByLabelText(/term to add/i)
    await user.type(field, `${CHURCH}{Enter}`)
    await user.type(field, `${CHURCH}{Enter}`)

    expect(await screen.findByRole('alert')).toHaveTextContent(/already in the list/i)
    expect(
      within(screen.getByRole('list', { name: /custom vocabulary terms/i })).getAllByText(CHURCH),
    ).toHaveLength(1)
  })

  it('explains what the vocabulary list is for', async () => {
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    await screen.findByText(/pastor's name, the church name, hymn titles/i)
    expect(screen.getByText(/sharply improves accuracy/i)).toBeInTheDocument()
  })

  it('saves mode, language, device, model and vocabulary in one round trip', async () => {
    const user = userEvent.setup()
    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    await user.click(await screen.findByRole('radio', { name: /local/i }))
    await user.click(screen.getByRole('radio', { name: /^english$/i }))
    await user.selectOptions(screen.getByLabelText(/input device/i), 'mock-pulpit-mic')
    await user.selectOptions(screen.getByLabelText(/model size/i), 'tiny')
    await user.type(screen.getByLabelText(/term to add/i), `${CHURCH}{Enter}`)
    await user.click(screen.getByRole('button', { name: /save speech settings/i }))

    await waitFor(() => {
      expect(installed.mock.calls.asrSetSettings).toHaveLength(1)
    })
    expect(installed.mock.calls.asrSetSettings[0]).toEqual({
      mode: 'local',
      language: 'en',
      deviceId: 'mock-pulpit-mic',
      customVocabulary: [CHURCH],
      localModel: 'tiny',
    })
    await screen.findByText(/speech settings saved/i)
  })

  it('starts from the settings the main process reported', async () => {
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())
    installed.mock.responses.asrGetSettings = ok({
      ...defaultAsrSettings(),
      mode: 'cloud',
      customVocabulary: [PASTOR],
    })

    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    expect(await screen.findByRole('radio', { name: /cloud/i })).toBeChecked()
    expect(screen.getByRole('list', { name: /custom vocabulary terms/i })).toHaveTextContent(PASTOR)
    // Configured, so there is no not-configured explainer to distract from the form.
    expect(
      screen.queryByRole('region', { name: /no speech provider is configured/i }),
    ).not.toBeInTheDocument()
  })

  it('surfaces a refused save rather than claiming it worked', async () => {
    const user = userEvent.setup()
    installed.mock.responses.asrSetSettings = err(ErrorCode.IO_ERROR, 'settings file is read-only')

    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })
    await screen.findByLabelText(/term to add/i)

    await user.click(screen.getByRole('button', { name: /save speech settings/i }))

    await screen.findByText(/settings file is read-only/i)
    expect(screen.queryByText(/speech settings saved/i)).not.toBeInTheDocument()
  })

  it('keeps a saved device selectable when it is not currently plugged in', async () => {
    installed.mock.responses.asrGetSettings = ok({
      ...defaultAsrSettings(),
      deviceId: 'unplugged-interface',
    })

    render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const select = (await screen.findByLabelText(/input device/i)) as HTMLSelectElement
    await waitFor(() => {
      expect(select.value).toBe('unplugged-interface')
    })
    expect(within(select).getByText(/not currently connected/i)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })
    await screen.findByLabelText(/term to add/i)
    await waitFor(() => {
      expect(
        within(screen.getByLabelText(/input device/i)).getAllByRole('option').length,
      ).toBeGreaterThan(1)
    })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations with terms listed and a rejection showing', async () => {
    const user = userEvent.setup()
    const { container } = render(<AsrSettings listDevices={devices} />, { wrapper: Landmark })

    const field = await screen.findByLabelText(/term to add/i)
    await user.type(field, `${CHURCH}{Enter}`)
    await user.type(field, `${CHURCH}{Enter}`)
    await screen.findByRole('alert')

    expect(await axe(container)).toHaveNoViolations()
  })
})
