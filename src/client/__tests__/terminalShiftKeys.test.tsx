import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import TerminalControls from '../components/TerminalControls'

const originalDocument = globalThis.document
const originalWindow = globalThis.window
let renderer: TestRenderer.ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  globalThis.document = originalDocument
  globalThis.window = originalWindow
})

function setup() {
  const doc = new EventTarget()
  globalThis.document = doc as unknown as Document
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis
  const sent: string[] = []
  const render = (session = 'one', disabled = false) => (
    <TerminalControls onSendKey={key => sent.push(key)} sessions={[]}
      currentSessionId={session} onSelectSession={() => {}} disabled={disabled} />
  )
  act(() => { renderer = TestRenderer.create(render()) })
  const shift = (active: boolean) => {
    act(() => { doc.dispatchEvent(Object.assign(new Event(active ? 'keydown' : 'keyup'), { key: 'Shift' })) })
  }
  const button = (label: string) => renderer!.root.findAllByType('button').find(
    b => b.props['aria-label'] === label || b.props.children === label
  )!
  const click = (label: string) => { act(() => button(label).props.onClick()) }
  return { sent, doc, render, shift, button, click }
}

describe('keyboard Shift with quick keys', () => {
  test('plain Tab, shifted touch taps and Shift release', () => {
    const { sent, shift, button, click } = setup()
    click('tab')
    shift(true)
    // iOS touch events do not include the software keyboard modifier state.
    const point = { clientX: 100, clientY: 100 }
    const touch = { preventDefault() {}, stopPropagation() {}, touches: [point], changedTouches: [point], shiftKey: false }
    const deck = renderer!.root.findAllByType('div').find(d => d.props.onTouchStartCapture)!
    act(() => deck.props.onTouchStartCapture(touch))
    act(() => button('tab').props.onTouchEnd(touch))
    act(() => button('tab').props.onTouchEnd(touch))
    shift(false)
    act(() => button('tab').props.onTouchEnd(touch))
    expect(sent).toEqual(['\t', '\x1b[Z', '\x1b[Z', '\t'])
  })

  test('shifted Tab preserves armed Ctrl and Shift+Enter inserts a newline', () => {
    const { sent, shift, click } = setup()
    shift(true)
    click('ctrl')
    click('tab')
    act(() => { document.dispatchEvent(Object.assign(new Event('keydown'), {
      key: 'a', stopPropagation() {},
    })) })
    click('Enter')
    expect(sent).toEqual(['\x1b[Z', '\x01', '\x1b[13;2u'])
  })

  test('Shift+Enter repeats without submitting and plain Enter resumes after release', () => {
    const { sent, shift, click } = setup()
    shift(true)
    click('Enter')
    click('Enter')
    shift(false)
    click('Enter')
    expect(sent).toEqual(['\x1b[13;2u', '\x1b[13;2u', '\r'])
  })

  test('focus loss and session changes reset Shift; disabled Tab sends nothing', () => {
    const { sent, doc, render, shift, click } = setup()
    shift(true)
    act(() => { doc.dispatchEvent(new Event('focusout')) })
    click('tab')
    shift(true)
    act(() => renderer!.update(render('two')))
    click('tab')
    shift(true)
    act(() => renderer!.update(render('two', true)))
    click('tab')
    act(() => renderer!.update(render('two')))
    click('tab')
    expect(sent).toEqual(['\t', '\t', '\t'])
  })
})
