/**
 * The Preflight screen — a one-glance "am I ready?" checklist for the booth, shown automatically the
 * first time Verger launches on a new machine (see `App.tsx` / localStorage marker).
 *
 * It reads only what the existing stores already mirror (OBS, overlay, cameras) plus the browser's
 * own audio-device list — it invents no new main-process IPC and changes nothing about OBS. The two
 * action buttons reuse the exact commands the Overlay and Camera panels use, so "Test lower third"
 * and "Test each camera scene" exercise the real path an operator will drive on Sunday. This is the
 * one chance to confirm the lower-third renders on real hardware before a live service.
 *
 * Copy is intentionally in English (the operator works in English); only the tab label is localised.
 */

import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Mic,
  PlayCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { CAMERA_SLOTS } from '@shared/camera'

import { Button } from '../components/Button'
import { useCameraStore } from '../store/cameraStore'
import { useObsStore } from '../store/obsStore'
import { useOverlayStore } from '../store/overlayStore'

type CheckState = 'pass' | 'warn' | 'fail' | 'pending'

interface Check {
  readonly key: string
  readonly label: string
  readonly state: CheckState
  readonly detail: string
  /** Shown only when the check is not passing — a plain-language next step. */
  readonly fix?: string
}

/** One audio input the OS reported. Label is empty until the browser is granted microphone access. */
interface AudioInput {
  readonly id: string
  readonly label: string
}

export function PreflightScreen(): React.JSX.Element {
  const obsStatus = useObsStore((s) => s.status)
  const sceneList = useObsStore((s) => s.sceneList)
  const obsHydrate = useObsStore((s) => s.hydrate)
  const obsSubscribe = useObsStore((s) => s.subscribe)

  const serverInfo = useOverlayStore((s) => s.serverInfo)
  const overlaySend = useOverlayStore((s) => s.send)

  const cameraSelect = useCameraStore((s) => s.select)
  const cameraHydrate = useCameraStore((s) => s.hydrate)
  const cameraSubscribe = useCameraStore((s) => s.subscribe)

  const [audio, setAudio] = useState<AudioInput[] | null>(null)
  const [ltTest, setLtTest] = useState<'idle' | 'running'>('idle')
  const [camTest, setCamTest] = useState<'idle' | 'running'>('idle')

  // Preflight can be the FIRST screen shown, before the Connection or Camera panels have mounted, so
  // it must hydrate the stores it reads itself rather than assume another panel did.
  useEffect(() => {
    const off = [obsSubscribe(), cameraSubscribe()]
    void obsHydrate()
    void cameraHydrate()
    return () => {
      for (const unsub of off) unsub()
    }
  }, [obsSubscribe, cameraSubscribe, obsHydrate, cameraHydrate])

  const enumerateAudio = useCallback(async (): Promise<void> => {
    try {
      const media = navigator.mediaDevices
      if (media === undefined) {
        setAudio([])
        return
      }
      const devices = await media.enumerateDevices()
      setAudio(
        devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ id: d.deviceId, label: d.label.length > 0 ? d.label : `Microphone ${i + 1}` })),
      )
    } catch {
      setAudio([])
    }
  }, [])

  useEffect(() => {
    void enumerateAudio()
  }, [enumerateAudio])

  const testLowerThird = useCallback((): void => {
    setLtTest('running')
    void overlaySend({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 'Verger', line2: 'Preflight test — lower third', template: 'bar' },
    })
    window.setTimeout(() => {
      void overlaySend({ channel: 'command', name: 'lowerThird.hide', payload: {} })
      setLtTest('idle')
    }, 5000)
  }, [overlaySend])

  const testCameras = useCallback(async (): Promise<void> => {
    setCamTest('running')
    for (const slot of CAMERA_SLOTS) {
      await cameraSelect(slot)
      await new Promise((resolve) => window.setTimeout(resolve, 1200))
    }
    setCamTest('idle')
  }, [cameraSelect])

  // --- derive the checks --------------------------------------------------------------------------
  const obsConnected = obsStatus.state === 'connected'
  const sceneCount = sceneList?.scenes.length ?? 0

  const checks: Check[] = [
    {
      key: 'obs',
      label: 'OBS connected',
      state: obsConnected ? 'pass' : obsStatus.state === 'connecting' ? 'pending' : 'fail',
      detail: obsConnected
        ? `OBS ${obsStatus.obsVersion ?? '?'} · websocket ${obsStatus.obsWebSocketVersion ?? '?'}`
        : `Status: ${obsStatus.state}`,
      ...(obsConnected
        ? {}
        : {
            fix: 'OBS → Tools → WebSocket Server Settings → enable it, then put the port + password into config.json (next to START.bat) and restart. Connect on the Connection tab.',
          }),
    },
    {
      key: 'scenes',
      label: 'OBS scenes',
      state: sceneCount > 0 ? 'pass' : obsConnected ? 'warn' : 'pending',
      detail:
        sceneCount > 0
          ? `${sceneCount} scene${sceneCount === 1 ? '' : 's'} · program: ${sceneList?.currentProgramScene ?? '—'}`
          : 'No scenes seen yet',
      ...(sceneCount > 0
        ? {}
        : { fix: 'Create at least one scene in OBS. Verger uses whatever scenes exist — it does not need specific names.' }),
    },
    {
      key: 'overlay-server',
      label: 'Overlay server',
      state: serverInfo.running ? 'pass' : 'fail',
      detail: serverInfo.running ? `Listening · ${serverInfo.pageUrl}` : (serverInfo.lastError ?? 'Not running'),
      ...(serverInfo.running
        ? {}
        : { fix: 'Restart Verger. If it still will not bind, another program may be using the overlay port — change overlay.port in config.json.' }),
    },
    {
      key: 'overlay-source',
      label: 'Overlay browser source in OBS',
      state: serverInfo.clients > 0 ? 'pass' : serverInfo.running ? 'warn' : 'pending',
      detail: serverInfo.clients > 0 ? `${serverInfo.clients} attached` : 'No browser source attached yet',
      ...(serverInfo.clients > 0
        ? {}
        : { fix: `In OBS add a Browser Source and set its URL to ${serverInfo.pageUrl} (copy it exactly). It is what puts lower-thirds, scripture and slides on the congregation screen.` }),
    },
    {
      key: 'audio',
      label: 'Microphone / audio input',
      state: audio === null ? 'pending' : audio.length > 0 ? 'pass' : 'warn',
      detail:
        audio === null
          ? 'Checking…'
          : audio.length > 0
            ? `${audio.length} input${audio.length === 1 ? '' : 's'}: ${audio.map((a) => a.label).join(', ')}`
            : 'No audio inputs found',
      ...(audio !== null && audio.length === 0
        ? { fix: 'Plug in / enable the microphone you will use for speech following, then press Re-check audio.' }
        : {}),
    },
    {
      key: 'config',
      label: 'Configuration',
      state: 'pass',
      detail: `Edit config.json next to START.bat (OBS host/port/password, overlay port). Overlay URL: ${serverInfo.pageUrl}`,
    },
  ]

  const failing = checks.filter((c) => c.state === 'fail').length
  const warning = checks.filter((c) => c.state === 'warn').length

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-readout font-semibold text-text">Preflight</h1>
          <p className="mt-1 max-w-2xl text-body text-text-muted">
            A quick check that everything is ready before the service. Fix anything red, then use the
            test buttons to confirm the lower-third and cameras on the real screen.
          </p>
        </div>
        <Button variant="secondary" size="md" icon={RefreshCw} onClick={() => void enumerateAudio()}>
          Re-check audio
        </Button>
      </header>

      <div
        className={`rounded-glass-lg border p-4 text-body ${
          failing > 0
            ? 'border-panic/50 bg-surface text-panic'
            : warning > 0
              ? 'border-border bg-surface text-text'
              : 'border-live/50 bg-surface text-live'
        }`}
      >
        {failing > 0
          ? `${failing} thing${failing === 1 ? '' : 's'} to fix before you go live.`
          : warning > 0
            ? `Ready — ${warning} optional item${warning === 1 ? '' : 's'} still to check.`
            : 'All checks passed. You are ready.'}
      </div>

      <section aria-label="Readiness checks" className="flex flex-col gap-2">
        {checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </section>

      <section aria-label="Hardware tests" className="rounded-glass-lg border border-border bg-surface p-5">
        <h2 className="text-micro font-semibold uppercase tracking-wide text-text-muted">On-screen tests</h2>
        <p className="mt-1 text-meta text-text-muted">
          Watch the congregation screen (the OBS output) while you run these.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="primary"
            size="lg"
            icon={Layers}
            disabled={!serverInfo.running || ltTest === 'running'}
            onClick={testLowerThird}
          >
            {ltTest === 'running' ? 'Showing lower third…' : 'Test lower third (5s)'}
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={PlayCircle}
            disabled={!obsConnected || camTest === 'running'}
            onClick={() => void testCameras()}
          >
            {camTest === 'running' ? 'Cycling cameras…' : 'Test each camera scene'}
          </Button>
        </div>
        {!serverInfo.running ? (
          <p className="mt-3 text-meta text-text-muted">
            The lower-third test needs the overlay server running and a Browser Source attached in OBS.
          </p>
        ) : null}
      </section>
    </div>
  )
}

function CheckRow({ check }: { check: Check }): React.JSX.Element {
  const Icon =
    check.state === 'pass'
      ? CheckCircle2
      : check.state === 'warn'
        ? AlertTriangle
        : check.state === 'fail'
          ? XCircle
          : Mic
  const tone =
    check.state === 'pass'
      ? 'text-live'
      : check.state === 'warn'
        ? 'text-accent-2'
        : check.state === 'fail'
          ? 'text-panic'
          : 'text-text-muted'

  return (
    <div className="flex min-h-touch items-start gap-3 rounded-glass border border-border bg-surface px-4 py-3">
      <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-body font-medium text-text">{check.label}</p>
        <p className="mt-0.5 select-text break-words text-meta text-text-muted">{check.detail}</p>
        {check.fix !== undefined ? (
          <p className="mt-1 break-words text-meta text-accent-2">→ {check.fix}</p>
        ) : null}
      </div>
    </div>
  )
}
