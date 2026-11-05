import { afterEach, describe, expect, test } from 'bun:test'
import { useLayoutEffect } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import NewSessionModal from '../components/NewSessionModal'
import { DEFAULT_PRESETS, useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalThis.fetch = originalFetch
})

function setupDom() {
  const keyHandlers = new Map<string, EventListener>()
  const textarea = {
    removeAttribute: () => {},
    focus: () => {},
  }

  globalAny.document = {
    querySelector: () => textarea,
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis

  return { keyHandlers }
}

/**
 * Claude chat is the dialog's default kind; tests that exercise the terminal
 * form (command presets, hosts, first-prompt) select Terminal first. A
 * change-section launch is the one context that opens on Terminal by itself.
 */
function selectKind(renderer: TestRenderer.ReactTestRenderer, value: 'terminal' | 'chat') {
  act(() => {
    renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.onChange({ target: { value } })
  })
}

function profileSelectorCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByProps({ 'aria-label': 'Profile' }).length
}

/**
 * Drive the dialog through the opens the spec cares about: `reopen` closes and
 * opens again the way App does — `initial*` props change in the same batched
 * update as `isOpen` — so the preselected kind is always the current entry
 * point's, never a leftover from the previous open.
 */
function mountDialog(entry: Record<string, unknown> = {}) {
  setupDom()
  const form = (isOpen: boolean, props: Record<string, unknown>) => (
    <NewSessionModal
      isOpen={isOpen}
      onClose={() => {}}
      onCreate={() => {}}
      defaultProjectDir="/base"
      commandPresets={DEFAULT_PRESETS}
      defaultPresetId="claude"
      {...props}
    />
  )

  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(form(true, entry))
  })

  return {
    renderer,
    kind: () =>
      renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.value as string,
    reopen: (next: Record<string, unknown> = {}) => {
      act(() => {
        renderer.update(form(false, entry))
      })
      act(() => {
        renderer.update(form(true, next))
      })
    },
    unmount: () => {
      act(() => {
        renderer.unmount()
      })
    },
  }
}

describe('NewSessionModal default session kind', () => {
  test('a generic open preselects chat: profile selector, no command presets', () => {
    const dialog = mountDialog()
    expect(dialog.kind()).toBe('chat')
    expect(profileSelectorCount(dialog.renderer)).toBe(1)
    expect(dialog.renderer.root.findAllByProps({ 'data-testid': 'command-select' })).toHaveLength(0)
    dialog.unmount()
  })

  test('a change-section open preselects Terminal with the first-prompt selector', () => {
    const dialog = mountDialog({
      initialPath: '/repo/.worktrees/add-auth',
      initialAutoStartChange: 'add-auth',
    })
    expect(dialog.kind()).toBe('terminal')
    expect(dialog.renderer.root.findAllByProps({ 'data-testid': 'start-with-select' })).toHaveLength(1)
    expect(profileSelectorCount(dialog.renderer)).toBe(0)
    dialog.unmount()
  })

  test('generic open → close → change-section open preselects Terminal', () => {
    const dialog = mountDialog()
    expect(dialog.kind()).toBe('chat')
    dialog.reopen({ initialAutoStartChange: 'add-auth' })
    expect(dialog.kind()).toBe('terminal')
    dialog.unmount()
  })

  test('change-section open → close → generic open preselects Claude chat', () => {
    const dialog = mountDialog({ initialAutoStartChange: 'add-auth' })
    expect(dialog.kind()).toBe('terminal')
    dialog.reopen()
    expect(dialog.kind()).toBe('chat')
    dialog.unmount()
  })

  test('switching kind keeps the entered project path and display name', () => {
    const dialog = mountDialog()
    const inputs = dialog.renderer.root.findAllByType('input')
    // Chat input order: auto-approve checkbox, project path, display name.
    act(() => {
      inputs[1].props.onChange({ target: { value: '/typed/by/user' } })
      inputs[2].props.onChange({ target: { value: 'My session' } })
    })

    selectKind(dialog.renderer, 'terminal')
    const terminalInputs = dialog.renderer.root.findAllByType('input')
    // Command, project path, display name.
    expect(terminalInputs[1].props.value).toBe('/typed/by/user')
    expect(terminalInputs[2].props.value).toBe('My session')

    selectKind(dialog.renderer, 'chat')
    const chatInputs = dialog.renderer.root.findAllByType('input')
    expect(chatInputs[1].props.value).toBe('/typed/by/user')
    expect(chatInputs[2].props.value).toBe('My session')

    dialog.unmount()
  })
})

describe('NewSessionModal component', () => {
  test('submits resolved values and closes', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    selectKind(renderer, 'terminal')

    // With new field order: modifiers/command (index 0), project path (index 1), name (index 2)
    const inputs = renderer.root.findAllByType('input')
    const projectInput = inputs[1]
    const nameInput = inputs[2]

    act(() => {
      projectInput.props.onChange({ target: { value: 'repo' } })
      nameInput.props.onChange({ target: { value: ' Alpha ' } })
    })

    const buttons = renderer.root.findAllByType('button')
    const customButton = buttons.find((button) => {
      const children = Array.isArray(button.props.children)
        ? button.props.children
        : [button.props.children]
      return children.some((c: unknown) => c === 'Custom')
    })

    if (!customButton) {
      throw new Error('Expected custom command button')
    }

    act(() => {
      customButton.props.onClick()
    })

    // Custom command input is now at index 0 (first in the form)
    const commandInput = renderer.root.findAllByType('input')[0]

    act(() => {
      commandInput.props.onChange({ target: { value: ' bun run dev ' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    expect(created).toEqual([
      { path: 'repo', name: 'Alpha', command: 'bun run dev' },
    ])
    expect(closed).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('closes on overlay click and escape', () => {
    const { keyHandlers } = setupDom()
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    const overlay = renderer.root.findByProps({ role: 'dialog' })

    act(() => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
    })

    act(() => {
      keyHandlers.get('keydown')?.({ key: 'Escape' } as KeyboardEvent)
    })

    expect(closed).toBe(2)

    act(() => {
      renderer.unmount()
    })
  })

  test('allows editing full command', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    selectKind(renderer, 'terminal')

    // Command input is the first input field
    const inputs = renderer.root.findAllByType('input')
    const commandInput = inputs[0]

    // Edit the full command (preset starts with 'claude')
    act(() => {
      commandInput.props.onChange({ target: { value: 'claude --model opus --dangerously-skip-permissions' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    // Command should be the full edited command
    expect(created[0].command).toBe('claude --model opus --dangerously-skip-permissions')

    act(() => {
      renderer.unmount()
    })
  })

  test('discovered-worktree picker fills the path and submits the worktree root', () => {
    setupDom()

    const created: Array<{ path: string; host?: string }> = []
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, host) => {
            created.push({ path, host })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          worktrees={[
            {
              worktreeId: '/repo/.git::/repo',
              repositoryName: 'repo',
              path: '/repo',
              branch: 'main',
              detached: false,
              headRevision: 'aaaaaaa1',
            },
            {
              worktreeId: '/repo/.git::/repo-feat',
              repositoryName: 'repo',
              path: '/repo-feat',
              detached: true,
              headRevision: 'bbbbbbb2',
            },
          ]}
        />
      )
    })

    selectKind(renderer, 'terminal')

    const picker = renderer.root.findByProps({ 'data-testid': 'worktree-picker' })
    const options = picker.findAllByType('option')
    expect(options.map((option) => option.props.value)).toEqual([
      '',
      '/repo/.git::/repo',
      '/repo/.git::/repo-feat',
    ])
    expect(JSON.stringify(renderer.toJSON())).toContain('repo · main')
    expect(JSON.stringify(renderer.toJSON())).toContain('@bbbbbbb')

    act(() => {
      picker.props.onChange({ target: { value: '/repo/.git::/repo-feat' } })
    })

    // Project path input (index 1) reflects the picked worktree root.
    const projectInput = renderer.root.findAllByType('input')[1]
    expect(projectInput.props.value).toBe('/repo-feat')

    // The picker keeps showing the matching worktree.
    expect(renderer.root.findByProps({ 'data-testid': 'worktree-picker' }).props.value).toBe(
      '/repo/.git::/repo-feat'
    )

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ path: '/repo-feat', host: undefined }])

    act(() => {
      renderer.unmount()
    })
  })

  test('manual path edits reset the picker and the picker stays hidden without worktrees', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/repo"
          worktrees={[
            {
              worktreeId: '/repo/.git::/repo',
              repositoryName: 'repo',
              path: '/repo',
              branch: 'main',
              detached: false,
              headRevision: 'aaaaaaa1',
            },
          ]}
        />
      )
    })

    selectKind(renderer, 'terminal')

    // lastProjectPath matches a discovered worktree: the picker shows it.
    const picker = renderer.root.findByProps({ 'data-testid': 'worktree-picker' })
    expect(picker.props.value).toBe('/repo/.git::/repo')

    // Editing the path manually falls back to the placeholder.
    const projectInput = renderer.root.findAllByType('input')[1]
    act(() => {
      projectInput.props.onChange({ target: { value: '/somewhere/else' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'worktree-picker' }).props.value).toBe('')

    act(() => {
      renderer.unmount()
    })

    // No discovered worktrees: no picker at all, manual entry untouched.
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    selectKind(renderer, 'terminal')
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'worktree-picker' })
    ).toHaveLength(0)
    expect(renderer.root.findAllByType('input')).toHaveLength(3)

    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal first-prompt selector', () => {
  test('offers Claude, Codex, and Nothing labelled with the literal prompts, defaulting from the preset', () => {
    setupDom()

    const created: Array<{
      path: string
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, _host, autoStartChange, autoStartAgent) => {
            created.push({ path, autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialPath="/repo/.worktrees/add-auth"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    // The default preset is Claude, so the selector defaults to Claude.
    expect(select.props.value).toBe('claude')
    const options = select.findAllByType('option')
    expect(options.map((option) => option.props.value)).toEqual(['claude', 'codex', 'none'])
    // Each option carries the literal prompt it would send.
    expect(
      options.map((option) =>
        Array.isArray(option.props.children)
          ? option.props.children.join('')
          : option.props.children
      )
    ).toEqual([
      'Claude - /opsx:apply add-auth',
      'Codex - $openspec-apply-change add-auth',
      'Nothing',
    ])

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([
      { path: '/repo/.worktrees/add-auth', autoStartChange: 'add-auth', autoStartAgent: 'claude' },
    ])

    act(() => {
      renderer.unmount()
    })
  })

  test('selecting Nothing submits without change name or agent', () => {
    setupDom()

    const created: Array<{
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(_path, _name, _command, _host, autoStartChange, autoStartAgent) => {
            created.push({ autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    act(() => {
      select.props.onChange({ target: { value: 'none' } })
    })
    expect(select.props.value).toBe('none')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ autoStartChange: undefined, autoStartAgent: undefined }])

    act(() => {
      renderer.unmount()
    })
  })

  test('default precedence: preset agentType outranks the command, then the prefix rule, then Nothing', () => {
    setupDom()

    // A preset that declares claude while its command is a wrapper — the
    // declaration wins.
    const wrapperPreset = {
      id: 'glm',
      label: 'GLM',
      command: 'claude-glm --yolo',
      isBuiltIn: false,
      agentType: 'claude' as const,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={[...DEFAULT_PRESETS, wrapperPreset]}
          defaultPresetId="glm"
          initialAutoStartChange="add-auth"
        />
      )
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('claude')

    // Custom mode with a wrapper command: no preset declaration, so the
    // prefix rule on the resolved token picks Claude.
    const buttons = renderer.root.findAllByType('button')
    const customButton = buttons.find((button) => {
      const children = Array.isArray(button.props.children)
        ? button.props.children
        : [button.props.children]
      return children.some((c: unknown) => c === 'Custom')
    })
    act(() => {
      customButton!.props.onClick()
    })
    const commandInput = renderer.root.findAllByType('input')[0]
    act(() => {
      commandInput.props.onChange({ target: { value: 'env FOO=1 npx claude-glm --yolo' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('claude')

    // An unrecognized command defaults to Nothing — but stays selectable.
    act(() => {
      commandInput.props.onChange({ target: { value: 'vim .' } })
    })
    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    expect(select.props.value).toBe('none')

    act(() => {
      renderer.unmount()
    })
  })

  test('an explicit selection survives subsequent command edits', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    act(() => {
      select.props.onChange({ target: { value: 'codex' } })
    })
    // Editing the command away from the preset no longer re-derives the
    // default — the user's choice sticks.
    const commandInput = renderer.root.findAllByType('input')[0]
    act(() => {
      commandInput.props.onChange({ target: { value: 'vim .' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('codex')

    act(() => {
      renderer.unmount()
    })
  })

  test('the selector is offered on remote hosts and the submission carries change and agent', () => {
    setupDom()

    const created: Array<{
      path: string
      host?: string
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, host, autoStartChange, autoStartAgent) => {
            created.push({ path, host, autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          remoteHosts={[
            { host: 'box', ok: true, lastUpdated: '2026-01-01T00:00:00.000Z' },
          ]}
          remoteAllowControl
          initialHost="box"
          initialAutoStartChange="add-auth"
        />
      )
    })

    // No local-host gate: the dropdown renders for a remote host.
    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    expect(select.props.value).toBe('claude')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([
      {
        path: '/base',
        host: 'box',
        autoStartChange: 'add-auth',
        autoStartAgent: 'claude',
      },
    ])

    act(() => {
      renderer.unmount()
    })
  })

  test('no first-prompt affordance without a change context', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    selectKind(renderer, 'terminal')

    expect(renderer.root.findAllByProps({ 'data-testid': 'start-with-select' })).toHaveLength(0)
    // The form keeps exactly its three inputs (command, path, name).
    expect(renderer.root.findAllByType('input')).toHaveLength(3)

    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal project path validation', () => {
  function renderModal(overrides: Record<string, unknown> = {}) {
    setupDom()
    const created: unknown[] = []
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={((...args: unknown[]) => {
            created.push(args)
          }) as never}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          {...overrides}
        />
      )
    })

    return {
      renderer,
      created,
      get closed() {
        return closed
      },
      submit: () => {
        act(() => {
          renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
        })
      },
      pathError: () => {
        const matches = renderer.root.findAllByProps({ 'data-testid': 'project-path-error' })
        return matches.length > 0 ? String(matches[0].props.children) : null
      },
    }
  }

  test('empty project path refuses create and shows an inline error', () => {
    const modal = renderModal()
    selectKind(modal.renderer, 'terminal')
    const projectInput = modal.renderer.root.findAllByType('input')[1]

    act(() => {
      projectInput.props.onChange({ target: { value: '   ' } })
    })
    modal.submit()

    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)
    // The input is marked invalid so the reason is reachable to assistive tech.
    expect(
      modal.renderer.root.findAllByType('input')[1].props['aria-invalid']
    ).toBe('true')

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('empty project path refuses chat create too', () => {
    const modal = renderModal()
    const kindSelect = modal.renderer.root.findByProps({ 'aria-label': 'Session kind' })

    act(() => {
      kindSelect.props.onChange({ target: { value: 'chat' } })
    })
    // Chat inputs: auto-approve checkbox first, then the project path.
    const projectInput = modal.renderer.root.findAllByType('input')[1]
    act(() => {
      projectInput.props.onChange({ target: { value: '' } })
    })
    modal.submit()

    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('typing a path clears the error and allows create', () => {
    const modal = renderModal()
    selectKind(modal.renderer, 'terminal')
    const projectInput = modal.renderer.root.findAllByType('input')[1]

    // Clear the prefilled default so submit is refused and raises the error.
    act(() => {
      projectInput.props.onChange({ target: { value: '' } })
    })
    modal.submit()
    expect(modal.pathError()).not.toBeNull()

    act(() => {
      projectInput.props.onChange({ target: { value: '/work/repo' } })
    })
    expect(modal.pathError()).toBeNull()

    modal.submit()
    expect(modal.pathError()).toBeNull()
    expect(modal.created).toHaveLength(1)
    expect(modal.closed).toBe(1)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('a modal with no pre-filled path starts clean and refuses on submit', () => {
    // Nothing supplies a default: no active/last project and no default dir.
    const modal = renderModal({
      defaultProjectDir: '',
      lastProjectPath: null,
      activeProjectPath: undefined,
    })

    expect(modal.pathError()).toBeNull()

    modal.submit()
    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('prop updates while open do not wipe what the user typed', () => {
    // server-info (and thus defaultProjectDir) arrives asynchronously after
    // the dialog opens; re-initializing on that change used to silently reset
    // the form under the user's hands.
    setupDom()
    const created: Array<{ path: string; name?: string }> = []

    const form = (props: { defaultProjectDir: string; lastProjectPath?: string | null }) => (
      <NewSessionModal
        isOpen
        onClose={() => {}}
        onCreate={((path: string, name?: string) => {
          created.push({ path, name })
        }) as never}
        defaultProjectDir={props.defaultProjectDir}
        commandPresets={DEFAULT_PRESETS}
        defaultPresetId="claude"
        lastProjectPath={props.lastProjectPath}
      />
    )

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(form({ defaultProjectDir: '' }))
    })

    selectKind(renderer, 'terminal')
    const [projectInput, nameInput] = renderer.root.findAllByType('input').slice(1)
    act(() => {
      projectInput.props.onChange({ target: { value: '/typed/by/user' } })
      nameInput.props.onChange({ target: { value: 'My name' } })
    })

    // The async default lands while the dialog is still open.
    act(() => {
      renderer.update(form({ defaultProjectDir: '/late/default', lastProjectPath: '/late/last' }))
    })

    const inputs = renderer.root.findAllByType('input')
    expect(inputs[1].props.value).toBe('/typed/by/user')
    expect(inputs[2].props.value).toBe('My name')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ path: '/typed/by/user', name: 'My name' }])

    act(() => {
      renderer.unmount()
    })
  })
})

/**
 * Open-transition race harness. CI e2e intermittently saw a freshly filled
 * Project Path revert to the default: the dialog's defaults were applied by a
 * passive effect that fires after paint, so a fill landing between the open
 * commit and that effect (Playwright under load) was overwritten. The probe
 * reproduces that window exactly: `createNodeMock` captures the Project Path
 * input's props during the open commit (refs attach before layout effects),
 * and a layout effect — the first moment the input is interactive and still
 * strictly before any passive effect — performs the user's fill.
 */
describe('NewSessionModal open-transition race', () => {
  interface RaceHarness {
    open: () => void
    committedAtOpen: () => string | undefined
    pathValue: () => string
    pathError: () => string | null
    deliverLateData: (props: Record<string, unknown>) => void
    settleFetches: () => Promise<void>
    submit: () => void
    created: Array<{ path: string }>
    unmount: () => void
  }

  function mountRaceDialog(fill: string, entry: Record<string, unknown> = {}): RaceHarness {
    setupDom()
    globalThis.fetch = (async (url: string) =>
      String(url).startsWith('/api/chat/groups')
        ? Response.json({ groups: [], errors: [] })
        : Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    let pathProps: Record<string, unknown> | null = null
    let committed: string | undefined
    const created: Array<{ path: string }> = []
    /** Set before the open update: the probe fills once, at the open commit. */
    let probeNextOpen = false

    // Refs attach during the commit, so the captured props carry the value
    // the input was committed with — before any effect could initialize it.
    const createNodeMock = (element: { type?: unknown; props?: Record<string, unknown> }) => {
      if (element.type === 'input' && element.props?.['aria-label'] === 'Project Path') {
        pathProps = element.props
      }
      return { focus: () => {} }
    }

    function CommitProbe() {
      useLayoutEffect(() => {
        if (!probeNextOpen || !pathProps) return
        probeNextOpen = false
        committed = pathProps.value as string
        ;(pathProps.onChange as (event: { target: { value: string } }) => void)({
          target: { value: fill },
        })
      })
      return null
    }

    const form = (isOpen: boolean, props: Record<string, unknown> = {}) => (
      <>
        <NewSessionModal
          isOpen={isOpen}
          onClose={() => {}}
          onCreate={(path) => {
            created.push({ path })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          {...entry}
          {...props}
        />
        <CommitProbe />
      </>
    )

    act(() => {
      renderer = TestRenderer.create(form(false), { createNodeMock })
    })

    return {
      open: () => {
        probeNextOpen = true
        act(() => {
          renderer.update(form(true))
        })
      },
      committedAtOpen: () => committed,
      pathValue: () =>
        renderer.root.findAllByProps({ 'aria-label': 'Project Path' })[0]!.props.value as string,
      pathError: () => {
        const matches = renderer.root.findAllByProps({ 'data-testid': 'project-path-error' })
        return matches.length > 0 ? String(matches[0].props.children) : null
      },
      deliverLateData: (props: Record<string, unknown>) => {
        act(() => {
          renderer.update(form(true, props))
        })
      },
      settleFetches: async () => {
        await act(async () => {
          for (let i = 0; i < 12; i++) await Promise.resolve()
        })
      },
      created,
      submit: () => {
        act(() => {
          renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
        })
      },
      unmount: () => {
        act(() => {
          renderer.unmount()
        })
      },
    }
  }

  test('a fill landing at the first interactive moment is never overwritten by the open init', async () => {
    const dialog = mountRaceDialog('/typed/by/user')
    dialog.open()

    // The open commit must already carry the default: a dialog that paints
    // interactive with an uninitialized path invites the fill-then-init race.
    expect(dialog.committedAtOpen()).toBe('/base')
    // The fill survived the open init that flushes right after the commit.
    expect(dialog.pathValue()).toBe('/typed/by/user')

    // Late first-load hydration (server default dir, last path, sessions'
    // active path, presets) must not touch the edited field either.
    dialog.deliverLateData({
      defaultProjectDir: '/late/default',
      lastProjectPath: '/late/last',
      activeProjectPath: '/late/active',
      commandPresets: DEFAULT_PRESETS,
    })
    expect(dialog.pathValue()).toBe('/typed/by/user')

    await dialog.settleFetches()
    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/typed/by/user' }])

    dialog.unmount()
  })

  test('clearing the path at the first interactive moment is never refilled by the open init', () => {
    const dialog = mountRaceDialog('', { initialPath: '/pre/from/duplicate' })
    dialog.open()

    expect(dialog.committedAtOpen()).toBe('/pre/from/duplicate')
    // Edited to empty stays empty — an empty edit is still an edit.
    expect(dialog.pathValue()).toBe('')

    dialog.deliverLateData({ defaultProjectDir: '/late/default', lastProjectPath: '/late/last' })
    expect(dialog.pathValue()).toBe('')

    // An empty path refuses create with the inline reason instead of
    // silently submitting whatever the init would have refilled.
    dialog.submit()
    expect(dialog.pathError()).toBe('Enter a project path to create the session.')

    dialog.unmount()
  })

  test('opening fetches the per-project catalog and groups exactly once, for the initialized path', () => {
    setupDom()
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return String(url).startsWith('/api/chat/groups')
        ? Response.json({ groups: [], errors: [] })
        : Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })
    }) as unknown as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    // Master fetched the catalog twice on open (stale path from the first
    // render, refetch after the init effect set the default); the render-phase
    // init means one fetch per endpoint, for the right path.
    expect(urls.filter((url) => url.startsWith('/api/chat/profiles'))).toEqual([
      '/api/chat/profiles?projectPath=%2Fbase',
    ])
    expect(urls.filter((url) => url.startsWith('/api/chat/groups'))).toEqual([
      '/api/chat/groups?projectPath=%2Fbase',
    ])

    act(() => {
      renderer.unmount()
    })
  })

  /**
   * Terminal-focus harness: the xterm helper textarea stands in for the
   * terminal, recording the disable/enable/focus touches the modal's
   * open/close side effects make on it.
   */
  function terminalFocusDom() {
    const calls: string[] = []
    const textarea = {
      setAttribute: (_name: string, _value: string) => {
        calls.push('disable')
      },
      removeAttribute: (_name: string) => {
        calls.push('enable')
      },
      focus: () => {
        calls.push('terminal-focus')
      },
      blur: () => {},
    }
    globalAny.document = { querySelector: () => textarea } as unknown as Document
    globalAny.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis
    return { calls }
  }

  /** The close-side terminal focus waits 300 ms; run past it. */
  const afterCloseWindow = () => new Promise((resolve) => setTimeout(resolve, 340))

  test('a mount while closed schedules no terminal focus', async () => {
    const terminal = terminalFocusDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen={false}
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    await act(async () => {
      await afterCloseWindow()
    })
    expect(terminal.calls).toEqual([])

    act(() => {
      renderer.unmount()
    })
  })

  test('a close→reopen within 300 ms never re-enables or focuses the terminal textarea', async () => {
    const terminal = terminalFocusDom()
    const form = (isOpen: boolean) => (
      <NewSessionModal
        isOpen={isOpen}
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/base"
        commandPresets={DEFAULT_PRESETS}
        defaultPresetId="claude"
      />
    )
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(form(true))
    })
    act(() => {
      renderer.update(form(false))
    })
    // Reopen before the close-side 300 ms terminal focus fires.
    act(() => {
      renderer.update(form(true))
    })

    await act(async () => {
      await afterCloseWindow()
    })
    // Both opens disabled the textarea; the stale close timeout was cancelled
    // instead of re-enabling and focusing the terminal under the open dialog.
    expect(terminal.calls).toEqual(['disable', 'disable'])

    act(() => {
      renderer.unmount()
    })
  })
})

/**
 * Focus harness. react-test-renderer hosts are not DOM nodes, so refs are
 * `createNodeMock` objects whose `focus()` maintains `document.activeElement`
 * the way a browser would. Tags say which control holds focus. The mock form
 * answers `contains()` so the two "user moved focus" helpers can model the two
 * sides of the form boundary — the dialog's own controls live outside it too
 * (the directory browser), and a focus guard may not treat those as stealable.
 */
function setupFocusDom() {
  const keyHandlers = new Map<string, EventListener>()
  const textarea = { removeAttribute: () => {}, focus: () => {} }
  let active: { tag: string } | null = null
  const body = { tag: 'body' }
  /** Everything the mock form owns. */
  const formDescendants = new Set<object>()

  globalAny.document = {
    querySelector: () => textarea,
    body,
    get activeElement() {
      return active as unknown as Element | null
    },
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
  } as unknown as Window & typeof globalThis

  const tagFor = (element: { type?: unknown; props?: Record<string, unknown> }) => {
    const props = element.props ?? {}
    if (props['aria-label'] === 'Session kind') return 'kind-select'
    if (props['aria-label'] === 'Profile') return 'profile'
    if (element.type === 'button' && props.type === 'submit') return 'create'
    return `${String(element.type)}:${String(props['data-testid'] ?? props['aria-label'] ?? '')}`
  }

  const createNodeMock = (element: { type?: unknown; props?: Record<string, unknown> }) => {
    const node: {
      tag: string
      focus(): void
      blur(): void
      contains?: (other: unknown) => boolean
    } = {
      tag: tagFor(element),
      focus() {
        active = node
      },
      blur() {
        if (active === node) active = null
      },
    }
    if (element.type === 'form') {
      node.contains = (other: unknown) => formDescendants.has(other as object)
    }
    formDescendants.add(node)
    return node
  }

  return {
    keyHandlers,
    createNodeMock,
    activeTag: () => active?.tag ?? null,
    /** The user picks a control outside the form, e.g. the directory browser. */
    moveFocusAway: () => {
      active = { tag: 'user-moved' }
    },
    /** The user picks one of the form's own controls the dialog did not choose. */
    moveFocusInForm: () => {
      const node = { tag: 'user-in-form' }
      formDescendants.add(node)
      active = node
    },
    /** Nothing meaningful holds focus: it is resting on the document body. */
    restFocusOnBody: () => {
      active = body
    },
  }
}

/** Hang the chat profile catalog until the test releases it. */
function deferredCatalog() {
  let release!: (response: Response) => void
  // Only the profile catalog hangs; the team-groups request answers at once
  // (empty) so it cannot take over the held resolver.
  globalThis.fetch = ((url: string) =>
    String(url).startsWith('/api/chat/groups')
      ? Promise.resolve(Response.json({ groups: [], errors: [] }))
      : new Promise<Response>((resolve) => {
        release = resolve
      })) as unknown as typeof fetch
  return {
    succeed: (profiles: Array<{ id: string; label: string }> = [{ id: 'default', label: 'Default' }]) =>
      release(Response.json({ profiles, errors: [] })),
    fail: () => release(Response.json({ error: 'down' }, { status: 500 })),
  }
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** The dialog's initial focus attempt runs ~50 ms after open. */
const afterFocusAttempt = () => new Promise((resolve) => setTimeout(resolve, 60))

async function openDialog(focus: ReturnType<typeof setupFocusDom>) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <NewSessionModal
        isOpen
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/base"
        commandPresets={DEFAULT_PRESETS}
        defaultPresetId="claude"
      />,
      { createNodeMock: focus.createNodeMock }
    )
    await settle()
  })
  return renderer
}

describe('NewSessionModal provisional focus', () => {
  test('the initial attempt focuses Create when it is enabled and the kind select while the catalog loads', async () => {
    // Delayed catalog: Create cannot take focus yet, so the attempt falls back
    // to the always-enabled session-kind select. The catalog is never released.
    deferredCatalog()
    const loadingFocus = setupFocusDom()
    const loadingDialog = await openDialog(loadingFocus)
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(loadingFocus.activeTag()).toBe('kind-select')
    act(() => {
      loadingDialog.unmount()
    })

    // A catalog that settles before the attempt: Create is enabled and takes
    // focus itself.
    globalThis.fetch = (async () =>
      Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch
    const readyFocus = setupFocusDom()
    const readyDialog = await openDialog(readyFocus)
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(readyFocus.activeTag()).toBe('create')
    act(() => {
      readyDialog.unmount()
    })
  })

  test('the deferred attempt never overrides a focus the user moved before it fires', async () => {
    // The attempt is deferred ~50 ms so the DOM settles first — long enough for
    // the user to reach a control of their own. Whichever side of the form
    // boundary they land on, the attempt must leave their focus alone rather
    // than yank it onto Create or the kind select.
    const outside = deferredCatalog()
    const outsideFocus = setupFocusDom()
    const outsideDialog = await openDialog(outsideFocus)
    outsideFocus.moveFocusAway()
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(outsideFocus.activeTag()).toBe('user-moved')

    // Skipping the attempt leaves no provisional focus behind, so a later
    // catalog settle must not promote onto the user either.
    outside.succeed()
    await act(async () => {
      await settle()
    })
    expect(outsideFocus.activeTag()).toBe('user-moved')
    act(() => {
      outsideDialog.unmount()
    })

    // The same holds for a form control the user picked for themselves.
    deferredCatalog()
    const insideFocus = setupFocusDom()
    const insideDialog = await openDialog(insideFocus)
    insideFocus.moveFocusInForm()
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(insideFocus.activeTag()).toBe('user-in-form')
    act(() => {
      insideDialog.unmount()
    })

    // Focus resting on the body is nobody's choice, not the user's: the attempt
    // still lands. (Catalog still deferred, so the kind select is the target.)
    deferredCatalog()
    const ambientFocus = setupFocusDom()
    const ambientDialog = await openDialog(ambientFocus)
    ambientFocus.restFocusOnBody()
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(ambientFocus.activeTag()).toBe('kind-select')
    act(() => {
      ambientDialog.unmount()
    })
  })

  test('a settled catalog promotes provisional focus to Create, but never steals a focus the user moved', async () => {
    // Provisional focus still holds: the catch-up promotes it to Create.
    const promoting = deferredCatalog()
    const promotingFocus = setupFocusDom()
    const promotingDialog = await openDialog(promotingFocus)
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(promotingFocus.activeTag()).toBe('kind-select')
    promoting.succeed()
    await act(async () => {
      await settle()
    })
    expect(promotingFocus.activeTag()).toBe('create')
    act(() => {
      promotingDialog.unmount()
    })

    // The user moved focus away before the catalog settled: leave it alone.
    const stealing = deferredCatalog()
    const stealingFocus = setupFocusDom()
    const stealingDialog = await openDialog(stealingFocus)
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(stealingFocus.activeTag()).toBe('kind-select')
    stealingFocus.moveFocusAway()
    stealing.succeed()
    await act(async () => {
      await settle()
    })
    expect(stealingFocus.activeTag()).toBe('user-moved')
    act(() => {
      stealingDialog.unmount()
    })
  })

  test('a catalog error leaves focus on the session-kind select', async () => {
    const catalog = deferredCatalog()
    const focus = setupFocusDom()
    const renderer = await openDialog(focus)
    await act(async () => {
      await afterFocusAttempt()
    })
    expect(focus.activeTag()).toBe('kind-select')

    catalog.fail()
    await act(async () => {
      await settle()
    })
    expect(focus.activeTag()).toBe('kind-select')
    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined()
    // Create stays unusable, so the kind select is the right resting place.
    expect(
      renderer.root.findAllByType('button').find((button) => button.props.type === 'submit')!.props.disabled
    ).toBe(true)
    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal auto-approve tools', () => {
  afterEach(() => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'manual' })
  })

  /**
   * Open the dialog on its chat default with a resolved profile catalog, so
   * the chat submit path can run (it refuses while the catalog loads).
   */
  async function chatDialog() {
    setupDom()
    const created: Array<{ path: string; approvalPolicy?: string }> = []
    globalThis.fetch = (async () =>
      Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, _host, _change, _agent, _kind, _profile, approvalPolicy) => {
            created.push({ path, approvalPolicy })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
      await settle()
    })

    return {
      renderer,
      created,
      checkbox: () => renderer.root.findAllByProps({ 'data-testid': 'chat-auto-approve' }),
      submit: () => {
        act(() => {
          renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
        })
      },
    }
  }

  test('the checkbox appears for chat and not for terminal', async () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'manual' })
    const dialog = await chatDialog()

    // Chat is the dialog's default kind: the checkbox is present.
    expect(dialog.checkbox()).toHaveLength(1)
    expect(dialog.checkbox()[0].props.checked).toBe(false)

    selectKind(dialog.renderer, 'terminal')
    expect(dialog.checkbox()).toHaveLength(0)

    selectKind(dialog.renderer, 'chat')
    expect(dialog.checkbox()).toHaveLength(1)

    act(() => {
      dialog.renderer.unmount()
    })
  })

  // @covers: chat-sessions › Users configure the default approval policy for new chat sessions › Settings default seeds new chats
  test('a default of auto pre-checks the box and submits auto', async () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'auto' })
    const dialog = await chatDialog()
    expect(dialog.checkbox()[0].props.checked).toBe(true)

    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base', approvalPolicy: 'auto' }])

    act(() => {
      dialog.renderer.unmount()
    })
  })

  // @covers: chat-sessions › Users configure the default approval policy for new chat sessions › Creation dialog overrides the default
  test('unchecking an auto default creates a manual session', async () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'auto' })
    const dialog = await chatDialog()
    act(() => {
      dialog.checkbox()[0].props.onChange({ target: { checked: false } })
    })
    expect(dialog.checkbox()[0].props.checked).toBe(false)

    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base', approvalPolicy: 'manual' }])

    act(() => {
      dialog.renderer.unmount()
    })
  })

  test('a default of manual leaves the box unchecked and submits manual', async () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'manual' })
    const dialog = await chatDialog()
    expect(dialog.checkbox()[0].props.checked).toBe(false)

    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base', approvalPolicy: 'manual' }])

    act(() => {
      dialog.renderer.unmount()
    })
  })
})

describe('NewSessionModal radiogroup keyboard navigation', () => {
  /**
   * Each radio's handler closes over its own map index, and focus follows the
   * selection, so a keypress lands on whichever radio is currently selected.
   * react-test-renderer has no DOM, so stand in for the handler's
   * `parentElement.querySelectorAll('[role="radio"]')[n].focus()`.
   */
  function press(group: ReactTestInstance, key: string, focusLog: number[] = []) {
    const radios = group.findAllByType('button')
    const activeIndex = radios.findIndex((radio) => radio.props.tabIndex === 0)
    const currentTarget = {
      parentElement: {
        querySelectorAll: () => radios.map((_, index) => ({ focus: () => focusLog.push(index) })),
      },
    }
    act(() => {
      radios[activeIndex]!.props.onKeyDown({ key, preventDefault: () => {}, currentTarget })
    })
    return focusLog
  }

  // The command picker prefixes each label with an AgentIcon; the host picker
  // renders the label alone. Pull out whichever child is the text.
  const labels = (group: ReactTestInstance) =>
    group.findAllByType('button').map((radio) => {
      const children = radio.props.children
      const parts: unknown[] = Array.isArray(children) ? children : [children]
      return parts.find((part) => typeof part === 'string') as string
    })
  const checked = (group: ReactTestInstance) =>
    group.findAllByType('button').map((radio) => radio.props['aria-checked'] as boolean)
  const tabbable = (group: ReactTestInstance) =>
    group.findAllByType('button').map((radio) => radio.props.tabIndex as number)

  test('the host picker arrows through Local and the remote hosts, wrapping both ways', () => {
    setupDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          remoteHosts={[
            { host: 'box-a', ok: true, lastUpdated: '2026-01-01T00:00:00.000Z' },
            { host: 'box-b', ok: true, lastUpdated: '2026-01-01T00:00:00.000Z' },
          ]}
          remoteAllowControl
        />
      )
    })
    selectKind(renderer, 'terminal')

    const group = renderer.root.findByProps({ 'data-testid': 'host-select' })
    expect(group.props.role).toBe('radiogroup')
    expect(labels(group)).toEqual(['Local', 'box-a', 'box-b'])
    expect(checked(group)).toEqual([true, false, false])
    expect(tabbable(group)).toEqual([0, -1, -1])

    const focusLog: number[] = []
    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([false, true, false])
    expect(tabbable(group)).toEqual([-1, 0, -1])

    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([false, false, true])

    // Wraps forward off the end and backward off the start.
    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([true, false, false])
    press(group, 'ArrowLeft', focusLog)
    expect(checked(group)).toEqual([false, false, true])

    // Every move refocused the newly selected radio.
    expect(focusLog).toEqual([1, 2, 0, 2])

    // An unmatched key leaves the selection alone.
    press(group, 'Enter')
    expect(checked(group)).toEqual([false, false, true])

    act(() => {
      renderer.unmount()
    })
  })

  test('the command picker arrows through the presets and Custom, wrapping', () => {
    setupDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    selectKind(renderer, 'terminal')

    const group = renderer.root.findByProps({ 'data-testid': 'command-select' })
    expect(group.props.role).toBe('radiogroup')
    expect(labels(group)).toEqual(['Claude', 'Codex', 'Pi', 'Custom'])
    expect(checked(group)).toEqual([true, false, false, false])
    expect(tabbable(group)).toEqual([0, -1, -1, -1])

    const focusLog: number[] = []
    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([false, true, false, false])

    // Reaching Custom clears the command the way clicking it does.
    press(group, 'ArrowRight', focusLog)
    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([false, false, false, true])
    expect(tabbable(group)).toEqual([-1, -1, -1, 0])
    expect(renderer.root.findAllByType('input')[0]!.props.value).toBe('')

    // Wraps back to the first preset and restores its command.
    press(group, 'ArrowRight', focusLog)
    expect(checked(group)).toEqual([true, false, false, false])
    expect(renderer.root.findAllByType('input')[0]!.props.value).toBe('claude')
    expect(focusLog).toEqual([1, 2, 3, 0])

    // Backward from the first preset lands on Custom again.
    press(group, 'ArrowLeft', focusLog)
    expect(checked(group)).toEqual([false, false, false, true])

    act(() => {
      renderer.unmount()
    })
  })

  test('both pickers keep their roving tabindex through the whole cycle', () => {
    setupDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          remoteHosts={[{ host: 'box-a', ok: true, lastUpdated: '2026-01-01T00:00:00.000Z' }]}
          remoteAllowControl
        />
      )
    })
    selectKind(renderer, 'terminal')

    const hostGroup = renderer.root.findByProps({ 'data-testid': 'host-select' })
    const commandGroup = renderer.root.findByProps({ 'data-testid': 'command-select' })
    for (const group of [hostGroup, commandGroup]) {
      const count = group.findAllByType('button').length
      for (let step = 0; step < count + 1; step++) {
        // Exactly one radio is in the tab order at every point in the cycle.
        expect(tabbable(group).filter((value) => value === 0)).toHaveLength(1)
        press(group, 'ArrowRight')
      }
    }

    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal team group picker', () => {
  async function groupDialog(groupsResponse: unknown) {
    setupDom()
    const created: Array<{ path: string; groupId?: string }> = []
    globalThis.fetch = (async (url: string) =>
      String(url).startsWith('/api/chat/groups')
        ? Response.json(groupsResponse)
        : Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, _host, _change, _agent, _kind, _profile, _policy, groupId) => {
            created.push({ path, ...(groupId ? { groupId } : {}) })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
      await settle()
    })
    const select = () => renderer.root.findByProps({ 'aria-label': 'Group' })
    const submit = () => act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    return { renderer, created, select, submit }
  }

  test('offers the team groups after "No group" and creates with the chosen one', async () => {
    const dialog = await groupDialog({
      groups: [
        { id: 'devs', label: 'Developers', description: 'Build features' },
        { id: 'qa', label: 'qa', description: '' },
      ],
      errors: [],
    })
    const options = dialog.select().findAllByType('option')
    expect(options.map(option => option.props.value)).toEqual(['', 'devs', 'qa'])
    expect(options[1]!.props.title).toBe('Build features')
    act(() => { dialog.select().props.onChange({ target: { value: 'devs' } }) })
    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base', groupId: 'devs' }])
    act(() => { dialog.renderer.unmount() })
  })

  test('a group at its profile cap warns but still creates (user exceeds cap)', async () => {
    const dialog = await groupDialog({
      groups: [{ id: 'devs', label: 'devs', description: '', profiles: [{ profileId: 'default', cap: 1, live: 1 }, { profileId: 'glm', cap: 2, live: 0 }] }],
      errors: [], warnings: ['/base/.kawai/groups/devs.md: profile "nope" is not defined; ignored'],
    })
    const warning = () => dialog.renderer.root.findAllByProps({ 'data-testid': 'group-cap-warning' })
    expect(warning()).toHaveLength(0)
    act(() => { dialog.select().props.onChange({ target: { value: 'devs' } }) })
    expect(warning()).toHaveLength(1)
    expect(String(warning()[0]!.children)).toContain('devs already has 1 live member on default (cap 1)')
    // Fallback warnings ride along with errors.
    expect(dialog.renderer.root.findAllByProps({ role: 'status' })
      .some(node => String(node.children).includes('profile "nope" is not defined'))).toBe(true)
    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base', groupId: 'devs' }])
    act(() => { dialog.renderer.unmount() })
  })

  test('creating without choosing a group sends none, and catalog problems show as warnings', async () => {
    const dialog = await groupDialog({ groups: [], errors: ['/base/.kawai/groups/x.md: bad'] })
    expect(dialog.select().props.value).toBe('')
    expect(dialog.renderer.root.findAllByProps({ role: 'status' })
      .some(node => node.children.includes('/base/.kawai/groups/x.md: bad'))).toBe(true)
    dialog.submit()
    expect(dialog.created).toEqual([{ path: '/base' }])
    act(() => { dialog.renderer.unmount() })
  })
})

describe('profile picker groups by provider', () => {
  // Catalog order (D13): the provider holding default first, then file order.
  const groupedCatalog = [
    { id: 'default', label: 'Default', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
    { id: 'opus', label: 'Claude Opus', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
    { id: 'glm', label: 'GLM', providerId: 'zai', providerLabel: 'Z.AI', runtime: 'claude' },
    { id: 'glm-flash', label: 'GLM Flash', providerId: 'zai', providerLabel: 'Z.AI', runtime: 'claude' },
    { id: 'mimo', label: 'MiMo', providerId: 'mimo', providerLabel: 'MiMo', runtime: 'claude' },
  ]

  async function openWith(profiles: unknown) {
    globalThis.fetch = ((url: string) =>
      String(url).startsWith('/api/chat/groups')
        ? Promise.resolve(Response.json({ groups: [], errors: [] }))
        : Promise.resolve(Response.json({ profiles, errors: [] }))) as unknown as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <NewSessionModal isOpen onClose={() => {}} onCreate={() => {}} defaultProjectDir="/base" commandPresets={DEFAULT_PRESETS} defaultPresetId="claude" />
      )
      await settle()
    })
    return renderer
  }

  test('models are grouped by provider; a one-model provider with an equal label stays plain', async () => {
    const renderer = await openWith(groupedCatalog)
    const select = renderer.root.findByProps({ 'aria-label': 'Profile' })
    const groups = select.findAllByType('optgroup')
    expect(groups.map(group => group.props.label)).toEqual(['Claude', 'Z.AI'])
    expect(groups[0]!.findAllByType('option').map(option => option.props.value))
      .toEqual(['default', 'opus'])
    expect(groups[1]!.findAllByType('option').map(option => option.props.value))
      .toEqual(['glm', 'glm-flash'])
    // MiMo: one model whose label equals the provider's label — a plain option.
    const allOptions = select.findAllByType('option').map(option => option.props.value)
    expect(allOptions).toEqual(['default', 'opus', 'glm', 'glm-flash', 'mimo'])
    act(() => { renderer.unmount() })
  })

  test('a profiles-only catalog keeps the plain picker it has always had', async () => {
    const renderer = await openWith([
      { id: 'default', label: 'Default', providerId: 'default', providerLabel: 'Default', runtime: 'claude' },
      { id: 'glm', label: 'GLM', providerId: 'glm', providerLabel: 'GLM', runtime: 'claude' },
    ])
    const select = renderer.root.findByProps({ 'aria-label': 'Profile' })
    expect(select.findAllByType('optgroup')).toEqual([])
    expect(select.findAllByType('option').map(option => option.props.value)).toEqual(['default', 'glm'])
    act(() => { renderer.unmount() })
  })

  test('a Codex profile is its own group under the Codex provider (task 3.4)', async () => {
    const renderer = await openWith([
      ...groupedCatalog,
      // A label equal to the provider's renders plain; a distinct label sits
      // in an optgroup named Codex.
      { id: 'codex', label: 'Codex', providerId: 'codex-home-0123456789ab', providerLabel: 'Codex', runtime: 'codex' },
      { id: 'work-codex', label: 'Work Codex', providerId: 'codex-home-fedcba098765', providerLabel: 'Codex', runtime: 'codex' },
    ])
    const select = renderer.root.findByProps({ 'aria-label': 'Profile' })
    const groups = select.findAllByType('optgroup')
    expect(groups.map(group => group.props.label)).toEqual(['Claude', 'Z.AI', 'Codex'])
    expect(groups[2]!.findAllByType('option').map(option => option.props.children)).toEqual(['Work Codex'])
    // The equal-label entry stays a plain option after its group.
    const options = select.findAllByType('option')
    expect(options.map(option => option.props.value)).toEqual(['default', 'opus', 'glm', 'glm-flash', 'mimo', 'codex', 'work-codex'])
    act(() => { renderer.unmount() })
  })
})

describe('capWarning', () => {
  test('only a reached cap on the chosen profile warns', async () => {
    const { capWarning } = await import('../components/chat/useTeamGroups')
    const group = { id: 'devs', label: 'Developers', description: '', profiles: [{ profileId: 'glm', cap: 2, live: 2 }, { profileId: 'claude', live: 5 }] }
    expect(capWarning(group, 'glm')).toContain('Developers already has 2 live members on glm (cap 2)')
    expect(capWarning(group, 'claude')).toBeNull()
    expect(capWarning(group, 'mimo')).toBeNull()
    expect(capWarning({ ...group, profiles: [{ profileId: 'glm', cap: 2, live: 1 }] }, 'glm')).toBeNull()
    expect(capWarning(undefined, 'glm')).toBeNull()
  })
})
