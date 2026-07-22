/**
 * The cue engine's safety suite — the most safety-critical tests in the project.
 *
 * Every transcript here is INVENTED (Standing Rule 4). There is no real sermon in this file, no
 * verse text anywhere in it, and the one place resolved scripture text appears it is the literal
 * string `VERSE TEXT PLACEHOLDER`. The detector and resolver are test doubles: they emit
 * REFERENCES and a placeholder, exactly as the real ones must.
 *
 * What these tests are actually protecting:
 *
 *  - `syncToActual()` runs FIRST on every tick, so an operator taking manual control is never
 *    racing a suggestion the engine formed a second ago.
 *  - Nothing can FORCE an auto-fire. `confirmAlways`, a below-threshold confidence and a failed
 *    verse resolution can each block one; nothing compels one.
 *  - Losing plan alignment makes the engine quieter, not stuck: scripture and hot phrases keep
 *    working with no plan at all.
 *  - PANIC halts automation and touches nothing else — no overlay, no stream, no recording.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptSegment } from '@shared/asr'
import { ALIGNMENT_LOST_AFTER, MIN_AUTO_FIRE_GAP_MS, defaultCueEngineSettings } from '@shared/cue'
import type { CueEngineSettings } from '@shared/cue'
import type { Logger } from '@shared/log'
import type { OverlayCommand } from '@shared/overlay'
import type { Cue, ServicePlan } from '@shared/plan'
import { ErrorCode, err, ok } from '@shared/result'
import type { Result } from '@shared/result'
import {
  CONFIDENCE_EXACT,
  CONFIDENCE_FUZZY,
  CONFIDENCE_WEAK,
  formatReference
} from '@shared/scripture'
import type { ResolvedScripture, ScriptureReference } from '@shared/scripture'

import { CueEngine, SUGGESTION_TTL_MS } from './CueEngine'
import type { CuePlanSnapshot } from './CueEngine'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger
}

/**
 * A plan service stand-in.
 *
 * The important part is that IT owns the position, not the engine — `movedByOperator` is how a
 * test simulates a manual advance, a BACK or a click in the cue list.
 */
class FakePlan {
  position = -1
  readonly fired: string[] = []
  failNextFire = false

  constructor(private plan: ServicePlan) {}

  getState(): Result<CuePlanSnapshot> {
    return ok({ plan: this.plan, position: { index: this.position, firedCueIds: [...this.fired] } })
  }

  async fireCue(cueId: string): Promise<Result<unknown>> {
    if (this.failNextFire) {
      this.failNextFire = false
      return err(ErrorCode.NOT_CONNECTED, 'OBS is not connected')
    }
    const index = this.plan.cues.findIndex((cue) => cue.id === cueId)
    if (index < 0) return err(ErrorCode.NOT_FOUND, 'no such cue')
    this.position = index
    this.fired.push(cueId)
    return ok(undefined)
  }

  /** Simulate the operator moving the plan by hand — the whole point of `syncToActual`. */
  movedByOperator(index: number): void {
    this.position = index
  }

  replace(plan: ServicePlan): void {
    this.plan = plan
  }
}

class FakeOverlay {
  readonly sent: OverlayCommand[] = []

  send(command: OverlayCommand): Result<unknown> {
    this.sent.push(command)
    return ok(undefined)
  }
}

/**
 * A deliberately tiny scripture detector double.
 *
 * It recognises three synthetic shapes so the BANDS are exercised end-to-end through the engine:
 * an English reference and a Korean reference at the `exact` band, a mangled book name at the
 * `fuzzy` band, and a vague phrase below `CONFIDENCE_DISCARD` that must vanish silently. The real
 * two-tier detector is another module with its own tests; this one exists to prove what the ENGINE
 * does with what a detector hands it. It emits references only — never text.
 */
class FakeScriptureDetector {
  detect(text: string): readonly ScriptureReference[] {
    const lower = text.toLowerCase()
    const hits: ScriptureReference[] = []

    if (lower.includes('john 3:16')) {
      hits.push(reference('John', 'John', 3, 16, CONFIDENCE_EXACT, 'exact', text))
    }
    if (text.includes('요한복음 3장 16절')) {
      hits.push(reference('John', '요한복음', 3, 16, CONFIDENCE_EXACT, 'exact', text))
    }
    if (lower.includes('romams chapter 8')) {
      hits.push(reference('Romans', 'Romams', 8, null, CONFIDENCE_FUZZY, 'fuzzy', text))
    }
    if (lower.includes('somewhere in the psalms')) {
      hits.push(reference('Psalms', 'the psalms', 1, null, CONFIDENCE_WEAK - 0.1, 'weak', text))
    }
    return hits
  }
}

class FakeResolver {
  resolvable = true
  readonly asked: string[] = []

  async resolve(ref: ScriptureReference): Promise<Result<ResolvedScripture>> {
    this.asked.push(formatReference(ref))
    if (!this.resolvable) {
      return err(ErrorCode.NOT_CONFIGURED, 'no translation is configured')
    }
    return ok({
      reference: ref,
      // Standing Rule 4: a placeholder, never real verse text, anywhere in this repository.
      text: 'VERSE TEXT PLACEHOLDER',
      translation: 'KJV',
      attribution: 'Public domain'
    })
  }
}

function reference(
  book: string,
  spokenBook: string,
  chapter: number,
  verse: number | null,
  confidence: number,
  band: ScriptureReference['band'],
  sourceText: string
): ScriptureReference {
  return { book, spokenBook, chapter, verse, verseEnd: null, confidence, band, sourceText }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WELCOME_ANCHOR = 'good morning and welcome to our service'
const NOTICES_ANCHOR = 'the first thing I want us to see this morning'
const OFFERING_ANCHOR = 'we will now receive our offering together'

function anchoredCue(id: string, anchor: string, options?: Cue['options']): Cue {
  return {
    id,
    type: 'action',
    label: id,
    trigger: { mode: 'anchor', text: anchor },
    payload: { action: 'clear' },
    ...(options === undefined ? {} : { options })
  }
}

function makePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    schemaVersion: 1,
    service: 'Synthetic test service',
    defaultMode: 'assist',
    assetDir: 'assets',
    cues: [
      anchoredCue('welcome', WELCOME_ANCHOR),
      anchoredCue('notices', NOTICES_ANCHOR),
      anchoredCue('offering', OFFERING_ANCHOR),
      {
        id: 'prayer',
        type: 'action',
        label: 'Prayer slide',
        trigger: { mode: 'hotphrase', text: "let's pray" },
        payload: { action: 'clear' }
      }
    ],
    ...overrides
  }
}

let segmentSeq = 0

function finalSegment(text: string): TranscriptSegment {
  segmentSeq += 1
  return {
    id: `seg-${segmentSeq}`,
    text,
    isFinal: true,
    tsStart: 0,
    tsEnd: 0,
    confidence: 0.9,
    provider: 'whisper',
    isDraft: false
  }
}

function draftSegment(text: string): TranscriptSegment {
  return { ...finalSegment(text), isFinal: false, isDraft: true }
}

/** A final with EMPTY text — Phase 7 retracting a hallucination. Not speech. */
function retraction(id: string): TranscriptSegment {
  return {
    id,
    text: '',
    isFinal: true,
    tsStart: 0,
    tsEnd: 0,
    confidence: null,
    provider: 'whisper',
    isDraft: false
  }
}

interface Harness {
  readonly engine: CueEngine
  readonly plan: FakePlan
  readonly overlay: FakeOverlay
  readonly detector: FakeScriptureDetector
  readonly resolver: FakeResolver
  readonly clock: { value: number }
  say(text: string): Promise<void>
}

function build(
  settings: Partial<CueEngineSettings> = {},
  planOverrides: Partial<ServicePlan> = {}
): Harness {
  const plan = new FakePlan(makePlan(planOverrides))
  const overlay = new FakeOverlay()
  const detector = new FakeScriptureDetector()
  const resolver = new FakeResolver()
  const clock = { value: 1_000_000 }

  const engine = new CueEngine({
    plan,
    overlay,
    logger: silentLogger,
    scripture: detector,
    resolver,
    now: () => clock.value,
    settings: { ...defaultCueEngineSettings(), ...settings }
  })

  return {
    engine,
    plan,
    overlay,
    detector,
    resolver,
    clock,
    say: async (text: string) => {
      await engine.onTranscript(finalSegment(text))
    }
  }
}

beforeEach(() => {
  segmentSeq = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. Human always wins — syncToActual runs first
// ---------------------------------------------------------------------------

describe('syncToActual runs first on every tick', () => {
  it('drops a pending suggestion when the operator moved the plan by hand', async () => {
    const h = build()

    await h.say(`${WELCOME_ANCHOR} today`)
    const pending = h.engine.getState()
    expect(pending.ok && pending.value.pending?.cueId).toBe('welcome')

    // The operator advances the plan themselves, mid-suggestion.
    h.plan.movedByOperator(1)

    await h.say('and now some words that match nothing at all in this plan')

    const after = h.engine.getState()
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.pending).toBeNull()
    expect(after.value.position).toBe(1)
  })

  it('re-syncs even on a draft, before the draft is discarded', async () => {
    const h = build()

    await h.say(`${WELCOME_ANCHOR} today`)
    expect(h.engine.getState()).toMatchObject({ value: { pending: { cueId: 'welcome' } } })

    h.plan.movedByOperator(2)
    await h.engine.onTranscript(draftSegment('a partial that should drive nothing'))

    const after = h.engine.getState()
    expect(after.ok && after.value.pending).toBeNull()
    expect(after.ok && after.value.position).toBe(2)
  })

  it('confirming a suggestion the operator has already overtaken is a harmless no-op', async () => {
    const h = build()
    await h.say(`${WELCOME_ANCHOR} today`)
    const state = h.engine.getState()
    const id = state.ok ? (state.value.pending?.id ?? '') : ''

    h.plan.movedByOperator(1)
    await h.say('unrelated speech about nothing in particular')

    const confirmed = await h.engine.confirm(id)
    expect(confirmed.ok).toBe(true)
    expect(h.plan.fired).toEqual([])
  })

  it('lifts alignment back out of "lost" when the operator moves the plan', async () => {
    const h = build()
    for (let index = 0; index < ALIGNMENT_LOST_AFTER; index += 1) {
      await h.say(`a completely unrelated sentence number ${index} about rivers and boats`)
    }
    expect(h.engine.getState()).toMatchObject({ value: { alignment: 'lost' } })

    h.plan.movedByOperator(1)
    await h.engine.onTranscript(draftSegment('anything'))
    expect(h.engine.getState()).toMatchObject({ value: { alignment: 'aligned' } })
  })
})

// ---------------------------------------------------------------------------
// 2. Scripture, end to end through the engine
// ---------------------------------------------------------------------------

describe('the scripture detector', () => {
  it('surfaces an English reference at the exact band', async () => {
    const h = build({ scriptureAutoShow: false })
    await h.say('please turn with me to John 3:16 this morning')

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.value.pending?.detector).toBe('scripture')
    expect(state.value.pending?.reference?.band).toBe('exact')
    expect(state.value.pending?.reference?.book).toBe('John')
    expect(state.value.pending?.confidence).toBe(CONFIDENCE_EXACT)
  })

  it('surfaces a Korean reference at the exact band, keeping the spoken book name', async () => {
    const h = build()
    await h.say('오늘 받으실 말씀은 요한복음 3장 16절 입니다')

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.value.pending?.reference?.spokenBook).toBe('요한복음')
    expect(state.value.pending?.reference?.book).toBe('John')
    expect(state.value.pending?.reference?.band).toBe('exact')
  })

  it('surfaces a mangled book name at the fuzzy band', async () => {
    const h = build()
    await h.say('we are in romams chapter 8 again')

    const state = h.engine.getState()
    expect(state.ok && state.value.pending?.reference?.band).toBe('fuzzy')
    expect(state.ok && state.value.pending?.confidence).toBe(CONFIDENCE_FUZZY)
  })

  it('discards anything below the discard floor in silence', async () => {
    const h = build()
    await h.say('it is somewhere in the psalms I think')

    const state = h.engine.getState()
    expect(state.ok && state.value.pending).toBeNull()
  })

  it('resolves verse text at runtime and never carries it in a reference', async () => {
    const h = build({ scriptureAutoShow: true, mode: 'assist' })
    await h.say('turn to John 3:16')

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok || state.value.pending === null) throw new Error('expected a suggestion')
    // The suggestion carries the reference. Text lives only in the resolver's answer.
    expect(Object.keys(state.value.pending.reference ?? {})).not.toContain('text')

    await h.engine.confirm(state.value.pending.id)
    expect(h.overlay.sent).toHaveLength(1)
    expect(h.overlay.sent[0]).toMatchObject({
      name: 'scripture.show',
      payload: { reference: 'John 3:16', text: 'VERSE TEXT PLACEHOLDER' }
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Hot phrases
// ---------------------------------------------------------------------------

describe('the hot-phrase detector', () => {
  const hotPhrases = [{ id: 'hp-pray', phrase: "let's pray", cueId: 'prayer', enabled: true }]

  it('suggests in assist mode and applies nothing', async () => {
    const h = build({ hotPhrases })
    await h.say("and so, let's pray together now")

    const state = h.engine.getState()
    expect(state.ok && state.value.pending?.detector).toBe('hotphrase')
    expect(state.ok && state.value.pending?.cueId).toBe('prayer')
    expect(h.plan.fired).toEqual([])
  })

  it('fires in auto mode', async () => {
    const h = build({ hotPhrases, mode: 'auto' })
    await h.say("and so, let's pray together now")

    expect(h.plan.fired).toEqual(['prayer'])
    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
  })

  it('matches a Korean phrase regardless of the recogniser inserting spaces', async () => {
    const h = build({
      hotPhrases: [{ id: 'hp-ko', phrase: '받으실 말씀은', cueId: 'prayer', enabled: true }],
      mode: 'auto'
    })
    await h.say('오늘 받으실말씀은 다음과 같습니다')
    expect(h.plan.fired).toEqual(['prayer'])
  })

  it('ignores a disabled phrase', async () => {
    const h = build({ hotPhrases: [{ ...hotPhrases[0]!, enabled: false }] })
    await h.say("let's pray")
    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
  })

  it('ignores a phrase pointing at a cue that is not in this plan', async () => {
    const h = build({
      hotPhrases: [{ id: 'hp-x', phrase: "let's pray", cueId: 'not-here', enabled: true }]
    })
    await h.say("let's pray")
    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
    expect(h.plan.fired).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. The plan-follower
// ---------------------------------------------------------------------------

describe('the plan-follower', () => {
  it('suggests in assist mode and applies nothing until the operator confirms', async () => {
    const h = build()
    await h.say(`${WELCOME_ANCHOR} today, it is lovely to see you`)

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok || state.value.pending === null) throw new Error('expected a suggestion')
    expect(state.value.pending.detector).toBe('plan')
    expect(state.value.pending.cueId).toBe('welcome')
    expect(h.plan.fired).toEqual([])

    await h.engine.confirm(state.value.pending.id)
    expect(h.plan.fired).toEqual(['welcome'])
    expect(h.engine.getState()).toMatchObject({ value: { pending: null, position: 0 } })
  })

  it('applies by itself in auto mode and adopts the position the plan reports', async () => {
    const h = build({ mode: 'auto' })
    await h.say(`${WELCOME_ANCHOR} today`)

    expect(h.plan.fired).toEqual(['welcome'])
    expect(h.engine.getState()).toMatchObject({ value: { position: 0, pending: null } })
  })

  it('suggests but never applies in manual mode', async () => {
    const h = build({ mode: 'manual' })
    await h.say(`${WELCOME_ANCHOR} today`)

    const state = h.engine.getState()
    expect(state.ok && state.value.pending?.cueId).toBe('welcome')
    expect(h.plan.fired).toEqual([])

    // The operator can still confirm — manual means the engine will not act, not that it is deaf.
    const id = state.ok ? (state.value.pending?.id ?? '') : ''
    await h.engine.confirm(id)
    expect(h.plan.fired).toEqual(['welcome'])
  })

  it('reports no-plan when nothing in the plan carries an anchor', async () => {
    const h = build(
      {},
      {
        cues: [
          {
            id: 'only',
            type: 'action',
            label: 'Only',
            trigger: { mode: 'manual' },
            payload: { action: 'clear' }
          }
        ]
      }
    )
    await h.say('anything at all')
    expect(h.engine.getState()).toMatchObject({ value: { alignment: 'no-plan' } })
  })

  it('only looks a few cues ahead, so it cannot leap across the service', async () => {
    const h = build({ mode: 'auto' })
    // The 4th anchored cue is outside the look-ahead window from position -1.
    h.plan.replace(
      makePlan({
        cues: [
          anchoredCue('a', 'first anchored cue phrase here'),
          anchoredCue('b', 'second anchored cue phrase here'),
          anchoredCue('c', 'third anchored cue phrase here'),
          anchoredCue('d', 'the closing hymn we sing at the very end of the service')
        ]
      })
    )
    await h.say('the closing hymn we sing at the very end of the service')
    expect(h.plan.fired).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Manual override always wins, even in auto
// ---------------------------------------------------------------------------

describe('manual override in auto mode', () => {
  it('is honoured, and the engine does not fight it back', async () => {
    // `confirmAlways` keeps a suggestion pending in auto mode so there is something to overtake.
    const h = build({ mode: 'auto' }, {
      cues: [
        anchoredCue('welcome', WELCOME_ANCHOR, { confirmAlways: true }),
        anchoredCue('notices', NOTICES_ANCHOR, { confirmAlways: true }),
        anchoredCue('offering', OFFERING_ANCHOR, { confirmAlways: true })
      ]
    })

    await h.say(`${WELCOME_ANCHOR} today`)
    expect(h.engine.getState()).toMatchObject({ value: { pending: { cueId: 'welcome' } } })
    expect(h.plan.fired).toEqual([])

    // The operator takes over and advances past it themselves.
    h.plan.movedByOperator(1)

    await h.say(`${WELCOME_ANCHOR} today`)

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.value.position).toBe(1)
    // The engine never re-fired the cue the operator walked past.
    expect(h.plan.fired).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. Going off-script — "it degrades well"
// ---------------------------------------------------------------------------

describe('when the speaker goes off-script', () => {
  const hotPhrases = [{ id: 'hp-pray', phrase: "let's pray", cueId: 'prayer', enabled: true }]

  it('loses alignment after the miss budget, stops suggesting from the plan, and keeps the other two detectors working', async () => {
    const h = build({ hotPhrases, mode: 'assist' })

    for (let index = 0; index < ALIGNMENT_LOST_AFTER; index += 1) {
      await h.say(`a story about a man and his two sons, part ${index}, told at some length`)
      h.clock.value += 1_000
    }

    let state = h.engine.getState()
    expect(state.ok && state.value.alignment).toBe('lost')
    expect(state.ok && state.value.pending).toBeNull()

    // The plan-follower is now silent even when the anchor is spoken verbatim.
    await h.say(`${WELCOME_ANCHOR} today`)
    state = h.engine.getState()
    expect(state.ok && state.value.alignment).toBe('lost')
    expect(state.ok && state.value.pending).toBeNull()
    expect(h.plan.fired).toEqual([])

    // Hot phrases still work — they need no plan alignment at all.
    await h.say("and now, let's pray together")
    state = h.engine.getState()
    expect(state.ok && state.value.pending?.detector).toBe('hotphrase')

    const hotId = state.ok ? (state.value.pending?.id ?? '') : ''
    h.engine.dismiss(hotId)

    // And so does scripture.
    await h.say('turn with me to John 3:16')
    state = h.engine.getState()
    expect(state.ok && state.value.pending?.detector).toBe('scripture')
    expect(state.ok && state.value.alignment).toBe('lost')
  })

  it('does not count a retraction as a miss', async () => {
    const h = build()
    const segment = finalSegment('a sentence that matches nothing whatsoever in the plan')
    await h.engine.onTranscript(segment)
    await h.engine.onTranscript(retraction(segment.id))
    await h.engine.onTranscript(retraction('some-other-id'))

    // One real miss only; nowhere near the budget.
    expect(h.engine.getState()).toMatchObject({ value: { alignment: 'aligned' } })
  })

  it('ignores drafts entirely for detection', async () => {
    const h = build({ mode: 'auto' })
    await h.engine.onTranscript(draftSegment(`${WELCOME_ANCHOR} today`))
    expect(h.plan.fired).toEqual([])
    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
  })
})

// ---------------------------------------------------------------------------
// 7. Nothing can force an auto-fire
// ---------------------------------------------------------------------------

describe('the auto-fire gates', () => {
  it('never fires below the configured threshold', async () => {
    const h = build({ mode: 'auto', autoFireThreshold: 0.99 })
    // A dropped word puts the score above the anchor threshold but below the auto threshold.
    await h.say('good morning and welcome to service')

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok || state.value.pending === null) throw new Error('expected a suggestion')
    expect(state.value.pending.confidence).toBeLessThan(0.99)
    expect(state.value.pending.canAutoFire).toBe(false)
    expect(h.plan.fired).toEqual([])
  })

  it('honours a per-cue threshold that is stricter than the service default', async () => {
    const h = build({ mode: 'auto', autoFireThreshold: 0.5 }, {
      cues: [anchoredCue('welcome', WELCOME_ANCHOR, { autoFireThreshold: 0.999 })]
    })
    await h.say('good morning and welcome to service')
    expect(h.plan.fired).toEqual([])
    expect(h.engine.getState()).toMatchObject({ value: { pending: { canAutoFire: false } } })
  })

  it('lets confirmAlways block an auto-fire even at confidence 1.0', async () => {
    const h = build({ mode: 'auto', autoFireThreshold: 0 }, {
      cues: [anchoredCue('welcome', WELCOME_ANCHOR, { confirmAlways: true })]
    })
    await h.say(WELCOME_ANCHOR)

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok || state.value.pending === null) throw new Error('expected a suggestion')
    expect(state.value.pending.confidence).toBe(1)
    expect(state.value.pending.canAutoFire).toBe(false)
    expect(h.plan.fired).toEqual([])

    // It is still confirmable by a human — safer, never unusable.
    await h.engine.confirm(state.value.pending.id)
    expect(h.plan.fired).toEqual(['welcome'])
  })

  it('does not auto-show a confident reference whose text failed to resolve', async () => {
    const h = build({ mode: 'auto', scriptureAutoShow: true })
    h.resolver.resolvable = false

    await h.say('turn with me to John 3:16')

    const state = h.engine.getState()
    expect(state.ok).toBe(true)
    if (!state.ok || state.value.pending === null) throw new Error('expected a suggestion')
    expect(state.value.pending.reference?.band).toBe('exact')
    expect(state.value.pending.canAutoFire).toBe(false)
    // Nothing reached the congregation screen. An empty scripture card is worse than nothing.
    expect(h.overlay.sent).toEqual([])
  })

  it('does auto-show once the text has actually resolved', async () => {
    const h = build({ mode: 'auto', scriptureAutoShow: true })
    await h.say('turn with me to John 3:16')

    expect(h.overlay.sent).toHaveLength(1)
    expect(h.overlay.sent[0]).toMatchObject({
      name: 'scripture.show',
      payload: { reference: 'John 3:16', text: 'VERSE TEXT PLACEHOLDER', attribution: 'Public domain' }
    })
  })

  it('never auto-shows scripture while the operator has scriptureAutoShow off', async () => {
    const h = build({ mode: 'auto', scriptureAutoShow: false })
    await h.say('turn with me to John 3:16')

    expect(h.overlay.sent).toEqual([])
    expect(h.engine.getState()).toMatchObject({ value: { pending: { canAutoFire: false } } })
  })

  it('respects the minimum gap between auto-fires across a burst', async () => {
    const h = build({ mode: 'auto' })

    await h.say(WELCOME_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome'])

    // Half a second later — well inside the dwell floor.
    h.clock.value += 500
    await h.say(NOTICES_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome'])
    expect(h.engine.getState()).toMatchObject({ value: { pending: { cueId: 'notices' } } })

    // Past the floor, the held suggestion is allowed through.
    h.clock.value += MIN_AUTO_FIRE_GAP_MS + 1
    await h.say(NOTICES_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome', 'notices'])
  })
})

// ---------------------------------------------------------------------------
// 8. One pending suggestion at a time
// ---------------------------------------------------------------------------

describe('the single-pending rule', () => {
  it('replaces a pending suggestion only with a strictly better one', async () => {
    const h = build({ mode: 'assist', autoFireThreshold: 1 })

    // A weaker plan match first.
    await h.say('good morning and welcome to service')
    const first = h.engine.getState()
    const firstId = first.ok ? (first.value.pending?.id ?? '') : ''
    const firstConfidence = first.ok ? (first.value.pending?.confidence ?? 0) : 0
    expect(firstConfidence).toBeLessThan(1)

    // A verbatim match scores higher and takes over.
    await h.say(WELCOME_ANCHOR)
    const second = h.engine.getState()
    expect(second.ok && second.value.pending?.id).not.toBe(firstId)
    expect(second.ok && (second.value.pending?.confidence ?? 0)).toBeGreaterThan(firstConfidence)

    // An equal-or-lower one does not thrash the operator's decision.
    const secondId = second.ok ? (second.value.pending?.id ?? '') : ''
    await h.say(WELCOME_ANCHOR)
    expect(h.engine.getState()).toMatchObject({ value: { pending: { id: secondId } } })
  })

  it('treats a dismiss for a stale id as a no-op, not an error', async () => {
    const h = build()
    await h.say(WELCOME_ANCHOR)
    const dismissed = h.engine.dismiss('cue-does-not-exist')
    expect(dismissed.ok).toBe(true)
    expect(h.engine.getState()).toMatchObject({ value: { pending: { cueId: 'welcome' } } })
  })

  it('drops a suggestion that has sat unconfirmed for too long', async () => {
    const h = build()
    await h.say(WELCOME_ANCHOR)
    expect(h.engine.getState()).toMatchObject({ value: { pending: { cueId: 'welcome' } } })

    vi.advanceTimersByTime(SUGGESTION_TTL_MS + 1)

    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
    // Expiry only ever makes the engine quieter. It fires nothing.
    expect(h.plan.fired).toEqual([])
    expect(h.overlay.sent).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9. PANIC
// ---------------------------------------------------------------------------

describe('panic', () => {
  it('halts automation and issues no overlay, stream or recording command', async () => {
    const h = build({ mode: 'auto' })

    await h.say(WELCOME_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome'])

    const panicked = h.engine.panic()
    expect(panicked.ok).toBe(true)
    if (!panicked.ok) return
    expect(panicked.value.panicked).toBe(true)
    expect(panicked.value.mode).toBe('manual')
    expect(panicked.value.pending).toBeNull()

    // NOTHING was sent anywhere. PANIC silences the AI; it does not touch the output.
    expect(h.overlay.sent).toEqual([])

    h.clock.value += 10_000
    await h.say(NOTICES_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome'])
    expect(h.engine.getState()).toMatchObject({ value: { pending: null, panicked: true } })
  })

  it('does not re-enable itself — resume is explicit', async () => {
    const h = build({ mode: 'auto' })
    h.engine.panic()

    // Even setting the mode back to auto does not lift the panic.
    const remoded = h.engine.setMode('auto')
    expect(remoded.ok && remoded.value.panicked).toBe(true)
    expect(remoded.ok && remoded.value.mode).toBe('manual')

    h.clock.value += 10_000
    await h.say(WELCOME_ANCHOR)
    expect(h.plan.fired).toEqual([])

    const resumed = h.engine.resume()
    expect(resumed.ok && resumed.value.panicked).toBe(false)
    expect(resumed.ok && resumed.value.mode).toBe('auto')

    h.clock.value += 10_000
    await h.say(WELCOME_ANCHOR)
    expect(h.plan.fired).toEqual(['welcome'])
  })

  it('keeps settings changes pending until resume', async () => {
    const h = build({ mode: 'auto' })
    h.engine.panic()

    const applied = h.engine.setSettings({ ...defaultCueEngineSettings(), mode: 'auto' })
    expect(applied.ok).toBe(true)
    expect(h.engine.getState()).toMatchObject({ value: { mode: 'manual', panicked: true } })

    const resumed = h.engine.resume()
    expect(resumed.ok && resumed.value.mode).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// 10. Failures never escape as exceptions
// ---------------------------------------------------------------------------

describe('failure handling', () => {
  it('returns an Err rather than throwing when the plan refuses a fire', async () => {
    const h = build()
    await h.say(WELCOME_ANCHOR)
    const state = h.engine.getState()
    const id = state.ok ? (state.value.pending?.id ?? '') : ''

    h.plan.failNextFire = true
    const confirmed = await h.engine.confirm(id)
    expect(confirmed.ok).toBe(false)
    // The suggestion is cleared either way — leaving a dead one on screen would be worse.
    expect(h.engine.getState()).toMatchObject({ value: { pending: null } })
    expect(h.engine.getState()).toMatchObject({ value: { lastError: 'OBS is not connected' } })
  })

  it('survives a scripture detector that throws', async () => {
    const h = build()
    ;(h.detector as unknown as { detect: () => never }).detect = () => {
      throw new Error('detector exploded')
    }
    const result = await h.engine.onTranscript(finalSegment(WELCOME_ANCHOR))
    expect(result.ok).toBe(true)
    // The other detectors carried on regardless.
    expect(h.engine.getState()).toMatchObject({ value: { pending: { detector: 'plan' } } })
  })

  it('refuses invalid settings without changing anything', () => {
    const h = build()
    const bad = h.engine.setSettings({
      ...defaultCueEngineSettings(),
      autoFireThreshold: 5
    })
    expect(bad.ok).toBe(false)
    expect(h.engine.getSettings()).toMatchObject({ value: { autoFireThreshold: 0.85 } })
  })

  it('reports an Err from every entry point once disposed', async () => {
    const h = build()
    h.engine.dispose()
    expect((await h.engine.onTranscript(finalSegment(WELCOME_ANCHOR))).ok).toBe(false)
    expect((await h.engine.confirm('cue-1')).ok).toBe(false)
    expect(h.engine.dismiss('cue-1').ok).toBe(false)
    expect(h.engine.panic().ok).toBe(false)
  })
})
