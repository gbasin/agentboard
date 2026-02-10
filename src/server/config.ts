import os from 'node:os'
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
const rgThreadsRaw = Number(process.env.AGENTBOARD_RG_THREADS)
const rgThreads = Number.isFinite(rgThreadsRaw) && rgThreadsRaw > 0
  ? Math.floor(rgThreadsRaw)
  : 1
const logMatchWorkerRaw = process.env.AGENTBOARD_LOG_MATCH_WORKER
const logMatchWorker =
  logMatchWorkerRaw === 'false' || logMatchWorkerRaw === '0' ? false : true
const logMatchProfile =
  process.env.AGENTBOARD_LOG_MATCH_PROFILE === 'true' ||
  process.env.AGENTBOARD_LOG_MATCH_PROFILE === '1'

const enterRefreshDelayMsRaw = Number(process.env.AGENTBOARD_ENTER_REFRESH_MS)
const enterRefreshDelayMs = Number.isFinite(enterRefreshDelayMsRaw)
  ? enterRefreshDelayMsRaw
  : 1000

const workingGracePeriodMsRaw = Number(process.env.AGENTBOARD_WORKING_GRACE_MS)
const workingGracePeriodMs = Number.isFinite(workingGracePeriodMsRaw)
  ? workingGracePeriodMsRaw
  : 4000

// Max age for inactive sessions shown in UI (hours)
// Sessions older than this are not sent to frontend or processed for orphan rematch
const inactiveSessionMaxAgeHoursRaw = Number(process.env.AGENTBOARD_INACTIVE_MAX_AGE_HOURS)
const inactiveSessionMaxAgeHours = Number.isFinite(inactiveSessionMaxAgeHoursRaw)
  ? inactiveSessionMaxAgeHoursRaw
  : 24

// Exclude sessions from certain project directories (comma-separated paths)
// Sessions with projectPath starting with any of these will be filtered out
// Example: AGENTBOARD_EXCLUDE_PROJECTS="/,/tmp" to exclude root and /tmp sessions
const excludeProjects = (process.env.AGENTBOARD_EXCLUDE_PROJECTS || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)

// Default patterns for sessions that should skip window matching when orphaned.
// These sessions are still tracked in the DB but won't trigger expensive
// ripgrep scans trying to match them to tmux windows.
// Special markers:
//   <codex-exec> - Codex sessions started via `codex exec` (headless)
// Path patterns support trailing * for prefix matching.
const defaultSkipMatchingPatterns = [
  '<codex-exec>',
  '/private/tmp/*',
  '/private/var/folders/*',
  '/var/folders/*',
  '/tmp/*',
]

// Allow override via env var (comma-separated). If set (even empty), replaces defaults.
// Set to empty string to disable skip matching entirely.
const skipMatchingPatternsRaw = process.env.AGENTBOARD_SKIP_MATCHING_PATTERNS
const skipMatchingPatterns = skipMatchingPatternsRaw !== undefined
  ? skipMatchingPatternsRaw.split(',').map((p) => p.trim()).filter(Boolean)
  : defaultSkipMatchingPatterns

// Logging config
const logLevelRaw = process.env.LOG_LEVEL?.toLowerCase()
const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw || '')
  ? (logLevelRaw as 'debug' | 'info' | 'warn' | 'error')
  : 'info'
const defaultLogFile = path.join(homeDir, '.agentboard', 'agentboard.log')
const logFile = process.env.LOG_FILE ?? defaultLogFile

const claudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
const codexHomeDir =
  process.env.CODEX_HOME || path.join(homeDir, '.codex')

const hostLabel = process.env.AGENTBOARD_HOST?.trim() || os.hostname()

// RFC 1123 hostname validation
// Each label: 1-63 chars, alphanumeric + hyphen, no leading/trailing hyphen
const HOSTNAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])(\.([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*$/

export function isValidHostname(hostname: string): boolean {
  return hostname.length > 0 && hostname.length <= 253 && HOSTNAME_REGEX.test(hostname)
}

const remoteHosts = (process.env.AGENTBOARD_REMOTE_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => {
    if (!value) return false
    if (!isValidHostname(value)) {
      console.warn(`[agentboard] Invalid hostname in AGENTBOARD_REMOTE_HOSTS: "${value}"`)
      return false
    }
    return true
  })

const remotePollMsRaw = Number(process.env.AGENTBOARD_REMOTE_POLL_MS)
const remotePollMs = Number.isFinite(remotePollMsRaw) ? remotePollMsRaw : 2000

const remoteTimeoutMsRaw = Number(process.env.AGENTBOARD_REMOTE_TIMEOUT_MS)
const remoteTimeoutMs = Number.isFinite(remoteTimeoutMsRaw) ? remoteTimeoutMsRaw : 4000

const remoteStaleMsRaw = Number(process.env.AGENTBOARD_REMOTE_STALE_MS)
const remoteStaleMs = Number.isFinite(remoteStaleMsRaw)
  ? remoteStaleMsRaw
  : Math.max(remotePollMs * 3, 15000)

const remoteSshOpts = process.env.AGENTBOARD_REMOTE_SSH_OPTS || ''
const remoteAllowControl = process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL === 'true'
// Allow attaching to (viewing/interacting with) remote terminals.
// Defaults to true when remoteAllowControl is enabled; can be set independently.
const remoteAllowAttachRaw = process.env.AGENTBOARD_REMOTE_ALLOW_ATTACH
const remoteAllowAttach = remoteAllowAttachRaw !== undefined
  ? remoteAllowAttachRaw === 'true'
  : remoteAllowControl

export const config = {
  port: Number(process.env.PORT) || 4040,
  hostname: process.env.HOSTNAME || '0.0.0.0',
  hostLabel,
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
  rgThreads,
  logMatchWorker,
  logMatchProfile,
  claudeConfigDir,
  codexHomeDir,
  claudeResumeCmd: process.env.CLAUDE_RESUME_CMD || 'claude --resume {sessionId}',
  codexResumeCmd: process.env.CODEX_RESUME_CMD || 'codex resume {sessionId}',
  enterRefreshDelayMs,
  workingGracePeriodMs,
  inactiveSessionMaxAgeHours,
  excludeProjects,
  skipMatchingPatterns,
  logLevel,
  logFile,
  remoteHosts,
  remotePollMs,
  remoteTimeoutMs,
  remoteStaleMs,
  remoteSshOpts,
  remoteAllowControl,
  remoteAllowAttach,
}
