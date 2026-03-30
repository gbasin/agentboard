/**
 * double-attach.integration.test.ts
 *
 * Reproduces and verifies the "slow first WebSocket message after reconnect"
 * issue where the client sends two terminal-attach messages ~34ms apart (double-
 * attach).  Each would cause the server to capture and send ~62KB of scrollback
 * history.  The server-side dedup logic should collapse the second attach into a
 * cheap terminal-ready acknowledgement, halving the data volume.
 *
 * The server has two dedup layers:
 *   1. terminalAttachSeq: rapid back-to-back attaches cancel the previous one
 *      before it completes (only the latest seq wins).
 *   2. lastAttachKey/lastAttachTs: if the first attach completes and a second
 *      arrives for the same session+target within 500ms, the second skips the
 *      expensive scrollback capture and just sends terminal-ready.
 *
 * This test exercises both layers with real server integration.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { canBindLocalhost, isTmuxAvailable } from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping double-attach integration test`,
    () => {}
  )
} else {
  describe('double-attach dedup integration', () => {
    const sessionName = `agentboard-dblattach-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-dblattach-${process.pid}-${Date.now()}.db`
    )
    const logFilePath = path.join(
      os.tmpdir(),
      `agentboard-dblattach-${process.pid}-${Date.now()}.log`
    )

    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let tmuxWindowTarget = ''
    let discoveredSessionId = ''

    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir
        ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
        : { ...process.env }

    beforeAll(async () => {
      tmuxTmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'agentboard-tmux-')
      )

      // Create a tmux session with a window
      Bun.spawnSync(
        [
          'tmux',
          'new-session',
          '-d',
          '-s',
          sessionName,
          '-x',
          '120',
          '-y',
          '40',
        ],
        { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
      )

      // Find the default window target
      const listResult = Bun.spawnSync(
        [
          'tmux',
          'list-windows',
          '-t',
          sessionName,
          '-F',
          '#{session_name}:#{window_id}',
        ],
        { stdout: 'pipe', stderr: 'pipe', env: tmuxEnv() }
      )
      const windows = listResult.stdout
        .toString()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (windows.length === 0) {
        throw new Error('Failed to create tmux session')
      }
      tmuxWindowTarget = windows[0]

      // Pump some content into the pane to generate scrollback history so
      // captureTmuxHistory returns non-empty data.
      for (let i = 0; i < 50; i++) {
        Bun.spawnSync(
          [
            'tmux',
            'send-keys',
            '-t',
            tmuxWindowTarget,
            `echo "scrollback line ${i}"`,
            'Enter',
          ],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )
      }
      // Give tmux a moment to process
      await delay(500)

      // Start the server
      port = await getFreePort()
      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
          TERMINAL_MODE: 'pty',
          LOG_LEVEL: 'debug',
          LOG_FILE: logFilePath,
          AGENTBOARD_LOG_MATCH_WORKER: 'false',
          ...(tmuxTmpDir ? { TMUX_TMPDIR: tmuxTmpDir } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      drainStream(serverProcess.stdout)
      drainStream(serverProcess.stderr)

      await waitForHealth(port, serverProcess)

      // Discover the actual session ID
      const sessionsResp = await fetch(
        `http://${testHost}:${port}/api/sessions`
      )
      const sessions = (await sessionsResp.json()) as Array<{
        id: string
        tmuxWindow: string
      }>
      const ourSession = sessions.find(
        (s) => s.tmuxWindow === tmuxWindowTarget
      )
      if (!ourSession) {
        throw new Error(
          `Server did not discover tmux window ${tmuxWindowTarget}. ` +
            `Found sessions: ${JSON.stringify(sessions.map((s) => s.tmuxWindow))}`
        )
      }
      discoveredSessionId = ourSession.id
    }, 20000)

    afterAll(async () => {
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore
        }
      }

      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: tmuxEnv(),
        })
      } catch {
        // ignore
      }

      for (const f of [dbPath, logFilePath]) {
        try {
          fs.unlinkSync(f)
        } catch {
          // ignore
        }
      }

      if (tmuxTmpDir) {
        try {
          fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })

    test(
      'rapid back-to-back terminal-attach: seq mechanism cancels first attach',
      async () => {
        // When two terminal-attach messages arrive before either completes,
        // the terminalAttachSeq mechanism cancels the first one (only the
        // latest seq wins).  This results in ONE terminal-ready and ONE
        // scrollback from the surviving (second) attach.
        const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
        await waitForOpen(ws)

        const messages: Array<{
          type: string
          sessionId?: string
          data?: string
        }> = []
        ws.onmessage = (event) => {
          try {
            messages.push(JSON.parse(String(event.data)))
          } catch {
            // ignore
          }
        }

        await waitUntil(
          () =>
            messages.some((m) => m.type === 'sessions') &&
            messages.some((m) => m.type === 'server-config'),
          5000,
          'initial sessions/config messages'
        )
        messages.length = 0

        // Send two terminal-attach messages back-to-back.
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: discoveredSessionId,
            tmuxTarget: tmuxWindowTarget,
            cols: 120,
            rows: 40,
          })
        )
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: discoveredSessionId,
            tmuxTarget: tmuxWindowTarget,
            cols: 120,
            rows: 40,
          })
        )

        // Wait for at least one terminal-ready
        await waitUntil(
          () =>
            messages.some(
              (m) =>
                m.type === 'terminal-ready' &&
                m.sessionId === discoveredSessionId
            ),
          10000,
          'at least one terminal-ready message'
        )
        await delay(1000)

        // Only ONE terminal-ready should be emitted (from the winning attach).
        // The scrollback history (terminal-output) appears BEFORE terminal-ready
        // in the message stream.  Count how many terminal-output messages appear
        // before the first terminal-ready — that is the scrollback.  Anything
        // after terminal-ready is live pty output and should not be counted.
        const terminalReadys = messages.filter(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === discoveredSessionId
        )
        expect(terminalReadys.length).toBe(1)

        // Find the index of the first terminal-ready
        const readyIndex = messages.findIndex(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === discoveredSessionId
        )

        // Count scrollback outputs: terminal-output messages for our session
        // that arrived BEFORE the terminal-ready.
        const scrollbackOutputs = messages
          .slice(0, readyIndex)
          .filter(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          )

        // Exactly one scrollback capture from the winning attach
        expect(scrollbackOutputs.length).toBe(1)

        ws.close()
      },
      20000
    )

    test(
      'second terminal-attach within 500ms after first completes triggers dedup',
      async () => {
        // This test exercises the lastAttachKey/lastAttachTs dedup layer.
        // We let the first attach complete fully, then send a second one
        // within 500ms.  The server should skip scrollback capture for the
        // second and only send terminal-ready.
        const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
        await waitForOpen(ws)

        const messages: Array<{
          type: string
          sessionId?: string
          data?: string
        }> = []
        ws.onmessage = (event) => {
          try {
            messages.push(JSON.parse(String(event.data)))
          } catch {
            // ignore
          }
        }

        await waitUntil(
          () =>
            messages.some((m) => m.type === 'sessions') &&
            messages.some((m) => m.type === 'server-config'),
          5000,
          'initial sessions/config messages'
        )
        messages.length = 0

        // Step 1: Send the first terminal-attach and wait for it to complete
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: discoveredSessionId,
            tmuxTarget: tmuxWindowTarget,
            cols: 120,
            rows: 40,
          })
        )

        await waitUntil(
          () =>
            messages.some(
              (m) =>
                m.type === 'terminal-ready' &&
                m.sessionId === discoveredSessionId
            ),
          10000,
          'first terminal-ready'
        )

        // Verify: one terminal-ready, and one scrollback output before it
        const firstReadyIndex = messages.findIndex(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === discoveredSessionId
        )
        const scrollbacksBeforeFirstReady = messages
          .slice(0, firstReadyIndex)
          .filter(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          )
        expect(scrollbacksBeforeFirstReady.length).toBe(1)

        // Record the total message count so we can isolate second-attach messages
        const messagesBeforeSecondAttach = messages.length

        // Step 2: Send the second terminal-attach immediately (well within 500ms).
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: discoveredSessionId,
            tmuxTarget: tmuxWindowTarget,
            cols: 120,
            rows: 40,
          })
        )

        // Wait for the second terminal-ready
        await waitUntil(
          () =>
            messages.filter(
              (m) =>
                m.type === 'terminal-ready' &&
                m.sessionId === discoveredSessionId
            ).length >= 2,
          10000,
          'second terminal-ready from dedup path'
        )

        // Give a moment for any trailing messages
        await delay(200)

        // Look at messages received AFTER the second attach was sent.
        const secondAttachMessages = messages.slice(messagesBeforeSecondAttach)

        // Find the second terminal-ready in the new batch
        const secondReadyIndex = secondAttachMessages.findIndex(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === discoveredSessionId
        )
        expect(secondReadyIndex).not.toBe(-1)

        // Count scrollback outputs before the second terminal-ready:
        // The dedup path should NOT have sent any scrollback.
        const scrollbacksBeforeSecondReady = secondAttachMessages
          .slice(0, secondReadyIndex)
          .filter(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          )
        expect(scrollbacksBeforeSecondReady.length).toBe(0)

        // Total terminal-ready count should be exactly 2
        const totalReadys = messages.filter(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === discoveredSessionId
        ).length
        expect(totalReadys).toBe(2)

        ws.close()

        // Verify the log file contains a terminal_attach_dedup event
        await delay(500) // allow pino to flush
        let logContent = ''
        try {
          logContent = fs.readFileSync(logFilePath, 'utf-8')
        } catch {
          // If log file doesn't exist (pino async flush), skip this check
        }
        if (logContent) {
          expect(logContent).toContain('terminal_attach_dedup')
        }
      },
      20000
    )

    test(
      'attaches for different sessions within 500ms are NOT deduped',
      async () => {
        // Create a second tmux window in the same session
        Bun.spawnSync(
          [
            'tmux',
            'new-window',
            '-t',
            sessionName,
            '-n',
            'second-window',
          ],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )

        // Find the new window target
        const listResult = Bun.spawnSync(
          [
            'tmux',
            'list-windows',
            '-t',
            sessionName,
            '-F',
            '#{session_name}:#{window_id}',
          ],
          { stdout: 'pipe', stderr: 'pipe', env: tmuxEnv() }
        )
        const allWindows = listResult.stdout
          .toString()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
        const secondWindow = allWindows.find((w) => w !== tmuxWindowTarget)
        if (!secondWindow) {
          throw new Error('Failed to create second tmux window')
        }

        // Add some content to the second window
        for (let i = 0; i < 30; i++) {
          Bun.spawnSync(
            [
              'tmux',
              'send-keys',
              '-t',
              secondWindow,
              `echo "window2 line ${i}"`,
              'Enter',
            ],
            { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
          )
        }
        await delay(500)

        // Trigger a server refresh so it discovers the new window
        const refreshWs = new WebSocket(`ws://${testHost}:${port}/ws`)
        await waitForOpen(refreshWs)
        const refreshMessages: Array<{
          type: string
          sessions?: Array<{ id: string; tmuxWindow: string }>
        }> = []
        refreshWs.onmessage = (event) => {
          try {
            refreshMessages.push(JSON.parse(String(event.data)))
          } catch {
            // ignore
          }
        }

        await waitUntil(
          () => refreshMessages.some((m) => m.type === 'sessions'),
          5000,
          'sessions message on refresh ws'
        )
        refreshWs.send(JSON.stringify({ type: 'session-refresh' }))

        // Wait for a sessions message that includes the second window
        await waitUntil(
          () =>
            refreshMessages.some(
              (m) =>
                m.type === 'sessions' &&
                Array.isArray(m.sessions) &&
                m.sessions.some((s) => s.tmuxWindow === secondWindow)
            ),
          5000,
          'sessions message with second window'
        )

        const sessionsMsg = refreshMessages
          .filter(
            (m) => m.type === 'sessions' && Array.isArray(m.sessions)
          )
          .pop()
        const secondSession = sessionsMsg?.sessions?.find(
          (s) => s.tmuxWindow === secondWindow
        )
        if (!secondSession) {
          throw new Error('Server did not discover second tmux window')
        }
        const secondSessionId = secondSession.id
        refreshWs.close()

        // Now connect a new WebSocket and attach to two DIFFERENT sessions rapidly
        const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
        await waitForOpen(ws)

        const messages: Array<{
          type: string
          sessionId?: string
          data?: string
        }> = []
        ws.onmessage = (event) => {
          try {
            messages.push(JSON.parse(String(event.data)))
          } catch {
            // ignore
          }
        }

        await waitUntil(
          () => messages.some((m) => m.type === 'sessions'),
          5000,
          'sessions message'
        )
        messages.length = 0

        // Attach to first session
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: discoveredSessionId,
            tmuxTarget: tmuxWindowTarget,
            cols: 120,
            rows: 40,
          })
        )

        // Immediately attach to a DIFFERENT session
        ws.send(
          JSON.stringify({
            type: 'terminal-attach',
            sessionId: secondSessionId,
            tmuxTarget: secondWindow,
            cols: 120,
            rows: 40,
          })
        )

        // Wait for terminal-ready for the second session (the most recent attach wins
        // via the seq mechanism since both share the same ws)
        await waitUntil(
          () =>
            messages.some(
              (m) =>
                m.type === 'terminal-ready' &&
                m.sessionId === secondSessionId
            ),
          10000,
          'terminal-ready for second session'
        )

        await delay(500)

        // The second session's attach should have scrollback output (not deduped
        // because it's a different session+target key)
        const readyIndex = messages.findIndex(
          (m) =>
            m.type === 'terminal-ready' &&
            m.sessionId === secondSessionId
        )
        const scrollbacksForSecond = messages
          .slice(0, readyIndex)
          .filter(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === secondSessionId
          )
        expect(scrollbacksForSecond.length).toBeGreaterThanOrEqual(1)

        ws.close()
      },
      25000
    )
  })
}

// --- Helper functions ---

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

async function waitForOpen(
  ws: WebSocket,
  timeoutMs = 5000
): Promise<void> {
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

/**
 * Polls a condition function until it returns true, or throws on timeout.
 */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

function drainStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
) {
  if (!stream || typeof stream === 'number') return
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const pump = async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  }
  void pump()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
