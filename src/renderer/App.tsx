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

import { Cast, Disc, Layers, Mic, Radio, RadioTower } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AsrState } from '@shared/asr'
import type { GoLivePhase } from '@shared/golive'
import type { AppVersions } from '@shared/ipc'
import type { ObsConnectionState } from '@shared/obs'
import type { YouTubeAuthState } from '@shared/youtube'

import { ErrorBoundary } from './components/ErrorBoundary'
import { AsrSettings } from './screens/AsrSettings'
import { CameraPanel } from './screens/CameraPanel'
import { CameraSettings } from './screens/CameraSettings'
import { ConnectionScreen } from './screens/ConnectionScreen'
import { GoLivePanel } from './screens/GoLivePanel'
import { GoLiveSettings } from './screens/GoLiveSettings'
import { OverlayPanel } from './screens/OverlayPanel'
import { PlanEditor } from './screens/PlanEditor'
import { TranscriptPanel } from './screens/TranscriptPanel'
import { useAsrStore } from './store/asrStore'
import { isRecordingMissing, useGoLiveStore } from './store/goLiveStore'
import { useObsStore } from './store/obsStore'
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
  // Phase 5 splits what Phase 4 called "Go Live" in two: the GO LIVE / END *controls* sit here,
  // with the two other live surfaces, and the weekly template and OAuth *settings* move one tab
  // to the right. A screen that both configures a broadcast and starts one invites the operator to
  // press the big button while they are still editing a title.
  { id: 'goLive', labelKey: 'app.section.goLive' },
  { id: 'goLiveSettings', labelKey: 'app.section.goLiveSettings' },
  { id: 'cameraSetup', labelKey: 'app.section.cameraSetup' },
  { id: 'asrSettings', labelKey: 'app.section.asrSettings' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Where a subsystem light gets its state from. */
type SubsystemSource = 'obs' | 'overlay' | 'asr' | 'youtube' | 'goLive' | 'recording' | 'pending'

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
  { id: 'asr', labelKey: 'app.subsystem.asr', icon: Mic, source: 'asr' },
  { id: 'youtube', labelKey: 'app.subsystem.youtube', icon: Cast, source: 'youtube' },
  // Live and Recording are two lights, not one. Standing Rule 3 makes them start together, which
  // is exactly why the strip must be able to show them disagreeing: "streaming, not recording" is
  // the failure the operator most needs to notice, and it is invisible in a combined light.
  { id: 'live', labelKey: 'app.subsystem.live', icon: RadioTower, source: 'goLive' },
  { id: 'recording', labelKey: 'app.subsystem.recording', icon: Disc, source: 'recording' },
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

/**
 * Tints for the YouTube light.
 *
 * `not-configured` is muted, not red: with no Google credentials the subsystem is *off*, which is
 * a resting state (Standing Rule 5), not a fault. Only a failed sign-in earns the panic colour.
 */
const YOUTUBE_TONES: Record<YouTubeAuthState, string> = {
  'not-configured': 'text-text-muted',
  'signed-out': 'text-text-muted',
  authorizing: 'text-accent-2',
  'signed-in': 'text-live',
  'auth-error': 'text-panic',
}

/**
 * Tints for the LIVE light.
 *
 * `partial` is panic-coloured and *not* folded in with `live`: OBS is pushing but the broadcast is
 * not public, and a green light over that state would be the single most expensive lie the strip
 * could tell. `failed` is panic for the obvious reason; `idle` is muted, because not being live is
 * a resting state, not a fault.
 */
const GO_LIVE_TONES: Record<GoLivePhase, string> = {
  idle: 'text-text-muted',
  starting: 'text-accent-2',
  live: 'text-live',
  partial: 'text-panic',
  ending: 'text-accent-2',
  failed: 'text-panic',
}

/**
 * Tints for the SPEECH light.
 *
 * `degraded` is amber and emphatically **not** folded in with `listening`: a transcript is still
 * arriving, but from the fallback provider, and a green light there would hide exactly the fact the
 * operator needs. `failed` is red; `not-configured` is muted, because a subsystem nobody switched
 * on is a resting state (Standing Rule 5), not a fault — and either way the console runs manual.
 */
const ASR_TONES: Record<AsrState, string> = {
  'not-configured': 'text-text-muted',
  idle: 'text-text-muted',
  starting: 'text-accent-2',
  listening: 'text-live',
  degraded: 'text-accent-2',
  failed: 'text-panic',
}

function SubsystemStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const obsState = useObsStore((state) => state.status.state)
  const serverInfo = useOverlayStore((state) => state.serverInfo)
  const overlayHydrated = useOverlayStore((state) => state.hydrated)
  const youtubeState = useYouTubeStore((state) => state.status.auth.state)
  const youtubeHydrated = useYouTubeStore((state) => state.hydrated)
  const goLivePhase = useGoLiveStore((state) => state.state.phase)
  const goLiveObs = useGoLiveStore((state) => state.state.obs)
  const goLiveHydrated = useGoLiveStore((state) => state.hydrated)
  const asrState = useAsrStore((state) => state.status.state)
  const asrHydrated = useAsrStore((state) => state.hydrated)

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

  const youtubeLight = ((): LightState => {
    if (!youtubeHydrated) {
      return { key: 'unknown', text: t('youtube.subsystem.unknown'), tone: 'text-text-muted' }
    }
    return {
      key: youtubeState,
      text: t(`youtube.subsystem.${youtubeState}`),
      tone: YOUTUBE_TONES[youtubeState],
    }
  })()

  const goLiveLight = ((): LightState => {
    if (!goLiveHydrated) {
      return { key: 'unknown', text: t('goLive.subsystem.unknown'), tone: 'text-text-muted' }
    }
    return {
      key: goLivePhase,
      text: t(`goLive.subsystem.${goLivePhase}`),
      tone: GO_LIVE_TONES[goLivePhase],
    }
  })()

  const asrLight = ((): LightState => {
    if (!asrHydrated) {
      return { key: 'unknown', text: t('asr.subsystem.unknown'), tone: 'text-text-muted' }
    }
    return {
      key: asrState,
      text: t(`asr.subsystem.${asrState}`),
      tone: ASR_TONES[asrState],
    }
  })()

  const recordingLight = ((): LightState => {
    if (!goLiveHydrated) {
      return { key: 'unknown', text: t('goLive.subsystem.unknown'), tone: 'text-text-muted' }
    }
    // Streaming with no recording is the Standing Rule 3 failure. It gets its own words and the
    // panic colour, rather than reading as an unremarkable "not recording".
    if (isRecordingMissing(goLiveObs)) {
      return {
        key: 'missing',
        text: t('goLive.subsystem.recordingMissing'),
        tone: 'text-panic',
      }
    }
    if (goLiveObs.recording && goLiveObs.recordingPaused) {
      return {
        key: 'paused',
        text: t('goLive.subsystem.recordingPaused'),
        tone: 'text-accent-2',
      }
    }
    if (goLiveObs.recording) {
      return { key: 'recording', text: t('goLive.subsystem.recording'), tone: 'text-live' }
    }
    return {
      key: 'not-recording',
      text: t('goLive.subsystem.notRecording'),
      tone: 'text-text-muted',
    }
  })()

  const lightFor = (source: SubsystemSource): LightState => {
    switch (source) {
      case 'obs':
        return { key: obsState, text: t(STATE_LABEL_KEYS[obsState]), tone: STATE_TONES[obsState] }
      case 'overlay':
        return overlayLight
      case 'asr':
        return asrLight
      case 'youtube':
        return youtubeLight
      case 'goLive':
        return goLiveLight
      case 'recording':
        return recordingLight
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

/** One screen per section. Exhaustive over {@link SectionId}, so a new tab cannot render blank. */
function SectionView({ section }: { section: SectionId }): React.JSX.Element {
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
    case 'goLive':
      return <GoLivePanel />
    case 'goLiveSettings':
      return <GoLiveSettings />
    case 'cameraSetup':
      return <CameraSettings />
    case 'asrSettings':
      return <AsrSettings />
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
              {entry.id === section ? <SectionView section={entry.id} /> : null}
            </div>
          ))}
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
