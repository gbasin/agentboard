// macOS adapter: launchd owns the binary directly; health must belong to that job.
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { command } from './release-store.mjs'

const xml = value => String(value).replace(/[<>&"']/g, c => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[c])
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`

export function renderService(base, home, release, env, label = 'com.agentboard') {
  const launcher = path.join(release.stage, 'run.sh')
  fs.writeFileSync(launcher, `#!/bin/bash\nset -e\ncd ${quote(home)}\nexec ${quote(path.join(release.root, 'bin/agentboard'))}\n`, { mode: 0o700 })
  const environment = { ...env, HOME: home, NODE_ENV: 'production',
    AGENTBOARD_STATIC_DIR: path.join(release.root, 'dist/client') }
  // Never carry a calling pane's tmux routing into the service.
  delete environment.TMUX
  delete environment.TMUX_PANE
  const entries = Object.entries(environment).map(([key, value]) =>
    `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(launcher)}</string></array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict>${entries}</dict>
<key>StandardOutPath</key><string>${xml(path.join(base, 'launchd.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(base, 'launchd.err.log'))}</string>
</dict></plist>\n`
}

export function readPlist(file, run = command) {
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]))
}

export function validateEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('service-env.json must contain environment variable names and string values')
    }
  }
  const port = Number(env.PORT || 4040)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service PORT')
  if (env.TLS_CERT || env.TLS_KEY || !['', 'localhost', '127.0.0.1', '0.0.0.0'].includes(env.HOSTNAME || '')) {
    throw new Error('Release installer currently requires HTTP on localhost, 127.0.0.1 or 0.0.0.0. Use --source for custom TLS/bind setups.')
  }
  return port
}

export class LaunchdService {
  constructor(plist, port, { label = 'com.agentboard', run = command, timeout = 60_000 } = {}) {
    this.plist = plist
    this.port = port
    this.domain = `gui/${process.getuid()}`
    this.label = label
    this.target = `${this.domain}/${label}`
    this.run = run
    this.timeout = timeout
  }
  info() {
    try { return this.run('/bin/launchctl', ['print', this.target]) } catch (error) {
      if (error.status === 113) return '' // launchctl: service not found
      throw error
    }
  }
  loaded() { return this.info() !== '' }
  assertManaged() {
    const info = this.info()
    if (!info) return
    const loadedPath = info.match(/^\s*path = (.+)$/m)?.[1]
    if (!loadedPath || !fs.existsSync(this.plist) || fs.realpathSync(loadedPath) !== fs.realpathSync(this.plist)) {
      throw new Error('The loaded job uses a different plist. Stop it explicitly before replacing it.')
    }
  }
  disabled() {
    const output = this.run('/bin/launchctl', ['print-disabled', this.domain])
    const escaped = this.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`"${escaped}"\\s*=>\\s*true`).test(output)
  }
  setDisabled(disabled) {
    if (this.disabled() === disabled) return
    this.run('/bin/launchctl', [disabled ? 'disable' : 'enable', this.target])
  }
  async wasHealthy() {
    try { await this.check(null, true, 5000); return true } catch { return false }
  }
  pid() { return Number(this.info().match(/^\s*pid = (\d+)$/m)?.[1] || 0) }
  async stop() {
    if (this.loaded()) this.run('/bin/launchctl', ['bootout', this.target])
  }
  async start() {
    this.setDisabled(false)
    this.run('/bin/launchctl', ['bootstrap', this.domain, this.plist])
  }
  listeners(port = this.port) {
    try {
      return this.run('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
        .trim().split(/\s+/).filter(Boolean).map(Number)
    } catch (error) {
      if (error.status === 1 && !error.stdout && !error.stderr) return []
      throw error
    }
  }
  async assertPortFree() {
    const deadline = Date.now() + 10_000
    do {
      if (!this.listeners().length) return
      await delay(200)
    } while (Date.now() < deadline)
    throw new Error(`Port ${this.port} is still occupied; refusing to stop an unmanaged process`)
  }
  descendant(pid, parent) {
    for (let n = 0; pid > 1 && n < 10; n++) {
      if (pid === parent) return true
      try { pid = Number(this.run('/bin/ps', ['-p', String(pid), '-o', 'ppid=']).trim()) } catch { return false }
    }
    return false
  }
  async check(release, previous = false, timeout = this.timeout) {
    const env = readPlist(this.plist, this.run).EnvironmentVariables || {}
    const port = validateEnvironment(env)
    const base = `http://${env.HOSTNAME === 'localhost' ? 'localhost' : '127.0.0.1'}:${port}`
    let healthyPid = 0
    let lastError = 'Service did not start'
    const deadline = Date.now() + timeout
    do {
      try {
        const pid = this.pid()
        const owned = this.listeners(port).some(p => previous ? this.descendant(p, pid) : p === pid)
        if (!pid || !owned) throw new Error('The launchd job does not own the listening port')
        const get = async endpoint => {
          const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(2000) })
          if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`)
          return response
        }
        if ((await (await get('/api/health')).json()).ok !== true) throw new Error('Unhealthy backend')
        const html = await (await get('/')).text()
        if (!html.includes('<html')) throw new Error('Missing frontend document')
        for (const asset of release?.assets || []) {
          await (await get(asset.startsWith('/') ? asset : `/${asset}`)).arrayBuffer()
        }
        if (pid === healthyPid) return // Two checks, separated by a second, with the same process.
        healthyPid = pid
      } catch (error) { healthyPid = 0; lastError = error.message }
      await delay(1000)
    } while (Date.now() < deadline)
    throw new Error(`Startup check failed: ${lastError}`)
  }
  async checkPrevious() { await this.check(null, true) }
}
