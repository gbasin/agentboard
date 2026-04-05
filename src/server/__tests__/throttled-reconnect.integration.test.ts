/**
 * throttled-reconnect.integration.test.ts
 *
 * Proves that the double-attach dedup fix reduces time-to-first-output on slow
 * connections.  A TCP-level throttling proxy sits between WebSocket clients and
 * the agentboard server, limiting server->client bandwidth to simulate TCP slow
 * start on a high-latency mobile connection.
 *
 * The pre-fix problem: When a mobile client reconnects, iOS Safari's page
 * lifecycle fires two WebSocket connections ~34ms apart.  Each connection sends
 * terminal-attach, and each gets the full ~18KB scrollback.  Through a
 * bandwidth-limited pipe, delivering 2x the data takes measurably longer.
 *
 * We simulate this by:
 *   Test A (pre-fix): Two separate WebSocket connections through the throttled
 *     proxy, both attaching to the same session.  The client doesn't see
 *     terminal-output until BOTH connections' initial payloads drain through
 *     the shared throttled TCP pipe.  We measure total bytes transferred and
 *     the time for the second (slower) connection to deliver terminal-output.
 *
 *   Test B (post-fix): One WebSocket connection through the throttled proxy,
 *     sending a single terminal-attach.  Only one scrollback payload drains.
 *
 * We measure:
 *   1. Total bytes transferred through the proxy (data volume reduction)
 *   2. Time from attach to terminal-output (latency improvement)
 *
 * The fix halves the data, which through a throttled pipe means measurably
 * faster time-to-first-output.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
  waitForTmuxWindows,
} from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping throttled-reconnect integration test`,
    () => {}
  )
} else {
  describe('throttled-reconnect: double-attach vs single-attach timing', () => {
    const sessionName = `agentboard-throttle-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-throttle-${process.pid}-${Date.now()}.db`
    )
    const logFilePath = path.join(
      os.tmpdir(),
      `agentboard-throttle-${process.pid}-${Date.now()}.log`
    )

    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let serverPort = 0
    let tmuxTmpDir: string | null = null
    let tmuxWindowTarget = ''
    let discoveredSessionId = ''

    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir
        ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
        : { ...process.env }

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir('agentboard-tt-')

      // Create tmux session
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
      const windows = await waitForTmuxWindows(sessionName, tmuxEnv())
      tmuxWindowTarget = windows[0]

      // Pump substantial content into the pane for scrollback history.
      // We want enough data that the bandwidth throttle makes a meaningful
      // difference between sending it once vs twice.
      for (let i = 0; i < 80; i++) {
        Bun.spawnSync(
          [
            'tmux',
            'send-keys',
            '-t',
            tmuxWindowTarget,
            `echo "scrollback-padding-line-${i}-${'x'.repeat(80)}"`,
            'Enter',
          ],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )
      }
      await delay(600)

      // Start the server
      serverPort = await getFreePort()
      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(serverPort),
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

      await waitForHealth(serverPort, serverProcess)

      // Discover the session ID
      const sessionsResp = await fetch(
        `http://${testHost}:${serverPort}/api/sessions`
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

    // ----------------------------------------------------------------
    // TCP throttling proxy
    // ----------------------------------------------------------------

    /**
     * Creates a TCP proxy that forwards connections to `targetPort`, but
     * throttles the server->client direction to `bytesPerSecond` and adds
     * `latencyMs` of delay to each server->client data delivery (simulating
     * high-RTT connections like 5G + Tailscale).  All connections through
     * this proxy share the bandwidth pool (simulating a single congested link).
     *
     * Returns { port, close, getTotalServerToClientBytes }.
     */
    function createThrottleProxy(
      targetPort: number,
      bytesPerSecond: number,
      latencyMs = 0
    ): Promise<{
      port: number
      close: () => void
      getTotalServerToClientBytes: () => number
    }> {
      return new Promise((resolve, reject) => {
        const CHUNK_INTERVAL_MS = 10
        const chunkSize = Math.max(
          1,
          Math.floor((bytesPerSecond * CHUNK_INTERVAL_MS) / 1000)
        )

        let totalServerToClientBytes = 0

        const connections: Array<{
          clientSocket: net.Socket
          serverSocket: net.Socket
        }> = []

        // Shared bandwidth pool across all connections
        const globalBuffer: Array<{
          data: Buffer
          clientSocket: net.Socket
        }> = []
        let globalBufferedBytes = 0

        const drainTimer = setInterval(() => {
          if (globalBufferedBytes === 0) return

          let toSend = chunkSize
          while (toSend > 0 && globalBuffer.length > 0) {
            const entry = globalBuffer[0]
            if (entry.data.length <= toSend) {
              try {
                entry.clientSocket.write(entry.data)
              } catch {
                // socket may be closed
              }
              toSend -= entry.data.length
              globalBufferedBytes -= entry.data.length
              globalBuffer.shift()
            } else {
              try {
                entry.clientSocket.write(entry.data.subarray(0, toSend))
              } catch {
                // socket may be closed
              }
              entry.data = entry.data.subarray(toSend)
              globalBufferedBytes -= toSend
              toSend = 0
            }
          }
        }, CHUNK_INTERVAL_MS)

        const server = net.createServer((clientSocket) => {
          const serverSocket = net.createConnection(
            { host: testHost, port: targetPort },
            () => {
              // Connection established
            }
          )

          // Client -> Server: forward immediately (upload is not throttled)
          clientSocket.on('data', (data) => {
            serverSocket.write(data)
          })

          // Server -> Client: buffer into shared pool and drip-feed
          // Add latency to simulate high-RTT connections (5G + Tailscale)
          serverSocket.on('data', (data) => {
            totalServerToClientBytes += data.length
            const bufferData = () => {
              globalBuffer.push({
                data: Buffer.from(data),
                clientSocket,
              })
              globalBufferedBytes += data.length
            }
            if (latencyMs > 0) {
              setTimeout(bufferData, latencyMs)
            } else {
              bufferData()
            }
          })

          const cleanup = () => {
            clientSocket.destroy()
            serverSocket.destroy()
          }

          clientSocket.on('close', cleanup)
          clientSocket.on('error', cleanup)
          serverSocket.on('close', cleanup)
          serverSocket.on('error', cleanup)

          connections.push({ clientSocket, serverSocket })
        })

        server.listen({ port: 0, host: testHost }, () => {
          const address = server.address()
          if (!address || typeof address !== 'object') {
            reject(new Error('Failed to get proxy address'))
            return
          }
          resolve({
            port: address.port,
            close: () => {
              clearInterval(drainTimer)
              for (const conn of connections) {
                conn.clientSocket.destroy()
                conn.serverSocket.destroy()
              }
              server.close()
            },
            getTotalServerToClientBytes: () => totalServerToClientBytes,
          })
        })

        server.on('error', reject)
      })
    }

    // ----------------------------------------------------------------
    // Measurement helpers
    // ----------------------------------------------------------------

    /** Helper: connect a WS, wait for sessions/config, return it ready. */
    async function connectAndHandshake(
      proxyPort: number,
      label: string
    ): Promise<{
      ws: WebSocket
      messages: Array<{ type: string; sessionId?: string; data?: string }>
    }> {
      const ws = new WebSocket(`ws://${testHost}:${proxyPort}/ws`)
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
        15000,
        `${label}: initial sessions/config`
      )

      return { ws, messages }
    }

    /**
     * Simulate the pre-fix double-attach scenario:
     * Two WebSocket connections through the SAME throttled proxy each send
     * terminal-attach.  Both get full scrollback since they are separate
     * connections (no per-ws dedup).  Because they share the proxy's
     * bandwidth, the second connection's data is queued behind the first.
     *
     * Returns time from first attach to the second connection receiving
     * terminal-output (the worst-case client experience).
     */
    async function measureDoubleAttach(
      proxyPort: number,
      label: string
    ): Promise<{ timeMs: number; totalOutputBytes: number }> {
      // Connect two WebSocket clients through the same proxy
      const conn1 = await connectAndHandshake(proxyPort, `${label}-ws1`)
      const conn2 = await connectAndHandshake(proxyPort, `${label}-ws2`)

      // Clear handshake messages
      conn1.messages.length = 0
      conn2.messages.length = 0

      const attachMsg = JSON.stringify({
        type: 'terminal-attach',
        sessionId: discoveredSessionId,
        tmuxTarget: tmuxWindowTarget,
        cols: 120,
        rows: 40,
      })

      // Send attach on first connection, then second 34ms later
      const t0 = performance.now()
      conn1.ws.send(attachMsg)
      await delay(34)
      conn2.ws.send(attachMsg)

      // Wait for BOTH connections to receive terminal-output
      await waitUntil(
        () =>
          conn1.messages.some(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          ) &&
          conn2.messages.some(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          ),
        20000,
        `${label}: both connections received terminal-output`
      )
      const timeMs = performance.now() - t0

      // Total output bytes across both connections
      const bytesFrom = (
        msgs: Array<{ type: string; sessionId?: string; data?: string }>
      ) =>
        msgs
          .filter(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          )
          .reduce((sum, m) => sum + (m.data?.length ?? 0), 0)

      const totalOutputBytes = bytesFrom(conn1.messages) + bytesFrom(conn2.messages)

      conn1.ws.close()
      conn2.ws.close()

      return { timeMs, totalOutputBytes }
    }

    /**
     * Simulate the post-fix single-attach scenario:
     * One WebSocket connection, one terminal-attach.  Only one scrollback
     * payload drains through the throttled pipe.
     */
    async function measureSingleAttach(
      proxyPort: number,
      label: string
    ): Promise<{ timeMs: number; totalOutputBytes: number }> {
      const conn = await connectAndHandshake(proxyPort, label)
      conn.messages.length = 0

      const attachMsg = JSON.stringify({
        type: 'terminal-attach',
        sessionId: discoveredSessionId,
        tmuxTarget: tmuxWindowTarget,
        cols: 120,
        rows: 40,
      })

      const t0 = performance.now()
      conn.ws.send(attachMsg)

      await waitUntil(
        () =>
          conn.messages.some(
            (m) =>
              m.type === 'terminal-output' &&
              m.sessionId === discoveredSessionId
          ),
        20000,
        `${label}: terminal-output`
      )
      const timeMs = performance.now() - t0

      const totalOutputBytes = conn.messages
        .filter(
          (m) =>
            m.type === 'terminal-output' &&
            m.sessionId === discoveredSessionId
        )
        .reduce((sum, m) => sum + (m.data?.length ?? 0), 0)

      conn.ws.close()

      return { timeMs, totalOutputBytes }
    }

    // ----------------------------------------------------------------
    // The actual test
    // ----------------------------------------------------------------

    test(
      'single-attach receives terminal-output faster than double-attach through throttled proxy',
      async () => {
        // 8KB/s bandwidth + 100ms latency: simulates 5G + Tailscale.
        // With chunking (12KB chunks), the first chunk fits in the initial
        // congestion window and arrives after ~1 RTT instead of waiting
        // for the full payload to drain.
        const BANDWIDTH_BPS = 8 * 1024
        const LATENCY_MS = 100

        const TRIALS = 3
        const doubleResults: Array<{ timeMs: number; totalOutputBytes: number }> = []
        const singleResults: Array<{ timeMs: number; totalOutputBytes: number }> = []

        for (let trial = 0; trial < TRIALS; trial++) {
          // --- Double-attach trial ---
          const proxyA = await createThrottleProxy(serverPort, BANDWIDTH_BPS, LATENCY_MS)
          try {
            // Wait for dedup window to expire
            await delay(600)
            const result = await measureDoubleAttach(
              proxyA.port,
              `double-trial-${trial + 1}`
            )
            doubleResults.push(result)
            console.log(
              `  [trial ${trial + 1}] double-attach: ${Math.round(result.timeMs)}ms, ` +
                `${result.totalOutputBytes} bytes, ` +
                `proxy sent ${proxyA.getTotalServerToClientBytes()} bytes total`
            )
          } finally {
            proxyA.close()
          }

          // --- Single-attach trial ---
          const proxyB = await createThrottleProxy(serverPort, BANDWIDTH_BPS, LATENCY_MS)
          try {
            await delay(600)
            const result = await measureSingleAttach(
              proxyB.port,
              `single-trial-${trial + 1}`
            )
            singleResults.push(result)
            console.log(
              `  [trial ${trial + 1}] single-attach: ${Math.round(result.timeMs)}ms, ` +
                `${result.totalOutputBytes} bytes, ` +
                `proxy sent ${proxyB.getTotalServerToClientBytes()} bytes total`
            )
          } finally {
            proxyB.close()
          }
        }

        // Use median to reduce outlier impact
        const median = (arr: number[]) => {
          const sorted = [...arr].sort((a, b) => a - b)
          return sorted[Math.floor(sorted.length / 2)]
        }

        const medianDouble = median(doubleResults.map((r) => r.timeMs))
        const medianSingle = median(singleResults.map((r) => r.timeMs))
        const improvement = ((medianDouble - medianSingle) / medianDouble) * 100

        const medianDoubleBytes = median(
          doubleResults.map((r) => r.totalOutputBytes)
        )
        const medianSingleBytes = median(
          singleResults.map((r) => r.totalOutputBytes)
        )

        console.log(
          `\n  [throttled-reconnect] Results (${TRIALS} trials each):` +
            `\n    Double-attach times: ${doubleResults.map((r) => `${Math.round(r.timeMs)}ms`).join(', ')}` +
            `\n    Single-attach times: ${singleResults.map((r) => `${Math.round(r.timeMs)}ms`).join(', ')}` +
            `\n    Median double-attach: ${Math.round(medianDouble)}ms (${medianDoubleBytes} bytes)` +
            `\n    Median single-attach: ${Math.round(medianSingle)}ms (${medianSingleBytes} bytes)` +
            `\n    Time improvement: ${improvement.toFixed(1)}%` +
            `\n    Data reduction: ${((1 - medianSingleBytes / medianDoubleBytes) * 100).toFixed(1)}%\n`
        )

        // The single-attach path should send roughly half the output data
        expect(medianSingleBytes).toBeLessThan(medianDoubleBytes * 0.75)

        // The single-attach path should be at least 30% faster through the
        // throttled pipe (it has half the data to drain)
        expect(medianSingle).toBeLessThan(medianDouble * 0.70)
      },
      120000
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
  timeoutMs = 10000
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
