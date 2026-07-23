import { describe, expect, it } from 'vitest'

import { OBS_DEFAULT_WS_PORT, normalizeObsUrl, obsUrlSchema } from './config'

/**
 * `normalizeObsUrl` exists because of a real first-contact failure: OBS's "Show Connect Info"
 * lists a Server IP, a Server Port and a Server Password as three separate boxes, none of them a
 * URL, and assembling one by hand fails cryptically. These cases are the exact inputs an operator
 * produces from that screen — including the two that produced `ECONNREFUSED …:80` and
 * `ENETUNREACH 0.0.17.103` in the field.
 */
describe('normalizeObsUrl', () => {
  it('completes a bare host to loopback-style ws:// with the default port', () => {
    expect(normalizeObsUrl('127.0.0.1')).toBe(`ws://127.0.0.1:${OBS_DEFAULT_WS_PORT}`)
  })

  it('adds the scheme to a host:port', () => {
    expect(normalizeObsUrl('127.0.0.1:4455')).toBe('ws://127.0.0.1:4455')
  })

  it('fills in the port when a scheme+host has none — the ECONNREFUSED :80 case', () => {
    expect(normalizeObsUrl('ws://127.0.0.1')).toBe('ws://127.0.0.1:4455')
  })

  it('treats a lone port number as loopback on that port — the 0.0.17.103 case', () => {
    // `4455` parsed as an integer IP is 0.0.17.103; this is the mistake that produced ENETUNREACH.
    expect(normalizeObsUrl('4455')).toBe('ws://127.0.0.1:4455')
  })

  it('keeps a host and a non-default port the operator actually typed', () => {
    expect(normalizeObsUrl('192.168.1.50:4460')).toBe('ws://192.168.1.50:4460')
  })

  it('leaves an already-valid wss:// URL untouched', () => {
    expect(normalizeObsUrl('wss://obs.example.org:4455')).toBe('wss://obs.example.org:4455')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeObsUrl('   127.0.0.1:4455  ')).toBe('ws://127.0.0.1:4455')
  })

  it('returns empty for empty input rather than inventing a URL', () => {
    expect(normalizeObsUrl('')).toBe('')
    expect(normalizeObsUrl('   ')).toBe('')
  })

  it('does not rewrite a non-ws scheme — validation should reject it clearly instead', () => {
    // Someone pasting a browser URL should get the "must be ws://" message, not a silent rewrite.
    expect(normalizeObsUrl('http://127.0.0.1:4455')).toBe('http://127.0.0.1:4455')
  })

  it('leaves a garbled value malformed rather than rescuing it into a nonsense host', () => {
    // Must stay invalid so `loadConfig` reports "not configured" — not become ws://ws:4455/...
    const garbled = 'ws//missing-colon'
    expect(normalizeObsUrl(garbled)).toBe(garbled)
    expect(obsUrlSchema.safeParse(normalizeObsUrl(garbled)).success).toBe(false)
  })

  it('produces a URL the OBS schema accepts, for every input an operator can produce from OBS', () => {
    for (const input of [
      '127.0.0.1',
      '127.0.0.1:4455',
      'ws://127.0.0.1',
      '4455',
      '192.168.1.50:4460'
    ]) {
      const normalized = normalizeObsUrl(input)
      expect(obsUrlSchema.safeParse(normalized).success, `${input} -> ${normalized}`).toBe(true)
    }
  })
})
