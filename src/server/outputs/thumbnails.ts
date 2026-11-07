/** First-open screenshots: one isolated browser at a time, bounded disk cache.
 * Chrome/Chromium is optional; a missing browser never prevents opening output.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { sanitizedTmuxEnv } from '../tmuxEnv'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_ITEM_BYTES = 128 * 1024
const MAX_ENTRIES = 256

export async function captureOutput(url: string, destination: string): Promise<void> {
  const candidates = [process.env.AGENTBOARD_PREVIEW_BROWSER,
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : []),
    Bun.which('chromium'), Bun.which('chromium-browser'), Bun.which('google-chrome')]
  let executable: string | undefined
  for (const candidate of candidates) {
    if (candidate && await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) { executable = candidate; break }
  }
  if (!executable) throw new Error('Preview capture browser unavailable')
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-preview-browser-'))
  try {
    const child = Bun.spawn([executable, '--headless', '--no-first-run', '--disable-extensions',
      '--disable-background-networking', `--user-data-dir=${profile}`, '--window-size=640,400',
      '--hide-scrollbars', '--timeout=8000', '--virtual-time-budget=1000', `--screenshot=${destination}`, url],
    { env: sanitizedTmuxEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try { if (await child.exited !== 0) throw new Error('Preview capture failed') }
    finally { clearTimeout(timer) }
  } finally { await fs.rm(profile, { recursive: true, force: true }) }
}

export class OutputThumbnails {
  private running = false
  constructor(private root: string, private capture = captureOutput) {}
  private file(key: string) { return path.join(this.root, createHash('sha256').update(key).digest('hex') + '.png') }

  async read(key: string): Promise<Buffer | null> {
    try {
      const file = this.file(key)
      if ((await fs.stat(file)).size > MAX_ITEM_BYTES) return null
      return await fs.readFile(file)
    } catch { return null }
  }

  /** No scan-time captures or unbounded queue; another open can retry a busy job. */
  async ensure(key: string, url: string): Promise<void> {
    if (this.running) return
    this.running = true
    let temporary: string | undefined
    try {
      if (await this.read(key)) return
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      temporary = this.file(key) + '.tmp.png'
      await this.capture(url, temporary)
      const stat = await fs.stat(temporary)
      if (!stat.size || stat.size > MAX_ITEM_BYTES) return
      const entries = await Promise.all((await fs.readdir(this.root)).filter(name => /^[a-f0-9]{64}\.png$/.test(name)).map(async name => {
        const file = path.join(this.root, name)
        return { file, stat: await fs.stat(file) }
      }))
      entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
      let bytes = entries.reduce((sum, entry) => sum + entry.stat.size, stat.size)
      while (entries.length >= MAX_ENTRIES || bytes > MAX_BYTES) {
        const oldest = entries.shift()
        if (!oldest) break
        await fs.unlink(oldest.file); bytes -= oldest.stat.size
      }
      await fs.rename(temporary, this.file(key))
    } catch { /* Optional capture must never interrupt the terminal or preview. */ }
    finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {})
      this.running = false
    }
  }
}
