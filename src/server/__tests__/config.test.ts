import { afterEach, describe, expect, test } from 'bun:test'
import os from 'node:os'

const ORIGINAL_ENV = {
  PORT: process.env.PORT,
  HOSTNAME: process.env.HOSTNAME,
  TMUX_SESSION: process.env.TMUX_SESSION,
  REFRESH_INTERVAL_MS: process.env.REFRESH_INTERVAL_MS,
  DISCOVER_PREFIXES: process.env.DISCOVER_PREFIXES,
  PRUNE_WS_SESSIONS: process.env.PRUNE_WS_SESSIONS,
  TERMINAL_MODE: process.env.TERMINAL_MODE,
  TERMINAL_MONITOR_TARGETS: process.env.TERMINAL_MONITOR_TARGETS,
  TLS_CERT: process.env.TLS_CERT,
  TLS_KEY: process.env.TLS_KEY,
  AGENTBOARD_LOG_POLL_MS: process.env.AGENTBOARD_LOG_POLL_MS,
  AGENTBOARD_LOG_POLL_MAX: process.env.AGENTBOARD_LOG_POLL_MAX,
  AGENTBOARD_RG_THREADS: process.env.AGENTBOARD_RG_THREADS,
  AGENTBOARD_LOG_MATCH_WORKER: process.env.AGENTBOARD_LOG_MATCH_WORKER,
  AGENTBOARD_LOG_MATCH_PROFILE: process.env.AGENTBOARD_LOG_MATCH_PROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_RESUME_CMD: process.env.CLAUDE_RESUME_CMD,
  CODEX_RESUME_CMD: process.env.CODEX_RESUME_CMD,
  AGENTBOARD_HOST: process.env.AGENTBOARD_HOST,
  AGENTBOARD_REMOTE_HOSTS: process.env.AGENTBOARD_REMOTE_HOSTS,
  AGENTBOARD_REMOTE_POLL_MS: process.env.AGENTBOARD_REMOTE_POLL_MS,
  AGENTBOARD_REMOTE_TIMEOUT_MS: process.env.AGENTBOARD_REMOTE_TIMEOUT_MS,
  AGENTBOARD_REMOTE_STALE_MS: process.env.AGENTBOARD_REMOTE_STALE_MS,
  AGENTBOARD_REMOTE_SSH_OPTS: process.env.AGENTBOARD_REMOTE_SSH_OPTS,
  AGENTBOARD_REMOTE_ALLOW_CONTROL: process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL,
  AGENTBOARD_REMOTE_ALLOW_ATTACH: process.env.AGENTBOARD_REMOTE_ALLOW_ATTACH,
}

const ENV_KEYS = Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function loadConfig(tag: string) {
  const modulePath = `../config?${tag}`
  const module = await import(modulePath)
  return module.config as {
    port: number
    hostname: string
    tmuxSession: string
    refreshIntervalMs: number
    discoverPrefixes: string[]
    pruneWsSessions: boolean
    terminalMode: string
    terminalMonitorTargets: boolean
    tlsCert: string
    tlsKey: string
    logPollIntervalMs: number
    logPollMax: number
    rgThreads: number
    logMatchWorker: boolean
    logMatchProfile: boolean
    claudeConfigDir: string
    codexHomeDir: string
    claudeResumeCmd: string
    codexResumeCmd: string
    hostLabel: string
    remoteHosts: string[]
    remotePollMs: number
    remoteTimeoutMs: number
    remoteStaleMs: number
    remoteSshOpts: string
    remoteAllowControl: boolean
    remoteAllowAttach: boolean
  }
}

afterEach(() => {
  restoreEnv()
})

describe('config', () => {
  test('uses defaults when env is unset', async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }

    const config = await loadConfig('defaults')
    expect(config.port).toBe(4040)
    expect(config.hostname).toBe('0.0.0.0')
    expect(config.tmuxSession).toBe('agentboard')
    expect(config.refreshIntervalMs).toBe(2000)
    expect(config.discoverPrefixes).toEqual([])
    expect(config.pruneWsSessions).toBe(true)
    expect(config.terminalMode).toBe('pty')
    expect(config.terminalMonitorTargets).toBe(true)
    expect(config.tlsCert).toBe('')
    expect(config.tlsKey).toBe('')
    expect(config.logPollIntervalMs).toBe(5000)
    expect(config.logPollMax).toBe(25)
    expect(config.rgThreads).toBe(1)
    expect(config.logMatchWorker).toBe(true)
    expect(config.logMatchProfile).toBe(false)
    expect(config.claudeResumeCmd).toBe('claude --resume {sessionId}')
    expect(config.codexResumeCmd).toBe('codex resume {sessionId}')
    expect(config.hostLabel).toBe(os.hostname())
    expect(config.remoteHosts).toEqual([])
    expect(config.remotePollMs).toBe(2000)
    expect(config.remoteTimeoutMs).toBe(4000)
    expect(config.remoteStaleMs).toBe(15000)
    expect(config.remoteSshOpts).toBe('')
    expect(config.remoteAllowControl).toBe(false)
    expect(config.remoteAllowAttach).toBe(false)
  })

  test('parses env overrides and trims discover prefixes', async () => {
    process.env.PORT = '9090'
    process.env.HOSTNAME = '127.0.0.1'
    process.env.TMUX_SESSION = 'demo'
    process.env.REFRESH_INTERVAL_MS = '3000'
    process.env.DISCOVER_PREFIXES = ' alpha, beta ,,gamma '
    process.env.PRUNE_WS_SESSIONS = 'false'
    process.env.TERMINAL_MODE = 'pipe-pane'
    process.env.TERMINAL_MONITOR_TARGETS = 'false'
    process.env.TLS_CERT = '/tmp/cert.pem'
    process.env.TLS_KEY = '/tmp/key.pem'
    process.env.AGENTBOARD_LOG_POLL_MS = '7000'
    process.env.AGENTBOARD_LOG_POLL_MAX = '123'
    process.env.AGENTBOARD_RG_THREADS = '4'
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    process.env.AGENTBOARD_LOG_MATCH_PROFILE = 'true'
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude'
    process.env.CODEX_HOME = '/tmp/codex'
    process.env.CLAUDE_RESUME_CMD = 'claude --resume={sessionId}'
    process.env.CODEX_RESUME_CMD = 'codex --resume={sessionId}'
    process.env.AGENTBOARD_HOST = 'blade'
    process.env.AGENTBOARD_REMOTE_HOSTS = 'mba,carbon,worm'
    process.env.AGENTBOARD_REMOTE_POLL_MS = '12000'
    process.env.AGENTBOARD_REMOTE_TIMEOUT_MS = '9000'
    process.env.AGENTBOARD_REMOTE_STALE_MS = '50000'
    process.env.AGENTBOARD_REMOTE_SSH_OPTS = '-o StrictHostKeyChecking=accept-new'
    process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL = 'true'

    const config = await loadConfig('overrides')
    expect(config.port).toBe(9090)
    expect(config.hostname).toBe('127.0.0.1')
    expect(config.tmuxSession).toBe('demo')
    expect(config.refreshIntervalMs).toBe(3000)
    expect(config.discoverPrefixes).toEqual(['alpha', 'beta', 'gamma'])
    expect(config.pruneWsSessions).toBe(false)
    expect(config.terminalMode).toBe('pipe-pane')
    expect(config.terminalMonitorTargets).toBe(false)
    expect(config.tlsCert).toBe('/tmp/cert.pem')
    expect(config.tlsKey).toBe('/tmp/key.pem')
    expect(config.logPollIntervalMs).toBe(7000)
    expect(config.logPollMax).toBe(123)
    expect(config.rgThreads).toBe(4)
    expect(config.logMatchWorker).toBe(false)
    expect(config.logMatchProfile).toBe(true)
    expect(config.claudeConfigDir).toBe('/tmp/claude')
    expect(config.codexHomeDir).toBe('/tmp/codex')
    expect(config.claudeResumeCmd).toBe('claude --resume={sessionId}')
    expect(config.codexResumeCmd).toBe('codex --resume={sessionId}')
    expect(config.hostLabel).toBe('blade')
    expect(config.remoteHosts).toEqual(['mba', 'carbon', 'worm'])
    expect(config.remotePollMs).toBe(12000)
    expect(config.remoteTimeoutMs).toBe(9000)
    expect(config.remoteStaleMs).toBe(50000)
    expect(config.remoteSshOpts).toBe('-o StrictHostKeyChecking=accept-new')
    expect(config.remoteAllowControl).toBe(true)
    expect(config.remoteAllowAttach).toBe(true)
  })

  test('REMOTE_ALLOW_ATTACH=true works without REMOTE_ALLOW_CONTROL', async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    process.env.AGENTBOARD_REMOTE_ALLOW_ATTACH = 'true'

    const config = await loadConfig('attach-only')
    expect(config.remoteAllowAttach).toBe(true)
    expect(config.remoteAllowControl).toBe(false)
  })

  test('REMOTE_ALLOW_CONTROL=true implies REMOTE_ALLOW_ATTACH=true', async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL = 'true'

    const config = await loadConfig('control-implies-attach')
    expect(config.remoteAllowControl).toBe(true)
    expect(config.remoteAllowAttach).toBe(true)
  })
})
