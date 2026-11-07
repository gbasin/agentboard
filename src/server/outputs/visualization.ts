/** Adapt Codex's visualize marker to its standalone renderer, without host APIs. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { sanitizedTmuxEnv } from '../tmuxEnv'

export class VisualizationError extends Error {}

function escapedHtml(source: string): string {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

async function findRenderer(): Promise<string | null> {
  if (process.env.AGENTBOARD_VISUALIZE_RENDERER) return process.env.AGENTBOARD_VISUALIZE_RENDERER
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins/cache/openai-bundled/visualize')
  try {
    const versions = (await fs.readdir(root)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const renderer = path.join(root, version, 'skills/visualize/scripts/render.py')
      if ((await fs.stat(renderer).catch(() => null))?.isFile()) return renderer
    }
  } catch { /* Optional local Codex integration. */ }
  return null
}

export async function visualizationFile(source: string, cacheRoot: string): Promise<string> {
  const info = await fs.stat(source)
  if (!info.isFile() || info.size > 1_000_000) throw new VisualizationError('Visualization must be an HTML fragment smaller than 1 MB.')
  const fragment = await fs.readFile(source, 'utf8')
  if (/<!doctype\s|<html[\s>]/i.test(fragment)) return source
  const escaped = escapedHtml(fragment)
  // An agent may already have exported this exact fragment. Check its contents,
  // not a guessed filename, so an unrelated or stale preview is never selected.
  const siblings = await fs.readdir(path.dirname(source))
  for (const name of siblings.filter(name => /\.html?$/i.test(name)).slice(0, 32)) {
    const candidate = path.join(path.dirname(source), name)
    if (candidate === source) continue
    const stat = await fs.lstat(candidate).catch(() => null)
    if (!stat?.isFile() || stat.size > 4_000_000) continue
    const document = await fs.readFile(candidate, 'utf8')
    if (document.includes('data-visualize-standalone') && document.includes(escaped)) return candidate
  }
  const renderer = await findRenderer()
  if (!renderer) throw new VisualizationError('This visualization needs the Codex standalone renderer. Export it to HTML in Codex, or set AGENTBOARD_VISUALIZE_RENDERER to the visualize skill’s render.py.')
  const hash = createHash('sha256').update(source).update(fragment).update(renderer).digest('hex')
  const directory = path.join(cacheRoot, 'visualizations', hash)
  const destination = path.join(directory, 'index.html')
  if ((await fs.stat(destination).catch(() => null))?.isFile()) return destination
  await fs.mkdir(directory, { recursive: true })
  // Use an independent temporary output per concurrent request, then rename.
  const temporary = path.join(directory, `${crypto.randomUUID()}.html`)
  const child = Bun.spawn(['python3', renderer, source, temporary], { env: sanitizedTmuxEnv(), stdout: 'ignore', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    if (await child.exited !== 0) throw new VisualizationError('Codex could not export this visualization. Ask it to export a standalone HTML page, then open that output.')
    await fs.rename(temporary, destination)
    return destination
  } finally {
    clearTimeout(timer)
    await fs.rm(temporary, { force: true })
  }
}
