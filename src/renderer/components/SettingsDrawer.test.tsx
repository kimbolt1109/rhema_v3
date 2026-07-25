/**
 * The drawer's contract: thirteen screens behind one gear, and *only* while it is open.
 *
 * The load-bearing assertion in this file is the negative one at the top: with `open: false` the
 * component renders **nothing at all**. That is not tidiness. Several of the thirteen panels own IPC
 * subscriptions, so a closed-but-mounted drawer would hold a second listener on every channel and
 * fire every handler twice for a surface nobody can see. An absence cannot be seen in a screenshot,
 * so it is asserted here against the DOM *and* against the mock bridge's live listener count for
 * every channel in `IPC_EVENT_VALUES`.
 *
 * The other three worth naming:
 *
 *  - **The nav is controlled.** A click or an arrow key calls `onSectionChange` and changes nothing
 *    by itself. `App.tsx` owns the section, and a drawer that self-navigated would drift out of step
 *    with the state that has to survive a close and a reopen.
 *  - **The old `app.section.*` labels are reused verbatim, in the old order.** The redesign is a
 *    re-composition, not a rewrite, so there is no new copy to translate and no window in which the
 *    Korean bundle is behind English. Asserting the real English strings is what catches a new key
 *    being invented here.
 *  - **The versions line is in the header.** It is the first thing a bug report asks for and the
 *    title bar that used to carry it is gone, so it has to be here — and it has to degrade to a
 *    sentence, not a blank, when the preload bridge is missing (Standing Rule 5).
 *
 * Only cheap sections are actually mounted (`shortcuts`, `connection`, `preflight`). Because the
 * component is fully controlled, an arrow key can be asserted without ever rendering the section it
 * names, which is why the wrap-around tests cost nothing.
 */

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IPC_EVENT_VALUES, IpcEvent } from '@shared/ipc'

import '../i18n'
import { resetAsrStore } from '../store/asrStore'
import { resetCameraStore } from '../store/cameraStore'
import { resetCueStore } from '../store/cueStore'
import { resetGoLiveStore } from '../store/goLiveStore'
import { resetHealthStore } from '../store/healthStore'
import { resetObsStore } from '../store/obsStore'
import { resetOverlayStore } from '../store/overlayStore'
import { resetPlanStore } from '../store/planStore'
import { resetYouTubeStore } from '../store/youtubeStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import { MOCK_APP_VERSIONS, installMockVergerApi } from '../test/mockVergerApi'
import type { DrawerSectionId } from './SettingsDrawer'
import { DRAWER_SECTIONS, SettingsDrawer } from './SettingsDrawer'

/** Every section label, in order, exactly as the tablist this replaced spelled them. */
const SECTION_LABELS: readonly string[] = [
  'Preflight',
  'Connection',
  'Cameras',
  'Overlay',
  'Plan',
  'Transcript',
  'Automation',
  'GO LIVE',
  'Status',
  'Go Live settings',
  'Camera setup',
  'Speech settings',
  'Shortcuts',
]

/** The versions line the header renders once the bridge answers. Built from the fixture. */
const VERSIONS_LINE = `Verger ${MOCK_APP_VERSIONS.app} · Electron ${MOCK_APP_VERSIONS.electron} · Chromium ${MOCK_APP_VERSIONS.chrome}`

/**
 * Flush the async work a freshly mounted section kicked off.
 *
 * Mounting the drawer fires its version fetch, and mounting a section fires that screen's store
 * hydration. Both land after the synchronous assertions unless they are drained here, and an
 * un-drained one shows up as React's "not wrapped in act" warning — noise that would eventually
 * hide a real one.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** What the parent was told. Assert against these arrays rather than on spies. */
interface DrawerCalls {
  readonly sections: DrawerSectionId[]
  readonly closes: number[]
}

interface DrawerView extends DrawerCalls {
  readonly container: HTMLElement
  /** Re-render with a different section, the way the controlling parent would. */
  readonly show: (section: DrawerSectionId) => void
}

/**
 * Render the drawer inside a `<main>`.
 *
 * The landmark is for axe's `region` rule — in the app the drawer sits over the console, which is
 * itself inside `<main>`; see `PlanRunner.test.tsx`'s `Landmark` helper for the same trick.
 */
function setup({
  open = true,
  section = 'shortcuts',
}: { open?: boolean; section?: DrawerSectionId } = {}): DrawerView {
  const sections: DrawerSectionId[] = []
  const closes: number[] = []

  const tree = (currentSection: DrawerSectionId, currentOpen: boolean): React.JSX.Element => (
    <main>
      <SettingsDrawer
        open={currentOpen}
        section={currentSection}
        onSectionChange={(next) => {
          sections.push(next)
        }}
        onClose={() => {
          closes.push(closes.length)
        }}
        onBindingsChange={() => undefined}
      />
    </main>
  )

  const view = render(tree(section, open))

  return {
    sections,
    closes,
    container: view.container,
    show: (next) => {
      view.rerender(tree(next, true))
    },
  }
}

describe('SettingsDrawer', () => {
  let installed: InstalledMockVergerApi

  // Every one of the thirteen screens reaches for the preload bridge, and the stores they read are
  // module singletons that outlive a single test — a snapshot leaked from one section's test would
  // silently change what the next one renders.
  beforeEach(() => {
    installed = installMockVergerApi()
    resetObsStore()
    resetOverlayStore()
    resetCameraStore()
    resetPlanStore()
    resetCueStore()
    resetAsrStore()
    resetGoLiveStore()
    resetYouTubeStore()
    resetHealthStore()
  })

  afterEach(() => {
    installed.restore()
  })

  describe('closed', () => {
    it('RENDERS NOTHING AT ALL, so no panel can hold a second IPC listener', async () => {
      const view = setup({ open: false, section: 'connection' })

      expect(screen.queryByTestId('settings-drawer')).toBeNull()
      expect(screen.queryByTestId('settings-drawer-root')).toBeNull()
      expect(screen.queryByTestId('settings-drawer-backdrop')).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryAllByRole('tab')).toHaveLength(0)

      // The reason the emptiness matters: nothing is mounted, so nothing is subscribed.
      for (const event of IPC_EVENT_VALUES) {
        expect(installed.mock.listenerCount(event)).toBe(0)
      }

      // …and the zero above is a real contrast, not a vacuous one: `ConnectionScreen` does take a
      // live `obsStatus` subscription the moment it is mounted. A drawer that stayed mounted while
      // closed would therefore be holding this listener, and every reopen would add another.
      view.show('connection')
      expect(installed.mock.listenerCount(IpcEvent.obsStatus)).toBe(1)
      await settle()
    })
  })

  describe('modality', () => {
    it('is a modal dialog with an accessible name', async () => {
      setup()

      const dialog = screen.getByRole('dialog', { name: 'Setup and settings' })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(dialog).toBe(screen.getByTestId('settings-drawer'))
      await settle()
    })

    it('closes on the close button and on the backdrop', async () => {
      const user = userEvent.setup()
      const view = setup()
      await settle()

      await user.click(screen.getByRole('button', { name: 'Close setup' }))
      expect(view.closes).toHaveLength(1)

      // The backdrop is a plain aria-hidden div, but a click anywhere off the panel must still get
      // the operator out — that is the gesture everybody tries first.
      await user.click(screen.getByTestId('settings-drawer-backdrop'))
      expect(view.closes).toHaveLength(2)
    })
  })

  describe('the section list', () => {
    it('offers every section as a tab, reusing the console’s existing labels and order', async () => {
      setup()
      await settle()

      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(DRAWER_SECTIONS.length)
      expect(tabs).toHaveLength(13)
      expect(tabs.map((tab) => tab.textContent)).toEqual(SECTION_LABELS)

      // Spot-checks against the real `app.section.*` English copy, so a renamed key is caught here
      // rather than by an operator who cannot find the camera setup.
      for (const label of ['Preflight', 'Connection', 'Cameras', 'Status', 'Shortcuts']) {
        expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
      }
    })

    it('marks exactly one tab selected, and does not navigate itself when another is clicked', async () => {
      const user = userEvent.setup()
      const view = setup({ section: 'connection' })
      await settle()

      const selected = screen
        .getAllByRole('tab')
        .filter((tab) => tab.getAttribute('aria-selected') === 'true')
      expect(selected.map((tab) => tab.textContent)).toEqual(['Connection'])

      await user.click(screen.getByRole('tab', { name: 'Shortcuts' }))

      expect(view.sections).toEqual(['shortcuts'])
      // Fully controlled: the click reported an intent and changed nothing. `App.tsx` owns the
      // section, and a drawer that moved on its own would disagree with the state that persists.
      expect(screen.getByRole('tab', { name: 'Connection' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute(
        'aria-selected',
        'false',
      )
    })

    it('walks up with ArrowUp and wraps past the last section with ArrowDown', async () => {
      const user = userEvent.setup()
      const view = setup({ section: 'shortcuts' })
      const tab = screen.getByRole('tab', { name: 'Shortcuts' })
      await settle()

      tab.focus()
      await user.keyboard('{ArrowUp}')
      expect(view.sections).toEqual(['asrSettings'])
      // Roving focus, as the tablist this replaced had: the key moves the focus, not just the state.
      expect(screen.getByRole('tab', { name: 'Speech settings' })).toHaveFocus()

      tab.focus()
      await user.keyboard('{ArrowDown}')
      // `shortcuts` is the last entry, so down wraps to the first rather than dead-ending.
      expect(view.sections).toEqual(['asrSettings', 'preflight'])
    })

    it('walks down with ArrowDown and wraps past the first section with ArrowUp', async () => {
      const user = userEvent.setup()
      const view = setup({ section: 'preflight' })
      const tab = screen.getByRole('tab', { name: 'Preflight' })
      await settle()

      tab.focus()
      await user.keyboard('{ArrowDown}')
      expect(view.sections).toEqual(['connection'])

      tab.focus()
      await user.keyboard('{ArrowUp}')
      // `preflight` is the first entry, so up wraps to the last.
      expect(view.sections).toEqual(['connection', 'shortcuts'])
    })
  })

  describe('the content area', () => {
    it('renders the selected section’s own screen, and swaps it when the section changes', async () => {
      const view = setup({ section: 'shortcuts' })
      await settle()

      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveAttribute('aria-labelledby', 'section-tab-shortcuts')

      // Something real from `ShortcutSettings`, not a marker the drawer could have faked.
      expect(
        within(panel).getByRole('heading', {
          level: 1,
          name: 'Shortcuts, foot pedals & Stream Deck',
        }),
      ).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Save shortcuts' })).toBeInTheDocument()

      view.show('connection')
      await settle()

      expect(screen.getByRole('tabpanel')).toHaveAttribute(
        'aria-labelledby',
        'section-tab-connection',
      )
      expect(screen.getByRole('heading', { level: 1, name: 'OBS connection' })).toBeInTheDocument()
      // The old screen is gone, not merely hidden — see the module note on doubled listeners.
      expect(screen.queryByRole('button', { name: 'Save shortcuts' })).toBeNull()
    })
  })

  describe('the versions line', () => {
    it('carries the runtime versions in the header, for bug reports', async () => {
      setup()

      // The fetch is an async IPC round trip; the header renders the fallback first.
      await expect(screen.findByText(VERSIONS_LINE)).resolves.toBeInTheDocument()
      expect(installed.mock.calls.getVersions).not.toHaveLength(0)
    })

    it('says the versions are unavailable rather than rendering a blank with no bridge', () => {
      // Standing Rule 5: a missing preload bridge is a degraded mode, never a crash and never an
      // empty line the operator would read as "there is no version".
      installed.restore()
      expect(window.verger).toBeUndefined()

      setup({ section: 'shortcuts' })

      expect(screen.getByText('Version information unavailable')).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has no axe violations while open', async () => {
      const view = setup({ section: 'shortcuts' })
      await settle()

      await expect(axe(view.container)).resolves.toHaveNoViolations()
    })
  })
})
