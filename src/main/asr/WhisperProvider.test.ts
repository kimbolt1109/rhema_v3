/**
 * Tests for the local faster-whisper adapter.
 *
 * Two layers, deliberately:
 *
 * 1. **Unit tests** that mock `spawn` entirely. They own the parts that are easy to get subtly,
 *    silently wrong and impossible to notice until a Sunday: partial-line JSON reassembly, a
 *    malformed line that must not end the session, restart backoff, the draft/final id contract,
 *    and the "no venv" resting state.
 * 2. **One integration test** that runs the REAL Python sidecar out of `resources/asr-venv`,
 *    guarded on that venv existing so the suite still passes on a machine without it. Mocks prove
 *    the state machine; only a real process proves the protocol.
 *
 * ## Standing Rule 4
 *
 * Every byte of audio in this file is synthesised arithmetically — a sine tone and digital
 * silence. There is no recording here, no fixture on disk, and every piece of transcript text is
 * invented placeholder wording.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ASR_SAMPLE_RATE } from '@shared/asr'
import type { AsrLanguage, TranscriptSegment } from '@shared/asr'
import { ErrorCode } from '@shared/result'

import {
  DEFAULT_WHISPER_RESTART_POLICY,
  LineAssembler,
  WHISPER_DRAFT_MODEL,
  WhisperProvider,
  buildSidecarConfig,
  parseSidecarLine,
  resolveWhisperRuntime,
  whisperRestartDelayMs
} from './WhisperProvider'
import type {
  WhisperChild,
  WhisperProviderStatus,
  WhisperRestartPolicy,
  WhisperSpawn
} from './WhisperProvider'
import type { AsrStartOptions } from './AsrProvider'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void

class FakeStream {
  private readonly listeners: AnyListener[] = []

  on(_event: 'data', listener: (chunk: unknown) => void): unknown {
    this.listeners.push(listener as AnyListener)
    return this
  }

  /** Deliver one chunk exactly as a pipe would — including a half-finished JSON object. */
  push(chunk: string | Uint8Array): void {
    for (const listener of [...this.listeners]) listener(chunk)
  }
}

class FakeStdin {
  readonly writes: Uint8Array[] = []
  ended = false
  /** Flip to false to simulate a full kernel buffer, i.e. backpressure. */
  accepting = true
  private readonly drainListeners: AnyListener[] = []

  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk)
    return this.accepting
  }

  end(): void {
    this.ended = true
  }

  on(event: 'drain' | 'error' | 'close', listener: (payload?: unknown) => void): unknown {
    if (event === 'drain') this.drainListeners.push(listener as AnyListener)
    return this
  }

  drain(): void {
    this.accepting = true
    for (const listener of [...this.drainListeners]) listener()
  }

  /** Everything written so far, as text. The config line is `writes[0]`. */
  text(): string {
    const total = this.writes.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.writes) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(joined)
  }

  /** Bytes written after the config line — i.e. the PCM the provider actually forwarded. */
  audioBytes(): number {
    return this.writes.slice(1).reduce((sum, chunk) => sum + chunk.byteLength, 0)
  }
}

class FakeChild implements WhisperChild {
  readonly pid = 4242
  readonly stdin = new FakeStdin()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  private readonly exitListeners: AnyListener[] = []
  private readonly errorListeners: AnyListener[] = []

  on(event: 'exit' | 'error', listener: (...args: never[]) => void): unknown {
    if (event === 'exit') this.exitListeners.push(listener as AnyListener)
    else this.errorListeners.push(listener as AnyListener)
    return this
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  /** Emit one JSON protocol line, newline included. */
  say(message: Record<string, unknown>): void {
    this.stdout.push(`${JSON.stringify(message)}\n`)
  }

  ready(overrides: Record<string, unknown> = {}): void {
    this.say({
      type: 'ready',
      device: 'cpu',
      computeType: 'int8',
      draftModel: 'tiny',
      finalModel: 'small',
      ...overrides
    })
  }

  exit(code: number | null = 1, signal: string | null = null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }

  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }
}

interface ScheduledTimer {
  readonly delayMs: number
  readonly run: () => void
  cancelled: boolean
}

/** A timer seam whose whole point is that the backoff sequence is inspectable. */
class FakeTimers {
  readonly scheduled: ScheduledTimer[] = []

  readonly set = (callback: () => void, delayMs: number): unknown => {
    const entry: ScheduledTimer = { delayMs, run: callback, cancelled: false }
    this.scheduled.push(entry)
    return entry
  }

  readonly clear = (handle: unknown): void => {
    const entry = this.scheduled.find((candidate) => candidate === handle)
    if (entry !== undefined) entry.cancelled = true
  }

  /** Delays of the timers that were actually allowed to run, in order. */
  get liveDelays(): number[] {
    return this.scheduled.filter((entry) => !entry.cancelled).map((entry) => entry.delayMs)
  }

  /** Fire the most recently scheduled live timer. */
  runLatest(): void {
    for (let index = this.scheduled.length - 1; index >= 0; index -= 1) {
      const entry = this.scheduled[index]
      if (entry !== undefined && !entry.cancelled) {
        entry.cancelled = true
        entry.run()
        return
      }
    }
  }
}

interface Harness {
  readonly provider: WhisperProvider
  readonly children: FakeChild[]
  readonly timers: FakeTimers
  readonly segments: TranscriptSegment[]
  readonly statuses: WhisperProviderStatus[]
  readonly errors: string[]
  readonly spawns: Array<{ command: string; args: readonly string[] }>
  latest(): FakeChild
}

const START_OPTIONS: AsrStartOptions = {
  language: 'ko' as AsrLanguage,
  customVocabulary: ['Placeholder Name', 'Placeholder Church'],
  localModel: 'small',
  deviceId: null
}

function makeHarness(
  options: {
    readonly restartPolicy?: WhisperRestartPolicy
    readonly maxPendingBytes?: number
    readonly configured?: boolean
  } = {}
): Harness {
  const children: FakeChild[] = []
  const spawns: Array<{ command: string; args: readonly string[] }> = []
  const timers = new FakeTimers()
  const segments: TranscriptSegment[] = []
  const statuses: WhisperProviderStatus[] = []
  const errors: string[] = []

  const fakeSpawn: WhisperSpawn = (command, args) => {
    spawns.push({ command, args })
    const child = new FakeChild()
    children.push(child)
    return child
  }

  const provider = new WhisperProvider({
    spawn: fakeSpawn,
    setTimer: timers.set,
    clearTimer: timers.clear,
    now: () => 1_000,
    ...(options.restartPolicy === undefined ? {} : { restartPolicy: options.restartPolicy }),
    ...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
    ...(options.configured === false
      ? { resolvePaths: () => resolveWhisperRuntime(NOTHING_EXISTS) }
      : { paths: { interpreter: '/venv/python', script: '/repo/whisper_sidecar.py' } })
  })

  provider.onSegment((segment) => segments.push(segment))
  provider.onStatus((status) => statuses.push(status))
  provider.onError((error) => errors.push(error.message))

  return {
    provider,
    children,
    timers,
    segments,
    statuses,
    errors,
    spawns,
    latest: () => {
      const child = children[children.length - 1]
      if (child === undefined) throw new Error('no child has been spawned')
      return child
    }
  }
}

const NOTHING_EXISTS = {
  isPackaged: false,
  resourcesPath: '/resources',
  moduleDir: '/repo/out/main',
  exists: () => false
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('resolveWhisperRuntime', () => {
  const posix = (value: string): string => value.replace(/\\/g, '/')

  it('finds the venv and the script two levels above the bundle directory in development', () => {
    const resolved = resolveWhisperRuntime({
      isPackaged: false,
      resourcesPath: '/resources',
      moduleDir: '/repo/out/main',
      platform: 'win32',
      exists: () => true
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(posix(resolved.value.interpreter)).toBe('/repo/resources/asr-venv/Scripts/python.exe')
    expect(posix(resolved.value.script)).toBe('/repo/resources/asr/whisper_sidecar.py')
  })

  it('uses bin/python3 rather than Scripts/python.exe off Windows', () => {
    const resolved = resolveWhisperRuntime({
      isPackaged: false,
      resourcesPath: '/resources',
      moduleDir: '/repo/out/main',
      platform: 'darwin',
      exists: () => true
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(posix(resolved.value.interpreter)).toBe('/repo/resources/asr-venv/bin/python3')
  })

  it('prefers the packaged resources directory when packaged', () => {
    const resolved = resolveWhisperRuntime({
      isPackaged: true,
      resourcesPath: '/app/resources',
      moduleDir: '/app/resources/app.asar/out/main',
      platform: 'win32',
      exists: (path) =>
        posix(path).startsWith('/app/resources/resources/') ||
        posix(path).startsWith('/app/resources/asr')
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(posix(resolved.value.interpreter)).toBe(
      '/app/resources/resources/asr-venv/Scripts/python.exe'
    )
  })

  it('reports NOT_CONFIGURED, naming the path it looked for, when the venv is absent', () => {
    const resolved = resolveWhisperRuntime(NOTHING_EXISTS)

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(resolved.error.detail).toContain('asr-venv')
  })

  it('reports NOT_CONFIGURED when the interpreter exists but the sidecar script does not', () => {
    const resolved = resolveWhisperRuntime({
      isPackaged: false,
      resourcesPath: '/resources',
      moduleDir: '/repo/out/main',
      platform: 'win32',
      exists: (path) => path.includes('asr-venv')
    })

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(resolved.error.message).toContain('sidecar script')
  })
})

// ---------------------------------------------------------------------------
// Line reassembly
// ---------------------------------------------------------------------------

describe('LineAssembler', () => {
  it('returns nothing until a newline arrives, then the whole line', () => {
    const assembler = new LineAssembler()

    expect(assembler.push('{"type":"re')).toEqual([])
    expect(assembler.push('ady"')).toEqual([])
    expect(assembler.push('}\n')).toEqual(['{"type":"ready"}'])
  })

  it('splits several complete lines out of one chunk and keeps the trailing fragment', () => {
    const assembler = new LineAssembler()

    expect(assembler.push('a\nb\nc')).toEqual(['a', 'b'])
    expect(assembler.pendingLength).toBe(1)
    expect(assembler.push('\n')).toEqual(['c'])
  })

  it('tolerates CRLF', () => {
    const assembler = new LineAssembler()
    expect(assembler.push('{"x":1}\r\n')).toEqual(['{"x":1}'])
  })

  it('emits the trailing fragment on flush and nothing when there is none', () => {
    const assembler = new LineAssembler()
    assembler.push('tail')
    expect(assembler.flush()).toEqual(['tail'])
    expect(assembler.flush()).toEqual([])
  })

  it('drops an over-long partial line rather than buffering it forever', () => {
    const assembler = new LineAssembler(16)

    expect(assembler.push('x'.repeat(64))).toEqual([])
    expect(assembler.pendingLength).toBe(0)
    expect(assembler.overflowCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

describe('parseSidecarLine', () => {
  it('parses a ready record', () => {
    const message = parseSidecarLine(
      '{"type":"ready","device":"cuda","computeType":"int8_float16","draftModel":"tiny","finalModel":"small"}'
    )

    expect(message).toEqual({
      kind: 'ready',
      device: 'cuda',
      computeType: 'int8_float16',
      draftModel: 'tiny',
      finalModel: 'small'
    })
  })

  it('parses a segment, clamping a confidence that escaped [0,1]', () => {
    const message = parseSidecarLine(
      '{"type":"segment","id":"w3","text":"placeholder","isFinal":true,"tsStart":10,"tsEnd":20,"confidence":1.4,"isDraft":false}'
    )

    expect(message?.kind).toBe('segment')
    if (message?.kind !== 'segment') return
    expect(message.segment.confidence).toBe(1)
    expect(message.segment.isFinal).toBe(true)
    expect(message.segment.isDraft).toBe(false)
  })

  it.each([
    ['a blank line', ''],
    ['a bare stderr-style warning', 'UserWarning: symlinks are unsupported'],
    ['truncated JSON', '{"type":"segment","id":'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"ready"'],
    ['an object with no type', '{"id":"w1"}'],
    ['a segment with no id', '{"type":"segment","text":"x","tsStart":0,"tsEnd":1}'],
    ['a segment with a non-string text', '{"type":"segment","id":"w1","text":5,"tsStart":0,"tsEnd":1}'],
    ['a segment with no timestamps', '{"type":"segment","id":"w1","text":"x"}'],
    ['an error with no message', '{"type":"error"}']
  ])('returns null for %s', (_label, line) => {
    expect(parseSidecarLine(line)).toBeNull()
  })

  it('surfaces an unknown record type rather than discarding it, for forward compatibility', () => {
    expect(parseSidecarLine('{"type":"selftest","python":"3.14.6"}')).toEqual({
      kind: 'other',
      type: 'selftest'
    })
  })
})

// ---------------------------------------------------------------------------
// Backoff and config
// ---------------------------------------------------------------------------

describe('whisperRestartDelayMs', () => {
  it('doubles per attempt and saturates at maxDelayMs', () => {
    const sequence = Array.from({ length: 8 }, (_unused, attempt) =>
      whisperRestartDelayMs(attempt, DEFAULT_WHISPER_RESTART_POLICY)
    )

    expect(sequence).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000])
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5, 1e308])(
    'produces a finite, non-negative, capped delay for attempt %p',
    (attempt) => {
      const delay = whisperRestartDelayMs(attempt)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(DEFAULT_WHISPER_RESTART_POLICY.maxDelayMs)
    }
  )

  it('never returns NaN when the policy itself is nonsense', () => {
    const delay = whisperRestartDelayMs(3, {
      baseDelayMs: Number.NaN,
      maxDelayMs: Number.NaN,
      maxAttempts: 1,
      healthyAfterMs: 1
    })
    expect(Number.isFinite(delay)).toBe(true)
  })
})

describe('buildSidecarConfig', () => {
  it('pins the draft tier to tiny and takes the final tier from settings', () => {
    const config = buildSidecarConfig(START_OPTIONS)

    expect(config.draftModel).toBe(WHISPER_DRAFT_MODEL)
    expect(config.finalModel).toBe('small')
    expect(config.language).toBe('ko')
    expect(config.draftIntervalMs).toBe(500)
    expect(config.finalIntervalMs).toBe(5_000)
    expect(config.maxUtteranceMs).toBe(30_000)
  })

  it("copies the custom vocabulary rather than aliasing the caller's array", () => {
    const vocabulary = ['Placeholder Name']
    const config = buildSidecarConfig({ ...START_OPTIONS, customVocabulary: vocabulary })
    vocabulary.push('mutated')

    expect(config.customVocabulary).toEqual(['Placeholder Name'])
  })
})

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

describe('WhisperProvider — not configured', () => {
  it('reports not-configured and spawns nothing when there is no venv', async () => {
    const harness = makeHarness({ configured: false })

    expect(harness.provider.isConfigured()).toBe(false)
    expect(harness.provider.getStatus().state).toBe('not-configured')

    const started = await harness.provider.start(START_OPTIONS)

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(harness.spawns).toHaveLength(0)
  })

  it('answers runtimePaths with the reason, so settings can say what is missing', () => {
    const harness = makeHarness({ configured: false })
    const paths = harness.provider.runtimePaths()

    expect(paths.ok).toBe(false)
    if (paths.ok) return
    expect(paths.error.detail).toContain('asr-venv')
  })
})

describe('WhisperProvider — starting', () => {
  it('runs python unbuffered and writes the config line before any audio', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await started

    expect(harness.spawns[0]?.command).toBe('/venv/python')
    // `-u` matters: a buffered Python holds the first kilobytes of the protocol stream and the
    // transcript arrives minutes late.
    expect(harness.spawns[0]?.args).toEqual(['-u', '/repo/whisper_sidecar.py'])

    const firstWrite = harness.latest().stdin.writes[0]
    expect(firstWrite).toBeDefined()
    const config: unknown = JSON.parse(new TextDecoder().decode(firstWrite))
    expect(config).toMatchObject({ draftModel: 'tiny', finalModel: 'small', language: 'ko' })
    // The newline terminator is what lets the sidecar's `readline()` stop before the PCM starts.
    expect(harness.latest().stdin.text().endsWith('\n')).toBe(true)
    expect(harness.latest().stdin.audioBytes()).toBe(0)
  })

  it('resolves start() on ready and reports the device the sidecar actually resolved', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready({ device: 'cpu', computeType: 'int8' })

    await expect(started).resolves.toEqual({ ok: true, value: undefined })
    const status = harness.provider.getStatus()
    expect(status.state).toBe('listening')
    expect(status.device).toBe('cpu')
    expect(status.computeType).toBe('int8')
    expect(status.gapSince).toBeNull()
  })

  it('resolves anyway when ready never arrives, so a model download cannot hang the booth', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)

    // The ready deadline is the only live timer at this point.
    harness.timers.runLatest()

    await expect(started).resolves.toEqual({ ok: true, value: undefined })
    expect(harness.provider.getStatus().state).toBe('starting')
  })

  it('is idempotent — a double tap does not produce two Python processes', async () => {
    const harness = makeHarness()
    const first = harness.provider.start(START_OPTIONS)
    const second = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await Promise.all([first, second])

    expect(harness.spawns).toHaveLength(1)
  })
})

describe('WhisperProvider — protocol handling', () => {
  it('reassembles a JSON object split across three chunks', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.stdout.push('{"type":"segment","id":"w0","text":"partial place')
    expect(harness.segments).toHaveLength(0)

    child.stdout.push('holder","isFinal":false,"tsStart":0,"tsEnd":500,')
    expect(harness.segments).toHaveLength(0)

    child.stdout.push('"confidence":0.5,"isDraft":true}\n')

    expect(harness.segments).toHaveLength(1)
    expect(harness.segments[0]?.text).toBe('partial placeholder')
    expect(harness.segments[0]?.isDraft).toBe(true)
  })

  it('reassembles multibyte text split mid-codepoint across chunks', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    // The sidecar escapes non-ASCII, but a future change must not corrupt Korean transcript, so
    // the decoder is driven in streaming mode and this asserts it.
    const line = `${JSON.stringify({
      type: 'segment',
      id: 'w0',
      text: '한국어 자리 표시',
      isFinal: true,
      tsStart: 0,
      tsEnd: 900,
      confidence: null,
      isDraft: false
    })}\n`
    const bytes = new TextEncoder().encode(line)
    const split = 20

    child.stdout.push(bytes.subarray(0, split))
    child.stdout.push(bytes.subarray(split))

    expect(harness.segments[0]?.text).toBe('한국어 자리 표시')
  })

  it('ignores a malformed line without ending the session', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.stdout.push('UserWarning: huggingface_hub cache-system uses symlinks\n')
    child.stdout.push('{"type":"segment","id":"w0","text":\n')
    child.say({
      type: 'segment',
      id: 'w0',
      text: 'still here',
      isFinal: true,
      tsStart: 0,
      tsEnd: 100,
      confidence: 0.9,
      isDraft: false
    })

    expect(harness.segments).toHaveLength(1)
    expect(harness.segments[0]?.text).toBe('still here')
    expect(harness.provider.getStatus().state).toBe('listening')
    expect(child.killed).toBe(false)
  })

  it('surfaces a sidecar error record on onError without stopping', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say({ type: 'error', message: 'transcription pass failed: placeholder' })

    expect(harness.errors).toHaveLength(1)
    expect(harness.provider.getStatus().lastError).toContain('placeholder')
    expect(harness.provider.getStatus().state).toBe('listening')
  })
})

describe('WhisperProvider — the draft/final contract', () => {
  const draft = (id: string, text: string): Record<string, unknown> => ({
    type: 'segment',
    id,
    text,
    isFinal: false,
    tsStart: 0,
    tsEnd: 500,
    confidence: 0.4,
    isDraft: true
  })
  const final = (id: string, text: string): Record<string, unknown> => ({
    type: 'segment',
    id,
    text,
    isFinal: true,
    tsStart: 0,
    tsEnd: 3000,
    confidence: 0.9,
    isDraft: false
  })

  it('gives the draft and the final that supersedes it the SAME id', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say(draft('w0', 'placeholder par'))
    child.say(draft('w0', 'placeholder partial two'))
    child.say(final('w0', 'placeholder final text'))

    expect(harness.segments).toHaveLength(3)
    const ids = harness.segments.map((segment) => segment.id)
    expect(new Set(ids).size).toBe(1)
    expect(harness.segments.map((segment) => segment.isFinal)).toEqual([false, false, true])
    expect(harness.segments.map((segment) => segment.isDraft)).toEqual([true, true, false])
    expect(harness.segments.every((segment) => segment.provider === 'whisper')).toBe(true)
  })

  it('gives a NEW id to the next span, so a consumer appends rather than overwriting', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say(final('w0', 'first placeholder'))
    child.say(final('w1', 'second placeholder'))

    expect(harness.segments[0]?.id).not.toBe(harness.segments[1]?.id)
  })

  it('prefixes ids with a restart epoch so a respawned sidecar cannot overwrite old transcript', async () => {
    const harness = makeHarness({
      restartPolicy: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 5, healthyAfterMs: 30_000 }
    })
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await started
    harness.latest().say(final('w0', 'before the crash'))

    harness.latest().exit(1, null)
    harness.timers.runLatest()
    harness.latest().ready()
    // The fresh child numbers from zero again — without the epoch this would silently REPLACE
    // the segment the operator already has on screen.
    harness.latest().say(final('w0', 'after the restart'))

    expect(harness.segments).toHaveLength(2)
    expect(harness.segments[0]?.id).not.toBe(harness.segments[1]?.id)
    expect(harness.segments[0]?.text).toBe('before the crash')
    expect(harness.segments[1]?.text).toBe('after the restart')
  })

  it('drops a hallucinated draft silently', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say(draft('w0', 'Thank you for watching'))

    expect(harness.segments).toHaveLength(0)
  })

  it('clears a shown draft with an empty final when the final is a hallucination', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say(draft('w0', 'placeholder partial'))
    child.say(final('w0', 'please subscribe'))

    expect(harness.segments).toHaveLength(2)
    expect(harness.segments[1]?.isFinal).toBe(true)
    expect(harness.segments[1]?.text).toBe('')
    expect(harness.segments[1]?.id).toBe(harness.segments[0]?.id)
  })

  it('drops a hallucinated final outright when no draft was ever shown', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.say(final('w0', '[음악]'))

    expect(harness.segments).toHaveLength(0)
  })
})

describe('WhisperProvider — supervision', () => {
  const fastPolicy: WhisperRestartPolicy = {
    baseDelayMs: 100,
    maxDelayMs: 800,
    maxAttempts: 4,
    healthyAfterMs: 30_000
  }

  it('restarts a dead child with exponential backoff and surfaces the gap', async () => {
    const harness = makeHarness({ restartPolicy: fastPolicy })
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await started

    const restartDelays: number[] = []
    for (let round = 0; round < 3; round += 1) {
      const before = harness.timers.scheduled.length
      harness.latest().exit(1, null)
      const scheduled = harness.timers.scheduled[before]
      expect(scheduled).toBeDefined()
      restartDelays.push(scheduled?.delayMs ?? -1)
      expect(harness.provider.getStatus().state).toBe('restarting')
      expect(harness.provider.getStatus().gapSince).not.toBeNull()
      harness.timers.runLatest()
      harness.latest().ready()
    }

    expect(restartDelays).toEqual([100, 200, 400])
    expect(harness.spawns).toHaveLength(4)
    expect(harness.provider.getStatus().restarts).toBe(3)
    expect(harness.provider.getStatus().state).toBe('listening')
    expect(harness.provider.getStatus().gapSince).toBeNull()
  })

  it('reports the exit on onError so the service can count it toward failover', async () => {
    const harness = makeHarness({ restartPolicy: fastPolicy })
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await started

    harness.latest().exit(3, null)

    expect(harness.errors).toEqual(['the local recogniser stopped unexpectedly'])
  })

  it('gives up and reports failed after maxAttempts consecutive deaths', async () => {
    const harness = makeHarness({
      restartPolicy: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 2, healthyAfterMs: 30_000 }
    })
    const started = harness.provider.start(START_OPTIONS)
    harness.latest().ready()
    await started

    harness.latest().exit(1, null)
    harness.timers.runLatest()
    harness.latest().exit(1, null)
    harness.timers.runLatest()
    harness.latest().exit(1, null)

    expect(harness.provider.getStatus().state).toBe('failed')
    // Three deaths, two restarts, and then it stops thrashing.
    expect(harness.spawns).toHaveLength(3)
  })

  it('does not restart after stop() — a stopped provider stays stopped', async () => {
    const harness = makeHarness({ restartPolicy: fastPolicy })
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    const stopping = harness.provider.stop()
    child.exit(0, null)
    await stopping

    expect(harness.spawns).toHaveLength(1)
    expect(harness.provider.getStatus().state).toBe('idle')
  })
})

describe('WhisperProvider — stopping', () => {
  it('closes stdin so the sidecar flushes, then kills it, and resolves', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    const stopping = harness.provider.stop()
    expect(child.stdin.ended).toBe(true)

    child.exit(0, null)
    const stopped = await stopping

    expect(stopped.ok).toBe(true)
    expect(child.killed).toBe(true)
    expect(harness.provider.getStatus().state).toBe('idle')
  })

  it('kills the child anyway when it refuses to exit within the grace period', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    const stopping = harness.provider.stop()
    // The child never emits `exit`; the grace timer is what has to save us.
    harness.timers.runLatest()
    const stopped = await stopping

    expect(stopped.ok).toBe(true)
    expect(child.killed).toBe(true)
  })

  it('is safe to stop when never started, and safe to stop twice', async () => {
    const harness = makeHarness()

    await expect(harness.provider.stop()).resolves.toEqual({ ok: true, value: undefined })

    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    const first = harness.provider.stop()
    child.exit(0, null)
    await first
    await expect(harness.provider.stop()).resolves.toEqual({ ok: true, value: undefined })
  })

  it('dispose() kills the child, so no orphaned Python process holds the GPU', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    harness.provider.dispose()

    expect(child.killed).toBe(true)
  })
})

describe('WhisperProvider — audio and backpressure', () => {
  const chunk = (bytes: number): Uint8Array => new Uint8Array(bytes).fill(1)

  it('refuses audio when not running rather than buffering it into the void', () => {
    const harness = makeHarness()
    const pushed = harness.provider.pushAudio(chunk(64))

    expect(pushed.ok).toBe(false)
    if (pushed.ok) return
    expect(pushed.error.code).toBe(ErrorCode.NOT_CONNECTED)
  })

  it('forwards audio to the child once it is running', async () => {
    const harness = makeHarness()
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    harness.provider.pushAudio(chunk(320))
    harness.provider.pushAudio(chunk(320))

    expect(child.stdin.audioBytes()).toBe(640)
  })

  it('drops the OLDEST audio when the child stops accepting writes', async () => {
    const harness = makeHarness({ maxPendingBytes: 1_000 })
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.stdin.accepting = false
    // The first write is accepted and returns false, which is what turns the tap off.
    harness.provider.pushAudio(chunk(400))
    for (let index = 0; index < 10; index += 1) harness.provider.pushAudio(chunk(400))

    expect(harness.provider.getStatus().droppedChunks).toBeGreaterThan(0)

    child.stdin.drain()
    // Never more than the cap is held, so a slow final pass costs seconds of audio, not memory.
    expect(child.stdin.audioBytes()).toBeLessThanOrEqual(400 + 1_000 + 400)
  })

  it('resumes writing on drain', async () => {
    const harness = makeHarness({ maxPendingBytes: 10_000 })
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    child.stdin.accepting = false
    harness.provider.pushAudio(chunk(320))
    const beforeDrain = child.stdin.audioBytes()
    harness.provider.pushAudio(chunk(320))
    expect(child.stdin.audioBytes()).toBe(beforeDrain)

    child.stdin.drain()

    expect(child.stdin.audioBytes()).toBe(640)
  })

  it('survives a subscriber that throws', async () => {
    const harness = makeHarness()
    harness.provider.onSegment(() => {
      throw new Error('subscriber bug')
    })
    const started = harness.provider.start(START_OPTIONS)
    const child = harness.latest()
    child.ready()
    await started

    expect(() => {
      child.say({
        type: 'segment',
        id: 'w0',
        text: 'placeholder',
        isFinal: true,
        tsStart: 0,
        tsEnd: 10,
        confidence: null,
        isDraft: false
      })
    }).not.toThrow()
    expect(harness.segments).toHaveLength(1)
  })

  it('never lets a spawn failure escape as an exception', async () => {
    const throwingSpawn: WhisperSpawn = () => {
      throw new Error('ENOENT')
    }
    const timers = new FakeTimers()
    const provider = new WhisperProvider({
      spawn: throwingSpawn,
      setTimer: timers.set,
      clearTimer: timers.clear,
      paths: { interpreter: '/venv/python', script: '/repo/whisper_sidecar.py' }
    })

    const started = await provider.start(START_OPTIONS)

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.detail).toContain('ENOENT')
    provider.dispose()
  })
})

// ---------------------------------------------------------------------------
// Integration — the REAL sidecar, guarded on the venv being present
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VENV_PYTHON = join(
  REPO_ROOT,
  'resources',
  'asr-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'
)
const SIDECAR_SCRIPT = join(REPO_ROOT, 'resources', 'asr', 'whisper_sidecar.py')
const VENV_PRESENT = existsSync(VENV_PYTHON) && existsSync(SIDECAR_SCRIPT)

/**
 * A 440 Hz sine tone, synthesised arithmetically.
 *
 * Standing Rule 4: there is no audio fixture in this repository and there never will be. A tone
 * is not speech, which is also the point — Silero should gate it out, so this test proves the
 * process lifecycle without asserting on any transcript at all.
 */
function sinePcm(durationMs: number): Uint8Array {
  const sampleCount = Math.round((ASR_SAMPLE_RATE * durationMs) / 1000)
  const bytes = new Uint8Array(sampleCount * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(0.25 * 32_767 * Math.sin((2 * Math.PI * 440 * index) / ASR_SAMPLE_RATE))
    view.setInt16(index * 2, value, true)
  }
  return bytes
}

describe('WhisperProvider — real sidecar', () => {
  it.skipIf(!VENV_PRESENT)(
    'runs --selftest in the provisioned venv and exits 0',
    async () => {
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(VENV_PYTHON, ['-u', SIDECAR_SCRIPT, '--selftest'], {
            windowsHide: true
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
          })
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
          })
          child.on('exit', (code) => resolve({ code, stdout, stderr }))
        }
      )

      expect(output.code).toBe(0)
      const message = parseSidecarLine(output.stdout.trim().split('\n')[0] ?? '')
      expect(message?.kind).toBe('other')
      const parsed: unknown = JSON.parse(output.stdout.trim().split('\n')[0] ?? '{}')
      expect(parsed).toMatchObject({ type: 'selftest' })
    },
    120_000
  )

  it.skipIf(!VENV_PRESENT)(
    'starts, reports ready on a real device, accepts PCM and shuts down cleanly',
    async () => {
      const statuses: WhisperProviderStatus[] = []
      const provider = new WhisperProvider({
        paths: { interpreter: VENV_PYTHON, script: SIDECAR_SCRIPT },
        // `tiny` for BOTH tiers: the first run on a fresh machine downloads model weights from
        // HuggingFace, and one 75 MB download is a tolerable cost for a test where 500 MB is not.
        configOverrides: { draftModel: 'tiny', finalModel: 'tiny', finalIntervalMs: 2_000 },
        // Generous, because a cold machine is downloading; a warm one reaches ready in ~3 s.
        readyTimeoutMs: 540_000,
        stopGraceMs: 30_000
      })
      provider.onStatus((status) => statuses.push(status))

      try {
        const started = await provider.start({
          language: 'en',
          customVocabulary: ['Placeholder Name'],
          localModel: 'tiny',
          deviceId: null
        })
        expect(started.ok).toBe(true)

        const ready = provider.getStatus()
        expect(ready.state).toBe('listening')
        expect(['cuda', 'cpu']).toContain(ready.device)
        expect(ready.draftModel).toBe('tiny')

        // Two seconds of tone, in the same 100 ms chunks the renderer sends.
        const tone = sinePcm(2_000)
        const chunkBytes = (ASR_SAMPLE_RATE * 2) / 10
        for (let offset = 0; offset < tone.byteLength; offset += chunkBytes) {
          expect(provider.pushAudio(tone.subarray(offset, offset + chunkBytes)).ok).toBe(true)
        }

        const startedStopAt = Date.now()
        const stopped = await provider.stop()
        const stopTookMs = Date.now() - startedStopAt

        expect(stopped.ok).toBe(true)
        // A clean exit means the child flushed and left of its own accord well inside the grace
        // period — if it had hung, this would be pinned at stopGraceMs.
        expect(stopTookMs).toBeLessThan(30_000)
        expect(provider.getStatus().state).toBe('idle')
        // It exited because we asked it to, not because it crashed and got respawned.
        expect(statuses.some((status) => status.state === 'restarting')).toBe(false)
        expect(provider.getStatus().restarts).toBe(0)
      } finally {
        provider.dispose()
      }
    },
    600_000
  )
})
