/** Preview-only TLS, independent of the dashboard's reverse proxy.
 * Tailscaled owns issuance/cache; private temporary exports are removed after
 * reading. One bounded refresh is shared by concurrent opens and listeners.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { timedSpawnAsync } from '../syncSpawnTiming'

export interface PreviewCertificate { cert: string; key: string; fingerprint: string; expires: number }
export class PreviewTlsError extends Error {}
const SETUP = 'HTTPS previews need a certificate. Enable Tailscale HTTPS for this machine, or configure PREVIEW_TLS_CERT and PREVIEW_TLS_KEY, then retry.'
const HOUR = 60 * 60_000
const PATHS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

export function validateCertificate(cert: string, key: string, hostname: string, now = Date.now()): PreviewCertificate {
  const x509 = new X509Certificate(cert)
  const expires = Date.parse(x509.validTo)
  const host = hostname.replace(/^\[|\]$/g, '')
  const matches = isIP(host) ? x509.checkIP(host) : x509.checkHost(host)
  if (!matches ||
      Date.parse(x509.validFrom) > now || expires <= now + 60_000 || !x509.checkPrivateKey(createPrivateKey(key))) {
    throw new PreviewTlsError('The preview TLS certificate is expired, does not match this hostname, or has the wrong key. Update the preview certificate and retry.')
  }
  return { cert, key, fingerprint: x509.fingerprint256, expires }
}

export class PreviewCertificates {
  private cached?: { hostname: string; value: PreviewCertificate; refreshAt: number }
  private pending?: { hostname: string; promise: Promise<PreviewCertificate> }
  private retry?: { hostname: string; at: number }
  constructor(private files?: { cert: string; key: string }, private run = timedSpawnAsync, private now = Date.now) {}

  async get(hostname: string): Promise<PreviewCertificate> {
    if (this.cached?.hostname === hostname && this.cached.refreshAt > this.now() && this.cached.value.expires > this.now()) return this.cached.value
    if (this.pending) {
      if (this.pending.hostname === hostname) return this.pending.promise
      await this.pending.promise.catch(() => {})
      return this.get(hostname)
    }
    if (this.retry?.hostname === hostname && this.retry.at > this.now()) throw new PreviewTlsError(SETUP)
    const promise = this.load(hostname).then(value => {
      this.cached = { hostname, value, refreshAt: Math.min(this.now() + HOUR, value.expires - 60_000) }
      return value
    }).catch(error => {
      this.retry = { hostname, at: this.now() + 10_000 }
      throw error instanceof PreviewTlsError ? error : new PreviewTlsError(SETUP)
    }).finally(() => { this.pending = undefined })
    this.pending = { hostname, promise }
    return promise
  }

  private async load(hostname: string): Promise<PreviewCertificate> {
    if (this.files) {
      const [cert, key] = await Promise.all([fs.readFile(this.files.cert, 'utf8'), fs.readFile(this.files.key, 'utf8')])
      return validateCertificate(cert, key, hostname, this.now())
    }
    // Never turn a request Host into permission to issue an arbitrary cert.
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(hostname)) throw new PreviewTlsError(SETUP)
    for (const cli of PATHS) {
      let status
      try { status = await this.run([cli, 'status', '--json'], { timeout: 5000 }) }
      catch { continue }
      if (status.signalCode) break
      if (status.exitCode !== 0) continue
      const local = JSON.parse(status.stdout).Self?.DNSName?.replace(/\.$/, '')
      if (local !== hostname) throw new PreviewTlsError('This preview hostname is not this machine’s Tailscale name. Open the board using its Tailscale hostname or configure a preview certificate.')
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-preview-cert-'))
      try {
        await fs.chmod(root, 0o700)
        const certFile = path.join(root, 'cert.pem'), keyFile = path.join(root, 'key.pem')
        const result = await this.run([cli, 'cert', '--min-validity=24h', `--cert-file=${certFile}`, `--key-file=${keyFile}`, hostname], { timeout: 20_000 })
        if (result.exitCode !== 0) throw new PreviewTlsError(SETUP)
        const [cert, key] = await Promise.all([fs.readFile(certFile, 'utf8'), fs.readFile(keyFile, 'utf8')])
        return validateCertificate(cert, key, hostname, this.now())
      } finally { await fs.rm(root, { recursive: true, force: true }) }
    }
    throw new PreviewTlsError(SETUP)
  }
}
