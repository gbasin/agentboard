import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PreviewCertificates, validateCertificate } from '../outputs/certificates'
import { previewCertificate } from './fixtures/previewCertificate'
import type { timedSpawnAsync } from '../syncSpawnTiming'

test('local identity gates issuance; concurrent opens share export, cache and renewal; failed exports are removed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-cert-test-'))
  try {
    const hostname = 'preview.fixture.ts.net'
    const files = previewCertificate(root, 'first', hostname)
    let now = Date.now(), requests = 0, fail = false, exported = ''
    const run: typeof timedSpawnAsync = async command => {
      requests++
      if (command[1] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: hostname + '.' } }), stderr: '', exitCode: 0, signalCode: null }
      const cert = command.find(s => s.startsWith('--cert-file='))!.slice(12)
      const key = command.find(s => s.startsWith('--key-file='))!.slice(11)
      exported = path.dirname(cert)
      expect((await fs.stat(exported)).mode & 0o777).toBe(0o700)
      expect(command).toContain('--min-validity=24h')
      await fs.copyFile(files.cert, cert); await fs.copyFile(files.key, key)
      return { stdout: '', stderr: 'never disclose credentials', exitCode: fail ? 1 : 0, signalCode: null }
    }
    const provider = new PreviewCertificates(undefined, run, () => now)
    const values = await Promise.all([provider.get(hostname), provider.get(hostname), provider.get(hostname)])
    expect(requests).toBe(2)
    expect(new Set(values.map(v => v.fingerprint)).size).toBe(1)
    expect(await fs.stat(exported).then(() => true, () => false)).toBe(false)
    await provider.get(hostname); expect(requests).toBe(2)
    now += 60 * 60_000 + 1
    await provider.get(hostname); expect(requests).toBe(4)
    await expect(provider.get('other.fixture.ts.net')).rejects.toThrow('not this machine')
    expect(requests).toBe(5)
    now += 60 * 60_000; fail = true
    await expect(provider.get(hostname)).rejects.toThrow('HTTPS previews need a certificate')
    expect(await fs.stat(exported).then(() => true, () => false)).toBe(false)
    const failedCount = requests
    await expect(provider.get(hostname)).rejects.toThrow('HTTPS previews')
    expect(requests).toBe(failedCount)
    now += 10_001; fail = false
    await provider.get(hostname)
    const cert = await fs.readFile(files.cert, 'utf8'), key = await fs.readFile(files.key, 'utf8')
    expect(() => validateCertificate(cert, key, 'wrong.example')).toThrow('does not match')
    expect(() => validateCertificate(cert, key, hostname, now + 3 * 86400_000)).toThrow('expired')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('unsupported hosts never invoke Tailscale; explicit certificates reload after rotation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-cert-files-'))
  try {
    const disabled = new PreviewCertificates(undefined, async () => { throw Error('must not run') })
    await expect(disabled.get('attacker.example')).rejects.toThrow('HTTPS previews')
    const first = previewCertificate(root, 'first'), second = previewCertificate(root, 'second')
    let now = Date.now()
    const provider = new PreviewCertificates(first, undefined, () => now)
    const before = await provider.get('localhost')
    await fs.copyFile(second.cert, first.cert); await fs.copyFile(second.key, first.key)
    now += 60 * 60_000 + 1
    expect((await provider.get('localhost')).fingerprint).not.toBe(before.fingerprint)
    now += 60 * 60_000 + 1
    const concurrent = await Promise.allSettled([provider.get('wrong.example'), provider.get('localhost')])
    expect(concurrent[0].status).toBe('rejected')
    expect(concurrent[1].status).toBe('fulfilled')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
