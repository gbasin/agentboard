// Regression: private tmux exits before cleanup; its marked shell moves to PID 1.
import { describe, expect, test } from 'bun:test'
import { ThrowawayShellReaper } from '../throwawayShellReaper'
import { getThrowawayCwd } from '../tmuxGroupedSession'

function fixture(options: {
  marker?: string
  extraFd?: boolean
  children?: boolean
  young?: boolean
  startsAfterHup?: boolean
  adoptedAfterHup?: boolean
} = {}) {
  const signals: Array<[number, string]> = []
  const logs: unknown[] = []
  const reaper = new ThrowawayShellReaper({
    getServerPid: () => 500,
    platform: 'darwin',
    signal: (pid, signal) => { signals.push([pid, signal]) },
    sleep: async () => {},
    log: (...args) => { logs.push(args) },
    runCommand: async (argv) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout })
      if (argv[0] === 'pgrep') {
        return ok(argv[2] === '500,1' ? '601' : options.children ? '900' : '')
      }
      if (argv[0] === 'ps') {
        if (argv.includes('900')) return ok('900 601 10:00 S ttys001 vim')
        const parent = options.adoptedAfterHup && signals.length === 0 ? 500 : 1
        return ok(`601 ${parent} ${options.young ? '00:05' : '10:00'} Ss+ ttys001 -zsh`)
      }
      if (argv[0] === 'tmux') return ok('500 700')
      if (argv[0] === 'lsof') return ok(`p601\nfcwd\nn${options.marker ?? getThrowawayCwd()}\nf0\nf1\nf2\n${options.extraFd || (options.startsAfterHup && signals.length) ? 'f10\n' : ''}`)
      throw new Error(`Unexpected command: ${argv[0]}`)
    },
  })
  return { reaper, signals, logs }
}

describe('orphan throwaway shells', () => {
  test('reaps a marked shell after the original tmux server has exited', async () => {
    const { reaper, signals, logs } = fixture()
    expect(await reaper.runNow()).toEqual({ kind: 'reaped', hupPids: [601], killedPids: [601] })
    expect(signals).toEqual([[601, 'SIGHUP'], [601, 'SIGKILL']])
    expect(JSON.stringify(logs)).not.toContain('SECRET')
  })

  test.each([
    ['unmarked', { marker: 'OTHER=1' }],
    ['a directory with a similar name', { marker: `${getThrowawayCwd()}-other` }],
    ['a child of the marker directory', { marker: `${getThrowawayCwd()}/child` }],
    ['started normally', { extraFd: true }],
    ['has children', { children: true }],
    ['too young', { young: true }],
    ['missing provenance', { marker: '' }],
  ])('does not signal an orphan that is %s', async (_label, options) => {
    const { reaper, signals } = fixture(options)
    await reaper.runNow()
    expect(signals).toEqual([])
  })

  test('rechecks fds before escalating, leaving a shell that completed startup alone', async () => {
    const { reaper, signals } = fixture({ startsAfterHup: true })
    expect(await reaper.runNow()).toEqual({ kind: 'reaped', hupPids: [601], killedPids: [] })
    expect(signals).toEqual([[601, 'SIGHUP']])
  })

  test('follows a marked shell adopted between HUP and the recheck', async () => {
    const { reaper, signals } = fixture({ adoptedAfterHup: true })
    await reaper.runNow()
    expect(signals).toEqual([[601, 'SIGHUP'], [601, 'SIGKILL']])
  })
})
