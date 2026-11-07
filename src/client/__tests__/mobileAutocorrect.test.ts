import { expect, test } from 'bun:test'
import type { Terminal } from '@xterm/xterm'
import { installMobileAutocorrect } from '../utils/mobileAutocorrect'

function harness(platform: 'ios' | 'android' = 'android') {
  const listeners = new Map<string, EventListener>()
  const attributes = new Map([['autocorrect', 'off'], ['spellcheck', 'false']])
  const textarea = {
    value: '',
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    removeAttribute: (name: string) => { attributes.delete(name) },
    addEventListener() {}, removeEventListener() {},
  }
  const output: string[] = []
  let ready = true
  const terminal = {
    textarea,
    element: {
      addEventListener: (name: string, handler: EventListener) => { listeners.set(name, handler) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    },
    input: (data: string) => { output.push(data); adapter.reset() },
  }
  const adapter = installMobileAutocorrect(terminal as unknown as Terminal, () => ready, platform)
  const event = (name: string, fields: Record<string, unknown> = {}, cancelable = true) => {
    const e = new Event(name, { cancelable })
    for (const [key, value] of Object.entries({ ...fields, target: textarea })) Object.defineProperty(e, key, { value })
    listeners.get(name)?.(e)
    return e
  }
  const input = (value: string, inputType = 'insertCompositionText', data: string | null = null) => {
    textarea.value = value
    event('input', { inputType, data })
  }
  return { adapter, textarea, output, attributes, listeners, event, input, block: () => { ready = false } }
}

test('Android composition corrections are explicit pastes; duplicate commits send nothing', () => {
  const h = harness()
  h.event('compositionstart')
  h.input('t'); h.input('teh'); h.input('the')
  h.event('compositionend')
  h.input('the', 'insertText', 'the')
  expect(h.output).toEqual(['t', 'eh', '\x7f\x7f\x1b[200~he\x1b[201~'])
  expect(h.textarea.value).toBe('the') // onData reset does not clear our own input
  h.adapter.dispose()
})

test('Android Return commits current text before one CR, including noncancelable input', () => {
  const h = harness()
  h.input('first')
  expect(h.event('beforeinput', { inputType: 'insertText', data: '\n' }).defaultPrevented).toBe(true)
  expect(h.output).toEqual(['first', '\r'])
  expect(h.textarea.value).toBe('')
  h.input('next')
  h.event('beforeinput', { inputType: 'insertLineBreak' }, false)
  expect(h.output.at(-1)).toBe('next')
  h.input('next\n', 'insertLineBreak')
  expect(h.output).toEqual(['first', '\r', 'next', '\r'])
  expect(h.textarea.value).toBe('')
  h.adapter.dispose()
})

test('Android input-only newline submits, while paste text is not mistaken for Return', () => {
  const h = harness()
  h.input('word\n', 'insertText', '\n')
  expect(h.output).toEqual(['word', '\r'])
  h.input('a\nb', 'insertFromPaste', 'a\nb')
  expect(h.output.at(-1)).toBe('a\nb')
  h.adapter.dispose()
})

test('Android Backspace after a reset reaches the terminal without keydown', () => {
  const h = harness()
  h.input('draft')
  h.adapter.reset()
  expect(h.event('beforeinput', { inputType: 'deleteContentBackward' }).defaultPrevented).toBe(true)
  h.input('', 'deleteContentBackward')
  expect(h.output).toEqual(['draft', '\x7f'])
  h.adapter.dispose()
})

test('blocked native input cannot replay text, delete or submit', () => {
  const h = harness()
  h.input('old')
  h.block()
  h.adapter.reset()
  h.event('beforeinput', { inputType: 'deleteContentBackward' })
  h.event('beforeinput', { inputType: 'insertText', data: '\n' })
  h.input('late', 'insertCompositionText')
  expect(h.output).toEqual(['old'])
  expect(h.textarea.value).toBe('')
  h.adapter.dispose()
})

test('iOS keeps its replacement framing and native newline behavior', () => {
  const h = harness('ios')
  h.input('teh', 'insertText')
  h.input('the', 'insertReplacementText')
  h.event('beforeinput', { inputType: 'insertLineBreak' })
  expect(h.output).toEqual(['teh', '\x7f\x7f\x1b[200~he\x1b[201~', '\r'])
  h.adapter.dispose()
  expect(h.attributes.get('autocorrect')).toBe('off')
  expect(h.attributes.get('spellcheck')).toBe('false')
  expect(h.attributes.has('autocapitalize')).toBe(false)
  expect(h.listeners.size).toBe(0)
})
