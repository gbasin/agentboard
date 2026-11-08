// Real macOS regression for shells adopted by PID 1 after private tmux exits.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createGroupedSession, getThrowawayCwd } from '../tmuxGroupedSession'
import { spawnWithTimeout, ThrowawayShellReaper } from '../throwawayShellReaper'
import { createTmuxTmpDir, isTmuxAvailable, privateTmuxEnv } from './testEnvironment'

const enabled = process.platform === 'darwin' && isTmuxAvailable()
test.skipIf(!enabled)('reclaims only marked shells after their tmux server exits', async () => {
  const dir = createTmuxTmpDir('ab-orphan-')
  const env = privateTmuxEnv(dir)
  const socket = path.join(dir, 'socket')
  const pids: number[] = []
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(['tmux', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const ps = (pid: number, field: string) => Bun.spawnSync(
    ['ps', '-o', `${field}=`, '-p', String(pid)], { env, stdout: 'pipe', stderr: 'ignore' }
  ).stdout.toString().trim()
  const alive = (pid: number) => { const state = ps(pid, 'stat'); return state !== '' && !state.startsWith('Z') }
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return
      await Bun.sleep(30)
    }
    throw new Error('Timed out waiting for orphan lifecycle')
  }
  try {
    const standIn = path.join(dir, 'standin')
    fs.writeFileSync(standIn, "#!/bin/bash\ntrap '' HUP\nexec -a -standin sleep 300\n", { mode: 0o755 })
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'base', 'sleep', '300'])
    tmux(['set-option', '-g', 'default-shell', '/usr/bin/true'])
    createGroupedSession({ runTmux: tmux }, '=base', 'marked-group')
    expect(tmux(['display-message', '-p', '-t', 'marked-group:', '#{pane_current_path}'])).toBe(process.cwd())
    tmux(['kill-session', '-t', '=marked-group'])
    for (const marked of [true, false]) {
      const output = tmux(['new-window', '-d', '-P', '-F', '#{pane_pid} #{window_id}',
        '-t', 'base:', '-c', marked ? getThrowawayCwd() : dir, standIn, 'stand-in'])
      const [pidText, window] = output.split(' ')
      const pid = Number(pidText)
      pids.push(pid)
      await waitFor(() => ps(pid, 'comm') === '-standin')
      tmux(['kill-window', '-t', window!])
      expect(alive(pid)).toBe(true)
    }
    // Last session exits its private server; both survivors move to PID 1.
    tmux(['kill-session', '-t', '=base'])
    await waitFor(() => pids.every((pid) => ps(pid, 'ppid') === '1'))
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'observer', 'sleep', '300'])
    const serverPid = Number(tmux(['display-message', '-p', '#{pid}']))
    const reaper = new ThrowawayShellReaper({
      getServerPid: () => serverPid,
      timing: { minAgeMs: 0, hupGraceMs: 50 },
      log: () => {},
      runCommand: async (argv, timeout) => {
        // Limit discovery to this test's PIDs; all subsequent evidence is real.
        if (argv[0] === 'pgrep' && argv[2] === `${serverPid},1`) {
          return Promise.resolve({ exitCode: 0, stdout: pids.join('\n') })
        }
        const result = await spawnWithTimeout(argv[0] === 'tmux'
          ? ['env', '-u', 'TMUX', 'tmux', '-S', socket, ...argv.slice(1)] : argv, timeout)
        return result
      },
    })
    expect(await reaper.runNow()).toEqual({ kind: 'reaped', hupPids: [pids[0]], killedPids: [pids[0]] })
    await waitFor(() => !alive(pids[0]!))
    expect(alive(pids[1]!)).toBe(true)
  } finally {
    for (const pid of pids) {
      if (ps(pid, 'comm') === '-standin') {
        try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
    }
    for (const session of ['marked-group', 'base', 'observer']) {
      try { tmux(['kill-session', '-t', `=${session}`]) } catch { /* Already exited. */ }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
