/**
 * Everything that is not the service, behind one gear icon.
 *
 * The console used to be thirteen tabs across the top, all of them one click from the operator's
 * hand mid-service — including the plan editor, the OAuth settings and the keymap. This drawer is
 * where all thirteen went. During a service it is closed and nothing in it is on screen; the whole
 * surface is the slide grid and the bottom bar.
 *
 * ## Nothing inside it changed
 *
 * Every section renders the **same component it always did**, with the same props. That is the point:
 * the redesign is a re-composition, not a rewrite, so all thirteen screens keep their tests, their
 * i18n keys and their behaviour. The nav even reuses the old `app.section.*` label keys, so there is
 * no new copy to translate and no window in which the Korean bundle is behind the English one.
 *
 * ## Only the open section is mounted
 *
 * Inherited deliberately from the old shell: several of these panels own IPC subscriptions, and a
 * hidden-but-live panel would double every listener for no benefit. When the drawer is shut it
 * renders `null`, so none of them are mounted at all — the always-on subsystem hooks in `App.tsx`
 * are what keep the stores warm.
 *
 * ## Modality
 *
 * `role="dialog" aria-modal="true"`, `Esc` closes, the backdrop closes, and focus moves into the
 * drawer on open and back to the opener on close. The background is made genuinely unreachable by
 * `App.tsx`, which marks the console `inert` while this is open — that is also what stops SPACE from
 * advancing the service while the operator is typing in here, alongside the keyboard hook being
 * suspended outright.
 *
 * No Node globals — this module is bundled into the renderer.
 */

import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { KeyBinding } from '@shared/actions'
import type { AppVersions } from '@shared/ipc'

import { AsrSettings } from '../screens/AsrSettings'
import { CameraPanel } from '../screens/CameraPanel'
import { CameraSettings } from '../screens/CameraSettings'
import { ConnectionScreen } from '../screens/ConnectionScreen'
import { GoLivePanel } from '../screens/GoLivePanel'
import { GoLiveSettings } from '../screens/GoLiveSettings'
import { HotPhraseEditor } from '../screens/HotPhraseEditor'
import { OverlayPanel } from '../screens/OverlayPanel'
import { PlanEditor } from '../screens/PlanEditor'
import { PreflightScreen } from '../screens/PreflightScreen'
import { ShortcutSettings } from '../screens/ShortcutSettings'
import { StatusDashboard } from '../screens/StatusDashboard'
import { TranscriptPanel } from '../screens/TranscriptPanel'
import { TrustDial } from './TrustDial'

/**
 * The drawer's sections, in the order an operator meets them.
 *
 * Same ids and same `labelKey`s as the tablist this replaced — see the module note. Preflight leads
 * because on an unfamiliar machine that is the screen that answers "will this work today", and
 * `App.tsx` opens the drawer straight onto it the first time Verger runs on a PC.
 */
export const DRAWER_SECTIONS = [
  { id: 'preflight', labelKey: 'app.section.preflight' },
  { id: 'connection', labelKey: 'app.section.connection' },
  { id: 'camera', labelKey: 'app.section.camera' },
  { id: 'overlay', labelKey: 'app.section.overlay' },
  { id: 'plan', labelKey: 'app.section.plan' },
  { id: 'transcript', labelKey: 'app.section.transcript' },
  { id: 'automation', labelKey: 'app.section.automation' },
  { id: 'goLive', labelKey: 'app.section.goLive' },
  { id: 'status', labelKey: 'app.section.status' },
  { id: 'goLiveSettings', labelKey: 'app.section.goLiveSettings' },
  { id: 'cameraSetup', labelKey: 'app.section.cameraSetup' },
  { id: 'asrSettings', labelKey: 'app.section.asrSettings' },
  { id: 'shortcuts', labelKey: 'app.section.shortcuts' },
] as const

/** Union of the drawer's section ids. */
export type DrawerSectionId = (typeof DRAWER_SECTIONS)[number]['id']

/**
 * The runtime versions, for the drawer header.
 *
 * These used to live in the shell's title bar, which the redesign removed — and they are the first
 * thing anybody asks for in a bug report, so they had to land somewhere rather than be dropped. The
 * drawer header is the right somewhere: reachable in one keystroke, invisible during a service.
 * Degrades to `null` when the preload bridge is absent (jsdom, or a packaged build whose preload
 * failed), in which case the header says so instead of rendering a blank.
 */
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

/** The trust dial and the hot phrases, together — the same pairing the old shell had. */
function AutomationSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <TrustDial />
      <HotPhraseEditor />
    </div>
  )
}

/** One screen per section. Exhaustive over {@link DrawerSectionId}, so a new entry cannot render blank. */
function DrawerSectionView({
  section,
  onBindingsChange,
}: {
  section: DrawerSectionId
  onBindingsChange: (next: readonly KeyBinding[]) => void
}): React.JSX.Element {
  switch (section) {
    case 'preflight':
      return <PreflightScreen />
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

export interface SettingsDrawerProps {
  readonly open: boolean
  readonly section: DrawerSectionId
  readonly onSectionChange: (section: DrawerSectionId) => void
  readonly onClose: () => void
  readonly onBindingsChange: (next: readonly KeyBinding[]) => void
}

export function SettingsDrawer({
  open,
  section,
  onSectionChange,
  onClose,
  onBindingsChange,
}: SettingsDrawerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const versions = useAppVersions()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const navRefs = useRef(new Map<DrawerSectionId, HTMLButtonElement>())
  /** Where focus was before the drawer opened, so closing puts it back. */
  const returnFocusTo = useRef<Element | null>(null)

  // Move focus into the drawer when it opens, and hand it back when it closes. Without the
  // hand-back, closing the drawer leaves focus on a detached node and the next SPACE goes nowhere.
  useEffect(() => {
    if (!open) return undefined
    returnFocusTo.current = typeof document === 'undefined' ? null : document.activeElement
    const node = panelRef.current
    if (node !== null && typeof node.focus === 'function') node.focus()

    return () => {
      const previous = returnFocusTo.current
      if (
        previous !== null &&
        previous instanceof HTMLElement &&
        typeof previous.focus === 'function'
      ) {
        previous.focus()
      }
    }
  }, [open])

  if (!open) return null

  /** Vertical roving focus over the section list, matching the tablist this replaced. */
  const move = (delta: number): void => {
    const index = DRAWER_SECTIONS.findIndex((entry) => entry.id === section)
    const next = DRAWER_SECTIONS[(index + delta + DRAWER_SECTIONS.length) % DRAWER_SECTIONS.length]
    if (next === undefined) return
    onSectionChange(next.id)
    navRefs.current.get(next.id)?.focus()
  }

  return (
    <div className="absolute inset-0 z-40 flex justify-end" data-testid="settings-drawer-root">
      {/*
        The backdrop. A click closes — but it is a plain div, not a button: a screen reader has the
        close button and the Esc key, and announcing "button, backdrop" would be noise.
      */}
      <div
        aria-hidden="true"
        data-testid="settings-drawer-backdrop"
        onClick={onClose}
        className="absolute inset-0 bg-background/70"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('console.drawer.label')}
        tabIndex={-1}
        data-testid="settings-drawer"
        className="relative flex h-full w-[92vw] max-w-[64rem] flex-col border-l border-border bg-background shadow-float-dark focus-visible:outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-title font-semibold tracking-tight text-text">
              {t('console.drawer.title')}
            </h2>
            <span className="text-meta text-text-muted">{t('console.drawer.closeHint')}</span>
            {/* Selectable: the point of this line is that it can be pasted into a bug report. */}
            <p className="select-text font-mono text-micro font-normal text-text-muted">
              {versions === null
                ? t('app.versionsUnknown')
                : t('app.versions', {
                    app: versions.app,
                    electron: versions.electron,
                    chrome: versions.chrome,
                  })}
            </p>
          </div>
          <button
            type="button"
            data-testid="settings-drawer-close"
            aria-label={t('console.drawer.close')}
            onClick={onClose}
            className="flex min-h-touch min-w-touch items-center justify-center rounded-glass border border-border bg-surface-2 text-text transition-colors duration-150 hover:border-accent/60"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('app.sectionsLabel')}
            className="w-48 shrink-0 space-y-1 overflow-y-auto border-r border-border bg-surface p-2"
          >
            {DRAWER_SECTIONS.map((entry) => {
              const selected = entry.id === section
              return (
                <button
                  key={entry.id}
                  ref={(node) => {
                    if (node === null) navRefs.current.delete(entry.id)
                    else navRefs.current.set(entry.id, node)
                  }}
                  type="button"
                  role="tab"
                  id={`section-tab-${entry.id}`}
                  aria-selected={selected}
                  aria-controls={`section-panel-${entry.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    onSectionChange(entry.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                      event.preventDefault()
                      move(1)
                    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                      event.preventDefault()
                      move(-1)
                    }
                  }}
                  className={clsx(
                    'flex min-h-touch w-full items-center rounded-glass border px-3 text-left text-label font-medium transition-colors duration-150',
                    selected
                      ? 'border-accent bg-surface-2 text-text'
                      : 'border-transparent text-text-muted hover:text-text',
                  )}
                >
                  {t(entry.labelKey)}
                </button>
              )
            })}
          </div>

          <div
            role="tabpanel"
            id={`section-panel-${section}`}
            aria-labelledby={`section-tab-${section}`}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <DrawerSectionView section={section} onBindingsChange={onBindingsChange} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsDrawer
