import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PipePaneTerminalProxy } from '../terminal/PipePaneTerminalProxy'
import { createTmuxTmpDir, privateTmuxEnv, privateTmuxSocket } from './testEnvironment'

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for terminal output')
    await Bun.sleep(20)
  }
}

// Production pipe proxy + real tmux + WebSockets, without starting the user's
// server. Every process receives an explicit private socket and scrubbed env.
test.skipIf(Bun.spawnSync(['tmux', '-V'], { env: privateTmuxEnv(null), stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0)('two WebSocket viewers share a pipe and remain interactive across close/switch/reconnect', async () => {
  const root = createTmuxTmpDir('ab-shared-pipe-')
  const env = privateTmuxEnv(root)
  const socket = privateTmuxSocket(root)
  await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
  const session = 'shared-pipe-test'
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const commands: string[][] = []
  const proxies = new Set<PipePaneTerminalProxy>()
  const clients: WebSocket[] = []
  const disposed: Promise<void>[] = []
  let nextId = 0
  const server = Bun.serve<{ proxy: PipePaneTerminalProxy | null }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) { return server.upgrade(req, { data: { proxy: null } }) ? undefined : new Response('upgrade', { status: 400 }) },
    websocket: {
      open(ws) {
        const id = `shared-real-${++nextId}`
        const proxy = new PipePaneTerminalProxy({
          connectionId: id, sessionName: id, baseSession: session, monitorTargets: false,
          onData: (data) => ws.send(data),
          spawn: (args, options) => Bun.spawn(args, { ...options, env }),
          spawnSync: (args, options) => {
            commands.push(args)
            return Bun.spawnSync([args[0], '-S', socket, ...args.slice(1)], { ...options, env })
          },
        })
        ws.data.proxy = proxy
        proxies.add(proxy)
        void proxy.switchTo(`${session}:0`).then(() => ws.send('ATTACHED'))
      },
      message(ws, data) {
        const message = JSON.parse(data.toString())
        const proxy = ws.data.proxy!
        if (message.input) proxy.write(message.input)
        if (message.resize) proxy.resize(...message.resize as [number, number])
        if (message.target) void proxy.switchTo(message.target).then(() => ws.send('SWITCHED'))
      },
      close(ws) { if (ws.data.proxy) disposed.push(ws.data.proxy.dispose()) },
    },
  })
  const connect = async () => {
    const messages: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    clients.push(ws)
    ws.onmessage = (event) => messages.push(event.data.toString())
    await until(() => messages.includes('ATTACHED'))
    return { ws, messages, send: (message: unknown) => ws.send(JSON.stringify(message)) }
  }
  try {
    tmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', 'sh'])
    tmux(['new-window', '-d', '-t', session, 'sh'])
    const pane = tmux(['display-message', '-t', `${session}:0`, '-p', '#{pane_id}'])
    const a = await connect()
    const b = await connect()
    a.send({ input: "printf 'shared-output-one\\n'\n", resize: [93, 31] })
    await until(() => [a, b].every((client) => client.messages.join('').includes('shared-output-one')))
    expect(commands).toContainEqual(['tmux', 'resize-pane', '-t', `${session}:0`, '-x', '93', '-y', '31'])
    a.ws.close()
    await until(() => disposed.length === 1)
    await Promise.all(disposed)
    b.send({ input: "printf 'after-first-close\\n'\n" })
    await until(() => b.messages.join('').includes('after-first-close'))
    const c = await connect()
    c.send({ target: `${session}:1` })
    await until(() => c.messages.includes('SWITCHED'))
    b.send({ input: "printf 'after-other-switch\\n'\n" })
    c.send({ input: "printf 'different-pane-output\\n'\n" })
    await until(() => b.messages.join('').includes('after-other-switch') && c.messages.join('').includes('different-pane-output'))
    b.ws.close(); c.ws.close()
    await until(() => disposed.length === 3)
    await Promise.all(disposed)
    expect(tmux(['display-message', '-t', pane, '-p', '#{pane_pipe}'])).toBe('0')
    expect(tmux(['display-message', '-t', `${session}:1`, '-p', '#{pane_pipe}'])).toBe('0')
    // Reuse the exact socket and pane ID after a server restart. Disposing
    // the old owner must not detach the replacement server's new pipe.
    const old = await connect()
    tmux(['kill-session', '-t', session])
    tmux(['new-session', '-d', '-s', session, 'sh'])
    const replacement = await connect()
    old.ws.close()
    await until(() => disposed.length === 4)
    await Promise.all(disposed)
    expect(tmux(['display-message', '-t', `${session}:0`, '-p', '#{pane_pipe}'])).toBe('1')
    replacement.send({ input: "printf 'replacement-server-output\\n'\n" })
    await until(() => replacement.messages.join('').includes('replacement-server-output'))
    replacement.ws.close()
    await until(() => disposed.length === 5)
    await Promise.all(disposed)
    expect(tmux(['display-message', '-t', `${session}:0`, '-p', '#{pane_pipe}'])).toBe('0')
  } finally {
    for (const client of clients) client.close()
    await Promise.all([...proxies].map((proxy) => proxy.dispose()))
    server.stop(true)
    // Only this test's named session; never kill a server or unrelated session.
    try { tmux(['kill-session', '-t', session]) } catch { /* Creation may have failed. */ }
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)
