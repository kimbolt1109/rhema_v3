/**
 * The health store's contract — which is mostly a set of safety properties.
 *
 * Four of them carry the phase:
 *
 *  1. **Nothing is invented.** With no bridge the store rests at all-`not-configured` and says the
 *     bridge is missing; it never guesses that a subsystem is fine.
 *  2. **`not-configured` is not a problem.** It never appears in the "needs attention" list, because
 *     a permanently amber console teaches its operator to ignore amber.
 *  3. **Neither recovery action can reach the broadcast.** Restoring a checkpoint and reloading the
 *     overlays leave the `stream` and `recording` lights exactly as they were, and never place a
 *     single call on the GO LIVE channel. This is asserted against the fake bridge's own call log,
 *     not by reading the source.
 *  4. **A refused recovery does not blank the lights.** A failed restore must not turn a dashboard
 *     that was reporting a healthy service into one that reports nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SUBSYSTEMS, isServiceStillGoingOut } from '@shared/health'
import { IpcEvent } from '@shared/ipc'
import { ErrorCode, err, ok } from '@shared/result'

import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  MOCK_CHECKPOINTS,
  MOCK_NOW,
  installMockVergerApi,
  mockHealthSnapshot,
  mockHealthySnapshot,
  mockObsDownHealthSnapshot,
  mockStreamReconnectingSnapshot,
} from '../test/mockVergerApi'
import {
  HEALTH_BRIDGE_UNAVAILABLE_MESSAGE,
  describeElapsed,
  findSubsystem,
  restingHealthSnapshot,
  resetHealthStore,
  subsystemsNeedingAttention,
  useHealthStore,
} from './healthStore'

describe('restingHealthSnapshot', () => {
  it('starts every subsystem at rest, never at ok', () => {
    const snapshot = restingHealthSnapshot(MOCK_NOW)
    expect(snapshot.subsystems).toHaveLength(SUBSYSTEMS.length)
    for (const subsystem of snapshot.subsystems) {
      expect(subsystem.level).toBe('not-configured')
      expect(subsystem.stillWorks).toBeNull()
    }
    // Not "ok". A console that starts green would show a full row of healthy lights during the
    // seconds before the first snapshot arrives — exactly when somebody is most likely to glance.
    expect(snapshot.worst).toBe('not-configured')
  })
})

describe('subsystemsNeedingAttention', () => {
  it('excludes not-configured — a resting state is not a problem to solve', () => {
    const attention = subsystemsNeedingAttention(restingHealthSnapshot(MOCK_NOW))
    expect(attention).toHaveLength(0)
  })

  it('sorts down ahead of degraded', () => {
    const snapshot = mockHealthSnapshot({
      asr: { level: 'degraded', detail: 'on the local model', stillWorks: 'transcript still arriving' },
      obs: { level: 'down', detail: 'websocket went away', stillWorks: 'OBS keeps streaming' },
    })
    expect(subsystemsNeedingAttention(snapshot).map((entry) => entry.id)).toEqual(['obs', 'asr'])
  })
})

describe('describeElapsed', () => {
  it('clamps a main-process clock that runs ahead of the renderer to "just now"', () => {
    expect(describeElapsed(MOCK_NOW + 5_000, MOCK_NOW)).toEqual({
      key: 'health.duration.seconds',
      value: 0,
    })
  })

  it('steps through seconds, minutes and hours', () => {
    expect(describeElapsed(MOCK_NOW - 45_000, MOCK_NOW)).toEqual({
      key: 'health.duration.seconds',
      value: 45,
    })
    expect(describeElapsed(MOCK_NOW - 5 * 60_000, MOCK_NOW)).toEqual({
      key: 'health.duration.minutes',
      value: 5,
    })
    expect(describeElapsed(MOCK_NOW - 2 * 3_600_000, MOCK_NOW)).toEqual({
      key: 'health.duration.hours',
      value: 2,
    })
  })
})

describe('useHealthStore', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetHealthStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('hydrates the snapshot and the checkpoint list', async () => {
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())

    await useHealthStore.getState().hydrate()

    const state = useHealthStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.bridgeAvailable).toBe(true)
    expect(state.lastError).toBeNull()
    expect(state.checkpoints).toEqual(MOCK_CHECKPOINTS)
    expect(findSubsystem(state.snapshot, 'stream')?.level).toBe('ok')
    expect(installed.mock.calls.healthGet).toHaveLength(1)
    expect(installed.mock.calls.healthListCheckpoints).toHaveLength(1)
  })

  it('adopts a pushed snapshot, and stops when unsubscribed', () => {
    const unsubscribe = useHealthStore.getState().subscribe()
    expect(installed.mock.listenerCount(IpcEvent.healthSnapshot)).toBe(1)

    installed.mock.emit(IpcEvent.healthSnapshot, mockObsDownHealthSnapshot())
    expect(findSubsystem(useHealthStore.getState().snapshot, 'obs')?.level).toBe('down')

    unsubscribe()
    expect(installed.mock.listenerCount(IpcEvent.healthSnapshot)).toBe(0)

    installed.mock.emit(IpcEvent.healthSnapshot, mockHealthySnapshot())
    expect(findSubsystem(useHealthStore.getState().snapshot, 'obs')?.level).toBe('down')
  })

  it('rests at not-configured with no bridge, and never claims a subsystem is fine', async () => {
    installed.restore()
    resetHealthStore()

    await useHealthStore.getState().hydrate()

    const state = useHealthStore.getState()
    expect(state.bridgeAvailable).toBe(false)
    expect(state.hydrated).toBe(true)
    expect(state.lastError?.message).toBe(HEALTH_BRIDGE_UNAVAILABLE_MESSAGE)
    for (const subsystem of state.snapshot.subsystems) expect(subsystem.level).toBe('not-configured')

    const refusal = await useHealthStore.getState().reloadOverlays()
    expect(refusal.ok).toBe(false)

    // Reinstalled for the shared afterEach.
    installed = installMockVergerApi()
  })

  it('RESTORING A CHECKPOINT NEVER TOUCHES THE STREAM OR THE RECORDING', async () => {
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    const before = useHealthStore.getState().snapshot
    const result = await useHealthStore.getState().restoreCheckpoint('checkpoint-2')

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.healthRestoreCheckpoint).toEqual([{ checkpointId: 'checkpoint-2' }])

    // The only light that moved is `automation`.
    const after = useHealthStore.getState().snapshot
    expect(findSubsystem(after, 'stream')).toEqual(findSubsystem(before, 'stream'))
    expect(findSubsystem(after, 'recording')).toEqual(findSubsystem(before, 'recording'))
    expect(isServiceStillGoingOut(after)).toBe(true)

    // And nothing reached the GO LIVE channel at all. This is the assertion that would fail if a
    // future "safety" tidy-up made a restore stop the stream first.
    expect(installed.mock.calls.goLiveStart).toHaveLength(0)
    expect(installed.mock.calls.goLiveEnd).toHaveLength(0)
  })

  it('RELOADING THE OVERLAYS NEVER TOUCHES THE STREAM OR THE RECORDING', async () => {
    installed.mock.responses.healthGet = ok(mockHealthySnapshot())
    await useHealthStore.getState().hydrate()

    const before = useHealthStore.getState().snapshot
    const result = await useHealthStore.getState().reloadOverlays()

    expect(result.ok).toBe(true)
    expect(installed.mock.calls.healthReloadOverlays).toHaveLength(1)

    const after = useHealthStore.getState().snapshot
    expect(findSubsystem(after, 'stream')).toEqual(findSubsystem(before, 'stream'))
    expect(findSubsystem(after, 'recording')).toEqual(findSubsystem(before, 'recording'))
    expect(findSubsystem(after, 'overlay')?.level).toBe('ok')
    expect(installed.mock.calls.goLiveStart).toHaveLength(0)
    expect(installed.mock.calls.goLiveEnd).toHaveLength(0)
  })

  it('keeps the lights exactly as they were when a recovery is refused', async () => {
    installed.mock.responses.healthGet = ok(mockStreamReconnectingSnapshot())
    await useHealthStore.getState().hydrate()
    const before = useHealthStore.getState().snapshot

    installed.mock.responses.healthRestoreCheckpoint = err(ErrorCode.NOT_FOUND, 'aged out')
    const result = await useHealthStore.getState().restoreCheckpoint('checkpoint-gone')

    expect(result.ok).toBe(false)
    // A refused call is not evidence that any subsystem changed. Blanking here would turn a failed
    // button press into a dashboard that looks like a catastrophe.
    expect(useHealthStore.getState().snapshot).toEqual(before)
    expect(useHealthStore.getState().lastError?.code).toBe(ErrorCode.NOT_FOUND)
    expect(useHealthStore.getState().busy).toBe(false)
  })

  it('refuses an unknown checkpoint id rather than pretending automation moved', async () => {
    await useHealthStore.getState().hydrate()
    const result = await useHealthStore.getState().restoreCheckpoint('checkpoint-never-existed')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND)
  })
})
