import path from 'node:path'

const terminalModeRaw = process.env.TERMINAL_MODE
const terminalMode =
  terminalModeRaw === 'pty' ||
  terminalModeRaw === 'pipe-pane' ||
  terminalModeRaw === 'auto'
    ? terminalModeRaw
    : 'pty'

const homeDir = process.env.HOME || process.env.USERPROFILE || ''

const logPollIntervalMsRaw = Number(process.env.AGENTBOARD_LOG_POLL_MS)
const logPollIntervalMs = Number.isFinite(logPollIntervalMsRaw)
  ? logPollIntervalMsRaw
  : 5000
const logPollMaxRaw = Number(process.env.AGENTBOARD_LOG_POLL_MAX)
const logPollMax = Number.isFinite(logPollMaxRaw) ? logPollMaxRaw : 25

const claudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
const codexHomeDir =
  process.env.CODEX_HOME || path.join(homeDir, '.codex')

export const config = {
  port: Number(process.env.PORT) || 4040,
  hostname: process.env.HOSTNAME || '0.0.0.0',
  tmuxSession: process.env.TMUX_SESSION || 'agentboard',
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 2000,
  discoverPrefixes: (process.env.DISCOVER_PREFIXES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  pruneWsSessions: process.env.PRUNE_WS_SESSIONS !== 'false',
  terminalMode,
  terminalMonitorTargets: process.env.TERMINAL_MONITOR_TARGETS !== 'false',
  // Allow killing external (discovered) sessions from UI
  allowKillExternal: process.env.ALLOW_KILL_EXTERNAL === 'true',
  // TLS config - set both to enable HTTPS
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  logPollIntervalMs,
  logPollMax,
  claudeConfigDir,
  codexHomeDir,
  claudeResumeCmd: process.env.CLAUDE_RESUME_CMD || 'claude --resume {sessionId}',
  codexResumeCmd: process.env.CODEX_RESUME_CMD || 'codex resume {sessionId}',
}
