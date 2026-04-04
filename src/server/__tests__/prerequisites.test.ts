import { afterEach, describe, expect, test } from 'bun:test'
import { ensureTmux } from '../prerequisites'

const bunAny = Bun as typeof Bun & {
  spawnSync: typeof Bun.spawnSync
}

const originalSpawnSync = bunAny.spawnSync

afterEach(() => {
  bunAny.spawnSync = originalSpawnSync
})

describe('ensureTmux', () => {
  test('does nothing when tmux is available', () => {
    bunAny.spawnSync = () =>
      ({
        exitCode: 0,
        stdout: Buffer.from('tmux 3.4'),
        stderr: Buffer.from(''),
      }) as ReturnType<typeof Bun.spawnSync>

    expect(() => ensureTmux()).not.toThrow()
  })

  test('throws when tmux returns non-zero', () => {
    bunAny.spawnSync = () =>
      ({
        exitCode: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from('not found'),
      }) as ReturnType<typeof Bun.spawnSync>

    expect(() => ensureTmux()).toThrow(/tmux is required/i)
  })

  test('throws when tmux probe times out', () => {
    bunAny.spawnSync = () =>
      ({
        exitCode: null,
        signalCode: 'SIGTERM',
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      }) as unknown as ReturnType<typeof Bun.spawnSync>

    expect(() => ensureTmux()).toThrow(/did not respond to the startup probe/i)

    try {
      ensureTmux()
      throw new Error('Expected ensureTmux to throw')
    } catch (error) {
      expect((error as Error).message).not.toContain('brew install tmux')
    }
  })

  test('throws when spawnSync fails', () => {
    bunAny.spawnSync = () => {
      throw new Error('boom')
    }

    expect(() => ensureTmux()).toThrow(/boom/)
  })
})
