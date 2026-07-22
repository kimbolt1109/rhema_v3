/**
 * Unit tests for the auto-updater.
 *
 * No network, no Electron, no `electron-updater`. Everything the module touches — the engine,
 * the clock, the timer, `process.argv`, and the "is a service running" probe — is injected, so
 * these tests assert the *policy*, which is the whole point of the file:
 *
 *   1. Not configured is inert: not one call to anything.
 *   2. An available update is reported and NEVER installed on its own.
 *   3. An install is refused while a stream or a recording is running.
 *   4. Errors become log lines and a status, never a dialog and never an unbounded retry.
 *
 * What these tests do NOT prove, and no test in this repo does: that a real `latest.yml` on a
 * real host is fetched, verified and applied. There is no update server and the installer is
 * unsigned, so an end-to-end update has never happened. That gap is recorded in STATUS.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LAUNCH_CHECK_DELAY_MS,
  MAX_CONSECUTIVE_ERRORS,
  REFUSED_NOTHING_DOWNLOADED,
  REFUSED_SERVICE_ACTIVE,
  SQUIRREL_FIRSTRUN_ARG,
  UPDATE_URL_ENV_KEY,
  Updater,
  createUpdater,
  readUpdateFeedUrl,
} from '@main/updater'
import type {
  CreateUpdaterOptions,
  UpdaterEngine,
  UpdaterEngineCheckResult,
  UpdaterEngineFactory,
  UpdaterTimers,
} from '@main/updater'
import type { Logger } from '@shared/log'

const FEED_URL = 'https://updates.example.invalid/verger/stable'
const CURRENT = '0.1.0'
const NEXT = '0.2.0'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** An `electron-updater` stand-in that records every call and never touches a socket. */
class FakeEngine implements UpdaterEngine {
  autoDownload = true
  autoInstallOnAppQuit = false

  readonly feedUrls: Array<{ provider: string; url: string; channel?: string }> = []
  checkCalls = 0
  downloadCalls = 0
  readonly quitAndInstallCalls: Array<[boolean, boolean]> = []

  /** Queue of outcomes for successive `checkForUpdates()` calls. */
  checkOutcomes: Array<UpdaterEngineCheckResult | null | Error> = []
  downloadOutcome: 'ok' | Error = 'ok'
  quitAndInstallThrows: Error | null = null

  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void {
    this.feedUrls.push({ ...options })
  }

  async checkForUpdates(): Promise<UpdaterEngineCheckResult | null> {
    this.checkCalls += 1
    const outcome = this.checkOutcomes.shift() ?? null
    if (outcome instanceof Error) throw outcome
    return outcome
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    if (this.downloadOutcome instanceof Error) throw this.downloadOutcome
    return ['installer.exe']
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.quitAndInstallCalls.push([isSilent, isForceRunAfter])
    if (this.quitAndInstallThrows !== null) throw this.quitAndInstallThrows
  }
}

/** Manual timers: nothing fires until the test says so. */
class FakeTimers implements UpdaterTimers {
  private nextHandle = 1
  readonly scheduled = new Map<number, { handler: () => void; ms: number }>()

  setTimeout(handler: () => void, ms: number): unknown {
    const handle = this.nextHandle++
    this.scheduled.set(handle, { handler, ms })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number)
  }

  /** Fire every pending timer once, in insertion order. */
  runAll(): void {
    const pending = [...this.scheduled.entries()]
    this.scheduled.clear()
    for (const [, entry] of pending) entry.handler()
  }

  delays(): number[] {
    return [...this.scheduled.values()].map((entry) => entry.ms)
  }
}

function fakeLogger(): { logger: Logger; warns: string[]; infos: string[] } {
  const warns: string[] = []
  const infos: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: (message) => infos.push(message),
    warn: (message) => warns.push(message),
    error: (message) => warns.push(message),
    child: () => logger,
  }
  return { logger, warns, infos }
}

interface Harness {
  readonly updater: Updater
  readonly engine: FakeEngine
  readonly timers: FakeTimers
  readonly engineFactory: ReturnType<typeof vi.fn>
  readonly warns: string[]
  readonly infos: string[]
  readonly statuses: string[]
  serviceActive: boolean
}

function makeUpdater(overrides: Partial<CreateUpdaterOptions> = {}): Harness {
  const engine = new FakeEngine()
  const timers = new FakeTimers()
  const { logger, warns, infos } = fakeLogger()
  const statuses: string[] = []
  const engineFactory = vi.fn(async () => ({ ok: true as const, value: engine }))

  const state = { serviceActive: false }

  const updater = createUpdater({
    feedUrl: FEED_URL,
    currentVersion: CURRENT,
    isServiceActive: () => state.serviceActive,
    engine: engineFactory as unknown as UpdaterEngineFactory,
    timers,
    logger,
    now: () => 1_700_000_000_000,
    onStatus: (status) => statuses.push(status.kind),
    ...overrides,
  })

  return {
    updater,
    engine,
    timers,
    engineFactory,
    warns,
    infos,
    statuses,
    get serviceActive() {
      return state.serviceActive
    },
    set serviceActive(value: boolean) {
      state.serviceActive = value
    },
  }
}

function updateFound(version = NEXT): UpdaterEngineCheckResult {
  return {
    updateInfo: {
      version,
      releaseDate: '2026-08-01T00:00:00Z',
      releaseNotes: 'Fixes.',
    },
  }
}

// ---------------------------------------------------------------------------

describe('readUpdateFeedUrl', () => {
  it('returns null for an absent key', () => {
    expect(readUpdateFeedUrl({})).toBeNull()
  })

  it('treats an empty or whitespace value as not configured', () => {
    expect(readUpdateFeedUrl({ [UPDATE_URL_ENV_KEY]: '' })).toBeNull()
    expect(readUpdateFeedUrl({ [UPDATE_URL_ENV_KEY]: '   ' })).toBeNull()
  })

  it('trims a real value', () => {
    expect(readUpdateFeedUrl({ [UPDATE_URL_ENV_KEY]: `  ${FEED_URL} ` })).toBe(FEED_URL)
  })
})

describe('not configured', () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeUpdater({ feedUrl: null })
  })

  it('reports the not-configured resting state', () => {
    expect(harness.updater.isConfigured()).toBe(false)
    expect(harness.updater.getStatus()).toEqual({ kind: 'not-configured' })
  })

  it('never constructs the engine, so no network call is possible', async () => {
    harness.updater.start()
    harness.timers.runAll()
    await harness.updater.checkNow()
    await harness.updater.downloadNow()
    await harness.updater.installNow()

    expect(harness.engineFactory).not.toHaveBeenCalled()
    expect(harness.engine.checkCalls).toBe(0)
    expect(harness.engine.downloadCalls).toBe(0)
    expect(harness.engine.feedUrls).toEqual([])
  })

  it('schedules nothing on start', () => {
    harness.updater.start()
    expect(harness.timers.scheduled.size).toBe(0)
  })

  it('returns NOT_CONFIGURED rather than throwing', async () => {
    const result = await harness.updater.checkNow()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_CONFIGURED')
  })

  it('treats an empty-string feed url as not configured', () => {
    const blank = makeUpdater({ feedUrl: '   ' })
    expect(blank.updater.isConfigured()).toBe(false)
    expect(blank.updater.getStatus()).toEqual({ kind: 'not-configured' })
  })
})

describe('launch check', () => {
  it('schedules the check at the blueprint delay rather than firing immediately', () => {
    const harness = makeUpdater()
    harness.updater.start()

    expect(harness.timers.delays()).toEqual([LAUNCH_CHECK_DELAY_MS])
    expect(harness.engine.checkCalls).toBe(0)
  })

  it('runs the check when the timer fires', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [null]
    harness.updater.start()
    harness.timers.runAll()
    await vi.waitFor(() => expect(harness.engine.checkCalls).toBe(1))

    expect(harness.updater.getStatus().kind).toBe('up-to-date')
  })

  it('never checks on a Squirrel first run (ADR-010 (C) — it crashes)', async () => {
    const harness = makeUpdater({ argv: ['verger.exe', SQUIRREL_FIRSTRUN_ARG] })
    harness.updater.start()
    harness.timers.runAll()
    const result = await harness.updater.checkNow()

    expect(harness.timers.scheduled.size).toBe(0)
    expect(harness.engineFactory).not.toHaveBeenCalled()
    expect(harness.engine.checkCalls).toBe(0)
    expect(result.ok).toBe(false)
  })

  it('stop() cancels a pending check', () => {
    const harness = makeUpdater()
    harness.updater.start()
    harness.updater.stop()
    harness.timers.runAll()

    expect(harness.engine.checkCalls).toBe(0)
  })
})

describe('engine configuration', () => {
  it('pins the generic provider at the configured base url and disables library automation', async () => {
    const harness = makeUpdater({ channel: 'latest' })
    harness.engine.checkOutcomes = [null]
    await harness.updater.checkNow()

    expect(harness.engine.feedUrls).toEqual([
      { provider: 'generic', url: FEED_URL, channel: 'latest' },
    ])
    // The library must never download or install by its own schedule.
    expect(harness.engine.autoDownload).toBe(false)
    // Quit-time install is the one automatic path allowed: the operator already chose to quit.
    expect(harness.engine.autoInstallOnAppQuit).toBe(true)
  })

  it('omits the channel when none is configured', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [null]
    await harness.updater.checkNow()

    expect(harness.engine.feedUrls[0]).toEqual({ provider: 'generic', url: FEED_URL })
  })

  it('builds the engine once and reuses it', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [null, null]
    await harness.updater.checkNow()
    await harness.updater.checkNow()

    expect(harness.engineFactory).toHaveBeenCalledTimes(1)
    expect(harness.engine.checkCalls).toBe(2)
  })

  it('degrades to off when the engine cannot be loaded, and does not retry it', async () => {
    const factory = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'INTERNAL' as const, message: 'no electron-updater here' },
    }))
    const harness = makeUpdater({ engine: factory as unknown as UpdaterEngineFactory })

    const first = await harness.updater.checkNow()
    const second = await harness.updater.checkNow()

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(harness.warns).toContain('update engine unavailable; auto-update stays off')
  })
})

describe('an available update is reported, never installed', () => {
  it('reports the new version without downloading or installing', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound()]

    const result = await harness.updater.checkNow()

    expect(result.ok).toBe(true)
    expect(harness.updater.getStatus()).toEqual({
      kind: 'available',
      currentVersion: CURRENT,
      version: NEXT,
      releaseDate: '2026-08-01T00:00:00Z',
      notes: 'Fixes.',
      checkedAt: 1_700_000_000_000,
    })
    expect(harness.engine.downloadCalls).toBe(0)
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('downloads in the background when configured to — and still installs nothing', async () => {
    const harness = makeUpdater({ autoDownload: true })
    harness.engine.checkOutcomes = [updateFound()]

    await harness.updater.checkNow()
    await vi.waitFor(() => expect(harness.updater.getStatus().kind).toBe('downloaded'))

    expect(harness.engine.downloadCalls).toBe(1)
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('reports up-to-date when the feed offers the version already installed', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound(CURRENT)]

    await harness.updater.checkNow()

    expect(harness.updater.getStatus().kind).toBe('up-to-date')
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('flattens array-shaped release notes without throwing', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [
      { updateInfo: { version: NEXT, releaseNotes: [{ note: 'one' }, { note: 'two' }] } },
    ]

    await harness.updater.checkNow()
    const status = harness.updater.getStatus()

    expect(status.kind).toBe('available')
    if (status.kind === 'available') {
      expect(status.notes).toBe('one\n\ntwo')
      expect(status.releaseDate).toBeNull()
    }
  })

  it('shares one in-flight check between concurrent callers', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound(), updateFound()]

    await Promise.all([harness.updater.checkNow(), harness.updater.checkNow()])

    expect(harness.engine.checkCalls).toBe(1)
  })

  it('refuses to download when nothing is available', async () => {
    const harness = makeUpdater()
    const result = await harness.updater.downloadNow()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    expect(harness.engine.downloadCalls).toBe(0)
  })
})

describe('installing is gated on the service', () => {
  async function readyToInstall(overrides: Partial<CreateUpdaterOptions> = {}): Promise<Harness> {
    const harness = makeUpdater(overrides)
    harness.engine.checkOutcomes = [updateFound()]
    await harness.updater.checkNow()
    await harness.updater.downloadNow()
    expect(harness.updater.getStatus().kind).toBe('downloaded')
    return harness
  }

  it('REFUSES while a stream or recording is running', async () => {
    const harness = await readyToInstall()
    harness.serviceActive = true

    const result = await harness.updater.installNow()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARG')
      expect(result.error.detail).toBe(REFUSED_SERVICE_ACTIVE)
    }
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('fails closed when the service probe itself throws', async () => {
    const harness = await readyToInstall({
      isServiceActive: () => {
        throw new Error('health service is down')
      },
    })

    const result = await harness.updater.installNow()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toBe(REFUSED_SERVICE_ACTIVE)
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('checks the service guard before it checks whether anything was downloaded', async () => {
    // Ordering matters: a mid-service request must be refused as a service refusal, not
    // shadowed by some other precondition.
    const harness = makeUpdater()
    harness.serviceActive = true

    const result = await harness.updater.installNow()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toBe(REFUSED_SERVICE_ACTIVE)
  })

  it('refuses when nothing has been downloaded', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound()]
    await harness.updater.checkNow()

    const result = await harness.updater.installNow()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toBe(REFUSED_NOTHING_DOWNLOADED)
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('installs only on an explicit call, off-service, with a visible installer', async () => {
    const harness = await readyToInstall()

    const result = await harness.updater.installNow()

    expect(result.ok).toBe(true)
    // isSilent false (the operator can see what is happening), isForceRunAfter true.
    expect(harness.engine.quitAndInstallCalls).toEqual([[false, true]])
  })
})

describe('errors degrade to a log, never a dialog storm', () => {
  it('returns an Err and records a status instead of throwing', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [new Error('ENOTFOUND updates.example.invalid')]

    const result = await harness.updater.checkNow()

    expect(result.ok).toBe(false)
    const status = harness.updater.getStatus()
    expect(status.kind).toBe('error')
    if (status.kind === 'error') {
      expect(status.message).toContain('ENOTFOUND')
      expect(status.gaveUp).toBe(false)
    }
    expect(harness.warns).toContain('check failed')
  })

  it('stops checking after the failure budget is spent', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = Array.from(
      { length: MAX_CONSECUTIVE_ERRORS + 3 },
      () => new Error('boom')
    )

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_ERRORS + 3; attempt += 1) {
      await harness.updater.checkNow()
    }

    expect(harness.engine.checkCalls).toBe(MAX_CONSECUTIVE_ERRORS)
    const status = harness.updater.getStatus()
    expect(status.kind).toBe('error')
    if (status.kind === 'error') expect(status.gaveUp).toBe(true)
    // One warn per real attempt — no storm.
    expect(harness.warns.filter((line) => line === 'check failed')).toHaveLength(
      MAX_CONSECUTIVE_ERRORS
    )
  })

  it('resets the failure budget after a successful check', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [new Error('boom'), null, new Error('boom')]

    await harness.updater.checkNow()
    await harness.updater.checkNow()
    const third = await harness.updater.checkNow()

    expect(third.ok).toBe(false)
    const status = harness.updater.getStatus()
    if (status.kind === 'error') expect(status.consecutive).toBe(1)
    expect(harness.engine.checkCalls).toBe(3)
  })

  it('surfaces a download failure as a status, not an exception', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound()]
    harness.engine.downloadOutcome = new Error('disk full')
    await harness.updater.checkNow()

    const result = await harness.updater.downloadNow()

    expect(result.ok).toBe(false)
    expect(harness.updater.getStatus().kind).toBe('error')
    expect(harness.engine.quitAndInstallCalls).toEqual([])
  })

  it('survives a status listener that throws', async () => {
    const harness = makeUpdater({
      onStatus: () => {
        throw new Error('renderer went away')
      },
    })
    harness.engine.checkOutcomes = [null]

    const result = await harness.updater.checkNow()

    expect(result.ok).toBe(true)
  })

  it('publishes each status transition to the listener', async () => {
    const harness = makeUpdater()
    harness.engine.checkOutcomes = [updateFound()]

    await harness.updater.checkNow()
    await harness.updater.downloadNow()

    expect(harness.statuses).toEqual(['checking', 'available', 'downloading', 'downloaded'])
  })
})
