/**
 * Regression test for the 2026-10-04 tmux 3.7b segfault: killing the last
 * window of an external session while a browser proxy sat on agentboard's
 * grouped mirror of it ran server_destroy_session_group with an attached
 * client and took the whole tmux server down (see tmuxKillGuard.ts).
 *
 * Drives a real PtyTerminalProxy and SessionManager against a private tmux
 * server addressed by an explicit -S socket path, with TMUX removed from the
 * environment, so it can never touch a live server.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { SessionManager } from '../SessionManager'
import { PtyTerminalProxy } from '../terminal/PtyTerminalProxy'
import { TerminalState } from '../terminal/types'
import { createTmuxTmpDir, isTmuxAvailable, privateTmuxEnv } from './testEnvironment'

const BASE = 'kgbase'
const TMP_PREFIX = 'agentboard-killguard-'

// A hang must fail the file, not stall the whole suite.
setDefaultTimeout(15_000)

if (!isTmuxAvailable()) {
  test.skip('tmux not available - skipping grouped kill test', () => {})
} else {
  describe('killWindow on the last window of a grouped session', () => {
    let dir = ''
    let socket = ''
    const proxies: PtyTerminalProxy[] = []
    const plainClients: Array<ReturnType<typeof Bun.spawn>> = []

    const withSocket = (args: string[]): string[] =>
      args[0] === 'tmux' ? ['tmux', '-S', socket, ...args.slice(1)] : args

    const scrubEnv = (env: Record<string, string | undefined> | undefined) => {
      const copy = { ...(env ?? privateTmuxEnv(null)) }
      delete copy.TMUX
      return copy
    }

    const tmux = (args: string[]): string => {
      const result = Bun.spawnSync(withSocket(['tmux', ...args]), {
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

    const sessions = (): string[] =>
      tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean)

    const clientSession = (tty: string): string | undefined =>
      tmux(['list-clients', '-F', '#{client_tty} #{client_session}'])
        .split('\n')
        .map((line) => line.split(' '))
        .find(([clientTty]) => clientTty === tty)?.[1]

    const newExternalSession = (name: string, windows: number): string[] => {
      tmux(['new-session', '-d', '-s', name, 'tail -f /dev/null'])
      for (let i = 1; i < windows; i++) {
        tmux(['new-window', '-d', '-t', `=${name}:`, 'tail -f /dev/null'])
      }
      return tmux(['list-windows', '-t', `=${name}`, '-F', '#{window_id}'])
        .split('\n')
        .filter(Boolean)
    }

    const startProxy = async (connectionId: string): Promise<PtyTerminalProxy> => {
      const proxy = new PtyTerminalProxy({
        connectionId,
        sessionName: `${BASE}-ws-${connectionId}`,
        baseSession: BASE,
        onData: () => {},
        spawn: (args, options) =>
          Bun.spawn(withSocket(args), { ...options, env: scrubEnv(options?.env) }),
        spawnSync: (args, options) =>
          Bun.spawnSync(withSocket(args), { ...options, env: scrubEnv(options?.env) }),
      })
      proxies.push(proxy)
      await proxy.start()
      return proxy
    }

    // A plain tmux client attached straight to `session`, like the user's own
    // terminal on an external session.
    const attachPlainClient = async (session: string) => {
      const before = new Set(
        tmux(['list-clients', '-F', '#{client_tty}']).split('\n').filter(Boolean)
      )
      const proc = Bun.spawn(['tmux', '-S', socket, 'attach', '-t', `=${session}`], {
        env: { ...privateTmuxEnv(null), TERM: 'xterm-256color' },
        terminal: { cols: 80, rows: 24, data: () => {} },
      })
      plainClients.push(proc)
      for (let i = 0; i < 100; i++) {
        const tty = tmux(['list-clients', '-F', '#{client_tty}'])
          .split('\n')
          .find((line) => line && !before.has(line))
        if (tty) return { proc, tty }
        await Bun.sleep(20)
      }
      proc.kill()
      throw new Error(`plain client never attached to ${session}`)
    }

    // Bun's pty-backed `exited` is not a reliable detach signal; poll tmux.
    const waitForClientGone = async (tty: string): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        if (clientSession(tty) === undefined) return true
        await Bun.sleep(20)
      }
      return false
    }

    const recordingManager = () => {
      const calls: string[][] = []
      const manager = new SessionManager(BASE, {
        runTmux: (args) => {
          calls.push(args[0] === '-u' ? args.slice(1) : args)
          return tmux(args)
        },
      })
      return { manager, calls }
    }

    beforeAll(() => {
      dir = createTmuxTmpDir(TMP_PREFIX)
      socket = path.join(dir, 'tmux.sock')
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', BASE, '-x', '80', '-y', '24', 'tail -f /dev/null'])
      // new-session -t forks a throwaway login shell; keep it trivial.
      tmux(['set-option', '-g', 'default-shell', '/bin/sh'])
      tmux(['new-window', '-d', '-t', `=${BASE}:`, 'tail -f /dev/null'])
      // Never let these commands reach the user's server.
      expect(tmux(['display-message', '-p', '#{socket_path}']).trim()).toBe(socket)
    })

    afterAll(async () => {
      for (const proc of plainClients) {
        try {
          proc.kill()
          proc.terminal?.close()
        } catch {
          // Already gone
        }
      }
      for (const proxy of proxies) await proxy.dispose()
      try {
        tmux(['kill-server'])
      } catch {
        // Already gone
      }
      // Only ever remove the mkdtemp dir this file created.
      if (dir && path.basename(dir).startsWith(TMP_PREFIX) && fs.existsSync(socket)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    test('moves the mirror client home and kills the mirror before kill-window', async () => {
      const [windowId] = newExternalSession('cgl', 1)
      const connId = '11111111-1111-4111-8111-111111111111'
      const home = `${BASE}-ws-${connId}`
      const proxy = await startProxy(connId)
      const tty = proxy.getClientTty()!
      expect(await proxy.switchTo(`cgl:${windowId}`)).toBe(true)
      const mirror = clientSession(tty)!
      expect(mirror.startsWith(`${home}-x-cgl-`)).toBe(true)

      const { manager, calls } = recordingManager()
      manager.killWindow(`cgl:${windowId}`)

      const commands = calls.map((call) => call[0])
      const switchAt = calls.findIndex(
        (call) => call[0] === 'switch-client' && call.includes(tty) && call.includes(`=${home}`)
      )
      const mirrorKillAt = calls.findIndex(
        (call) => call[0] === 'kill-session' && call.includes(`=${mirror}`)
      )
      const killAt = commands.indexOf('kill-window')
      expect(switchAt).toBeGreaterThanOrEqual(0)
      expect(mirrorKillAt).toBeGreaterThan(switchAt)
      expect(killAt).toBeGreaterThan(mirrorKillAt)
      expect(commands).not.toContain('detach-client')

      // Server alive, external session and mirror gone, client back home.
      const remaining = sessions()
      expect(remaining).toContain(BASE)
      expect(remaining).not.toContain('cgl')
      expect(remaining).not.toContain(mirror)
      expect(clientSession(tty)).toBe(home)
      expect(proxy.isReady()).toBe(true)

      // The proxy keeps working: switching to a managed window succeeds.
      const managedWindow = tmux(['list-windows', '-t', `=${BASE}`, '-F', '#{window_id}'])
        .split('\n')
        .filter(Boolean)
        .at(-1)!
      expect(await proxy.switchTo(`${BASE}:${managedWindow}`)).toBe(true)
      expect(clientSession(tty)).toBe(home)
    })

    test('detaches a client attached to the target session itself', async () => {
      const [windowId] = newExternalSession('own', 1)
      const connId = '33333333-3333-4333-8333-333333333333'
      const home = `${BASE}-ws-${connId}`
      const proxy = await startProxy(connId)
      const proxyTty = proxy.getClientTty()!
      expect(await proxy.switchTo(`own:${windowId}`)).toBe(true)
      const mirror = clientSession(proxyTty)!
      const user = await attachPlainClient('own')
      expect(clientSession(user.tty)).toBe('own')

      const { manager, calls } = recordingManager()
      manager.killWindow(`own:${windowId}`)

      const detachAt = calls.findIndex(
        (call) => call[0] === 'detach-client' && call.includes(user.tty)
      )
      const mirrorKillAt = calls.findIndex(
        (call) => call[0] === 'kill-session' && call.includes(`=${mirror}`)
      )
      const killAt = calls.findIndex((call) => call[0] === 'kill-window')
      expect(detachAt).toBeGreaterThanOrEqual(0)
      expect(mirrorKillAt).toBeGreaterThanOrEqual(0)
      expect(killAt).toBeGreaterThan(Math.max(detachAt, mirrorKillAt))

      expect(await waitForClientGone(user.tty)).toBe(true)
      expect(clientSession(proxyTty)).toBe(home)
      expect(sessions()).not.toContain('own')
      expect(sessions()).toContain(BASE)
      expect(proxy.isReady()).toBe(true)
    })

    test('guards a grouped session even after its other members are gone', async () => {
      const [windowId] = newExternalSession('shrunk', 1)
      tmux(['new-session', '-d', '-t', '=shrunk', '-s', 'shrunk-pair'])
      tmux(['kill-session', '-t', '=shrunk-pair'])
      const user = await attachPlainClient('shrunk')

      const { manager, calls } = recordingManager()
      manager.killWindow(`shrunk:${windowId}`)

      const detachAt = calls.findIndex(
        (call) => call[0] === 'detach-client' && call.includes(user.tty)
      )
      expect(detachAt).toBeGreaterThanOrEqual(0)
      expect(calls.findIndex((call) => call[0] === 'kill-window')).toBeGreaterThan(detachAt)
      expect(await waitForClientGone(user.tty)).toBe(true)
      expect(sessions()).not.toContain('shrunk')
      expect(sessions()).toContain(BASE)
    })

    test('non-last window keeps the fast path', async () => {
      const [first, second] = newExternalSession('multi', 2)
      const proxy = await startProxy('22222222-2222-4222-8222-222222222222')
      const tty = proxy.getClientTty()!
      expect(await proxy.switchTo(`multi:${first}`)).toBe(true)
      const mirror = clientSession(tty)!

      const { manager, calls } = recordingManager()
      manager.killWindow(`multi:${second}`)

      expect(calls.map((call) => call[0])).toEqual(['display-message', 'kill-window'])
      expect(clientSession(tty)).toBe(mirror)
      expect(sessions()).toContain('multi')
      expect(proxy.isReady()).toBe(true)
    })

    test('ungrouped external session keeps the fast path', () => {
      const [windowId] = newExternalSession('solo', 1)

      const { manager, calls } = recordingManager()
      manager.killWindow(`solo:${windowId}`)

      expect(calls.map((call) => call[0])).toEqual(['display-message', 'kill-window'])
      expect(sessions()).not.toContain('solo')
      expect(sessions()).toContain(BASE)
      for (const proxy of proxies) {
        expect((proxy as unknown as { state: TerminalState }).state).not.toBe(TerminalState.DEAD)
      }
    })
  })
}
