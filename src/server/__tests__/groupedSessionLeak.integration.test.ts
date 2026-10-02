/**
 * Regression test for the grouped-session pty leak (see tmuxGroupedSession.ts
 * and throwawayShellReaper.ts).
 *
 * Every `new-session -t` makes tmux fork a login shell for an initial window
 * it discards at once. When the kernel's hangup misses that shell (a race
 * that only shows under load), the shell blocks forever holding a pty. The
 * race itself is not reproducible on demand, so this test manufactures the
 * same end state deterministically: a tmux child with a login argv0
 * (`-standin`), only fds 0-2 open and no children, that ignores SIGHUP and
 * outlives its pane. It checks that the stand-in survives without the
 * reaper, that one reaper run kills it, and that look-alikes which miss the
 * signature (an extra open fd, a live pane) survive the same run.
 *
 * Runs on a private tmux server addressed by an explicit -S socket path, with
 * TMUX removed from the environment, so it can never touch a live server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createGroupedSession } from '../tmuxGroupedSession'
import { spawnWithTimeout, ThrowawayShellReaper } from '../throwawayShellReaper'
import { createTmuxTmpDir, isTmuxAvailable, privateTmuxEnv } from './testEnvironment'

const MIN_AGE_MS = 1_000

if (!isTmuxAvailable()) {
  test.skip('tmux not available - skipping grouped session leak test', () => {})
} else {
  describe('grouped session throwaway shell', () => {
    let dir = ''
    let socket = ''
    let standIn = ''
    let standInWithFd = ''
    let serverPid = 0

    const tmux = (args: string[]): string => {
      const result = Bun.spawnSync(['tmux', '-S', socket, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: privateTmuxEnv(null),
        timeout: 5000,
      })
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || `tmux ${args[0]} failed`)
      }
      return result.stdout.toString()
    }

    const psField = (pid: number, field: string): string =>
      Bun.spawnSync(['ps', '-o', `${field}=`, '-p', String(pid)]).stdout.toString().trim()

    // A killed child stays a zombie until tmux reaps it; that holds no pty.
    const isAlive = (pid: number): boolean => {
      const state = psField(pid, 'stat')
      return state !== '' && !state.startsWith('Z')
    }

    const waitFor = (check: () => boolean, timeoutMs = 3000): boolean => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (check()) return true
        Bun.sleepSync(20)
      }
      return check()
    }

    const serverChildren = (): number[] =>
      Bun.spawnSync(['pgrep', '-P', String(serverPid)])
        .stdout.toString()
        .split('\n')
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 1)

    const panePids = (): Set<number> =>
      new Set(
        tmux(['list-panes', '-a', '-F', '#{pane_pid}'])
          .split('\n')
          .map((line) => Number.parseInt(line, 10))
      )

    const strayServerChildren = (): number[] => {
      const panes = panePids()
      return serverChildren().filter((pid) => !panes.has(pid) && isAlive(pid))
    }

    // A pane process running the stand-in, waited on until it has exec'd.
    const startStandIn = (script: string): number => {
      const pid = Number.parseInt(
        // Two argv words make tmux execvp the script instead of passing it
        // to default-shell -c (which is `true` here).
        tmux(['new-window', '-d', '-P', '-F', '#{pane_pid}', '-t', 'base:', script, 'stand-in']),
        10
      )
      if (!waitFor(() => psField(pid, 'comm') === '-standin')) {
        throw new Error('stand-in never started')
      }
      return pid
    }

    // A stand-in that outlives its pane: started as a window, then orphaned
    // by kill-window (it ignores the SIGHUP that follows).
    const makeSurvivor = (script = standIn): number => {
      const pid = startStandIn(script)
      const windowId = tmux(['list-panes', '-a', '-F', '#{pane_pid} #{window_id}'])
        .split('\n')
        .find((line) => line.startsWith(`${pid} `))
        ?.split(' ')[1]
      if (!windowId) throw new Error('stand-in window not found')
      tmux(['kill-window', '-t', windowId])
      return pid
    }

    const makeReaper = () =>
      new ThrowawayShellReaper({
        getServerPid: () => serverPid,
        timing: { minAgeMs: MIN_AGE_MS, hupGraceMs: 500 },
        log: () => {},
        // Pin every tmux call the reaper makes to the private socket.
        runCommand: (argv, timeoutMs) =>
          spawnWithTimeout(
            argv[0] === 'tmux' ? ['env', '-u', 'TMUX', 'tmux', '-S', socket, ...argv.slice(1)] : argv,
            timeoutMs
          ),
      })

    beforeAll(() => {
      dir = createTmuxTmpDir('ab-grp-')
      socket = path.join(dir, 'sock')
      standIn = path.join(dir, 'standin.sh')
      standInWithFd = path.join(dir, 'standin-fd.sh')
      // `exec -a -standin` gives the login-shell argv0 the reaper looks for;
      // exec closes the script's own fd, leaving only the pty on 0-2.
      fs.writeFileSync(standIn, "#!/bin/bash\ntrap '' HUP\nexec -a -standin sleep 300\n", { mode: 0o755 })
      fs.writeFileSync(
        standInWithFd,
        "#!/bin/bash\ntrap '' HUP\nexec 3</dev/null\nexec -a -standin sleep 300\n",
        { mode: 0o755 }
      )
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'base', 'tail -f /dev/null'])
      // The real discarded shell would add noise (it can itself survive
      // under load); a shell that exits at once keeps the stand-ins the only
      // candidates.
      tmux(['set-option', '-g', 'default-shell', Bun.which('true') ?? '/usr/bin/true'])
      serverPid = Number.parseInt(tmux(['display-message', '-p', '#{pid}']), 10)
    })

    afterAll(() => {
      const children = serverPid > 1 ? serverChildren() : []
      try {
        tmux(['kill-server'])
      } catch {
        // Already gone
      }
      for (const pid of children) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already exited
        }
      }
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('tmux forks a pane for every grouped new-session', () => {
      const paneNumber = () =>
        Number.parseInt(
          tmux(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'base:', 'tail -f /dev/null']).slice(1),
          10
        )
      const first = paneNumber()
      createGroupedSession({ runTmux: tmux }, '=base', 'probe-ws')
      const next = paneNumber()
      tmux(['kill-session', '-t', '=probe-ws'])
      // One pane id went to the initial window tmux spawned and discarded.
      expect(next - first).toBe(2)
    })

    // macOS only: the stand-in is identified by its argv0 (`exec -a -standin`),
    // which Linux's `ps comm` does not report, so it is never seen to start
    // there. This failed the release workflow's commit hook on a Linux runner.
    test.skipIf(process.platform !== 'darwin')('without the reaper, a pane process that missed its hangup survives', () => {
      createGroupedSession({ runTmux: tmux }, '=base', 'control-ws')
      const survivor = makeSurvivor()
      tmux(['kill-session', '-t', '=control-ws'])
      Bun.sleepSync(MIN_AGE_MS + 500)
      expect(isAlive(survivor)).toBe(true)
      expect(strayServerChildren()).toEqual([survivor])
      process.kill(survivor, 'SIGKILL')
      expect(waitFor(() => !isAlive(survivor))).toBe(true)
    }, 30_000)

    // macOS only: the reaper recognizes the discarded shell by the tty it
    // still holds after its pane is gone. Linux drops a process's controlling
    // tty when the pty master closes, so there the reaper does not run.
    test.skipIf(process.platform !== 'darwin')(
      'one reaper run kills matching stand-ins and spares look-alikes',
      async () => {
        let armed = 0
        const survivors: number[] = []
        for (let i = 0; i < 3; i += 1) {
          createGroupedSession(
            { runTmux: tmux, onCreated: () => (armed += 1) },
            '=base',
            `leak-ws-${i}`
          )
          survivors.push(makeSurvivor())
          tmux(['kill-session', '-t', `=leak-ws-${i}`])
        }
        expect(armed).toBe(3)
        // Same signature but an extra open fd: a shell that finished starting.
        const withFd = makeSurvivor(standInWithFd)
        // Same signature but still a pane.
        const livePane = startStandIn(standIn)
        Bun.sleepSync(MIN_AGE_MS + 1_100)

        const outcome = await makeReaper().runNow()

        expect(outcome.kind).toBe('reaped')
        if (outcome.kind !== 'reaped') return
        expect([...outcome.hupPids].sort()).toEqual([...survivors].sort())
        // The stand-ins ignore SIGHUP, so each needed the SIGKILL follow-up.
        expect([...outcome.killedPids].sort()).toEqual([...survivors].sort())
        expect(waitFor(() => survivors.every((pid) => !isAlive(pid)))).toBe(true)
        expect(isAlive(withFd)).toBe(true)
        expect(isAlive(livePane)).toBe(true)
        expect(strayServerChildren()).toEqual([withFd])

        // A second run finds nothing more to do.
        expect(await makeReaper().runNow()).toEqual({ kind: 'nothing' })
        process.kill(withFd, 'SIGKILL')
        expect(waitFor(() => !isAlive(withFd))).toBe(true)
      },
      60_000
    )
  })
}
