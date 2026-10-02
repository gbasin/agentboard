/**
 * Regression test for the grouped-session pty leak (see tmuxGroupedSession.ts).
 *
 * Every `new-session -t` makes tmux fork a login shell for an initial window
 * it discards at once. When the kernel's hangup misses that shell (a race
 * that only shows under load), the shell blocks forever holding a pty. The
 * race itself is not reproducible on demand, so this test manufactures the
 * same end state deterministically: a tmux child that outlives its pane and
 * ignores SIGHUP, created while a grouped session is being made. It then
 * checks that createGroupedSession leaves no such process behind, and that
 * without it the process does survive (so the test can detect a regression).
 *
 * Runs on a private tmux server addressed by an explicit -S socket path, with
 * TMUX removed from the environment, so it can never touch a live server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createGroupedSession,
  listProcessesWithPs,
} from '../tmuxGroupedSession'
import { createTmuxTmpDir, isTmuxAvailable, privateTmuxEnv } from './testEnvironment'

const ITERATIONS = 5

if (!isTmuxAvailable()) {
  test.skip('tmux not available - skipping grouped session leak test', () => {})
} else {
  describe('grouped session throwaway shell', () => {
    let dir = ''
    let socket = ''
    let standIn = ''
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

    const strayServerChildren = (): number[] => {
      const panes = new Set(
        tmux(['list-panes', '-a', '-F', '#{pane_pid}'])
          .split('\n')
          .map((line) => Number.parseInt(line, 10))
      )
      return (listProcessesWithPs() ?? [])
        .filter((r) => r.ppid === serverPid && !panes.has(r.pid))
        .map((r) => r.pid)
        .filter(isAlive)
    }

    // A pane process that outlives its pane: started as a window, given time
    // to ignore SIGHUP, then orphaned by kill-window. Synchronous so it can
    // run inside createGroupedSession's runTmux, between its snapshots.
    const makeSurvivor = (): number => {
      const pid = Number.parseInt(
        // Two argv words make tmux execvp the script instead of passing it
        // to default-shell -c (which is `true` here).
        tmux(['new-window', '-d', '-P', '-F', '#{pane_pid}', '-t', '=base', standIn, 'stand-in']),
        10
      )
      const ready = waitFor(() => psField(pid, 'comm').endsWith('sleep'))
      if (!ready) throw new Error('stand-in never started')
      const windowId = tmux(['list-panes', '-a', '-F', '#{pane_pid} #{window_id}'])
        .split('\n')
        .find((line) => line.startsWith(`${pid} `))
        ?.split(' ')[1]
      if (!windowId) throw new Error('stand-in window not found')
      tmux(['kill-window', '-t', windowId])
      return pid
    }

    beforeAll(() => {
      dir = createTmuxTmpDir('ab-grp-')
      socket = path.join(dir, 'sock')
      standIn = path.join(dir, 'standin.sh')
      fs.writeFileSync(standIn, "#!/bin/sh\ntrap '' HUP\nexec sleep 300\n", { mode: 0o755 })
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'base', 'tail -f /dev/null'])
      // The real discarded shell would add noise (it can itself survive
      // under load); a shell that exits at once keeps the stand-in the only
      // candidate.
      tmux(['set-option', '-g', 'default-shell', Bun.which('true') ?? '/usr/bin/true'])
      serverPid = Number.parseInt(tmux(['display-message', '-p', '#{pid}']), 10)
    })

    afterAll(() => {
      const children = (listProcessesWithPs() ?? [])
        .filter((r) => r.ppid === serverPid)
        .map((r) => r.pid)
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
          tmux(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', '=base', 'tail -f /dev/null']).slice(1),
          10
        )
      const first = paneNumber()
      tmux(['new-session', '-d', '-t', '=base', '-s', 'probe-ws'])
      const next = paneNumber()
      tmux(['kill-session', '-t', '=probe-ws'])
      // One pane id went to the initial window tmux spawned and discarded.
      expect(next - first).toBe(2)
    })

    test('without reaping, a pane process that missed its hangup survives', () => {
      tmux(['new-session', '-d', '-t', '=base', '-s', 'control-ws'])
      const survivor = makeSurvivor()
      tmux(['kill-session', '-t', '=control-ws'])
      expect(isAlive(survivor)).toBe(true)
      expect(strayServerChildren()).toEqual([survivor])
      process.kill(survivor, 'SIGKILL')
      expect(waitFor(() => !isAlive(survivor))).toBe(true)
    }, 30_000)

    // macOS only: the reaper recognizes the discarded shell by the tty it
    // still holds after its pane is gone. Linux drops a process's controlling
    // tty when the pty master closes, so there the stand-in has none and the
    // reaper (correctly) leaves a tty-less process alone.
    test.skipIf(process.platform !== 'darwin')(`createGroupedSession leaves no stray pty holder (${ITERATIONS} runs)`, () => {
      const survivors: number[] = []
      for (let i = 0; i < ITERATIONS; i += 1) {
        const name = `leak-ws-${i}`
        const result = createGroupedSession(
          {
            runTmux: (args) => {
              const out = tmux(args)
              // Stand in for the discarded shell, created between the
              // before/after process snapshots like the real one.
              if (args[0] === 'new-session') survivors.push(makeSurvivor())
              return out
            },
          },
          '=base',
          name
        )
        expect(result.skipped).toBeUndefined()
        expect(result.reapedPids).toContain(survivors[i])
        tmux(['kill-session', '-t', `=${name}`])
      }
      expect(survivors).toHaveLength(ITERATIONS)
      expect(waitFor(() => survivors.every((pid) => !isAlive(pid)))).toBe(true)
      expect(strayServerChildren()).toEqual([])
    }, 60_000)
  })
}
