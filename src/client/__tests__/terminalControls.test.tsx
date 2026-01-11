import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NumPad from '../components/NumPad'

const globalAny = globalThis as typeof globalThis & {
  navigator?: Navigator
  fetch?: typeof fetch
}

const originalNavigator = globalAny.navigator

const { default: TerminalControls } = await import('../components/TerminalControls')

afterEach(() => {
  globalAny.navigator = originalNavigator
})

function findPasteButton(renderer: TestRenderer.ReactTestRenderer) {
  const buttons = renderer.root.findAllByType('button')
  return buttons.find((button) => {
    const child = button.props.children
    return (
      child?.type === 'svg' &&
      child.props?.stroke === 'currentColor' &&
      child.props?.fill === 'none'
    )
  })
}

describe('TerminalControls', () => {
  test('ctrl toggle modifies keys and resets', () => {
    globalAny.navigator = { vibrate: () => true } as unknown as Navigator

    const sent: string[] = []

    const renderer = TestRenderer.create(
      <TerminalControls
        onSendKey={(key) => sent.push(key)}
        sessions={[{ id: 'session-1', name: 'alpha', status: 'working' }]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )

    const ctrlButton = renderer.root.findAllByType('button').find(
      (button) => button.props.children === 'ctrl'
    )
    if (!ctrlButton) {
      throw new Error('Expected ctrl button')
    }

    act(() => {
      ctrlButton.props.onClick()
    })

    const numpad = renderer.root.findByType(NumPad)

    act(() => {
      numpad.props.onSendKey('a')
    })

    expect(sent[0]).toBe(String.fromCharCode(1))

    act(() => {
      numpad.props.onSendKey('a')
    })

    expect(sent[1]).toBe('a')
  })

  test('paste button uses clipboard text fallback and refocuses', async () => {
    let refocused = false
    const sent: string[] = []

    globalAny.navigator = {
      vibrate: () => true,
      clipboard: {
        read: () => Promise.reject(new Error('no clipboard')),
        readText: () => Promise.resolve('pasted text'),
      },
    } as unknown as Navigator

    const renderer = TestRenderer.create(
      <TerminalControls
        onSendKey={(key) => sent.push(key)}
        sessions={[{ id: 'session-1', name: 'alpha', status: 'working' }]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
        onRefocus={() => {
          refocused = true
        }}
        isKeyboardVisible={() => true}
      />
    )

    const pasteButton = findPasteButton(renderer)
    if (!pasteButton) {
      throw new Error('Expected paste button')
    }

    await act(async () => {
      await pasteButton.props.onClick()
    })

    expect(sent).toEqual(['pasted text'])
    expect(refocused).toBe(true)
  })

  test('manual paste input sends text on enter', async () => {
    const sent: string[] = []

    globalAny.navigator = {
      vibrate: () => true,
      clipboard: {
        read: () => Promise.reject(new Error('no clipboard')),
        readText: () => Promise.reject(new Error('no text')),
      },
    } as unknown as Navigator

    const renderer = TestRenderer.create(
      <TerminalControls
        onSendKey={(key) => sent.push(key)}
        sessions={[{ id: 'session-1', name: 'alpha', status: 'working' }]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )

    const pasteButton = findPasteButton(renderer)
    if (!pasteButton) {
      throw new Error('Expected paste button')
    }

    await act(async () => {
      await pasteButton.props.onClick()
    })

    const input = renderer.root.findByType('input')

    act(() => {
      input.props.onChange({ target: { value: 'manual' } })
    })

    act(() => {
      input.props.onKeyDown({
        key: 'Enter',
        preventDefault: () => {},
      })
    })

    expect(sent).toEqual(['manual'])
  })
})
