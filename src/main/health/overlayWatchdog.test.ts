/**
 * `OverlayWatchdog` behaviour, driven entirely through injected seams.
 *
 * No OBS, no browser, no real timers and no sockets — the real-socket half of this failure mode
 * lives in `failureInjection.test.ts`, which crashes a genuine `ws` client against a genuine
 * `OverlayServer`. What is proved HERE is the policy: when the watchdog stays quiet, when it goes
 * amber, when it goes red, and the two things it must never do.
 *
 * The load-bearing blocks are:
 *
 *  - **the grace period.** An OBS scene change drops and re-adds a browser source in well under a
 *    second. A watchdog that shouted about that would be ignored by the third Sunday, so a drop
 *    that heals inside the window must produce no alarm at all;
 *  - **`not-configured` is not amber.** A machine with no browser source ever attached is at rest,
 *    not degraded (`@shared/health`);
 *  - **recovery never blanks the overlay.** The state cache is what makes a reloaded browser
 *    source come back correct.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { createNullLogger } from '@main/logging/logger'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import { ErrorCode, ok } from '@shared/result'
import type { Result } from '@shared/result'

import {
  DEFAULT_OVERLAY_GRACE_MS,
  OVERLAY_OPERATOR_REMEDY,
  OVERLAY_STILL_WORKS_NONE,
  OVERLAY_STILL_WORKS_PARTIAL,
  OverlayWatchdog
} from './overlayWatchdog'
import type {
  OverlayWatchdogInfo,
  OverlayWatchdogTarget,
  OverlayWatchdogTimerHandle,
  OverlayWatchdogTimers
} from './overlayWatchdog'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GRACE_MS = 5_000

/**
 * An overlay server double.
 *
 * `send` exists on the double but NOT on {@link OverlayWatchdogTarget}, deliberately: the seam is
 * how "the watchdog cannot blank the overlay" is enforced, and the spy proves the runtime agrees
 * with the type.
 */
class FakeOverlay implements OverlayWatchdogTarget {
  running = true
  clients = 0
  revision = 41

  reloads = 0
  reloadOutcome: Result<unknown> = ok(undefined)
  reloadThrows = false
  onInfoThrows = false

  /** Not part of the seam. Must never be called. */
  readonly send = vi.fn()

  private readonly listeners = new Set<(info: OverlayWatchdogInfo) => void>()

  getInfo(): OverlayWatchdogInfo {
    return { running: this.running, clients: this.clients }
  }

  onInfo(callback: (info: OverlayWatchdogInfo) => void): Unsubscribe {
    if (this.onInfoThrows) throw new Error('the overlay server refused a subscriber')
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  getState(): { readonly revision: number } {
    return { revision: this.revision }
  }

  reloadClients(): Result<unknown> {
    this.reloads += 1
    if (this.reloadThrows) throw new Error('the reload channel is gone')
    return this.reloadOutcome
  }

  /** Simulate a client attaching or detaching, exactly as `OverlayServer.emitInfo` would. */
  setClients(clients: number): void {
    this.clients = clients
    this.emit()
  }

  setRunning(running: boolean): void {
    this.running = running
    this.emit()
  }

  subscriberCount(): number {
    return this.listeners.size
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.getInfo())
  }
}

/** A target with no reload channel at all — the seam's optional half omitted. */
class FakeOverlayWithoutReload implements OverlayWatchdogTarget {
  running = true
  clients = 0
  private readonly listeners = new Set<(info: OverlayWatchdogInfo) => void>()

  getInfo(): OverlayWatchdogInfo {
    return { running: this.running, clients: this.clients }
  }

  onInfo(callback: (info: OverlayWatchdogInfo) => void): Unsubscribe {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  getState(): { readonly revision: number } {
    return { revision: 3 }
  }

  setClients(clients: number): void {
    this.clients = clients
    for (const listener of [...this.listeners]) listener(this.getInfo())
  }
}

/** Timers the test fires by hand, so the grace period is exact rather than approximate. */
class ManualTimers implements OverlayWatchdogTimers {
  private next = 1
  private readonly pending = new Map<number, { handler: () => void; ms: number }>()
  cancelled = 0

  setTimeout(handler: () => void, ms: number): OverlayWatchdogTimerHandle {
    const id = this.next
    this.next += 1
    this.pending.set(id, { handler, ms })
    return id
  }

  clearTimeout(handle: OverlayWatchdogTimerHandle): void {
    if (typeof handle !== 'number') return
    if (this.pending.delete(handle)) this.cancelled += 1
  }

  pendingCount(): number {
    return this.pending.size
  }

  /** The delay the most recent timer was armed with, for asserting the grace period is used. */
  lastDelay(): number | null {
    let delay: number | null = null
    for (const entry of this.pending.values()) delay = entry.ms
    return delay
  }

  /** Fire everything currently pending. */
  run(): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id)
      entry.handler()
    }
  }
}

/** A logger that records what was said, so "loudly visible" can be asserted rather than assumed. */
function recordingLogger(): { logger: Logger; errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warns.push(message)
    },
    error: (message: string) => {
      errors.push(message)
    },
    child: () => make()
  })
  return { logger: make(), errors, warns }
}

interface Harness {
  readonly watchdog: OverlayWatchdog
  readonly overlay: FakeOverlay
  readonly timers: ManualTimers
  readonly errors: string[]
  readonly warns: string[]
  setNow(at: number): void
}

function harness(): Harness {
  const overlay = new FakeOverlay()
  const timers = new ManualTimers()
  const { logger, errors, warns } = recordingLogger()
  let now = 1_000
  const watchdog = new OverlayWatchdog({
    overlay,
    logger,
    timers,
    graceMs: GRACE_MS,
    now: () => now
  })
  return {
    watchdog,
    overlay,
    timers,
    errors,
    warns,
    setNow: (at: number) => {
      now = at
    }
  }
}

// ---------------------------------------------------------------------------
// Resting states — amber must mean something
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — resting states', () => {
  it('reports not-configured, never amber, when no browser source has ever attached', () => {
    const { watchdog, overlay } = harness()
    overlay.clients = 0

    const started = watchdog.start()

    expect(started.ok).toBe(true)
    const health = watchdog.getHealth()
    expect(health.id).toBe('overlay')
    expect(health.level).toBe('not-configured')
    expect(health.stillWorks).toBeNull()
    expect(health.detail).toContain('no overlay browser source')
  })

  it('goes ok the moment the first browser source attaches', () => {
    const { watchdog, overlay } = harness()
    watchdog.start()

    overlay.setClients(1)

    expect(watchdog.getHealth().level).toBe('ok')
    expect(watchdog.getHealth().detail).toBe('1 overlay browser source attached')
    expect(watchdog.getHealth().stillWorks).toBeNull()
    expect(watchdog.getExpectedClients()).toBe(1)
  })

  it('reports down when the overlay server is not listening at all', () => {
    const { watchdog, overlay } = harness()
    overlay.running = false

    watchdog.start()

    expect(watchdog.getHealth().level).toBe('down')
    expect(watchdog.getHealth().stillWorks).toBe(OVERLAY_STILL_WORKS_NONE)
  })

  it('pins `since` to when the LEVEL was entered, not to every detail change', () => {
    const { watchdog, overlay, setNow } = harness()
    watchdog.start()

    setNow(2_000)
    overlay.setClients(1)
    const enteredOk = watchdog.getHealth().since
    expect(enteredOk).toBe(2_000)

    setNow(9_000)
    overlay.setClients(2)

    expect(watchdog.getHealth().level).toBe('ok')
    expect(watchdog.getHealth().detail).toBe('2 overlay browser sources attached')
    expect(watchdog.getHealth().since).toBe(enteredOk)
  })
})

// ---------------------------------------------------------------------------
// The grace period — not crying wolf on a scene change
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — the grace period', () => {
  it('stays quiet when a source drops and comes back inside the grace period', () => {
    const { watchdog, overlay, timers, errors, warns } = harness()
    watchdog.start()
    overlay.setClients(1)

    // An OBS scene change: the source is destroyed and re-created a few hundred ms later.
    overlay.setClients(0)
    expect(watchdog.getHealth().level).toBe('ok')
    expect(timers.pendingCount()).toBe(1)

    overlay.setClients(1)
    timers.run()

    expect(watchdog.getHealth().level).toBe('ok')
    expect(overlay.reloads).toBe(0)
    expect(errors).toEqual([])
    expect(warns).toEqual([])
  })

  it('arms the grace timer with the configured grace period', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)

    expect(timers.lastDelay()).toBe(GRACE_MS)
  })

  it('does not re-arm the grace timer on a second drop while one is already counting', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(2)

    overlay.setClients(1)
    overlay.setClients(0)

    expect(timers.pendingCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Total loss — the loud one
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — nothing left to tell', () => {
  it('goes down, names the remedy and says what still works when every source is gone', () => {
    const { watchdog, overlay, timers, errors, setNow } = harness()
    watchdog.start()
    overlay.setClients(1)

    setNow(20_000)
    overlay.setClients(0)
    setNow(20_000 + GRACE_MS)
    timers.run()

    const health = watchdog.getHealth()
    expect(health.level).toBe('down')
    expect(health.detail).toContain(OVERLAY_OPERATOR_REMEDY)
    expect(health.stillWorks).toBe(OVERLAY_STILL_WORKS_NONE)
    expect(health.stillWorks).toContain('recording')
    expect(health.since).toBe(20_000 + GRACE_MS)

    // Loudly visible: an operator reading the log finds the failure and the fix in one line.
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toContain(OVERLAY_OPERATOR_REMEDY)
  })

  it('does not attempt a reload when there is no client left to receive it', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)
    timers.run()

    expect(watchdog.getHealth().level).toBe('down')
    expect(overlay.reloads).toBe(0)
  })

  it('returns to ok when the browser source comes back after being reported down', () => {
    const { watchdog, overlay, timers, setNow } = harness()
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)
    timers.run()
    expect(watchdog.getHealth().level).toBe('down')

    setNow(50_000)
    overlay.setClients(1)

    expect(watchdog.getHealth().level).toBe('ok')
    expect(watchdog.getHealth().since).toBe(50_000)
  })
})

// ---------------------------------------------------------------------------
// Partial loss — the one recovery can actually fix
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — partial loss', () => {
  it('goes degraded and tells the surviving source to reload', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(2)

    overlay.setClients(1)
    timers.run()

    const health = watchdog.getHealth()
    expect(health.level).toBe('degraded')
    expect(health.detail).toBe('1 of 2 overlay sources attached')
    expect(health.stillWorks).toBe(OVERLAY_STILL_WORKS_PARTIAL)
    expect(overlay.reloads).toBe(1)
  })

  it('uses a reload channel injected as a plain function, so wiring needs no adapter', () => {
    const overlay = new FakeOverlayWithoutReload()
    const timers = new ManualTimers()
    let reloads = 0
    const watchdog = new OverlayWatchdog({
      overlay,
      logger: createNullLogger(),
      timers,
      graceMs: GRACE_MS,
      reload: () => {
        reloads += 1
        return ok(undefined)
      }
    })
    watchdog.start()
    overlay.setClients(2)

    overlay.setClients(1)
    timers.run()

    expect(reloads).toBe(1)
    expect(watchdog.getHealth().level).toBe('degraded')
  })

  it('reports the shortfall even with no reload channel wired', () => {
    const overlay = new FakeOverlayWithoutReload()
    const timers = new ManualTimers()
    const watchdog = new OverlayWatchdog({
      overlay,
      logger: createNullLogger(),
      timers,
      graceMs: GRACE_MS
    })
    watchdog.start()
    overlay.setClients(2)

    overlay.setClients(1)
    timers.run()

    expect(watchdog.getHealth().level).toBe('degraded')
  })

  it('does not launch a reload storm once the shortfall is already surfaced', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(3)

    overlay.setClients(2)
    timers.run()
    expect(overlay.reloads).toBe(1)

    overlay.setClients(1)
    overlay.setClients(2)

    expect(overlay.reloads).toBe(1)
    expect(watchdog.getHealth().level).toBe('degraded')
  })

  it('survives a reload seam that throws, and still reports the shortfall', () => {
    const { watchdog, overlay, timers } = harness()
    overlay.reloadThrows = true
    watchdog.start()
    overlay.setClients(2)

    overlay.setClients(1)
    expect(() => {
      timers.run()
    }).not.toThrow()

    expect(watchdog.getHealth().level).toBe('degraded')
  })

  it('lets the operator re-baseline, so a deliberate removal is not permanently amber', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(2)
    overlay.setClients(1)
    timers.run()
    expect(watchdog.getHealth().level).toBe('degraded')

    const acknowledged = watchdog.acknowledge()

    expect(acknowledged.ok).toBe(true)
    expect(watchdog.getExpectedClients()).toBe(1)
    expect(watchdog.getHealth().level).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Recovery never blanks the overlay
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — recovery never blanks overlay state', () => {
  it('leaves the state cache untouched through a drop, a report and a reload', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(2)
    const revisionBefore = overlay.revision

    overlay.setClients(1)
    timers.run()
    overlay.setClients(0)
    timers.run()
    overlay.setClients(1)

    expect(overlay.revision).toBe(revisionBefore)
    expect(overlay.send).not.toHaveBeenCalled()
  })

  it('carries no way to blank, clear or stop anything in its source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./overlayWatchdog.ts', import.meta.url)),
      'utf8'
    )

    // No output verbs: a watchdog that can stop a stream or a recording is a bug, not a safeguard.
    expect(source).not.toMatch(/\bstopStream\s*\(/)
    expect(source).not.toMatch(/\bstopRecord\s*\(/)
    expect(source).not.toMatch(/['"]StopStream['"]/)
    expect(source).not.toMatch(/['"]StopRecord['"]/)
    // No overlay mutation: `clearAll` and `.hide` would blank the congregation screen, and the
    // state cache is exactly what a reloading browser source re-syncs from.
    expect(source).not.toMatch(/clearAll/)
    expect(source).not.toMatch(/\.send\s*\(/)
    expect(source).not.toMatch(/emptyOverlayState/)
  })
})

// ---------------------------------------------------------------------------
// Operator-driven reload
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — reloadNow', () => {
  it('reloads the attached sources and reports the current health', async () => {
    const { watchdog, overlay } = harness()
    watchdog.start()
    overlay.setClients(1)

    const reloaded = await watchdog.reloadNow()

    expect(reloaded.ok).toBe(true)
    expect(overlay.reloads).toBe(1)
    expect(overlay.revision).toBe(41)
  })

  it('refuses with the OBS remedy when nothing is attached to reload', async () => {
    const { watchdog, overlay } = harness()
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)

    const reloaded = await watchdog.reloadNow()

    expect(reloaded.ok).toBe(false)
    if (reloaded.ok) throw new Error('expected a refusal')
    expect(reloaded.error.code).toBe(ErrorCode.NOT_CONNECTED)
    expect(reloaded.error.detail).toBe(OVERLAY_OPERATOR_REMEDY)
  })

  it('refuses when the overlay server is not listening', async () => {
    const { watchdog, overlay } = harness()
    watchdog.start()
    overlay.setRunning(false)

    const reloaded = await watchdog.reloadNow()

    expect(reloaded.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Boundaries — nothing throws outward
// ---------------------------------------------------------------------------

describe('OverlayWatchdog — boundaries', () => {
  it('reports rather than throws when it cannot subscribe to the overlay server', () => {
    const { watchdog, overlay } = harness()
    overlay.onInfoThrows = true

    const started = watchdog.start()

    expect(started.ok).toBe(false)
    expect(watchdog.getHealth().level).toBe('down')
  })

  it('treats an overlay server that throws on getInfo as not listening', () => {
    const overlay: OverlayWatchdogTarget = {
      getInfo: () => {
        throw new Error('the server exploded')
      },
      onInfo: () => () => undefined,
      getState: () => ({ revision: 0 })
    }
    const watchdog = new OverlayWatchdog({ overlay, logger: createNullLogger() })

    expect(watchdog.start().ok).toBe(true)
    expect(watchdog.getHealth().level).toBe('down')
  })

  it('does not let a throwing health subscriber break the next one', () => {
    const { watchdog, overlay } = harness()
    const seen: string[] = []
    watchdog.onHealth(() => {
      throw new Error('a subscriber exploded')
    })
    watchdog.onHealth((health) => {
      seen.push(health.level)
    })
    watchdog.start()

    expect(() => {
      overlay.setClients(1)
    }).not.toThrow()
    expect(seen).toContain('ok')
  })

  it('unsubscribes and cancels the grace timer on dispose', () => {
    const { watchdog, overlay, timers } = harness()
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)
    expect(timers.pendingCount()).toBe(1)

    watchdog.dispose()

    expect(timers.pendingCount()).toBe(0)
    expect(overlay.subscriberCount()).toBe(0)
    expect(watchdog.acknowledge().ok).toBe(false)
  })

  it('is idempotent on start', () => {
    const { watchdog, overlay } = harness()
    watchdog.start()
    watchdog.start()

    expect(overlay.subscriberCount()).toBe(1)
  })

  it('defaults the grace period to the documented constant', () => {
    const overlay = new FakeOverlay()
    const timers = new ManualTimers()
    const watchdog = new OverlayWatchdog({ overlay, logger: createNullLogger(), timers })
    watchdog.start()
    overlay.setClients(1)
    overlay.setClients(0)

    expect(timers.lastDelay()).toBe(DEFAULT_OVERLAY_GRACE_MS)
  })
})
