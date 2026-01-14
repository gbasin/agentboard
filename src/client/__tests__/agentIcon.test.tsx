import { describe, expect, test, mock } from 'bun:test'
import TestRenderer from 'react-test-renderer'

const iconStub =
  (testId: string) =>
  ({ className }: { className?: string }) => (
    <svg data-testid={testId} className={className} />
  )

mock.module('@untitledui-icons/react/line', () => ({
  HandIcon: iconStub('hand-icon'),
  PlusIcon: iconStub('plus-icon'),
  FolderIcon: iconStub('folder-icon'),
  MoveIcon: iconStub('move-icon'),
  TerminalIcon: iconStub('terminal-icon'),
  CornerDownLeftIcon: iconStub('corner-down-left-icon'),
  XCloseIcon: iconStub('x-close-icon'),
  DotsVerticalIcon: iconStub('dots-vertical-icon'),
  Menu01Icon: iconStub('menu-01-icon'),
}))

const { default: AgentIcon } = await import('../components/AgentIcon')

describe('AgentIcon', () => {
  test('renders Anthropic icon for claude sessions', () => {
    const renderer = TestRenderer.create(
      <AgentIcon agentType="claude" className="icon" />
    )

    const icon = renderer.root.findByProps({ 'aria-label': 'Anthropic' })
    expect(icon.props.className).toBe('icon')
  })

  test('renders OpenAI icon based on command', () => {
    const renderer = TestRenderer.create(
      <AgentIcon command="Codex --help" />
    )

    expect(renderer.root.findByProps({ 'aria-label': 'OpenAI' })).toBeTruthy()
  })

  test('falls back to terminal icon for unknown agent', () => {
    const renderer = TestRenderer.create(
      <AgentIcon command="bash" className="fallback" />
    )

    const fallback = renderer.root.findByProps({ 'data-testid': 'terminal-icon' })
    expect(fallback.props.className).toBe('fallback')
  })
})
