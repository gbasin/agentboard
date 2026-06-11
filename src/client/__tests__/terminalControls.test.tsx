import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NumPad from '../components/NumPad'

const globalAny = globalThis as typeof globalThis & {
  navigator?: Navigator
  fetch?: typeof fetch
}

const originalNavigator = globalAny.navigator
const originalFetch = globalAny.fetch

const { default: TerminalControls } = await import('../components/TerminalControls')

afterEach(() => {
  globalAny.navigator = originalNavigator
  globalAny.fetch = originalFetch
})

function clipboardWithImage() {
  return {
    read: () =>
      Promise.resolve([
        {
          types: ['image/png'],
          getType: () =>
            Promise.resolve(
              new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
            ),
        },
      ]),
    readText: () => Promise.reject(new Error('no text')),
  }
}

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

  test('paste button uploads clipboard image and sends the stored path', async () => {
    const sent: string[] = []
    const requests: Array<{ url: string; init?: RequestInit }> = []

    globalAny.navigator = {
      vibrate: () => true,
      clipboard: clipboardWithImage(),
    } as unknown as Navigator

    globalAny.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ path: '/tmp/paste-test.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

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

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/paste-image')
    expect(sent).toEqual(['/tmp/paste-test.png'])
  })

  test('shows the server error when an image upload is rejected', async () => {
    const sent: string[] = []

    globalAny.navigator = {
      vibrate: () => true,
      clipboard: clipboardWithImage(),
    } as unknown as Navigator

    globalAny.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Image too large' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

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

    // Nothing was pasted, and the paste modal opens showing the failure
    expect(sent).toEqual([])
    const alert = renderer.root
      .findAllByType('p')
      .find((p) => p.props.role === 'alert')
    if (!alert) {
      throw new Error('Expected upload error message')
    }
    expect(alert.props.children).toBe('Image too large')
  })

  test('clears the upload error when the paste modal is cancelled', async () => {
    globalAny.navigator = {
      vibrate: () => true,
      clipboard: clipboardWithImage(),
    } as unknown as Navigator

    globalAny.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Unsupported image type' }), {
        status: 415,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const renderer = TestRenderer.create(
      <TerminalControls
        onSendKey={() => {}}
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

    const cancelButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Cancel')
    if (!cancelButton) {
      throw new Error('Expected cancel button')
    }

    act(() => {
      cancelButton.props.onClick()
    })

    expect(
      renderer.root.findAllByType('p').some((p) => p.props.role === 'alert')
    ).toBe(false)
  })
})
