import { describe, expect, test } from 'bun:test'
import { createInfoBatcher, createMetadataScheduler } from '../lib/prMetadataRequests'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('PR metadata HTTP budget', () => {
  test('coalesces eight URLs, dedupes late mounts, and reserves capacity for media and checks', async () => {
    const schedule = createMetadataScheduler()
    const gates = Array.from({ length: 3 }, () => deferred<{ url: string }[]>())
    const calls: string[][] = []
    const info = createInfoBatcher<{ url: string }>(urls => schedule('info', async () => {
      const index = calls.push(urls) - 1
      return gates[index].promise
    }), item => item.url)
    const pending = Array.from({ length: 18 }, (_, i) => info(`pr-${i}`))
    await tick()
    expect(calls).toEqual([Array.from({ length: 8 }, (_, i) => `pr-${i}`)])
    expect(info('pr-2')).toBe(pending[2])
    expect(info('pr-17')).toBe(pending[17])
    const checkGate = deferred<void>()
    let checks = 0
    const check1 = schedule('checks', async () => { checks++; await checkGate.promise })
    const check2 = schedule('checks', async () => { checks++ })
    await tick()
    expect(checks).toBe(1)
    gates[0].resolve(calls[0].map(url => ({ url })))
    await tick()
    expect(calls[1]).toEqual(Array.from({ length: 8 }, (_, i) => `pr-${i + 8}`))
    gates[1].resolve(calls[1].map(url => ({ url })))
    await tick()
    expect(calls[2]).toEqual(['pr-16', 'pr-17'])
    gates[2].resolve(calls[2].map(url => ({ url })))
    expect((await Promise.all(pending)).map(item => item?.url)).toEqual(Array.from({ length: 18 }, (_, i) => `pr-${i}`))
    checkGate.resolve()
    await Promise.all([check1, check2])
    expect(checks).toBe(2)
  })

  test('deadline aborts the active request and admits the next batch; failures can retry', async () => {
    const schedule = createMetadataScheduler(10)
    let attempts = 0
    let signal!: AbortSignal
    const info = createInfoBatcher<{ url: string }>(urls => schedule('info', current => {
      attempts++
      if (attempts > 1) return Promise.resolve(urls.map(url => ({ url })))
      signal = current
      return new Promise((_resolve, reject) => current.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    }), item => item.url)
    const first = info('retry').catch(error => error.message)
    await tick()
    const second = info('queued')
    expect(await first).toBe('timeout')
    expect(signal.aborted).toBe(true)
    expect(await second).toEqual({ url: 'queued' })
    expect(await info('retry')).toEqual({ url: 'retry' })
    expect(attempts).toBe(3)
  })
})
