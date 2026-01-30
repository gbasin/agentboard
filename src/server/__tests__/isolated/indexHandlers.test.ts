import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Session, ServerMessage } from '@shared/types'
import type { AgentSessionRecord } from '../../db'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
  write: typeof Bun.write
}

const processAny = process as typeof process & {
  on: typeof process.on
  exit: typeof process.exit
}

const originalServe = bunAny.serve
const originalSpawnSync = bunAny.spawnSync
const originalWrite = bunAny.write
const originalSetInterval = globalThis.setInterval
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalProcessOn = processAny.on
const originalProcessExit = processAny.exit

let serveOptions: Parameters<typeof Bun.serve>[0] | null = null
let spawnSyncImpl: typeof Bun.spawnSync
let writeImpl: typeof Bun.write
let replaceSessionsCalls: Session[][] = []
let dbState: {
  records: Map<string, AgentSessionRecord>
  nextId: number
  updateCalls: Array<{ sessionId: string; patch: Partial<AgentSessionRecord> }>
  setPinnedCalls: Array<{ sessionId: string; isPinned: boolean }>
}

const defaultConfig = {
  port: 4040,
  hostname: '0.0.0.0',
  refreshIntervalMs: 1000,
  tmuxSession: 'agentboard',
  discoverPrefixes: [],
  pruneWsSessions: true,
  terminalMode: 'pty',
  terminalMonitorTargets: true,
  tlsCert: '',
  tlsKey: '',
  rgThreads: 1,
  logMatchWorker: false,
  logMatchProfile: false,
  claudeResumeCmd: 'claude --resume {sessionId}',
  codexResumeCmd: 'codex resume {sessionId}',
}

const configState = { ...defaultConfig }
const baseRecordTimestamp = new Date('2026-01-01T00:00:00.000Z').toISOString()

function resetDbState() {
  dbState = {
    records: new Map(),
    nextId: 1,
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
    agentType: 'claude',
    displayName: 'alpha',
    createdAt: baseRecordTimestamp,
    lastActivityAt: baseRecordTimestamp,
    lastUserMessage: null,
    currentWindow: null,
    isPinned: false,
    lastResumeError: null,
    lastKnownLogSize: null,
    isCodexExec: false,
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
}

class SessionRegistryMock {
  static instance: SessionRegistryMock | null = null
  sessions: Session[] = []
  agentSessions: { active: unknown[]; inactive: unknown[] } = {
    active: [],
    inactive: [],
  }
  listeners = new Map<string, Array<(payload: unknown) => void>>()

  constructor() {
    SessionRegistryMock.instance = this
  }

  replaceSessions(sessions: Session[]) {
    this.sessions = sessions
    replaceSessionsCalls.push(sessions)
    this.emit('sessions', sessions)
  }

  getAll() {
    return this.sessions
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

  setAgentSessions(active: unknown[], inactive: unknown[]) {
    this.agentSessions = { active, inactive }
    this.emit('agent-sessions', { active, inactive })
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

  write(data: string) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows })
  }

  dispose() {
    this.disposed = true
  }

  emitData(data: string) {
    this.options.onData(data)
  }

  emitExit() {
    this.options.onExit?.()
  }
}

mock.module('../../config', () => ({
  config: configState,
}))
mock.module('../../db', () => ({
  initDatabase: () => ({
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
    getInactiveSessions: (options?: { maxAgeHours?: number }) => {
      const inactive = Array.from(dbState.records.values()).filter(
        (record) => record.currentWindow === null
      )
      if (!options?.maxAgeHours) {
        return inactive
      }
      const cutoff = Date.now() - options.maxAgeHours * 60 * 60 * 1000
      return inactive.filter(
        (record) => new Date(record.lastActivityAt).getTime() > cutoff
      )
    },
    orphanSession: (sessionId: string) => {
      const record = dbState.records.get(sessionId)
      if (!record) return null
      const updated = { ...record, currentWindow: null }
      dbState.records.set(sessionId, updated)
      return updated
    },
    updateSession: (
      sessionId: string,
      patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
    ) => {
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
    getPinnedOrphaned: () =>
      Array.from(dbState.records.values()).filter(
        (record) => record.isPinned && record.currentWindow === null
      ),
    getAppSetting: () => null,
    setAppSetting: () => {},
    close: () => {},
  }),
}))
mock.module('../../SessionManager', () => ({
  SessionManager: SessionManagerMock,
}))
mock.module('../../SessionRegistry', () => ({
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

mock.module('../../terminal', () => ({
  createTerminalProxy: (options: ConstructorParameters<typeof TerminalProxyMock>[0]) =>
    new TerminalProxyMock(options),
  resolveTerminalMode: () => 'pty',
  TerminalProxyError: TerminalProxyErrorMock,
}))

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  source: 'managed',
}

function createWs() {
  const sent: ServerMessage[] = []
  const ws = {
    data: {
      terminal: null as TerminalProxyMock | null,
      currentSessionId: null as string | null,
      currentTmuxTarget: null as string | null,
      connectionId: 'ws-test',
    },
    send: (payload: string) => {
      sent.push(JSON.parse(payload) as ServerMessage)
    },
  }
  return { ws, sent }
}

let importCounter = 0

async function loadIndex() {
  importCounter += 1
  await import(`../../index?test=${importCounter}`)
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

beforeEach(() => {
  serveOptions = null
  replaceSessionsCalls = []
  TerminalProxyMock.instances = []
  SessionManagerMock.instance = null
  SessionRegistryMock.instance = null
  resetDbState()
  Object.assign(configState, defaultConfig)
  sessionManagerState = {
    listWindows: () => [],
    createWindow: () => ({ ...baseSession, id: 'created' }),
    killWindow: () => {},
    renameWindow: () => {},
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

afterEach(() => {
  bunAny.serve = originalServe
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

describe('server message handlers', () => {
  test('websocket open sends sessions and registry broadcasts', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [baseSession]

    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }
    websocket.open?.(ws as never)

    expect(sent[0]).toEqual({ type: 'sessions', sessions: [baseSession] })
    expect(sent[1]).toMatchObject({ type: 'agent-sessions' })

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

    // 3 calls: startup logging + initial sync refresh + post-resurrection refresh
    // (message refresh uses async worker, not sessionManager.listWindows)
    expect(listCalls).toBe(3)
    expect(replaceSessionsCalls).toHaveLength(2)

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

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-create',
        projectPath: '/tmp/new',
      })
    )

    expect(sent[sent.length - 1]).toEqual({
      type: 'error',
      message: 'explode',
    })
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

    // Wait for async attach operations to complete
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
        type: 'terminal-resize',
        sessionId: baseSession.id,
        cols: 120,
        rows: 40,
      })
    )

    expect(attached?.writes).toEqual(['ls'])
    expect(attached?.resizes).toEqual([{ cols: 120, rows: 40 }])

    attached?.emitData('output')
    expect(sent.some((message) => message.type === 'terminal-output')).toBe(true)

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
      if (command[0] === 'tmux' && command[1] === 'send-keys') {
        sendKeysTarget = command[4] ?? ''
      }
      if (command[0] === 'tmux' && command[1] === 'display-message') {
        displayTarget = command[4] ?? ''
        return {
          exitCode: 0,
          stdout: Buffer.from('1\n'),
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

    const statusMessage = sent.find(
      (message) => message.type === 'tmux-copy-mode-status'
    )
    expect(statusMessage).toEqual({
      type: 'tmux-copy-mode-status',
      sessionId: baseSession.id,
      inCopyMode: true,
    })
  })

  test('pins and unpins sessions with validation', async () => {
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [{ ...baseSession, agentSessionId: baseSession.id }]
    seedRecord(
      makeRecord({
        sessionId: baseSession.id,
        currentWindow: baseSession.tmuxWindow,
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
        type: 'session-pin',
        sessionId: baseSession.id,
        isPinned: 'yes',
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-pin-result',
      sessionId: baseSession.id,
      ok: false,
      error: 'isPinned must be a boolean',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-pin',
        sessionId: 'bad id',
        isPinned: true,
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-pin-result',
      sessionId: 'bad id',
      ok: false,
      error: 'Invalid session id',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-pin',
        sessionId: 'missing',
        isPinned: true,
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-pin-result',
      sessionId: 'missing',
      ok: false,
      error: 'Session not found',
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-pin',
        sessionId: baseSession.id,
        isPinned: true,
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-pin-result',
      sessionId: baseSession.id,
      ok: true,
    })
    expect(dbState.updateCalls).toHaveLength(1)
    expect(dbState.updateCalls[0]?.patch).toMatchObject({
      isPinned: true,
      lastResumeError: null,
    })
    expect(registryInstance.sessions[0]?.isPinned).toBe(true)

    websocket.message?.(
      ws as never,
      JSON.stringify({
        type: 'session-pin',
        sessionId: baseSession.id,
        isPinned: false,
      })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-pin-result',
      sessionId: baseSession.id,
      ok: true,
    })
    expect(dbState.setPinnedCalls).toEqual([
      { sessionId: baseSession.id, isPinned: false },
    ])
    expect(registryInstance.sessions[0]?.isPinned).toBe(false)
  })

  test('validates session resume errors', async () => {
    const { serveOptions } = await loadIndex()
    const { ws, sent } = createWs()
    const websocket = serveOptions.websocket
    if (!websocket) {
      throw new Error('WebSocket handlers not configured')
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-resume', sessionId: 'bad id' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-resume-result',
      sessionId: 'bad id',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Invalid session id' },
    })

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-resume', sessionId: 'missing' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-resume-result',
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
      JSON.stringify({ type: 'session-resume', sessionId: 'active-session' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-resume-result',
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
      JSON.stringify({ type: 'session-resume', sessionId: 'bad-template' })
    )
    expect(sent[sent.length - 1]).toEqual({
      type: 'session-resume-result',
      sessionId: 'bad-template',
      ok: false,
      error: {
        code: 'RESUME_FAILED',
        message: 'Resume command template missing {sessionId} placeholder',
      },
    })
  })

  test('resumes sessions and broadcasts activation', async () => {
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
    })
    seedRecord(record)

    let createArgs: { projectPath: string; name?: string; command?: string } | null = null
    const createdSession: Session = {
      ...baseSession,
      id: 'created-session',
      name: 'resume',
      tmuxWindow: 'agentboard:99',
    }
    sessionManagerState.createWindow = (projectPath, name, command) => {
      createArgs = { projectPath, name, command }
      return createdSession
    }

    websocket.message?.(
      ws as never,
      JSON.stringify({ type: 'session-resume', sessionId: 'resume-ok' })
    )

    expect(createArgs).not.toBeNull()
    expect(createArgs!).toEqual({
      projectPath: '/tmp/resume',
      name: 'resume',
      command: 'claude --resume resume-ok',
    })
    expect(dbState.updateCalls[0]?.patch).toMatchObject({
      currentWindow: createdSession.tmuxWindow,
      displayName: createdSession.name,
      lastResumeError: null,
    })

    const resumeMessage = sent.find(
      (message) => message.type === 'session-resume-result' && message.ok
    )
    expect(resumeMessage).toEqual({
      type: 'session-resume-result',
      sessionId: 'resume-ok',
      ok: true,
      session: createdSession,
    })

    const activatedMessage = sent.find(
      (message) => message.type === 'session-activated'
    )
    expect(activatedMessage).toMatchObject({
      type: 'session-activated',
      window: createdSession.tmuxWindow,
    })

    expect(registryInstance.sessions[0]?.id).toBe(createdSession.id)
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
    }
    expect(payload.port).toBe(4040)
    expect(payload.protocol).toBe('http')
    expect(payload.tailscaleIp).toBe('100.64.0.42')
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

  test('returns session preview for existing logs', async () => {
    const { serveOptions } = await loadIndex()
    const fetchHandler = serveOptions.fetch
    if (!fetchHandler) {
      throw new Error('Fetch handler not configured')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-preview-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`)
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
        lines: string[]
      }
      expect(payload.sessionId).toBe('session-preview')
      expect(payload.displayName).toBe('Preview')
      expect(payload.projectPath).toBe('/tmp/preview')
      expect(payload.agentType).toBe('codex')
      expect(payload.lines).toHaveLength(100)
      expect(payload.lines[0]).toBe('line-20')
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
  test('prunes unattached websocket sessions on startup', async () => {
    const calls: string[][] = []
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0] : [String(args[0])]
      calls.push(command as string[])
      if (command[0] === 'tmux' && command[1] === 'list-sessions') {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            ['agentboard-ws-1\t0', 'agentboard-ws-2\t1', 'other\t0'].join('\n')
          ),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command[0] === 'tmux' && command[1] === 'kill-session') {
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
      (command) => command[0] === 'tmux' && command[1] === 'kill-session'
    )
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0]).toEqual(['tmux', 'kill-session', '-t', 'agentboard-ws-1'])
  })
})
