import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { initDatabase } from '../db'
import type { AgentSessionRecord } from '../db'

const tmuxAvailable = (() => {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
})()

if (!tmuxAvailable) {
  test.skip('tmux not available - skipping pin sessions integration test', () => {})
} else {
  describe('pin sessions integration', () => {
    const sessionName = `agentboard-pin-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-pin-${process.pid}-${Date.now()}.db`
    )
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    const originalTmuxTmpDir = process.env.TMUX_TMPDIR
    let tmuxTmpDir: string | null = null

    // Session ID for pin/unpin test - seeded before server starts
    const wsTestSessionId = `ws-pin-test-${Date.now()}`

    async function startServer() {
      port = await getFreePort()
      const resumeCommand = 'sh -c "sleep 30" -- {sessionId}'
      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
          // Use a long-lived command so windows stay open during the test
          CLAUDE_RESUME_CMD: resumeCommand,
          CODEX_RESUME_CMD: resumeCommand,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await waitForHealth(port)
    }

    async function stopServer() {
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore shutdown errors
        }
        serverProcess = null
      }
    }

    beforeAll(async () => {
      tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tmux-'))
      process.env.TMUX_TMPDIR = tmuxTmpDir

      // Create the tmux session first (required for resurrection to work)
      Bun.spawnSync(['tmux', 'new-session', '-d', '-s', sessionName], {
        stdout: 'ignore',
        stderr: 'ignore',
      })

      // Seed the database BEFORE starting the server to avoid SQLite locking issues
      const db = initDatabase({ path: dbPath })
      db.insertSession({
        sessionId: wsTestSessionId,
        logFilePath: `/tmp/ws-${wsTestSessionId}.jsonl`,
        projectPath: os.tmpdir(),
        agentType: 'claude',
        displayName: 'ws-pin-test',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: `${sessionName}:1`, // active
        isPinned: false,
        lastResumeError: null,
      })
      db.close()

      await startServer()
    })

    afterAll(async () => {
      await stopServer()
      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
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
      if (originalTmuxTmpDir === undefined) {
        delete process.env.TMUX_TMPDIR
      } else {
        process.env.TMUX_TMPDIR = originalTmuxTmpDir
      }
      try {
        fs.unlinkSync(dbPath)
      } catch {
        // ignore cleanup errors
      }
    })

    test(
      'pinned session resurrects after server restart',
      async () => {
      await stopServer()

      const resurrectSessionId = `pin-resurrect-${Date.now()}`
      const db = initDatabase({ path: dbPath })
      db.insertSession({
        sessionId: resurrectSessionId,
        logFilePath: `/tmp/${resurrectSessionId}.jsonl`,
        projectPath: os.tmpdir(),
        agentType: 'claude',
        displayName: 'pin-resurrect',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: null,
        isPinned: true,
        lastResumeError: null,
      })
      db.close()

      await startServer()

      const resurrected = await waitForResurrectedSessionInDb(
        resurrectSessionId,
        dbPath
      )
      expect(resurrected.isPinned).toBe(true)
      expect(resurrected.lastResumeError).toBe(null)
      expect(resurrected.currentWindow).not.toBe(null)
      if (!resurrected.currentWindow) {
        throw new Error('Resurrected session missing current window')
      }
      expect(resurrected.currentWindow.startsWith(`${sessionName}:`)).toBe(true)
      assertTmuxWindowExists(sessionName, resurrected.currentWindow)
      },
      15000
    )

    // Note: "failed resurrection unpins session" test is not included because
    // createWindow doesn't fail on invalid paths - tmux still creates the window.
    // The unpin-on-failure path is only hit if tmux itself fails (rare).

    test('pin/unpin via websocket', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`)
      await waitForOpen(ws)

      // Session was seeded in beforeAll to avoid SQLite locking issues

      // Pin via websocket
      ws.send(
        JSON.stringify({
          type: 'session-pin',
          sessionId: wsTestSessionId,
          isPinned: true,
        })
      )

      const pinResult = await waitForMessage(ws, 'session-pin-result')
      expect(pinResult.ok).toBe(true)
      expect(pinResult.sessionId).toBe(wsTestSessionId)

      // Unpin via websocket
      ws.send(
        JSON.stringify({
          type: 'session-pin',
          sessionId: wsTestSessionId,
          isPinned: false,
        })
      )

      const unpinResult = await waitForMessage(ws, 'session-pin-result')
      expect(unpinResult.ok).toBe(true)
      expect(unpinResult.sessionId).toBe(wsTestSessionId)

      ws.close()
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, () => {
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

async function waitForHealth(port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await delay(150)
  }
  throw new Error('Server did not become healthy in time')
}

async function waitForResurrectedSessionInDb(
  sessionId: string,
  dbPath: string,
  timeoutMs = 8000
): Promise<AgentSessionRecord> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const db = initDatabase({ path: dbPath })
      const record = db.getSessionById(sessionId)
      db.close()
      if (
        record &&
        record.isPinned &&
        record.currentWindow &&
        !record.lastResumeError
      ) {
        return record
      }
    } catch {
      // retry
    }
    await delay(150)
  }
  throw new Error('Pinned session did not resurrect in time')
}

function assertTmuxWindowExists(sessionName: string, tmuxWindow: string) {
  const result = Bun.spawnSync(
    ['tmux', 'list-windows', '-t', sessionName, '-F', '#{session_name}:#{window_id}'],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (result.exitCode !== 0) {
    throw new Error('tmux list-windows failed')
  }
  const windows = result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!windows.includes(tmuxWindow)) {
    throw new Error(`tmux window not found: ${tmuxWindow}`)
  }
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
