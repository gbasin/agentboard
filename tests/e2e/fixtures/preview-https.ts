/** Real TLS reverse proxy with no forwarded-proto header. Only tailscaled's
 * identity/certificate export is substituted; preview TLS is production code.
 */
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { previewCertificate } from '../../../src/server/__tests__/fixtures/previewCertificate'

const root = process.env.E2E_TMUX_TMPDIR
if (!root || process.env.TMUX || !process.env.E2E_TMUX_SESSION) throw Error('Private E2E environment required')
const port = Number(process.env.E2E_HTTPS_PORT), backend = Number(process.env.E2E_HTTPS_BACKEND_PORT)
const files = previewCertificate(root, 'https', 'preview.fixture.ts.net')
const bin = path.join(root, 'https-bin'); fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'tailscale'), `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]==='ip') console.log('::1');
else if(args[0]==='status') console.log(JSON.stringify({Self:{DNSName:'preview.fixture.ts.net.'}}));
else if(args[0]==='cert') {
 const fs=await import('node:fs');
 for(const [flag,file] of [['--cert-file=',${JSON.stringify(files.cert)}],['--key-file=',${JSON.stringify(files.key)}]]) fs.copyFileSync(file,args.find(a=>a.startsWith(flag)).slice(flag.length));
 fs.appendFileSync(${JSON.stringify(path.join(root, 'cert-exports'))},'export\\n');
} else process.exit(1);
`, { mode: 0o755 })
const sockets = new Set<net.Socket>()
const proxy = tls.createServer({ cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) }, client => {
  const upstream = net.connect({ host: '127.0.0.1', port: backend })
  for (const socket of [client, upstream]) {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { client.destroy(); upstream.destroy() })
  }
  client.pipe(upstream).pipe(client)
})
const child = Bun.spawn(['bun', 'src/server/index.ts'], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOSTNAME: '127.0.0.1', PORT: String(backend),
    TLS_CERT: '', TLS_KEY: '',
    PREVIEW_TLS_CERT: process.env.E2E_PREVIEW_AUTO_TLS === '1' ? '' : files.cert,
    PREVIEW_TLS_KEY: process.env.E2E_PREVIEW_AUTO_TLS === '1' ? '' : files.key,
    TMUX_SESSION: process.env.E2E_TMUX_SESSION, AGENTBOARD_STATIC_DIR: 'dist/client', AGENTBOARD_LOG_WATCH_MODE: 'poll',
    AGENTBOARD_TERMINAL_RELAY: '1', LANG: 'C', LC_ALL: 'C' }, stdout: 'inherit', stderr: 'inherit',
})
for (let i = 0; i < 300; i++) {
  if (await fetch(`http://127.0.0.1:${backend}/api/health`).then(r => r.ok, () => false)) break
  await Bun.sleep(100)
}
proxy.listen(port, '127.0.0.1')
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
const code = await child.exited
for (const socket of sockets) socket.destroy()
proxy.close()
process.exit(code)
