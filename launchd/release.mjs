#!/usr/bin/env node
// Explicit install/upgrade entry point. The installed service never runs this file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { command, prepareRelease, atomicWrite } from './release-store.mjs'
import { activate, restore, lock } from './release-transaction.mjs'
import { LaunchdService, readPlist, renderService, validateEnvironment } from './release-service.mjs'

async function main() {
  const [action, requested = 'latest', ...extra] = process.argv.slice(2)
  if (!['install', 'upgrade'].includes(action) || extra.length) {
    throw new Error('Usage: install.sh --release [VERSION | --recover] or upgrade.sh [VERSION | --recover]')
  }
  if (process.platform !== 'darwin') throw new Error('This installer is for macOS; see systemd/ for Linux')
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required for installation')
  const home = os.homedir()
  const base = path.join(home, '.agentboard')
  const plist = path.join(home, 'Library/LaunchAgents/com.agentboard.plist')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const unlock = lock(base)
  try {
    // Recovery never contacts npm. Preserve the journal on a failed recovery.
    const service = new LaunchdService(plist, 4040)
    if (requested === '--recover') {
      console.log(await restore(base, service) ? 'Previous service restored.' : 'No interrupted upgrade to recover.')
      return
    }
    if (fs.existsSync(path.join(base, 'release-pending.json'))) {
      throw new Error('An earlier upgrade was interrupted. Run install.sh --release --recover first.')
    }
    const existing = fs.existsSync(plist) ? readPlist(plist) : null
    if (action === 'upgrade' && !existing) throw new Error('No installation found; run install.sh first')
    const config = path.join(base, 'service-env.json')
    const overrides = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {}
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('service-env.json must be an object')
    const env = {
      PATH: `${path.dirname(process.execPath)}:${home}/.bun/bin:${home}/.local/bin:${home}/bin:${home}/.cargo/bin:${home}/go/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8',
      ...existing?.EnvironmentVariables, ...overrides,
    }
    service.port = validateEnvironment(env)
    // tmux remains a runtime dependency of the compiled release.
    command('/bin/bash', ['-c', 'command -v tmux'], { env: { ...process.env, PATH: env.PATH } })
    console.log(`Preparing ${requested}; the current service remains running during download.`)
    const release = prepareRelease(base, requested)
    const candidate = renderService(base, home, release, env)
    const candidatePath = path.join(release.stage, 'service.plist')
    atomicWrite(candidatePath, candidate)
    command('/usr/bin/plutil', ['-lint', candidatePath])
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    console.log(`Starting ${release.version}; failed startup will restore the previous service configuration.`)
    await activate(base, service, candidate, release)
    console.log(`Agentboard ${release.version} is healthy. Restarts now use the installed binary without npm.`)
    // Keep the existing rotation job or install it for a new release installation.
    try {
      command('/bin/bash', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-logrotate.sh')])
    } catch (error) {
      throw new Error(`The new release is running, but log rotation setup failed: ${error.message}`)
    }
  } finally { unlock() }
}

main().catch(error => {
  console.error(error.message)
  if (error.stderr) console.error(String(error.stderr).trim())
  process.exitCode = 1
})
