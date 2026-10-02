/**
 * Tests the e2e harness's tmux reaping (tests/e2e/tmuxReap.ts) against real
 * private tmux servers. Each server lives in its own temp dir laid out like an
 * e2e run (`abe2e-*` with tmux-<uid>/default) and is only ever addressed by
 * that explicit socket path with TMUX removed from the environment.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  reapPrivateTmuxServer,
  reapStaleE2eServers,
  socketPath,
} from '../../../tests/e2e/tmuxReap'
import { createTmuxTmpDir, isTmuxAvailable, privateTmuxEnv } from './testEnvironment'

if (!isTmuxAvailable()) {
  test.skip('tmux not available - skipping e2e tmux reap test', () => {})
} else {
  describe('e2e tmux reaping', () => {
    const root = createTmuxTmpDir('ab-reap-')
    const repoRoot = path.join(root, 'repo')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(repoRoot)
    fs.mkdirSync(elsewhere)
    const standIn = path.join(root, 'standin.sh')
    fs.writeFileSync(standIn, "#!/bin/sh\ntrap '' HUP\nexec sleep 300\n", { mode: 0o755 })
    const started: number[] = []

    const tmux = (socket: string, args: string[], cwd = repoRoot): string => {
      const result = Bun.spawnSync(['tmux', '-S', socket, ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: privateTmuxEnv(null),
        timeout: 5000,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString()
    }

    const isAlive = (pid: number): boolean => {
      const stat = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
      return stat !== '' && !stat.startsWith('Z')
    }

    const waitUntil = (check: () => boolean, timeoutMs = 3000): boolean => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (check()) return true
        Bun.sleepSync(20)
      }
      return check()
    }

    const deadPid = (): number => {
      const proc = Bun.spawnSync(['sh', '-c', 'echo $$'])
      return Number.parseInt(proc.stdout.toString(), 10)
    }

    // An e2e-like run dir whose server runs a HUP-ignoring pane process, so
    // kill-server alone would leave it behind holding a pty.
    const makeRun = (name: string, lockPid: number | null, cwd = repoRoot) => {
      const dir = path.join(root, name)
      fs.mkdirSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`), { recursive: true })
      if (lockPid !== null) {
        fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: lockPid }))
      }
      const socket = socketPath(dir)
      tmux(socket, ['-f', '/dev/null', 'new-session', '-d', '-s', 'e2e', '-P', '-F', '#{pane_pid}', standIn, 'x'], cwd)
      const panePid = Number.parseInt(
        tmux(socket, ['list-panes', '-a', '-F', '#{pane_pid}'], cwd),
        10
      )
      started.push(panePid)
      // Wait for the trap to be in place (the script exec'd sleep).
      expect(
        waitUntil(() =>
          Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(panePid)]).stdout.toString().trim().endsWith('sleep')
        )
      ).toBe(true)
      return { dir, socket, panePid }
    }

    afterAll(() => {
      for (const pid of started) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone
        }
      }
      for (const entry of fs.readdirSync(root)) {
        const socket = socketPath(path.join(root, entry))
        if (fs.existsSync(socket)) {
          Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { env: privateTmuxEnv(null) })
        }
      }
      fs.rmSync(root, { recursive: true, force: true })
    })

    test('kill-server alone leaves a HUP-ignoring pane process alive', () => {
      const run = makeRun('abe2e-control', process.pid)
      tmux(run.socket, ['kill-server'])
      expect(waitUntil(() => !isAlive(run.panePid), 500)).toBe(false)
      process.kill(run.panePid, 'SIGKILL')
    }, 30_000)

    test('reapPrivateTmuxServer kills the server and processes that outlive it', () => {
      const run = makeRun('abe2e-teardown', process.pid)
      expect(reapPrivateTmuxServer(run.socket)).toBe(1)
      expect(waitUntil(() => !isAlive(run.panePid))).toBe(true)
      expect(reapPrivateTmuxServer(path.join(root, 'missing', 'sock'))).toBe(0)
    }, 30_000)

    test('reapStaleE2eServers only reaps dead runs of this checkout', () => {
      const current = makeRun('abe2e-current', null)
      const stale = makeRun('abe2e-stale', deadPid())
      const live = makeRun('abe2e-live', process.pid)
      const foreign = makeRun('abe2e-foreign', deadPid(), elsewhere)
      const freshUnlocked = makeRun('abe2e-unlocked', null)
      const notE2e = makeRun('other-stale', deadPid())

      const reaped = reapStaleE2eServers(root, current.dir, repoRoot)

      expect(reaped).toEqual([stale.dir])
      expect(waitUntil(() => !isAlive(stale.panePid))).toBe(true)
      expect(fs.existsSync(stale.dir)).toBe(false)
      for (const kept of [current, live, foreign, freshUnlocked, notE2e]) {
        expect(isAlive(kept.panePid)).toBe(true)
        expect(fs.existsSync(kept.socket)).toBe(true)
      }

      // Without a lock file, a run counts as dead only once it is old.
      const later = Date.now() + 2 * 60 * 60 * 1000
      expect(reapStaleE2eServers(root, current.dir, repoRoot, later)).toEqual([freshUnlocked.dir])
      for (const run of [current, live, foreign, notE2e]) reapPrivateTmuxServer(run.socket)
    }, 60_000)
  })
}
