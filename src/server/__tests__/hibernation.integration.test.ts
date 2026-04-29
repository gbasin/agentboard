import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { initDatabase } from '../db'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
} from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(`${reasons.join(' and ')} - skipping hibernation integration test`, () => {})
} else {
  describe('hibernation integration', () => {
    const sessionName = `agentboard-hibernate-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-hibernate-${process.pid}-${Date.now()}.db`
    )
    const projectPath = process.cwd()
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let harnessInitialized = false
    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir } : { ...process.env }

    // Session ID for move-to-history test - seeded before server starts.
    const wsTestSessionId = `ws-history-test-${Date.now()}`

    async function startServer(extraEnv: Record<string, string> = {}, retries = 2) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        port = await getFreePort()
        const resumeCommand = 'sh -c "sleep 30" -- {sessionId}'
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          // Defaults that extraEnv can override
          CLAUDE_RESUME_CMD: resumeCommand,
          CODEX_RESUME_CMD: resumeCommand,
          TERMINAL_MODE: 'pty',
          ...extraEnv,
          // Test-critical fields that must not be overridden
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
        }
        if (tmuxTmpDir) {
          env.TMUX_TMPDIR = tmuxTmpDir
        }
        serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
          cwd: process.cwd(),
          env,
          stdout: 'ignore',
          stderr: 'ignore',
        })
        try {
          await waitForHealth(port, serverProcess)
          return
        } catch (err) {
          await shutdownProcess(serverProcess)
          serverProcess = null
          if (attempt === retries) throw err
        }
      }
    }

    async function stopServer() {
      if (serverProcess) {
        await shutdownProcess(serverProcess)
        serverProcess = null
      }
    }

    async function ensureHarnessReady() {
      if (!harnessInitialized) {
        tmuxTmpDir = createTmuxTmpDir()

        // Create the tmux session first so startup has a stable base session.
        Bun.spawnSync(['tmux', 'new-session', '-d', '-s', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: tmuxEnv(),
        })

        // Seed the database BEFORE starting the server to avoid SQLite locking issues
        const db = initDatabase({ path: dbPath })
        db.insertSession({
          sessionId: wsTestSessionId,
          logFilePath: `/tmp/ws-${wsTestSessionId}.jsonl`,
          projectPath,
          slug: null,
          agentType: 'claude',
          displayName: 'ws-history-test',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          lastUserMessage: null,
          currentWindow: null,
          isPinned: true,
          lastResumeError: null,
          lastKnownLogSize: null,
          isCodexExec: false,
          launchCommand: null,
        })
        db.close()
        harnessInitialized = true
      }

      if (!serverProcess) {
        await startServer()
      }
    }

    afterAll(async () => {
      await stopServer()
      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: tmuxEnv(),
        })
      } catch {
        // ignore cleanup errors
      }
      if (tmuxTmpDir) {
        try {
          fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
      try {
        fs.unlinkSync(dbPath)
      } catch {
        // ignore cleanup errors
      }
    })

    test(
      'hibernating session stays dormant after server restart',
      async () => {
        await ensureHarnessReady()
        const baselineWindows = listTmuxWindows(sessionName, tmuxEnv())
        await stopServer()

        const dormantSessionId = `hibernate-restart-${Date.now()}`
        const db = initDatabase({ path: dbPath })
        db.insertSession({
          sessionId: dormantSessionId,
          logFilePath: `/tmp/${dormantSessionId}.jsonl`,
          projectPath,
          slug: null,
          agentType: 'claude',
          displayName: 'hibernate-restart',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          lastUserMessage: null,
          currentWindow: null,
          isPinned: true,
          lastResumeError: null,
          lastKnownLogSize: null,
          isCodexExec: false,
          launchCommand: null,
        })
        db.close()

        await startServer()

        const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
        const payloadPromise = waitForAgentSessionsContaining(
          ws,
          'hibernating',
          dormantSessionId
        )
        await waitForOpen(ws)
        const payload = await payloadPromise
        expect(payload.hibernating.some((session) => session.sessionId === dormantSessionId)).toBe(true)
        ws.close()

        await delay(500)
        const windowsAfterStart = listTmuxWindows(sessionName, tmuxEnv())
        expect(windowsAfterStart).toEqual(baselineWindows)

        const verifyDb = initDatabase({ path: dbPath })
        const dormant = verifyDb.getSessionById(dormantSessionId)
        verifyDb.close()
        expect(dormant?.isPinned).toBe(true)
        expect(dormant?.currentWindow).toBe(null)
        expect(dormant?.lastResumeError).toBe(null)
      },
      25000
    )

    test('move-to-history via websocket clears the hibernation marker', async () => {
      await ensureHarnessReady()
      const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
      await waitForOpen(ws)

      ws.send(
        JSON.stringify({
          type: 'session-move-to-history',
          sessionId: wsTestSessionId,
        })
      )

      const result = await waitForMessage(ws, 'session-move-to-history-result')
      expect(result.ok).toBe(true)
      expect(result.sessionId).toBe(wsTestSessionId)
      expect((result.session as { isPinned?: boolean }).isPinned).toBe(false)

      const db = initDatabase({ path: dbPath })
      const record = db.getSessionById(wsTestSessionId)
      db.close()
      expect(record?.isPinned).toBe(false)
      expect(record?.currentWindow).toBe(null)

      ws.close()
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ port: 0, host: testHost }, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Unable to allocate port')))
      }
    })
  })
}

async function waitForHealth(
  port: number,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 10000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Fail fast if process crashed
    if (proc.exitCode !== null) {
      throw new Error(`Server process exited with code ${proc.exitCode}`)
    }
    try {
      const response = await fetch(`http://${testHost}:${port}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await delay(100)
  }
  throw new Error('Server did not become healthy in time')
}

function listTmuxWindows(
  sessionName: string,
  env?: NodeJS.ProcessEnv
): string[] {
  const result = Bun.spawnSync(
    [
      'tmux',
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{session_name}:#{window_id}',
    ],
    { stdout: 'pipe', stderr: 'pipe', env }
  )
  if (result.exitCode !== 0) {
    return []
  }
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WebSocket open timeout'))
    }, timeoutMs)
    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket error'))
    }
  })
}

async function waitForAgentSessionsContaining(
  ws: WebSocket,
  bucket: 'hibernating' | 'history',
  sessionId: string,
  timeoutMs = 5000
): Promise<{
  hibernating: Array<{ sessionId: string }>
  history: Array<{ sessionId: string }>
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`Timed out waiting for ${sessionId} in ${bucket}`))
    }, timeoutMs)

    const handler = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as Record<string, unknown>
        if (payload.type !== 'agent-sessions') {
          return
        }
        const hibernating = Array.isArray(payload.hibernating)
          ? payload.hibernating as Array<{ sessionId: string }>
          : []
        const history = Array.isArray(payload.history)
          ? payload.history as Array<{ sessionId: string }>
          : []
        if ((bucket === 'hibernating' ? hibernating : history).some((session) => session.sessionId === sessionId)) {
          clearTimeout(timeout)
          ws.removeEventListener('message', handler)
          resolve({ hibernating, history })
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.addEventListener('message', handler)
  })
}

async function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${type} message`))
    }, timeoutMs)

    const handler = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as Record<string, unknown>
        if (payload.type === type) {
          clearTimeout(timeout)
          ws.removeEventListener('message', handler)
          resolve(payload)
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.addEventListener('message', handler)
  })
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shutdownProcess(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 3000
) {
  try {
    proc.kill()
  } catch {
    return
  }

  const exited = proc.exited.catch(() => {})
  const timedOut = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs)
  })

  if ((await Promise.race([exited, timedOut])) === 'timeout') {
    try {
      proc.kill('SIGKILL')
    } catch {
      return
    }
    await proc.exited.catch(() => {})
  }
}
