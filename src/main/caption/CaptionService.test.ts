/**
 * The caption service's safety suite.
 *
 * Every string fed to the recogniser double in this file is INVENTED (Standing Rule 4). There is no
 * sermon here, no verse text and no lyric — the fixtures are `PLACEHOLDER SPEECH ONE` and friends,
 * and the long-utterance fixture is generated from a counter.
 *
 * What these tests protect:
 *
 *  - captions are OFF until an operator says otherwise, and OFF drops the segment before anything
 *    downstream of it runs;
 *  - `setEnabled(false)` HIDES the layer in the same tick, mid-utterance, exactly once;
 *  - a long utterance can never be rejected by `captionShowPayload` — every command this service
 *    emits is re-parsed by the real protocol schema before it is asserted on;
 *  - a caption command leaves the other three layers referentially unchanged;
 *  - nothing throws: a hostile `send` and a hostile state subscriber both leave the service working.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptSegment } from '@shared/asr'
import type { Unsubscribe } from '@shared/ipc'
import {
  applyOverlayCommand,
  emptyOverlayState,
  overlayCommandSchema
} from '@shared/overlay'
import type { OverlayCommand } from '@shared/overlay'

// The cap, the idle delay and the windowing function are shared, not owned by the service — the
// renderer needs the same state type and may not import from `@main/*`. See the note at the top of
// `CaptionService.ts`. Aliased to the names these tests already read by.
import {
  CAPTION_IDLE_HIDE_MS as DEFAULT_IDLE_HIDE_MS,
  CAPTION_MAX_CHARS as MAX_CAPTION_CHARS,
  windowCaptionText
} from '@shared/caption'
import type { CaptionRuntimeState } from '@shared/caption'

import { CaptionService } from './CaptionService'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A transcript source. `emit` is how a test plays speech into the service. */
class FakeAsr {
  private readonly listeners = new Set<(segment: TranscriptSegment) => void>()
  subscribeCount = 0
  unsubscribeCount = 0
  refuseSubscription = false

  onTranscript(callback: (segment: TranscriptSegment) => void): Unsubscribe {
    if (this.refuseSubscription) throw new Error('no recogniser is attached')
    this.subscribeCount += 1
    this.listeners.add(callback)
    return () => {
      this.unsubscribeCount += 1
      this.listeners.delete(callback)
    }
  }

  emit(segment: TranscriptSegment): void {
    for (const listener of [...this.listeners]) listener(segment)
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

/**
 * The overlay seam.
 *
 * Every command is validated against the REAL `overlayCommandSchema` on the way in, so a payload
 * the protocol would reject — a caption over 400 characters, an empty one — fails here rather than
 * being asserted on happily and refused in production.
 */
class FakeOverlay {
  readonly sent: OverlayCommand[] = []
  throwOnNextSend = false

  send = (command: OverlayCommand): void => {
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false
      throw new Error('the overlay socket is gone')
    }
    const parsed = overlayCommandSchema.safeParse(command)
    if (!parsed.success) {
      throw new Error(`the protocol rejected this command: ${parsed.error.issues[0]?.message ?? ''}`)
    }
    this.sent.push(command)
  }

  names(): string[] {
    return this.sent.map((command) => command.name)
  }

  last(): OverlayCommand | undefined {
    return this.sent[this.sent.length - 1]
  }
}

let clock = 1_000

/** Move the injected clock and the fake timers together — they must never disagree. */
function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'span-1',
    text: 'PLACEHOLDER SPEECH ONE',
    isFinal: true,
    isDraft: false,
    tsStart: 0,
    tsEnd: 1_000,
    confidence: 0.92,
    provider: 'deepgram',
    ...overrides
  }
}

interface Harness {
  readonly service: CaptionService
  readonly asr: FakeAsr
  readonly overlay: FakeOverlay
}

function build(options: { readonly idleHideMs?: number } = {}): Harness {
  const asr = new FakeAsr()
  const overlay = new FakeOverlay()
  const service = new CaptionService({
    asr,
    send: overlay.send,
    now: () => clock,
    ...(options.idleHideMs === undefined ? {} : { idleHideMs: options.idleHideMs })
  })
  service.start()
  return { service, asr, overlay }
}

/** Invented speech, long enough that the protocol would refuse it unwindowed. */
function longUtterance(words = 60): string {
  return Array.from({ length: words }, (_, index) => `PLACEHOLDER WORD ${String(index)}`).join(' ')
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  clock = 1_000
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

describe('captions are off until an operator asks for them', () => {
  it('starts disabled, with drafts off and nothing said', () => {
    const { service } = build()

    expect(service.getState()).toEqual<CaptionRuntimeState>({
      enabled: false,
      showDrafts: false,
      lastText: ''
    })
  })

  it('ignores transcript segments entirely while disabled', () => {
    const { asr, overlay, service } = build()

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH TWO', isFinal: false }))
    advance(DEFAULT_IDLE_HIDE_MS * 2)

    expect(overlay.sent).toEqual([])
    expect(service.getState().lastText).toBe('')
  })

  it('sends nothing when captions are switched on — a stale sentence must not flash back', () => {
    const { overlay, service } = build()

    service.setEnabled(true)

    expect(overlay.sent).toEqual([])
    expect(service.getState().enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

describe('setEnabled(false) is the kill switch', () => {
  it('hides the layer immediately, mid-utterance, in the same tick', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    expect(overlay.names()).toEqual(['caption.show'])

    service.setEnabled(false)

    // No timer was advanced and no further segment arrived: the hide is synchronous.
    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })

  it('sends exactly one hide, however many times it is switched off', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())

    service.setEnabled(false)
    service.setEnabled(false)
    service.setEnabled(false)

    expect(overlay.names().filter((name) => name === 'caption.hide')).toHaveLength(1)
  })

  it('sends nothing at all when it was already disabled', () => {
    const { overlay, service } = build()

    service.setEnabled(false)

    expect(overlay.sent).toEqual([])
  })

  it('drops every later segment, so the layer stays down', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())
    service.setEnabled(false)
    const afterHide = overlay.sent.length

    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH TWO' }))
    asr.emit(segment({ id: 'span-3', text: 'PLACEHOLDER SPEECH THREE' }))
    advance(DEFAULT_IDLE_HIDE_MS * 3)

    expect(overlay.sent).toHaveLength(afterHide)
  })

  it('keeps the last text, so the operator panel can still show what was said', () => {
    const { asr, service } = build()
    service.setEnabled(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))

    service.setEnabled(false)

    expect(service.getState().lastText).toBe('PLACEHOLDER SPEECH ONE')
  })
})

// ---------------------------------------------------------------------------
// Finals and drafts
// ---------------------------------------------------------------------------

describe('what reaches the layer while captions are on', () => {
  it('shows a final as a confirmed caption', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))

    expect(overlay.last()).toEqual({
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH ONE', draft: false }
    })
  })

  it('ignores a partial while drafts are off', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: false, isDraft: true }))

    expect(overlay.sent).toEqual([])
  })

  it('shows a partial as a draft once drafts are opted into', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    service.setShowDrafts(true)

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: false, isDraft: true }))

    expect(overlay.last()).toEqual({
      channel: 'command',
      name: 'caption.show',
      payload: { text: 'PLACEHOLDER SPEECH ONE', draft: true }
    })
  })

  it('treats a draft-model result that claims to be final as a draft', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: true, isDraft: true }))

    expect(overlay.sent).toEqual([])
  })

  it('replaces the caption as a span is refined, rather than accumulating text', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    service.setShowDrafts(true)

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH', isFinal: false, isDraft: true }))
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: true }))

    expect(overlay.sent.map((command) => command.payload)).toEqual([
      { text: 'PLACEHOLDER SPEECH', draft: true },
      { text: 'PLACEHOLDER SPEECH ONE', draft: false }
    ])
    expect(service.getState().lastText).toBe('PLACEHOLDER SPEECH ONE')
  })

  it('hides a draft that is on the layer when drafts are switched back off', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    service.setShowDrafts(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: false, isDraft: true }))

    service.setShowDrafts(false)

    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
    expect(service.getState().showDrafts).toBe(false)
  })

  it('leaves a confirmed final alone when drafts are switched off', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    service.setShowDrafts(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))

    service.setShowDrafts(false)

    expect(overlay.names()).toEqual(['caption.show'])
  })

  it('is idempotent about the draft toggle', () => {
    const { overlay, service } = build()
    service.setEnabled(true)

    service.setShowDrafts(false)
    service.setShowDrafts(false)

    expect(overlay.sent).toEqual([])
  })

  it('hides when a final retracts a partial the recogniser has withdrawn', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    service.setShowDrafts(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE', isFinal: false, isDraft: true }))

    // `AsrService` retracts a filtered hallucination by re-emitting the span with empty text.
    asr.emit(segment({ text: '', isFinal: true }))

    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })

  it('does not send a hide for an empty final when nothing is on the layer', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)

    asr.emit(segment({ text: '   ', isFinal: true }))

    expect(overlay.sent).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

describe('windowing keeps a long utterance inside the protocol', () => {
  it('sends a caption the protocol accepts, however long the speech was', () => {
    const spoken = longUtterance()
    expect(spoken.length).toBeGreaterThan(MAX_CAPTION_CHARS)

    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment({ text: spoken }))

    // FakeOverlay re-parses with the real schema, so arriving here at all proves the payload is
    // acceptable; this asserts the cap explicitly rather than relying on that.
    const command = overlay.last()
    expect(command?.name).toBe('caption.show')
    const text = command?.name === 'caption.show' ? command.payload.text : ''
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS)
  })

  it('keeps the most recent words and starts at a word boundary', () => {
    const spoken = longUtterance()
    const windowed = windowCaptionText(spoken)

    expect(spoken.endsWith(windowed)).toBe(true)
    expect(spoken).toContain(` ${windowed}`)
    expect(windowed.startsWith('PLACEHOLDER')).toBe(true)
    // The boundary cut may drop at most one word, never a large slice of the budget.
    expect(windowed.length).toBeGreaterThan(MAX_CAPTION_CHARS - 40)
  })

  it('collapses the newlines and double spaces recognisers emit', () => {
    expect(windowCaptionText('  PLACEHOLDER  SPEECH\n\nONE  ')).toBe('PLACEHOLDER SPEECH ONE')
  })

  it('falls back to a hard cut for text with no nearby word boundary', () => {
    // Space-free text stands in for Korean, which is written with far fewer spaces than English.
    const spaceless = 'A'.repeat(500)
    const windowed = windowCaptionText(spaceless)

    expect(windowed).toHaveLength(MAX_CAPTION_CHARS)
  })

  it('leaves short speech exactly as it was said', () => {
    expect(windowCaptionText('PLACEHOLDER SPEECH ONE')).toBe('PLACEHOLDER SPEECH ONE')
  })
})

// ---------------------------------------------------------------------------
// The idle deadline
// ---------------------------------------------------------------------------

describe('a stale caption does not sit on the congregation screen', () => {
  it('hides after the idle window with no new speech', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())

    advance(DEFAULT_IDLE_HIDE_MS - 1)
    expect(overlay.names()).toEqual(['caption.show'])

    advance(1)
    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })

  it('hides exactly once, then stays quiet', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())

    advance(DEFAULT_IDLE_HIDE_MS * 5)

    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })

  it('measures the window from the LAST segment, not the first', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())

    advance(4_000)
    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH TWO' }))

    // The deadline armed by the first segment falls here; speech since then must defer the hide.
    advance(2_000)
    expect(overlay.names()).toEqual(['caption.show', 'caption.show'])

    advance(4_000)
    expect(overlay.names()).toEqual(['caption.show', 'caption.show', 'caption.hide'])
  })

  it('honours a configured window', () => {
    const { asr, overlay, service } = build({ idleHideMs: 1_500 })
    service.setEnabled(true)
    asr.emit(segment())

    advance(1_400)
    expect(overlay.names()).toEqual(['caption.show'])

    advance(100)
    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })

  it('does not hide twice when the operator got there first', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())

    service.setEnabled(false)
    advance(DEFAULT_IDLE_HIDE_MS * 2)

    expect(overlay.names().filter((name) => name === 'caption.hide')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Layer independence
// ---------------------------------------------------------------------------

describe('a caption never disturbs another layer', () => {
  it('leaves lowerThird, scripture and slide referentially unchanged', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    advance(DEFAULT_IDLE_HIDE_MS)

    const before = emptyOverlayState()
    let state = before
    for (const command of overlay.sent) state = applyOverlayCommand(state, command)

    expect(overlay.sent.length).toBeGreaterThan(1)
    expect(state.lowerThird).toBe(before.lowerThird)
    expect(state.scripture).toBe(before.scripture)
    expect(state.slide).toBe(before.slide)
    expect(state.caption).toEqual({
      visible: false,
      text: 'PLACEHOLDER SPEECH ONE',
      draft: false
    })
  })
})

// ---------------------------------------------------------------------------
// State subscribers
// ---------------------------------------------------------------------------

describe('state subscribers', () => {
  it('publishes the operator switches and each new caption', () => {
    const { asr, service } = build()
    const seen: CaptionRuntimeState[] = []
    service.onState((state) => seen.push(state))

    service.setEnabled(true)
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    service.setEnabled(false)

    expect(seen).toEqual([
      { enabled: true, showDrafts: false, lastText: '' },
      { enabled: true, showDrafts: false, lastText: 'PLACEHOLDER SPEECH ONE' },
      { enabled: false, showDrafts: false, lastText: 'PLACEHOLDER SPEECH ONE' }
    ])
  })

  it('does not republish when a repeated segment says the same thing', () => {
    const { asr, service } = build()
    service.setEnabled(true)
    const seen: CaptionRuntimeState[] = []
    service.onState((state) => seen.push(state))

    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH ONE' }))

    expect(seen).toHaveLength(1)
  })

  it('stops publishing once unsubscribed', () => {
    const { service } = build()
    const seen: CaptionRuntimeState[] = []
    const unsubscribe = service.onState((state) => seen.push(state))

    service.setEnabled(true)
    unsubscribe()
    service.setEnabled(false)

    expect(seen).toHaveLength(1)
  })

  it('a subscriber that throws stops neither the others nor the service', () => {
    const { asr, overlay, service } = build()
    const seen: CaptionRuntimeState[] = []
    service.onState(() => {
      throw new Error('a renderer bridge blew up')
    })
    service.onState((state) => seen.push(state))

    expect(() => service.setEnabled(true)).not.toThrow()
    asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))

    expect(seen).toHaveLength(2)
    expect(overlay.names()).toEqual(['caption.show'])
    // The kill switch still works after a subscriber misbehaved.
    expect(service.setEnabled(false).ok).toBe(true)
    expect(overlay.names()).toEqual(['caption.show', 'caption.hide'])
  })
})

// ---------------------------------------------------------------------------
// Nothing throws
// ---------------------------------------------------------------------------

describe('nothing crosses the boundary as an exception', () => {
  it('survives an overlay send that throws, and keeps captioning', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)

    overlay.throwOnNextSend = true
    expect(() => {
      asr.emit(segment({ text: 'PLACEHOLDER SPEECH ONE' }))
    }).not.toThrow()

    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH TWO' }))
    expect(overlay.names()).toEqual(['caption.show'])
    expect(service.getState().lastText).toBe('PLACEHOLDER SPEECH TWO')
  })

  it('reports a recogniser it cannot subscribe to instead of throwing', () => {
    const asr = new FakeAsr()
    asr.refuseSubscription = true
    const overlay = new FakeOverlay()
    const service = new CaptionService({ asr, send: overlay.send, now: () => clock })

    const started = service.start()

    expect(started.ok).toBe(false)
    expect(service.getState().enabled).toBe(false)
  })

  it('subscribes once however often start is called', () => {
    const { asr, service } = build()

    expect(service.start().ok).toBe(true)
    expect(service.start().ok).toBe(true)

    expect(asr.subscribeCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('unsubscribes from the transcript and cancels the idle deadline', () => {
    const { asr, overlay, service } = build()
    service.setEnabled(true)
    asr.emit(segment())
    const beforeDispose = overlay.sent.length

    service.dispose()
    advance(DEFAULT_IDLE_HIDE_MS * 2)
    asr.emit(segment({ id: 'span-2', text: 'PLACEHOLDER SPEECH TWO' }))

    expect(asr.unsubscribeCount).toBe(1)
    expect(asr.listenerCount).toBe(0)
    expect(overlay.sent).toHaveLength(beforeDispose)
  })

  it('is idempotent', () => {
    const { asr, service } = build()

    service.dispose()
    expect(() => service.dispose()).not.toThrow()

    expect(asr.unsubscribeCount).toBe(1)
  })

  it('refuses the operator methods afterwards instead of throwing', () => {
    const { service } = build()
    service.dispose()

    const enabled = service.setEnabled(true)
    const drafts = service.setShowDrafts(true)
    const started = service.start()

    expect(enabled.ok).toBe(false)
    expect(drafts.ok).toBe(false)
    expect(started.ok).toBe(false)
  })
})
