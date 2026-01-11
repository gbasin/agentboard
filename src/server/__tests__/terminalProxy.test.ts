import { describe, expect, test } from 'bun:test'
import { TerminalProxy } from '../TerminalProxy'

function createSpawnStub() {
  const calls: Array<{ args: string[]; options: Parameters<typeof Bun.spawn>[1] }> =
    []
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let closed = false
  let killed = false
  let exitResolver: (() => void) | null = null
  const exited = new Promise<void>((resolve) => {
    exitResolver = resolve
  })

  const terminal = {
    write: (data: string) => {
      writes.push(data)
    },
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows })
    },
    close: () => {
      closed = true
    },
  }

  const spawn = (args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    calls.push({ args, options })
    return {
      terminal,
      exited,
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }

  return {
    spawn,
    calls,
    writes,
    resizes,
    terminal,
    exited,
    resolveExit: () => exitResolver?.(),
    wasClosed: () => closed,
    wasKilled: () => killed,
  }
}

describe('TerminalProxy', () => {
  test('spawns tmux attach once and forwards data', () => {
    const spawnStub = createSpawnStub()
    const received: string[] = []
    const proxy = new TerminalProxy(
      'agentboard:1',
      {
        onData: (data) => received.push(data),
      },
      spawnStub.spawn
    )

    proxy.start()
    proxy.start()

    expect(spawnStub.calls).toHaveLength(1)
    expect(spawnStub.calls[0]?.args).toEqual([
      'tmux',
      'attach',
      '-t',
      'agentboard:1',
    ])

    const terminalOptions =
      spawnStub.calls[0]?.options?.terminal as Bun.TerminalOptions | undefined
    const dataHandler = terminalOptions?.data
    const payload = new TextEncoder().encode('hello')
    dataHandler?.(spawnStub.terminal as unknown as Bun.Terminal, payload)

    expect(received).toEqual(['hello'])
  })

  test('write, resize, and dispose proxy terminal interactions', async () => {
    const spawnStub = createSpawnStub()
    let exitCount = 0
    const proxy = new TerminalProxy(
      'agentboard:2',
      {
        onData: () => {},
        onExit: () => {
          exitCount += 1
        },
      },
      spawnStub.spawn
    )

    proxy.start()
    proxy.write('ls')
    proxy.resize(120, 40)
    proxy.dispose()

    expect(spawnStub.writes).toEqual(['ls'])
    expect(spawnStub.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(spawnStub.wasClosed()).toBe(true)
    expect(spawnStub.wasKilled()).toBe(true)

    spawnStub.resolveExit()
    await spawnStub.exited
    await Promise.resolve()

    expect(exitCount).toBe(1)
  })
})
