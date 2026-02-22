import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

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
  return buttons.find((button) =>
    button.props['aria-label'] === 'Paste'
  )
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

    // Find the mode toggle button (sends Shift+Tab) and use it to test ctrl modifier
    const modeButton = renderer.root.findAllByType('button').find(
      (button) => button.props['aria-label'] === 'Toggle mode (Shift+Tab)'
    )
    if (!modeButton) {
      throw new Error('Expected mode toggle button')
    }

    act(() => {
      modeButton.props.onClick()
    })

    // Ctrl + Shift+Tab sends the raw escape sequence (non-letter, ctrl consumed)
    expect(sent[0]).toBe('\x1b[Z')

    // After ctrl is consumed, next press should be normal
    act(() => {
      modeButton.props.onClick()
    })

    expect(sent[1]).toBe('\x1b[Z')
  })

  test('session switcher selects sessions when multiple are present', () => {
    globalAny.navigator = { vibrate: () => true } as unknown as Navigator

    const selections: string[] = []

    const renderer = TestRenderer.create(
      <TerminalControls
        onSendKey={() => {}}
        sessions={[
          { id: 'session-1', name: 'alpha', status: 'working' },
          { id: 'session-2', name: 'beta', status: 'waiting' },
        ]}
        currentSessionId="session-1"
        onSelectSession={(id) => selections.push(id)}
      />
    )

    const sessionButtons = renderer.root
      .findAllByType('button')
      .filter((button) =>
        String(button.props.className ?? '').includes('snap-start')
      )

    expect(sessionButtons).toHaveLength(2)

    act(() => {
      sessionButtons[1]?.props.onClick()
    })

    expect(selections).toEqual(['session-2'])
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
