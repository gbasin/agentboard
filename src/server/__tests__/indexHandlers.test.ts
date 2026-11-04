import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Session, ServerMessage, TerminalSession } from '@shared/types'
import type { AgentSessionRecord, ChatSessionRecord, ClaimCurrentWindowPatch } from '../db'
import { TmuxTimeoutError } from '../tmuxTimeout'
import { TMUX_FIELD_SEPARATOR } from '../tmuxFormat'
import { BUILD_VERSION } from '../version'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawn: typeof Bun.spawn
  spawnSync: typeof Bun.spawnSync
  write: typeof Bun.write
}

const processAny = process as typeof process & {
  on: typeof process.on
  exit: typeof process.exit
}

const originalServe = bunAny.serve
const originalSpawn = bunAny.spawn
const originalSpawnSync = bunAny.spawnSync
const originalWrite = bunAny.write
const originalSetInterval = globalThis.setInterval
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalProcessOn = processAny.on
const originalProcessExit = processAny.exit

let mailboxDb: Database

let serveOptions: Parameters<typeof Bun.serve>[0] | null = null
let spawnSyncImpl: typeof Bun.spawnSync
let writeImpl: typeof Bun.write
let replaceSessionsCalls: Session[][] = []
let logEntries: Array<{
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  data?: Record<string, unknown>
}> = []
let dbState: {
  appSettings: Map<string, string>
  records: Map<string, AgentSessionRecord>
  chatRecords: Map<string, ChatSessionRecord>
  nextId: number
  setAppSettingCalls: Array<{ key: string; value: string }>
  setAppSettingError: Error | null
  updateSessionError:
    | ((
        sessionId: string,
        patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
      ) => Error | null)
    | null
  updateCalls: Array<{ sessionId: string; patch: Partial<AgentSessionRecord> }>
  setPinnedCalls: Array<{ sessionId: string; isPinned: boolean }>
}

const defaultConfig = {
  port: 4040,
  hostname: '0.0.0.0',
  hostLabel: 'test-host',
  refreshIntervalMs: 1000,
  tmuxSession: 'agentboard',
  discoverPrefixes: [],
  pruneWsSessions: true,
  terminalMode: 'pty',
  terminalMonitorTargets: true,
  terminalColorsEnabled: true,
  tlsCert: '',
  tlsKey: '',
  rgThreads: 1,
  logMatchWorker: false,
  logMatchProfile: false,
  claudeResumeCmd: 'claude --resume {sessionId}',
  codexResumeCmd: 'codex resume {sessionId}',
  piResumeCmd: 'pi --session {logFilePath}',
  remoteHosts: [] as string[],
  remotePollMs: 15000,
  remoteTimeoutMs: 4000,
  remoteStaleMs: 45000,
  remoteSshOpts: '',
  remoteAllowControl: false,
  remoteAllowAttach: false,
  tmuxTimeoutMs: 3000,
  tmuxMutationTimeoutMs: 15000,
  pasteImageMaxBytes: 40 * 1024 * 1024,
  defaultProjectDir: '',
}

const configState = { ...defaultConfig }
const baseRecordTimestamp = new Date('2026-01-01T00:00:00.000Z').toISOString()

function resetDbState() {
  dbState = {
    appSettings: new Map(),
    records: new Map(),
    chatRecords: new Map(),
    nextId: 1,
    setAppSettingCalls: [],
    setAppSettingError: null,
    updateSessionError: null,
    updateCalls: [],
    setPinnedCalls: [],
  }
}

function makeRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  const id = overrides.id ?? dbState.nextId++
  const sessionId = overrides.sessionId ?? `session-${id}`
  const logFilePath =
    overrides.logFilePath ?? path.join('/tmp', `${sessionId}.jsonl`)

  return {
    id,
    sessionId,
    logFilePath,
    projectPath: '/tmp/project',
    slug: null,
    agentType: 'claude',
    displayName: 'alpha',
    createdAt: baseRecordTimestamp,
    lastActivityAt: baseRecordTimestamp,
    lastUserMessage: null,
    currentWindow: null,
    isPinned: false,
    lastResumeError: null,
    wakeStartedAt: null,
    lastKnownLogSize: null,
    isCodexExec: false,
    launchCommand: null,
    ...overrides,
  }
}

function seedRecord(record: AgentSessionRecord) {
  dbState.records.set(record.sessionId, record)
}

let sessionManagerState: {
  listWindows: () => Session[]
  createWindow: (
    projectPath: string,
    name?: string,
    command?: string
  ) => Session
  killWindow: (tmuxWindow: string) => void
  renameWindow: (tmuxWindow: string, newName: string) => void
  setMouseMode: (enabled: boolean) => void
  setTerminalColors: (enabled: boolean) => void
  ensureSession: () => { canPruneWsSessions: boolean }
  scrubLeakedGlobalEnvironment: () => string[]
}

class SessionManagerMock {
  static instance: SessionManagerMock | null = null
  constructor() {
    SessionManagerMock.instance = this
  }

  listWindows() {
    return sessionManagerState.listWindows()
  }

  createWindow(projectPath: string, name?: string, command?: string) {
    return sessionManagerState.createWindow(projectPath, name, command)
  }

  killWindow(tmuxWindow: string) {
    sessionManagerState.killWindow(tmuxWindow)
  }

  renameWindow(tmuxWindow: string, newName: string) {
    sessionManagerState.renameWindow(tmuxWindow, newName)
  }

  setMouseMode(enabled: boolean) {
    sessionManagerState.setMouseMode(enabled)
  }

  setTerminalColors(enabled: boolean) {
    sessionManagerState.setTerminalColors(enabled)
  }

  ensureSession() {
    return sessionManagerState.ensureSession()
  }

  scrubLeakedGlobalEnvironment() {
    return sessionManagerState.scrubLeakedGlobalEnvironment()
  }
}

class SessionRegistryMock {
  static instance: SessionRegistryMock | null = null
  // The instance whose setAgentSessions ran last (N2): the startup marker is
  // emitted in the same synchronous block that call sits in, so the pair is
  // atomic and the logger gate can tell this test's registry from a previous
  // import's late one.
  static lastActor: SessionRegistryMock | null = null
  sessions: Session[] = []
  agentSessions: { active: unknown[]; hibernating: unknown[]; history: unknown[] } = {
    active: [],
    hibernating: [],
    history: [],
  }
  listeners = new Map<string, Array<(payload: unknown) => void>>()

  constructor() {
    SessionRegistryMock.instance = this
  }

  replaceSessions(sessions: Session[]) {
    this.sessions = sessions
    // Record only the live test's registry: a previous index's late async
    // work (startup verification, enter refresh) writes its own instance and
    // must not reach this test's recorded calls.
    if (this === SessionRegistryMock.instance) {
      replaceSessionsCalls.push(sessions)
    }
    this.emit('sessions', sessions)
  }

  getAll() {
    return this.sessions
  }

  setChatSession(session: Session) {
    this.sessions.push(session)
    this.emit('sessions', this.sessions)
  }

  removeChatSession(id: string) {
    this.sessions = this.sessions.filter(session => session.id !== id)
    this.emit('session-removed', id)
  }

  getAgentSessions() {
    return this.agentSessions
  }

  get(id: string) {
    return this.sessions.find((session) => session.id === id)
  }

  updateSession(id: string, patch: Partial<Session>) {
    const index = this.sessions.findIndex((session) => session.id === id)
    if (index === -1) return undefined
    const updated = { ...this.sessions[index], ...patch }
    this.sessions[index] = updated
    this.emit('session-update', updated)
    return updated
  }

  on(event: string, listener: (payload: unknown) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  setAgentSessions(active: unknown[], hibernating: unknown[], history: unknown[]) {
    SessionRegistryMock.lastActor = this
    this.agentSessions = { active, hibernating, history }
    this.emit('agent-sessions', { active, hibernating, history })
  }
}

class TerminalProxyMock {
  static instances: TerminalProxyMock[] = []
  options: {
    connectionId: string
    sessionName: string
    baseSession: string
    onData: (data: string) => void
    onExit?: () => void
  }
  starts = 0
  writes: string[] = []
  pastes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  disposed = false
  switchTargets: string[] = []
  private started = false

  constructor(options: {
    connectionId: string
    sessionName: string
    baseSession: string
    onData: (data: string) => void
    onExit?: () => void
  }) {
    this.options = options
    TerminalProxyMock.instances.push(this)
  }

  start() {
    if (!this.started) {
      this.starts += 1
      this.started = true
    }
    return Promise.resolve()
  }

  switchTo(target: string, onReady?: () => void) {
    this.switchTargets.push(target)
    if (onReady) {
      onReady()
    }
    return Promise.resolve(true)
  }

  ensureEffectiveTarget(target: string) {
    if (target === this.options.baseSession) {
      return this.options.sessionName
    }
    const prefix = `${this.options.baseSession}:`
    if (target.startsWith(prefix)) {
      return `${this.options.sessionName}:${target.slice(prefix.length)}`
    }
    return target
  }

  write(data: string) {
    this.writes.push(data)
  }

  paste(data: string) {
    this.pastes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows })
  }

  dispose() {
    this.disposed = true
  }

  getMode() {
    return 'pty' as const
  }

  getSessionName() {
    return this.options.sessionName
  }

  emitData(data: string) {
    this.options.onData(data)
  }

  emitExit() {
    this.options.onExit?.()
  }
}

mock.module('../config', () => ({
  config: configState,
  isValidHostname: (hostname: string) => {
    const re = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])(\.([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*$/
    return hostname.length > 0 && hostname.length <= 253 && re.test(hostname)
  },
}))
// N2: a previous index's startup verification can settle late and log its
// startup_verification_complete marker into the live test's logEntries, so a
// wait gated on that count passes early. The marker is emitted in the same
// synchronous block that calls registry.setAgentSessions (SessionRefreshLoop),
// so recording the last registry actor and gating only this marker on "it is
// the live test's registry" drops the stale marker while passing this test's —
// the same gate replaceSessions applies to its recorded calls. Every other
// event passes unconditionally.
function pushLogEntry(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>
) {
  if (
    event === 'startup_verification_complete' &&
    SessionRegistryMock.lastActor !== SessionRegistryMock.instance
  ) {
    return
  }
  logEntries.push({ level, event, data })
}
mock.module('../logger', () => ({
  logLevel: 'info',
  logger: {
    debug: (event: string, data?: Record<string, unknown>) => pushLogEntry('debug', event, data),
    info: (event: string, data?: Record<string, unknown>) => pushLogEntry('info', event, data),
    warn: (event: string, data?: Record<string, unknown>) => pushLogEntry('warn', event, data),
    error: (event: string, data?: Record<string, unknown>) => pushLogEntry('error', event, data),
  },
}))
mock.module('../db', () => ({
  resolveDataDir: () => path.join(os.tmpdir(), `agentboard-index-handlers-${process.pid}`),
  initDatabase: () => ({
    db: mailboxDb,
    getChatSessions: () => Array.from(dbState.chatRecords.values()),
    getChatSession: (sessionId: string) => dbState.chatRecords.get(sessionId) ?? null,
    insertChatSession: (session: ChatSessionRecord) => {
      dbState.chatRecords.set(session.sessionId, session)
      return session
    },
    updateChatSession: (sessionId: string, patch: Partial<Omit<ChatSessionRecord, 'sessionId'>>) => {
      const record = dbState.chatRecords.get(sessionId)
      if (!record) return null
      const updated = { ...record, ...patch }
      dbState.chatRecords.set(sessionId, updated)
      return updated
    },
    deleteChatSession: (sessionId: string) => dbState.chatRecords.delete(sessionId),
    getSessionById: (sessionId: string) => dbState.records.get(sessionId) ?? null,
    getSessionByLogPath: (logFilePath: string) =>
      Array.from(dbState.records.values()).find(
        (record) => record.logFilePath === logFilePath
      ) ?? null,
    getSessionByWindow: (tmuxWindow: string) =>
      Array.from(dbState.records.values()).find(
        (record) => record.currentWindow === tmuxWindow
      ) ?? null,
    getActiveSessions: () =>
      Array.from(dbState.records.values()).filter(
        (record) => record.currentWindow !== null
      ),
    getHistorySessions: (options?: { maxAgeHours?: number }) => {
      const history = Array.from(dbState.records.values()).filter(
        (record) => record.currentWindow === null && !record.isPinned
      )
      if (!options?.maxAgeHours) {
        return history
      }
      const cutoff = Date.now() - options.maxAgeHours * 60 * 60 * 1000
      return history.filter(
        (record) => new Date(record.lastActivityAt).getTime() > cutoff
      )
    },
    getHibernatingSessions: () =>
      Array.from(dbState.records.values()).filter(
        (record) => record.currentWindow === null && record.isPinned
      ),
    orphanSession: (sessionId: string, options?: { hibernate?: boolean }) => {
      const record = dbState.records.get(sessionId)
      if (!record) return null
      const updated = {
        ...record,
        currentWindow: null,
        isPinned: options?.hibernate ?? true,
      }
      dbState.records.set(sessionId, updated)
      return updated
    },
    updateSession: (
      sessionId: string,
      patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
    ) => {
      const error = dbState.updateSessionError?.(sessionId, patch)
      if (error) {
        throw error
      }
      const record = dbState.records.get(sessionId)
      if (!record) return null
      const updated = { ...record, ...patch }
      dbState.records.set(sessionId, updated)
      dbState.updateCalls.push({
        sessionId,
        patch: patch as Partial<AgentSessionRecord>,
      })
      return updated
    },
    claimCurrentWindow: (
      sessionId: string,
      tmuxWindow: string,
      extraPatch?: ClaimCurrentWindowPatch
    ) => {
      const record = dbState.records.get(sessionId)
      if (!record) return null
      if (record.currentWindow !== null) return null
      // Reject if another row already owns this window.
      for (const other of dbState.records.values()) {
        if (other.sessionId !== sessionId && other.currentWindow === tmuxWindow) {
          return null
        }
      }
      const patch = { currentWindow: tmuxWindow, ...(extraPatch as Partial<AgentSessionRecord>) }
      const error = dbState.updateSessionError?.(sessionId, patch)
      if (error) {
        throw error
      }
      const updated = { ...record, ...extraPatch, currentWindow: tmuxWindow }
      dbState.records.set(sessionId, updated)
      dbState.updateCalls.push({
        sessionId,
        patch,
      })
      return updated
    },
    displayNameExists: (displayName: string, excludeSessionId?: string) =>
      Array.from(dbState.records.values()).some(
        (record) =>
          record.displayName === displayName &&
          record.sessionId !== excludeSessionId
      ),
    setPinned: (sessionId: string, isPinned: boolean) => {
      dbState.setPinnedCalls.push({ sessionId, isPinned })
      const record = dbState.records.get(sessionId)
      if (!record) return null
      const updated = { ...record, isPinned }
      dbState.records.set(sessionId, updated)
      return updated
    },
    getAppSetting: (key: string) => dbState.appSettings.get(key) ?? null,
    setAppSetting: (key: string, value: string) => {
      if (dbState.setAppSettingError) {
        throw dbState.setAppSettingError
      }
      dbState.appSettings.set(key, value)
      dbState.setAppSettingCalls.push({ key, value })
    },
    close: () => {},
  }),
}))
// Controllable refresh worker mock.
// By default, refresh() resolves immediately with refreshWorkerSessions.
// Set refreshWorkerDeferred = true before triggering a refresh to make it
// hang until refreshWorkerResolve/Reject is called.
let refreshWorkerDeferred = false
let refreshWorkerSessions: Session[] = []
let refreshWorkerResolve: ((sessions: Session[]) => void) | null = null
let _refreshWorkerReject: ((error: Error) => void) | null = null
let refreshWorkerError: Error | null = null
let refreshWorkerExpectedWindowCounts: number[] = []
let lastUserMessageWorkerError: Error | null = null
let lastUserMessageWorkerMessage: string | null = null

class SessionRefreshWorkerTimeoutErrorMock extends Error {
  constructor(message = 'Session refresh worker timed out') {
    super(message)
    this.name = 'SessionRefreshWorkerTimeoutError'
  }
}

class SessionRefreshWorkerClientMock {
  // Workers of the live test's index only: a previous index's late refresh
  // runs on its own client and must not append into this test's counts.
  static instances = new Set<SessionRefreshWorkerClientMock>()

  constructor() {
    SessionRefreshWorkerClientMock.instances.add(this)
  }

  refresh(
    _managedSession: string,
    _discoverPrefixes: string[],
    options?: { expectedWindowCount?: number }
  ): Promise<Session[]> {
    if (SessionRefreshWorkerClientMock.instances.has(this)) {
      refreshWorkerExpectedWindowCounts.push(options?.expectedWindowCount ?? 0)
    }
    if (refreshWorkerDeferred) {
      return new Promise<Session[]>((resolve, reject) => {
        refreshWorkerResolve = resolve
        _refreshWorkerReject = reject
      })
    }
    if (refreshWorkerError) {
      const error = refreshWorkerError
      refreshWorkerError = null
      return Promise.reject(error)
    }
    return Promise.resolve(refreshWorkerSessions)
  }

  getLastUserMessage(): Promise<string | null> {
    if (lastUserMessageWorkerError) {
      const error = lastUserMessageWorkerError
      lastUserMessageWorkerError = null
      return Promise.reject(error)
    }
    return Promise.resolve(lastUserMessageWorkerMessage)
  }

  dispose(): void {}
}

mock.module('../sessionRefreshWorkerClient', () => ({
  SessionRefreshWorkerClient: SessionRefreshWorkerClientMock,
  SessionRefreshWorkerTimeoutError: SessionRefreshWorkerTimeoutErrorMock,
}))
mock.module('../SessionManager', () => ({
  SessionManager: SessionManagerMock,
}))
mock.module('../SessionRegistry', () => ({
  SessionRegistry: SessionRegistryMock,
}))
class TerminalProxyErrorMock extends Error {
  code: string
  retryable: boolean
  constructor(message: string, code: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

mock.module('../terminal', () => ({
  createTerminalProxy: (options: ConstructorParameters<typeof TerminalProxyMock>[0]) =>
    new TerminalProxyMock(options),
  resolveTerminalMode: () => 'pty',
  TerminalProxyError: TerminalProxyErrorMock,
}))

const baseSession: TerminalSession = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  source: 'managed',
  host: 'test-host',
  remote: false,
}

function getTmuxArgs(command: string[]): string[] {
  if (command[0] !== 'tmux') {
    return []
  }
  return command[1] === '-u' ? command.slice(2) : command.slice(1)
}

function tmuxLine(...fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR)
}

function tmuxOutput(...rows: string[][]): string {
  return rows.map((row) => tmuxLine(...row)).join('\n')
}

function createWs() {
  const sent: ServerMessage[] = []
  const ws = {
    data: {
      terminal: null as TerminalProxyMock | null,
      currentSessionId: null as string | null,
      currentTmuxTarget: null as string | null,
      connectionId: 'ws-test',
      remoteAddress: '127.0.0.1',
      userAgent: 'test-agent',
      terminalHost: null as string | null,
      terminalAttachSeq: 0,
      lastAttachKey: null as string | null,
      lastAttachTs: 0,
      clipboardPollTimer: null as ReturnType<typeof setInterval> | null,
      clipboardPollInFlight: false,
      lastClipboardBufferKey: null as string | null,
      clipboardBufferArmedUntil: 0,
      clipboardArmedAtSec: 0,
      clipboardWatchGen: 0,
      copyModeCheckInFlight: false,
    },
    send: (payload: string) => {
      sent.push(JSON.parse(payload) as ServerMessage)
    },
  }
  return { ws, sent }
}

/**
 * Async tmux handlers (copy-mode probes, history capture) send their replies
 * only after their spawned command resolves — dispatch returning does not
 * imply the handler finished. Bounded-poll the captured outbound messages.
 */
async function waitForSent(
  sent: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
  description: string,
  timeoutMs = 2000
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (sent.some(predicate)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

let importCounter = 0

async function loadIndex() {
  importCounter += 1
  await import(`../index?test=${importCounter}`)
  if (!serveOptions) {
    throw new Error('Bun.serve was not called')
  }
  if (!SessionRegistryMock.instance) {
    throw new Error('SessionRegistry instance was not created')
  }
  if (!SessionManagerMock.instance) {
    throw new Error('SessionManager instance was not created')
  }
  return {
    serveOptions,
    registryInstance: SessionRegistryMock.instance,
    sessionManagerInstance: SessionManagerMock.instance,
  }
}

function startupVerificationCount(): number {
  return logEntries.filter((entry) => entry.event === 'startup_verification_complete').length
}

/**
 * completeStartupVerification() is fire-and-forget (bootstrap.ts) and its
 * disk IO can still be in flight when a test starts driving the server, so a
 * baseline captured before it settles can be invalidated by its late
 * replaceSessions. Each index logs exactly one startup_verification_complete
 * entry; wait for this import's entry before capturing any baseline. The
 * logger mock only records that marker when the last registry actor is this
 * test's registry instance (the same gate replaceSessions applies), so a
 * previous import's late marker never satisfies the wait.
 */
async function waitForStartupVerification(baseline: number): Promise<void> {
  // 4 s: settled imports return at once, and the bound stays under the raw
  // `bun test` 5 s per-test default as well as the runner's 20 s.
  const startedAt = Date.now()
  while (Date.now() - startedAt < 4000 && startupVerificationCount() <= baseline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (startupVerificationCount() <= baseline) {
    throw new Error('Timed out waiting for: startup_verification_complete')
  }
}

/**
 * Bounded-poll for the refresh whose payload is the expected outcome — not
 * merely any new call, which a concurrent path's call can satisfy first.
 */
async function waitForReplacedSessions(
  baseline: number,
  matches: (sessions: Session[]) => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (replaceSessionsCalls.slice(baseline).some(matches)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

beforeEach(() => {
  // The full schema (baseline plus every migration), as initDatabase leaves it.
  mailboxDb = schemaDb()
  serveOptions = null
  replaceSessionsCalls = []
  logEntries = []
  TerminalProxyMock.instances = []
  SessionManagerMock.instance = null
  refreshWorkerDeferred = false
  refreshWorkerSessions = []
  refreshWorkerResolve = null
  _refreshWorkerReject = null
  refreshWorkerError = null
  refreshWorkerExpectedWindowCounts = []
  lastUserMessageWorkerError = null
  lastUserMessageWorkerMessage = null
  SessionRegistryMock.instance = null
  SessionRegistryMock.lastActor = null
  SessionRefreshWorkerClientMock.instances = new Set()
  resetDbState()
  Object.assign(configState, defaultConfig)
  sessionManagerState = {
    listWindows: () => [],
    createWindow: () => ({ ...baseSession, id: 'created' }),
    killWindow: () => {},
    renameWindow: () => {},
    setMouseMode: () => {},
    setTerminalColors: () => {},
    ensureSession: () => ({ canPruneWsSessions: true }),
    scrubLeakedGlobalEnvironment: () => [],
  }

  spawnSyncImpl = () =>
    ({
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    }) as ReturnType<typeof Bun.spawnSync>
  writeImpl = (async () => 0) as typeof Bun.write

  bunAny.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) =>
    spawnSyncImpl(...args)) as typeof Bun.spawnSync
  // Mock Bun.spawn for async SSH calls — delegates to spawnSyncImpl for results
  bunAny.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const cmd = Array.isArray(args[0]) ? args[0] : [String(args[0])]
    const opts = typeof args[1] === 'object' ? args[1] : undefined
    const syncResult = spawnSyncImpl(
      cmd as Parameters<typeof Bun.spawnSync>[0],
      opts as Parameters<typeof Bun.spawnSync>[1]
    )
    const stdoutBuf = syncResult.stdout ?? Buffer.from('')
    const stderrBuf = syncResult.stderr ?? Buffer.from('')
    return {
      exited: Promise.resolve(syncResult.exitCode ?? 0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(typeof stdoutBuf === 'string' ? new TextEncoder().encode(stdoutBuf) : stdoutBuf)
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(typeof stderrBuf === 'string' ? new TextEncoder().encode(stderrBuf) : stderrBuf)
          controller.close()
        },
      }),
      kill: () => {},
      pid: 12345,
    } as unknown as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn
  bunAny.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    serveOptions = options
    return {} as ReturnType<typeof Bun.serve>
  }) as typeof Bun.serve
  bunAny.write = ((...args: Parameters<typeof Bun.write>) =>
    writeImpl(...args)) as typeof Bun.write

  globalThis.setInterval = ((..._args: Parameters<typeof globalThis.setInterval>) =>
    0) as unknown as typeof globalThis.setInterval
  console.log = () => {}
  console.error = () => {}
  processAny.on = (() => processAny) as typeof processAny.on
})

afterEach(async () => {
  // Startup mailbox work must settle before closing its SQLite fixture.
  for (let i = 0; i < 6; i++) await Promise.resolve()
  mailboxDb.close()
  bunAny.serve = originalServe
  bunAny.spawn = originalSpawn
  bunAny.spawnSync = originalSpawnSync
  bunAny.write = originalWrite
  globalThis.setInterval = originalSetInterval
  console.log = originalConsoleLog
  console.error = originalConsoleError
  processAny.on = originalProcessOn
  processAny.exit = originalProcessExit
})

afterAll(() => {
  mock.restore()
})

mock.module('../chat/sdkAvailability', () => ({ probeSdkAvailability: async () => {} }))
// The executable check spawns a real child for --version; Bun.spawn is
// mocked below, so stub the module like the handshake probe above.
mock.module('../chat/claudeExecutable', () => {
  class ClaudeExecutableError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
    }
  }
  return {
    ClaudeExecutableError,
    ensureClaudeExecutable: async () => ({ path: '/mock/claude', identity: 'mock-claude' }),
  }
})

describe('server message handlers', () => {
  test('chat creation and kill route through the manager without creating a tmux window', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket!
      websocket.open?.(ws as never)
      const before = registryInstance.getAll().length
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', kind: 'chat', projectPath: os.tmpdir(), name: 'test chat' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const created = sent.find(message => message.type === 'session-created')
      expect(created?.type).toBe('session-created')
      if (created?.type !== 'session-created') throw new Error('Chat creation failed')
      expect(created.session.kind).toBe('chat')
      expect(created.session.tmuxWindow).toBeUndefined()
      expect(registryInstance.getAll()).toHaveLength(before + 1)
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-kill', sessionId: created.session.id }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(registryInstance.get(created.session.id)).toBeUndefined()
      expect(sent).toContainEqual({ type: 'session-removed', sessionId: created.session.id })
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  // @covers: chat-sessions › Users configure the default approval policy for new chat sessions › Unspecified policy creates a manual session
  test('chat creation applies the requested approval policy and defaults to manual', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const websocket = serveOptions.websocket!

      const create = async (payload: Record<string, unknown>) => {
        const { ws, sent } = createWs()
        websocket.open?.(ws as never)
        websocket.message?.(ws as never, JSON.stringify({
          type: 'session-create',
          kind: 'chat',
          projectPath: os.tmpdir(),
          ...payload,
        }))
        await new Promise(resolve => setTimeout(resolve, 0))
        const created = sent.find(message => message.type === 'session-created')
        if (created?.type !== 'session-created') throw new Error('Chat creation failed')
        return created.session
      }

      const auto = await create({ approvalPolicy: 'auto' })
      expect(auto.approvalPolicy).toBe('auto')
      expect(registryInstance.get(auto.id)?.approvalPolicy).toBe('auto')

      // Absent field (older clients) and an unknown value both read as manual.
      const absent = await create({})
      expect(absent.approvalPolicy).toBe('manual')
      const corrupt = await create({ approvalPolicy: 'yolo' })
      expect(corrupt.approvalPolicy).toBe('manual')
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  test('chat archive and restore broadcast the updated session and refuse sends while archived', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket!
      websocket.open?.(ws as never)
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', kind: 'chat', projectPath: os.tmpdir(), name: 'archive me' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const created = sent.find(message => message.type === 'session-created')
      if (created?.type !== 'session-created') throw new Error('Chat creation failed')
      const sessionId = created.session.id

      websocket.message?.(ws as never, JSON.stringify({ type: 'chat-archive', sessionId }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const archived = registryInstance.get(sessionId)
      expect(archived?.archivedAt).toBeTruthy()
      const update = sent.find(
        message => message.type === 'session-update' && message.session.id === sessionId && message.session.archivedAt
      )
      expect(update).toBeTruthy()

      // Sends while archived are refused with an archived error, and unknown
      // ids echo the unknown-session error.
      sent.length = 0
      websocket.message?.(ws as never, JSON.stringify({ type: 'chat-send', sessionId, text: 'hello' }))
      websocket.message?.(ws as never, JSON.stringify({ type: 'chat-archive', sessionId: 'chat-none' }))
      websocket.message?.(ws as never, JSON.stringify({ type: 'chat-restore', sessionId: 'chat-none' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent).toContainEqual({ type: 'error', message: 'This chat session is archived. Restore it to continue the conversation.' })
      expect(sent).toContainEqual({ type: 'error', message: 'Unknown chat session chat-none' })
      expect(sent.filter(message => message.type === 'error' && message.message === 'Unknown chat session chat-none')).toHaveLength(2)

      sent.length = 0
      websocket.message?.(ws as never, JSON.stringify({ type: 'chat-restore', sessionId }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(registryInstance.get(sessionId)?.archivedAt ?? null).toBeNull()
      expect(sent.some(
        message => message.type === 'session-update' && message.session.id === sessionId && !message.session.archivedAt
      )).toBe(true)

      websocket.message?.(ws as never, JSON.stringify({ type: 'session-kill', sessionId }))
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  test('chat rename accepts free text and refuses empty names and unknown sessions', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket!
      websocket.open?.(ws as never)
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', kind: 'chat', projectPath: os.tmpdir() }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const created = sent.find(message => message.type === 'session-created')
      if (created?.type !== 'session-created') throw new Error('Chat creation failed')
      const sessionId = created.session.id

      // Free text: spaces and punctuation the terminal `[\w-]+` rule rejects.
      sent.length = 0
      websocket.message?.(ws as never, JSON.stringify({
        type: 'session-rename',
        sessionId,
        newName: '  Claude Code Chat subscription usage metrics spec!  ',
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(registryInstance.get(sessionId)?.name).toBe(
        'Claude Code Chat subscription usage metrics spec!'
      )
      expect(registryInstance.get(sessionId)?.nameSource).toBe('manual')
      expect(sent.some(
        message => message.type === 'session-update'
          && message.session.id === sessionId
          && message.session.name === 'Claude Code Chat subscription usage metrics spec!'
          && message.session.nameSource === 'manual'
      )).toBe(true)

      // Empty after trimming is refused and leaves the name alone.
      sent.length = 0
      websocket.message?.(ws as never, JSON.stringify({
        type: 'session-rename',
        sessionId,
        newName: '   ',
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent).toContainEqual({ type: 'error', message: 'Name cannot be empty' })
      expect(registryInstance.get(sessionId)?.name).toBe(
        'Claude Code Chat subscription usage metrics spec!'
      )

      // Unknown sessions are refused — same error the terminal path gives,
      // before any chat-specific handling runs.
      sent.length = 0
      websocket.message?.(ws as never, JSON.stringify({
        type: 'session-rename',
        sessionId: 'chat-none',
        newName: 'whatever',
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent).toContainEqual({ type: 'error', message: 'Session not found' })

      websocket.message?.(ws as never, JSON.stringify({ type: 'session-kill', sessionId }))
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  test('chat creation for a missing project directory replies with an error', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket!
      websocket.open?.(ws as never)
      const before = registryInstance.getAll().length
      const missing = path.join(os.tmpdir(), 'agentboard-missing-chat-dir (deleted)')
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', kind: 'chat', projectPath: missing }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent).toContainEqual({ type: 'error', message: `Project directory does not exist: ${missing}` })
      expect(sent.some(message => message.type === 'session-created')).toBe(false)
      expect(registryInstance.getAll()).toHaveLength(before)
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  test('profile metadata routes and WS creation validate profile inputs', async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      const { serveOptions, registryInstance } = await loadIndex()
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket!
      // An existing directory, so the refusals below come from profile validation.
      const projectPath = os.tmpdir()
      const before = registryInstance.getAll().length
      for (const input of [
        { kind: 'terminal', claudeProfileId: 'glm' },
        { kind: 'chat', claudeProfileId: 'unknown' },
        { kind: 'chat', claudeProfileId: 'glm', env: { ANTHROPIC_API_KEY: 'forbidden' } },
      ]) {
        websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', projectPath, ...input }))
      }
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent.filter(message => message.type === 'error')).toHaveLength(3)
      expect(registryInstance.getAll()).toHaveLength(before)
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-create', kind: 'chat', projectPath, claudeProfileId: 'mimo' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const created = sent.find(message => message.type === 'session-created')
      if (created?.type !== 'session-created') throw new Error('Profile creation failed')
      expect(created.session.claudeProfileId).toBe('mimo')
      expect(JSON.stringify(created)).not.toContain('test-oauth-token')
      websocket.message?.(ws as never, JSON.stringify({ type: 'session-kill', sessionId: created.session.id }))
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
  test('websocket open sends sessions and registry broadcasts', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    expect(sent.find((message) => message.type === 'sessions')).toEqual({
      type: 'sessions',
      sessions: [baseSession],
    })
    expect(sent.find((message) => message.type === 'host-status')).toBeTruthy()
    expect(sent.find((message) => message.type === 'agent-sessions')).toMatchObject({
      type: 'agent-sessions',
    })

    const nextSession = { ...baseSession, id: 'session-2', name: 'beta' }
    registryInstance.emit('session-update', nextSession)
    registryInstance.emit('sessions', [baseSession, nextSession])

    const sessionUpdate = sent.find(
      (message) => message.type === 'session-update'
    )
    expect(sessionUpdate).toEqual({ type: 'session-update', session: nextSession })

    const sessionMessages = sent.filter((message) => message.type === 'sessions')
    expect(sessionMessages[1]).toEqual({
      type: 'sessions',
      sessions: [baseSession, nextSession],
    })
  })

  test('handles invalid payloads and unknown types', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(ws as never, 'not-json')
    websocket.message?.(ws as never, JSON.stringify({ type: 'unknown' }))
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'terminal-attach', sessionId: 'missing' })
    )

    expect(sent[0]).toEqual({
      type: 'error',
      message: 'Invalid message payload',
    })
    expect(sent[1]).toEqual({ type: 'error', message: 'Unknown message type' })
    expect(sent[2]).toEqual({
      type: 'terminal-error',
      sessionId: 'missing',
      code: 'ERR_INVALID_WINDOW',
      message: 'Session not found',
      retryable: false,
    })
  })

  test('validates workspace create-worktree messages', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    // Missing required fields.
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'create-worktree', branch: 'feat' })
    )
    // Relative destinations are rejected.
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'create-worktree',
        repositoryId: '/repo/.git',
        branch: 'feat',
        destination: 'repo-feat',
      })
    )
    // Invalid ref names are rejected.
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'create-worktree',
        repositoryId: '/repo/.git',
        branch: 'bad..name',
        destination: '/repo-feat',
      })
    )
    expect(sent.slice(0, 3)).toEqual([
      { type: 'error', message: 'Invalid create-worktree payload' },
      { type: 'error', message: 'Invalid create-worktree payload' },
      { type: 'error', message: 'Invalid create-worktree payload' },
    ])

    // A valid payload reaches the operation path and replies with an
    // operation result rather than a generic error.
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'create-worktree',
        repositoryId: '/repo/.git',
        branch: 'feat/x',
        destination: '/repo-feat',
      })
    )
    // The operation spawns git before replying; bounded-poll for the reply.
    await waitForSent(
      sent,
      (message) => message.type === 'workspace-operation-result',
      'create-worktree operation result'
    )
    const resultIndex = sent.findIndex(
      (message) => message.type === 'workspace-operation-result'
    )
    expect(
      sent.slice(resultIndex).some((message) => message.type === 'error')
    ).toBe(false)

    // workspace-refresh is recognized (no unknown-type error, no reply yet).
    const sentBefore = sent.length
    websocket.message?.(ws as never, JSON.stringify({ type: 'workspace-refresh' }))
    expect(sent.length).toBe(sentBefore)
  })

  test('workspace snapshots reach clients on connect, discovery, and removal', async () => {
    // Fake git plumbing for one repository at /wstest/repo on branch main.
    const repoCommonDir = '/wstest/repo/.git'
    spawnSyncImpl = ((command: string[], options?: { cwd?: string }) => {
      const cmd = Array.isArray(command) ? command : [String(command)]
      if (cmd[0] === 'git') {
        const gitArgs = cmd.slice(1).filter((arg) => arg !== '--git-dir')
        const cwd = options?.cwd ?? ''
        if (gitArgs.includes('rev-parse')) {
          if (cwd === '/wstest/repo' || cwd.startsWith('/wstest/repo/')) {
            return {
              exitCode: 0,
              stdout: Buffer.from([repoCommonDir, repoCommonDir, '/wstest/repo'].join('\n')),
              stderr: Buffer.from(''),
            }
          }
          return { exitCode: 128, stdout: Buffer.from(''), stderr: Buffer.from('not a repo') }
        }
        if (gitArgs.includes('worktree')) {
          return {
            exitCode: 0,
            stdout: Buffer.from(
              ['worktree /wstest/repo', 'HEAD aaa1111', 'branch refs/heads/main', ''].join('\n')
            ),
            stderr: Buffer.from(''),
          }
        }
        if (gitArgs.includes('for-each-ref')) {
          return { exitCode: 0, stdout: Buffer.from('aaa1111 main'), stderr: Buffer.from('') }
        }
        if (gitArgs.includes('status')) {
          return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
        }
      }
      if (cmd[0] === 'openspec') {
        return {
          exitCode: 1,
          stdout: Buffer.from(
            JSON.stringify({
              changes: [],
              root: null,
              status: [{ code: 'no_openspec_root' }],
            })
          ),
          stderr: Buffer.from(''),
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }) as unknown as typeof Bun.spawnSync

    const { serveOptions, registryInstance } = await loadIndex()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    // Initial connection: registry is empty, so the client receives the
    // (empty) workspace snapshot captured on open.
    const { ws: firstWs, sent: firstSent } = createWs()
    websocket.open?.(firstWs as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const initialSnapshot = firstSent.find(
      (message) => message.type === 'workspace-snapshot'
    )
    expect(initialSnapshot).toBeTruthy()
    if (initialSnapshot?.type === 'workspace-snapshot') {
      expect(initialSnapshot.snapshot.repositories).toEqual([])
    }

    // New repository discovery: a local session path seeds /wstest/repo.
    registryInstance.replaceSessions([
      { ...baseSession, id: 'ws-1', projectPath: '/wstest/repo' },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const discovered = firstSent
      .filter((message) => message.type === 'workspace-snapshot')
      .at(-1)
    expect(discovered).toBeTruthy()
    if (discovered?.type === 'workspace-snapshot') {
      expect(discovered.snapshot.repositories).toHaveLength(1)
      const repository = discovered.snapshot.repositories[0]
      expect(repository.id).toBe(repoCommonDir)
      expect(repository.worktrees[0].path).toBe('/wstest/repo')
      expect(repository.worktrees[0].branch).toBe('main')
      expect(repository.branches.map((branch) => branch.name)).toEqual(['main'])
    }

    // A newly connected client after discovery receives the latest snapshot.
    const { ws: secondWs, sent: secondSent } = createWs()
    websocket.open?.(secondWs as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const onConnect = secondSent.find(
      (message) => message.type === 'workspace-snapshot'
    )
    expect(onConnect).toBeTruthy()
    if (onConnect?.type === 'workspace-snapshot') {
      expect(onConnect.snapshot.repositories).toHaveLength(1)
    }

    // Path removal: the session disappears, so its repository is dropped.
    registryInstance.replaceSessions([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const afterRemoval = secondSent
      .filter((message) => message.type === 'workspace-snapshot')
      .at(-1)
    expect(afterRemoval).toBeTruthy()
    if (afterRemoval?.type === 'workspace-snapshot') {
      expect(afterRemoval.snapshot.repositories).toEqual([])
    }
  })

  test('refreshes sessions and creates new sessions', async () => {
    const createdSession = { ...baseSession, id: 'created', name: 'new' }
    let listCalls = 0
    sessionManagerState.listWindows = () => {
      listCalls += 1
      return [createdSession]
    }
    sessionManagerState.createWindow = () => createdSession

    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const refreshPayload = Buffer.from(
      JSON.stringify({ type: 'session-refresh' })
    )
    websocket.message?.(ws as never, refreshPayload)

    // 2 calls: startup logging + initial sync refresh
    // (message refresh uses async worker, not sessionManager.listWindows)
    expect(listCalls).toBe(2)
    expect(replaceSessionsCalls).toHaveLength(1)

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/tmp/new',
        name: 'new',
        command: 'claude',
      })
    )

    expect(sent.some((message) => message.type === 'session-created')).toBe(true)

    sessionManagerState.createWindow = () => {
      throw new Error('explode')
    }

    // Use an existing directory: a missing path now takes the stale-worktree
    // branch (§7.3) instead of surfacing the raw createWindow error.
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/tmp',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'explode',
    })
  })

  test('session-create at a worktree root passes the exact path and options through', async () => {
    // Task 7.2/7.3 contract: the contextual worktree action opens the normal
    // session form, so the handler must forward the exact project path plus
    // the existing session options (name, command) to createWindow.
    const createdSession = { ...baseSession, id: 'created-wt', name: 'worktree-agent' }
    const createCalls: Array<{ projectPath: string; name?: string; command?: string }> = []
    sessionManagerState.createWindow = (projectPath: string, name?: string, command?: string) => {
      createCalls.push({ projectPath, name, command })
      return createdSession
    }
    sessionManagerState.listWindows = () => [createdSession]

    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/repo/worktrees/feat-x',
        name: 'feat-x agent',
        command: 'claude --resume abc',
      })
    )

    expect(createCalls).toEqual([
      {
        projectPath: '/repo/worktrees/feat-x',
        name: 'feat-x agent',
        command: 'claude --resume abc',
      },
    ])
    expect(
      sent.find((message) => message.type === 'session-created')
    ).toBeTruthy()

    // Omitted optional fields stay undefined (no fabrication).
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/repo/main',
      })
    )
    expect(createCalls[1]).toEqual({ projectPath: '/repo/main', name: undefined, command: undefined })
  })

  /**
   * The async refresh chain awaits the worker promise and its own
   * setTimeout(0) yield before replacing the registry — one macrotask is
   * not enough for an externally-triggered refresh to fully settle.
   */
  async function settleRefresh() {
    for (let round = 0; round < 5; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  test('session-create composes the selected agent\'s apply prompt into the start command', async () => {
    // Launch-argument composition (replacing keystroke injection): the
    // create-session message carries the selected agent alongside the change
    // name, and the handler appends the mapped, shell-quoted apply command to
    // the start command before createWindow. An unrecognized agent or an
    // invalid change name starts the session unmodified, and no keystrokes
    // are ever delivered to the pane — not even at idle reports.
    const createdSession = { ...baseSession, id: 'auto-1', name: 'compose' }
    const createCalls: Array<{ projectPath: string; name?: string; command?: string }> = []
    sessionManagerState.createWindow = (projectPath: string, name?: string, command?: string) => {
      createCalls.push({ projectPath, name, command })
      return { ...createdSession, tmuxWindow: `agentboard:${createCalls.length}` }
    }
    sessionManagerState.listWindows = () => []
    const tmuxSendKeys: string[][] = []
    spawnSyncImpl = ((command: string[]) => {
      const cmd = Array.isArray(command) ? command : [String(command)]
      if (cmd[0] === 'tmux' && cmd.includes('send-keys')) {
        tmuxSendKeys.push(cmd)
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      }
    }) as unknown as typeof Bun.spawnSync

    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const sendCreate = (payload: Record<string, unknown>) =>
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'session-create',
          projectPath: '/repo/.worktrees/add-auth',
          ...payload,
        })
      )

    sendCreate({ command: 'claude', autoStartChange: 'add-auth', autoStartAgent: 'claude' })
    sendCreate({ command: 'codex --yolo', autoStartChange: 'add-auth', autoStartAgent: 'codex' })
    // An unrecognized agent composes nothing — the session still starts.
    sendCreate({ command: 'vim .', autoStartChange: 'add-auth', autoStartAgent: 'pi' })
    // An invalid change name composes nothing.
    sendCreate({ command: 'claude', autoStartChange: '../evil', autoStartAgent: 'claude' })
    // No agent selected: unmodified command.
    sendCreate({ command: 'claude', autoStartChange: 'add-auth' })

    expect(createCalls.map((call) => call.command)).toEqual([
      `claude '/opsx:apply add-auth'`,
      `codex --yolo '$openspec-apply-change add-auth'`,
      'vim .',
      'claude',
      'claude',
    ])
    expect(sent.filter((message) => message.type === 'session-created')).toHaveLength(5)

    // Idle reports never trigger keystroke delivery for the prompt anymore.
    refreshWorkerSessions = [{ ...createdSession, status: 'waiting' }]
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await settleRefresh()
    expect(tmuxSendKeys).toHaveLength(0)
  })

  test('session-create at a disappeared worktree rejects with an actionable error and refreshes workspace', async () => {
    // Task 7.3: the selected worktree vanished between discovery and
    // submission. The handler must reject with an error naming the stale
    // worktree and request a scoped workspace refresh of that exact path.
    const repoCommonDir = '/wstest/repo/.git'
    const revParseCwds: string[] = []
    spawnSyncImpl = ((command: string[], options?: { cwd?: string }) => {
      const cmd = Array.isArray(command) ? command : [String(command)]
      if (cmd[0] === 'git') {
        const gitArgs = cmd.slice(1).filter((arg) => arg !== '--git-dir')
        const cwd = options?.cwd ?? ''
        if (gitArgs.includes('rev-parse')) {
          revParseCwds.push(cwd)
          if (cwd === '/wstest/repo' || cwd.startsWith('/wstest/repo/')) {
            return {
              exitCode: 0,
              stdout: Buffer.from([repoCommonDir, repoCommonDir, '/wstest/repo'].join('\n')),
              stderr: Buffer.from(''),
            }
          }
          return { exitCode: 128, stdout: Buffer.from(''), stderr: Buffer.from('not a repo') }
        }
        if (gitArgs.includes('worktree')) {
          return {
            exitCode: 0,
            stdout: Buffer.from(
              ['worktree /wstest/repo', 'HEAD aaa1111', 'branch refs/heads/main', ''].join('\n')
            ),
            stderr: Buffer.from(''),
          }
        }
        if (gitArgs.includes('for-each-ref')) {
          return { exitCode: 0, stdout: Buffer.from('aaa1111 main'), stderr: Buffer.from('') }
        }
        if (gitArgs.includes('status')) {
          return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
        }
      }
      if (cmd[0] === 'openspec') {
        return {
          exitCode: 1,
          stdout: Buffer.from(
            JSON.stringify({
              changes: [],
              root: null,
              status: [{ code: 'no_openspec_root' }],
            })
          ),
          stderr: Buffer.from(''),
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }) as unknown as typeof Bun.spawnSync

    // Mimic the real SessionManager's missing-path rejection.
    sessionManagerState.createWindow = (projectPath: string) => {
      throw new Error(`Project path does not exist: ${projectPath}`)
    }

    const { serveOptions, registryInstance } = await loadIndex()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    // Seed discovery so the snapshot knows the /wstest/repo worktree.
    const { ws, sent } = createWs()
    websocket.open?.(ws as never)
    registryInstance.replaceSessions([
      { ...baseSession, id: 'ws-stale', projectPath: '/wstest/repo' },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    const revParseBefore = revParseCwds.length
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/wstest/repo/gone',
        name: 'stale-agent',
      })
    )

    // Rejected with the worktree-aware, actionable message; no session created.
    expect(sent.find((message) => message.type === 'session-created')).toBeUndefined()
    expect(sent.find((message) => message.type === 'error')).toMatchObject({
      type: 'error',
      message:
        'Worktree no longer exists: /wstest/repo. It may have been removed outside Agentboard; workspace metadata is refreshing.',
    })

    // A scoped workspace refresh of the missing path was requested (its seed
    // resolution re-runs git against exactly that directory).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revParseCwds.slice(revParseBefore)).toContain('/wstest/repo/gone')

    // A missing path outside any known worktree keeps the generic message.
    const sentBefore = sent.length
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/definitely/not/a/repo',
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Project path does not exist: /definitely/not/a/repo',
    })
    expect(sent.length).toBe(sentBefore + 1)
  })

  test('returns errors for kill and rename when sessions are missing', async () => {
    const externalSession = {
      ...baseSession,
      id: 'external',
      source: 'external' as const,
      tmuxWindow: 'work:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [externalSession]

    const killed: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killed.push(tmuxWindow)
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: 'missing' })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: 'external' })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId: 'missing',
        newName: 'rename',
      })
    )

    expect(sent[0]).toEqual({ type: 'kill-failed', sessionId: 'missing', message: 'Session not found' })
    // External sessions cannot be killed by default (requires ALLOW_KILL_EXTERNAL=true)
    expect(sent[1]).toEqual({ type: 'kill-failed', sessionId: 'external', message: 'Cannot kill external sessions' })
    expect(killed).toEqual([])
    expect(sent[2]).toEqual({ type: 'error', message: 'Session not found' })
  })

  test('handles kill and rename success paths', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const killed: string[] = []
    const renamed: Array<{ tmuxWindow: string; name: string }> = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killed.push(tmuxWindow)
    }
    sessionManagerState.renameWindow = (tmuxWindow: string, newName: string) => {
      renamed.push({ tmuxWindow, name: newName })
    }
    sessionManagerState.listWindows = () => [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId: baseSession.id,
        newName: 'renamed',
      })
    )

    expect(killed).toEqual([baseSession.tmuxWindow])
    expect(renamed).toEqual([
      { tmuxWindow: baseSession.tmuxWindow, name: 'renamed' },
    ])

    sessionManagerState.killWindow = () => {
      throw new Error('boom')
    }
    sessionManagerState.renameWindow = () => {
      throw new Error('nope')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId: baseSession.id,
        newName: 'later',
      })
    )

    expect(sent[sent.length - 2]).toEqual({ type: 'kill-failed', sessionId: baseSession.id, message: 'boom' })
    expect(sent[sent.length - 1]).toEqual({ type: 'error', message: 'nope' })
  })

  test('logs kill request source and connection context', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: 'agent-session-1', agentSessionName: 'alpha-agent' },
    ]
    sessionManagerState.killWindow = () => {}

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-kill',
        sessionId: baseSession.id,
        source: 'session_list_context_menu',
      })
    )

    const requested = logEntries.find((entry) => entry.event === 'session_kill_requested')
    const completed = logEntries.find((entry) => entry.event === 'session_kill_completed')

    expect(requested).toMatchObject({
      level: 'info',
      data: {
        requestedSessionId: baseSession.id,
        killSource: 'session_list_context_menu',
        connectionId: 'ws-test',
        remoteAddress: '127.0.0.1',
        userAgent: 'test-agent',
        sessionFound: true,
        tmuxWindow: baseSession.tmuxWindow,
        agentSessionId: 'agent-session-1',
        agentSessionName: 'alpha-agent',
      },
    })
    expect(completed).toMatchObject({
      level: 'info',
      data: {
        requestedSessionId: baseSession.id,
        killSource: 'session_list_context_menu',
        agentSessionIds: ['agent-session-1'],
      },
    })
  })

  test('intentional kill clears hibernation marker before killing and moves row to history', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const agentSessionId = 'kill-marked'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId, isPinned: true },
    ]
    seedRecord(
      makeRecord({
        sessionId: agentSessionId,
        currentWindow: baseSession.tmuxWindow,
        isPinned: true,
        lastActivityAt: new Date().toISOString(),
      })
    )

    let killedTarget: string | null = null
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      const recordAtKill = dbState.records.get(agentSessionId)
      expect(recordAtKill?.isPinned).toBe(false)
      expect(recordAtKill?.currentWindow).toBe(baseSession.tmuxWindow)
      killedTarget = tmuxWindow
    }

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )

    expect(killedTarget === baseSession.tmuxWindow).toBe(true)
    expect(dbState.records.get(agentSessionId)).toMatchObject({
      currentWindow: null,
      isPinned: false,
    })
    expect(registryInstance.agentSessions.hibernating).toEqual([])
    expect(registryInstance.agentSessions.history).toMatchObject([
      expect.objectContaining({
        sessionId: agentSessionId,
        isPinned: false,
      }),
    ])
  })

  test('intentional kill restores hibernation marker when tmux kill fails', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const agentSessionId = 'kill-marker-rollback'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId, isPinned: true },
    ]
    seedRecord(
      makeRecord({
        sessionId: agentSessionId,
        currentWindow: baseSession.tmuxWindow,
        isPinned: true,
      })
    )
    sessionManagerState.killWindow = () => {
      throw new Error('tmux kill failed')
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'kill-failed',
      sessionId: baseSession.id,
      message: 'tmux kill failed',
    })
    expect(dbState.records.get(agentSessionId)).toMatchObject({
      currentWindow: baseSession.tmuxWindow,
      isPinned: true,
    })
  })

  test('intentional kill restores prepared markers when database prep fails', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const staleAgentSessionId = 'kill-prep-stale'
    const windowAgentSessionId = 'kill-prep-window'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: staleAgentSessionId, isPinned: true },
    ]
    seedRecord(
      makeRecord({
        sessionId: staleAgentSessionId,
        logFilePath: '/tmp/kill-prep-stale.jsonl',
        currentWindow: null,
        isPinned: true,
      })
    )
    seedRecord(
      makeRecord({
        sessionId: windowAgentSessionId,
        logFilePath: '/tmp/kill-prep-window.jsonl',
        currentWindow: baseSession.tmuxWindow,
        isPinned: true,
      })
    )
    dbState.updateSessionError = (sessionId, patch) =>
      sessionId === windowAgentSessionId && patch.isPinned === false
        ? new Error('prep failed')
        : null
    let killCalled = false
    sessionManagerState.killWindow = () => {
      killCalled = true
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )

    expect(killCalled).toBe(false)
    expect(sent[sent.length - 1]).toEqual({
      type: 'kill-failed',
      sessionId: baseSession.id,
      message: 'prep failed',
    })
    expect(dbState.records.get(staleAgentSessionId)?.isPinned).toBe(true)
    expect(dbState.records.get(windowAgentSessionId)?.isPinned).toBe(true)
  })

  test('renames dormant agent sessions without requiring a tmux window', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const sessionId = 'dormant-rename'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'old-name',
        currentWindow: null,
        isPinned: true,
      })
    )

    const renamed: Array<{ tmuxWindow: string; name: string }> = []
    sessionManagerState.renameWindow = (tmuxWindow, newName) => {
      renamed.push({ tmuxWindow, name: newName })
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId,
        newName: '  renamed-dormant  ',
      })
    )

    expect(renamed).toEqual([])
    expect(dbState.records.get(sessionId)?.displayName).toBe('renamed-dormant')
    expect(registryInstance.agentSessions.hibernating).toMatchObject([
      expect.objectContaining({
        sessionId,
        displayName: 'renamed-dormant',
      }),
    ])
    expect(sent).toEqual([])

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId,
        newName: 'bad name!',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  })

  test('stale in-flight refresh does not resurrect killed session', async () => {
    const otherSession: Session = { ...baseSession, id: 'other', name: 'other', tmuxWindow: 'agentboard:2' }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]
    sessionManagerState.killWindow = () => {}
    // After kill, only otherSession should remain
    sessionManagerState.listWindows = () => [otherSession]

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    // 1. Start an async refresh BEFORE the kill — simulates the 2s periodic refresh
    refreshWorkerDeferred = true
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-refresh' })
    )
    const staleResolve = refreshWorkerResolve
    expect(staleResolve).not.toBeNull()

    // 2. Kill the session while the refresh is in flight
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: baseSession.id })
    )

    // After kill, registry should not contain the killed session
    const afterKill = replaceSessionsCalls[replaceSessionsCalls.length - 1] ?? []
    expect(afterKill.some((s: Session) => s.id === baseSession.id)).toBe(false)

    // 3. Resolve the stale worker result (includes the killed session).
    //    The generation guard should discard this and trigger a re-refresh.
    replaceSessionsCalls = []
    // Switch mock to immediate mode so the retry refresh completes
    refreshWorkerDeferred = false
    refreshWorkerSessions = [otherSession]
    staleResolve!([baseSession, otherSession])
    await new Promise((r) => setTimeout(r, 50))

    // Stale result must not have been applied — killed session must not reappear
    for (const call of replaceSessionsCalls) {
      expect(call.some((s: Session) => s.id === baseSession.id)).toBe(false)
    }
    // Re-refresh must have fired and applied fresh data
    expect(replaceSessionsCalls.length).toBeGreaterThan(0)
  })

  test('worker timeout skips sync fallback but allows the next refresh to recover', async () => {
    const freshSession: Session = {
      ...baseSession,
      id: 'fresh',
      name: 'fresh',
      tmuxWindow: 'agentboard:2',
    }
    let listCalls = 0
    sessionManagerState.listWindows = () => {
      listCalls += 1
      return [freshSession]
    }

    const settledVerifications = startupVerificationCount()
    const { serveOptions } = await loadIndex()
    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    await waitForStartupVerification(settledVerifications)
    const baselineReplaceCalls = replaceSessionsCalls.length
    refreshWorkerError = new SessionRefreshWorkerTimeoutErrorMock()
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(listCalls).toBe(2)
    expect(replaceSessionsCalls).toHaveLength(baselineReplaceCalls)
    expect(refreshWorkerExpectedWindowCounts[0]).toBe(1)

    refreshWorkerSessions = [freshSession]
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await waitForReplacedSessions(
      baselineReplaceCalls,
      (sessions) => sessions.length === 1 && sessions[0].id === freshSession.id,
      'the recovered refresh applying [freshSession]'
    )

    // N2: assert on the call the wait matched, not on whatever call happens
    // to be last — a concurrent path's late call must not move this.
    const applied = replaceSessionsCalls
      .slice(baselineReplaceCalls)
      .find((sessions) => sessions.length === 1 && sessions[0].id === freshSession.id)
    expect(applied).toEqual([freshSession])
    expect(refreshWorkerExpectedWindowCounts[1]).toBeGreaterThan(
      refreshWorkerExpectedWindowCounts[0] ?? 0
    )
  }, 15_000)

  test('session refresh ensures base session before worker snapshot', async () => {
    let ensureCalls = 0
    sessionManagerState.ensureSession = () => {
      ensureCalls += 1
      return { canPruneWsSessions: true }
    }

    const settledVerifications = startupVerificationCount()
    const { serveOptions } = await loadIndex()
    await waitForStartupVerification(settledVerifications)
    const startupEnsureCalls = ensureCalls
    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    refreshWorkerSessions = [baseSession]
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    // Wait for the live index's worker refresh (ensureSession runs before it),
    // not for any ensureSession growth a previous index's late work could add.
    const ensureStartedAt = Date.now()
    while (Date.now() - ensureStartedAt < 5000 && refreshWorkerExpectedWindowCounts.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(refreshWorkerExpectedWindowCounts.length).toBeGreaterThan(0)
    expect(ensureCalls).toBeGreaterThan(startupEnsureCalls)
    expect(refreshWorkerExpectedWindowCounts).toHaveLength(1)
  }, 15_000)

  test('last-user-message timeout does not poison the queued refresh', async () => {
    const refreshedSession: Session = {
      ...baseSession,
      status: 'working',
      name: 'refreshed',
    }

    const settledVerifications = startupVerificationCount()
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws } = createWs()
    ws.data.currentSessionId = baseSession.id
    ws.data.terminal = {
      write: () => {},
    } as never

    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    refreshWorkerSessions = [refreshedSession]
    lastUserMessageWorkerError = new SessionRefreshWorkerTimeoutErrorMock(
      'Session refresh worker timed out'
    )

    await waitForStartupVerification(settledVerifications)
    const baselineReplaceCalls = replaceSessionsCalls.length

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-input',
        sessionId: baseSession.id,
        data: '\r',
      })
    )

    await waitForReplacedSessions(
      baselineReplaceCalls,
      (sessions) => sessions.length === 1 && sessions[0].id === refreshedSession.id,
      'the queued refresh applying [refreshedSession]'
    )

    // N2: assert on the call the wait matched, not on whatever call happens
    // to be last — a concurrent path's late call must not move this.
    const applied = replaceSessionsCalls
      .slice(baselineReplaceCalls)
      .find((sessions) => sessions.length === 1 && sessions[0].id === refreshedSession.id)
    expect(applied).toEqual([refreshedSession])
  }, 15_000)

  test('startup sync timeout skips replacing sessions and leaves DB state intact', async () => {
    const activeRecord = makeRecord({
      sessionId: 'active-timeout',
      currentWindow: baseSession.tmuxWindow,
    })
    seedRecord(activeRecord)
    replaceSessionsCalls = []
    sessionManagerState.listWindows = () => {
      throw new TmuxTimeoutError('list-sessions', 3000)
    }

    const { registryInstance } = await loadIndex()
    await Promise.resolve()

    expect(replaceSessionsCalls).toHaveLength(0)
    expect(dbState.records.get(activeRecord.sessionId)?.currentWindow).toBe(
      baseSession.tmuxWindow
    )
    expect(registryInstance.agentSessions.active).toEqual([])
  })

  test('startup sync timeout seeds the first worker refresh budget from persisted active sessions', async () => {
    for (let i = 0; i < 5; i++) {
      seedRecord(makeRecord({
        sessionId: `seeded-${i}`,
        currentWindow: `agentboard:${i + 1}`,
      }))
    }
    sessionManagerState.listWindows = () => {
      throw new TmuxTimeoutError('list-sessions', 3000)
    }

    const { serveOptions } = await loadIndex()
    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    refreshWorkerExpectedWindowCounts = []
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(refreshWorkerExpectedWindowCounts[0]).toBe(5)
  })

  test('blocks remote kill when remoteAllowControl is false', async () => {
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: 'remote-1' })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'kill-failed',
      sessionId: 'remote-1',
      message: 'Remote sessions are read-only',
    })
  })

  test('kills remote session via SSH when remoteAllowControl is true', async () => {
    configState.remoteAllowControl = true
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: 'remote-1' })
    )
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const sshKillCall = sshCalls.find(
      (cmd) => cmd[0] === 'ssh' && cmd.some((a) => a.includes('kill-window'))
    )
    expect(sshKillCall).toBeTruthy()
    expect(sshKillCall).toContain('remote-host')
    // Session should be removed from registry
    expect(registryInstance.sessions.find((s) => s.id === 'remote-1')).toBeUndefined()
    // Should not send kill-failed
    expect(sent.find((m) => m.type === 'kill-failed')).toBeUndefined()
  })

  test('sends kill-failed when remote SSH kill fails', async () => {
    configState.remoteAllowControl = true
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]

    spawnSyncImpl = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('window not found'),
    })) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: 'remote-1' })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent[sent.length - 1]).toEqual({
      type: 'kill-failed',
      sessionId: 'remote-1',
      message: 'window not found',
    })
  })

  test('blocks remote rename when remoteAllowControl is false', async () => {
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-rename', sessionId: 'remote-1', newName: 'new-name' })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Remote sessions are read-only',
    })
  })

  test('renames remote session via SSH when remoteAllowControl is true', async () => {
    configState.remoteAllowControl = true
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-rename', sessionId: 'remote-1', newName: 'new-name' })
    )
    await new Promise((r) => setTimeout(r, 0))

    const sshRenameCall = sshCalls.find(
      (cmd) => cmd[0] === 'ssh' && cmd.some((a) => a.includes('rename-window'))
    )
    expect(sshRenameCall).toBeTruthy()
    expect(sshRenameCall).toContain('remote-host')
    // Should not send error
    expect(sent.find((m) => m.type === 'error')).toBeUndefined()
  })

  test('validates remote rename name format', async () => {
    configState.remoteAllowControl = true
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    // Empty name
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-rename', sessionId: 'remote-1', newName: '  ' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Name cannot be empty',
    })

    // Invalid characters
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-rename', sessionId: 'remote-1', newName: 'bad name!' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  })

  test('sends error when remote SSH rename fails', async () => {
    configState.remoteAllowControl = true
    const remoteSession: Session = {
      ...baseSession,
      id: 'remote-1',
      remote: true,
      host: 'remote-host',
      tmuxWindow: 'remote:1',
    }
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [remoteSession]

    spawnSyncImpl = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('rename failed'),
    })) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-rename', sessionId: 'remote-1', newName: 'valid-name' })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'rename failed',
    })
  })

  test('blocks remote session creation when remoteAllowControl is false', async () => {
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        host: 'remote-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Remote session creation is disabled',
    })
  })

  test('rejects remote create with invalid hostname', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        host: '-invalid-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Invalid hostname',
    })
  })

  test('rejects remote create when host is not in configured list', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['allowed-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        host: 'not-allowed-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Host is not in the configured remote hosts list',
    })
  })

  test('rejects remote create when path does not exist on remote', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()
    sessionManagerState.listWindows = () => []

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      // Fail the test -d check
      if (command[0] === 'ssh' && command.some((a) => typeof a === 'string' && a.includes('test -d'))) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/nonexistent/path',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Directory does not exist on remote-host: /nonexistent/path',
    })
  })

  test('rejects remote create with relative path', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: 'relative/path',
        host: 'remote-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Project path must be an absolute path (starting with /)',
    })
  })

  test('rejects remote create with ~ path', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '~/project',
        host: 'remote-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Project path must be an absolute path (starting with /)',
    })
  })

  test('rejects remote create with invalid name characters', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        name: 'bad name!',
        host: 'remote-host',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Name can only contain letters, numbers, hyphens, and underscores',
    })
  })

  test('creates remote session via new-window when tmux session exists', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      const cmdStr = command.join(' ')
      // has-session succeeds (session exists)
      // new-window -P -F returns window index and ID
      if (cmdStr.includes('new-window')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['1', '@5'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        name: 'test-name',
        command: 'claude',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    // Should have made SSH calls for: test -d, has-session, new-window
    const sshCommands = sshCalls.filter((cmd) => cmd[0] === 'ssh')
    expect(sshCommands.length).toBeGreaterThanOrEqual(3)

    // new-window call should include -P flag for print
    const newWindowCall = sshCalls.find((cmd) => cmd.some((a) => typeof a === 'string' && a.includes('new-window')))
    expect(newWindowCall).toBeTruthy()
    expect(newWindowCall!.some((a) => typeof a === 'string' && a.includes('tmux -u new-window'))).toBe(true)
    expect(newWindowCall!.some((a) => typeof a === 'string' && a.includes('-P'))).toBe(true)

    // Should have sent session-created
    const createdMsg = sent.find((m) => m.type === 'session-created')
    expect(createdMsg).toBeTruthy()
    if (createdMsg && createdMsg.type === 'session-created') {
      expect(createdMsg.session.host).toBe('remote-host')
      expect(createdMsg.session.remote).toBe(true)
      expect(createdMsg.session.projectPath).toBe('/home/user/project')
      expect(createdMsg.session.name).toBe('test-name')
      expect(createdMsg.session.id).toBe('remote:remote-host:agentboard:@5')
      // tmuxWindow should use stable windowId
      expect(createdMsg.session.tmuxWindow).toBe('agentboard:@5')
    }

    // Session should be in registry
    expect(registryInstance.sessions.some((s) => s.remote && s.host === 'remote-host')).toBe(true)
  })

  test('remote session-create receives the composed apply command', async () => {
    // The same launch-argument composition as the local path: the remote
    // handler appends the quoted apply prompt to the window command before
    // the bash -lic wrapping, so the first prompt rides in the remote start
    // command rather than a pending-prompt store.
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      const cmdStr = command.join(' ')
      if (cmdStr.includes('new-window')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['1', '@5'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        command: 'claude',
        host: 'remote-host',
        autoStartChange: 'add-auth',
        autoStartAgent: 'claude',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent.some((m) => m.type === 'session-created')).toBe(true)
    const newWindowCall = sshCalls.find(
      (cmd) => cmd[0] === 'ssh' && cmd.some((a) => typeof a === 'string' && a.includes('new-window'))
    )
    expect(newWindowCall).toBeTruthy()
    // The window command argument carries the login-shell wrapper around the
    // composed prompt. runRemoteTmux re-quotes each tmux arg for ssh, so
    // assert on the prompt text itself, which contains no quote characters.
    const windowCommandArg = newWindowCall!.find(
      (a) => typeof a === 'string' && a.includes('/opsx:apply add-auth')
    )
    expect(windowCommandArg).toBeTruthy()
    expect(windowCommandArg).toContain('bash -lic')
  })

  test('sends error when created remote window exits immediately', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      const cmdStr = command.join(' ')
      if (cmdStr.includes('new-window')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['1', '@5'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      // Verify check fails for the new window target (window was created then exited)
      if (cmdStr.includes('has-session') && cmdStr.includes('agentboard:@5')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from("can't find window: @5\n"),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        command: 'bash -lic bash',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent.some((m) => m.type === 'session-created')).toBe(false)
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Remote window exited immediately on remote-host'),
    })
    expect(registryInstance.sessions.some((s) => s.id === 'remote:remote-host:agentboard:@5')).toBe(false)

    // Ensure we attempted to verify the created window target
    expect(sshCalls.some((cmd) => cmd.join(' ').includes('has-session') && cmd.join(' ').includes('agentboard:@5'))).toBe(true)
  })

  test('creates remote session via new-session when tmux session does not exist', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []

    const sshCalls: string[][] = []
    let sessionCreated = false
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      sshCalls.push(command as string[])
      const cmdStr = command.join(' ')
      // has-session fails before new-session, succeeds after (verify check)
      if (cmdStr.includes('has-session')) {
        return {
          exitCode: sessionCreated ? 0 : 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      // new-session -P -F returns window index 0 and ID
      if (cmdStr.includes('new-session')) {
        sessionCreated = true
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['0', '@1'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        name: 'my-session',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    // Should NOT have called new-window (used new-session instead)
    const newWindowCall = sshCalls.find((cmd) => cmd.some((a) => typeof a === 'string' && a.includes('new-window')))
    expect(newWindowCall).toBeFalsy()

    // new-session call should include -P and -d flags
    const newSessionCall = sshCalls.find((cmd) => cmd.some((a) => typeof a === 'string' && a.includes('new-session')))
    expect(newSessionCall).toBeTruthy()
    expect(newSessionCall!.some((a) => typeof a === 'string' && a.includes('tmux -u new-session'))).toBe(true)
    expect(newSessionCall!.some((a) => typeof a === 'string' && a.includes('-P'))).toBe(true)

    // Should have sent session-created with window at index 0
    const createdMsg = sent.find((m) => m.type === 'session-created')
    expect(createdMsg).toBeTruthy()
    if (createdMsg && createdMsg.type === 'session-created') {
      expect(createdMsg.session.host).toBe('remote-host')
      expect(createdMsg.session.remote).toBe(true)
      expect(createdMsg.session.name).toBe('my-session')
      expect(createdMsg.session.id).toBe('remote:remote-host:agentboard:@1')
      // tmuxWindow should use stable windowId
      expect(createdMsg.session.tmuxWindow).toBe('agentboard:@1')
    }

    expect(registryInstance.sessions.some((s) => s.remote && s.host === 'remote-host')).toBe(true)
  })

  test('does not drop optimistically created remote session on refresh before poller updates', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const settledVerifications = startupVerificationCount()
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      if (cmdStr.includes('new-window')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['1', '@5'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        name: 'test-name',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    const createdId = 'remote:remote-host:agentboard:@5'
    expect(registryInstance.sessions.some((s) => s.id === createdId)).toBe(true)

    await waitForStartupVerification(settledVerifications)
    const baselineReplaceCalls = replaceSessionsCalls.length
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))

    await waitForReplacedSessions(
      baselineReplaceCalls,
      (sessions) => sessions.some((s) => s.id === createdId),
      'the refresh preserving the created remote session'
    )

    expect(registryInstance.sessions.some((s) => s.id === createdId)).toBe(true)
  }, 15_000)

  test('remote kill is not resurrected by stale poller snapshot on next refresh', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']

    const nowSeconds = Math.floor(Date.now() / 1000)
    const listWindowsLine =
      `agentboard\t1\t@5\told-name\t/home/user/project\t${nowSeconds}\t${nowSeconds}\tclaude\n`

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      if (cmdStr.includes('list-windows')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(listWindowsLine),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const settledVerifications = startupVerificationCount()
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []
    await new Promise((r) => setTimeout(r, 0)) // allow initial remote poll to populate snapshot

    const remoteSession: Session = {
      id: 'remote:remote-host:agentboard:@5',
      name: 'old-name',
      tmuxWindow: 'agentboard:@5',
      projectPath: '/home/user/project',
      status: 'unknown',
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      source: 'managed',
      host: 'remote-host',
      remote: true,
      command: 'claude',
    }
    registryInstance.sessions = [remoteSession]

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-kill', sessionId: remoteSession.id })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(registryInstance.sessions.some((s) => s.id === remoteSession.id)).toBe(
      false
    )

    await waitForStartupVerification(settledVerifications)
    const baselineReplaceCalls = replaceSessionsCalls.length
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await waitForReplacedSessions(
      baselineReplaceCalls,
      (sessions) => !sessions.some((s) => s.id === remoteSession.id),
      'the refresh keeping the killed remote session gone'
    )

    expect(registryInstance.sessions.some((s) => s.id === remoteSession.id)).toBe(
      false
    )
  }, 15_000)

  test('remote rename is not reverted by stale poller snapshot on next refresh', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']

    const nowSeconds = Math.floor(Date.now() / 1000)
    const listWindowsLine =
      `agentboard\t1\t@5\told-name\t/home/user/project\t${nowSeconds}\t${nowSeconds}\tclaude\n`

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      if (cmdStr.includes('list-windows')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(listWindowsLine),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const settledVerifications = startupVerificationCount()
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []
    await new Promise((r) => setTimeout(r, 0))

    const remoteSession: Session = {
      id: 'remote:remote-host:agentboard:@5',
      name: 'old-name',
      tmuxWindow: 'agentboard:@5',
      projectPath: '/home/user/project',
      status: 'unknown',
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      source: 'managed',
      host: 'remote-host',
      remote: true,
      command: 'claude',
    }
    registryInstance.sessions = [remoteSession]

    const { ws } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-rename',
        sessionId: remoteSession.id,
        newName: 'new-name',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(registryInstance.get(remoteSession.id)?.name).toBe('new-name')

    await waitForStartupVerification(settledVerifications)
    const baselineReplaceCalls = replaceSessionsCalls.length
    websocket.message?.(ws as never, JSON.stringify({ type: 'session-refresh' }))
    await waitForReplacedSessions(
      baselineReplaceCalls,
      (sessions) =>
        sessions.some((s) => s.id === remoteSession.id && s.name === 'new-name'),
      'the refresh keeping the renamed remote session'
    )

    expect(registryInstance.get(remoteSession.id)?.name).toBe('new-name')
  }, 15_000)

  test('sends error when remote new-window fails', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()
    sessionManagerState.listWindows = () => []

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      // has-session succeeds, but new-window fails
      if (cmdStr.includes('new-window')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('create window failed'),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Failed to create remote window: create window failed',
    })
  })

  test('sends error when remote new-session fails (no existing session)', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions } = await loadIndex()
    sessionManagerState.listWindows = () => []

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      // has-session fails (no existing session)
      if (cmdStr.includes('has-session')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      // new-session also fails
      if (cmdStr.includes('new-session')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('session create failed'),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'Failed to create remote window: session create failed',
    })
  })

  test('sends error when remote command exits immediately after creation', async () => {
    configState.remoteAllowControl = true
    configState.remoteHosts = ['remote-host']
    const { serveOptions, registryInstance } = await loadIndex()
    sessionManagerState.listWindows = () => []

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const cmdStr = command.join(' ')
      // new-session succeeds (tmux returns output) but session dies immediately
      if (cmdStr.includes('new-session') && cmdStr.includes('-P')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxOutput(['0', '@1'])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      // All has-session calls fail (session never persists)
      if (cmdStr.includes('has-session')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) throw new Error('WebSocket handlers not configured')

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/home/user/project',
        command: 'nonexistent-shell',
        host: 'remote-host',
      })
    )
    await new Promise((r) => setTimeout(r, 0))

    // Should NOT have added session to registry
    expect(registryInstance.sessions.some((s) => s.remote && s.host === 'remote-host')).toBe(false)

    // Should have sent a helpful error
    const errorMsg = sent[sent.length - 1]
    expect(errorMsg.type).toBe('error')
    if (errorMsg.type === 'error') {
      expect(errorMsg.message).toContain('nonexistent-shell')
      expect(errorMsg.message).toContain('remote-host')
    }
  })

  test('attaches terminals and forwards input/output', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.open?.(ws as never)

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-attach',
        sessionId: baseSession.id,
        tmuxTarget: baseSession.tmuxWindow,
      })
    )

    // Wait for async attach operations to complete (two ticks: one for
    // attachTerminalPersistent, one for the post-history yield that flushes WS buffers)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const attached = ws.data.terminal
    if (!attached) {
      throw new Error('Expected terminal to be created')
    }

    expect(attached.starts).toBe(1)
    expect(attached.switchTargets).toEqual([baseSession.tmuxWindow])
    expect(ws.data.currentSessionId).toBe(baseSession.id)
    expect(
      sent.some(
        (message) =>
          message.type === 'terminal-ready' &&
          message.sessionId === baseSession.id
      )
    ).toBe(true)

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-input',
        sessionId: baseSession.id,
        data: 'ls',
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-paste',
        sessionId: baseSession.id,
        data: 'pasted\nmultiline',
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-resize',
        sessionId: baseSession.id,
        cols: 120,
        rows: 40,
      })
    )

    // Typed input goes to write(); pasted text goes to paste() (bracketed via
    // tmux) and must not leak into the raw keystroke path.
    expect(attached?.writes).toEqual(['ls'])
    expect(attached?.pastes).toEqual(['pasted\nmultiline'])
    expect(attached?.resizes).toEqual([{ cols: 120, rows: 40 }])

    attached?.emitData('output')
    // Output frames flush on the coalescer's turn timer — await the frame.
    await waitForSent(
      sent,
      (message) =>
        message.type === 'terminal-output' &&
        message.sessionId === baseSession.id &&
        message.data === 'output',
      'terminal-output frame after emitData'
    )

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'terminal-detach', sessionId: baseSession.id })
    )
    expect(ws.data.currentSessionId).toBe(null)
    expect(attached?.disposed).toBe(false)

    const outputCount = sent.filter(
      (message) => message.type === 'terminal-output'
    ).length
    attached?.emitData('ignored')
    const outputCountAfter = sent.filter(
      (message) => message.type === 'terminal-output'
    ).length
    expect(outputCountAfter).toBe(outputCount)
  })

  test('offers changed tmux paste buffer for the active local terminal', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    let intervalCallback: (() => void) | null = null
    const originalSetIntervalForTest = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void
      return 123 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval

    // Buffer creation times are real unix seconds: an offer requires the buffer
    // to have been created at/after the arming gesture.
    const nowSec = Math.floor(Date.now() / 1000)
    let bufferCreated = nowSec - 10
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-buffers') {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxLine('buffer0', String(bufferCreated), '18') + '\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'show-buffer') {
        return {
          exitCode: 0,
          stdout: Buffer.from('copied-from-tmux'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'capture-pane') {
        return {
          exitCode: 0,
          stdout: Buffer.from('visible pane line\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket
      if (!websocket) {
        throw new Error('WebSocket handlers not configured')
      }

      websocket.open?.(ws as never)
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-attach',
          sessionId: baseSession.id,
          tmuxTarget: baseSession.tmuxWindow,
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      const pollClipboard = intervalCallback as (() => void) | null
      if (!pollClipboard) {
        throw new Error('Expected clipboard poll interval')
      }
      expect(
        sent.some((message) => message.type === 'clipboard-offer')
      ).toBe(false)

      // Unarmed buffer change: watermarked, not offered.
      bufferCreated = nowSec - 5
      pollClipboard()
      await new Promise((r) => setTimeout(r, 0))
      expect(
        sent.some((message) => message.type === 'clipboard-offer')
      ).toBe(false)

      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-input',
          sessionId: baseSession.id,
          data: '\x1b[<0;10;4M\x1b[<32;11;4M\x1b[<0;11;4m',
        })
      )
      // Buffer created after the arming gesture: offered.
      bufferCreated = nowSec + 30
      pollClipboard()
      await new Promise((r) => setTimeout(r, 0))
      expect(sent).toContainEqual({
        type: 'clipboard-offer',
        sessionId: baseSession.id,
        text: 'copied-from-tmux',
        source: 'tmux-buffer',
      })

      const offerCount = sent.filter((message) => message.type === 'clipboard-offer').length
      bufferCreated = nowSec + 31
      pollClipboard()
      await new Promise((r) => setTimeout(r, 0))
      expect(sent.filter((message) => message.type === 'clipboard-offer')).toHaveLength(offerCount)
    } finally {
      globalThis.setInterval = originalSetIntervalForTest
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('arms on a click-only selection (double/triple-click, no drag) and offers the copy', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    let intervalCallback: (() => void) | null = null
    const originalSetIntervalForTest = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void
      return 123 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval

    const nowSec = Math.floor(Date.now() / 1000)
    let bufferCreated = nowSec - 10
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-buffers') {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxLine('buffer0', String(bufferCreated), '18') + '\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'show-buffer') {
        return {
          exitCode: 0,
          stdout: Buffer.from('word-from-double-click'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket
      if (!websocket) {
        throw new Error('WebSocket handlers not configured')
      }

      websocket.open?.(ws as never)
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-attach',
          sessionId: baseSession.id,
          tmuxTarget: baseSession.tmuxWindow,
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      const pollClipboard = intervalCallback as (() => void) | null
      if (!pollClipboard) {
        throw new Error('Expected clipboard poll interval')
      }

      // Double-click word selection: left-button press + release with NO motion
      // bit (button 32). This must still arm — it's a real selection that copies.
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-input',
          sessionId: baseSession.id,
          data: '\x1b[<0;10;4M\x1b[<0;10;4m',
        })
      )
      bufferCreated = nowSec + 30
      pollClipboard()
      await new Promise((r) => setTimeout(r, 0))

      expect(sent).toContainEqual({
        type: 'clipboard-offer',
        sessionId: baseSession.id,
        text: 'word-from-double-click',
        source: 'tmux-buffer',
      })
    } finally {
      globalThis.setInterval = originalSetIntervalForTest
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('does not offer a buffer created before the arming gesture', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    let intervalCallback: (() => void) | null = null
    const originalSetIntervalForTest = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void
      return 123 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval

    const nowSec = Math.floor(Date.now() / 1000)
    let bufferCreated = nowSec
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-buffers') {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxLine('buffer0', String(bufferCreated), '18') + '\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'show-buffer') {
        return {
          exitCode: 0,
          stdout: Buffer.from('stale-unrelated-buffer'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket
      if (!websocket) {
        throw new Error('WebSocket handlers not configured')
      }

      websocket.open?.(ws as never)
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-attach',
          sessionId: baseSession.id,
          tmuxTarget: baseSession.tmuxWindow,
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      const pollClipboard = intervalCallback as (() => void) | null
      if (!pollClipboard) {
        throw new Error('Expected clipboard poll interval')
      }

      // Arm via a drag selection.
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-input',
          sessionId: baseSession.id,
          data: '\x1b[<0;10;4M\x1b[<32;11;4M\x1b[<0;11;4m',
        })
      )
      // A different buffer becomes "latest" but was created well before the
      // gesture (e.g. an unrelated copy in another window). It must NOT be
      // offered, even though the watch is armed.
      bufferCreated = nowSec - 100
      pollClipboard()
      await new Promise((r) => setTimeout(r, 0))

      expect(sent.some((message) => message.type === 'clipboard-offer')).toBe(false)
    } finally {
      globalThis.setInterval = originalSetIntervalForTest
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('a poll from a superseded watch generation is inert after re-attach', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const intervalCallbacks: Array<() => void> = []
    const originalSetIntervalForTest = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallbacks.push(callback as () => void)
      return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval

    const nowSec = Math.floor(Date.now() / 1000)
    let bufferCreated = nowSec - 10
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-buffers') {
        return {
          exitCode: 0,
          stdout: Buffer.from(tmuxLine('buffer0', String(bufferCreated), '18') + '\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'show-buffer') {
        return {
          exitCode: 0,
          stdout: Buffer.from('fresh-copy'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const { ws, sent } = createWs()
      const websocket = serveOptions.websocket
      if (!websocket) {
        throw new Error('WebSocket handlers not configured')
      }

      websocket.open?.(ws as never)
      // First attach establishes watch generation N.
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-attach',
          sessionId: baseSession.id,
          tmuxTarget: baseSession.tmuxWindow,
        })
      )
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      // Re-attach supersedes it with generation N+1 (and a fresh poll closure).
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-attach',
          sessionId: baseSession.id,
          tmuxTarget: baseSession.tmuxWindow,
        })
      )
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      expect(intervalCallbacks.length).toBeGreaterThanOrEqual(2)
      const stalePoll = intervalCallbacks[0]
      const freshPoll = intervalCallbacks[intervalCallbacks.length - 1]

      // Arm and produce a post-gesture buffer.
      websocket.message?.(
        ws as never,
        JSON.stringify({
          type: 'terminal-input',
          sessionId: baseSession.id,
          data: '\x1b[<0;10;4M\x1b[<32;11;4M\x1b[<0;11;4m',
        })
      )
      bufferCreated = nowSec + 30

      // The poll closure from the superseded generation must do nothing.
      stalePoll()
      await new Promise((r) => setTimeout(r, 0))
      expect(sent.some((message) => message.type === 'clipboard-offer')).toBe(false)

      // The current-generation poll delivers the offer.
      freshPoll()
      await new Promise((r) => setTimeout(r, 0))
      expect(sent.some((message) => message.type === 'clipboard-offer')).toBe(true)
    } finally {
      globalThis.setInterval = originalSetIntervalForTest
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('session-only attach replays the current grouped view and keeps copy-mode targeting aligned in pty mode', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    let captureTarget = ''
    let captureArgs: string[] = []
    let captureOptions: Parameters<typeof Bun.spawnSync>[1] | undefined
    let captureUsesUtf8 = false
    let copyModeTarget = ''
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'capture-pane') {
        captureArgs = tmuxArgs
        captureUsesUtf8 = command[1] === '-u'
        captureTarget = tmuxArgs[2] ?? ''
        captureOptions = args[1]
      }
      if (tmuxArgs[0] === 'display-message') {
        copyModeTarget = tmuxArgs[3] ?? ''
        // Format: pane_in_mode,alternate_on,mouse_any_flag — here: a fullscreen app
        // (not in copy-mode, alt screen on, app owns the mouse).
        return {
          exitCode: 0,
          stdout: Buffer.from('0,1,1\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout:
          tmuxArgs[0] === 'capture-pane'
            ? Buffer.from('visible pane 你好 🚀\n')
            : Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    websocket.open?.(ws as never)
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-attach',
        sessionId: baseSession.id,
        tmuxTarget: 'agentboard',
      })
    )

    await new Promise((r) => setTimeout(r, 0))

    const attached = ws.data.terminal
    if (!attached) {
      throw new Error('Expected terminal to be created')
    }

    const groupedTarget = `${configState.tmuxSession}-ws-${ws.data.connectionId}`
    expect(attached.switchTargets).toEqual(['agentboard'])
    expect(captureTarget).toBe(groupedTarget)
    expect(captureArgs[0]).toBe('capture-pane')
    expect(captureUsesUtf8).toBe(true)
    expect(captureArgs).toContain('-e')
    expect(captureOptions?.timeout).toBe(configState.tmuxTimeoutMs)
    // History chunks flush on the coalescer's turn timer — await the frame.
    await waitForSent(
      sent,
      (message) =>
        message.type === 'terminal-output' &&
        message.sessionId === baseSession.id &&
        message.data === 'visible pane 你好 🚀\r\n',
      'coalesced history frame'
    )
    const historyIndex = sent.findIndex(
      (message) =>
        message.type === 'terminal-output' &&
        message.sessionId === baseSession.id &&
        message.data === 'visible pane 你好 🚀\r\n'
    )
    expect(historyIndex).toBeGreaterThanOrEqual(0)
    expect(ws.data.currentTmuxTarget).toBe(groupedTarget)

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'tmux-check-copy-mode', sessionId: baseSession.id })
    )
    expect(copyModeTarget).toBe(groupedTarget)

    // The reply arrives asynchronously (async spawn) — await it.
    await waitForSent(
      sent,
      (message) => message.type === 'tmux-copy-mode-status',
      'copy-mode status reply'
    )
    // The fullscreen flags from tmux propagate to the client (appMouse drives the
    // client's decision to stop hijacking mouse events into copy-mode).
    const fullscreenStatus = sent.find(
      (message) => message.type === 'tmux-copy-mode-status'
    )
    expect(fullscreenStatus).toMatchObject({
      inCopyMode: false,
      altScreen: true,
      appMouse: true,
    })
  })

  test('terminal attach continues when local history capture times out', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    let captureTimeout: number | undefined
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      if (getTmuxArgs(command as string[])[0] === 'capture-pane') {
        captureTimeout = args[1]?.timeout
        return {
          exitCode: null,
          signalCode: 'SIGTERM',
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as unknown as ReturnType<typeof Bun.spawnSync>
      }

      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    websocket.open?.(ws as never)
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-attach',
        sessionId: baseSession.id,
        tmuxTarget: baseSession.tmuxWindow,
      })
    )

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const attached = ws.data.terminal
    if (!attached) {
      throw new Error('Expected terminal to be created')
    }

    expect(captureTimeout).toBe(configState.tmuxTimeoutMs)
    expect(ws.data.currentSessionId).toBe(baseSession.id)
    expect(
      sent.some(
        (message) =>
          message.type === 'terminal-ready' &&
          message.sessionId === baseSession.id
      )
    ).toBe(true)
    expect(
      sent.some(
        (message) =>
          message.type === 'terminal-output' &&
          message.sessionId === baseSession.id
      )
    ).toBe(false)
  })

  test('validates tmux target on terminal attach', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-attach',
        sessionId: baseSession.id,
        tmuxTarget: 'bad target',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'terminal-error',
      sessionId: baseSession.id,
      code: 'ERR_INVALID_WINDOW',
      message: 'Invalid tmux target',
      retryable: false,
    })
  })

  test('handles copy-mode commands for active session', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    ws.data.currentSessionId = baseSession.id
    ws.data.currentTmuxTarget = 'agentboard:1.1'

    let sendKeysTarget = ''
    let displayTarget = ''
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'send-keys') {
        sendKeysTarget = tmuxArgs[3] ?? ''
      }
      if (tmuxArgs[0] === 'display-message') {
        displayTarget = tmuxArgs[3] ?? ''
        // Format: pane_in_mode,alternate_on,mouse_any_flag — classic copy-mode here.
        return {
          exitCode: 0,
          stdout: Buffer.from('1,0,0\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    // The copy-mode reply is discarded unless the socket is open/registered —
    // stale-reply discard checks sockets membership, so simulate the open.
    websocket.open?.(ws as never)

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'tmux-cancel-copy-mode', sessionId: baseSession.id })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'tmux-check-copy-mode', sessionId: baseSession.id })
    )

    expect(sendKeysTarget).toBe('agentboard:1.1')
    expect(displayTarget).toBe('agentboard:1.1')

    // The status reply arrives asynchronously (async spawn) — await it.
    await waitForSent(
      sent,
      (message) => message.type === 'tmux-copy-mode-status',
      'copy-mode status reply'
    )
    const statusMessage = sent.find(
      (message) => message.type === 'tmux-copy-mode-status'
    )
    expect(statusMessage).toEqual({
      type: 'tmux-copy-mode-status',
      sessionId: baseSession.id,
      inCopyMode: true,
      altScreen: false,
      appMouse: false,
    })
  })

  test('moves hibernating sessions to history and rejects active sessions', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: baseSession.id, isPinned: true },
    ]
    const hibernatingId = 'hibernating-history'
    seedRecord(
      makeRecord({
        sessionId: baseSession.id,
        currentWindow: baseSession.tmuxWindow,
        isPinned: true,
      })
    )
    seedRecord(
      makeRecord({
        sessionId: hibernatingId,
        currentWindow: null,
        isPinned: true,
      })
    )

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-move-to-history',
        sessionId: 'bad id',
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-move-to-history-result',
      sessionId: 'bad id',
      ok: false,
      error: 'Invalid session id',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-move-to-history',
        sessionId: 'missing',
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-move-to-history-result',
      sessionId: 'missing',
      ok: false,
      error: 'Session not found',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-move-to-history',
        sessionId: baseSession.id,
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-move-to-history-result',
      sessionId: baseSession.id,
      ok: false,
      error: 'Session is active',
    })
    expect(dbState.setPinnedCalls).toEqual([])
    expect(dbState.records.get(baseSession.id)?.isPinned).toBe(true)
    expect(registryInstance.sessions[0]?.isPinned).toBe(true)

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-move-to-history',
        sessionId: hibernatingId,
      })
    )
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-move-to-history-result',
      sessionId: hibernatingId,
      ok: true,
    })
    expect(dbState.setPinnedCalls).toEqual([
      { sessionId: hibernatingId, isPinned: false },
    ])
    expect(dbState.records.get(hibernatingId)?.isPinned).toBe(false)
  })

  test('validates session hibernate errors', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: 'bad id' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-hibernate-result',
      sessionId: 'bad id',
      ok: false,
      error: 'Invalid session id',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: 'missing' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-hibernate-result',
      sessionId: 'missing',
      ok: false,
      error: 'Session not found',
    })

    // Truly history-only (never hibernating) should still error — only already-hibernating
    // gets the idempotent ack below.
    seedRecord(
      makeRecord({
        sessionId: 'truly-history',
        currentWindow: null,
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: 'truly-history' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-hibernate-result',
      sessionId: 'truly-history',
      ok: false,
      error: 'Session is not active',
    })
  })

  test('hibernate is idempotent for already-hibernating sessions', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    seedRecord(
      makeRecord({
        sessionId: 'already-hibernating',
        currentWindow: null,
        isPinned: true,
      })
    )

    let killCalled = false
    sessionManagerState.killWindow = () => {
      killCalled = true
    }
    const updateCallsBefore = dbState.updateCalls.length

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: 'already-hibernating' })
    )

    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-hibernate-result',
      sessionId: 'already-hibernating',
      ok: true,
      session: expect.objectContaining({
        sessionId: 'already-hibernating',
        isPinned: true,
        isActive: false,
      }),
    })
    // No side effects — shouldn't try to kill anything or touch the DB.
    expect(killCalled).toBe(false)
    expect(dbState.updateCalls.length).toBe(updateCallsBefore)
  })

  test('hibernates active sessions and moves them into the hibernating bucket', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'hibernate-ok'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: liveAgentSessionId },
    ]
    seedRecord(
      makeRecord({
        sessionId: liveAgentSessionId,
        currentWindow: baseSession.tmuxWindow,
      })
    )

    let killedTarget: string | null = null
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      const recordAtKill = dbState.records.get(liveAgentSessionId)
      expect(recordAtKill?.isPinned).toBe(true)
      expect(recordAtKill?.currentWindow).toBe(baseSession.tmuxWindow)
      killedTarget = tmuxWindow
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: liveAgentSessionId })
    )

    if (!killedTarget) {
      throw new Error('Expected killWindow to be called')
    }
    const killTarget = killedTarget
    expect(killTarget === baseSession.tmuxWindow).toBe(true)
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-hibernate-result',
      sessionId: liveAgentSessionId,
      ok: true,
      session: expect.objectContaining({
        sessionId: liveAgentSessionId,
        isPinned: true,
        isActive: false,
      }),
    })
    expect(dbState.updateCalls.at(-1)?.patch).toMatchObject({
      currentWindow: null,
      isPinned: true,
    })
    expect(registryInstance.sessions).toEqual([])
    expect(registryInstance.agentSessions.hibernating).toMatchObject([
      expect.objectContaining({
        sessionId: liveAgentSessionId,
        isPinned: true,
      }),
    ])
    expect(registryInstance.agentSessions.history).toEqual([])
  })

  test('hibernate kills resolved live window when DB window is stale', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'hibernate-stale-window'
    const liveSession: TerminalSession = {
      ...baseSession,
      id: 'live-stale-window',
      agentSessionId: liveAgentSessionId,
      tmuxWindow: 'agentboard:77',
      command: 'claude --dangerously-skip-permissions',
    }
    registryInstance.sessions = [liveSession]
    seedRecord(
      makeRecord({
        sessionId: liveAgentSessionId,
        currentWindow: 'agentboard:stale',
        launchCommand: null,
      })
    )

    const killCalls: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: liveAgentSessionId })
    )

    expect(killCalls).toEqual([liveSession.tmuxWindow])
    expect(dbState.updateCalls[0]).toMatchObject({
      sessionId: liveAgentSessionId,
      patch: {
        isPinned: true,
        lastResumeError: null,
        launchCommand: liveSession.command,
      },
    })
    expect(dbState.records.get(liveAgentSessionId)).toMatchObject({
      currentWindow: null,
      isPinned: true,
      launchCommand: liveSession.command,
    })
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-hibernate-result',
      sessionId: liveAgentSessionId,
      ok: true,
    })
    expect(registryInstance.sessions).toEqual([])
  })

  test('hibernate restores marker state when tmux kill fails', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'hibernate-kill-fails'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: liveAgentSessionId },
    ]
    seedRecord(
      makeRecord({
        sessionId: liveAgentSessionId,
        currentWindow: baseSession.tmuxWindow,
        isPinned: false,
        lastResumeError: 'previous wake error',
      })
    )
    sessionManagerState.killWindow = () => {
      throw new Error('tmux kill failed')
    }
    sessionManagerState.listWindows = () => [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: liveAgentSessionId })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'session-hibernate-result',
      sessionId: liveAgentSessionId,
      ok: false,
      error: 'tmux kill failed',
    })
    expect(dbState.records.get(liveAgentSessionId)).toMatchObject({
      currentWindow: baseSession.tmuxWindow,
      isPinned: false,
      lastResumeError: 'previous wake error',
    })
  })

  test('hibernate succeeds when the target window is already gone after kill fails', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'hibernate-kill-raced'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: liveAgentSessionId },
    ]
    seedRecord(
      makeRecord({
        sessionId: liveAgentSessionId,
        currentWindow: baseSession.tmuxWindow,
        isPinned: false,
        lastResumeError: 'previous wake error',
      })
    )
    sessionManagerState.killWindow = () => {
      throw new Error("can't find window: @3")
    }
    sessionManagerState.listWindows = () => []

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: liveAgentSessionId })
    )

    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-hibernate-result',
      sessionId: liveAgentSessionId,
      ok: true,
      session: expect.objectContaining({
        sessionId: liveAgentSessionId,
        isPinned: true,
        isActive: false,
      }),
    })
    expect(dbState.records.get(liveAgentSessionId)).toMatchObject({
      currentWindow: null,
      isPinned: true,
      lastResumeError: null,
    })
    expect(registryInstance.sessions).toEqual([])
    expect(registryInstance.agentSessions.hibernating).toMatchObject([
      expect.objectContaining({
        sessionId: liveAgentSessionId,
        isPinned: true,
      }),
    ])
  })

  test('hibernate keeps marker when final DB window update fails after kill', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'hibernate-db-window-fails'
    registryInstance.sessions = [
      { ...baseSession, agentSessionId: liveAgentSessionId },
    ]
    seedRecord(
      makeRecord({
        sessionId: liveAgentSessionId,
        currentWindow: baseSession.tmuxWindow,
      })
    )
    let killedTarget: string | null = null
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killedTarget = tmuxWindow
    }
    dbState.updateSessionError = (sessionId, patch) =>
      sessionId === liveAgentSessionId && 'currentWindow' in patch
        ? new Error('db locked')
        : null

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-hibernate', sessionId: liveAgentSessionId })
    )

    expect(killedTarget === baseSession.tmuxWindow).toBe(true)
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-hibernate-result',
      sessionId: liveAgentSessionId,
      ok: false,
      error: 'Failed to update session state',
    })
    expect(dbState.records.get(liveAgentSessionId)).toMatchObject({
      currentWindow: baseSession.tmuxWindow,
      isPinned: true,
      lastResumeError: null,
    })
  })

  test('validates session wake errors', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'bad id' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'bad id',
      `session-wake-result for ${'bad id'}`
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'bad id',
      'session-wake-result for bad id'
      )
expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: 'bad id',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Invalid session id' },
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'missing' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'missing',
      `session-wake-result for ${'missing'}`
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'missing',
      'session-wake-result for missing'
      )
expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: 'missing',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Session not found' },
    })

    seedRecord(
      makeRecord({
        sessionId: 'active-session',
        currentWindow: 'agentboard:9',
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'active-session' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'active-session',
      `session-wake-result for ${'active-session'}`
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'active-session',
      'session-wake-result for active-session'
      )
expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: 'active-session',
      ok: false,
      error: { code: 'ALREADY_ACTIVE', message: 'Session is already active' },
    })

    configState.claudeResumeCmd = 'claude --resume'
    seedRecord(
      makeRecord({
        sessionId: 'bad-template',
        currentWindow: null,
        agentType: 'claude',
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'bad-template' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'bad-template',
      `session-wake-result for ${'bad-template'}`
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'bad-template',
      'session-wake-result for bad-template'
      )
expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: 'bad-template',
      ok: false,
      error: {
        code: 'WAKE_FAILED',
        message: 'Wake command template missing {sessionId} or {logFilePath} placeholder',
      },
    })
    seedRecord(
      makeRecord({
        sessionId: 'bad-template-with-launch-command',
        currentWindow: null,
        agentType: 'claude',
        launchCommand: 'claude --dangerously-skip-permissions',
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-wake',
        sessionId: 'bad-template-with-launch-command',
      })
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === 'bad-template-with-launch-command',
      'session-wake-result for bad-template-with-launch-command'
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'bad-template-with-launch-command',
      'session-wake-result for bad-template-with-launch-command'
      )
expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: 'bad-template-with-launch-command',
      ok: false,
      error: {
        code: 'WAKE_FAILED',
        message: 'Wake command template missing {sessionId} or {logFilePath} placeholder',
      },
    })
    const templateErrorPatch = dbState.updateCalls.find(
      (call) =>
        call.sessionId === 'bad-template' &&
        call.patch.lastResumeError ===
          'Wake command template missing {sessionId} or {logFilePath} placeholder'
    )
    expect(templateErrorPatch).toBeDefined()
  })

  test('wakes sessions and broadcasts activation', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const record = makeRecord({
      sessionId: 'resume-ok',
      displayName: 'resume',
      projectPath: '/tmp/resume',
      agentType: 'claude',
      currentWindow: null,
      isPinned: true,
      lastResumeError: 'resume failed',
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-session',
      name: 'resume',
      tmuxWindow: 'agentboard:99',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }
    // The deferred background refresh (refreshSessions()) lands after the
    // async wake handler sends its result; have the refresh worker report the
    // created session so the registry keeps it instead of being clobbered.
    refreshWorkerSessions = [
      {
        ...createdSession,
        agentSessionId: 'resume-ok',
        agentSessionName: 'resume',
        logFilePath: record.logFilePath,
        isPinned: true,
        lastActivity: record.lastActivityAt,
        createdAt: record.createdAt,
      },
    ]

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-ok' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-ok',
      `session-wake-result for ${'resume-ok'}`
    )

    expect(createArgs).not.toBeNull()
    expect(createArgs!).toEqual({
      projectPath: '/tmp/resume',
      name: 'resume',
      command: 'claude --resume resume-ok',
    })
    const activationPatch = dbState.updateCalls.find(
      (call) =>
        call.sessionId === 'resume-ok' &&
        call.patch.currentWindow === createdSession.tmuxWindow
    )
    expect(activationPatch?.patch).toMatchObject({
      currentWindow: createdSession.tmuxWindow,
      displayName: createdSession.name,
      lastResumeError: null,
    })

    const resumeMessage = sent.find(
      (message) => message.type === 'session-wake-result' && message.ok
    )
    expect(resumeMessage).toEqual({
      type: 'session-wake-result',
      sessionId: 'resume-ok',
      ok: true,
      session: expect.objectContaining({
        id: createdSession.id,
        name: createdSession.name,
        tmuxWindow: createdSession.tmuxWindow,
        status: createdSession.status,
        agentSessionId: 'resume-ok',
        agentSessionName: 'resume',
        logFilePath: record.logFilePath,
        lastActivity: record.lastActivityAt,
        createdAt: record.createdAt,
        isPinned: true,
      }),
    })

    const activatedMessage = sent.find(
      (message) => message.type === 'session-activated'
    )
    expect(activatedMessage).toMatchObject({
      type: 'session-activated',
      session: expect.objectContaining({
        sessionId: 'resume-ok',
        displayName: createdSession.name,
      }),
      window: createdSession.tmuxWindow,
    })
    expect(
      activatedMessage && 'session' in activatedMessage
        ? activatedMessage.session.lastResumeError
        : undefined
    ).toBeUndefined()

    expect(registryInstance.sessions[0]).toMatchObject({
      id: createdSession.id,
      agentSessionId: 'resume-ok',
      logFilePath: record.logFilePath,
    })
  })

  test('wake rematches a dormant session to an already-running window', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const rematchId = 'wake-rematch'
    const logFilePath = '/tmp/wake-rematch.jsonl'
    const liveSession: TerminalSession = {
      ...baseSession,
      id: 'live-rematched-session',
      name: 'manual-rematch',
      tmuxWindow: 'agentboard:77',
      logFilePath,
      command: 'claude --dangerously-skip-permissions',
    }
    seedRecord(
      makeRecord({
        sessionId: rematchId,
        displayName: 'stored-rematch',
        logFilePath,
        currentWindow: null,
        isPinned: true,
        lastResumeError: 'previous wake failed',
      })
    )
    sessionManagerState.listWindows = () => [liveSession]

    let createCalled = false
    sessionManagerState.createWindow = () => {
      createCalled = true
      return liveSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: rematchId })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === rematchId,
      `session-wake-result for ${rematchId}`
    )

    expect(createCalled).toBe(false)
    expect(dbState.records.get(rematchId)).toMatchObject({
      currentWindow: liveSession.tmuxWindow,
      displayName: liveSession.name,
      lastResumeError: null,
      launchCommand: liveSession.command,
    })
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'session-activated',
      window: liveSession.tmuxWindow,
      session: expect.objectContaining({
        sessionId: rematchId,
        displayName: liveSession.name,
      }),
    })
    const wakeResult = sent.find(
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === rematchId &&
        message.ok
    )
    expect(wakeResult).toMatchObject({
      type: 'session-wake-result',
      sessionId: rematchId,
      ok: true,
      session: expect.objectContaining({
        id: liveSession.id,
        agentSessionId: rematchId,
        logFilePath,
      }),
    })
    expect(registryInstance.agentSessions.hibernating).toEqual([])
    expect(registryInstance.agentSessions.active).toMatchObject([
      expect.objectContaining({ sessionId: rematchId }),
    ])
  })

  test('wake mutex suppresses duplicate create while a wake is in flight', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const sessionId = 'wake-lock'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'wake-lock',
        currentWindow: null,
        isPinned: true,
      })
    )
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'wake-lock-created',
      name: 'wake-lock',
      tmuxWindow: 'agentboard:80',
    }
    let createCalls = 0
    sessionManagerState.createWindow = () => {
      createCalls += 1
      if (createCalls === 1) {
        websocket.message?.(
          ws as never,
          JSON.stringify({ type: 'session-wake', sessionId })
        )
      }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId })
    )

    // The wake handler is async: wait for both results (the suppressed
    // duplicate and the original's completion) before asserting.
    const mutexDeadline = Date.now() + 2000
    while (
      sent.filter(
        (message) =>
          message.type === 'session-wake-result' && message.sessionId === sessionId
      ).length < 2 &&
      Date.now() < mutexDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(createCalls).toBe(1)
    const wakeResults = sent.filter(
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === sessionId
    )
    expect(wakeResults).toHaveLength(2)
    expect(wakeResults[0]).toEqual({
      type: 'session-wake-result',
      sessionId,
      ok: false,
      error: {
        code: 'WAKE_IN_PROGRESS',
        message: 'Wake already in progress for this session',
      },
    })
    expect(wakeResults[1]).toEqual({
      type: 'session-wake-result',
      sessionId,
      ok: true,
      session: expect.objectContaining({
        id: createdSession.id,
        name: createdSession.name,
        tmuxWindow: createdSession.tmuxWindow,
        agentSessionId: sessionId,
        agentSessionName: 'wake-lock',
        logFilePath: '/tmp/wake-lock.jsonl',
        isPinned: true,
      }),
    })
  })

  test('wake kills new window and returns rematched session if logPoller claims current_window mid-flight', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const sessionId = 'wake-race'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'wake-race',
        currentWindow: null,
        isPinned: false,
      })
    )

    const newWindow = 'agentboard:99'
    const racedWindow = 'agentboard:55'
    const newSession: Session = {
      ...baseSession,
      id: 'wake-race-created',
      name: 'wake-race',
      tmuxWindow: newWindow,
    }
    const racedSession: Session = {
      ...baseSession,
      id: 'wake-race-rematched',
      name: 'wake-race',
      tmuxWindow: racedWindow,
      agentSessionId: sessionId,
    }
    sessionManagerState.createWindow = () => {
      // Simulate the logPoller (or a concurrent rematch path) claiming the
      // session's current_window between the wake handler's initial read and
      // the post-createWindow claim attempt. The race appears AFTER
      // tryRematchDormantSession runs (registry was empty there), so the
      // simulation only surfaces the racing session now. listWindows must
      // include the raced window so the conflict-path refresh sees a
      // consistent live tmux state.
      const record = dbState.records.get(sessionId)
      if (record) {
        dbState.records.set(sessionId, {
          ...record,
          currentWindow: racedWindow,
        })
      }
      registryInstance.sessions = [racedSession]
      sessionManagerState.listWindows = () => [racedSession]
      return newSession
    }
    const killCalls: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId })
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === sessionId,
      'session-wake-result for sessionId'
    )

    // Newly-created window must be killed to avoid duplicate live windows.
    expect(killCalls).toEqual([newWindow])
    // DB must reflect the racing claim, not the wake's would-be window.
    expect(dbState.records.get(sessionId)?.currentWindow).toBe(racedWindow)
    // Caller still gets ok:true with the racing session payload.
    const wakeResults = sent.filter(
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === sessionId
    )
    expect(wakeResults).toHaveLength(1)
    expect(wakeResults[0]).toMatchObject({
      type: 'session-wake-result',
      sessionId,
      ok: true,
      session: { tmuxWindow: racedWindow },
    })
  })

  test('wake keeps new window if another session claims it mid-flight', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const sessionId = 'wake-claimed-by-other'
    const ownerSessionId = 'other-owner'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'wake-claimed-by-other',
        currentWindow: null,
        isPinned: true,
      })
    )
    seedRecord(
      makeRecord({
        sessionId: ownerSessionId,
        displayName: 'other-owner',
        currentWindow: null,
        isPinned: false,
      })
    )

    const newWindow = 'agentboard:99'
    const newSession: Session = {
      ...baseSession,
      id: 'wake-claimed-created',
      name: 'wake-claimed-by-other',
      tmuxWindow: newWindow,
    }
    const ownerSession: Session = {
      ...baseSession,
      id: 'wake-claimed-owner',
      name: 'other-owner',
      tmuxWindow: newWindow,
      agentSessionId: ownerSessionId,
    }
    sessionManagerState.createWindow = () => {
      const owner = dbState.records.get(ownerSessionId)
      if (owner) {
        dbState.records.set(ownerSessionId, {
          ...owner,
          currentWindow: newWindow,
        })
      }
      registryInstance.sessions = [ownerSession]
      sessionManagerState.listWindows = () => [ownerSession]
      return newSession
    }
    const killCalls: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId })
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === sessionId,
      'session-wake-result for sessionId'
    )

    expect(killCalls).toEqual([])
    expect(dbState.records.get(sessionId)).toMatchObject({
      currentWindow: null,
      wakeStartedAt: null,
    })
    expect(dbState.records.get(ownerSessionId)?.currentWindow).toBe(newWindow)

    const wakeResults = sent.filter(
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === sessionId
    )
    expect(wakeResults).toHaveLength(1)
    expect(wakeResults[0]).toMatchObject({
      type: 'session-wake-result',
      sessionId,
      ok: false,
      error: { code: 'WAKE_IN_PROGRESS' },
    })
  })

  test('wake keeps new window if a racing rematch claims that same window', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const sessionId = 'wake-same-window-race'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'wake-same-window-race',
        currentWindow: null,
        isPinned: true,
        lastResumeError: 'previous wake failed',
      })
    )

    const newWindow = 'agentboard:99'
    const newSession: Session = {
      ...baseSession,
      id: 'wake-same-window-created',
      name: 'wake-same-window-race',
      tmuxWindow: newWindow,
    }
    sessionManagerState.createWindow = () => {
      const record = dbState.records.get(sessionId)
      if (record) {
        dbState.records.set(sessionId, {
          ...record,
          currentWindow: newWindow,
          lastResumeError: null,
        })
      }
      return newSession
    }
    const killCalls: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    }
    // The deferred background refresh lands after the async handler's result;
    // report the created session so the registry keeps it.
    refreshWorkerSessions = [
      {
        ...newSession,
        agentSessionId: sessionId,
        agentSessionName: 'wake-same-window-race',
        logFilePath: `/tmp/${sessionId}.jsonl`,
      },
    ]

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId })
    )
    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === sessionId,
      'session-wake-result for sessionId'
    )

    expect(killCalls).toEqual([])
    expect(dbState.records.get(sessionId)).toMatchObject({
      currentWindow: newWindow,
      lastResumeError: null,
    })
    const wakeResults = sent.filter(
      (message) =>
        message.type === 'session-wake-result' &&
        message.sessionId === sessionId
    )
    expect(wakeResults).toHaveLength(1)
    expect(wakeResults[0]).toMatchObject({
      type: 'session-wake-result',
      sessionId,
      ok: true,
      session: {
        tmuxWindow: newWindow,
        agentSessionId: sessionId,
        agentSessionName: 'wake-same-window-race',
        logFilePath: `/tmp/${sessionId}.jsonl`,
      },
    })
    expect(registryInstance.sessions).toMatchObject([
      expect.objectContaining({
        tmuxWindow: newWindow,
        agentSessionId: sessionId,
      }),
    ])
  })

  test('wakes session with quoted launch_command by stripping tmux quotes', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const record = makeRecord({
      sessionId: 'resume-quoted',
      displayName: 'quoted-session',
      projectPath: '/tmp/quoted',
      agentType: 'claude',
      currentWindow: null,
      launchCommand: '"claude --dangerously-skip-permissions"',
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-quoted',
      name: 'quoted-session',
      tmuxWindow: 'agentboard:50',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-quoted' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-quoted',
      `session-wake-result for ${'resume-quoted'}`
    )

    expect(createArgs).not.toBeNull()
    expect(createArgs!).toEqual({
      projectPath: '/tmp/quoted',
      name: 'quoted-session',
      command: 'claude --dangerously-skip-permissions --resume resume-quoted',
    })
  })

  test('wake strips the composed apply prompt from the stored launch command', async () => {
    // A session created with a first prompt carries it in launchCommand.
    // Resuming must reconstruct the original launch flags without the apply
    // prompt, for both prompt forms — never re-running it on wake.
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-apply-prompt',
      name: 'apply-prompt',
      tmuxWindow: 'agentboard:54',
    }
    const commands: Array<string | undefined> = []
    sessionManagerState.createWindow = (_projectPath, _name, command) => {
      commands.push(command)
      return createdSession
    }

    seedRecord(
      makeRecord({
        sessionId: 'resume-apply-prompt',
        displayName: 'apply-prompt',
        projectPath: '/tmp/apply',
        agentType: 'claude',
        currentWindow: null,
        launchCommand: `claude --dangerously-skip-permissions '/opsx:apply add-x'`,
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-apply-prompt' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-apply-prompt',
      `session-wake-result for ${'resume-apply-prompt'}`
    )
    expect(commands[0]).toBe(
      'claude --dangerously-skip-permissions --resume resume-apply-prompt'
    )

    seedRecord(
      makeRecord({
        sessionId: 'resume-apply-prompt-codex',
        displayName: 'apply-prompt-codex',
        projectPath: '/tmp/apply-codex',
        agentType: 'codex',
        currentWindow: null,
        launchCommand: `codex --yolo '$openspec-apply-change add-x'`,
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-apply-prompt-codex' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-apply-prompt-codex',
      `session-wake-result for ${'resume-apply-prompt-codex'}`
    )
    expect(commands[1]).toBe('codex --yolo resume resume-apply-prompt-codex')
  })

  test('wake preserves unrelated quoted flag values while stripping the apply prompt', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-unrelated-quoted',
      name: 'unrelated-quoted',
      tmuxWindow: 'agentboard:56',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    seedRecord(
      makeRecord({
        sessionId: 'resume-unrelated-quoted',
        displayName: 'unrelated-quoted',
        projectPath: '/tmp/unrelated',
        agentType: 'claude',
        currentWindow: null,
        launchCommand: `claude --dangerously-skip-permissions --append-system-prompt 'foo' '/opsx:apply add-x'`,
      })
    )
    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-unrelated-quoted' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-unrelated-quoted',
      `session-wake-result for ${'resume-unrelated-quoted'}`
    )

    expect(createArgs).not.toBeNull()
    // The apply prompt is gone; the quoted --append-system-prompt value rides
    // through exactly as stored.
    expect(createArgs!.command).toBe(
      `claude --dangerously-skip-permissions --append-system-prompt 'foo' --resume resume-unrelated-quoted`
    )
  })

  test('wakes codex session with quoted launch_command preserving flags', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const record = makeRecord({
      sessionId: 'resume-codex',
      displayName: 'codex-session',
      projectPath: '/tmp/codex',
      agentType: 'codex',
      currentWindow: null,
      launchCommand: '"codex --yolo --search"',
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-codex',
      name: 'codex-session',
      tmuxWindow: 'agentboard:51',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-codex' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-codex',
      `session-wake-result for ${'resume-codex'}`
    )

    expect(createArgs).not.toBeNull()
    // Flags injected after exe, before resume subcommand
    expect(createArgs!.command).toBe('codex --yolo --search resume resume-codex')
  })

  test('wakes codex session stripping old resume subcommand from stored launch_command', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const record = makeRecord({
      sessionId: 'resume-codex-old',
      displayName: 'codex-old',
      projectPath: '/tmp/codex',
      agentType: 'codex',
      currentWindow: null,
      launchCommand: '"codex --search resume old-session-id"',
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-codex-old',
      name: 'codex-old',
      tmuxWindow: 'agentboard:52',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-codex-old' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-codex-old',
      `session-wake-result for ${'resume-codex-old'}`
    )

    expect(createArgs).not.toBeNull()
    // Old 'resume old-session-id' stripped, only --search flag preserved
    expect(createArgs!.command).toBe('codex --search resume resume-codex-old')
  })

  test('wakes pi session from its log file path and preserves launch flags', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    const record = makeRecord({
      sessionId: 'resume-pi',
      displayName: 'pi-session',
      projectPath: '/tmp/pi',
      agentType: 'pi',
      logFilePath: '/tmp/pi sessions/resume pi.jsonl',
      currentWindow: null,
      launchCommand: '"pi --fast --session /tmp/old-pi.jsonl"',
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'created-pi',
      name: 'pi-session',
      tmuxWindow: 'agentboard:53',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: 'resume-pi' })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === 'resume-pi',
      `session-wake-result for ${'resume-pi'}`
    )

    expect(createArgs).not.toBeNull()
    expect(createArgs!.command).toBe(
      "pi --fast --session '/tmp/pi sessions/resume pi.jsonl'"
    )
  })

  test('wake is idempotent when the registry already has the session live', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const liveAgentSessionId = 'wake-already-live'
    const liveSession = {
      ...baseSession,
      agentSessionId: liveAgentSessionId,
      tmuxWindow: 'agentboard:42',
    }
    registryInstance.sessions = [liveSession]
	    seedRecord(
	      makeRecord({
	        sessionId: liveAgentSessionId,
	        currentWindow: liveSession.tmuxWindow,
	        lastResumeError: 'previous wake failed',
	        wakeStartedAt: '2026-01-01T00:01:00.000Z',
	        // Session is genuinely live. Still, a stale client message shouldn't
	        // surface ALREADY_ACTIVE; we ack idempotently.
	      })
    )

    let createCalled = false
    sessionManagerState.createWindow = () => {
      createCalled = true
      return liveSession
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: liveAgentSessionId })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === liveAgentSessionId,
      `session-wake-result for ${liveAgentSessionId}`
    )

    expect(createCalled).toBe(false)
	    expect(sent[sent.length - 1]).toMatchObject({
	      type: 'session-wake-result',
	      sessionId: liveAgentSessionId,
	      ok: true,
	      session: expect.objectContaining({ id: liveSession.id }),
	    })
	    expect(dbState.records.get(liveAgentSessionId)).toMatchObject({
	      lastResumeError: null,
	      wakeStartedAt: null,
	    })
	    expect(dbState.updateCalls).toContainEqual({
	      sessionId: liveAgentSessionId,
	      patch: {
	        lastResumeError: null,
	        wakeStartedAt: null,
	      },
	    })
	  })

  test('wake kills created window when DB claim throws', async () => {
    const { serveOptions } = await loadIndex()
    const hibernatingId = 'wake-claim-throws'
    seedRecord(
      makeRecord({
        sessionId: hibernatingId,
        displayName: 'wake-claim-throws',
        projectPath: '/tmp/wake-claim-throws',
        agentType: 'claude',
        currentWindow: null,
        isPinned: true,
      })
    )

    const createdSession: TerminalSession = {
      ...baseSession,
      id: 'wake-claim-created',
      name: 'wake-claim-throws',
      tmuxWindow: 'agentboard:81',
    }
    sessionManagerState.createWindow = () => createdSession
    const killCalls: string[] = []
    sessionManagerState.killWindow = (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    }
    dbState.updateSessionError = (sessionId, patch) =>
      sessionId === hibernatingId &&
      patch.currentWindow === createdSession.tmuxWindow
        ? new Error('db locked')
        : null

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: hibernatingId })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === hibernatingId,
      `session-wake-result for ${hibernatingId}`
    )

    expect(killCalls).toEqual([createdSession.tmuxWindow])
    expect(dbState.records.get(hibernatingId)).toMatchObject({
      currentWindow: null,
      isPinned: true,
      lastResumeError: 'db locked',
    })
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: hibernatingId,
      ok: false,
      error: { code: 'WAKE_FAILED', message: 'db locked' },
    })
  })

  test('wake failure persists lastResumeError without clearing hibernation marker', async () => {
    const { serveOptions } = await loadIndex()
    const hibernatingId = 'wake-fails'
    seedRecord(
      makeRecord({
        sessionId: hibernatingId,
        displayName: 'wakes-bad',
        projectPath: '/tmp/wakes-bad',
        agentType: 'claude',
        currentWindow: null,
        isPinned: true,
      })
    )

    sessionManagerState.createWindow = () => {
      throw new Error('resume artifact missing')
    }

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: hibernatingId })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === hibernatingId,
      `session-wake-result for ${hibernatingId}`
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: hibernatingId,
      ok: false,
      error: { code: 'WAKE_FAILED', message: 'resume artifact missing' },
    })

    const errorPatch = dbState.updateCalls.find(
      (call) =>
        call.sessionId === hibernatingId &&
        call.patch.lastResumeError === 'resume artifact missing'
    )
    expect(errorPatch?.patch.lastResumeError).toBe('resume artifact missing')
    expect(errorPatch?.patch.wakeStartedAt).toBeNull()

    // Hibernation marker must stay true so the card remains in the Hibernating rail.
    const removedMarker = dbState.updateCalls.find(
      (call) =>
        call.sessionId === hibernatingId &&
        'isPinned' in call.patch &&
        call.patch.isPinned === false
    )
    expect(removedMarker).toBeUndefined()
  })

  test('wake failure still reports when persisting the error fails', async () => {
    const { serveOptions } = await loadIndex()
    const hibernatingId = 'wake-persist-fails'
    seedRecord(
      makeRecord({
        sessionId: hibernatingId,
        displayName: 'wake-persist-fails',
        projectPath: '/tmp/wake-persist-fails',
        agentType: 'claude',
        currentWindow: null,
        isPinned: true,
      })
    )

    sessionManagerState.createWindow = () => {
      throw new Error('resume artifact missing')
    }
    dbState.updateSessionError = (sessionId, patch) =>
      sessionId === hibernatingId && patch.lastResumeError
        ? new Error('db locked')
        : null

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-wake', sessionId: hibernatingId })
    )

    await waitForSent(
      sent,
      (message) =>
        message.type === 'session-wake-result' && message.sessionId === hibernatingId,
      `session-wake-result for ${hibernatingId}`
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'session-wake-result',
      sessionId: hibernatingId,
      ok: false,
      error: { code: 'WAKE_FAILED', message: 'resume artifact missing' },
    })
    expect(dbState.records.get(hibernatingId)?.isPinned).toBe(true)
  })

  test('websocket close disposes all terminals', async () => {
    const { serveOptions } = await loadIndex()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const { ws } = createWs()
    websocket.open?.(ws as never)

    const terminal = ws.data.terminal
    if (!terminal) {
      throw new Error('Expected terminal to be created')
    }

    websocket.close?.(ws as never, 1000, 'test')

    expect(terminal.disposed).toBe(true)
    expect(ws.data.terminal).toBe(null)
  })
})

describe('server signal handlers', () => {
  test('SIGINT and SIGTERM cleanup terminals and exit', async () => {
    const handlers = new Map<string, () => void>()
    processAny.on = ((event: string, handler: () => void) => {
      handlers.set(event, handler)
      return processAny
    }) as typeof processAny.on

    const exitCodes: number[] = []
    processAny.exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
      return undefined as never
    }) as typeof processAny.exit

    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    const { ws } = createWs()
    websocket.open?.(ws as never)
    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'terminal-attach',
        sessionId: baseSession.id,
        tmuxTarget: baseSession.tmuxWindow,
      })
    )

    const attached = ws.data.terminal
    if (!attached) {
      throw new Error('Expected terminal to be created')
    }

    handlers.get('SIGINT')?.()
    handlers.get('SIGTERM')?.()

    // cleanupAllTerminals is async — wait for the .finally() callbacks
    await new Promise((r) => setTimeout(r, 0))

    expect(attached?.disposed).toBe(true)
    expect(exitCodes).toEqual([0, 0])
  })
})

describe('server fetch handlers', () => {
  test('server-info returns tailscale ip when available', async () => {
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      if (command[0] === 'tailscale') {
        return {
          exitCode: 0,
          stdout: Buffer.from('100.64.0.42\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/server-info'),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for server-info request')
    }

    const payload = (await response.json()) as {
      port: number
      tailscaleIp: string | null
      protocol: string
      cwd?: string
      defaultProjectDir?: string
      version: string
    }
    expect(payload.port).toBe(4040)
    expect(payload.protocol).toBe('http')
    expect(payload.tailscaleIp).toBe('100.64.0.42')
    expect(payload.cwd).toBe(process.cwd())
    expect(payload.defaultProjectDir).toBe('')
    expect(payload.version).toBe(BUILD_VERSION)
  })

  test('server-info reports the configured default project directory', async () => {
    configState.defaultProjectDir = '/srv/work/projects'

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/server-info'),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for server-info request')
    }

    const payload = (await response.json()) as { defaultProjectDir?: string }
    expect(payload.defaultProjectDir).toBe('/srv/work/projects')
  })

  test('tmux mouse mode timeout returns 504 and does not persist the setting', async () => {
    let mouseModeCalls = 0
    sessionManagerState.setMouseMode = () => {
      mouseModeCalls += 1
      throw new TmuxTimeoutError('set-option', 3000)
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/tmux-mouse-mode', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for tmux mouse mode request')
    }

    expect(mouseModeCalls).toBe(1)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'Timed out applying tmux mouse mode',
    })
    expect(dbState.setAppSettingCalls).toEqual([])
  })

  test('tmux mouse mode apply failure returns 500 and does not persist the setting', async () => {
    let mouseModeCalls = 0
    sessionManagerState.setMouseMode = () => {
      mouseModeCalls += 1
      throw new Error('grouped set-option failed')
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/tmux-mouse-mode', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for tmux mouse mode request')
    }

    expect(mouseModeCalls).toBe(1)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Unable to apply tmux mouse mode',
    })
    expect(dbState.setAppSettingCalls).toEqual([])
  })

  test('tmux mouse mode persists only after tmux state applies successfully', async () => {
    const appliedValues: boolean[] = []
    sessionManagerState.setMouseMode = (enabled: boolean) => {
      appliedValues.push(enabled)
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/tmux-mouse-mode', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for tmux mouse mode request')
    }

    expect(appliedValues).toEqual([false])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false })
    expect(dbState.setAppSettingCalls).toEqual([
      { key: 'tmux_mouse_mode', value: 'false' },
    ])
  })

  test('tmux mouse mode persistence failure returns 500 and rolls back runtime state', async () => {
    dbState.setAppSettingError = new Error('db unavailable')
    const appliedValues: boolean[] = []
    sessionManagerState.setMouseMode = (enabled: boolean) => {
      appliedValues.push(enabled)
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/tmux-mouse-mode', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for tmux mouse mode request')
    }

    expect(appliedValues).toEqual([false, true])
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Unable to persist tmux mouse mode',
    })
    expect(dbState.setAppSettingCalls).toEqual([])
  })

  test('terminal colors setting applies globally and persists', async () => {
    const appliedValues: boolean[] = []
    sessionManagerState.setTerminalColors = (enabled: boolean) => {
      appliedValues.push(enabled)
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const putResponse = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/terminal-colors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!putResponse) {
      throw new Error('Expected response for terminal colors request')
    }

    expect(putResponse.status).toBe(200)
    expect(await putResponse.json()).toEqual({ enabled: false })
    expect(appliedValues).toEqual([false])
    expect(configState.terminalColorsEnabled).toBe(false)
    expect(dbState.setAppSettingCalls).toEqual([
      { key: 'terminal_colors_enabled', value: 'false' },
    ])

    const getResponse = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/terminal-colors'),
      {} as Bun.Server<unknown>
    )
    if (!getResponse) {
      throw new Error('Expected response for terminal colors request')
    }
    expect(await getResponse.json()).toEqual({ enabled: false })
  })

  test('terminal colors persistence failure rolls back runtime state', async () => {
    dbState.setAppSettingError = new Error('db unavailable')
    const appliedValues: boolean[] = []
    sessionManagerState.setTerminalColors = (enabled: boolean) => {
      appliedValues.push(enabled)
    }

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/terminal-colors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for terminal colors request')
    }

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Unable to persist terminal colors',
    })
    expect(appliedValues).toEqual([false, true])
    expect(configState.terminalColorsEnabled).toBe(true)
    expect(dbState.setAppSettingCalls).toEqual([])
  })

  test('terminal colors rejects non-boolean values', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/settings/terminal-colors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for terminal colors request')
    }

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'enabled must be a boolean' })
    expect(dbState.setAppSettingCalls).toEqual([])
  })

  test('returns no response for successful websocket upgrades', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const upgradeCalls: Array<{ url: string }> = []
    const server = {
      upgrade: (req: Request) => {
        upgradeCalls.push({ url: req.url })
        return true
      },
    } as unknown as Bun.Server<unknown>

    const response = await fetchHandler.call(
      server,
      new Request('http://localhost/ws'),
      server
    )

    expect(upgradeCalls).toHaveLength(1)
    expect(response).toBeUndefined()
  })

  test('returns upgrade failure for websocket requests', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }
    const upgradeCalls: Array<{ url: string }> = []
    const server = {
      upgrade: (req: Request) => {
        upgradeCalls.push({ url: req.url })
        return false
      },
    } as unknown as Bun.Server<unknown>

    const response = await fetchHandler.call(
      server,
      new Request('http://localhost/ws'),
      server
    )

    if (!response) {
      throw new Error('Expected response for websocket upgrade')
    }

    expect(upgradeCalls).toHaveLength(1)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('WebSocket upgrade failed')
  })

  test('returns macOS clipboard image file paths from AppKit pasteboard reader', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-clipboard-'))
    try {
      const imagePath = path.join(tempDir, 'screenshot.png')
      await fs.writeFile(imagePath, new Uint8Array([1, 2, 3]))

      let capturedCommandPrefix: string[] = []
      let capturedTimeout: number | undefined
      let capturedEnv: Record<string, string | undefined> | undefined
      spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
        const command = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])]
        if (command[0] !== 'swift') {
          return {
            exitCode: 0,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        capturedCommandPrefix = command.slice(0, 2)
        capturedTimeout = args[1]?.timeout
        capturedEnv = args[1]?.env as Record<string, string | undefined> | undefined
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({ path: imagePath, isImage: true })),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync

      const { serveOptions } = await loadIndex()
      const fetchHandler = serveOptions.fetch
      if (!fetchHandler) {
        throw new Error('Fetch handler not configured')
      }

      const response = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/clipboard-file-path'),
        {} as Bun.Server<unknown>
      )

      if (!response) {
        throw new Error('Expected response for clipboard file path')
      }

      expect(capturedCommandPrefix).toEqual(['swift', '-e'])
      expect(capturedTimeout).toBe(10000)
      expect(capturedEnv?.AGENTBOARD_PASTE_IMAGE_MAX_BYTES).toBe(String(defaultConfig.pasteImageMaxBytes))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ path: imagePath, isImage: true })
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('returns null when macOS clipboard path does not exist', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])]
      if (command[0] !== 'swift') {
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({ path: '/tmp/agentboard-missing.png', isImage: true })),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/clipboard-file-path'),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for clipboard file path')
    }

    expect(await response.json()).toEqual({ path: null, isImage: false })
  })

  test.each(['report.docx', 'report.pdf', 'custom.unknown', 'LICENSE'])('resolves Finder file %s without starting the Swift interpreter', async (filename) => {
    if (process.platform !== 'darwin') {
      return
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-clipboard-'))
    try {
      const filePath = path.join(tempDir, filename)
      await fs.writeFile(filePath, new Uint8Array([1, 2, 3]))

      const commands: string[][] = []
      spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
        const command = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])]
        commands.push(command.slice(0, 2))
        if (command[0] === 'swift') {
          return {
            exitCode: 1,
            stdout: Buffer.from(''),
            stderr: Buffer.from('swift-missing'),
          } as ReturnType<typeof Bun.spawnSync>
        }
        if (command[0] === 'osascript') {
          return {
            exitCode: 0,
            stdout: Buffer.from(`${filePath}\n`),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync

      const { serveOptions } = await loadIndex()
      const fetchHandler = serveOptions.fetch
      if (!fetchHandler) {
        throw new Error('Fetch handler not configured')
      }

      const response = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/clipboard-file-path'),
        {} as Bun.Server<unknown>
      )

      if (!response) {
        throw new Error('Expected response for clipboard file path')
      }

      expect(commands).not.toContainEqual(['swift', '-e'])
      expect(commands).toContainEqual(['osascript', '-e'])
      expect(await response.json()).toEqual({ path: filePath, isImage: false })
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('handles paste-image requests with and without files', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const server = {} as Bun.Server<unknown>
    registryInstance.sessions = [baseSession]

    const healthResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/health'),
      server
    )
    if (!healthResponse) {
      throw new Error('Expected response for health request')
    }
    expect((await healthResponse.json()) as { ok: boolean }).toEqual({ ok: true })

    const sessionsResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/sessions'),
      server
    )
    if (!sessionsResponse) {
      throw new Error('Expected response for sessions request')
    }
    const sessions = (await sessionsResponse.json()) as Session[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(baseSession.id)

    const emptyResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        body: new FormData(),
      }),
      server
    )

    if (!emptyResponse) {
      throw new Error('Expected response for paste-image without files')
    }

    expect(emptyResponse.status).toBe(400)

    const formData = new FormData()
    const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', {
      type: 'image/png',
    })
    formData.append('image', file)

    const uploadResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        body: formData,
      }),
      server
    )

    if (!uploadResponse) {
      throw new Error('Expected response for paste-image upload')
    }

    const payload = (await uploadResponse.json()) as { path: string }
    expect(uploadResponse.ok).toBe(true)
    expect(payload.path.startsWith('/tmp/paste-')).toBe(true)
    expect(payload.path.endsWith('.png')).toBe(true)
  })

  test('returns 500 when paste-image upload fails', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    writeImpl = async () => {
      throw new Error('write-failed')
    }

    const formData = new FormData()
    const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', {
      type: 'image/png',
    })
    formData.append('image', file)

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        body: formData,
      }),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for paste-image failure')
    }

    expect(response.status).toBe(500)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toBe('write-failed')
  })

  test('maps each allowed paste-image type to its extension', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }
    const server = {} as Bun.Server<unknown>

    // Bun's multipart parser derives File.type from the part filename's
    // extension, ignoring the declared blob type — so each upload's filename
    // must carry the extension for the type under test.
    const cases = [
      ['paste.png', 'image/png', '.png'],
      ['paste.jpeg', 'image/jpeg', '.jpg'],
      ['paste.gif', 'image/gif', '.gif'],
      ['paste.webp', 'image/webp', '.webp'],
    ] as const

    for (const [uploadName, mime, extension] of cases) {
      const formData = new FormData()
      formData.append(
        'image',
        new File([new Uint8Array([1, 2, 3])], uploadName, { type: mime })
      )

      const response = await fetchHandler.call(
        server,
        new Request('http://localhost/api/paste-image', {
          method: 'POST',
          body: formData,
        }),
        server
      )

      if (!response) {
        throw new Error(`Expected response for ${mime} upload`)
      }

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { path: string }
      expect(payload.path.startsWith('/tmp/paste-')).toBe(true)
      expect(payload.path.endsWith(extension)).toBe(true)
    }
  })

  test('rejects paste-image uploads with unsupported types', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }
    const server = {} as Bun.Server<unknown>

    const unsupported = [
      ['paste.txt', 'text/plain'],
      ['paste.svg', 'image/svg+xml'],
      ['paste.pdf', 'application/pdf'],
      ['paste.heic', 'image/heic'],
    ] as const

    for (const [uploadName, mime] of unsupported) {
      const formData = new FormData()
      formData.append(
        'image',
        new File([new Uint8Array([1, 2, 3])], uploadName, { type: mime })
      )

      const response = await fetchHandler.call(
        server,
        new Request('http://localhost/api/paste-image', {
          method: 'POST',
          body: formData,
        }),
        server
      )

      if (!response) {
        throw new Error(`Expected response for ${mime} upload`)
      }

      expect(response.status).toBe(415)
      const payload = (await response.json()) as { error: string }
      expect(payload.error).toBe('Unsupported image type')
    }

    // A plain string field named 'image' is not a file upload
    const stringForm = new FormData()
    stringForm.append('image', 'not-a-file')

    const stringResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        body: stringForm,
      }),
      server
    )

    if (!stringResponse) {
      throw new Error('Expected response for string image field')
    }

    expect(stringResponse.status).toBe(400)
  })

  test('rejects oversized paste-image uploads', async () => {
    configState.pasteImageMaxBytes = 2
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }
    const server = {} as Bun.Server<unknown>

    const formData = new FormData()
    formData.append(
      'image',
      new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })
    )

    const oversizedResponse = await fetchHandler.call(
      server,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        body: formData,
      }),
      server
    )

    if (!oversizedResponse) {
      throw new Error('Expected response for oversized upload')
    }

    expect(oversizedResponse.status).toBe(413)
    const payload = (await oversizedResponse.json()) as { error: string }
    expect(payload.error).toBe('Image too large')
  })

  test('rejects paste-image requests by content-length before parsing the body', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }
    const server = {} as Bun.Server<unknown>

    // The body is not valid multipart, so a 413 (rather than the 500 a
    // formData() parse failure produces) proves the header check ran first.
    const response = await fetchHandler.call(
      server,
      new Request('http://localhost/api/paste-image', {
        method: 'POST',
        headers: { 'content-length': String(64 * 1024 * 1024) },
        body: 'x',
      }),
      server
    )

    if (!response) {
      throw new Error('Expected response for oversized content-length')
    }

    expect(response.status).toBe(413)
  })

  test('returns session preview for existing logs', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-preview-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`)
    await fs.writeFile(logPath, lines.join('\n'))

    seedRecord(
      makeRecord({
        sessionId: 'session-preview',
        logFilePath: logPath,
        displayName: 'Preview',
        projectPath: '/tmp/preview',
        agentType: 'codex',
      })
    )

    try {
      const response = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/session-preview/session-preview'),
        {} as Bun.Server<unknown>
      )

      if (!response) {
        throw new Error('Expected response for session preview')
      }

      expect(response.ok).toBe(true)
      const payload = (await response.json()) as {
        sessionId: string
        displayName: string
        projectPath: string
        agentType: string
        totalLines: number
        startLine: number
        endLine: number
        hasMoreBefore: boolean
        lines: string[]
      }
      expect(payload.sessionId).toBe('session-preview')
      expect(payload.displayName).toBe('Preview')
      expect(payload.projectPath).toBe('/tmp/preview')
      expect(payload.agentType).toBe('codex')
      expect(payload.totalLines).toBe(250)
      expect(payload.startLine).toBe(50)
      expect(payload.endLine).toBe(250)
      expect(payload.hasMoreBefore).toBe(true)
      expect(payload.lines).toHaveLength(200)
      expect(payload.lines[0]).toBe('line-50')

      const earlierResponse = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/session-preview/session-preview?beforeLine=50&limit=30'),
        {} as Bun.Server<unknown>
      )

      if (!earlierResponse) {
        throw new Error('Expected earlier response for session preview')
      }

      expect(earlierResponse.ok).toBe(true)
      const earlierPayload = (await earlierResponse.json()) as {
        totalLines: number
        startLine: number
        endLine: number
        hasMoreBefore: boolean
        lines: string[]
      }
      expect(earlierPayload.totalLines).toBe(250)
      expect(earlierPayload.startLine).toBe(20)
      expect(earlierPayload.endLine).toBe(50)
      expect(earlierPayload.hasMoreBefore).toBe(true)
      expect(earlierPayload.lines).toHaveLength(30)
      expect(earlierPayload.lines[0]).toBe('line-20')
      expect(earlierPayload.lines[29]).toBe('line-49')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('returns large session previews from the tail with byte cursors', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-preview-large-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const lines = Array.from(
      { length: 5200 },
      (_, index) => `line-${String(index).padStart(4, '0')}-🙂-${'x'.repeat(1000)}`
    )
    await fs.writeFile(logPath, `${lines.join('\r\n')}\r\n`)

    seedRecord(
      makeRecord({
        sessionId: 'session-preview-large',
        logFilePath: logPath,
        displayName: 'Large Preview',
        projectPath: '/tmp/preview',
        agentType: 'codex',
      })
    )

    try {
      const response = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/session-preview/session-preview-large?limit=25'),
        {} as Bun.Server<unknown>
      )

      if (!response) {
        throw new Error('Expected response for large session preview')
      }

      expect(response.ok).toBe(true)
      const payload = (await response.json()) as {
        totalLines: number | null
        startByte: number
        endByte: number
        hasMoreBefore: boolean
        lines: string[]
        lineKeys: string[]
      }
      expect(payload.totalLines).toBeNull()
      expect(payload.hasMoreBefore).toBe(true)
      expect(payload.lines).toHaveLength(25)
      expect(payload.lines[0]?.startsWith('line-5175-')).toBe(true)
      expect(payload.lines[24]?.startsWith('line-5199-')).toBe(true)
      expect(payload.lines[0]).toContain('🙂')
      expect(payload.lines.join('\n')).not.toContain('�')
      expect(payload.startByte).toBeLessThan(payload.endByte)
      expect(payload.lineKeys).toHaveLength(25)
      expect(payload.lineKeys[0]).toMatch(/^b:\d+$/)
      expect(payload.lineKeys[0]).toBe(`b:${payload.startByte}`)

      const earlierResponse = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request(
          `http://localhost/api/session-preview/session-preview-large?limit=25&beforeByte=${payload.startByte}`
        ),
        {} as Bun.Server<unknown>
      )

      if (!earlierResponse) {
        throw new Error('Expected earlier response for large session preview')
      }

      expect(earlierResponse.ok).toBe(true)
      const earlierPayload = (await earlierResponse.json()) as {
        totalLines: number | null
        endByte: number
        lines: string[]
      }
      expect(earlierPayload.totalLines).toBeNull()
      expect(earlierPayload.endByte).toBe(payload.startByte)
      expect(earlierPayload.lines).toHaveLength(25)
      expect(earlierPayload.lines[0]?.startsWith('line-5150-')).toBe(true)
      expect(earlierPayload.lines[24]?.startsWith('line-5174-')).toBe(true)
      expect(earlierPayload.lines[0]).toContain('🙂')
      expect(earlierPayload.lines.join('\n')).not.toContain('�')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('serves fresh content after the preview log is rewritten', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-preview-refresh-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    await fs.writeFile(logPath, ['line-a', 'line-b'].join('\n'))

    seedRecord(
      makeRecord({
        sessionId: 'session-preview-refresh',
        logFilePath: logPath,
        displayName: 'Preview',
        projectPath: '/tmp/preview',
        agentType: 'codex',
      })
    )

    const request = () =>
      fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/session-preview/session-preview-refresh'),
        {} as Bun.Server<unknown>
      )

    try {
      const first = await request()
      if (!first) throw new Error('Expected first preview response')
      const firstPayload = (await first.json()) as { totalLines: number; lines: string[] }
      expect(firstPayload.totalLines).toBe(2)
      expect(firstPayload.lines).toEqual(['line-a', 'line-b'])

      // Rewrite with different content (and different size) so size+mtime keying
      // invalidates the cached line array instead of serving stale data.
      await fs.writeFile(logPath, ['line-c', 'line-d', 'line-e'].join('\n'))

      const second = await request()
      if (!second) throw new Error('Expected second preview response')
      const secondPayload = (await second.json()) as { totalLines: number; lines: string[] }
      expect(secondPayload.totalLines).toBe(3)
      expect(secondPayload.lines).toEqual(['line-c', 'line-d', 'line-e'])
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('treats empty limit/beforeLine query params as absent', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-preview-empty-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    await fs.writeFile(logPath, ['line-0', 'line-1', 'line-2', 'line-3', 'line-4'].join('\n'))

    seedRecord(
      makeRecord({
        sessionId: 'session-preview-empty',
        logFilePath: logPath,
        displayName: 'Preview',
        projectPath: '/tmp/preview',
        agentType: 'codex',
      })
    )

    try {
      const response = await fetchHandler.call(
        {} as Bun.Server<unknown>,
        new Request('http://localhost/api/session-preview/session-preview-empty?limit=&beforeLine='),
        {} as Bun.Server<unknown>
      )

      if (!response) {
        throw new Error('Expected response for session preview')
      }

      expect(response.ok).toBe(true)
      const payload = (await response.json()) as {
        totalLines: number
        startLine: number
        endLine: number
        hasMoreBefore: boolean
        lines: string[]
      }
      // Empty limit must fall back to the default window, not collapse to 1 line
      // (Number('') === 0 -> Math.max(1, 0) === 1), and empty beforeLine must mean
      // "latest" rather than "before line 0".
      expect(payload.totalLines).toBe(5)
      expect(payload.startLine).toBe(0)
      expect(payload.endLine).toBe(5)
      expect(payload.hasMoreBefore).toBe(false)
      expect(payload.lines).toHaveLength(5)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('returns 404 when session preview log is missing', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    seedRecord(
      makeRecord({
        sessionId: 'missing-log',
        logFilePath: path.join('/tmp', 'missing-log.jsonl'),
      })
    )

    const response = await fetchHandler.call(
      {} as Bun.Server<unknown>,
      new Request('http://localhost/api/session-preview/missing-log'),
      {} as Bun.Server<unknown>
    )

    if (!response) {
      throw new Error('Expected response for missing log')
    }

    expect(response.status).toBe(404)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toBe('Log file not found')
  })
})

describe('server startup side effects', () => {
  test('prunes unattached websocket sessions after startup session recovery', async () => {
    const calls: string[][] = []
    sessionManagerState.ensureSession = () => {
      calls.push(['ensure-session'])
      return { canPruneWsSessions: true }
    }
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      calls.push(command as string[])
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-sessions') {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            tmuxOutput(
              ['agentboard-ws-1', '0'],
              ['agentboard-ws-2', '1'],
              ['other', '0']
            )
          ),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (tmuxArgs[0] === 'kill-session') {
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    await loadIndex()

    const killCalls = calls.filter(
      (command) => getTmuxArgs(command)[0] === 'kill-session'
    )
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0]).toEqual(['tmux', 'kill-session', '-t', 'agentboard-ws-1'])
    expect(calls.findIndex((command) => command[0] === 'ensure-session')).toBeLessThan(
      calls.findIndex((command) => getTmuxArgs(command)[0] === 'kill-session')
    )
  })

  test('skips websocket session pruning when startup group recovery is unreliable', async () => {
    const calls: string[][] = []
    sessionManagerState.ensureSession = () => {
      calls.push(['ensure-session'])
      return { canPruneWsSessions: false }
    }
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      calls.push(command as string[])
      const tmuxArgs = getTmuxArgs(command as string[])
      if (tmuxArgs[0] === 'list-sessions') {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            tmuxOutput(
              ['agentboard-ws-1', '0'],
              ['agentboard-ws-2', '0']
            )
          ),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    await loadIndex()

    expect(
      calls.some((command) => getTmuxArgs(command)[0] === 'kill-session')
    ).toBe(false)
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'ws_session_prune_skipped',
        data: { reason: 'session_group_lookup_unavailable' },
      })
    )
  })

  test('ping message returns pong and echoes seq when provided', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(ws as never, JSON.stringify({ type: 'ping' }))
    websocket.message?.(ws as never, JSON.stringify({ type: 'ping', seq: 123 }))

    expect(sent).toContainEqual({ type: 'pong' })
    expect(sent).toContainEqual({ type: 'pong', seq: 123 })
  })

  test('/api/client-log returns ok for valid JSON', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const server = {} as Bun.Server<unknown>
    const response = await fetchHandler.call(
      server,
      new Request('http://localhost/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'test_event', data: { foo: 'bar' } }),
      }),
      server
    )

    if (!response) {
      throw new Error('Expected response for client-log request')
    }

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { ok: boolean }
    expect(payload.ok).toBe(true)
  })

  test('/api/client-log handles malformed body gracefully', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const server = {} as Bun.Server<unknown>
    const response = await fetchHandler.call(
      server,
      new Request('http://localhost/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad-json}',
      }),
      server
    )

    if (!response) {
      throw new Error('Expected response for malformed client-log')
    }

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { ok: boolean }
    expect(payload.ok).toBe(true)
  })

  test('startup keeps hibernating sessions dormant', async () => {
    const sessionId = 'startup-hibernating'
    seedRecord(
      makeRecord({
        sessionId,
        displayName: 'startup-hibernating',
        currentWindow: null,
        isPinned: true,
        lastResumeError: 'resume artifact missing',
      })
    )

    let createCalls = 0
    sessionManagerState.createWindow = () => {
      createCalls += 1
      return {
        ...baseSession,
        id: 'startup-hibernating-created',
        name: 'startup-hibernating',
        tmuxWindow: 'agentboard:90',
      }
    }

    const { registryInstance } = await loadIndex()

    expect(createCalls).toBe(0)
    expect(dbState.updateCalls).toEqual([])
    expect(registryInstance.agentSessions.hibernating).toMatchObject([
      expect.objectContaining({
        sessionId,
        isPinned: true,
        lastResumeError: 'resume artifact missing',
      }),
    ])
  })

  test('does not run sync window verification before startup is ready', async () => {
    const syncCapturePaneCalls: string[][] = []
    seedRecord(
      makeRecord({
        sessionId: 'session-active',
        displayName: baseSession.name,
        currentWindow: baseSession.tmuxWindow,
        logFilePath: path.join('/tmp', 'session-active.jsonl'),
      })
    )
    sessionManagerState.listWindows = () => [baseSession]

    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      if (getTmuxArgs(command as string[])[0] === 'capture-pane') {
        syncCapturePaneCalls.push(command as string[])
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync
    bunAny.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const cmd = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            if (getTmuxArgs(cmd as string[])[0] === 'capture-pane') {
              controller.enqueue(new TextEncoder().encode(''))
            }
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        kill: () => {},
        pid: 12345,
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    await loadIndex()

    expect(serveOptions).not.toBeNull()
    expect(syncCapturePaneCalls).toHaveLength(0)
  })
})
