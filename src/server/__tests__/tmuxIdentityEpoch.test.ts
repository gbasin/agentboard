/** The tmux server epoch survives a concurrent first write. */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { ensureTmuxServerEpoch } from '../persistence/tmuxIdentity'

type SpawnResult = ReturnType<typeof Bun.spawnSync>
const result = (exitCode: number, stdout = '', stderr = '') =>
  ({ exitCode, signalCode: undefined, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), success: exitCode === 0 }) as unknown as SpawnResult

let restore: (() => void) | undefined
afterEach(() => restore?.())

function stubTmux(respond: (args: string[]) => SpawnResult) {
  const calls: string[][] = []
  const spy = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = command.slice(1)
    calls.push(args)
    return respond(args)
  }) as unknown as typeof Bun.spawnSync)
  restore = () => spy.mockRestore()
  return calls
}

test('a concurrent setter wins the epoch and the reader adopts it', () => {
  let reads = 0
  const calls = stubTmux(args => {
    if (args[0] === 'show-options') return result(0, reads++ === 0 ? '' : 'winner-epoch\n')
    return result(1, '', 'already set: @agentboard-server-id')
  })
  expect(ensureTmuxServerEpoch()).toBe('winner-epoch')
  expect(calls.map(args => args[0])).toEqual(['show-options', 'set-option', 'show-options'])
})

test('other set-option failures still fail', () => {
  stubTmux(args => args[0] === 'show-options' ? result(0, '') : result(1, '', 'no server running'))
  expect(() => ensureTmuxServerEpoch()).toThrow('no server running')
})

test('an existing epoch is returned without writing', () => {
  const calls = stubTmux(() => result(0, 'stable-epoch\n'))
  expect(ensureTmuxServerEpoch()).toBe('stable-epoch')
  expect(calls).toHaveLength(1)
})
