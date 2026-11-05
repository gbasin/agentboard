// copyTextExact (copy-chat-message-markdown D3): the outcome table C1–C5 and
// the byte-for-byte round-trip property P1, through stubbed browser globals —
// `window.isSecureContext`, `navigator.clipboard.writeText`, and a document
// whose `execCommand('copy')` dispatches a `copy` event with recording
// `clipboardData`. Every stub is restored after each test.
import { afterEach, describe, expect, test } from 'bun:test'
import { copyTextExact } from '../utils/copyText'

type Fallback = 'listener ran, execCommand true' | 'execCommand false' | 'execCommand throws' | 'listener did not run'
type Async = 'resolves' | 'rejects' | '*'

interface Harness { asyncCalls: string[]; fallbackCalls: number; clipboard: string | null; listenersLeft: () => number }

const originals = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
}
const restore = (key: keyof typeof originals) => {
  const descriptor = originals[key]
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else delete (globalThis as Record<string, unknown>)[key]
}
afterEach(() => { restore('window'); restore('navigator'); restore('document') })

const define = (key: string, value: unknown) =>
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

/** Installs the browser stubs for one row and returns what they record. */
function install(asyncAvailable: boolean, asyncResult: Async, fallback: Fallback): Harness {
  const harness: Harness = { asyncCalls: [], fallbackCalls: 0, clipboard: null, listenersLeft: () => listeners.size }
  const listeners = new Set<(event: ClipboardEvent) => void>()
  define('window', { isSecureContext: asyncAvailable })
  define('navigator', {
    clipboard: {
      writeText: (text: string) => {
        harness.asyncCalls.push(text)
        if (asyncResult === 'rejects') return Promise.reject(new Error('NotAllowedError'))
        harness.clipboard = text
        return Promise.resolve()
      },
    },
  })
  define('document', {
    addEventListener: (type: string, listener: (event: ClipboardEvent) => void) => { if (type === 'copy') listeners.add(listener) },
    removeEventListener: (type: string, listener: (event: ClipboardEvent) => void) => { if (type === 'copy') listeners.delete(listener) },
    execCommand: (command: string) => {
      harness.fallbackCalls += 1
      if (command !== 'copy') return false
      if (fallback === 'execCommand throws') throw new Error('SecurityError')
      if (fallback === 'execCommand false') return false
      if (fallback === 'listener did not run') return true
      let data: string | null = null
      const event = {
        clipboardData: { setData: (type: string, value: string) => { if (type === 'text/plain') data = value } },
        preventDefault: () => { harness.clipboard = data },
      } as unknown as ClipboardEvent
      for (const listener of listeners) listener(event)
      return true
    },
  })
  return harness
}

// Design table "Copy outcome", verbatim; C3 and C5 expand their fallback alternatives.
const OUTCOME: Array<[id: string, asyncAvailable: boolean, asyncResult: Async, fallback: Fallback | '*', outcome: 'Copied' | 'Copy failed', asyncCalled: boolean, fallbackCalled: boolean]> = [
  ['C1', true, 'resolves', '*', 'Copied', true, false],
  ['C2', true, 'rejects', 'listener ran, execCommand true', 'Copied', true, true],
  ['C3 (execCommand false)', true, 'rejects', 'execCommand false', 'Copy failed', true, true],
  ['C3 (throws)', true, 'rejects', 'execCommand throws', 'Copy failed', true, true],
  ['C3 (listener did not run)', true, 'rejects', 'listener did not run', 'Copy failed', true, true],
  ['C4', false, '*', 'listener ran, execCommand true', 'Copied', false, true],
  ['C5 (execCommand false)', false, '*', 'execCommand false', 'Copy failed', false, true],
  ['C5 (throws)', false, '*', 'execCommand throws', 'Copy failed', false, true],
  ['C5 (listener did not run)', false, '*', 'listener did not run', 'Copy failed', false, true],
]

describe('copyTextExact outcome (C1–C5)', () => {
  for (const [id, asyncAvailable, asyncResult, fallback, outcome, asyncCalled, fallbackCalled] of OUTCOME) {
    test(`${id}: async ${asyncAvailable ? 'available' : 'unavailable'}, ${asyncResult}, fallback ${fallback} → ${outcome}`, async () => {
      const text = '# Title\r\n\n- item'
      const harness = install(asyncAvailable, asyncResult, fallback === '*' ? 'listener ran, execCommand true' : fallback)
      const copied = await copyTextExact(text)
      expect(copied ? 'Copied' : 'Copy failed').toBe(outcome)
      expect(harness.asyncCalls.length > 0).toBe(asyncCalled)
      expect(harness.fallbackCalls > 0).toBe(fallbackCalled)
      expect(harness.clipboard).toBe(outcome === 'Copied' ? text : null)
      // The one-shot listener never outlives the call.
      expect(harness.listenersLeft()).toBe(0)
    })
  }

  test('no window at all reads as an insecure context and uses the fallback', async () => {
    const harness = install(false, '*', 'listener ran, execCommand true')
    delete (globalThis as Record<string, unknown>).window
    expect(await copyTextExact('x')).toBe(true)
    expect(harness.asyncCalls).toEqual([])
  })
})

/** Seeded LCG (Numerical Recipes constants); deterministic across runs. */
function lcg(seed: number) {
  let state = seed >>> 0
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000
}
const POOL = ['#', '## ', '- ', '1. ', '```', '```ts\n', '|', ' | ', '[a](b)', '~~', '**', '`', '\r\n', '\n', '\r', '\t',
  '  ', 'text', '😀', '𝔘', 'שלום', '‏', '\\', '<b>', '&amp;']

describe('copyTextExact round trip (P1)', () => {
  for (const path of ['C1', 'C4'] as const) {
    test(`P1: ${path} path copies 200 generated strings byte for byte (seed 0x5eed)`, async () => {
      const next = lcg(0x5eed)
      for (let i = 0; i < 200; i++) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 24) }, () => POOL[Math.floor(next() * POOL.length)]!)
        const text = parts.join('')
        const harness = path === 'C1'
          ? install(true, 'resolves', 'listener ran, execCommand true')
          : install(false, '*', 'listener ran, execCommand true')
        expect(await copyTextExact(text)).toBe(true)
        expect(harness.clipboard).toBe(text)
      }
    })
  }
})
