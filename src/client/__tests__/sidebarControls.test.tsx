import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SidebarControls from '../components/SidebarControls'
import { getNavShortcutMod } from '../utils/device'
import type { ConnectionStatus } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  navigator?: Navigator
  window?: Window & typeof globalThis
  document?: Document
}

const originalNavigator = globalAny.navigator
const originalWindow = globalAny.window
const originalDocument = globalAny.document

afterEach(() => {
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

type Renderer = TestRenderer.ReactTestRenderer

function render(props: Partial<Parameters<typeof SidebarControls>[0]> = {}) {
  let renderer!: Renderer
  act(() => {
    renderer = TestRenderer.create(
      <SidebarControls
        connectionStatus="connected"
        onNewSession={() => {}}
        onOpenSettings={() => {}}
        tailscaleIp={null}
        {...props}
      />
    )
  })
  return renderer
}

function findDot(renderer: Renderer) {
  const dot = renderer.root.findAllByType('span').find((node) =>
    typeof node.props.className === 'string' &&
    node.props.className.includes('rounded-full')
  )
  if (!dot) throw new Error('Expected status dot')
  return dot
}

const findButton = (renderer: Renderer, label: string) =>
  renderer.root.findAllByType('button').find((b) => b.props['aria-label'] === label)

const findDotButton = (renderer: Renderer) =>
  renderer.root.findAllByType('button').find((b) => b.props['aria-haspopup'] === 'dialog')

const findPopover = (renderer: Renderer) =>
  renderer.root.findAll((n) => n.type === 'div' && n.props.role === 'dialog')[0]

const findCopyButton = (renderer: Renderer) =>
  renderer.root.findAllByType('button').find((b) =>
    b.props.title === 'Tailscale IP - click to copy remote access URL'
  )

const textOf = (renderer: Renderer) => JSON.stringify(renderer.toJSON())

describe('SidebarControls', () => {
  test('renders status dot and triggers new session', () => {
    globalAny.navigator = {
      platform: 'Win32',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
    } as unknown as Navigator

    let created = 0
    const renderer = render({ onNewSession: () => { created += 1 } })

    expect(findDot(renderer).props.className).toContain('bg-working')

    const newSessionButton = findButton(renderer, 'New session')
    if (!newSessionButton) throw new Error('Expected new session button')
    expect(newSessionButton.props.title).toBe(`New session (${getNavShortcutMod()}N)`)

    act(() => {
      newSessionButton.props.onClick()
    })
    expect(created).toBe(1)

    act(() => renderer.unmount())
  })

  test('settings button opens settings', () => {
    let opened = 0
    const renderer = render({ onOpenSettings: () => { opened += 1 } })
    const settingsButton = findButton(renderer, 'Settings')
    if (!settingsButton) throw new Error('Expected settings button')
    expect(settingsButton.props.title).toBe('Settings')
    act(() => settingsButton.props.onClick())
    expect(opened).toBe(1)
    act(() => renderer.unmount())
  })

  test('no wordmark', () => {
    const renderer = render()
    expect(textOf(renderer)).not.toContain('AGENTBOARD')
    act(() => renderer.unmount())
  })

  test.each([
    ['connected', 'bg-working', 'Connected'],
    ['connecting', 'bg-approval', 'Connecting'],
    ['reconnecting', 'bg-approval', 'Reconnecting'],
    ['disconnected', 'bg-danger', 'Disconnected'],
  ] as [ConnectionStatus, string, string][])('%s status styles and labels the dot', (status, color, label) => {
    const renderer = render({ connectionStatus: status })
    expect(findDot(renderer).props.className).toContain(color)
    const indicator = renderer.root.find((n) => n.props.role === 'img')
    expect(indicator.props['aria-label']).toBe(`Connection: ${label}`)
    expect(indicator.props.title).toBe(`Connection: ${label}`)
    act(() => renderer.unmount())
  })

  test('without a tailscale IP the dot is a plain indicator', () => {
    const renderer = render({ tailscaleIp: null })
    expect(findDotButton(renderer)).toBeUndefined()
    expect(findCopyButton(renderer)).toBeUndefined()
    expect(textOf(renderer)).not.toContain('100.')
    // Plain dot: no button chrome around it
    const indicator = renderer.root.find((n) => n.props.role === 'img')
    expect(indicator.props.className).not.toMatch(/\bborder\b/)
    expect(indicator.props.className).not.toContain('hover:')
    act(() => renderer.unmount())
  })

  test('with a tailscale IP the dot sits in a button styled like the settings gear', () => {
    const renderer = render({ tailscaleIp: '100.64.1.2', connectionStatus: 'disconnected' })
    const dotButton = findDotButton(renderer)
    const settingsButton = findButton(renderer, 'Settings')
    if (!dotButton || !settingsButton) throw new Error('Expected dot and settings buttons')
    // Same 28px bordered square, hover and focus-ring treatment as the gear
    expect(dotButton.props.className).toBe(settingsButton.props.className)
    for (const token of ['h-7', 'w-7', 'border', 'border-border', 'hover:bg-hover', 'focus-visible:ring-2']) {
      expect(dotButton.props.className.split(' ')).toContain(token)
    }
    // Status color stays on the dot inside the button, not on the button
    expect(dotButton.props.className).not.toContain('bg-danger')
    expect(dotButton.findByType('span').props.className).toContain('bg-danger')
    act(() => renderer.unmount())
  })

  test('with a tailscale IP the dot opens a popover that copies the URL', () => {
    const writes: string[] = []
    globalAny.navigator = {
      platform: 'Win32',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
      clipboard: { writeText: (text: string) => { writes.push(text); return Promise.resolve() } },
    } as unknown as Navigator
    globalAny.window = { location: { port: '4141' } } as unknown as Window & typeof globalThis

    const renderer = render({ tailscaleIp: '100.64.1.2', connectionStatus: 'reconnecting' })
    // IP is not shown inline: only the dot's tooltip carries it until opened
    expect(findPopover(renderer)).toBeUndefined()
    expect(renderer.root.findAll((n) => n.children.some((c) => typeof c === 'string' && c.includes('100.64')))).toHaveLength(0)
    expect(findDotButton(renderer)?.props.title).toBe('Reconnecting - Tailscale 100.64.1.2')

    const dotButton = findDotButton(renderer)
    if (!dotButton) throw new Error('Expected dot button')
    expect(dotButton.props['aria-expanded']).toBe(false)
    expect(dotButton.props['aria-label']).toBe('Connection: Reconnecting. Tailscale remote access')
    expect(findDot(renderer).props.className).toContain('bg-approval')

    act(() => dotButton.props.onClick())
    expect(findDotButton(renderer)?.props['aria-expanded']).toBe(true)
    const popover = findPopover(renderer)
    expect(popover).toBeDefined()
    expect(findDotButton(renderer)?.props['aria-controls']).toBe(popover.props.id)
    expect(textOf(renderer)).toContain('Reconnecting')

    const copyButton = findCopyButton(renderer)
    if (!copyButton) throw new Error('Expected copy button')
    const copyLabel = () => findCopyButton(renderer)?.findByType('span').children.join('')
    expect(copyLabel()).toBe('100.64.1.2')
    act(() => copyButton.props.onClick())
    expect(writes).toEqual(['http://100.64.1.2:4141'])
    expect(copyLabel()).toBe('Copied!')

    // Clicking the dot again closes it
    act(() => findDotButton(renderer)?.props.onClick())
    expect(findPopover(renderer)).toBeUndefined()

    act(() => renderer.unmount())
  })

  test('popover opens downward by default and upward for the bottom anchor', () => {
    const popoverClass = (placement?: 'down' | 'up') => {
      const renderer = render({ tailscaleIp: '100.64.1.2', placement })
      act(() => findDotButton(renderer)?.props.onClick())
      const className = findPopover(renderer).props.className as string
      act(() => renderer.unmount())
      return className
    }
    expect(popoverClass()).toMatch(/\btop-full\b/)
    expect(popoverClass()).not.toMatch(/\bbottom-full\b/)
    expect(popoverClass('up')).toMatch(/\bbottom-full\b/)
    expect(popoverClass('up')).not.toMatch(/\btop-full\b/)
  })

  test('Escape and outside clicks close the popover', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    globalAny.document = {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Document

    const renderer = render({ tailscaleIp: '100.64.1.2' })
    act(() => findDotButton(renderer)?.props.onClick())
    expect(listeners.has('keydown')).toBe(true)
    act(() => listeners.get('keydown')?.({ key: 'Escape' }))
    expect(findPopover(renderer)).toBeUndefined()
    expect(listeners.has('keydown')).toBe(false)

    act(() => findDotButton(renderer)?.props.onClick())
    act(() => listeners.get('mousedown')?.({ target: null }))
    expect(findPopover(renderer)).toBeUndefined()

    act(() => renderer.unmount())
  })
})
