import { describe, expect, test } from 'bun:test'
import { KillRateLimiter } from '../killRateLimit'

describe('KillRateLimiter', () => {
  test('allows a burst up to the limit, then refuses', () => {
    const limiter = new KillRateLimiter(3, 5_000)
    expect(limiter.tryAcquire('c1', 0)).toBe(true)
    expect(limiter.tryAcquire('c1', 100)).toBe(true)
    expect(limiter.tryAcquire('c1', 200)).toBe(true)
    expect(limiter.tryAcquire('c1', 300)).toBe(false)
    expect(limiter.tryAcquire('c1', 400)).toBe(false)
  })

  test('refused attempts do not extend the window', () => {
    const limiter = new KillRateLimiter(2, 1_000)
    limiter.tryAcquire('c1', 0)
    limiter.tryAcquire('c1', 10)
    expect(limiter.tryAcquire('c1', 900)).toBe(false)
    expect(limiter.tryAcquire('c1', 1_001)).toBe(true)
  })

  test('tracks connections independently', () => {
    const limiter = new KillRateLimiter(1, 1_000)
    expect(limiter.tryAcquire('c1', 0)).toBe(true)
    expect(limiter.tryAcquire('c2', 0)).toBe(true)
    expect(limiter.tryAcquire('c1', 1)).toBe(false)
  })

  test('forget clears a connection', () => {
    const limiter = new KillRateLimiter(1, 1_000)
    limiter.tryAcquire('c1', 0)
    limiter.forget('c1')
    expect(limiter.tryAcquire('c1', 1)).toBe(true)
  })
})
