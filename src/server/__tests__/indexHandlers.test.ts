import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import type { Session, ServerMessage } from '@shared/types'

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

  get(id: string) {
    return this.sessions.find((session) => session.id === id)
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

mock.module('../config', () => ({
  config: {
    port: 4040,
    refreshIntervalMs: 1000,
    tmuxSession: 'agentboard',
    persistentClient: true,
    discoverPrefixes: [],
    tlsCert: '',
    tlsKey: '',
  },
}))
mock.module('../SessionManager', () => ({
  SessionManager: SessionManagerMock,
}))
mock.module('../SessionRegistry', () => ({
  SessionRegistry: SessionRegistryMock,
}))
mock.module('../TerminalProxy', () => ({
  TerminalProxy: TerminalProxyMock,
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
      terminals: new Map<string, TerminalProxyMock>(),
      terminal: null as TerminalProxyMock | null,
      currentSessionId: null,
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

beforeEach(() => {
  serveOptions = null
  replaceSessionsCalls = []
  TerminalProxyMock.instances = []
  SessionManagerMock.instance = null
  SessionRegistryMock.instance = null
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

    const nextSession = { ...baseSession, id: 'session-2', name: 'beta' }
    registryInstance.emit('session-update', nextSession)
    registryInstance.emit('sessions', [baseSession, nextSession])

    expect(sent[1]).toEqual({ type: 'session-update', session: nextSession })
    expect(sent[2]).toEqual({
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

    expect(listCalls).toBe(2)
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
    const { serveOptions, registryInstance } = await loadIndex()
    registryInstance.sessions = [
      { ...baseSession, id: 'external', source: 'external' },
    ]

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

    expect(sent[0]).toEqual({ type: 'error', message: 'Session not found' })
    expect(sent[1]).toEqual({
      type: 'error',
      message: 'Cannot kill external sessions',
    })
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

    expect(sent[sent.length - 2]).toEqual({ type: 'error', message: 'boom' })
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
})
