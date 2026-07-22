/**
 * Pure tests for `computeBackoffDelay`.
 *
 * The reconnect loop runs unattended for the length of a service, so this function's guarantees
 * matter more than its exact numbers: a `NaN` delay passed to `setTimeout` fires immediately and
 * turns a graceful backoff into a spin loop against a machine that is already struggling, and a
 * negative delay does the same. Every hostile input below is therefore asserted to produce a
 * finite, non-negative, capped delay.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_RECONNECT_POLICY, computeBackoffDelay } from '@shared/obs'
import type { ReconnectPolicy } from '@shared/obs'

/** No jitter: `random() === 0.5` maps to an offset of exactly zero. */
const noJitter = (): number => 0.5
/** Maximum negative jitter. */
const minJitter = (): number => 0
/** Maximum positive jitter — outside `Math.random`'s range on purpose, as a boundary probe. */
const maxJitter = (): number => 1

describe('computeBackoffDelay', () => {
  it('lands on baseDelayMs for attempt 0 when jitter is neutral', () => {
    expect(computeBackoffDelay(0, DEFAULT_RECONNECT_POLICY, noJitter)).toBe(500)
  })

  it('doubles per attempt until it saturates at maxDelayMs', () => {
    const sequence = Array.from({ length: 10 }, (_unused, attempt) =>
      computeBackoffDelay(attempt, DEFAULT_RECONNECT_POLICY, noJitter)
    )

    expect(sequence).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000])
  })

  it('is non-decreasing in attempt', () => {
    let previous = -1
    for (let attempt = 0; attempt <= 40; attempt += 1) {
      const delay = computeBackoffDelay(attempt, DEFAULT_RECONNECT_POLICY, noJitter)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })

  it('never exceeds maxDelayMs, at either jitter extreme', () => {
    for (let attempt = 0; attempt <= 60; attempt += 1) {
      for (const random of [minJitter, noJitter, maxJitter]) {
        const delay = computeBackoffDelay(attempt, DEFAULT_RECONNECT_POLICY, random)
        expect(delay).toBeLessThanOrEqual(DEFAULT_RECONNECT_POLICY.maxDelayMs)
        expect(delay).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('applies jitter symmetrically around the exponential value', () => {
    // attempt 1 -> 1000ms nominal, +/-25%.
    expect(computeBackoffDelay(1, DEFAULT_RECONNECT_POLICY, minJitter)).toBe(750)
    expect(computeBackoffDelay(1, DEFAULT_RECONNECT_POLICY, noJitter)).toBe(1000)
    expect(computeBackoffDelay(1, DEFAULT_RECONNECT_POLICY, maxJitter)).toBe(1250)
  })

  it('keeps the cap a true ceiling even with maximum positive jitter', () => {
    expect(computeBackoffDelay(20, DEFAULT_RECONNECT_POLICY, maxJitter)).toBe(
      DEFAULT_RECONNECT_POLICY.maxDelayMs
    )
  })

  it('never produces NaN, Infinity or a negative delay for hostile attempts', () => {
    const hostile = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -1000,
      0.5,
      1e9,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE
    ]

    for (const attempt of hostile) {
      for (const random of [minJitter, noJitter, maxJitter]) {
        const delay = computeBackoffDelay(attempt, DEFAULT_RECONNECT_POLICY, random)

        expect(Number.isNaN(delay)).toBe(false)
        expect(Number.isFinite(delay)).toBe(true)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(DEFAULT_RECONNECT_POLICY.maxDelayMs)
      }
    }
  })

  it('treats a huge attempt as saturated rather than overflowing to Infinity', () => {
    expect(computeBackoffDelay(5000, DEFAULT_RECONNECT_POLICY, noJitter)).toBe(30_000)
  })

  it('honours a custom policy', () => {
    const policy: ReconnectPolicy = {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      factor: 3,
      jitterRatio: 0,
      maxAttempts: null
    }

    expect(computeBackoffDelay(0, policy, noJitter)).toBe(100)
    expect(computeBackoffDelay(1, policy, noJitter)).toBe(300)
    expect(computeBackoffDelay(2, policy, noJitter)).toBe(900)
    expect(computeBackoffDelay(3, policy, noJitter)).toBe(1000)
    // jitterRatio 0 means the extremes collapse onto the nominal value.
    expect(computeBackoffDelay(1, policy, minJitter)).toBe(300)
    expect(computeBackoffDelay(1, policy, maxJitter)).toBe(300)
  })

  it('survives a degenerate policy without producing a negative or NaN delay', () => {
    const degenerate: ReconnectPolicy = {
      baseDelayMs: -500,
      maxDelayMs: -1,
      factor: 0,
      jitterRatio: 5,
      maxAttempts: null
    }

    for (let attempt = 0; attempt <= 5; attempt += 1) {
      const delay = computeBackoffDelay(attempt, degenerate, noJitter)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBe(0)
    }
  })

  it('defaults to the shared policy and Math.random when only an attempt is given', () => {
    const delay = computeBackoffDelay(3)
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBeGreaterThanOrEqual(3000)
    expect(delay).toBeLessThanOrEqual(5000)
  })
})
