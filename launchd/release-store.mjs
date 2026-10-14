// Prepare an exact platform package without touching the running service.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function command(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  })
}

export function atomicWrite(file, contents, mode = 0o600) {
  const temp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temp, 'w', mode)
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
  const directory = fs.openSync(path.dirname(file), 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

export function validatePackage(root, name, version) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (metadata.name !== name || metadata.version !== version) {
    throw new Error('Downloaded package identity does not match the requested release')
  }
  fs.accessSync(path.join(root, 'bin/agentboard'), fs.constants.X_OK)
  const client = path.join(root, 'dist/client')
  const html = fs.readFileSync(path.join(client, 'index.html'), 'utf8')
  const assets = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(m => m[1])
  if (!assets.some(a => a.endsWith('.js')) || !assets.some(a => a.endsWith('.css'))) {
    throw new Error('Release is missing its frontend entry points')
  }
  for (const asset of assets) {
    const local = path.resolve(client, asset.replace(/^\//, ''))
    if (!local.startsWith(`${client}${path.sep}`)) throw new Error('Invalid frontend asset path')
    fs.accessSync(local, fs.constants.R_OK)
  }
  return assets
}

export function prepareRelease(base, requested = 'latest', run = command, arch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`)
  if (requested !== 'latest' && !/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(requested)) {
    throw new Error('Use latest or an exact release version, such as 0.31.0')
  }
  const metadata = run('npm', [
    'view', `@gbasin/agentboard@${requested.replace(/^v/, '')}`, 'version', '--json',
  ])
  let version
  try { version = JSON.parse(metadata) } catch { throw new Error(`npm did not return a published version for ${requested}`) }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('npm did not resolve a single exact release version')
  }
  const name = `@gbasin/agentboard-darwin-${arch}`
  const releases = path.join(base, 'releases')
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 })
  // Always use a new directory. Never mutate a tree referenced by launchd.
  const stage = fs.mkdtempSync(path.join(releases, `${version}-`))
  try {
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ private: true }))
    run('npm', ['install', '--prefix', stage, '--global=false', '--ignore-scripts',
      '--no-audit', '--no-fund', '--save-exact', `${name}@${version}`], { cwd: stage })
    // A REQUIRED platform dependency fails installation when publication is incomplete.
    // Do not use the meta-package's best-effort optionalDependencies here.
    const root = path.join(stage, 'node_modules', name)
    const assets = validatePackage(root, name, version)
    return { stage, root, version, assets }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
}
