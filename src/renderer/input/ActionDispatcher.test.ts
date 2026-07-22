/**
 * The dispatcher's one hard promise: **it cannot be broken by the code it calls.**
 *
 * A handler that throws mid-service must not take the input loop with it — if it did, the
 * operator's next keypress would land nowhere and the booth would be deaf until a reload. These
 * tests assert containment directly rather than trusting a `try`/`catch` to still be there after
 * the next refactor.
 */

import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'

import type { DispatchedAction } from '@shared/actions'
import { ActionId } from '@shared/actions'
import type { LogFields } from '@shared/log'

import type { ActionLogger } from './ActionDispatcher'
import { createActionDispatcher } from './ActionDispatcher'

type LogFn = (message: string, fields?: LogFields) => void

/** A logger stub, so contained failures are asserted instead of printed. */
function stubLogger(): { warn: Mock<LogFn>; error: Mock<LogFn> } & ActionLogger {
  return { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() }
}

describe('createActionDispatcher', () => {
  it('invokes the handler registered for the action, with param and source', () => {
    const dispatcher = createActionDispatcher({ now: () => 1234, logger: stubLogger() })
    const seen: DispatchedAction[] = []
    dispatcher.register(ActionId.cameraSelect, (dispatched) => seen.push(dispatched))

    dispatcher.dispatch(ActionId.cameraSelect, 'pulpit', 'keyboard')

    expect(seen).toEqual([
      { action: ActionId.cameraSelect, param: 'pulpit', source: 'keyboard', at: 1234 },
    ])
  })

  it('omits `param` entirely when there is none', () => {
    const dispatcher = createActionDispatcher({ now: () => 0, logger: stubLogger() })
    const dispatched = dispatcher.dispatch(ActionId.advance, undefined, 'keyboard')

    // `exactOptionalPropertyTypes`: the key must be absent, not present-and-undefined.
    expect(dispatched).not.toHaveProperty('param')
  })

  it('defaults the source to the UI, for on-screen buttons', () => {
    const dispatcher = createActionDispatcher({ now: () => 7, logger: stubLogger() })
    expect(dispatcher.dispatch(ActionId.logo).source).toBe('ui')
  })

  it('does not deliver an action to another action’s handler', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const black = vi.fn()
    const advance = vi.fn()
    dispatcher.register(ActionId.black, black)
    dispatcher.register(ActionId.advance, advance)

    dispatcher.dispatch(ActionId.advance, undefined, 'keyboard')

    expect(advance).toHaveBeenCalledTimes(1)
    expect(black).not.toHaveBeenCalled()
  })

  it('runs every handler registered for one action', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const first = vi.fn()
    const second = vi.fn()
    dispatcher.register(ActionId.advance, first)
    dispatcher.register(ActionId.advance, second)

    dispatcher.dispatch(ActionId.advance)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops calling a handler once it is unregistered', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const handler = vi.fn()
    const unregister = dispatcher.register(ActionId.advance, handler)

    dispatcher.dispatch(ActionId.advance)
    unregister()
    dispatcher.dispatch(ActionId.advance)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(dispatcher.hasHandler(ActionId.advance)).toBe(false)
  })

  it('contains a throwing handler: siblings still run, and the dispatcher stays usable', () => {
    const logger = stubLogger()
    const dispatcher = createActionDispatcher({ logger })
    const broken = vi.fn(() => {
      throw new Error('stale OBS socket')
    })
    const healthy = vi.fn()
    dispatcher.register(ActionId.advance, broken)
    dispatcher.register(ActionId.advance, healthy)

    // The throw must not escape into the caller — this is the keydown listener's stack frame.
    expect(() => dispatcher.dispatch(ActionId.advance, undefined, 'keyboard')).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)

    // And the *next* keypress must still work. A broken handler may not deafen the keyboard.
    dispatcher.dispatch(ActionId.advance, undefined, 'keyboard')
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(broken).toHaveBeenCalledTimes(2)
  })

  it('contains a handler that throws a non-Error', () => {
    const logger = stubLogger()
    const dispatcher = createActionDispatcher({ logger })
    dispatcher.register(ActionId.panic, () => {
      throw 'nope'
    })

    expect(() => dispatcher.dispatch(ActionId.panic, undefined, 'keyboard')).not.toThrow()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('notifies observers of every dispatch, even when a handler threw', () => {
    const dispatcher = createActionDispatcher({ now: () => 42, logger: stubLogger() })
    const seen: DispatchedAction[] = []
    dispatcher.subscribe((dispatched) => seen.push(dispatched))
    dispatcher.register(ActionId.advance, () => {
      throw new Error('boom')
    })

    dispatcher.dispatch(ActionId.advance, undefined, 'keyboard')
    dispatcher.dispatch(ActionId.cameraSelect, 'cam2', 'ui')

    expect(seen.map((entry) => entry.action)).toEqual([ActionId.advance, ActionId.cameraSelect])
  })

  it('contains a throwing observer without losing the remaining observers', () => {
    const logger = stubLogger()
    const dispatcher = createActionDispatcher({ logger })
    const survivor = vi.fn()
    dispatcher.subscribe(() => {
      throw new Error('bad readout')
    })
    dispatcher.subscribe(survivor)

    expect(() => dispatcher.dispatch(ActionId.freeze)).not.toThrow()
    expect(survivor).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('stops notifying an unsubscribed observer', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const observer = vi.fn()
    const unsubscribe = dispatcher.subscribe(observer)

    dispatcher.dispatch(ActionId.advance)
    unsubscribe()
    dispatcher.dispatch(ActionId.advance)

    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('survives a handler that unregisters itself while being called', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const later = vi.fn()
    const unregister = dispatcher.register(ActionId.advance, () => {
      unregister()
    })
    dispatcher.register(ActionId.advance, later)

    expect(() => dispatcher.dispatch(ActionId.advance)).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('records the last action for the operator readout', () => {
    const dispatcher = createActionDispatcher({ now: () => 99, logger: stubLogger() })
    expect(dispatcher.lastAction()).toBeNull()

    dispatcher.dispatch(ActionId.cameraSelect, 'wide', 'pedal')

    expect(dispatcher.lastAction()).toEqual({
      action: ActionId.cameraSelect,
      param: 'wide',
      source: 'pedal',
      at: 99,
    })
  })

  it('reports an unhandled action instead of throwing', () => {
    const logger = stubLogger()
    const dispatcher = createActionDispatcher({ logger })

    expect(() => dispatcher.dispatch(ActionId.clearAll, undefined, 'ui')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
    expect(dispatcher.hasHandler(ActionId.clearAll)).toBe(false)
  })

  it('drops every handler and observer on clear()', () => {
    const dispatcher = createActionDispatcher({ logger: stubLogger() })
    const handler = vi.fn()
    const observer = vi.fn()
    dispatcher.register(ActionId.advance, handler)
    dispatcher.subscribe(observer)

    dispatcher.clear()
    dispatcher.dispatch(ActionId.advance)

    expect(handler).not.toHaveBeenCalled()
    expect(observer).not.toHaveBeenCalled()
  })

  it('stamps each dispatch with the injected clock', () => {
    let ms = 1000
    const dispatcher = createActionDispatcher({ now: () => ms, logger: stubLogger() })

    const first = dispatcher.dispatch(ActionId.advance)
    ms = 2500
    const second = dispatcher.dispatch(ActionId.advance)

    expect(first.at).toBe(1000)
    expect(second.at).toBe(2500)
  })
})
