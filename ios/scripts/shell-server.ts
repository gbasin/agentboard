/** Isolated, loopback-only PTY fixture. Never attaches to tmux or a live agent. */

const shells = new Map<object, Bun.Subprocess>()
const env = { ...process.env, TERM: 'xterm-256color', PS1: 'spike % ' }
delete env.TMUX
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 4149,
  fetch(request, server) {
    if (server.upgrade(request)) return
    return new Response('Agentboard isolated shell fixture\n')
  },
  websocket: {
    open(socket) {
      const decoder = new TextDecoder()
      const shell = Bun.spawn(['/bin/zsh', '-f'], { cwd: '/tmp', env, terminal: {
        cols: 48, rows: 30, data(_terminal, data) { socket.send(decoder.decode(data, {stream: true})) },
      } })
      shells.set(socket, shell)
      socket.send('\x1b[34mAgentboard · isolated development shell\x1b[0m\r\n')
      void shell.exited.then(() => { shell.terminal?.close(); socket.close() })
    },
    message(socket, payload) {
      const shell = shells.get(socket)
      if (!shell) return
      try {
        const message = JSON.parse(String(payload))
        if (message.type === 'input' && typeof message.data === 'string') shell.terminal?.write(message.data)
        if (message.type === 'paste' && typeof message.data === 'string') {
          shell.terminal?.write('\x1b[200~' + message.data + '\x1b[201~')
        }
        if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          shell.terminal?.resize(Math.max(2, Math.min(500, message.cols)), Math.max(2, Math.min(300, message.rows)))
        }
      } catch (error) { console.error(error); socket.close(1003, 'Invalid fixture message') }
    },
    close(socket) { shells.get(socket)?.kill(); shells.delete(socket) },
  },
})
console.log(`Isolated shell fixture: ws://127.0.0.1:${server.port}`)
function stop() { for (const shell of shells.values()) shell.kill(); server.stop(true); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
