import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { clientLog, setClientLogLevel } from '../utils/clientLog'

const fetchMock = mock(() => Promise.resolve())

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockClear()
  setClientLogLevel('info') // reset to default
})

afterEach(() => {
  setClientLogLevel('info')
})

describe('clientLog', () => {
  test('default level is info — debug calls do not fetch', () => {
    clientLog('debug-event')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('setClientLogLevel("debug") enables debug logs', () => {
    setClientLogLevel('debug')
    clientLog('debug-event')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('setClientLogLevel("error") suppresses info and warn but not error', () => {
    setClientLogLevel('error')
    clientLog('info-event', undefined, 'info')
    clientLog('warn-event', undefined, 'warn')
    expect(fetchMock).not.toHaveBeenCalled()

    clientLog('error-event', undefined, 'error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('invalid level is ignored', () => {
    setClientLogLevel('error')
    setClientLogLevel('banana')
    // still at 'error' — info should be suppressed
    clientLog('info-event', undefined, 'info')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('sends correct JSON body', () => {
    clientLog('my-event', { foo: 'bar' }, 'info')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/client-log')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({
      event: 'my-event',
      data: { foo: 'bar' },
      level: 'info',
    })
  })

  test('explicit level="warn" respects the threshold', () => {
    setClientLogLevel('error')
    clientLog('warn-event', undefined, 'warn')
    expect(fetchMock).not.toHaveBeenCalled()

    setClientLogLevel('warn')
    clientLog('warn-event', undefined, 'warn')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('fetch errors are swallowed silently', () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('network'))) as unknown as typeof fetch
    expect(() => clientLog('event', undefined, 'info')).not.toThrow()
  })
})
