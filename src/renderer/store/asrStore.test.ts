/**
 * The ASR store's contract.
 *
 * The centrepiece is the **draft/final replacement rule**, because getting it wrong is what makes a
 * transcript flicker gibberish: partials for one span of speech share an `id` and must replace one
 * another in place, a final supersedes them, and a late partial must never rewind a settled line.
 * Everything else here is the usual Verger discipline — nothing throws without a bridge, a refusal
 * never blanks the mirrored status, and the rolling buffer is bounded so a 90-minute service does
 * not grow without limit.
 *
 * All transcript text is invented placeholder wording (Standing Rule 4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TranscriptSegment } from '@shared/asr'
import { defaultAsrSettings } from '@shared/asr'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_AUDIO_INPUTS,
  installMockVergerApi,
  mockDegradedAsrStatus,
  mockDraftSegment,
  mockFailedAsrStatus,
  mockIdleAsrStatus,
  mockListeningAsrStatus,
  mockNotConfiguredAsrStatus,
  mockTranscriptSegment,
} from '../test/mockVergerApi'
import {
  ASR_BRIDGE_UNAVAILABLE_MESSAGE,
  TRANSCRIPT_BUFFER_LIMIT,
  isRunningManual,
  isTranscribing,
  mergeSegment,
  resetAsrStore,
  useAsrStore,
} from './asrStore'

function segment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return mockTranscriptSegment(overrides)
}

describe('mergeSegment', () => {
  it('appends a segment with a new id', () => {
    const first = segment({ id: 'a', text: 'PLACEHOLDER ONE' })
    const second = segment({ id: 'b', text: 'PLACEHOLDER TWO' })
    expect(mergeSegment(mergeSegment([], first), second).map((entry) => entry.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('REPLACES a partial with the next partial for the same id, never appending', () => {
    const one = segment({ id: 'span-1', text: 'PLACEHOLDER', isFinal: false })
    const two = segment({ id: 'span-1', text: 'PLACEHOLDER TEXT', isFinal: false })
    const three = segment({ id: 'span-1', text: 'PLACEHOLDER TEXT HERE', isFinal: false })

    const merged = [one, two, three].reduce<readonly TranscriptSegment[]>(
      (segments, next) => mergeSegment(segments, next),
      [],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('PLACEHOLDER TEXT HERE')
    expect(merged[0]?.isFinal).toBe(false)
  })

  it('lets a final supersede the partials that preceded it', () => {
    const draft = mockDraftSegment({ id: 'span-1', text: 'PLACEHOLDER DRAFT' })
    const settled = segment({ id: 'span-1', text: 'PLACEHOLDER FINAL', isFinal: true })

    const merged = mergeSegment(mergeSegment([], draft), settled)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('PLACEHOLDER FINAL')
    expect(merged[0]?.isFinal).toBe(true)
    expect(merged[0]?.isDraft).toBe(false)
  })

  it('never un-finalises a settled line with a late partial', () => {
    const settled = segment({ id: 'span-1', text: 'PLACEHOLDER FINAL', isFinal: true })
    const late = segment({ id: 'span-1', text: 'PLACEHOLDER WORSE GUESS', isFinal: false })

    const merged = mergeSegment(mergeSegment([], settled), late)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('PLACEHOLDER FINAL')
    expect(merged[0]?.isFinal).toBe(true)
  })

  it('replaces in place rather than moving a refined span to the end', () => {
    const first = segment({ id: 'a', text: 'PLACEHOLDER ONE', isFinal: false })
    const second = segment({ id: 'b', text: 'PLACEHOLDER TWO', isFinal: false })
    const refinedFirst = segment({ id: 'a', text: 'PLACEHOLDER ONE REFINED', isFinal: true })

    const merged = [first, second, refinedFirst].reduce<readonly TranscriptSegment[]>(
      (segments, next) => mergeSegment(segments, next),
      [],
    )

    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(merged[0]?.text).toBe('PLACEHOLDER ONE REFINED')
  })

  it('caps the buffer, dropping the oldest segments', () => {
    let segments: readonly TranscriptSegment[] = []
    for (let index = 0; index < TRANSCRIPT_BUFFER_LIMIT + 50; index += 1) {
      segments = mergeSegment(
        segments,
        segment({ id: `seg-${String(index)}`, text: `PLACEHOLDER ${String(index)}` }),
      )
    }

    expect(segments).toHaveLength(TRANSCRIPT_BUFFER_LIMIT)
    expect(segments[0]?.id).toBe('seg-50')
    expect(segments.at(-1)?.id).toBe(`seg-${String(TRANSCRIPT_BUFFER_LIMIT + 49)}`)
  })

  it('does not grow the buffer when a capped span is merely refined', () => {
    let segments: readonly TranscriptSegment[] = []
    for (let index = 0; index < 5; index += 1) {
      segments = mergeSegment(segments, segment({ id: `seg-${String(index)}` }), 5)
    }
    segments = mergeSegment(segments, segment({ id: 'seg-2', text: 'PLACEHOLDER REFINED' }), 5)

    expect(segments).toHaveLength(5)
    expect(segments[2]?.text).toBe('PLACEHOLDER REFINED')
  })
})

describe('isTranscribing / isRunningManual', () => {
  it('counts degraded as transcribing, because a transcript is still arriving', () => {
    expect(isTranscribing(mockListeningAsrStatus())).toBe(true)
    expect(isTranscribing(mockDegradedAsrStatus())).toBe(true)
    expect(isTranscribing(mockFailedAsrStatus())).toBe(false)
    expect(isTranscribing(mockNotConfiguredAsrStatus())).toBe(false)
  })

  it('keeps degraded OUT of "running manual" — the two are deliberately distinct', () => {
    expect(isRunningManual(mockDegradedAsrStatus())).toBe(false)
    expect(isRunningManual(mockFailedAsrStatus())).toBe(true)
    expect(isRunningManual(mockNotConfiguredAsrStatus())).toBe(true)
  })
})

describe('useAsrStore', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetAsrStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates status and settings from the main process', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())

    await useAsrStore.getState().hydrate()

    const state = useAsrStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.status.state).toBe('listening')
    expect(state.settings).toEqual(defaultAsrSettings())
    expect(state.lastError).toBeNull()
  })

  it('reports not-configured by default, which is this machine’s real state', async () => {
    await useAsrStore.getState().hydrate()
    expect(useAsrStore.getState().status.state).toBe('not-configured')
    expect(isRunningManual(useAsrStore.getState().status)).toBe(true)
  })

  it('folds pushed transcript events through the replacement rule', async () => {
    const unsubscribe = useAsrStore.getState().subscribe()

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockDraftSegment({ id: 'span-1', text: 'PLACEHOLDER DRAFT' }),
    )
    installed.mock.emit(
      IpcEvent.asrTranscript,
      segment({ id: 'span-1', text: 'PLACEHOLDER FINAL', isFinal: true }),
    )
    installed.mock.emit(
      IpcEvent.asrTranscript,
      segment({ id: 'span-2', text: 'PLACEHOLDER SECOND', isFinal: true }),
    )

    const segments = useAsrStore.getState().segments
    expect(segments.map((entry) => entry.text)).toEqual([
      'PLACEHOLDER FINAL',
      'PLACEHOLDER SECOND',
    ])

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.asrTranscript)).toBe(0)
    expect(installed.mock.listenerCount(IpcEvent.asrStatus)).toBe(0)
  })

  it('mirrors a pushed status without inventing one', () => {
    const unsubscribe = useAsrStore.getState().subscribe()
    installed.mock.emit(IpcEvent.asrStatus, mockDegradedAsrStatus())

    const status = useAsrStore.getState().status
    expect(status.state).toBe('degraded')
    expect(status.provider).toBe('whisper')
    unsubscribe()
  })

  it('refuses to start when nothing is configured, and keeps the status as it was', async () => {
    await useAsrStore.getState().hydrate()

    const result = await useAsrStore.getState().start()

    expect(result.ok).toBe(false)
    expect(installed.mock.calls.asrStart).toHaveLength(1)
    expect(useAsrStore.getState().status.state).toBe('not-configured')
    expect(useAsrStore.getState().busy).toBe(false)
    expect(useAsrStore.getState().lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
  })

  it('starts and stops a configured session', async () => {
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())
    await useAsrStore.getState().hydrate()

    const started = await useAsrStore.getState().start()
    expect(started.ok).toBe(true)
    expect(useAsrStore.getState().status.state).toBe('listening')

    const stopped = await useAsrStore.getState().stop()
    expect(stopped.ok).toBe(true)
    expect(useAsrStore.getState().status.state).toBe('idle')
  })

  it('does not blank the mirrored status when a stop is refused', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    installed.mock.responses.asrStop = err(ErrorCode.INTERNAL, 'the recogniser is wedged')
    await useAsrStore.getState().hydrate()

    await useAsrStore.getState().stop()

    // Still listening as far as anyone knows. Claiming otherwise on our own error would put a
    // "stopped" readout over a running session.
    expect(useAsrStore.getState().status.state).toBe('listening')
    expect(useAsrStore.getState().lastError?.message).toMatch(/wedged/i)
  })

  it('saves settings through the bridge and adopts what came back', async () => {
    const next = { ...defaultAsrSettings(), mode: 'local' as const, customVocabulary: ['은혜교회'] }

    const result = await useAsrStore.getState().setSettings(next)

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.asrSetSettings).toEqual([next])
    expect(useAsrStore.getState().settings.customVocabulary).toEqual(['은혜교회'])
  })

  it('pushes audio without touching busy or lastError', async () => {
    const chunk = new Int16Array(1600).buffer

    const result = await useAsrStore.getState().pushAudio(chunk)

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.asrPushAudio).toEqual([3200])
    expect(useAsrStore.getState().busy).toBe(false)
    expect(useAsrStore.getState().lastError).toBeNull()
  })

  it('publishes enumerated devices to main and remembers them', async () => {
    const result = await useAsrStore.getState().reportDevices(MOCK_AUDIO_INPUTS)

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.asrListDevices).toEqual([MOCK_AUDIO_INPUTS])
    expect(useAsrStore.getState().devices).toEqual(MOCK_AUDIO_INPUTS)
  })

  it('clears the transcript on request and only on request', () => {
    useAsrStore.getState().ingest(segment({ id: 'a' }))
    expect(useAsrStore.getState().segments).toHaveLength(1)

    useAsrStore.getState().clearTranscript()
    expect(useAsrStore.getState().segments).toEqual([])
  })
})

describe('useAsrStore without a bridge', () => {
  beforeEach(() => {
    resetAsrStore()
  })

  it('degrades rather than throwing when window.verger is absent', async () => {
    delete window.verger
    resetAsrStore()

    await useAsrStore.getState().hydrate()

    const state = useAsrStore.getState()
    expect(state.bridgeAvailable).toBe(false)
    expect(state.hydrated).toBe(true)
    expect(state.lastError?.message).toBe(ASR_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from every action instead of dereferencing undefined', async () => {
    delete window.verger
    resetAsrStore()

    const store = useAsrStore.getState()
    for (const result of await Promise.all([
      store.start(),
      store.stop(),
      store.setSettings(defaultAsrSettings()),
      store.pushAudio(new ArrayBuffer(8)),
      store.reportDevices([]),
    ])) {
      expect(result.ok).toBe(false)
    }
    expect(store.subscribe()).toBeTypeOf('function')
  })

  it('still folds ingested segments, so a local capture loop keeps working', () => {
    delete window.verger
    resetAsrStore()

    useAsrStore.getState().ingest(mockDraftSegment({ id: 'x', text: 'PLACEHOLDER DRAFT' }))
    useAsrStore
      .getState()
      .ingest(segment({ id: 'x', text: 'PLACEHOLDER FINAL', isFinal: true }))

    expect(useAsrStore.getState().segments).toHaveLength(1)
    expect(useAsrStore.getState().segments[0]?.text).toBe('PLACEHOLDER FINAL')
  })
})
