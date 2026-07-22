/**
 * The cue store's contract — which is almost entirely a set of safety properties.
 *
 * Four of them carry the phase, and each has a test that fails loudly if it is ever relaxed:
 *
 *  1. **A veto is applied locally, before the round trip.** Dismissing and PANIC clear the pending
 *     suggestion synchronously. An operator who has said no must not still be racing a suggestion.
 *  2. **A halt survives a failed halt.** If the PANIC call itself fails, automation stays halted.
 *     Coming back requires an explicit resume that the main process acknowledged.
 *  3. **The scripture gate is re-applied on this side.** A `canAutoFire` suggestion whose verse text
 *     never resolved must not read as about to fire, in any mode.
 *  4. **A late resolution is dropped.** Verse text that arrives for a superseded suggestion may
 *     never be shown under the current suggestion's reference.
 *
 * All fixtures are placeholders. There is no verse text and no sermon text anywhere in this file
 * (Standing Rule 4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultCueEngineSettings } from '@shared/cue'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_VERSE_TEXT_PLACEHOLDER,
  installMockVergerApi,
  mockCueSuggestion,
  mockHotPhrase,
  mockPanickedCueEngineState,
  mockPendingCueEngineState,
  mockResolvedScripture,
  mockScriptureReference,
  mockScriptureSuggestion,
} from '../test/mockVergerApi'
import {
  CUE_BRIDGE_UNAVAILABLE_MESSAGE,
  classifyResolution,
  resetCueStore,
  useCueStore,
  willAutoFire,
} from './cueStore'

/** Let every queued microtask (the resolution chain) settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('willAutoFire', () => {
  it('never fires in assist, however confident the suggestion is', () => {
    const suggestion = mockCueSuggestion({ confidence: 1, canAutoFire: true })
    expect(willAutoFire(suggestion, 'assist', false, null)).toBe(false)
    expect(willAutoFire(suggestion, 'manual', false, null)).toBe(false)
    expect(willAutoFire(suggestion, 'auto', false, null)).toBe(true)
  })

  it('never fires while panicked', () => {
    const suggestion = mockCueSuggestion({ canAutoFire: true })
    expect(willAutoFire(suggestion, 'auto', true, null)).toBe(false)
  })

  it('never fires a suggestion the engine already marked un-fireable', () => {
    expect(willAutoFire(mockCueSuggestion({ canAutoFire: false }), 'auto', false, null)).toBe(false)
  })

  it('RE-APPLIES the scripture gate: no resolved text, no auto-show', () => {
    // The engine says this may fire. The text never arrived. The safer of the two answers wins.
    const suggestion = mockScriptureSuggestion({ canAutoFire: true })
    expect(willAutoFire(suggestion, 'auto', false, null)).toBe(false)
    expect(
      willAutoFire(suggestion, 'auto', false, mockResolvedScripture({ text: '   ' })),
    ).toBe(false)
    expect(willAutoFire(suggestion, 'auto', false, mockResolvedScripture())).toBe(true)
  })

  it('refuses a fuzzy reference even with text in hand', () => {
    const suggestion = mockScriptureSuggestion({
      canAutoFire: true,
      reference: mockScriptureReference({ band: 'fuzzy', confidence: 0.7 }),
    })
    expect(willAutoFire(suggestion, 'auto', false, mockResolvedScripture())).toBe(false)
  })

  it('is false with nothing pending', () => {
    expect(willAutoFire(null, 'auto', false, null)).toBe(false)
  })
})

describe('classifyResolution', () => {
  it('distinguishes not-scripture, resolving, resolved and unavailable', () => {
    expect(classifyResolution(mockCueSuggestion(), null, false)).toBe('not-scripture')
    expect(classifyResolution(mockScriptureSuggestion(), null, true)).toBe('resolving')
    expect(classifyResolution(mockScriptureSuggestion(), mockResolvedScripture(), false)).toBe(
      'resolved',
    )
    expect(classifyResolution(mockScriptureSuggestion(), null, false)).toBe('unavailable')
  })

  it('treats blank text as unavailable, not as resolved', () => {
    expect(
      classifyResolution(mockScriptureSuggestion(), mockResolvedScripture({ text: '' }), false),
    ).toBe('unavailable')
  })
})

describe('useCueStore', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCueStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates into assist mode, which is the default everywhere', async () => {
    await useCueStore.getState().hydrate()

    const state = useCueStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.state.mode).toBe('assist')
    expect(state.state.panicked).toBe(false)
    expect(state.state.pending).toBeNull()
    expect(state.settings).toEqual(defaultCueEngineSettings())
    expect(state.lastError).toBeNull()
  })

  it('adopts a pushed engine state without inventing one', () => {
    const unsubscribe = useCueStore.getState().subscribe()

    installed.mock.emit(IpcEvent.cueState, mockPendingCueEngineState(mockCueSuggestion()))

    expect(useCueStore.getState().state.pending?.id).toBe('suggestion-1')
    expect(useCueStore.getState().state.alignment).toBe('aligned')

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.cueState)).toBe(0)
    expect(installed.mock.listenerCount(IpcEvent.cueSuggestion)).toBe(0)
  })

  it('folds a pushed suggestion in and fetches its verse text', async () => {
    const unsubscribe = useCueStore.getState().subscribe()

    installed.mock.emit(IpcEvent.cueSuggestion, mockScriptureSuggestion())
    expect(useCueStore.getState().resolving).toBe(true)

    await flush()

    const state = useCueStore.getState()
    expect(state.resolving).toBe(false)
    expect(state.resolved?.text).toBe(MOCK_VERSE_TEXT_PLACEHOLDER)
    expect(installed.mock.calls.cueResolveScripture).toHaveLength(1)
    expect(installed.mock.calls.cueResolveScripture[0]?.reference.book).toBe('John')
    unsubscribe()
  })

  it('DROPS a resolution that arrives for a superseded suggestion', async () => {
    const unsubscribe = useCueStore.getState().subscribe()

    installed.mock.emit(
      IpcEvent.cueSuggestion,
      mockScriptureSuggestion({ id: 'first', reference: mockScriptureReference({ chapter: 3 }) }),
    )
    installed.mock.emit(
      IpcEvent.cueSuggestion,
      mockScriptureSuggestion({ id: 'second', reference: mockScriptureReference({ chapter: 8 }) }),
    )

    await flush()

    const state = useCueStore.getState()
    expect(state.resolvedFor).toBe('second')
    // The first reference's text must not have landed under the second reference's heading.
    expect(state.resolved?.reference.chapter).toBe(8)
    unsubscribe()
  })

  it('reports unavailable text rather than pretending, when resolution is refused', async () => {
    installed.mock.responses.cueResolveScripture = err(
      ErrorCode.NOT_CONFIGURED,
      'No Bible source is configured.',
    )
    const unsubscribe = useCueStore.getState().subscribe()

    installed.mock.emit(IpcEvent.cueSuggestion, mockScriptureSuggestion())
    await flush()

    const state = useCueStore.getState()
    expect(state.resolved).toBeNull()
    expect(state.resolveError?.message).toMatch(/no bible source/i)
    expect(classifyResolution(state.state.pending, state.resolved, state.resolving)).toBe(
      'unavailable',
    )
    unsubscribe()
  })

  it('applies a DISMISS locally, before the round trip resolves', async () => {
    installed.mock.responses.cueGetState = ok(mockPendingCueEngineState(mockCueSuggestion()))
    await useCueStore.getState().hydrate()
    expect(useCueStore.getState().state.pending).not.toBeNull()

    const pendingCall = useCueStore.getState().dismiss()

    // Synchronously, before anything has been awaited: the veto has already taken effect.
    expect(useCueStore.getState().state.pending).toBeNull()

    await pendingCall
    expect(installed.mock.calls.cueDismiss).toEqual([{ suggestionId: 'suggestion-1' }])
  })

  it('does NOT pre-apply a confirm — nothing claims to have happened until main says so', async () => {
    installed.mock.responses.cueGetState = ok(mockPendingCueEngineState(mockCueSuggestion()))
    installed.mock.responses.cueConfirm = err(ErrorCode.INTERNAL, 'the applier fell over')
    await useCueStore.getState().hydrate()

    const result = await useCueStore.getState().confirm()

    expect(result.ok).toBe(false)
    // Still pending: a refused confirm has not put anything on screen, and the card must stay so
    // the operator can try again or dismiss it.
    expect(useCueStore.getState().state.pending?.id).toBe('suggestion-1')
    expect(useCueStore.getState().lastError?.message).toMatch(/applier/i)
  })

  it('confirms the pending suggestion by id and adopts what came back', async () => {
    installed.mock.responses.cueGetState = ok(mockPendingCueEngineState(mockCueSuggestion()))
    await useCueStore.getState().hydrate()

    const result = await useCueStore.getState().confirm()

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.cueConfirm).toEqual([{ suggestionId: 'suggestion-1' }])
    expect(useCueStore.getState().state.pending).toBeNull()
    expect(useCueStore.getState().state.recent[0]?.id).toBe('suggestion-1')
  })

  it('refuses a confirm with nothing pending, without troubling the main process', async () => {
    await useCueStore.getState().hydrate()

    const result = await useCueStore.getState().confirm()

    expect(result.ok).toBe(false)
    expect(installed.mock.calls.cueConfirm).toHaveLength(0)
  })

  it('halts automation immediately on PANIC, and clears the pending suggestion', async () => {
    installed.mock.responses.cueGetState = ok(mockPendingCueEngineState(mockCueSuggestion()))
    await useCueStore.getState().hydrate()

    const pendingCall = useCueStore.getState().panic()

    expect(useCueStore.getState().state.panicked).toBe(true)
    expect(useCueStore.getState().state.pending).toBeNull()

    await pendingCall
    expect(installed.mock.calls.cuePanic).toHaveLength(1)
  })

  it('STAYS halted when the PANIC call itself fails', async () => {
    installed.mock.responses.cuePanic = err(ErrorCode.INTERNAL, 'the engine did not answer')
    await useCueStore.getState().hydrate()

    const result = await useCueStore.getState().panic()

    expect(result.ok).toBe(false)
    // Automation may never come back because a message was lost.
    expect(useCueStore.getState().state.panicked).toBe(true)
    expect(useCueStore.getState().lastError?.message).toMatch(/did not answer/i)
  })

  it('never un-panics on its own — only an acknowledged resume clears it', async () => {
    installed.mock.responses.cueGetState = ok(mockPanickedCueEngineState())
    await useCueStore.getState().hydrate()
    expect(useCueStore.getState().state.panicked).toBe(true)

    // A new suggestion arriving is not a reason to come back.
    const unsubscribe = useCueStore.getState().subscribe()
    installed.mock.emit(IpcEvent.cueSuggestion, mockCueSuggestion({ id: 'while-panicked' }))
    expect(useCueStore.getState().state.panicked).toBe(true)
    expect(useCueStore.getState().state.pending).toBeNull()

    // Neither is picking a mode.
    await useCueStore.getState().setMode('auto')
    expect(useCueStore.getState().state.panicked).toBe(true)

    // Nor is a resume the main process refused.
    installed.mock.responses.cueResume = err(ErrorCode.INTERNAL, 'refused')
    await useCueStore.getState().resume()
    expect(useCueStore.getState().state.panicked).toBe(true)

    installed.mock.responses.cueResume = null
    await useCueStore.getState().resume()
    expect(useCueStore.getState().state.panicked).toBe(false)
    expect(installed.mock.calls.cueResume).toHaveLength(2)
    unsubscribe()
  })

  it('sets the trust dial through the bridge', async () => {
    await useCueStore.getState().hydrate()

    const result = await useCueStore.getState().setMode('auto')

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.cueSetMode).toEqual(['auto'])
    expect(useCueStore.getState().state.mode).toBe('auto')
  })

  it('saves settings and adopts what came back', async () => {
    const next = { ...defaultCueEngineSettings(), hotPhrases: [mockHotPhrase()] }

    const result = await useCueStore.getState().setSettings(next)

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.cueSetSettings).toEqual([next])
    expect(useCueStore.getState().settings.hotPhrases).toHaveLength(1)
  })

  it('keeps the mirrored state when a call is refused', async () => {
    installed.mock.responses.cueGetState = ok(mockPendingCueEngineState(mockCueSuggestion()))
    installed.mock.responses.cueSetMode = err(ErrorCode.INTERNAL, 'busy')
    await useCueStore.getState().hydrate()

    await useCueStore.getState().setMode('manual')

    expect(useCueStore.getState().state.mode).toBe('assist')
    expect(useCueStore.getState().state.pending?.id).toBe('suggestion-1')
  })
})

describe('useCueStore without a bridge', () => {
  beforeEach(() => {
    resetCueStore()
  })

  it('degrades rather than throwing when window.verger is absent', async () => {
    delete window.verger
    resetCueStore()

    await useCueStore.getState().hydrate()

    const state = useCueStore.getState()
    expect(state.bridgeAvailable).toBe(false)
    expect(state.hydrated).toBe(true)
    expect(state.lastError?.message).toBe(CUE_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('returns an Err from every action instead of dereferencing undefined', async () => {
    delete window.verger
    resetCueStore()
    useCueStore.setState({ state: mockPendingCueEngineState(mockCueSuggestion()) })

    const store = useCueStore.getState()
    for (const result of await Promise.all([
      store.setMode('manual'),
      store.confirm(),
      store.dismiss(),
      store.panic(),
      store.resume(),
      store.setSettings(defaultCueEngineSettings()),
    ])) {
      expect(result.ok).toBe(false)
    }
    expect(store.subscribe()).toBeTypeOf('function')
  })

  it('still halts automation locally with no bridge to tell', async () => {
    delete window.verger
    resetCueStore()

    await useCueStore.getState().panic()

    expect(useCueStore.getState().state.panicked).toBe(true)
  })
})
