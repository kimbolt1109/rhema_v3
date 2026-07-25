/**
 * The app shell — two things on screen, and a drawer for everything else.
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │                                              │
 * │   SlideGrid — the whole surface              │  ← no header, no tabs, no sidebar
 * │                              ┌────────────┐  │
 * │                              │ suggestion │  │  ← only while one is pending
 * │                              └────────────┘  │
 * ├──────────────────────────────────────────────┤
 * │ BottomBar — the bar IS the progress fill     │  ← 80px
 * └──────────────────────────────────────────────┘
 * ```
 *
 * The previous shell was a title bar, a health strip, an always-present suggestion strip, thirteen
 * tabs and a panel. All thirteen sections still exist, unchanged, inside `SettingsDrawer`; during a
 * service the operator sees their deck and one bar.
 *
 * ## Every subsystem is hydrated here, and that is a fix
 *
 * The old shell kept six stores live for the session and left `plan`, `camera` and `obs` to whichever
 * panel happened to be open. That was survivable when the plan lived in a tab. It is not survivable
 * now: the grid *is* the plan and the bar *is* the OBS/camera readout, so all nine subsystems
 * hydrate and subscribe at the root. A store that only updates while its own panel is mounted is the
 * same defect `STATUS.md` cycles 2, 4, 5 and 8 record four times over.
 *
 * ## The keyboard, finally connected
 *
 * `useServiceActions` registers the handlers; this shell decides which keys reach them:
 *
 * - The operator's keymap is filtered through `isImplementedAction`, so a key bound to an action
 *   nothing implements keeps its browser default instead of being swallowed into silence.
 * - The service keymap is **suspended while the drawer is open** (`enabled: !drawerOpen`). Without
 *   that, SPACE pressed on a button inside the plan editor would advance the live service instead of
 *   activating the control under the operator's finger — `useKeyboardActions` calls
 *   `preventDefault()` on every key it owns, so the button would never see the press.
 * - `Ctrl+,` and `Esc` are *chrome*, not service actions, so they live in {@link useConsoleKeys} and
 *   stay live even while the service keymap is suspended. `Esc` closes the drawer and nothing else;
 *   with the drawer shut it keeps its existing meaning, which is a two-second HOLD to hand control
 *   back from the AI. A bare `Esc` tap still does nothing, deliberately.
 *
 * ## Why the suggestion card floats
 *
 * A suggestion has a deadline measured in seconds, so it cannot live behind a drawer. It also must
 * not be a permanent strip — the brief is explicit that nothing but the grid and the bar is on
 * screen during normal operation. So it is absolutely positioned above the bar and mounted **only
 * while something is pending**, which is exactly when it has something to say. It is passed no
 * dispatcher: `useServiceActions` owns the `confirm`/`dismiss` registration now, and two registered
 * handlers would confirm the same suggestion twice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { KeyBinding } from '@shared/actions'
import { withPedalAliases } from '@shared/actions'

import { BottomBar } from './components/BottomBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import type { DrawerSectionId } from './components/SettingsDrawer'
import { SettingsDrawer } from './components/SettingsDrawer'
import { SlideGrid } from './components/SlideGrid'
import { createActionDispatcher } from './input/ActionDispatcher'
import { loadBindings } from './input/bindings'
import { useKeyboardActions } from './input/useKeyboardActions'
import { isImplementedAction, useServiceActions } from './input/useServiceActions'
import { SuggestionPanel } from './screens/SuggestionPanel'
import { useAsrStore } from './store/asrStore'
import { useCameraStore } from './store/cameraStore'
import { useCueStore } from './store/cueStore'
import { useGoLiveStore } from './store/goLiveStore'
import { useHealthStore } from './store/healthStore'
import { useObsStore } from './store/obsStore'
import { useOverlayStore } from './store/overlayStore'
import { usePlanStore } from './store/planStore'
import { useYouTubeStore } from './store/youtubeStore'

/**
 * Marker for "Verger has run on this machine before".
 *
 * Unchanged from the tabbed shell on purpose: a church PC that already ran the portable build must
 * not be shown the preflight checklist a second time just because the UI moved.
 */
const PREFLIGHT_SEEN_KEY = 'verger.preflightSeen'

/**
 * Whether this is the first launch on this machine — in which case the drawer opens on Preflight.
 *
 * Reads *and writes* the marker, so it is only ever true once. Storage-disabled falls through to
 * `false`: a booth operator who cannot persist a flag should get the console, not a checklist every
 * single Sunday.
 */
export function isFirstRunOnThisMachine(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(PREFLIGHT_SEEN_KEY) === null) {
      localStorage.setItem(PREFLIGHT_SEEN_KEY, '1')
      return true
    }
  } catch {
    // Private-mode / storage-disabled: fall through.
  }
  return false
}

/** Reflect the active UI language onto `<html lang>` so the OS/AT picks the right voice. */
function useDocumentLanguage(): void {
  const { i18n } = useTranslation()
  useEffect(() => {
    const apply = (language: string): void => {
      document.documentElement.setAttribute('lang', language)
    }
    apply(i18n.language.length > 0 ? i18n.language : 'en')
    i18n.on('languageChanged', apply)
    return () => {
      i18n.off('languageChanged', apply)
    }
  }, [i18n])
}

/**
 * Keep every subsystem live for the whole session.
 *
 * One hook rather than nine near-identical ones: each store exposes the same `hydrate` + `subscribe`
 * pair, and nine copies of this effect is how one of them ends up quietly missing. The hook order is
 * fixed and unconditional, which is what React requires and what stops a subsystem from being live
 * only on some renders.
 */
function useSubsystems(): void {
  const hydrators = [
    useObsStore((store) => store.hydrate),
    useOverlayStore((store) => store.hydrate),
    useCameraStore((store) => store.hydrate),
    usePlanStore((store) => store.hydrate),
    useYouTubeStore((store) => store.hydrate),
    useGoLiveStore((store) => store.hydrate),
    useAsrStore((store) => store.hydrate),
    useCueStore((store) => store.hydrate),
    useHealthStore((store) => store.hydrate),
  ]
  const subscribers = [
    useObsStore((store) => store.subscribe),
    useOverlayStore((store) => store.subscribe),
    useCameraStore((store) => store.subscribe),
    usePlanStore((store) => store.subscribe),
    useYouTubeStore((store) => store.subscribe),
    useGoLiveStore((store) => store.subscribe),
    useAsrStore((store) => store.subscribe),
    useCueStore((store) => store.subscribe),
    useHealthStore((store) => store.subscribe),
  ]

  useEffect(
    () => {
      // Subscribe before hydrating: a snapshot that landed between the two would otherwise be
      // missed, and the store would sit on stale state until something else happened to push.
      const offs = subscribers.map((subscribe) => subscribe())
      for (const hydrate of hydrators) void hydrate()
      return () => {
        for (const off of offs) off()
      }
    },
    // The store actions are module-scoped and stable for the life of the process; re-running this
    // effect would tear down and rebuild every IPC listener for nothing.
    [],
  )
}

/**
 * The two chrome keys, which are not service actions and are never suspended.
 *
 * Kept out of `ActionDispatcher` on purpose: the dispatcher's vocabulary is things that happen to
 * the *service*, and it is remappable and pedal-bindable. "Open my settings" is neither, and adding
 * it would put a UI concern inside the contract `isSafeBinding` guards.
 */
export function useConsoleKeys({
  open,
  onOpen,
  onClose,
}: {
  readonly open: boolean
  readonly onOpen: () => void
  readonly onClose: () => void
}): void {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handle = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        if (open) onClose()
        else onOpen()
        return
      }
      // Only while it is open. With the drawer shut, Esc belongs to the service keymap, where a
      // 2-second HOLD hands control back from the AI and a tap deliberately does nothing.
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
    }
  }, [open, onOpen, onClose])
}

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  useDocumentLanguage()
  useSubsystems()

  const [drawerOpen, setDrawerOpen] = useState<boolean>(isFirstRunOnThisMachine)
  const [drawerSection, setDrawerSection] = useState<DrawerSectionId>('preflight')

  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
  }, [])
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
  }, [])
  const openPlanSection = useCallback(() => {
    setDrawerSection('plan')
    setDrawerOpen(true)
  }, [])

  useConsoleKeys({ open: drawerOpen, onOpen: openDrawer, onClose: closeDrawer })

  // One dispatcher for the session, so a pedal or a Stream Deck has a single object to bind against.
  const dispatcher = useMemo(() => createActionDispatcher(), [])
  useServiceActions({ dispatcher })

  const [bindings, setBindings] = useState<readonly KeyBinding[]>(() => loadBindings().bindings)
  // Filter first, then alias. Filtering drops keys bound to actions nothing implements, so those
  // keys keep their browser default instead of being swallowed; aliasing then adds the arrows, but
  // only where the operator has not claimed those keys themselves.
  const activeBindings = useMemo(
    () => withPedalAliases(bindings.filter((binding) => isImplementedAction(binding.action))),
    [bindings],
  )
  useKeyboardActions({ dispatcher, bindings: activeBindings, enabled: !drawerOpen })

  const plan = usePlanStore((store) => store.plan)
  const position = usePlanStore((store) => store.position)
  const planBusy = usePlanStore((store) => store.busy)
  const fireCue = usePlanStore((store) => store.fireCue)
  const pending = useCueStore((store) => store.state.pending)

  const selectCue = useCallback(
    (cueId: string) => {
      void fireCue(cueId)
    },
    [fireCue],
  )

  return (
    <ErrorBoundary>
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-text">
        {/*
          `inert` while the drawer is open makes the console genuinely unreachable — unfocusable and
          unclickable — rather than merely covered by a backdrop. That is what earns the drawer's
          `aria-modal="true"`, and it is a browser primitive instead of a hand-rolled focus trap.
        */}
        <div inert={drawerOpen} className="relative flex min-h-0 flex-1 flex-col">
          <main aria-label={t('app.mainLabel')} className="min-h-0 flex-1">
            <SlideGrid
              cues={plan.cues}
              currentIndex={position.index}
              firedCueIds={position.firedCueIds}
              onSelect={selectCue}
              busy={planBusy}
              onOpenPlan={openPlanSection}
            />
          </main>

          {pending === null ? null : (
            <div
              data-testid="floating-suggestion"
              className="pointer-events-none absolute bottom-4 right-4 z-30 w-[30rem] max-w-[calc(100%-2rem)]"
            >
              <div className="pointer-events-auto overflow-hidden rounded-glass border border-accent bg-surface shadow-float-dark">
                <SuggestionPanel />
              </div>
            </div>
          )}

          <BottomBar onOpenSettings={openDrawer} />
        </div>

        <SettingsDrawer
          open={drawerOpen}
          section={drawerSection}
          onSectionChange={setDrawerSection}
          onClose={closeDrawer}
          onBindingsChange={setBindings}
        />
      </div>
    </ErrorBoundary>
  )
}

export default App
