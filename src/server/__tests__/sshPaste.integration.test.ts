/** Real tmux recipient coverage through a local command transport, not SSH. */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshTerminalProxy } from '../terminal/SshTerminalProxy'
import { shellQuote } from '../shellQuote'
import { privateTmuxEnv, isTmuxAvailable } from './testEnvironment'

const available = isTmuxAvailable()

for (const removeRecipient of [false, true]) {
  test.skipIf(!available)(`SSH paste pins the selected split pane${removeRecipient ? ' and fails closed if it disappears' : ' across a later session switch'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-ssh-paste-'))
    const socket = join(dir, 'tmux.sock')
    const env = { ...privateTmuxEnv(dir), TERM: 'xterm-256color', AGENTBOARD_DATA_DIR: join(dir, 'data') }
    const tmux = (...args: string[]) => {
      const result = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    let releaseUpload!: () => void
    let uploadStarted!: () => void
    const uploading = new Promise<void>(resolve => { uploadStarted = resolve })
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    const commands: string[] = []
    const proxy = new SshTerminalProxy({
      connectionId: 'integration', sessionName: 'bootstrap', baseSession: '', host: 'local-transport',
      onData: () => {},
      spawn: (args, options) => {
        const command = args.at(-1)!.replace(/^tmux /, `tmux -S ${shellQuote(socket)} `)
        commands.push(command)
        const child = Bun.spawn(['sh', '-c', command], { ...options, env })
        if (command.includes('load-buffer')) {
          uploadStarted()
          // The buffer is uploaded, but hold delivery until the client switches.
          return new Proxy(child, { get(target, key) {
            if (key === 'exited') return Promise.all([target.exited, uploadGate]).then(([code]) => code)
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
        return child
      },
    })
    try {
      tmux('new-session', '-d', '-s', 'recipient', '-x', '100', '-y', '30', 'cat')
      const pane = tmux('split-window', '-d', '-t', 'recipient', '-P', '-F', '#{pane_id}', 'cat')
      tmux('select-pane', '-t', pane)
      tmux('new-session', '-d', '-s', 'later', 'cat')
      await proxy.start()
      await proxy.switchTo('recipient:0')
      const token = 'PINNED_PASTE_RECIPIENT'
      proxy.paste(token)
      await uploading
      await proxy.switchTo('later:0')
      if (removeRecipient) tmux('kill-pane', '-t', pane)
      releaseUpload()
      const deadline = Date.now() + 3000
      while (!commands.some(command => command.includes(removeRecipient ? 'delete-buffer' : 'paste-buffer'))) {
        if (Date.now() > deadline) throw new Error('Paste delivery did not finish')
        await Bun.sleep(10)
      }
      if (!removeRecipient) {
        while (!tmux('capture-pane', '-p', '-t', pane).includes(token)) {
          if (Date.now() > deadline) throw new Error('Paste did not reach selected split pane')
          await Bun.sleep(10)
        }
      }
      expect(tmux('capture-pane', '-p', '-t', 'bootstrap:0')).not.toContain(token)
      expect(tmux('capture-pane', '-p', '-t', 'later:0')).not.toContain(token)
      expect(commands.find(command => command.includes('paste-buffer'))).toContain(shellQuote(pane))
    } finally {
      releaseUpload()
      await proxy.dispose()
      for (const session of ['recipient', 'later']) {
        Bun.spawnSync(['tmux', '-S', socket, 'kill-session', '-t', session], { env, stdout: 'ignore', stderr: 'ignore' })
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
}

test.skipIf(!available)('host A to B to A keeps newer bootstrap alive after old startup cleanup', async () => {
  const { sshTerminalSessionName } = await import('../terminal/startOwnedTerminal')
  const dir = mkdtempSync(join(tmpdir(), 'ab-ssh-owner-'))
  const env = { ...privateTmuxEnv(dir), TERM: 'xterm-256color', AGENTBOARD_DATA_DIR: join(dir, 'data') }
  const sockets = { A: join(dir, 'a.sock'), B: join(dir, 'b.sock') }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let oldCreated!: () => void
  const created = new Promise<void>(resolve => { oldCreated = resolve })
  const make = (host: 'A' | 'B', sequence: number) => new SshTerminalProxy({
    connectionId: 'same-connection', sessionName: sshTerminalSessionName('board', 'same-connection', sequence), baseSession: '', host, onData: () => {},
    spawn: (args, options) => {
      const command = args.at(-1)!.replace(/^tmux /, `tmux -f /dev/null -S ${shellQuote(sockets[host])} `)
      const child = Bun.spawn(['sh', '-c', command], { ...options, env })
      if (sequence === 1 && !args.includes('-tt') && command.includes('new-session')) {
        return new Proxy(child, { get(target, key) {
          if (key === 'exited') return target.exited.then(async code => { oldCreated(); await gate; return code })
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      return child
    },
  })
  const oldA = make('A', 1), hostB = make('B', 2), newA = make('A', 3)
  const oldStart = oldA.start()
  try {
    await created
    // Keep host A's server alive while its first proxy is replaced.
    Bun.spawnSync(['tmux', '-S', sockets.A, 'new-session', '-d', '-s', 'sentinel'], { env, stdout: 'ignore', stderr: 'ignore' })
    await oldA.dispose()
    await hostB.start()
    await hostB.dispose()
    await newA.start()
    release()
    await oldStart
    expect(newA.isReady()).toBe(true)
    const alive = Bun.spawnSync(['tmux', '-S', sockets.A, 'has-session', '-t', newA.getSessionName()], { env, stdout: 'ignore', stderr: 'ignore' })
    expect(alive.exitCode).toBe(0)
    const gone = Bun.spawnSync(['tmux', '-S', sockets.A, 'has-session', '-t', oldA.getSessionName()], { env, stdout: 'ignore', stderr: 'ignore' })
    expect(gone.exitCode).not.toBe(0)
  } finally {
    release()
    await oldStart.catch(() => {})
    await Promise.all([oldA.dispose(), hostB.dispose(), newA.dispose()])
    Bun.spawnSync(['tmux', '-S', sockets.A, 'kill-session', '-t', 'sentinel'], { env, stdout: 'ignore', stderr: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)
