import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TIMING,
  findStuckShells,
  parseEtime,
  parseLsofFds,
  parsePaneList,
  parseProcessInfo,
  spawnWithTimeout,
  ThrowawayShellReaper,
  type CommandResult,
  type ProcessInfo,
  type ReaperTiming,
  type StuckShellEvidence,
} from '../throwawayShellReaper'

const SERVER = 500
const OLD = 3600

function row(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return { pid: 601, ppid: SERVER, ageSec: OLD, stat: 'Ss+', tty: 'ttys044', comm: '-zsh', ...overrides }
}

function evidence(overrides: Partial<StuckShellEvidence> = {}): StuckShellEvidence {
  return {
    rows: [row()],
    serverPid: SERVER,
    panePids: new Set([700]),
    parentsWithChildren: new Set(),
    fdsByPid: new Map([[601, new Set([0, 1, 2])]]),
    minAgeMs: 60_000,
    ...overrides,
  }
}

describe('findStuckShells', () => {
  test('matches the stuck throwaway shell signature', () => {
    expect(findStuckShells(evidence())).toEqual([601])
  })

  test.each([
    ['a pane pid', { panePids: new Set([601]) }],
    ['no tty', { rows: [row({ tty: '??' })] }],
    ['too young', { rows: [row({ ageSec: 59 })] }],
    ['children', { parentsWithChildren: new Set([601]) }],
    ['an extra open fd (zsh started)', { fdsByPid: new Map([[601, new Set([0, 1, 2, 10])]]) }],
    ['an extra open fd (bash started)', { fdsByPid: new Map([[601, new Set([0, 1, 2, 255])]]) }],
    ['fewer than three fds', { fdsByPid: new Map([[601, new Set([0, 1])]]) }],
    ['no fd evidence', { fdsByPid: new Map() }],
    ['a popup argv0', { rows: [row({ comm: '/bin/zsh' })] }],
    ['a job argv0', { rows: [row({ comm: 'sh' })] }],
    ['a bare dash', { rows: [row({ comm: '-' })] }],
    ['another parent', { rows: [row({ ppid: 1 })] }],
    ['a zombie', { rows: [row({ stat: 'Z' })] }],
  ] as const)('excludes a process with %s', (_label, overrides) => {
    expect(findStuckShells(evidence(overrides as Partial<StuckShellEvidence>))).toEqual([])
  })
})

describe('parsers', () => {
  test('parseEtime handles every ps etime shape', () => {
    expect(parseEtime('00:59')).toBe(59)
    expect(parseEtime('01:00')).toBe(60)
    expect(parseEtime('02:03:04')).toBe(7384)
    expect(parseEtime('1-00:00:01')).toBe(86_401)
    expect(parseEtime('garbage')).toBeNaN()
  })

  test('parseProcessInfo keeps spaces in comm and skips junk', () => {
    expect(
      parseProcessInfo(' 601   500   01:02 Ss+  ttys044  -zsh\n 602 500 00:01 S ?? /A B/c\nnope\n')
    ).toEqual([
      row({ ageSec: 62 }),
      { pid: 602, ppid: 500, ageSec: 1, stat: 'S', tty: '??', comm: '/A B/c' },
    ])
  })

  test('parsePaneList and parseLsofFds', () => {
    expect(parsePaneList('500 700\n500 701\n\n')).toEqual({
      serverPids: new Set([500]),
      panePids: new Set([700, 701]),
    })
    expect(parseLsofFds('p601\nfcwd\nftxt\nf0\nf1\nf2\np602\nf0\nf10\n')).toEqual(
      new Map([
        [601, new Set([0, 1, 2])],
        [602, new Set([0, 10])],
      ])
    )
  })
})

describe('spawnWithTimeout', () => {
  test('returns exit code and stdout', async () => {
    expect(await spawnWithTimeout(['echo', 'hi'], 5_000)).toEqual({ exitCode: 0, stdout: 'hi\n' })
  })

  test('kills a slow command and returns null without waiting it out', async () => {
    const startedAt = performance.now()
    expect(await spawnWithTimeout(['sleep', '5'], 100)).toBeNull()
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })

  test('reports a command that cannot start as a failure', async () => {
    expect(await spawnWithTimeout(['/nonexistent/agentboard-test-binary'], 1_000)).toEqual({
      exitCode: -1,
      stdout: '',
    })
  })
})

type Responder = (argv: string[]) => CommandResult | null | Promise<CommandResult | null>

function ok(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, stdout }
}

// Server 500 has a pane (700), the stuck shell (601), a young throwaway
// (602), a popup (603) and a job (604).
const PS_ROWS = [
  ' 700 500 10:00 Ss+ ttys001 -zsh',
  ' 601 500 10:00 Ss+ ttys044 -zsh',
  ' 602 500 00:05 Ss+ ttys045 -zsh',
  ' 603 500 10:00 Ss+ ttys046 /bin/zsh',
  ' 604 500 10:00 S ?? sh',
].join('\n')

function standardResponder(overrides: Partial<Record<string, Responder>> = {}): Responder {
  let psCalls = 0
  return (argv) => {
    const key = argv[0] === 'pgrep' && argv[2] !== String(SERVER) ? 'pgrep-candidates' : argv[0]!
    const override = overrides[key]
    if (override) return override(argv)
    switch (key) {
      case 'pgrep':
        return ok('700\n601\n602\n603\n604\n')
      case 'ps':
        psCalls += 1
        return psCalls === 1 ? ok(PS_ROWS) : ok(' 601 500 10:01 Ss+ ttys044 -zsh')
      case 'tmux':
        return ok('500 700\n')
      case 'pgrep-candidates':
        return ok('', 1)
      case 'lsof':
        return ok('p601\nfcwd\nf0\nf1\nf2\n')
      default:
        throw new Error(`unexpected ${key}`)
    }
  }
}

function makeReaper(respond: Responder, extra: { timing?: Partial<ReaperTiming>; serverPid?: number | null } = {}) {
  const calls: string[][] = []
  const signals: Array<[number, string]> = []
  const logs: Array<[string, Record<string, unknown>]> = []
  const reaper = new ThrowawayShellReaper({
    getServerPid: () => (extra.serverPid === undefined ? SERVER : extra.serverPid),
    platform: 'darwin',
    runCommand: async (argv) => {
      calls.push(argv)
      return respond(argv)
    },
    signal: (pid, signal) => {
      signals.push([pid, signal])
    },
    sleep: async () => {},
    log: (event, data) => logs.push([event, data]),
    timing: extra.timing,
  })
  return { reaper, calls, signals, logs }
}

describe('reap run', () => {
  test('HUPs the stuck shell, KILLs it if it survives, logs one line', async () => {
    const { reaper, calls, signals, logs } = makeReaper(standardResponder())
    expect(await reaper.runNow()).toEqual({ kind: 'reaped', hupPids: [601], killedPids: [601] })
    expect(signals).toEqual([
      [601, 'SIGHUP'],
      [601, 'SIGKILL'],
    ])
    expect(logs).toEqual([['tmux_group_throwaway_reaped', { hupPids: [601], killedPids: [601] }]])
    expect(calls).toEqual([
      ['pgrep', '-P', '500'],
      ['ps', '-o', 'pid=,ppid=,etime=,stat=,tty=,comm=', '-p', '700', '-p', '601', '-p', '602', '-p', '603', '-p', '604'],
      ['tmux', 'list-panes', '-a', '-F', '#{pid} #{pane_pid}'],
      ['pgrep', '-P', '601'],
      ['lsof', '-n', '-P', '-w', '-F', 'pf', '-p', '601'],
      ['ps', '-o', 'pid=,ppid=,etime=,stat=,tty=,comm=', '-p', '601'],
    ])
  })

  test('no SIGKILL when SIGHUP was enough', async () => {
    const { reaper, signals } = makeReaper(
      standardResponder({ ps: (() => { let n = 0; return () => (++n === 1 ? ok(PS_ROWS) : ok('', 1)) })() })
    )
    expect(await reaper.runNow()).toEqual({ kind: 'reaped', hupPids: [601], killedPids: [] })
    expect(signals).toEqual([[601, 'SIGHUP']])
  })

  test('a candidate with children is left alone', async () => {
    let psCalls = 0
    const { reaper, signals, logs } = makeReaper(
      standardResponder({
        'pgrep-candidates': () => ok('900\n'),
        ps: () => (++psCalls === 1 ? ok(PS_ROWS) : ok(' 900 601 00:30 S+ ttys044 vim')),
      })
    )
    expect(await reaper.runNow()).toEqual({ kind: 'nothing' })
    expect(signals).toEqual([])
    expect(logs).toEqual([])
  })

  test('an empty run is one spawn and no log', async () => {
    const { reaper, calls, logs } = makeReaper(standardResponder({ pgrep: () => ok('', 1) }))
    expect(await reaper.runNow()).toEqual({ kind: 'nothing' })
    expect(calls).toHaveLength(1)
    expect(logs).toEqual([])
  })

  test('skips the pane list when no row could match', async () => {
    const { reaper, calls } = makeReaper(standardResponder({ ps: () => ok(' 604 500 10:00 S ?? sh') }))
    expect(await reaper.runNow()).toEqual({ kind: 'nothing' })
    expect(calls.map((argv) => argv[0])).toEqual(['pgrep', 'ps'])
  })

  test.each(['pgrep', 'ps', 'tmux', 'pgrep-candidates', 'lsof'])(
    'a timed-out %s abandons the run quietly',
    async (step) => {
      const { reaper, signals, logs } = makeReaper(standardResponder({ [step]: () => null }))
      const outcome = await reaper.runNow()
      expect(outcome).toMatchObject({ kind: 'abandoned', reason: 'timeout' })
      expect(signals).toEqual([])
      expect(logs).toHaveLength(1)
      expect(logs[0]?.[0]).toBe('tmux_throwaway_reap_abandoned')
      expect(JSON.stringify(logs[0]?.[1])).not.toContain('-p')
    }
  )

  test('a failing step abandons the run', async () => {
    const { reaper, signals, logs } = makeReaper(standardResponder({ lsof: () => ok('', 2) }))
    expect(await reaper.runNow()).toEqual({ kind: 'abandoned', step: 'fds', reason: 'failed' })
    expect(signals).toEqual([])
    expect(logs).toEqual([['tmux_throwaway_reap_abandoned', { step: 'fds', reason: 'failed' }]])
  })

  test('a different tmux server in the pane list abandons the run', async () => {
    const { reaper, signals } = makeReaper(standardResponder({ tmux: () => ok('999 700\n') }))
    expect(await reaper.runNow()).toEqual({ kind: 'abandoned', step: 'panes', reason: 'server-changed' })
    expect(signals).toEqual([])
  })

  test('an unknown server pid abandons before any spawn', async () => {
    const { reaper, calls } = makeReaper(standardResponder(), { serverPid: null })
    expect(await reaper.runNow()).toEqual({ kind: 'abandoned', step: 'server-pid', reason: 'failed' })
    expect(calls).toEqual([])
  })

  test('never runs two passes at once', async () => {
    let release: (() => void) | null = null
    const { reaper } = makeReaper(
      standardResponder({
        pgrep: () =>
          new Promise((resolve) => {
            release = () => resolve(ok('', 1))
          }),
      })
    )
    const first = reaper.runNow()
    expect(await reaper.runNow()).toEqual({ kind: 'skipped', reason: 'in-flight' })
    release!()
    expect(await first).toEqual({ kind: 'nothing' })
  })

  test('does nothing off macOS', async () => {
    let timers = 0
    const reaper = new ThrowawayShellReaper({
      getServerPid: () => SERVER,
      platform: 'linux',
      runCommand: async () => {
        throw new Error('no spawn expected')
      },
      setTimer: () => {
        timers += 1
        return {}
      },
    })
    reaper.noteGroupedSessionCreated()
    expect(timers).toBe(0)
    expect(await reaper.runNow()).toEqual({ kind: 'skipped', reason: 'platform' })
  })
})

// Manual clock: timers fire in order as time advances; runs settle between.
function fakeClock() {
  let now = 1_000_000
  let nextId = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  return {
    now: () => now,
    pending: () => timers.size,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++nextId
      timers.set(id, { at: now + ms, fn })
      return { id }
    },
    clearTimer: (handle: { id?: number }) => {
      if (handle.id !== undefined) timers.delete(handle.id)
    },
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        await settle()
      }
      now = target
      await settle()
    },
  }
}

function scheduledReaper(timing: Partial<ReaperTiming> = {}, respond: Responder = () => ok('', 1)) {
  const clock = fakeClock()
  const runStarts: number[] = []
  const reaper = new ThrowawayShellReaper({
    getServerPid: () => SERVER,
    platform: 'darwin',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer as (handle: object) => void,
    sleep: async () => {},
    log: () => {},
    runCommand: async (argv) => {
      if (argv[0] === 'pgrep' && argv[2] === String(SERVER)) runStarts.push(clock.now())
      return respond(argv)
    },
    timing,
  })
  return { clock, reaper, runStarts }
}

describe('scheduling', () => {
  const { settleMs, minIntervalMs, maxDelayMs } = DEFAULT_TIMING

  test('defaults: settle past the age threshold, at most one run a minute', () => {
    expect(DEFAULT_TIMING.minAgeMs).toBe(60_000)
    expect(settleMs).toBeGreaterThan(DEFAULT_TIMING.minAgeMs)
    expect(minIntervalMs).toBe(60_000)
  })

  test('no creation, no run', async () => {
    const { clock, runStarts } = scheduledReaper()
    await clock.advance(10 * 60_000)
    expect(runStarts).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  test('a burst of connections produces one run, settleMs after the last', async () => {
    const { clock, reaper, runStarts } = scheduledReaper()
    const start = clock.now()
    for (let i = 0; i < 50; i += 1) {
      reaper.noteGroupedSessionCreated()
      await clock.advance(200)
    }
    const last = start + 49 * 200
    expect(clock.pending()).toBe(1)
    await clock.advance(10 * 60_000)
    expect(runStarts).toEqual([last + settleMs])
    expect(clock.pending()).toBe(0)
  })

  test('a creation right after a run waits for the minimum interval', async () => {
    const { clock, reaper, runStarts } = scheduledReaper({ settleMs: 5_000, minAgeMs: 1_000 })
    reaper.noteGroupedSessionCreated()
    await clock.advance(5_000)
    expect(runStarts).toHaveLength(1)
    reaper.noteGroupedSessionCreated()
    await clock.advance(10 * 60_000)
    expect(runStarts).toEqual([runStarts[0]!, runStarts[0]! + minIntervalMs])
  })

  test('a reconnect storm still runs every maxDelayMs, then once after it ends', async () => {
    const { clock, reaper, runStarts } = scheduledReaper()
    const start = clock.now()
    for (let t = 0; t < 5 * 60_000; t += 10_000) {
      reaper.noteGroupedSessionCreated()
      await clock.advance(10_000)
    }
    const lastCreation = start + 5 * 60_000 - 10_000
    await clock.advance(10 * 60_000)
    expect(runStarts[0]).toBe(start + maxDelayMs)
    for (let i = 1; i < runStarts.length; i += 1) {
      expect(runStarts[i]! - runStarts[i - 1]!).toBeGreaterThanOrEqual(minIntervalMs)
      expect(runStarts[i]! - runStarts[i - 1]!).toBeLessThanOrEqual(maxDelayMs)
    }
    // The final run is late enough to judge the last creation's shell.
    expect(runStarts.at(-1)!).toBeGreaterThanOrEqual(lastCreation + DEFAULT_TIMING.minAgeMs)
    expect(clock.pending()).toBe(0)
  })

  test('a timer that fires during a run is skipped, not queued', async () => {
    let release: (() => void) | null = null
    let first = true
    const { clock, reaper, runStarts } = scheduledReaper(
      { settleMs: 5_000, minIntervalMs: 5_000, minAgeMs: 1_000 },
      (argv) => {
        if (argv[0] === 'pgrep' && first) {
          first = false
          return new Promise((resolve) => {
            release = () => resolve(ok('', 1))
          })
        }
        return ok('', 1)
      }
    )
    reaper.noteGroupedSessionCreated()
    await clock.advance(5_000)
    expect(runStarts).toHaveLength(1)
    reaper.noteGroupedSessionCreated()
    await clock.advance(30_000)
    // Its timer fired mid-run and did nothing.
    expect(runStarts).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    release!()
    await clock.advance(0)
    // The finished run rescheduled the pending creation.
    expect(clock.pending()).toBe(1)
    await clock.advance(60_000)
    expect(runStarts).toHaveLength(2)
  })

  test('an abandoned run does not retry on its own', async () => {
    const { clock, reaper, runStarts } = scheduledReaper({}, () => null)
    reaper.noteGroupedSessionCreated()
    await clock.advance(10 * 60_000)
    expect(runStarts).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    reaper.noteGroupedSessionCreated()
    expect(clock.pending()).toBe(1)
  })

  test('dispose cancels the pending run', async () => {
    const { clock, reaper, runStarts } = scheduledReaper()
    reaper.noteGroupedSessionCreated()
    reaper.dispose()
    await clock.advance(10 * 60_000)
    expect(runStarts).toEqual([])
  })
})
