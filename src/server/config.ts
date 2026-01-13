export const config = {
  port: Number(process.env.PORT) || 4040,
  hostname: process.env.HOSTNAME || '0.0.0.0',
  tmuxSession: process.env.TMUX_SESSION || 'agentboard',
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 2000,
  discoverPrefixes: (process.env.DISCOVER_PREFIXES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  // TLS config - set both to enable HTTPS
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
}
