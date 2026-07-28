/**
 * The overlay-source auto-refresh.
 *
 * The behaviour under test is a safety property as much as a feature: this thing presses a button
 * in OBS on its own, so the tests that matter most are the ones proving it stays its hand. A
 * refresh fired while the overlay is healthy would re-animate a lower-third in front of a
 * congregation, which is exactly the flicker `restart_when_active: false` exists to prevent.
 *
 * No OBS, no sockets, no real timers — every seam is injected.
 */

import { describe, expect, it } from 'vitest'

import { createNullLogger } from '@main/logging/logger'
import {
  OBS_BROWSER_INPUT_KIND,
  OBS_REFRESH_BUTTON,
  OverlaySourceRecovery
} from '@main/obs/OverlaySourceRecovery'
import type { OverlayRecoveryInfo } from '@main/obs/OverlaySourceRecovery'
import type { Unsubscribe } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Records every request, and answers the three the recovery makes. */
class FakeObs {
  readonly calls: Array<{ type: string; data?: Record<string, unknown> }> = []
  connected = true

  constructor(
    private readonly inputs: Array<{ inputName: string; inputKind: string }>,
    private readonly urls: Record<string, string>
  ) {}

  call(type: string, data?: Record<string, unknown>): Promise<Result<unknown>> {
    this.calls.push(data === undefined ? { type } : { type, data })
    if (!this.connected) {
      return Promise.resolve(err(ErrorCode.NOT_CONNECTED, 'OBS is not connected'))
    }
    if (type === 'GetInputList') return Promise.resolve(ok({ inputs: this.inputs }))
    if (type === 'GetInputSettings') {
      const name = String(data?.['inputName'] ?? '')
      const url = this.urls[name]
      return Promise.resolve(
        ok(url === undefined ? { inputSettings: {} } : { inputSettings: { url } })
      )
    }
    return Promise.resolve(ok({}))
  }

  /** Names passed to the refresh button, in order. */
  refreshed(): string[] {
    return this.calls
      .filter((c) => c.type === 'PressInputPropertiesButton')
      .map((c) => String(c.data?.['inputName'] ?? ''))
  }
}

class FakeOverlay {
  private listeners: Array<(info: OverlayRecoveryInfo) => void> = []

  constructor(private info: OverlayRecoveryInfo) {}

  getInfo(): OverlayRecoveryInfo {
    return this.info
  }

  onInfo(callback: (info: OverlayRecoveryInfo) => void): Unsubscribe {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback)
    }
  }

  emit(info: OverlayRecoveryInfo): void {
    this.info = info
    for (const l of [...this.listeners]) l(info)
  }
}

/** Timers we drive by hand, so the grace and cooldown are exact rather than raced. */
class ManualTimers {
  private pending: Array<{ id: number; run: () => void }> = []
  private nextId = 1

  setTimeout(handler: () => void, _ms: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.pending.push({ id, run: handler })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p.id !== handle)
  }

  /** Fire everything currently queued. */
  flush(): void {
    const due = this.pending
    this.pending = []
    for (const p of due) p.run()
  }

  get count(): number {
    return this.pending.length
  }
}

const OVERLAYS = [{ inputName: 'Overlays', inputKind: OBS_BROWSER_INPUT_KIND }]
const OVERLAY_URL = { Overlays: 'http://127.0.0.1:7320/overlay' }

/** Let the recovery's internal promise chain settle without real timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function make(
  obs: FakeObs,
  overlay: { getInfo(): OverlayRecoveryInfo; onInfo(cb: (i: OverlayRecoveryInfo) => void): Unsubscribe },
  extra: { now?: () => number; cooldownMs?: number } = {}
): { recovery: OverlaySourceRecovery; timers: ManualTimers } {
  const timers = new ManualTimers()
  const recovery = new OverlaySourceRecovery({
    obs,
    overlay,
    overlayPort: 7320,
    logger: createNullLogger(),
    timers,
    graceMs: 4_000,
    ...extra
  })
  return { recovery, timers }
}

// ---------------------------------------------------------------------------
// refreshNow — what gets pressed, and what does not
// ---------------------------------------------------------------------------

describe('OverlaySourceRecovery.refreshNow', () => {
  it('refreshes a browser source whose URL names the overlay port', async () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const { recovery } = make(obs, new FakeOverlay({ running: true, clients: 0 }))

    const result = await recovery.refreshNow()

    expect(result).toEqual(ok(1))
    expect(obs.refreshed()).toEqual(['Overlays'])
    const press = obs.calls.find((c) => c.type === 'PressInputPropertiesButton')
    expect(press?.data?.['propertyName']).toBe(OBS_REFRESH_BUTTON)
  })

  it('leaves a browser source belonging to someone else alone', async () => {
    // A countdown widget in the same scene is not ours to reload.
    const obs = new FakeObs(
      [
        { inputName: 'Overlays', inputKind: OBS_BROWSER_INPUT_KIND },
        { inputName: 'Countdown', inputKind: OBS_BROWSER_INPUT_KIND }
      ],
      { Overlays: 'http://127.0.0.1:7320/overlay', Countdown: 'https://example.com/timer' }
    )
    const { recovery } = make(obs, new FakeOverlay({ running: true, clients: 0 }))

    expect(await recovery.refreshNow()).toEqual(ok(1))
    expect(obs.refreshed()).toEqual(['Overlays'])
  })

  it('ignores inputs that are not browser sources', async () => {
    const obs = new FakeObs(
      [
        { inputName: 'Cam 1', inputKind: 'dshow_input' },
        { inputName: 'Mic', inputKind: 'wasapi_input_capture' }
      ],
      {}
    )
    const { recovery } = make(obs, new FakeOverlay({ running: true, clients: 0 }))

    expect(await recovery.refreshNow()).toEqual(ok(0))
    expect(obs.refreshed()).toEqual([])
    // It must not even ask for their settings.
    expect(obs.calls.some((c) => c.type === 'GetInputSettings')).toBe(false)
  })

  it('prefers the port the server actually bound over the configured one', async () => {
    // 7320 was taken and the server fell back to 7999; the source naming 7999 is the live one.
    const obs = new FakeObs(
      [
        { inputName: 'Stale', inputKind: OBS_BROWSER_INPUT_KIND },
        { inputName: 'Live', inputKind: OBS_BROWSER_INPUT_KIND }
      ],
      { Stale: 'http://127.0.0.1:7320/overlay', Live: 'http://127.0.0.1:7999/overlay' }
    )
    const { recovery } = make(obs, new FakeOverlay({ running: true, clients: 0, port: 7999 }))

    expect(await recovery.refreshNow()).toEqual(ok(1))
    expect(obs.refreshed()).toEqual(['Live'])
  })

  it('reports NOT_CONNECTED rather than pretending it refreshed', async () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    obs.connected = false
    const { recovery } = make(obs, new FakeOverlay({ running: true, clients: 0 }))

    const result = await recovery.refreshNow()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(obs.refreshed()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The automatic path — and above all, when it stays its hand
// ---------------------------------------------------------------------------

describe('OverlaySourceRecovery automatic refresh', () => {
  it('NEVER refreshes while a browser source is attached', () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: true, clients: 1 })
    const { recovery, timers } = make(obs, overlay)

    recovery.start()
    timers.flush()

    // No grace was even armed: a healthy overlay is not a candidate.
    expect(timers.count).toBe(0)
    expect(obs.calls).toEqual([])
  })

  it('refreshes once the overlay has been dark for the grace period', async () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: true, clients: 0 })
    const { recovery, timers } = make(obs, overlay)

    recovery.start()
    expect(obs.calls).toEqual([]) // nothing before the grace elapses
    timers.flush()
    await settle()

    expect(obs.refreshed()).toEqual(['Overlays'])
  })

  it('cancels the pending refresh if a source attaches inside the grace', () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: true, clients: 0 })
    const { recovery, timers } = make(obs, overlay)

    recovery.start()
    expect(timers.count).toBe(1)

    overlay.emit({ running: true, clients: 1 })
    expect(timers.count).toBe(0)

    timers.flush()
    expect(obs.calls).toEqual([])
  })

  it('does not touch OBS while the overlay server is not listening', () => {
    // Refreshing here would only reload a page that is going to be refused again.
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: false, clients: 0 })
    const { recovery, timers } = make(obs, overlay)

    recovery.start()
    timers.flush()

    expect(timers.count).toBe(0)
    expect(obs.calls).toEqual([])
  })

  it('honours the cooldown instead of pressing refresh every grace period', async () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: true, clients: 0 })
    let now = 1_000
    const { recovery, timers } = make(obs, overlay, { now: () => now, cooldownMs: 30_000 })

    recovery.start()
    timers.flush()
    await settle()
    expect(obs.refreshed()).toEqual(['Overlays'])

    // Still dark, and only five seconds later: the cooldown must suppress a second press.
    now += 5_000
    timers.flush()
    await settle()
    expect(obs.refreshed()).toEqual(['Overlays'])

    // Past the cooldown, it tries again.
    now += 30_000
    timers.flush()
    await settle()
    expect(obs.refreshed()).toEqual(['Overlays', 'Overlays'])
  })

  it('stops watching after dispose', () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = new FakeOverlay({ running: true, clients: 0 })
    const { recovery, timers } = make(obs, overlay)

    recovery.start()
    recovery.dispose()
    timers.flush()

    expect(obs.calls).toEqual([])
  })

  it('survives an overlay server whose getInfo throws', () => {
    const obs = new FakeObs(OVERLAYS, OVERLAY_URL)
    const overlay = {
      getInfo: (): OverlayRecoveryInfo => {
        throw new Error('overlay server exploded')
      },
      onInfo: (): Unsubscribe => (): void => undefined
    }
    const { recovery, timers } = make(obs, overlay)

    expect(() => recovery.start()).not.toThrow()
    timers.flush()
    expect(obs.calls).toEqual([])
  })
})
