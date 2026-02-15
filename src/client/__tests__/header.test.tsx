import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import Header from '../components/Header'
import { getNavShortcutMod } from '../utils/device'

const globalAny = globalThis as typeof globalThis & {
  navigator?: Navigator
}

const originalNavigator = globalAny.navigator

afterEach(() => {
  globalAny.navigator = originalNavigator
})

describe('Header', () => {
  test('renders status dot and triggers new session', () => {
    globalAny.navigator = {
      platform: 'Win32',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
    } as unknown as Navigator

    let created = 0
    const renderer = TestRenderer.create(
      <Header connectionStatus="connected" onNewSession={() => { created += 1 }} onOpenSettings={() => {}} tailscaleIp={null} />
    )

    const statusDot = renderer.root.findAllByType('span').find((node) =>
      typeof node.props.className === 'string' &&
      node.props.className.includes('rounded-full')
    )
    if (!statusDot) {
      throw new Error('Expected status dot')
    }
    expect(statusDot.props.className).toContain('bg-working')

    const buttons = renderer.root.findAllByType('button')
    const newSessionButton = buttons.find((b) => b.props['aria-label'] === 'New session')
    if (!newSessionButton) {
      throw new Error('Expected new session button')
    }
    expect(newSessionButton.props.title).toBe(`New session (${getNavShortcutMod()}N)`)

    act(() => {
      newSessionButton.props.onClick()
    })

    expect(created).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('shows disconnected status styling', () => {
    const renderer = TestRenderer.create(
      <Header connectionStatus="disconnected" onNewSession={() => {}} onOpenSettings={() => {}} tailscaleIp={null} />
    )

    const statusDot = renderer.root.findAllByType('span').find((node) =>
      typeof node.props.className === 'string' &&
      node.props.className.includes('rounded-full')
    )
    if (!statusDot) {
      throw new Error('Expected status dot')
    }

    expect(statusDot.props.className).toContain('bg-danger')

    act(() => {
      renderer.unmount()
    })
  })

  test('displays tailscale IP when provided', () => {
    const renderer = TestRenderer.create(
      <Header connectionStatus="connected" onNewSession={() => {}} onOpenSettings={() => {}} tailscaleIp="100.64.1.2" />
    )

    const buttons = renderer.root.findAllByType('button')
    const ipButton = buttons.find((node) =>
      node.props.title === 'Tailscale IP - click to copy remote access URL'
    )
    expect(ipButton).toBeDefined()

    // Check that the IP text is rendered inside a span
    const ipSpan = renderer.root.findAllByType('span').find((node) =>
      Array.isArray(node.children) && node.children.includes('100.64.1.2')
    )
    expect(ipSpan).toBeDefined()

    act(() => {
      renderer.unmount()
    })
  })

  test('does not display tailscale IP when null', () => {
    const renderer = TestRenderer.create(
      <Header connectionStatus="connected" onNewSession={() => {}} onOpenSettings={() => {}} tailscaleIp={null} />
    )

    const spans = renderer.root.findAllByType('span')
    const ipSpan = spans.find((node) =>
      Array.isArray(node.children) && node.children.some((c) => typeof c === 'string' && c.includes('100.'))
    )
    expect(ipSpan).toBeUndefined()

    act(() => {
      renderer.unmount()
    })
  })
})
