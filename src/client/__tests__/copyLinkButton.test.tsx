import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { CopyLinkButton } from '../components/CopyLinkButton'
import { copyTextWithResult } from '../utils/copyTextWithResult'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
let renderer: TestRenderer.ReactTestRenderer | undefined
function install(name: string, value: unknown) { Object.defineProperty(globalThis, name, { configurable: true, value }) }
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  for (const [name, descriptor] of [['document', originalDocument], ['navigator', originalNavigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})
function render(url = 'https://example.com/path?q=full#fragment') {
  act(() => { renderer = TestRenderer.create(<CopyLinkButton url={url} label="Example" />) })
  return () => renderer!.root.findByType('button')
}
const click = { preventDefault() {}, stopPropagation() {}, currentTarget: { focus() {} } }

describe('CopyLinkButton', () => {
  test('copies complete destination and confirms only after successful clipboard write', async () => {
    install('document', undefined)
    let copied = ''
    let resolve!: () => void
    install('navigator', { clipboard: { writeText: (text: string) => { copied = text; return new Promise<void>(r => { resolve = r }) } } })
    const url = 'https://example.com/' + 'x'.repeat(3000) + '?q=unchanged#fragment'
    const button = render(url)
    act(() => button().props.onClick(click))
    expect(copied).toBe(url)
    expect(button().props['data-copy-state']).toBe('copying')
    await act(async () => resolve())
    expect(button().props['data-copy-state']).toBe('copied')
  })
  test('rejects false success when clipboard is unavailable or denied', async () => {
    install('document', undefined)
    install('navigator', {})
    const button = render()
    await act(async () => button().props.onClick(click))
    expect(button().props['data-copy-state']).toBe('failed')
    install('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    await act(async () => button().props.onClick(click))
    expect(button().props['data-copy-state']).toBe('failed')
    expect(renderer!.root.findByProps({ role: 'status' }).children.join('')).toContain('Could not copy')
  })
  test('ignores a pending result after changing the destination', async () => {
    install('document', undefined)
    let resolve!: () => void
    install('navigator', { clipboard: { writeText: () => new Promise<void>(r => { resolve = r }) } })
    const button = render()
    act(() => button().props.onClick(click))
    act(() => renderer!.update(<CopyLinkButton url="https://other.example" label="Other" />))
    await act(async () => resolve())
    expect(button().props['data-copy-state']).toBe('idle')
  })
  test('clears success feedback timers on unmount', async () => {
    install('document', undefined)
    install('navigator', { clipboard: { writeText: () => Promise.resolve() } })
    const originalSet = globalThis.setTimeout
    const originalClear = globalThis.clearTimeout
    const pending = new Set<number>()
    install('setTimeout', () => { pending.add(123); return 123 })
    install('clearTimeout', (id: number) => pending.delete(id))
    try {
      const button = render()
      await act(async () => button().props.onClick(click))
      expect(pending.size).toBe(1)
      act(() => renderer!.unmount())
      expect(pending.size).toBe(0)
      renderer = undefined
    } finally { install('setTimeout', originalSet); install('clearTimeout', originalClear) }
  })
  test('HTTP fallback selects full text, prevents keyboard opening and restores focus', async () => {
    let selected: number[] = []
    let restored = false
    let removed = false
    const textarea = { value: '', readOnly: false, style: {}, focus() {}, select() {},
      setSelectionRange(start: number, end: number) { selected = [start, end] }, remove() { removed = true } }
    install('navigator', {})
    install('document', { activeElement: { focus() { restored = true } }, createElement: () => textarea,
      body: { appendChild() {} }, execCommand: () => true })
    expect(await copyTextWithResult('full destination')).toBe(true)
    expect(textarea.value).toBe('full destination')
    expect(textarea.readOnly).toBe(true)
    expect(selected).toEqual([0, 16])
    expect(restored && removed).toBe(true)
  })
  test('failed synchronous fallback never claims success', async () => {
    install('navigator', {})
    install('document', { activeElement: null, createElement: () => ({ style: {}, focus() {}, select() {}, setSelectionRange() {}, remove() {} }),
      body: { appendChild() {} }, execCommand: () => false })
    expect(await copyTextWithResult('url')).toBe(false)
  })
  test('copy clicks and keyboard events do not propagate into terminal shortcuts', async () => {
    install('document', undefined)
    install('navigator', {})
    let stopped = 0, prevented = 0
    const button = render()
    const event = { ...click, stopPropagation() { stopped++ }, preventDefault() { prevented++ } }
    await act(async () => button().props.onClick(event))
    button().props.onKeyDown(event)
    button().props.onKeyUp(event)
    expect(stopped).toBe(3)
    expect(prevented).toBe(1)
  })
})
