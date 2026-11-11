/** Ephemeral, untrusted certificates for transport tests; never use in production. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function previewCertificate(root: string, name: string, hostname = 'localhost') {
  fs.mkdirSync(root, { recursive: true })
  const cert = path.join(root, name + '.crt'), key = path.join(root, name + '.key')
  const config = path.join(root, name + '.cnf')
  fs.writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${hostname}\n[ext]\nsubjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1,IP:::1\n`)
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config, '-keyout', key, '-out', cert], { env, encoding: 'utf8' })
  if (result.status !== 0) throw Error('Test certificate generation failed: ' + result.stderr)
  return { cert, key }
}
