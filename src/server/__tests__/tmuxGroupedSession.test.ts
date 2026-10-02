import { describe, expect, test } from 'bun:test'
import {
  createGroupedSession,
  findThrowawayPanePids,
  listProcessesWithPs,
  parseProcessRows,
  PS_ARGS,
  type ProcessRow,
} from '../tmuxGroupedSession'

const SERVER = 500

function row(pid: number, ppid: number, tty: string, comm: string): ProcessRow {
  return { pid, ppid, tty, comm }
}

describe('parseProcessRows', () => {
  test('parses ps rows, keeping spaces in the command name', () => {
    const rows = parseProcessRows(
      [
        '  501   500 ttys017  -zsh',
        '  502   500 ??       /opt/homebrew/bin/tmux',
        '  503     1 ?        /Applications/Some App.app/x',
        'garbage',
        '',
      ].join('\n')
    )
    expect(rows).toEqual([
      row(501, 500, 'ttys017', '-zsh'),
      row(502, 500, '??', '/opt/homebrew/bin/tmux'),
      row(503, 1, '?', '/Applications/Some App.app/x'),
    ])
  })
})

describe('listProcessesWithPs', () => {
  test('runs ps with the expected columns and parses its output', () => {
    const calls: string[][] = []
    const rows = listProcessesWithPs((command) => {
      calls.push(command)
      return { exitCode: 0, stdout: Buffer.from('7 1 ?? launchd\n') }
    })
    expect(calls).toEqual([PS_ARGS])
    expect(rows).toEqual([row(7, 1, '??', 'launchd')])
  })

  test('returns null when ps fails or throws', () => {
    expect(listProcessesWithPs(() => ({ exitCode: 1, stdout: Buffer.from('') }))).toBeNull()
    expect(
      listProcessesWithPs(() => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })
})

describe('findThrowawayPanePids', () => {
  test('keeps only new, non-pane server children with a tty or still a tmux fork', () => {
    const before = new Set([10, 11])
    const after = [
      row(10, SERVER, 'ttys001', '-zsh'), // existed before
      row(12, SERVER, 'ttys002', 'claude'), // live pane
      row(13, SERVER, 'ttys003', '-zsh'), // throwaway shell
      row(14, SERVER, '??', '/opt/homebrew/bin/tmux'), // throwaway, not exec'd
      row(15, SERVER, '??', 'sh'), // run-shell / #() job
      row(16, 999, 'ttys004', '-zsh'), // someone else's child
      row(17, SERVER, '?', 'tmux: server'), // Linux proctitle form
    ]
    expect(findThrowawayPanePids(before, after, SERVER, new Set([12]))).toEqual([13, 14, 17])
  })
})

describe('createGroupedSession', () => {
  function harness({
    printed = `${SERVER}\n`,
    before = [row(10, SERVER, 'ttys001', 'tail')],
    after = [row(10, SERVER, 'ttys001', 'tail'), row(20, SERVER, 'ttys009', '-zsh')],
    panes = '10\n',
  }: {
    printed?: string
    before?: ProcessRow[] | null
    after?: ProcessRow[] | null
    panes?: string | Error
  } = {}) {
    const tmuxCalls: string[][] = []
    const killed: number[] = []
    const snapshots = [before, after]
    const deps = {
      runTmux: (args: string[]) => {
        tmuxCalls.push(args)
        if (args[0] === 'new-session') return printed
        if (args[0] === 'list-panes') {
          if (panes instanceof Error) throw panes
          return panes
        }
        throw new Error(`unexpected tmux ${args[0]}`)
      },
      listProcesses: () => snapshots.shift() ?? null,
      killProcess: (pid: number) => {
        killed.push(pid)
      },
    }
    return { deps, tmuxCalls, killed }
  }

  test('creates the grouped session and kills the discarded pane process', () => {
    const h = harness()
    const result = createGroupedSession(h.deps, '=base', 'base-ws-1')
    expect(h.tmuxCalls[0]).toEqual([
      'new-session', '-d', '-P', '-F', '#{pid}', '-t', '=base', '-s', 'base-ws-1',
    ])
    expect(h.tmuxCalls[1]).toEqual(['list-panes', '-a', '-F', '#{pane_pid}'])
    expect(result).toEqual({ reapedPids: [20] })
    expect(h.killed).toEqual([20])
  })

  test('skips listing panes when the server gained no children', () => {
    const h = harness({ after: [row(10, SERVER, 'ttys001', 'tail')] })
    expect(createGroupedSession(h.deps, 'base', 'ws')).toEqual({ reapedPids: [] })
    expect(h.tmuxCalls).toHaveLength(1)
    expect(h.killed).toEqual([])
  })

  test('never kills a new child that is a live pane', () => {
    const h = harness({ panes: '10\n20\n' })
    expect(createGroupedSession(h.deps, 'base', 'ws')).toEqual({ reapedPids: [] })
    expect(h.killed).toEqual([])
  })

  test('ignores kill errors for processes that already exited', () => {
    const h = harness()
    h.deps.killProcess = () => {
      throw new Error('ESRCH')
    }
    expect(createGroupedSession(h.deps, 'base', 'ws')).toEqual({ reapedPids: [20] })
  })

  test('still creates the session but skips reaping when it cannot be done safely', () => {
    expect(createGroupedSession(harness({ before: null }).deps, 'b', 'w')).toEqual({
      reapedPids: [],
      skipped: 'process-list-failed',
    })
    expect(createGroupedSession(harness({ after: null }).deps, 'b', 'w')).toEqual({
      reapedPids: [],
      skipped: 'process-list-failed',
    })
    expect(createGroupedSession(harness({ printed: '' }).deps, 'b', 'w')).toEqual({
      reapedPids: [],
      skipped: 'server-pid-unknown',
    })
    const noPanes = harness({ panes: new Error('no server') })
    expect(createGroupedSession(noPanes.deps, 'b', 'w')).toEqual({
      reapedPids: [],
      skipped: 'pane-list-failed',
    })
    expect(noPanes.killed).toEqual([])
  })

  test('propagates new-session failures without reaping', () => {
    const h = harness()
    h.deps.runTmux = () => {
      throw new Error('duplicate session: w')
    }
    expect(() => createGroupedSession(h.deps, 'b', 'w')).toThrow('duplicate session')
    expect(h.killed).toEqual([])
  })
})
