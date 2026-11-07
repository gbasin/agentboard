// OS adapter for observation only. All commands are bounded, asynchronous and read-only.
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { sanitizedTmuxEnv } from '../tmuxEnv'
import { timedSpawnAsync } from '../syncSpawnTiming'
import { buildTmuxFormat, splitTmuxFields, splitTmuxLines } from '../tmuxFormat'
import { parseOpenFiles, parseProcesses } from './codex'
import type { OwnershipIO } from './probe'

export function createLocalOwnershipIO(options: {
  codexHome: string; claudeHome: string; socket?: string; timeoutMs?: number
  execute?: typeof timedSpawnAsync
}): OwnershipIO {
  const cache = new Map<string, { signature: string; text: string }>()
  async function run(command: string[]): Promise<string> {
    const env = { ...sanitizedTmuxEnv(), LC_ALL: 'C', TZ: 'UTC' }
    if (options.socket) {
      delete (env as Record<string, string>).TMUX
      delete (env as Record<string, string>).TMUX_PANE
    }
    const result = await (options.execute ?? timedSpawnAsync)(command, {
      timeout: options.timeoutMs ?? 5000,
      // Claude records procStart in UTC. Locale/zone must be independent of the shell.
      env,
    })
    if (result.exitCode !== 0 || result.signalCode) throw new Error(`${command[0]} inspection failed`)
    return result.stdout
  }
  return {
    codexHome: path.resolve(options.codexHome), claudeHome: path.resolve(options.claudeHome), platform: process.platform,
    async panes() {
      const text = await run(['tmux', '-u', ...(options.socket ? ['-S', options.socket] : []),
        'list-panes', '-a', '-F', buildTmuxFormat(['#{session_name}', '#{window_id}', '#{pane_id}', '#{pane_pid}', '#{pid}'])])
      return splitTmuxLines(text).map(line => {
        const fields = splitTmuxFields(line, 5)
        if (!fields || !/^@\d+$/.test(fields[1]) || !/^%\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]) || !/^\d+$/.test(fields[4])) throw new Error('invalid tmux pane identity')
        return { window: `${fields[0]}:${fields[1]}`, pane: fields[2], pid: Number(fields[3]), serverPid: Number(fields[4]) }
      })
    },
    async processes() { return parseProcesses(await run(['ps', '-axo', 'pid=,ppid=,lstart=,comm='])) },
    async files(pids) { return parseOpenFiles(await run(['lsof', '-nP', '-p', pids.join(','), '-F0pftan'])) },
    async head(file, useCache) {
      try {
        const info = await stat(file)
        if (!info.isFile()) return null
        const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        if (useCache && cache.get(file)?.signature === signature) return cache.get(file)!.text
        const handle = await open(file, 'r')
        let text: string
        try {
          const buffer = Buffer.alloc(64 * 1024)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          text = buffer.subarray(0, bytesRead).toString()
        } finally { await handle.close() }
        if (useCache) {
          if (cache.size >= 512) cache.delete(cache.keys().next().value!)
          cache.set(file, { signature, text })
        }
        return text
      } catch { return null }
    },
  }
}
