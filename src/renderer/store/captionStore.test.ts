/**
 * The caption switch, which is a kill switch.
 *
 * These tests are mostly about one property: the UI must never claim the congregation screen is
 * clear before the main process has said so. A store that flipped optimistically would pass a naive
 * "clicking Off shows Off" test and be wrong in the only moment that matters.
 *
 * Placeholder strings throughout — Standing Rule 4 forbids real sermon, verse or lyric text
 * anywhere in this repo, fixtures included.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { idleCaptionState } from '@shared/caption'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import { installMockVergerApi } from '../test/mockVergerApi'
import {
  CAPTION_BRIDGE_UNAVAILABLE_MESSAGE,
  resetCaptionStore,
  useCaptionStore,
} from './captionStore'

describe('captionStore without a bridge', () => {
  beforeEach(() => {
    delete window.verger
    resetCaptionStore()
  })

  it('settles into a flagged not-configured state instead of throwing', async () => {
    await useCaptionStore.getState().hydrate()

    const store = useCaptionStore.getState()
    expect(store.bridgeAvailable).toBe(false)
    expect(store.hydrated).toBe(true)
    expect(store.state).toEqual(idleCaptionState())
    expect(store.lastError?.code).toBe(ErrorCode.NOT_CONFIGURED)
    expect(store.lastError?.message).toBe(CAPTION_BRIDGE_UNAVAILABLE_MESSAGE)
  })

  it('refuses to switch on, and does not pretend it did', async () => {
    const result = await useCaptionStore.getState().setEnabled(true)

    expect(result.ok).toBe(false)
    // The critical half: a refusal must not leave the UI reading "captions are on".
    expect(useCaptionStore.getState().state.enabled).toBe(false)
  })

  it('subscribing is a no-op that does not throw', () => {
    const off = useCaptionStore.getState().subscribe()
    expect(() => {
      off()
    }).not.toThrow()
  })
})

describe('captionStore with a bridge', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetCaptionStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('starts off, because unreviewed machine text may never be on by default', async () => {
    await useCaptionStore.getState().hydrate()

    expect(useCaptionStore.getState().state).toEqual(idleCaptionState())
    expect(useCaptionStore.getState().hydrated).toBe(true)
  })

  it('sends the switch to the driver and settles on what the driver reports', async () => {
    useCaptionStore.getState().subscribe()
    await useCaptionStore.getState().hydrate()

    await useCaptionStore.getState().setEnabled(true)

    expect(installed.mock.calls.captionSetEnabled).toEqual([true])
    expect(useCaptionStore.getState().state.enabled).toBe(true)
    expect(useCaptionStore.getState().pending).toBe(false)
  })

  it('does NOT flip optimistically — the switch waits for the driver', async () => {
    useCaptionStore.getState().subscribe()
    await useCaptionStore.getState().hydrate()

    const inFlight = useCaptionStore.getState().setEnabled(true)

    // Synchronously after the click, before the bridge has answered: the control shows it is
    // unsettled, and it does NOT yet claim captions are on. This is the whole point of the store.
    expect(useCaptionStore.getState().pending).toBe(true)
    expect(useCaptionStore.getState().state.enabled).toBe(false)

    await inFlight
    expect(useCaptionStore.getState().state.enabled).toBe(true)
  })

  it('toggles from whatever the driver last reported, not from a captured value', async () => {
    useCaptionStore.getState().subscribe()
    await useCaptionStore.getState().hydrate()

    await useCaptionStore.getState().toggle()
    expect(useCaptionStore.getState().state.enabled).toBe(true)

    await useCaptionStore.getState().toggle()
    expect(useCaptionStore.getState().state.enabled).toBe(false)

    expect(installed.mock.calls.captionSetEnabled).toEqual([true, false])
  })

  it('follows the driver when it switches captions off by itself', async () => {
    useCaptionStore.getState().subscribe()
    await useCaptionStore.getState().hydrate()
    await useCaptionStore.getState().setEnabled(true)

    // The driver hides on its own for reasons the UI knows nothing about — an idle deadline, or a
    // retracted hallucination. The pushed event is the authority, so the switch has to follow.
    installed.mock.emit(IpcEvent.captionState, {
      enabled: false,
      showDrafts: false,
      lastText: 'PLACEHOLDER SPEECH ONE',
    })

    expect(useCaptionStore.getState().state.enabled).toBe(false)
    expect(useCaptionStore.getState().state.lastText).toBe('PLACEHOLDER SPEECH ONE')
  })

  it('carries the draft preference separately from the switch', async () => {
    useCaptionStore.getState().subscribe()
    await useCaptionStore.getState().hydrate()

    await useCaptionStore.getState().setShowDrafts(true)

    expect(installed.mock.calls.captionSetShowDrafts).toEqual([true])
    expect(useCaptionStore.getState().state.showDrafts).toBe(true)
    // Turning drafts on must not turn captions on.
    expect(useCaptionStore.getState().state.enabled).toBe(false)
  })

  it('clears pending even if the driver never pushes, so a control cannot stick mid-flight', async () => {
    // No `subscribe()` here on purpose: this is the build where the push channel is dead.
    await useCaptionStore.getState().hydrate()

    await useCaptionStore.getState().setEnabled(true)

    expect(useCaptionStore.getState().pending).toBe(false)
    expect(useCaptionStore.getState().state.enabled).toBe(true)
  })
})
