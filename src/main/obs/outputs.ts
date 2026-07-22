/**
 * OBS output control — the stream and recording verbs, and the observation of both.
 *
 * This is the thinnest possible layer over {@link ObsClient}: it maps four allowlisted OBS
 * requests and two reads onto `Result`-returning functions, and it maps OBS's own output events
 * back out again. It holds no state of its own beyond the subscriptions it hands back, because
 * **OBS owns whether it is streaming and recording** (Standing Rule 2). Everything here is either
 * an observation of OBS or a request to OBS, never a cached opinion about it.
 *
 * ## Standing Rule 3 lives in {@link ObsOutputs.startStreamAndRecord}
 *
 * Whenever streaming starts, local recording starts too. The local file is the backup for the
 * moment the internet wobbles mid-service, and a service is un-repeatable — you cannot ask the
 * congregation to do it again. There is deliberately **no flag anywhere in this module to disable
 * recording**; the absence of that flag is the design, and a failure to start recording is loud
 * rather than silent.
 *
 * ## Verger never stops the broadcast as a reaction to its own error
 *
 * No function in this module issues a `Stop*` request on a failure path. If the recording fails to
 * start, the stream keeps running. If a read fails, nothing is torn down. The only `Stop*`
 * requests that ever reach OBS are the ones {@link ObsOutputs.stopStream} and
 * {@link ObsOutputs.stopRecord} are asked for explicitly, by an operator ending the service.
 *
 * ## Nothing throws
 *
 * Every function returns a {@link Result}, every callback is wrapped, and every field OBS might
 * omit degrades to `null`/`false` rather than to an exception (see {@link toObsOutputState}).
 */

import { emptyObsOutputState } from '@shared/golive'
import type { ObsOutputState } from '@shared/golive'
import type { Unsubscribe } from '@shared/ipc'
import type { Logger } from '@shared/log'
import type { ObsStatus } from '@shared/obs'
import { ErrorCode, err, ok } from '@shared/result'
import type { AppError, Err, Result } from '@shared/result'

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

/**
 * The structural slice of `ObsClient` this module uses.
 *
 * Declared locally rather than importing the class so the tests drive it with a hand-written
 * object — no socket, no `ws`, no OBS Studio, no network. `ObsClient` satisfies this interface
 * structurally; `outputs.test.ts` asserts that at compile time.
 *
 * `onObsEvent` is optional because `ObsClient` does not expose raw obs-websocket events today.
 * Rather than widening that class (Standing Rule 2 keeps its surface deliberately small), the
 * caller that owns the socket may supply the hook; without it {@link ObsOutputs.subscribeOutputs}
 * degrades to refreshing on reconnect only, which is a smaller feature, never a failure.
 */
export interface ObsOutputSocket {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Result<unknown>>
  getStatus(): ObsStatus
  onStatus(callback: (status: ObsStatus) => void): Unsubscribe
  onObsEvent?(event: string, listener: (payload?: unknown) => void): Unsubscribe
}

/** Constructor dependencies. Everything is injected; nothing is reached for. */
export interface ObsOutputsOptions {
  readonly client: ObsOutputSocket
  readonly logger?: Logger
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The four output requests, exactly matching the Phase 5 additions to the write allowlist. */
export type OutputRequest = 'StartStream' | 'StopStream' | 'StartRecord' | 'StopRecord'

/**
 * The OBS events that mean "an output changed", including changes Verger did not ask for.
 *
 * Someone pressing "Start Recording" in the OBS window is a legitimate way to run a service, and
 * Verger must reflect it rather than contradict it.
 */
export const OBS_OUTPUT_EVENTS = [
  'StreamStateChanged',
  'RecordStateChanged',
  /** OBS 30 emits this when the recording rolls over to a new file (split recording). */
  'RecordFileChanged'
] as const

/**
 * obs-websocket `RequestStatus.OutputRunning` — "you asked me to start something already running".
 *
 * Surfaced by `ObsClient` as `AppError.detail === 'obs-websocket code 500'`.
 */
export const OBS_STATUS_OUTPUT_RUNNING = 500

/** obs-websocket `RequestStatus.OutputNotRunning` — stop requested on an idle output. */
export const OBS_STATUS_OUTPUT_NOT_RUNNING = 501

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

/** The result of one output verb. */
export interface OutputChange {
  readonly request: OutputRequest
  /**
   * True when OBS was already in the requested state, so the request was a no-op.
   *
   * This is a SUCCESS, not an error: OBS may well have been streaming or recording before Verger
   * asked (the operator started it by hand, or the app is re-attaching after a crash). Treating
   * "already recording" as a failure would make a healthy service look broken.
   */
  readonly alreadyInState: boolean
}

/**
 * The outcome of {@link ObsOutputs.startStreamAndRecord}.
 *
 * Deliberately reports the two outputs SEPARATELY instead of collapsing them into one pass/fail,
 * because the GO LIVE panel renders `stream` and `record` as two distinct steps and the honest
 * answer is frequently "one worked and the other did not".
 */
export interface StartOutputsOutcome {
  /** True when OBS is streaming after this call — whether we started it or it already was. */
  readonly streaming: boolean
  /** True when OBS is recording after this call. */
  readonly recording: boolean
  readonly streamAlreadyRunning: boolean
  readonly recordAlreadyRunning: boolean
  /** Non-null when `StartStream` failed. The caller marks the `stream` step failed. */
  readonly streamError: AppError | null
  /**
   * Non-null when `StartRecord` failed. The caller marks the `record` step failed, LOUDLY —
   * the service is running without its backup and the operator has to know that now, not
   * afterwards when the upload is corrupt.
   */
  readonly recordError: AppError | null
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export class ObsOutputs {
  private readonly client: ObsOutputSocket
  private readonly log: Logger

  constructor(options: ObsOutputsOptions) {
    this.client = options.client
    this.log = (options.logger ?? SILENT_LOGGER).child('obs:outputs')
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /**
   * Read what OBS is actually doing.
   *
   * Two reads (`GetStreamStatus`, `GetRecordStatus`) plus, only when OBS is recording and did not
   * volunteer a path, `GetRecordDirectory`. All three are `Get*` requests, so they pass the
   * client's guard as reads.
   */
  async readOutputState(): Promise<Result<ObsOutputState>> {
    const guard = this.requireConnected('read the OBS output state')
    if (guard !== null) return guard

    const stream = await this.client.call('GetStreamStatus')
    if (!stream.ok) return stream

    const record = await this.client.call('GetRecordStatus')
    if (!record.ok) return record

    const state = toObsOutputState(stream.value, record.value)
    if (state.recording && state.recordingPath === null) {
      // OBS 30's `GetRecordStatus` carries `outputPath`; older builds do not. The folder is far
      // more use to an operator hunting for the backup than `null` is, so fall back to it.
      const directory = await this.client.call('GetRecordDirectory')
      if (directory.ok) {
        const path = readString(directory.value, 'recordDirectory')
        if (path !== null) return ok({ ...state, recordingPath: path })
      }
    }
    return ok(state)
  }

  // -------------------------------------------------------------------------
  // The verbs
  // -------------------------------------------------------------------------

  /** `StartStream`. Already streaming counts as success. */
  async startStream(): Promise<Result<OutputChange>> {
    return this.send('StartStream')
  }

  /**
   * `StopStream`. Only ever called because an operator asked to END the service — never as
   * Verger's reaction to one of its own failures.
   */
  async stopStream(): Promise<Result<OutputChange>> {
    return this.send('StopStream')
  }

  /** `StartRecord`. Already recording counts as success. */
  async startRecord(): Promise<Result<OutputChange>> {
    return this.send('StartRecord')
  }

  /** `StopRecord`. Same rule as {@link stopStream}: operator-initiated only. */
  async stopRecord(): Promise<Result<OutputChange>> {
    return this.send('StopRecord')
  }

  /**
   * Start streaming AND recording. **The Standing Rule 3 primitive.**
   *
   * Both are attempted, always, in that order, and there is no parameter that can skip the
   * recording. Note what this function does NOT do:
   *
   * - **If `StartRecord` fails, it does not stop the stream.** That trade-off is deliberate and it
   *   is the whole point: the live service reaching the congregation is worth more than the backup
   *   copy of it. Losing the backup is bad and is reported loudly through `recordError`; taking
   *   the service off air to "clean up" after our own failure would be catastrophic and is
   *   forbidden (the app must never wedge the broadcast).
   * - **If `StartStream` fails, it still tries to record.** The service is happening in the room
   *   whether or not YouTube ever sees it, and a local file is the one artefact that can still be
   *   salvaged. Attempting it costs one request that OBS will refuse harmlessly if it cannot.
   *
   * Returns `Ok` whenever anything was attempted, with the per-output errors inside the outcome,
   * because the caller needs to mark `stream` and `record` as two independent steps. The only
   * `Err` is `NOT_CONNECTED`, which means nothing was attempted at all.
   */
  async startStreamAndRecord(): Promise<Result<StartOutputsOutcome>> {
    const guard = this.requireConnected('start the OBS outputs')
    if (guard !== null) return guard

    const stream = await this.send('StartStream')
    // Unconditional: no early return above this line, no flag that can skip it.
    const record = await this.send('StartRecord')

    const outcome: StartOutputsOutcome = {
      streaming: stream.ok,
      recording: record.ok,
      streamAlreadyRunning: stream.ok && stream.value.alreadyInState,
      recordAlreadyRunning: record.ok && record.value.alreadyInState,
      streamError: stream.ok ? null : stream.error,
      recordError: record.ok ? null : record.error
    }

    if (!record.ok) {
      this.log.error(
        'OBS refused to start the local recording — the stream is NOT being backed up to disk',
        { detail: record.error.detail, message: record.error.message, streaming: outcome.streaming }
      )
    }
    if (!stream.ok) {
      this.log.error('OBS refused to start the stream', {
        detail: stream.error.detail,
        message: stream.error.message,
        recording: outcome.recording
      })
    }

    return ok(outcome)
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  /**
   * Watch OBS's outputs, including changes Verger did not cause.
   *
   * Every notification is a fresh read of OBS rather than a guess derived from the event payload,
   * so the callback can only ever be given a state OBS actually confirmed.
   *
   * While OBS is disconnected the callback is deliberately **not** called: Verger does not know
   * what OBS is doing, and emitting a blank "not streaming, not recording" state would be a lie
   * that could talk the caller into starting a second stream. Silence is the honest answer; the
   * connection light already tells the operator why.
   */
  subscribeOutputs(callback: (state: ObsOutputState) => void): Unsubscribe {
    const subscriptions: Unsubscribe[] = []
    let disposed = false

    const refresh = (reason: string): void => {
      void this.refreshInto(callback, reason, () => disposed)
    }

    const onObsEvent = this.client.onObsEvent?.bind(this.client)
    if (onObsEvent === undefined) {
      this.log.warn(
        'the OBS client exposes no raw event hook; output changes will only be picked up on reconnect'
      )
    } else {
      for (const event of OBS_OUTPUT_EVENTS) {
        try {
          subscriptions.push(onObsEvent(event, () => refresh(event)))
        } catch (cause) {
          this.log.warn('failed to subscribe to an OBS output event', { event, cause })
        }
      }
    }

    // A reconnect is the other way the truth changes underneath us: OBS may have started or
    // stopped an output while Verger was away, which is exactly the crash re-attach case.
    let wasConnected = this.client.getStatus().state === 'connected'
    subscriptions.push(
      this.client.onStatus((status) => {
        const connected = status.state === 'connected'
        if (connected && !wasConnected) refresh('reconnected')
        wasConnected = connected
      })
    )

    return () => {
      disposed = true
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe()
        } catch {
          /* already gone — a teardown failure must never surface */
        }
      }
      subscriptions.length = 0
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async refreshInto(
    callback: (state: ObsOutputState) => void,
    reason: string,
    isDisposed: () => boolean
  ): Promise<void> {
    const state = await this.readOutputState()
    if (isDisposed()) return
    if (!state.ok) {
      // Not an error worth shouting about: an output event arriving as the socket drops is normal.
      this.log.debug('could not refresh the OBS output state', {
        reason,
        code: state.error.code,
        message: state.error.message
      })
      return
    }
    try {
      callback(state.value)
    } catch (cause) {
      this.log.warn('an OBS output subscriber threw', { reason, cause })
    }
  }

  /**
   * Issue one output request.
   *
   * "Already in the requested state" is mapped to success rather than error — see
   * {@link OutputChange.alreadyInState}.
   */
  private async send(request: OutputRequest): Promise<Result<OutputChange>> {
    const guard = this.requireConnected(`send "${request}" to OBS`)
    if (guard !== null) return guard

    const result = await this.client.call(request)
    if (result.ok) {
      this.log.info('OBS accepted an output request', { request })
      return ok({ request, alreadyInState: false })
    }

    const benign = request.startsWith('Start')
      ? isOutputAlreadyRunning(result.error)
      : isOutputNotRunning(result.error)

    if (benign) {
      this.log.info('OBS was already in the requested output state', { request })
      return ok({ request, alreadyInState: true })
    }
    return result
  }

  /** `null` when connected; otherwise the `NOT_CONNECTED` failure to return, having called nothing. */
  private requireConnected(what: string): Err | null {
    const state = this.client.getStatus().state
    if (state === 'connected') return null
    return err(ErrorCode.NOT_CONNECTED, `cannot ${what} while OBS is disconnected`, state)
  }
}

/** Convenience constructor, so callers need not `new` a class through an options bag. */
export function createObsOutputs(options: ObsOutputsOptions): ObsOutputs {
  return new ObsOutputs(options)
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map `GetStreamStatus` + `GetRecordStatus` responses onto the shared {@link ObsOutputState}.
 *
 * Total and defensive: every field OBS omits, renames or types differently between releases
 * degrades to `null` (or `false` for the booleans, which the contract does not make nullable),
 * never to a throw. An OBS build that answers with `{}` produces a blank-but-valid state.
 */
export function toObsOutputState(streamStatus: unknown, recordStatus: unknown): ObsOutputState {
  const blank = emptyObsOutputState()
  return {
    streaming: readBoolean(streamStatus, 'outputActive') ?? blank.streaming,
    recording: readBoolean(recordStatus, 'outputActive') ?? blank.recording,
    recordingPaused: readBoolean(recordStatus, 'outputPaused') ?? blank.recordingPaused,
    streamReconnecting: readBoolean(streamStatus, 'outputReconnecting') ?? blank.streamReconnecting,
    streamTimecodeMs: readDurationMs(streamStatus),
    recordTimecodeMs: readDurationMs(recordStatus),
    skippedFrames: readNumber(streamStatus, 'outputSkippedFrames'),
    totalFrames: readNumber(streamStatus, 'outputTotalFrames'),
    recordingPath: readString(recordStatus, 'outputPath')
  }
}

/**
 * Parse OBS's `outputTimecode` (`"HH:MM:SS.mmm"`) into milliseconds.
 *
 * Anything unparseable is `null` rather than `NaN` or `0`: a zero would render as "live for
 * 00:00" forever, which reads as a broken stream, whereas `null` renders as "unknown".
 * The hours group and the fractional part are both optional, because the exact formatting has
 * varied across obs-websocket releases.
 */
export function parseTimecodeMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim())
  if (match === null) return null

  const hours = match[1] === undefined ? 0 : Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = match[4] === undefined ? 0 : Number(match[4].padEnd(3, '0'))

  const total = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis
  return Number.isFinite(total) ? total : null
}

/** `outputTimecode` if it parses, else OBS's numeric `outputDuration`, else `null`. */
function readDurationMs(source: unknown): number | null {
  return parseTimecodeMs(readUnknown(source, 'outputTimecode')) ?? readNumber(source, 'outputDuration')
}

/** True when OBS refused a `Start*` because the output was already running. */
export function isOutputAlreadyRunning(error: AppError): boolean {
  return (
    hasObsStatusCode(error, OBS_STATUS_OUTPUT_RUNNING) ||
    /already\s+(?:active|running|started)|outputrunning/i.test(error.message)
  )
}

/** True when OBS refused a `Stop*` because the output was not running in the first place. */
export function isOutputNotRunning(error: AppError): boolean {
  return (
    hasObsStatusCode(error, OBS_STATUS_OUTPUT_NOT_RUNNING) ||
    /not\s+(?:active|running|started)|outputnotrunning/i.test(error.message)
  )
}

/**
 * Whether `error` carries a specific obs-websocket status code.
 *
 * `ObsClient.describeCause` formats it as `"obs-websocket code 500"`; the numeric code is checked
 * rather than the message text wherever possible, because OBS's messages are reworded between
 * releases and are sometimes empty.
 */
function hasObsStatusCode(error: AppError, code: number): boolean {
  return error.detail === `obs-websocket code ${code}`
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function readUnknown(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readBoolean(source: unknown, key: string): boolean | null {
  const value = readUnknown(source, key)
  return typeof value === 'boolean' ? value : null
}

function readNumber(source: unknown, key: string): number | null {
  const value = readUnknown(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(source: unknown, key: string): string | null {
  const value = readUnknown(source, key)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Used when no logger is injected. Never reached in production wiring. */
const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT_LOGGER
}
