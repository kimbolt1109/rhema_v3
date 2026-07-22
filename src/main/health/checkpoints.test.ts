/**
 * `CheckpointStore` behaviour — the CTRL+D rewind, and the promise that it rewinds automation and
 * nothing else.
 *
 * The most important test in this file is "TOUCHES AUTOMATION ONLY". It hands the store spies for
 * `stopStream`, `stopRecord` and `overlay.send`, drives a full record/restore cycle while the
 * broadcast is live, and asserts a zero call count on all three. A second test scans this module's
 * own source for those call sites, so a future edit that adds one fails here rather than on a
 * Sunday morning.
 *
 * Everything runs against hand-written doubles: no OBS, no plan file, no overlay socket.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CheckpointStore, MAX_REWIND_STEPS, firedCueLabel } from '@main/health/checkpoints'
import type { CheckpointCueLike, CheckpointPlanLike } from '@main/health/checkpoints'
import { createNullLogger } from '@main/logging/logger'
import { idleCueEngineState } from '@shared/cue'
import type { CueEngineState, CueSuggestion } from '@shared/cue'
import { MAX_CHECKPOINTS } from '@shared/health'
import { ErrorCode, ok } from '@shared/result'
import type { Result } from '@shared/result'
import type { ScriptureReference } from '@shared/scripture'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A plan whose pointer only ever moves backwards, one cue at a time, exactly like the real one. */
class FakePlan implements CheckpointPlanLike {
  backCalls = 0
  /** When set, `back()` reports success without moving — a plan edited under a checkpoint. */
  stuck = false
  /** When set, `back()` fails outright. */
  failure: Result<unknown> | null = null

  constructor(public position: number) {}

  getPosition(): number {
    return this.position
  }

  back(): Result<unknown> {
    this.backCalls += 1
    if (this.failure !== null) return this.failure
    if (!this.stuck) this.position = Math.max(-1, this.position - 1)
    return ok(undefined)
  }
}

class FakeCue implements CheckpointCueLike {
  private readonly listeners = new Set<(state: CueEngineState) => void>()
  readonly dismissed: string[] = []
  state: CueEngineState = idleCueEngineState()

  getState(): Result<CueEngineState> {
    return ok(this.state)
  }

  onState(callback: (state: CueEngineState) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  dismiss(suggestionId: string): Result<unknown> {
    this.dismissed.push(suggestionId)
    return ok(undefined)
  }

  push(state: CueEngineState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener(state)
  }

  /** Simulate a cue firing: the engine pushes it onto `recent`, newest first. */
  fire(fired: CueSuggestion): void {
    this.push({ ...this.state, recent: [fired, ...this.state.recent] })
  }
}

function suggestion(overrides: Partial<CueSuggestion> = {}): CueSuggestion {
  return {
    id: 's1',
    detector: 'plan',
    cueId: 'cue-welcome',
    reference: null,
    confidence: 0.9,
    why: 'matched "let us begin"',
    at: 1_000,
    canAutoFire: true,
    ...overrides,
  }
}

function reference(overrides: Partial<ScriptureReference> = {}): ScriptureReference {
  return {
    book: 'John',
    spokenBook: '요한복음',
    chapter: 3,
    verse: 16,
    verseEnd: null,
    confidence: 0.9,
    band: 'exact',
    sourceText: 'John three sixteen',
    ...overrides,
  }
}

let clock = 5_000
let ids = 0

function build(position = 4, options: { readonly live?: boolean } = {}) {
  const plan = new FakePlan(position)
  const cue = new FakeCue()
  const overlaySend = vi.fn(() => ok(undefined))
  const stopStream = vi.fn(() => Promise.resolve(ok(undefined)))
  const stopRecord = vi.fn(() => Promise.resolve(ok(undefined)))
  const isLive = vi.fn(() => options.live ?? false)
  const revision = { value: 7 }

  const store = new CheckpointStore({
    plan,
    overlay: { getRevision: () => revision.value, send: overlaySend },
    cue,
    broadcast: { isLive, stopStream, stopRecord },
    logger: createNullLogger(),
    now: () => clock,
    newId: () => {
      ids += 1
      return `cp-${ids}`
    },
  })
  store.start()

  return { store, plan, cue, overlaySend, stopStream, stopRecord, isLive, revision }
}

beforeEach(() => {
  clock = 5_000
  ids = 0
})

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('record', () => {
  it('captures the live plan position and overlay revision', () => {
    const harness = build(3)
    harness.revision.value = 11

    const recorded = harness.store.record({ label: 'before the sermon' })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    expect(recorded.value).toEqual({
      id: 'cp-1',
      at: 5_000,
      planPosition: 3,
      overlayRevision: 11,
      label: 'before the sermon',
    })
  })

  it('auto-records a checkpoint after each fired cue, labelled with the cue', () => {
    const harness = build(0)

    harness.cue.fire(suggestion({ id: 's1', cueId: 'cue-welcome' }))
    harness.cue.fire(suggestion({ id: 's2', cueId: 'cue-hymn-1' }))

    const list = harness.store.list()
    expect(list.ok).toBe(true)
    if (!list.ok) return

    expect(list.value.map((entry) => entry.label)).toEqual([
      'after cue "cue-hymn-1"',
      'after cue "cue-welcome"',
    ])
  })

  it('does not record twice for the same fired cue', () => {
    const harness = build(0)

    harness.cue.fire(suggestion({ id: 's1' }))
    // The engine republishes its state for an unrelated reason (a mode change, say).
    harness.cue.push({ ...harness.cue.state, mode: 'auto' })

    const list = harness.store.list()
    expect(list.ok && list.value).toHaveLength(1)
  })

  it('caps the ring at MAX_CHECKPOINTS, dropping the oldest', () => {
    const harness = build(0)

    for (let index = 0; index < MAX_CHECKPOINTS + 5; index += 1) {
      clock += 1
      harness.store.record({ label: `checkpoint ${index}` })
    }

    const list = harness.store.list()
    expect(list.ok).toBe(true)
    if (!list.ok) return

    expect(list.value).toHaveLength(MAX_CHECKPOINTS)
    // Newest first, and the five oldest are gone.
    expect(list.value[0]?.label).toBe(`checkpoint ${MAX_CHECKPOINTS + 4}`)
    expect(list.value[list.value.length - 1]?.label).toBe('checkpoint 5')
    expect(list.value.some((entry) => entry.label === 'checkpoint 0')).toBe(false)
  })

  it('lists newest first', () => {
    const harness = build(0)
    clock = 1
    harness.store.record({ label: 'first' })
    clock = 2
    harness.store.record({ label: 'second' })

    const list = harness.store.list()
    expect(list.ok && list.value.map((entry) => entry.label)).toEqual(['second', 'first'])
  })
})

describe('firedCueLabel', () => {
  it('names the cue, the reference, or falls back to the detector reason', () => {
    expect(firedCueLabel(suggestion({ cueId: 'cue-hymn-1' }))).toBe('after cue "cue-hymn-1"')
    expect(
      firedCueLabel(suggestion({ cueId: null, detector: 'scripture', reference: reference() })),
    ).toBe('after scripture "John 3:16"')
    expect(
      firedCueLabel(
        suggestion({
          cueId: null,
          reference: null,
          detector: 'hotphrase',
          why: 'heard "let us pray"',
        }),
      ),
    ).toBe('after hotphrase: heard "let us pray"')
  })
})

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

describe('restore', () => {
  it('rewinds the plan pointer one safe step at a time', () => {
    const harness = build(5)
    const target = harness.store.record({ label: 'before the mis-fire' })
    expect(target.ok).toBe(true)
    if (!target.ok) return

    // Two cues then fired on their own and took the pointer with them.
    harness.plan.position = 7

    const restored = harness.store.restore(target.value.id)
    expect(restored.ok).toBe(true)
    expect(harness.plan.getPosition()).toBe(5)
    expect(harness.plan.backCalls).toBe(2)
  })

  it('TOUCHES AUTOMATION ONLY: never stops the stream, the recording, or the overlay', () => {
    const harness = build(6, { live: true })
    harness.cue.push({ ...idleCueEngineState(), pending: suggestion({ id: 'pending-1' }) })

    const recorded = harness.store.record({ label: 'before the mis-fire' })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    harness.plan.position = 9

    const restored = harness.store.restore(recorded.value.id)
    expect(restored.ok).toBe(true)

    // Automation moved…
    expect(harness.plan.getPosition()).toBe(6)
    expect(harness.cue.dismissed).toEqual(['pending-1'])

    // …and the broadcast did not. This is the assertion the whole phase exists for.
    expect(harness.stopStream).not.toHaveBeenCalled()
    expect(harness.stopRecord).not.toHaveBeenCalled()
    expect(harness.overlaySend).not.toHaveBeenCalled()
  })

  it('never moves the pointer forward, because moving forward means firing cues', () => {
    const harness = build(8)
    const recorded = harness.store.record({ label: 'late' })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    // The operator has since stepped back manually; the checkpoint is now ahead of them.
    harness.plan.position = 2

    const restored = harness.store.restore(recorded.value.id)
    expect(restored.ok).toBe(true)
    expect(harness.plan.getPosition()).toBe(2)
    expect(harness.plan.backCalls).toBe(0)
    expect(harness.overlaySend).not.toHaveBeenCalled()
  })

  it('leaves the cue engine alone when there is no pending suggestion to drop', () => {
    const harness = build(3)
    const recorded = harness.store.record({})
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    expect(harness.store.restore(recorded.value.id).ok).toBe(true)
    expect(harness.cue.dismissed).toEqual([])
  })

  it('refuses an unknown id without touching anything', () => {
    const harness = build(3)
    const restored = harness.store.restore('nope')
    expect(restored.ok).toBe(false)
    if (restored.ok) return

    expect(restored.error.code).toBe(ErrorCode.NOT_FOUND)
    expect(harness.plan.backCalls).toBe(0)
    expect(harness.stopStream).not.toHaveBeenCalled()
    expect(harness.stopRecord).not.toHaveBeenCalled()
  })

  it('stops rather than spinning when the pointer will not move', () => {
    const harness = build(9)
    const recorded = harness.store.record({ label: 'target' })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    harness.plan.position = 12
    harness.plan.stuck = true

    const restored = harness.store.restore(recorded.value.id)
    expect(restored.ok).toBe(true)
    expect(harness.plan.backCalls).toBe(1)
    expect(harness.plan.backCalls).toBeLessThan(MAX_REWIND_STEPS)
  })

  it('reports a plan that refuses to step back, and still stops nothing', () => {
    const harness = build(1)
    const recorded = harness.store.record({ label: 'target' })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    harness.plan.position = 4
    harness.plan.failure = { ok: false, error: { code: ErrorCode.INTERNAL, message: 'no plan' } }

    const restored = harness.store.restore(recorded.value.id)
    expect(restored.ok).toBe(false)
    expect(harness.stopStream).not.toHaveBeenCalled()
    expect(harness.stopRecord).not.toHaveBeenCalled()
    expect(harness.overlaySend).not.toHaveBeenCalled()
  })

  it('reads whether the broadcast is live, and only reads it', () => {
    const harness = build(2, { live: true })
    const recorded = harness.store.record({})
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return

    harness.store.restore(recorded.value.id)
    expect(harness.isLive).toHaveBeenCalled()
    expect(harness.stopStream).not.toHaveBeenCalled()
    expect(harness.stopRecord).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('stops auto-recording once disposed, and refuses further work', () => {
    const harness = build(0)
    harness.store.dispose()

    harness.cue.fire(suggestion({ id: 'after-dispose' }))

    expect(harness.store.list().ok).toBe(false)
    expect(harness.store.record({}).ok).toBe(false)
    expect(harness.store.restore('cp-1').ok).toBe(false)
  })

  it('is idempotent to start, and does not double-record a fired cue', () => {
    const harness = build(0)
    expect(harness.store.start().ok).toBe(true)

    harness.cue.fire(suggestion({ id: 's1' }))

    const list = harness.store.list()
    expect(list.ok && list.value).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Structural guarantee
// ---------------------------------------------------------------------------

describe('the source itself', () => {
  it('contains no call to a verb that could stop the broadcast or change the overlay', () => {
    const source = readFileSync(fileURLToPath(new URL('./checkpoints.ts', import.meta.url)), 'utf8')

    // The seams DECLARE these so a test can prove they are unused; what must never appear is a
    // call site. Asserting on the source is crude, and it is also the only check that survives a
    // future refactor by someone who has not read the docblock.
    expect(source).not.toContain('broadcast.stopStream')
    expect(source).not.toContain('broadcast.stopRecord')
    expect(source).not.toContain('overlay.send')
    expect(source).not.toContain('startStream')
    expect(source).not.toContain('startRecord')
    // `advance()` fires cues. A rewind must never reach it.
    expect(source).not.toContain('plan.advance')
  })
})
