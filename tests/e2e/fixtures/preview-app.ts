/** Real loopback app for output proxy regressions: root assets, POST, cookies, WS. */
const html = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
<h1>Live preview fixture</h1><button id="save">Save setting</button><p id="api">Not saved</p><p id="socket">Connecting</p>
<script src="/app.js"></script></body></html>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  async fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/socket') {
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/app.css') return new Response('h1 { color: rgb(12, 100, 40) }', { headers: { 'Content-Type': 'text/css' } })
    if (url.pathname === '/app.js') return new Response(`
      document.querySelector('#save').onclick = async () => {
        const response = await fetch('/api/settings', {method:'POST', body:'Saved remotely'});
        document.querySelector('#api').textContent = await response.text();
      };
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/socket');
      socket.onopen = () => socket.send('WebSocket connected');
      socket.onmessage = e => document.querySelector('#socket').textContent = e.data;
    `, { headers: { 'Content-Type': 'text/javascript' } })
    if (url.pathname === '/api/settings') return new Response(await req.text())
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  },
  websocket: { message(ws, message) { ws.send(message) } },
})
console.log(String(server.port))
