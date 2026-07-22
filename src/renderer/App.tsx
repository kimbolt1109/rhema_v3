/**
 * The app shell.
 *
 * Three pieces of chrome and four views:
 *
 *  - a title bar carrying the product name and the runtime versions (the first thing anyone asks
 *    for in a bug report);
 *  - a **subsystem status strip**;
 *  - a **section tablist**, and
 *  - the Connection screen, the Camera panel, the Overlay panel, or Camera setup.
 *
 * Cameras and overlays are separate tabs rather than one combined "production" screen, and that is
 * a deliberate echo of BLUEPRINT.md §6: they are independent layers, and a single screen that
 * drove both would be the first place that independence quietly eroded.
 *
 * As of Phase 9 the strip is **not** assembled here from seven stores' private notions of
 * healthiness. It is {@link StatusStrip}, driven by the one `@shared/health` snapshot the main
 * process publishes, and it carries the answer to the only question an operator has mid-service —
 * *is the service still going out?* — next to the lights. The previous hand-rolled version had a
 * separate tone table per subsystem, which is exactly how "OBS is red" and "the congregation is
 * fine" ended up looking the same on screen.
 *
 * Everything is inside the {@link ErrorBoundary}, including the strip, so a crash anywhere in the
 * tree still produces a readable screen rather than a black window.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionId } from '@shared/actions'
import type { KeyBinding } from '@shared/actions'
import type { AppVersions } from '@shared/ipc'

import { ErrorBoundary } from './components/ErrorBoundary'
import { TrustDial } from './components/TrustDial'
import { createActionDispatcher } from './input/ActionDispatcher'
import { loadBindings } from './input/bindings'
import { useKeyboardActions } from './input/useKeyboardActions'
import { AsrSettings } from './screens/AsrSettings'
import { HotPhraseEditor } from './screens/HotPhraseEditor'
import { SuggestionPanel } from './screens/SuggestionPanel'
import { CameraPanel } from './screens/CameraPanel'
import { CameraSettings } from './screens/CameraSettings'
import { ConnectionScreen } from './screens/ConnectionScreen'
import { GoLivePanel } from './screens/GoLivePanel'
import { GoLiveSettings } from './screens/GoLiveSettings'
import { OverlayPanel } from './screens/OverlayPanel'
import { PlanEditor } from './screens/PlanEditor'
import { ShortcutSettings } from './screens/ShortcutSettings'
import { StatusDashboard, StatusStrip } from './screens/StatusDashboard'
import { TranscriptPanel } from './screens/TranscriptPanel'
import { useAsrStore } from './store/asrStore'
import { useCueStore } from './store/cueStore'
import { useGoLiveStore } from './store/goLiveStore'
import { useHealthStore } from './store/healthStore'
import { useOverlayStore } from './store/overlayStore'
import { useYouTubeStore } from './store/youtubeStore'

/** The console sections a tab can select. */
const SECTIONS = [
  { id: 'connection', labelKey: 'app.section.connection' },
  // Cameras sit ahead of Overlay because they are the busiest live surface, and Camera setup sits
  // last because it is a soundcheck task, not a service one.
  { id: 'camera', labelKey: 'app.section.camera' },
  { id: 'overlay', labelKey: 'app.section.overlay' },
  // Phase 6. The plan sits with the live surfaces rather than with the settings tabs, because it
  // is one: the operator drives slides from it during the service, not only before it.
  { id: 'plan', labelKey: 'app.section.plan' },
  // Phase 7. The transcript is a live surface too — the operator reads it during the sermon to see
  // what the cue engine (Phase 8) is going to key off — so it sits with the others, and its
  // settings sit with the settings tabs.
  { id: 'transcript', labelKey: 'app.section.transcript' },
  // Phase 8. The trust dial and the hot-phrase list live together because they are the same
  // decision at two scales: how much Verger may do without asking, and which words let it.
  { id: 'automation', labelKey: 'app.section.automation' },
  // Phase 5 splits what Phase 4 called "Go Live" in two: the GO LIVE / END *controls* sit here,
  // with the two other live surfaces, and the weekly template and OAuth *settings* move one tab
  // to the right. A screen that both configures a broadcast and starts one invites the operator to
  // press the big button while they are still editing a title.
  { id: 'goLive', labelKey: 'app.section.goLive' },
  // Phase 9. The full status dashboard sits with the live surfaces, not with the settings tabs:
  // it is opened *during* a service, by somebody who has just seen a light change and wants to
  // know whether the congregation is still watching.
  { id: 'status', labelKey: 'app.section.status' },
  { id: 'goLiveSettings', labelKey: 'app.section.goLiveSettings' },
  { id: 'cameraSetup', labelKey: 'app.section.cameraSetup' },
  { id: 'asrSettings', labelKey: 'app.section.asrSettings' },
  { id: 'shortcuts', labelKey: 'app.section.shortcuts' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

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

/** Versions for the title bar. Degrades to `null` when the bridge is absent. */
function useAppVersions(): AppVersions | null {
  const [versions, setVersions] = useState<AppVersions | null>(null)

  useEffect(() => {
    let cancelled = false
    const bridge = typeof window === 'undefined' ? undefined : window.verger
    if (bridge === undefined) return undefined

    void bridge.app
      .getVersions()
      .then((result) => {
        if (!cancelled && result.ok) setVersions(result.value)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  return versions
}

/**
 * Section navigation.
 *
 * A real ARIA tablist, roving `tabIndex` and all: the operator must be able to move between the
 * Connection screen and the Overlay panel from the keyboard without hunting for a focus stop, and
 * a screen reader has to announce which of the two is showing.
 */
function SectionTabs({
  active,
  onSelect,
}: {
  active: SectionId
  onSelect: (section: SectionId) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const refs = useRef(new Map<SectionId, HTMLButtonElement>())

  const move = (delta: number): void => {
    const index = SECTIONS.findIndex((section) => section.id === active)
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
    if (next === undefined) return
    onSelect(next.id)
    refs.current.get(next.id)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={t('app.sectionsLabel')}
      className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2"
    >
      {SECTIONS.map((section) => {
        const selected = section.id === active
        return (
          <button
            key={section.id}
            ref={(node) => {
              if (node === null) refs.current.delete(section.id)
              else refs.current.set(section.id, node)
            }}
            type="button"
            role="tab"
            id={`section-tab-${section.id}`}
            aria-selected={selected}
            aria-controls={`section-panel-${section.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onSelect(section.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault()
                move(1)
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault()
                move(-1)
              }
            }}
            className={`min-h-touch rounded-glass border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
              selected
                ? 'border-accent bg-surface-2 text-text'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {t(section.labelKey)}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Keep the overlay store live for the whole session, not just while its panel is mounted.
 *
 * The subsystem light has to keep reporting whether OBS's browser source is still attached even
 * when the operator is looking at the Connection screen — a light that only updates while you are
 * staring at it is not a light.
 */
function useOverlaySubsystem(): void {
  const hydrate = useOverlayStore((state) => state.hydrate)
  const subscribe = useOverlayStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/**
 * Keep the YouTube store live for the whole session, for the same reason as the overlay one: the
 * strip has to keep saying "not configured" (or "ready") whatever screen the operator is on.
 */
function useYouTubeSubsystem(): void {
  const hydrate = useYouTubeStore((state) => state.hydrate)
  const subscribe = useYouTubeStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/**
 * Keep the GO LIVE store live for the whole session.
 *
 * This one matters more than the other two: the LIVE and RECORDING lights have to keep reporting
 * while the operator is on the Cameras tab, which is where they will spend the service. It also
 * means the crash re-attach is detected at launch rather than the first time somebody happens to
 * open the Go Live tab.
 */
function useGoLiveSubsystem(): void {
  const hydrate = useGoLiveStore((state) => state.hydrate)
  const subscribe = useGoLiveStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/**
 * Keep the speech store live for the whole session.
 *
 * The SPEECH light has to keep saying "not set up" — or "running on the fallback" — while the
 * operator is on the Cameras tab. A subsystem light that only updates while its own panel is
 * mounted is not a light.
 */
function useAsrSubsystem(): void {
  const hydrate = useAsrStore((state) => state.hydrate)
  const subscribe = useAsrStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/**
 * Keep the cue engine live for the whole session.
 *
 * The most important of these hooks. The suggestion panel is mounted at the top of the shell and
 * has to receive a suggestion whatever tab the operator is on — a card that only appears while you
 * are looking at the automation tab is not an assistant. It also means PANIC state is visible from
 * every screen.
 */
function useCueSubsystem(): void {
  const hydrate = useCueStore((state) => state.hydrate)
  const subscribe = useCueStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/**
 * Keep subsystem health live for the whole session.
 *
 * The one hook that must never be conditional. The strip is the only part of Verger an operator is
 * guaranteed to be looking at when something breaks, and the four bugs logged in `STATUS.md` cycles
 * 2, 4, 5 and 8 were all the same shape: a fully unit-tested component wired to nothing. A health
 * store that hydrated only when its own tab was open would be the fifth.
 */
function useHealthSubsystem(): void {
  const hydrate = useHealthStore((state) => state.hydrate)
  const subscribe = useHealthStore((state) => state.subscribe)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])
}

/** The trust dial and the hot phrases, together. */
function AutomationSection(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <TrustDial />
      <HotPhraseEditor />
    </div>
  )
}

/** One screen per section. Exhaustive over {@link SectionId}, so a new tab cannot render blank. */
function SectionView({
  section,
  onBindingsChange
}: {
  section: SectionId
  onBindingsChange: (next: readonly KeyBinding[]) => void
}): React.JSX.Element {
  switch (section) {
    case 'connection':
      return <ConnectionScreen />
    case 'camera':
      return <CameraPanel />
    case 'overlay':
      return <OverlayPanel />
    case 'plan':
      return <PlanEditor />
    case 'transcript':
      return <TranscriptPanel />
    case 'automation':
      return <AutomationSection />
    case 'goLive':
      return <GoLivePanel />
    case 'status':
      return <StatusDashboard />
    case 'goLiveSettings':
      return <GoLiveSettings />
    case 'cameraSetup':
      return <CameraSettings />
    case 'asrSettings':
      return <AsrSettings />
    case 'shortcuts':
      return <ShortcutSettings onChange={onBindingsChange} />
  }
}

function TitleBar(): React.JSX.Element {
  const { t } = useTranslation()
  const versions = useAppVersions()

  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-3">
      <div className="flex items-baseline gap-3">
        <span className="text-base font-semibold tracking-tight text-text">{t('app.name')}</span>
        <span className="text-xs text-text-muted">{t('app.tagline')}</span>
      </div>
      <p className="select-text font-mono text-[11px] text-text-muted">
        {versions === null
          ? t('app.versionsUnknown')
          : t('app.versions', {
              app: versions.app,
              electron: versions.electron,
              chrome: versions.chrome,
            })}
      </p>
    </header>
  )
}

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  useDocumentLanguage()
  useOverlaySubsystem()
  useYouTubeSubsystem()
  useGoLiveSubsystem()
  useAsrSubsystem()
  useCueSubsystem()
  useHealthSubsystem()

  const [section, setSection] = useState<SectionId>('connection')

  // One dispatcher for the session. Created here rather than inside the panel so a pedal or a
  // Stream Deck added in Phase 10 has a single object to bind against.
  const dispatcher = useMemo(() => createActionDispatcher(), [])

  // The operator's remapped keymap, loaded once and held here so it feeds BOTH the live keyboard
  // handler and the settings screen. Loading it into a screen that nothing renders is how the
  // remap UI would have shipped inert.
  const [bindings, setBindings] = useState<readonly KeyBinding[]>(() => loadBindings().bindings)

  // Only the actions that actually have a handler are handed to the keyboard hook. Binding a key
  // nothing listens for would swallow the press and teach the operator that the key is broken.
  const activeBindings = useMemo(
    () =>
      bindings.filter(
        (binding) => binding.action === ActionId.confirm || binding.action === ActionId.dismiss
      ),
    [bindings]
  )
  useKeyboardActions({ dispatcher, bindings: activeBindings })

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col bg-background text-text">
        <TitleBar />
        {/* One strip, one source of truth (`@shared/health`), and the "is it still going out?"
            answer next to the lights. */}
        <StatusStrip />
        {/* Above the tabs, on every screen. A suggestion has a deadline measured in seconds and
            must never be one tab-click away. */}
        <SuggestionPanel dispatcher={dispatcher} />
        <SectionTabs active={section} onSelect={setSection} />
        <main aria-label={t('app.mainLabel')} className="min-h-0 flex-1">
          {SECTIONS.map((entry) => (
            <div
              key={entry.id}
              role="tabpanel"
              id={`section-panel-${entry.id}`}
              aria-labelledby={`section-tab-${entry.id}`}
              hidden={entry.id !== section}
              className="h-full"
            >
              {/* Unmounted rather than merely hidden: the Overlay panel owns IPC subscriptions,
                  and a hidden-but-live panel would double every listener for no benefit. The
                  subsystem light keeps its own subscription via `useOverlaySubsystem`. */}
              {entry.id === section ? (
                <SectionView section={entry.id} onBindingsChange={setBindings} />
              ) : null}
            </div>
          ))}
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
