import { describe, expect, it } from 'vitest'

import { ENV_KEYS, loadConfig, summarize } from '@main/config/env'
import type { EnvSource } from '@main/config/env'

/**
 * The contract under test (Standing Rule 5): nothing here may throw, and a missing or
 * malformed key degrades to "not configured" rather than failing the launch.
 */
describe('loadConfig', () => {
  it('treats a completely empty environment as "nothing configured", without throwing', () => {
    const config = loadConfig({})

    expect(config.obs).toBeNull()
    expect(config.google).toBeNull()
    expect(config.deepgramApiKey).toBeNull()
    expect(config.esvApiKey).toBeNull()
    expect(config.apiBibleKey).toBeNull()
    expect(config.sentryDsn).toBeNull()

    for (const key of ENV_KEYS) {
      expect(config.configured[key], `${key} should be unconfigured`).toBe(false)
    }
    expect(config.warnings).toHaveLength(0)
  })

  it('exposes exactly the eight keys declared in .env.example', () => {
    expect([...ENV_KEYS]).toEqual([
      'OBS_WEBSOCKET_URL',
      'OBS_WEBSOCKET_PASSWORD',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'DEEPGRAM_API_KEY',
      'ESV_API_KEY',
      'API_BIBLE_KEY',
      'SENTRY_DSN'
    ])
    expect(Object.keys(loadConfig({}).configured).sort()).toEqual([...ENV_KEYS].sort())
  })

  it('configures OBS from a URL alone, with an absent password reported as null', () => {
    const config = loadConfig({ OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455' })

    expect(config.obs).not.toBeNull()
    expect(config.obs?.url).toBe('ws://127.0.0.1:4455')
    expect(config.obs?.password).toBeNull()
    expect(config.configured.OBS_WEBSOCKET_URL).toBe(true)
    expect(config.configured.OBS_WEBSOCKET_PASSWORD).toBe(false)
    expect(config.warnings).toHaveLength(0)
  })

  it('accepts wss:// as well as ws://', () => {
    const config = loadConfig({ OBS_WEBSOCKET_URL: 'wss://obs.example.local:4455' })
    expect(config.obs?.url).toBe('wss://obs.example.local:4455')
    expect(config.configured.OBS_WEBSOCKET_URL).toBe(true)
  })

  it('treats an empty password as VALID (OBS auth disabled) and distinct from absent', () => {
    const withEmpty = loadConfig({
      OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455',
      OBS_WEBSOCKET_PASSWORD: ''
    })
    const withAbsent = loadConfig({ OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455' })

    // Present-but-empty is a real configuration: OBS has authentication turned off.
    expect(withEmpty.obs?.password).toBe('')
    expect(withEmpty.obs).not.toBeNull()

    // Absent is a different state, and the two must not collapse into one another.
    expect(withAbsent.obs?.password).toBeNull()
    expect(withEmpty.obs?.password).not.toBe(withAbsent.obs?.password)

    // Neither counts as a *configured* secret, and neither blocks the OBS connection.
    expect(withEmpty.configured.OBS_WEBSOCKET_PASSWORD).toBe(false)
    expect(withAbsent.configured.OBS_WEBSOCKET_PASSWORD).toBe(false)
  })

  it('carries a real password through verbatim', () => {
    const config = loadConfig({
      OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455',
      OBS_WEBSOCKET_PASSWORD: 'hunter2'
    })
    expect(config.obs?.password).toBe('hunter2')
    expect(config.configured.OBS_WEBSOCKET_PASSWORD).toBe(true)
  })

  it('degrades a malformed OBS URL to "not configured" plus a warning, and never throws', () => {
    for (const malformed of ['not a url', 'http://127.0.0.1:4455', '::::', 'ws//missing-colon']) {
      const config = loadConfig({ OBS_WEBSOCKET_URL: malformed })

      expect(config.obs, `${malformed} should not produce an OBS config`).toBeNull()
      expect(config.configured.OBS_WEBSOCKET_URL).toBe(false)
      expect(config.warnings.map((warning) => warning.key)).toContain('OBS_WEBSOCKET_URL')
    }
  })

  it('does not warn about an absent OBS URL — unconfigured is the normal first-run state', () => {
    expect(loadConfig({ OBS_WEBSOCKET_URL: '' }).warnings).toHaveLength(0)
  })

  it('requires both halves of the Google credential pair', () => {
    const onlyId = loadConfig({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' })
    expect(onlyId.google).toBeNull()
    expect(onlyId.warnings.map((warning) => warning.key)).toContain('GOOGLE_CLIENT_SECRET')

    const both = loadConfig({
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'shh'
    })
    expect(both.google).toEqual({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' })
    expect(both.warnings).toHaveLength(0)
  })

  it('trims surrounding whitespace, which .env files pick up easily', () => {
    const config = loadConfig({ ESV_API_KEY: '  esv-value  ', DEEPGRAM_API_KEY: '   ' })
    expect(config.esvApiKey).toBe('esv-value')
    expect(config.deepgramApiKey).toBeNull()
    expect(config.configured.DEEPGRAM_API_KEY).toBe(false)
  })
})

describe('summarize', () => {
  const secretEnv: EnvSource = {
    OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455',
    OBS_WEBSOCKET_PASSWORD: 'obs-password-value',
    GOOGLE_CLIENT_ID: 'google-client-id-value',
    GOOGLE_CLIENT_SECRET: 'google-client-secret-value',
    DEEPGRAM_API_KEY: 'deepgram-key-value',
    ESV_API_KEY: 'esv-key-value',
    API_BIBLE_KEY: 'api-bible-key-value',
    SENTRY_DSN: 'https://sentry-dsn-value@example.invalid/1'
  }

  it('reports key names and booleans only', () => {
    const summary = summarize(loadConfig(secretEnv))

    expect(summary.obsConfigured).toBe(true)
    expect(summary.googleConfigured).toBe(true)
    for (const key of ENV_KEYS) {
      expect(summary.configured[key]).toBe(true)
    }
  })

  it('leaks no secret value — this is what is written to the log file', () => {
    const serialized = JSON.stringify(summarize(loadConfig(secretEnv)))

    for (const value of Object.values(secretEnv)) {
      if (value === undefined || value.length === 0) continue
      expect(serialized, `summary must not contain ${value}`).not.toContain(value)
    }
    // Not even the OBS URL, which is the least sensitive value present.
    expect(serialized).not.toContain('127.0.0.1')
  })

  it('surfaces warnings as key-prefixed strings that contain no value', () => {
    const summary = summarize(loadConfig({ OBS_WEBSOCKET_URL: 'http://not-a-websocket:4455' }))

    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0]).toContain('OBS_WEBSOCKET_URL')
    expect(summary.warnings[0]).not.toContain('not-a-websocket')
  })
})
