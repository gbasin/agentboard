import { afterEach, describe, expect, test } from 'bun:test'
import type { UpdateState } from '@shared/types'
import { startUpdateChecker, type UpdateChecker } from '../updates/updateChecker'
import type { LatestRelease, ReleaseFeed } from '../updates/releaseFeed'

/** Scripted feed: each `latest()` call pulls the next response. */
function fakeFeed(script: Array<LatestRelease | null>) {
  let call = 0
  const feed: ReleaseFeed = {
    latest: async () => {
      const step = script[Math.min(call, script.length - 1)]!
      call += 1
      return step
    },
  }
  return { feed, calls: () => call }
}

const release = (tag: string): LatestRelease => ({ tag, htmlUrl: `https://example.com/${tag}`, assets: [] })

let checker: UpdateChecker | null = null
afterEach(() => {
  checker?.stop()
  checker = null
})

describe('updateChecker', () => {
  test('a newer base becomes the reported target and fires onChange once', async () => {
    const { feed } = fakeFeed([release('v1.2.0-7')])
    const states: UpdateState[] = []
    checker = startUpdateChecker({
      feed,
      currentVersion: '1.1.0-3',
      intervalMs: 60_000,
      onChange: state => states.push(state),
    })
    await checker.check()
    expect(checker.getState()).toEqual({
      current: '1.1.0-3',
      target: { tag: 'v1.2.0-7', base: '1.2.0', htmlUrl: 'https://example.com/v1.2.0-7' },
    })
    expect(states).toHaveLength(1)
    // A repeat with the same release changes nothing and stays silent.
    await checker.check()
    expect(states).toHaveLength(1)
  })

  test('a same-base or older release reports no target', async () => {
    const sameBase = fakeFeed([release('v1.1.0-400')])
    checker = startUpdateChecker({ feed: sameBase.feed, currentVersion: '1.1.0-3', intervalMs: 60_000 })
    await checker.check()
    expect(checker.getState().target).toBeNull()

    const older = fakeFeed([release('v1.0.9-9')])
    checker.stop()
    checker = startUpdateChecker({ feed: older.feed, currentVersion: '1.1.0-dev', intervalMs: 60_000 })
    await checker.check()
    expect(checker.getState().target).toBeNull()
    expect(checker.getState().current).toBe('1.1.0-dev')
  })

  test('a silent failure leaves the previous state unchanged', async () => {
    const { feed } = fakeFeed([release('v1.2.0-7'), null, release('v1.2.0-7')])
    checker = startUpdateChecker({ feed, currentVersion: '1.1.0-3', intervalMs: 60_000 })
    await checker.check()
    const before = checker.getState()
    await checker.check()
    expect(checker.getState()).toEqual(before)
    // The next successful check is unaffected by the failure.
    await checker.check()
    expect(checker.getState().target?.tag).toBe('v1.2.0-7')
  })

  test('an update that disappears clears the target', async () => {
    const { feed } = fakeFeed([release('v1.2.0-7'), release('v1.1.0-3')])
    const states: UpdateState[] = []
    checker = startUpdateChecker({
      feed,
      currentVersion: '1.1.0-3',
      intervalMs: 60_000,
      onChange: state => states.push(state),
    })
    await checker.check()
    await checker.check()
    expect(checker.getState().target).toBeNull()
    expect(states).toHaveLength(2)
  })

  test('the periodic timer drives checks without an explicit check() call', async () => {
    let calls = 0
    let checkedThreeTimes!: () => void
    const threeChecks = new Promise<void>(resolve => { checkedThreeTimes = resolve })
    const feed: ReleaseFeed = {
      latest: async () => {
        if (++calls === 3) checkedThreeTimes()
        return release('v1.2.0-7')
      },
    }
    checker = startUpdateChecker({ feed, currentVersion: '1.1.0-3', intervalMs: 10 })
    // Await startup plus two timer checks; a loaded worker may delay timers.
    await threeChecks
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(checker.getState().target?.tag).toBe('v1.2.0-7')
  })

  test('stop() halts the timer', async () => {
    const { feed, calls } = fakeFeed([release('v1.2.0-7')])
    checker = startUpdateChecker({ feed, currentVersion: '1.1.0-3', intervalMs: 10 })
    await new Promise(resolve => setTimeout(resolve, 30))
    checker.stop()
    const atStop = calls()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(calls()).toBe(atStop)
  })

  test('a feed that throws outright is absorbed, not propagated', async () => {
    const feed: ReleaseFeed = {
      latest: () => Promise.reject(new Error('network gone')),
    }
    checker = startUpdateChecker({ feed, currentVersion: '1.1.0-3', intervalMs: 60_000 })
    await expect(checker.check()).resolves.toBeUndefined()
    expect(checker.getState().target).toBeNull()
  })
})
