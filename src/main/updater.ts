/**
 * Auto-update — `electron-updater` wiring, deliberately timid.
 *
 * Adapted from `docs/v2-notes/OPS_AND_UPDATE.md` §5 (ADR-010 / PART 10.3). v2 wrote a
 * signed-manifest scheme for Tauri that was never once exercised against a real bucket;
 * Verger is Electron, so it goes back to the original decision — `electron-builder` +
 * `electron-updater` with a **generic** provider and the native `latest.yml` manifest — and
 * writes no manifest parsing of its own.
 *
 * ## The one rule this file exists to enforce
 *
 * **An update must never restart the app during a service.** A service is un-repeatable. If
 * this file ever quits the app while the stream is live or the recording is running, it has
 * destroyed the single thing the whole product is for, and no amount of convenience buys that
 * back. Concretely:
 *
 *  - `autoInstallOnAppQuit` is left **on** — that path only fires when the operator has
 *    already decided to quit, which is by definition not mid-service.
 *  - `quitAndInstall()` is called from exactly one place: {@link Updater.installNow}, which is
 *    reachable only from an explicit operator action, and which **refuses** while
 *    {@link CreateUpdaterOptions.isServiceActive} reports a stream or a recording running.
 *  - Nothing here ever calls `quitAndInstall` from an event handler, a timer, or a check.
 *  - Downloading is safe and silent; installing is not, and is never automatic.
 *
 * ## Not configured means off — completely off (Standing Rule 5)
 *
 * With no feed URL the updater never constructs the engine, so `electron-updater` is not even
 * imported, no `setFeedURL` happens and **no network request is ever made**. `getStatus()`
 * returns `not-configured` and the UI shows a resting state. There is no nag, no retry, no
 * dialog, and no error — an app with no update server is a normal, supported deployment. It is
 * also the *current* deployment: `electron-builder.yml` has no `publish:` block because no
 * update host exists, and the installer is unsigned, which on Windows means `electron-updater`
 * could not verify a downloaded installer's publisher anyway.
 *
 * ## Errors degrade to a log line
 *
 * Every failure path here ends in `logger.warn` and a `status.kind === 'error'`. This module
 * never opens a dialog — it does not import `dialog` — and after
 * {@link MAX_CONSECUTIVE_ERRORS} failures it stops checking for the rest of the session, so a
 * dead CDN cannot turn into an unbounded retry loop or a storm of identical toasts.
 *
 * ## Testability
 *
 * The Electron `autoUpdater`, the clock, the timer, the argv and the "is a service running"
 * probe are all injected. `updater.test.ts` needs no network, no Electron and no
 * `electron-updater`.
 */

import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import type { Logger } from '@shared/log'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Delay before the launch-time check.
 *
 * ADR-010 / PART 10.3 step 4: wait 10 s. On Windows the first seconds after launch are when
 * Squirrel may still hold a lock on the install directory, and it is also when the operator is
 * connecting OBS and importing a deck — the last moment to spend bandwidth on a download.
 */
export const LAUNCH_CHECK_DELAY_MS = 10_000

/** After this many consecutive failures the updater gives up for the session. */
export const MAX_CONSECUTIVE_ERRORS = 3

/**
 * The Squirrel first-run argument.
 *
 * ADR-010 marks this **(C)**: calling `checkForUpdates()` on the very first launch after a
 * Squirrel install crashes. Guarded unconditionally, on every entry point, not just the
 * scheduled one.
 */
export const SQUIRREL_FIRSTRUN_ARG = '--squirrel-firstrun'

/**
 * The `detail` marker on the refusal returned when an install is attempted mid-service.
 *
 * `ErrorCode` (in `src/shared/result.ts`) has no `SERVICE_ACTIVE` member and this module does
 * not own that file, so the refusal reuses `INVALID_ARG` — the precondition for the call was
 * not met — and carries this stable string in `detail`. Branch on the constant, not on the
 * message text, which is prose and may be reworded.
 */
export const REFUSED_SERVICE_ACTIVE = 'service-active'

/** The `detail` marker when an install is attempted before anything has been downloaded. */
export const REFUSED_NOTHING_DOWNLOADED = 'nothing-downloaded'

// ---------------------------------------------------------------------------
// Status — the discriminated union the renderer gates its UI on
// ---------------------------------------------------------------------------

/** What the updater is doing right now. Mirrors v2's `UpdaterStatus` enum shape. */
export type UpdaterStatus =
  /** No feed URL. The resting state, and the current shipped state. Never an alarm. */
  | { readonly kind: 'not-configured' }
  /** Configured, nothing in flight. */
  | { readonly kind: 'idle'; readonly currentVersion: string; readonly lastCheckedAt: number | null }
  /** A check is in flight. */
  | { readonly kind: 'checking'; readonly currentVersion: string }
  /** The server offered nothing newer. */
  | { readonly kind: 'up-to-date'; readonly currentVersion: string; readonly checkedAt: number }
  /** A newer version exists. Reported only — never acted on without the operator. */
  | {
      readonly kind: 'available'
      readonly currentVersion: string
      readonly version: string
      readonly releaseDate: string | null
      readonly notes: string | null
      readonly checkedAt: number
    }
  /** The installer is downloading in the background. Still nothing is installed. */
  | { readonly kind: 'downloading'; readonly currentVersion: string; readonly version: string }
  /**
   * The installer is on disk and will be applied **at quit, or when the operator asks**.
   * This is as far as the updater goes on its own.
   */
  | { readonly kind: 'downloaded'; readonly currentVersion: string; readonly version: string }
  /** Something went wrong. Logged; shown as a small status, never as a dialog. */
  | {
      readonly kind: 'error'
      readonly currentVersion: string
      readonly message: string
      readonly consecutive: number
      readonly gaveUp: boolean
    }

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The subset of `UpdateInfo` this module reads. */
export interface UpdaterEngineUpdateInfo {
  readonly version: string
  readonly releaseDate?: string
  readonly releaseNotes?: string | readonly unknown[] | null
}

/** The subset of `UpdateCheckResult` this module reads. */
export interface UpdaterEngineCheckResult {
  readonly updateInfo: UpdaterEngineUpdateInfo
}

/**
 * The slice of `electron-updater`'s `autoUpdater` that Verger uses.
 *
 * Declared structurally rather than imported so this module — and its tests — never pull in
 * `electron-updater`, which transitively requires a real Electron runtime.
 */
export interface UpdaterEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void
  checkForUpdates(): Promise<UpdaterEngineCheckResult | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

/** Lazily produces the engine. Never invoked when the updater is not configured. */
export type UpdaterEngineFactory = () => Promise<Result<UpdaterEngine>>

/** Minimal timer seam so tests advance time without waiting for it. */
export interface UpdaterTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CreateUpdaterOptions {
  /**
   * Base URL of the generic update feed — the directory containing `latest.yml`, NOT the
   * manifest file itself. `null` or empty ⇒ the updater is off.
   *
   * v2-notes §4 flagged the naming ambiguity it inherited (`RHEMA_UPDATE_MANIFEST_URL` pointed
   * at one JSON file; the blueprint's `RHEMA_UPDATE_URL` was a base). Resolved here in favour
   * of the base URL, because that is what `electron-updater`'s generic provider actually takes
   * and it means no bespoke manifest parsing exists in this codebase at all.
   */
  readonly feedUrl: string | null
  /** Release channel; maps to `latest.yml` vs `beta.yml`. Omit for the default. */
  readonly channel?: string
  /** `app.getVersion()`. */
  readonly currentVersion: string
  /**
   * Download an available update in the background without asking.
   *
   * Safe: downloading changes nothing until an install, and having the bytes ready means the
   * quit-time install is instant rather than a five-minute wait with the van packed. Default
   * `false` — bandwidth during a service is not ours to spend uninvited.
   */
  readonly autoDownload?: boolean
  /** `process.argv`. Checked for {@link SQUIRREL_FIRSTRUN_ARG}. */
  readonly argv?: readonly string[]
  /** Is a stream or a local recording running right now? The install guard. */
  readonly isServiceActive: () => boolean
  /** Produces the `electron-updater` engine. Defaults to {@link loadElectronUpdaterEngine}. */
  readonly engine?: UpdaterEngineFactory
  readonly logger?: Logger
  /** Epoch ms. Default `Date.now`. */
  readonly now?: () => number
  /** Delay before the launch check. Default {@link LAUNCH_CHECK_DELAY_MS}. */
  readonly launchCheckDelayMs?: number
  /** Timer seam. Default the globals. */
  readonly timers?: UpdaterTimers
  /** Called on every status transition — wire to an IPC push. */
  readonly onStatus?: (status: UpdaterStatus) => void
}

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

/**
 * The env key carrying the update feed base URL.
 *
 * NOT one of the eight keys in `src/shared/config.ts` / `.env.example`, because there is no
 * update server to point it at and adding a ninth key would imply otherwise. It is read
 * opportunistically; absent means off, which is the same thing the eight-key contract means by
 * an empty value.
 */
export const UPDATE_URL_ENV_KEY = 'VERGER_UPDATE_URL'

/** Pure: pull the feed URL out of an environment, normalising empty/whitespace to `null`. */
export function readUpdateFeedUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env[UPDATE_URL_ENV_KEY]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

// ---------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------

/**
 * Load `electron-updater`'s `autoUpdater` as an {@link UpdaterEngine}.
 *
 * Dynamically imported so that merely importing this module — in a unit test, or in an app
 * with no update server — does not drag in `electron-updater` and, through it, Electron. A
 * failed import degrades to an `Err`, which the updater logs and treats as "off".
 */
export async function loadElectronUpdaterEngine(): Promise<Result<UpdaterEngine>> {
  try {
    const module: unknown = await import('electron-updater')
    const candidate = (module as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } })
    const engine = candidate.autoUpdater ?? candidate.default?.autoUpdater
    if (engine === undefined || engine === null) {
      return err(ErrorCode.INTERNAL, 'electron-updater exported no autoUpdater')
    }
    return ok(engine as UpdaterEngine)
  } catch (cause) {
    return err(
      ErrorCode.INTERNAL,
      'electron-updater could not be loaded',
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NULL_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NULL_LOGGER,
}

/**
 * `releaseNotes` is `string | ReleaseNoteInfo[] | null` in electron-updater. Flatten to a
 * single string, or `null`. Never throws on a shape we did not expect.
 */
function flattenNotes(notes: UpdaterEngineUpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() === '' ? null : notes
  if (Array.isArray(notes)) {
    const parts = notes
      .map((entry) =>
        entry !== null && typeof entry === 'object' && 'note' in entry
          ? String((entry as { note?: unknown }).note ?? '')
          : ''
      )
      .filter((part) => part.trim() !== '')
    return parts.length === 0 ? null : parts.join('\n\n')
  }
  return null
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

/**
 * The update service.
 *
 * Construct once at startup, call {@link start} after the window is up, and let the operator
 * drive everything else. `start()` on an unconfigured updater is a no-op, so the caller needs
 * no branch.
 */
export class Updater {
  private readonly feedUrl: string | null
  private readonly channel: string | undefined
  private readonly currentVersion: string
  private readonly wantAutoDownload: boolean
  private readonly firstRun: boolean
  private readonly isServiceActive: () => boolean
  private readonly engineFactory: UpdaterEngineFactory
  private readonly log: Logger
  private readonly now: () => number
  private readonly launchCheckDelayMs: number
  private readonly timers: UpdaterTimers
  private readonly onStatus: ((status: UpdaterStatus) => void) | undefined

  private status: UpdaterStatus
  private engine: UpdaterEngine | null = null
  private engineFailed = false
  private consecutiveErrors = 0
  private launchTimer: unknown = null
  private inFlight: Promise<Result<UpdaterStatus>> | null = null
  /** The version electron-updater has fully downloaded, or `null`. Gates `installNow`. */
  private downloadedVersion: string | null = null
  private stopped = false

  constructor(options: CreateUpdaterOptions) {
    const feed = options.feedUrl === null ? null : options.feedUrl.trim()
    this.feedUrl = feed === null || feed.length === 0 ? null : feed
    this.channel = options.channel
    this.currentVersion = options.currentVersion
    this.wantAutoDownload = options.autoDownload ?? false
    this.firstRun = (options.argv ?? []).includes(SQUIRREL_FIRSTRUN_ARG)
    this.isServiceActive = options.isServiceActive
    this.engineFactory = options.engine ?? loadElectronUpdaterEngine
    this.log = (options.logger ?? NULL_LOGGER).child('updater')
    this.now = options.now ?? (() => Date.now())
    this.launchCheckDelayMs = options.launchCheckDelayMs ?? LAUNCH_CHECK_DELAY_MS
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.onStatus = options.onStatus

    this.status =
      this.feedUrl === null
        ? { kind: 'not-configured' }
        : { kind: 'idle', currentVersion: this.currentVersion, lastCheckedAt: null }
  }

  /** Is an update feed configured at all? */
  isConfigured(): boolean {
    return this.feedUrl !== null
  }

  /** The current status. Cheap; safe to poll from IPC. */
  getStatus(): UpdaterStatus {
    return this.status
  }

  /**
   * Schedule the single launch-time check.
   *
   * No-op — and specifically, **no engine construction and no network** — when the updater is
   * unconfigured, when this is a Squirrel first run, or when it has already been started.
   */
  start(): void {
    if (this.feedUrl === null) {
      this.log.info('not configured; auto-update is off', { reason: 'no feed url' })
      return
    }
    if (this.firstRun) {
      // ADR-010 (C). Squirrel is still moving files around; a check here crashes.
      this.log.info('squirrel first run; skipping the launch check')
      return
    }
    if (this.launchTimer !== null || this.stopped) return

    this.launchTimer = this.timers.setTimeout(() => {
      this.launchTimer = null
      void this.checkNow()
    }, this.launchCheckDelayMs)
  }

  /** Cancel the pending launch check. Idempotent; call from the app's quit path. */
  stop(): void {
    this.stopped = true
    if (this.launchTimer !== null) {
      this.timers.clearTimeout(this.launchTimer)
      this.launchTimer = null
    }
  }

  /**
   * Check the feed once.
   *
   * Never rejects. Concurrent calls share one in-flight check, so a operator tapping "check"
   * while the launch timer fires does not produce two requests.
   */
  async checkNow(): Promise<Result<UpdaterStatus>> {
    if (this.feedUrl === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'auto-update is not configured')
    }
    if (this.firstRun) {
      return err(ErrorCode.NOT_CONFIGURED, 'skipped: squirrel first run')
    }
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Gave up for the session. Deliberately not an error the UI re-raises.
      return ok(this.status)
    }
    if (this.inFlight !== null) return this.inFlight

    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runCheck(): Promise<Result<UpdaterStatus>> {
    const engineResult = await this.ensureEngine()
    if (!engineResult.ok) return engineResult

    const engine = engineResult.value
    this.setStatus({ kind: 'checking', currentVersion: this.currentVersion })

    let result: UpdaterEngineCheckResult | null
    try {
      result = await engine.checkForUpdates()
    } catch (cause) {
      return this.fail('check failed', cause)
    }

    const checkedAt = this.now()
    this.consecutiveErrors = 0

    // `null` means "no update" (electron-updater returns null when the updater is disabled or
    // nothing is newer). A version equal to ours means the same thing.
    if (result === null || result.updateInfo.version === this.currentVersion) {
      const status: UpdaterStatus = {
        kind: 'up-to-date',
        currentVersion: this.currentVersion,
        checkedAt,
      }
      this.setStatus(status)
      return ok(status)
    }

    const info = result.updateInfo
    const status: UpdaterStatus = {
      kind: 'available',
      currentVersion: this.currentVersion,
      version: info.version,
      releaseDate: info.releaseDate ?? null,
      notes: flattenNotes(info.releaseNotes),
      checkedAt,
    }
    this.setStatus(status)
    // REPORTED, NOT INSTALLED. Nothing below this line may install anything: the operator has
    // not been asked yet, and for all we know a service starts in ninety seconds.
    this.log.info('update available', { version: info.version, current: this.currentVersion })

    if (this.wantAutoDownload) {
      // Background download only. Still no install.
      void this.downloadNow()
    }
    return ok(status)
  }

  /**
   * Download the available update in the background.
   *
   * Downloading is not installing. Nothing on the operator's machine changes behaviour because
   * an installer sits in a cache directory.
   */
  async downloadNow(): Promise<Result<UpdaterStatus>> {
    if (this.feedUrl === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'auto-update is not configured')
    }
    if (this.status.kind !== 'available' && this.status.kind !== 'downloading') {
      return err(ErrorCode.NOT_FOUND, 'no update is available to download')
    }
    const version = this.status.version
    const engineResult = await this.ensureEngine()
    if (!engineResult.ok) return engineResult

    this.setStatus({ kind: 'downloading', currentVersion: this.currentVersion, version })
    try {
      await engineResult.value.downloadUpdate()
    } catch (cause) {
      return this.fail('download failed', cause)
    }
    this.downloadedVersion = version
    const status: UpdaterStatus = {
      kind: 'downloaded',
      currentVersion: this.currentVersion,
      version,
    }
    this.setStatus(status)
    this.log.info('update downloaded; will apply at quit or on operator request', { version })
    return ok(status)
  }

  /**
   * Apply the downloaded update **now**, quitting and relaunching the app.
   *
   * The only caller may be an explicit operator action. It is refused outright while a stream
   * or a recording is running — see the header. The refusal is not advisory and there is no
   * force flag; if the operator genuinely wants to update mid-service they can end the service
   * first, which is exactly the deliberation this guard is buying.
   */
  async installNow(): Promise<Result<'installing'>> {
    if (this.feedUrl === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'auto-update is not configured')
    }

    // Guard FIRST, before touching the engine. Order matters: a mid-service call must not even
    // begin an install sequence.
    let active: boolean
    try {
      active = this.isServiceActive()
    } catch (cause) {
      // A probe that throws is treated as "a service is running". Fail closed: the cost of a
      // wrongly-refused update is a later click; the cost of a wrongly-allowed one is a dead
      // stream in front of a congregation.
      this.log.warn('service-activity probe threw; refusing install', { error: messageOf(cause) })
      active = true
    }
    if (active) {
      this.log.warn('install refused: a stream or recording is running')
      return err(
        ErrorCode.INVALID_ARG,
        'refusing to install an update while a stream or recording is running',
        REFUSED_SERVICE_ACTIVE
      )
    }

    if (this.downloadedVersion === null || this.status.kind !== 'downloaded') {
      return err(
        ErrorCode.NOT_FOUND,
        'no downloaded update to install',
        REFUSED_NOTHING_DOWNLOADED
      )
    }

    const engineResult = await this.ensureEngine()
    if (!engineResult.ok) return engineResult

    this.log.info('operator requested install; quitting to apply', {
      version: this.downloadedVersion,
    })
    try {
      // `isSilent: false` so the NSIS installer's progress is visible — an app that vanishes
      // and comes back with no explanation is indistinguishable from a crash.
      // `isForceRunAfter: true` so the operator gets the app back.
      engineResult.value.quitAndInstall(false, true)
    } catch (cause) {
      const failure = this.fail('install failed', cause)
      return failure.ok ? err(ErrorCode.INTERNAL, 'install failed') : failure
    }
    return ok('installing')
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Build the engine on first use and configure it. Cached, including the failure. */
  private async ensureEngine(): Promise<Result<UpdaterEngine>> {
    if (this.engine !== null) return ok(this.engine)
    if (this.engineFailed) {
      return err(ErrorCode.INTERNAL, 'the update engine is unavailable')
    }
    if (this.feedUrl === null) {
      return err(ErrorCode.NOT_CONFIGURED, 'auto-update is not configured')
    }

    const loaded = await this.engineFactory()
    if (!loaded.ok) {
      this.engineFailed = true
      this.log.warn('update engine unavailable; auto-update stays off', {
        error: loaded.error.message,
      })
      return loaded
    }

    const engine = loaded.value
    try {
      // electron-updater's own auto behaviours are both disabled here. Verger decides when to
      // download (never during a check unless asked) and never lets the library decide when to
      // install. `autoInstallOnAppQuit` is the one automatic path allowed, and only because
      // "at quit" is already the operator having chosen to stop.
      engine.autoDownload = false
      engine.autoInstallOnAppQuit = true
      engine.setFeedURL(
        this.channel === undefined
          ? { provider: 'generic', url: this.feedUrl }
          : { provider: 'generic', url: this.feedUrl, channel: this.channel }
      )
    } catch (cause) {
      this.engineFailed = true
      this.log.warn('could not configure the update engine', { error: messageOf(cause) })
      return err(ErrorCode.INTERNAL, 'could not configure the update engine', messageOf(cause))
    }

    this.engine = engine
    return ok(engine)
  }

  /** One place where a failure becomes a log line and a status. Never a dialog. */
  private fail(what: string, cause: unknown): Result<UpdaterStatus> {
    this.consecutiveErrors += 1
    const gaveUp = this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
    const message = messageOf(cause)
    this.log.warn(what, { error: message, consecutive: this.consecutiveErrors, gaveUp })
    this.setStatus({
      kind: 'error',
      currentVersion: this.currentVersion,
      message,
      consecutive: this.consecutiveErrors,
      gaveUp,
    })
    return err(ErrorCode.INTERNAL, what, message)
  }

  private setStatus(status: UpdaterStatus): void {
    this.status = status
    if (this.onStatus === undefined) return
    try {
      this.onStatus(status)
    } catch {
      // A listener that throws is the listener's problem, never the updater's.
    }
  }
}

/** Convenience factory, mirroring the `create*` shape used elsewhere in the main process. */
export function createUpdater(options: CreateUpdaterOptions): Updater {
  return new Updater(options)
}
