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
    const projectPath = process.cwd()
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let baselineWindows: string[] = []
    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir } : { ...process.env }

    // Session ID for pin/unpin test - seeded before server starts
    const wsTestSessionId = `ws-pin-test-${Date.now()}`

    async function startServer(retries = 2) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        port = await getFreePort()
        const resumeCommand = 'sh -c "sleep 30" -- {sessionId}'
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
          // Use a long-lived command so windows stay open during the test
          CLAUDE_RESUME_CMD: resumeCommand,
          CODEX_RESUME_CMD: resumeCommand,
          // Ensure consistent startup regardless of CI terminal mode
          TERMINAL_MODE: 'pty',
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
          serverProcess.kill()
          await serverProcess.exited.catch(() => {})
          if (attempt === retries) throw err
        }
      }
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

      // Create the tmux session first (required for resurrection to work)
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
      baselineWindows = listTmuxWindows(sessionName, tmuxEnv())
    })

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
      'pinned session resurrects after server restart',
      async () => {
        // Timeout increased to 25s for CI stability - this test calls multiple
        // async waits (waitForWindowCount, waitForResurrectedSessionInDb, assertTmuxWindowExists)
      await stopServer()

      const resurrectSessionId = `pin-resurrect-${Date.now()}`
      const db = initDatabase({ path: dbPath })
      db.insertSession({
        sessionId: resurrectSessionId,
        logFilePath: `/tmp/${resurrectSessionId}.jsonl`,
        projectPath,
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
      await waitForWindowCount(
        sessionName,
        baselineWindows.length + 1,
        tmuxEnv(),
        8000
      )

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
      await assertTmuxWindowExists(
        sessionName,
        resurrected.currentWindow,
        tmuxEnv()
      )
      },
      25000
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
      const response = await fetch(`http://localhost:${port}/api/health`)
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

async function waitForResurrectedSessionInDb(
  sessionId: string,
  dbPath: string,
  timeoutMs = 15000
): Promise<AgentSessionRecord> {
  const start = Date.now()
  let lastRecord: AgentSessionRecord | null = null
  while (Date.now() - start < timeoutMs) {
    try {
      const db = initDatabase({ path: dbPath })
      const record = db.getSessionById(sessionId)
      db.close()
      if (record) {
        lastRecord = record
      }
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
  const detail = lastRecord?.lastResumeError
    ? ` Last resume error: ${lastRecord.lastResumeError}`
    : ''
  throw new Error(`Pinned session did not resurrect in time.${detail}`)
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

async function waitForWindowCount(
  sessionName: string,
  minCount: number,
  env?: NodeJS.ProcessEnv,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const windows = listTmuxWindows(sessionName, env)
    if (windows.length >= minCount) {
      return
    }
    await delay(150)
  }
  throw new Error(
    `Timed out waiting for tmux windows (expected >= ${minCount}) for ${sessionName}`
  )
}

async function assertTmuxWindowExists(
  sessionName: string,
  tmuxWindow: string,
  env?: NodeJS.ProcessEnv,
  maxAttempts = 20
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      if (attempt === maxAttempts) {
        throw new Error(
          `tmux list-windows failed after ${maxAttempts} attempts: ${result.stderr.toString()}`
        )
      }
      await delay(200)
      continue
    }
    const windows = result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (windows.includes(tmuxWindow)) {
      return // Success
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `tmux window not found after ${maxAttempts} attempts. Expected: ${tmuxWindow}, Found: [${windows.join(', ')}]`
      )
    }
    await delay(200)
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
