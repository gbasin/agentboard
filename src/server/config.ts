import path from 'node:path'

const homeDir = process.env.HOME || process.env.USERPROFILE || ''

export const config = {
  port: Number(process.env.PORT) || 4040,
  tmuxSession: process.env.TMUX_SESSION || 'agentboard',
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 5000,
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS) || 300000,
  discoverPrefixes: (process.env.DISCOVER_PREFIXES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  claudeProjectsDir:
    process.env.CLAUDE_PROJECTS_DIR ||
    path.join(homeDir, '.claude', 'projects'),
}
