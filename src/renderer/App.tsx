/**
 * The app shell.
 *
 * Two pieces of chrome and one view:
 *
 *  - a title bar carrying the product name and the runtime versions (the first thing anyone asks
 *    for in a bug report);
 *  - a **subsystem status strip**, and
 *  - the Connection screen.
 *
 * The strip is structured as a list of subsystem descriptors rather than as hard-coded markup,
 * because it is going to grow: overlay (Phase 2), recording and YouTube (Phases 4–5), and speech
 * (Phase 7) each need a light in exactly this row. Only OBS resolves to a real state today; the
 * rest render an explicit "not built yet" rather than a green light that lies. A subsystem light
 * that is optimistic by default is worse than no light at all.
 *
 * Everything is inside the {@link ErrorBoundary}, including the strip, so a crash anywhere in the
 * tree still produces a readable screen rather than a black window.
 */

import { Cast, Disc, Layers, Mic, Radio } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AppVersions } from '@shared/ipc'
import type { ObsConnectionState } from '@shared/obs'

import { ErrorBoundary } from './components/ErrorBoundary'
import { ConnectionScreen } from './screens/ConnectionScreen'
import { useObsStore } from './store/obsStore'

/** One light in the subsystem strip. */
interface SubsystemDescriptor {
  readonly id: string
  readonly labelKey: string
  readonly icon: LucideIcon
  /** `false` until the phase that builds it lands. */
  readonly implemented: boolean
}

const SUBSYSTEMS: readonly SubsystemDescriptor[] = [
  { id: 'obs', labelKey: 'app.subsystem.obs', icon: Radio, implemented: true },
  { id: 'overlay', labelKey: 'app.subsystem.overlay', icon: Layers, implemented: false },
  { id: 'asr', labelKey: 'app.subsystem.asr', icon: Mic, implemented: false },
  { id: 'youtube', labelKey: 'app.subsystem.youtube', icon: Cast, implemented: false },
  { id: 'recording', labelKey: 'app.subsystem.recording', icon: Disc, implemented: false },
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

function SubsystemStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const obsState = useObsStore((state) => state.status.state)

  return (
    <ul
      aria-label={t('app.subsystemsLabel')}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2"
    >
      {SUBSYSTEMS.map((subsystem) => {
        const Icon = subsystem.icon
        const label = t(subsystem.labelKey)
        const stateText = subsystem.implemented
          ? t(STATE_LABEL_KEYS[obsState])
          : t('app.phasePending')
        const tone = subsystem.implemented ? STATE_TONES[obsState] : 'text-text-muted'

        return (
          <li
            key={subsystem.id}
            data-subsystem={subsystem.id}
            data-subsystem-state={subsystem.implemented ? obsState : 'pending'}
            className="flex min-h-touch items-center gap-2 rounded-glass border border-border bg-surface-2 px-3"
          >
            <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${tone}`} />
            <span className="text-xs font-medium text-text">{label}</span>
            {/* The state text is what carries the meaning; the tint only reinforces it. */}
            <span className={`text-xs ${tone}`}>{stateText}</span>
          </li>
        )
      })}
    </ul>
  )
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

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col bg-background text-text">
        <TitleBar />
        <SubsystemStrip />
        <main aria-label={t('app.mainLabel')} className="min-h-0 flex-1">
          <ConnectionScreen />
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
