/**
 * The app shell.
 *
 * Three pieces of chrome and two views:
 *
 *  - a title bar carrying the product name and the runtime versions (the first thing anyone asks
 *    for in a bug report);
 *  - a **subsystem status strip**;
 *  - a **section tablist**, and
 *  - the Connection screen or the Overlay panel.
 *
 * The strip is structured as a list of subsystem descriptors rather than as hard-coded markup,
 * because it is going to grow: recording and YouTube (Phases 4–5) and speech (Phase 7) each need a
 * light in exactly this row. OBS and — as of Phase 2 — the overlay resolve to real states; the
 * rest render an explicit "not built yet" rather than a green light that lies. A subsystem light
 * that is optimistic by default is worse than no light at all.
 *
 * The overlay light is deliberately three-valued rather than two: a running server with **zero**
 * attached browser sources is not "fine", it is the failure `src/shared/ipc.ts` calls out — OBS's
 * Overlays source has died and nothing is on screen — so it gets its own amber state and its own
 * words.
 *
 * Everything is inside the {@link ErrorBoundary}, including the strip, so a crash anywhere in the
 * tree still produces a readable screen rather than a black window.
 */

import { Cast, Disc, Layers, Mic, Radio } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AppVersions } from '@shared/ipc'
import type { ObsConnectionState } from '@shared/obs'

import { ErrorBoundary } from './components/ErrorBoundary'
import { ConnectionScreen } from './screens/ConnectionScreen'
import { OverlayPanel } from './screens/OverlayPanel'
import { useObsStore } from './store/obsStore'
import { useOverlayStore } from './store/overlayStore'

/** The console sections a tab can select. */
const SECTIONS = [
  { id: 'connection', labelKey: 'app.section.connection' },
  { id: 'overlay', labelKey: 'app.section.overlay' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Where a subsystem light gets its state from. */
type SubsystemSource = 'obs' | 'overlay' | 'pending'

/** One light in the subsystem strip. */
interface SubsystemDescriptor {
  readonly id: string
  readonly labelKey: string
  readonly icon: LucideIcon
  readonly source: SubsystemSource
}

const SUBSYSTEMS: readonly SubsystemDescriptor[] = [
  { id: 'obs', labelKey: 'app.subsystem.obs', icon: Radio, source: 'obs' },
  { id: 'overlay', labelKey: 'app.subsystem.overlay', icon: Layers, source: 'overlay' },
  { id: 'asr', labelKey: 'app.subsystem.asr', icon: Mic, source: 'pending' },
  { id: 'youtube', labelKey: 'app.subsystem.youtube', icon: Cast, source: 'pending' },
  { id: 'recording', labelKey: 'app.subsystem.recording', icon: Disc, source: 'pending' },
]

/** Same three-channel rule as the big light: colour is never the only signal. */
const STATE_TONES: Record<ObsConnectionState, string> = {
  'not-configured': 'text-text-muted',
  idle: 'text-text-muted',
  connecting: 'text-accent-2',
  connected: 'text-live',
  reconnecting: 'text-accent-2',
  disconnected: 'text-panic',
  'auth-failed': 'text-panic',
}

const STATE_LABEL_KEYS: Record<ObsConnectionState, string> = {
  'not-configured': 'status.state.not-configured',
  idle: 'status.state.idle',
  connecting: 'status.state.connecting',
  connected: 'status.state.connected',
  reconnecting: 'status.state.reconnecting',
  disconnected: 'status.state.disconnected',
  'auth-failed': 'status.state.auth-failed',
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

/** What one light should say and how it should be tinted. */
interface LightState {
  readonly key: string
  readonly text: string
  readonly tone: string
}

function SubsystemStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const obsState = useObsStore((state) => state.status.state)
  const serverInfo = useOverlayStore((state) => state.serverInfo)
  const overlayHydrated = useOverlayStore((state) => state.hydrated)

  const overlayLight = ((): LightState => {
    if (!overlayHydrated) {
      return { key: 'unknown', text: t('overlay.subsystem.unknown'), tone: 'text-text-muted' }
    }
    if (!serverInfo.running) {
      return { key: 'stopped', text: t('overlay.subsystem.stopped'), tone: 'text-panic' }
    }
    if (serverInfo.clients === 0) {
      // Running with nothing attached is the silent failure, so it gets its own words rather
      // than being folded into a green "running".
      return { key: 'no-clients', text: t('overlay.subsystem.noClients'), tone: 'text-accent-2' }
    }
    return { key: 'attached', text: t('overlay.subsystem.attached'), tone: 'text-live' }
  })()

  const lightFor = (source: SubsystemSource): LightState => {
    switch (source) {
      case 'obs':
        return { key: obsState, text: t(STATE_LABEL_KEYS[obsState]), tone: STATE_TONES[obsState] }
      case 'overlay':
        return overlayLight
      case 'pending':
        return { key: 'pending', text: t('app.phasePending'), tone: 'text-text-muted' }
    }
  }

  return (
    <ul
      aria-label={t('app.subsystemsLabel')}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2"
    >
      {SUBSYSTEMS.map((subsystem) => {
        const Icon = subsystem.icon
        const label = t(subsystem.labelKey)
        const light = lightFor(subsystem.source)

        return (
          <li
            key={subsystem.id}
            data-subsystem={subsystem.id}
            data-subsystem-state={light.key}
            className="flex min-h-touch items-center gap-2 rounded-glass border border-border bg-surface-2 px-3"
          >
            <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${light.tone}`} />
            <span className="text-xs font-medium text-text">{label}</span>
            {/* The state text is what carries the meaning; the tint only reinforces it. */}
            <span className={`text-xs ${light.tone}`}>{light.text}</span>
          </li>
        )
      })}
    </ul>
  )
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

  const [section, setSection] = useState<SectionId>('connection')

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col bg-background text-text">
        <TitleBar />
        <SubsystemStrip />
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
                entry.id === 'connection' ? (
                  <ConnectionScreen />
                ) : (
                  <OverlayPanel />
                )
              ) : null}
            </div>
          ))}
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
