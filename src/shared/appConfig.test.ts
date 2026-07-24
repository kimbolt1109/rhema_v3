import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PORTABLE_CONFIG,
  portableConfigSchema,
  resolvePortableConfig,
  serializePortableConfig,
} from './appConfig'

/**
 * `config.json` is hand-edited by one operator on a church PC, often under time pressure. These
 * cases pin the two properties that matter there: an empty or partial or slightly-wrong file always
 * yields a usable config (never a crash — Standing Rule 5), and a valid file maps to exactly the
 * `ws://host:port` shape the OBS loader already validates.
 */
describe('portableConfigSchema', () => {
  it('fills a complete default from an empty object', () => {
    expect(portableConfigSchema.parse({})).toEqual(DEFAULT_PORTABLE_CONFIG)
  })

  it('fills only the missing fields from a partial object', () => {
    const parsed = portableConfigSchema.parse({ obs: { host: '192.168.1.50' } })
    expect(parsed.obs).toEqual({ host: '192.168.1.50', port: 4455, password: '' })
    expect(parsed.overlay).toEqual({ port: 7320 })
  })

  it('coerces a port typed as a string — the routine Notepad mistake', () => {
    expect(portableConfigSchema.parse({ obs: { port: '4460' } }).obs.port).toBe(4460)
  })

  it('falls back a single garbage field instead of failing the whole file', () => {
    const parsed = portableConfigSchema.parse({
      obs: { port: 'not-a-port' },
      asr: { engine: 'espeak-nonsense' },
    })
    expect(parsed.obs.port).toBe(4455) // fell back
    expect(parsed.asr.engine).toBe('whisper') // fell back
  })

  it('survives a wholly wrong top-level shape by using the default', () => {
    expect(portableConfigSchema.parse('nonsense')).toEqual(DEFAULT_PORTABLE_CONFIG)
    expect(portableConfigSchema.parse(42)).toEqual(DEFAULT_PORTABLE_CONFIG)
  })

  it('strips unknown keys rather than rejecting them (forward compatible)', () => {
    const parsed = portableConfigSchema.parse({ obs: { host: '10.0.0.4' }, futureKey: true })
    expect(parsed).not.toHaveProperty('futureKey')
    expect(parsed.obs.host).toBe('10.0.0.4')
  })
})

describe('resolvePortableConfig', () => {
  it('folds host + port into the ws:// URL the OBS loader validates', () => {
    const resolved = resolvePortableConfig(
      portableConfigSchema.parse({ obs: { host: '127.0.0.1', port: 4455, password: '' } }),
    )
    expect(resolved.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://127.0.0.1:4455')
    expect(resolved.envOverrides['OBS_WEBSOCKET_PASSWORD']).toBe('')
  })

  it('passes a real password through untouched', () => {
    const resolved = resolvePortableConfig(
      portableConfigSchema.parse({ obs: { host: '10.0.0.7', port: 4460, password: 'booth-secret' } }),
    )
    expect(resolved.envOverrides['OBS_WEBSOCKET_URL']).toBe('ws://10.0.0.7:4460')
    expect(resolved.envOverrides['OBS_WEBSOCKET_PASSWORD']).toBe('booth-secret')
  })

  it('surfaces the overlay port and asr engine for the launcher to wire up', () => {
    const resolved = resolvePortableConfig(
      portableConfigSchema.parse({ overlay: { port: 7999 }, asr: { engine: 'none' } }),
    )
    expect(resolved.overlayPort).toBe(7999)
    expect(resolved.asrEngine).toBe('none')
  })
})

describe('serializePortableConfig', () => {
  it('writes a human-readable file with a _readme that round-trips back to the same config', () => {
    const text = serializePortableConfig(DEFAULT_PORTABLE_CONFIG)
    expect(text).toContain('_readme')
    expect(text.endsWith('\n')).toBe(true)
    // Re-parsing strips the _readme hint and yields the identical config.
    expect(portableConfigSchema.parse(JSON.parse(text))).toEqual(DEFAULT_PORTABLE_CONFIG)
  })
})
