import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'

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
  test.skip('tmux not available - skipping integration test', () => {})
} else {
  describe('integration', () => {
    const sessionName = `agentboard-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0

    beforeAll(async () => {
      port = await getFreePort()

      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      drainStream(serverProcess.stdout)
      drainStream(serverProcess.stderr)

      await waitForHealth(port)
    })

    afterAll(async () => {
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore shutdown errors
        }
      }

      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      } catch {
        // ignore cleanup errors
      }
    })

    test('health endpoint responds', async () => {
      const response = await fetch(`http://localhost:${port}/api/health`)
      expect(response.ok).toBe(true)
      const payload = (await response.json()) as { ok: boolean }
      expect(payload.ok).toBe(true)
    })

    test('sessions endpoint returns tmux windows', async () => {
      const response = await fetch(`http://localhost:${port}/api/sessions`)
      expect(response.ok).toBe(true)
      const sessions = (await response.json()) as Array<{
        tmuxWindow: string
      }>
      expect(Array.isArray(sessions)).toBe(true)
      expect(sessions.length).toBeGreaterThan(0)
      expect(
        sessions.some((session) =>
          session.tmuxWindow.startsWith(`${sessionName}:`)
        )
      ).toBe(true)
    })

    test('websocket emits sessions payload', async () => {
      const message = await waitForWebSocketSessions(port)
      expect(message.type).toBe('sessions')
      expect(Array.isArray(message.sessions)).toBe(true)
      expect(message.sessions.length).toBeGreaterThan(0)
    })

    test('paste-image endpoint stores uploads', async () => {
      const formData = new FormData()
      const blob = new Blob([new Uint8Array([0, 1, 2, 3])], {
        type: 'image/png',
      })
      formData.append('image', blob, 'paste.png')

      const response = await fetch(`http://localhost:${port}/api/paste-image`, {
        method: 'POST',
        body: formData,
      })

      expect(response.ok).toBe(true)
      const payload = (await response.json()) as { path: string }
      expect(payload.path.startsWith('/tmp/paste-')).toBe(true)
      expect(payload.path.endsWith('.png')).toBe(true)
      expect(fs.existsSync(payload.path)).toBe(true)
      fs.unlinkSync(payload.path)
    })

    test('paste-image endpoint rejects empty payloads', async () => {
      const response = await fetch(`http://localhost:${port}/api/paste-image`, {
        method: 'POST',
        body: new FormData(),
      })

      expect(response.status).toBe(400)
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

async function waitForWebSocketSessions(
  port: number,
  timeoutMs = 5000
): Promise<{ type: string; sessions: unknown[] }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/ws`)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for sessions message'))
    }, timeoutMs)

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string
          sessions?: unknown[]
        }
        if (payload.type === 'sessions' && payload.sessions) {
          clearTimeout(timeout)
          socket.close()
          resolve({ type: payload.type, sessions: payload.sessions })
        }
      } catch {
        // ignore bad payloads
      }
    }

    socket.onerror = () => {
      clearTimeout(timeout)
      socket.close()
      reject(new Error('WebSocket error'))
    }
  })
}

function drainStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
) {
  if (!stream || typeof stream === 'number') {
    return
  }

  const reader = stream.getReader()
  const pump = async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) {
        break
      }
    }
  }
  void pump()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
