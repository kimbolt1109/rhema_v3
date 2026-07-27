/**
 * Read OBS's OWN obs-websocket settings, so the operator never types the password twice.
 *
 * ## The friction this removes
 *
 * `obs/OBS-SETUP.md` used to ask for the same secret three times: read it out of OBS's Connect Info
 * dialog, paste it into `config.json`, then paste it AGAIN into Verger's Connection screen, because
 * that screen does not read `config.json`. Three chances to typo one string, on a Sunday morning,
 * and the failure looks like "Password rejected" rather than like a typo.
 *
 * OBS already stores those settings in a plain JSON file. Reading it turns the whole procedure into
 * launching the app.
 *
 * ## Why this is a read and never a write
 *
 * Standing Rule 2: OBS is the resilient engine and this app is a convenience layer that imposes
 * nothing. Verger will not enable OBS's WebSocket server, will not set a password, and will not edit
 * this file — an operator who finds their OBS settings changed by a program they ran once has been
 * given a reason never to trust it again. If the server is switched off, this reports that and the
 * UI says so; turning it on stays the operator's decision.
 *
 * ## Secret handling
 *
 * The password crosses this boundary in memory and stops there. It is never logged (not even at
 * debug, not even truncated), never written into Verger's `config.json`, and never returned in
 * anything that reaches `summarize()`. Standing Rule 5 keeps secrets out of committed files; this
 * keeps them out of the log file too, which is the one an operator emails to ask for help.
 *
 * ## Absent is a resting state, not a failure
 *
 * OBS not installed, never launched, or a corrupt settings file all resolve to `NOT_FOUND` /
 * `IO_ERROR` and the caller carries on with whatever the operator configured by hand. Nothing here
 * can prevent Verger from starting.
 */

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'

/**
 * Where OBS keeps the obs-websocket plugin's settings on Windows.
 *
 * Verified against a real OBS install on the machine this was written on. `%APPDATA%` is passed in
 * rather than read from `process.env` here so the resolver is testable without touching the
 * environment.
 */
export const OBS_WEBSOCKET_CONFIG_SEGMENTS = [
  'obs-studio',
  'plugin_config',
  'obs-websocket',
  'config.json',
] as const

/** Absolute path to OBS's obs-websocket settings file, given an `%APPDATA%` directory. */
export function obsWebsocketConfigPath(appDataDir: string): string {
  return join(appDataDir, ...OBS_WEBSOCKET_CONFIG_SEGMENTS)
}

/**
 * Where a PORTABLE OBS keeps the same file, relative to the OBS folder itself.
 *
 * A portable OBS — one with a `portable_mode.txt` beside its `bin/` — does not use `%APPDATA%` at
 * all. It stores everything under `<obs>/config/obs-studio/`, so the `%APPDATA%` lookup above finds
 * nothing and discovery silently reports "OBS is not installed" on a machine where OBS is sitting
 * right next to Verger.
 *
 * This was verified by running one: a copy of OBS with the marker file created
 * `<obs>/config/obs-studio/plugin_config/obs-websocket/config.json` and never touched `%APPDATA%`.
 * Without this path, shipping a portable OBS would have made setup WORSE than the installed case —
 * the auto-connect added in Cycle 17 would have missed it every time.
 */
export const OBS_PORTABLE_CONFIG_SEGMENTS = [
  'config',
  ...OBS_WEBSOCKET_CONFIG_SEGMENTS,
] as const

/**
 * The folder a bundled portable OBS is expected to occupy, beside `Verger.exe`.
 *
 * Matches the layout `scripts/assemble-portable-obs.mts` produces and `portable/obs/OBS-SETUP.md`
 * documents. Nothing breaks if it is absent — that is simply the "no bundled OBS" case.
 */
export const OBS_PORTABLE_DIR_NAME = 'obs'

/** Absolute path to a portable OBS's obs-websocket settings, given the OBS folder. */
export function obsPortableWebsocketConfigPath(obsRootDir: string): string {
  return join(obsRootDir, ...OBS_PORTABLE_CONFIG_SEGMENTS)
}

/** What OBS itself says about its WebSocket server. */
export interface ObsLocalConfig {
  /**
   * Whether OBS's WebSocket server is switched ON.
   *
   * False is the interesting case and the common one on a fresh machine: the plugin ships disabled,
   * so discovery can succeed and still have nothing to connect to. A caller that ignores this will
   * dial a port nothing is listening on and report a timeout instead of "switch it on in OBS".
   */
  readonly serverEnabled: boolean
  /** Whether OBS demands a password. When false, connecting with an empty one is correct. */
  readonly authRequired: boolean
  /** The server password. Empty when OBS has authentication turned off. NEVER log this. */
  readonly password: string
  readonly port: number
  /** The file this came from, for a diagnostic that names the source without quoting the secret. */
  readonly sourcePath: string
}

export interface ReadObsWebsocketConfigOptions {
  /** Defaults to `process.env.APPDATA`. */
  readonly appDataDir?: string | undefined
  /**
   * The folder holding a PORTABLE OBS bundled beside Verger, if there is one.
   *
   * Checked BEFORE `%APPDATA%`, and the order is deliberate: an operator who put a portable OBS in
   * the Verger folder chose the OBS for this deployment, and it is the one `START.bat` launches. An
   * OBS installed on the machine years ago is the fallback, not the intent. Absent or unreadable
   * simply falls through, so a machine with only an installed OBS behaves exactly as before.
   */
  readonly portableObsDir?: string | undefined
  /** Injected in tests. Defaults to `node:fs`'s reader. */
  readonly readFile?: (path: string) => string
}

/** A port OBS could plausibly be listening on. Anything else means the file is not trustworthy. */
function isUsablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536
}

/**
 * Read OBS's obs-websocket settings.
 *
 * Never throws. Every failure — no `%APPDATA%`, no OBS, unreadable file, malformed JSON, a shape
 * that is not the object this expects — comes back as an `Err` the caller can ignore safely.
 */
export function readObsWebsocketConfig(
  options: ReadObsWebsocketConfigOptions = {},
): Result<ObsLocalConfig> {
  const appDataDir = options.appDataDir ?? process.env['APPDATA']
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  // Portable first — see `portableObsDir` for why that order. The first candidate that READS wins.
  const candidates: string[] = []
  if (options.portableObsDir !== undefined && options.portableObsDir.length > 0) {
    candidates.push(obsPortableWebsocketConfigPath(options.portableObsDir))
  }
  if (appDataDir !== undefined && appDataDir.length > 0) {
    candidates.push(obsWebsocketConfigPath(appDataDir))
  }

  if (candidates.length === 0) {
    return err(
      ErrorCode.NOT_CONFIGURED,
      'APPDATA is not set and no portable OBS folder was given, so OBS-s own settings cannot be located.',
    )
  }

  let raw: string | undefined
  let sourcePath = ''
  for (const candidate of candidates) {
    try {
      raw = read(candidate)
      sourcePath = candidate
      break
    } catch {
      continue
    }
  }

  if (raw === undefined) {
    // Deliberately not carrying the cause: an ENOENT here is the ordinary "OBS is not installed on
    // this machine" case, and a stack trace would make a non-event look like a fault in the log.
    return err(
      ErrorCode.NOT_FOUND,
      'OBS-s WebSocket settings file was not found. OBS may not be installed, or may never have been launched on this machine.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return err(ErrorCode.IO_ERROR, 'OBS-s WebSocket settings file is not valid JSON.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(ErrorCode.IO_ERROR, 'OBS-s WebSocket settings file is not a JSON object.')
  }

  const record = parsed as Record<string, unknown>
  const port = record['server_port']
  if (!isUsablePort(port)) {
    return err(
      ErrorCode.IO_ERROR,
      'OBS-s WebSocket settings file does not name a usable server port.',
    )
  }

  const password = record['server_password']
  // `auth_required` is the authority on whether a password is needed, not the presence of one: OBS
  // keeps the last password in the file after authentication is switched off.
  const authRequired = record['auth_required'] === true

  return ok({
    serverEnabled: record['server_enabled'] === true,
    authRequired,
    password: typeof password === 'string' ? password : '',
    port,
    sourcePath,
  })
}

/** How long to wait for the OBS port to accept a socket before deciding OBS is not up. */
export const OBS_PROBE_TIMEOUT_MS = 400

/**
 * Is anything actually listening on OBS's port right now?
 *
 * ## Why a launch-time connect needs this
 *
 * `ObsClient.connect` arms a reconnect backoff on failure, which is exactly right mid-service — OBS
 * restarting must not need the operator's attention. It is exactly wrong as an opening move against
 * a machine where OBS simply is not running: the operator gets a permanent amber tally and a panel
 * escalating through "Reconnecting… Attempt 5… **OBS went away**", when OBS was never there. That
 * message is only true after a connection existed, and "went away" for something that never arrived
 * teaches an operator to distrust the panel.
 *
 * So the launch path asks a cheaper question first, and stays quiet when the answer is no. Pressing
 * Connect by hand still goes down the full retrying path, because by then the operator has said they
 * expect OBS to be there.
 *
 * A bare TCP connect, not a WebSocket handshake: this only distinguishes "something is listening"
 * from "nothing is", and the real client does the protocol. Resolves `false` on any error and can
 * never reject.
 */
export async function isObsPortListening(
  port: number,
  host = '127.0.0.1',
  timeoutMs: number = OBS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (listening: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(listening)
    }

    const socket = connect({ port, host });
    // `once` on all three: a socket that errors after connecting must not flip the answer back.
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('timeout', () => {
      finish(false)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}
