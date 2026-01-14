const terminalModeRaw = process.env.TERMINAL_MODE
const terminalMode =
  terminalModeRaw === 'pty' ||
  terminalModeRaw === 'pipe-pane' ||
  terminalModeRaw === 'auto'
    ? terminalModeRaw
    : 'pty'

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
}
