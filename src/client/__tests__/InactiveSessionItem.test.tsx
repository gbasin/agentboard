import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession } from '@shared/types'
import InactiveSessionItem from '../components/InactiveSessionItem'

const baseSession: AgentSession = {
  sessionId: 'abcdef123456',
  logFilePath: '/tmp/session.jsonl',
  projectPath: '/projects/alpha',
  agentType: 'claude',
  displayName: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: new Date(Date.now() - 120000).toISOString(),
  isActive: false,
}

describe('InactiveSessionItem', () => {
  test('renders display name and session id prefix', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <InactiveSessionItem
          session={baseSession}
          showSessionIdPrefix
          onResume={() => {}}
          onPreview={() => {}}
        />
      )
    })

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('alpha')
    expect(html).toContain('abc…456')

    act(() => {
      renderer.unmount()
    })
  })

  test('handles preview and resume interactions', () => {
    let previewCalls = 0
    let resumeCalls = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <InactiveSessionItem
          session={{ ...baseSession, projectPath: '', displayName: '' }}
          showSessionIdPrefix={false}
          onResume={() => {
            resumeCalls += 1
          }}
          onPreview={() => {
            previewCalls += 1
          }}
        />
      )
    })

    const root = renderer.root.findByProps({ role: 'button' })

    act(() => {
      root.props.onClick()
    })

    let prevented = 0
    act(() => {
      root.props.onKeyDown({
        key: 'Enter',
        preventDefault: () => {
          prevented += 1
        },
      })
    })

    act(() => {
      root.props.onKeyDown({
        key: ' ',
        preventDefault: () => {
          prevented += 1
        },
      })
    })

    const resumeButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === 'Resume directly')

    if (!resumeButton) {
      throw new Error('Expected resume button')
    }

    let stopped = 0
    act(() => {
      resumeButton.props.onClick({
        stopPropagation: () => {
          stopped += 1
        },
      })
    })

    expect(previewCalls).toBe(3)
    expect(resumeCalls).toBe(1)
    expect(prevented).toBe(2)
    expect(stopped).toBe(1)

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('abcdef12')
    expect(html).not.toContain('abc…456')

    act(() => {
      renderer.unmount()
    })
  })
})
