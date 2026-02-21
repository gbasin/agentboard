import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { initDatabase } from '../db'
import type { AgentSessionRecord } from '../db'
import { encodeProjectPath } from '../logDiscovery'

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
  test.skip('tmux not available - skipping slug supersede integration test', () => {})
} else {
  describe('slug-based session supersede integration', () => {
    const sessionName = `agentboard-slug-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-slug-${process.pid}-${Date.now()}.db`
    )
    const projectPath = process.cwd()
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let claudeConfigDir: string | null = null
    const extraAgentHomeDirs: string[] = []
    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir } : { ...process.env }
    const createAgentHomeDir = (prefix: string): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      extraAgentHomeDirs.push(dir)
      return dir
    }

    const planSessionId = `plan-session-${Date.now()}`
    const execSessionId = `exec-session-${Date.now()}`
    const testSlug = `test-supersede-slug-${Date.now()}`

    beforeAll(async () => {
      tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tmux-'))
      claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-claude-'))

      // Create the tmux session
      Bun.spawnSync(['tmux', 'new-session', '-d', '-s', sessionName], {
        stdout: 'ignore',
        stderr: 'ignore',
        env: tmuxEnv(),
      })

      // Get the default window identifier
      const listResult = Bun.spawnSync(
        ['tmux', 'list-windows', '-t', sessionName, '-F', '#{session_name}:#{window_id}'],
        { stdout: 'pipe', stderr: 'pipe', env: tmuxEnv() }
      )
      const defaultWindow = listResult.stdout
        .toString()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0]!

      // Seed session A (planning session) in the DB BEFORE starting the server.
      // It already "owns" the default tmux window.
      const db = initDatabase({ path: dbPath })
      db.insertSession({
        sessionId: planSessionId,
        logFilePath: path.join(
          claudeConfigDir,
          'projects',
          encodeProjectPath(projectPath),
          'plan-session.jsonl'
        ),
        projectPath,
        slug: testSlug,
        agentType: 'claude',
        displayName: 'plan-session',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: defaultWindow,
        isPinned: false,
        lastResumeError: null,
        lastKnownLogSize: null,
        isCodexExec: false,
      })
      db.close()

      // Write the execution session log file (session B) with the same slug.
      // The poller will discover this and trigger slug-based supersede.
      const logDir = path.join(
        claudeConfigDir,
        'projects',
        encodeProjectPath(projectPath)
      )
      fs.mkdirSync(logDir, { recursive: true })

      // Also write the plan session log (so the poller sees it as existing)
      const planLogPath = path.join(logDir, 'plan-session.jsonl')
      const planEntry = JSON.stringify({
        type: 'user',
        sessionId: planSessionId,
        cwd: projectPath,
        slug: testSlug,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'plan this feature for me' }],
        },
      })
      const planAssistant = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Here is the plan for the feature' }],
        },
      })
      fs.writeFileSync(planLogPath, `${planEntry}\n${planAssistant}\n`)

      const execLogPath = path.join(logDir, 'exec-session.jsonl')
      const execEntry = JSON.stringify({
        type: 'user',
        sessionId: execSessionId,
        cwd: projectPath,
        slug: testSlug,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Implement the following plan with detailed steps and code changes' }],
        },
      })
      const execAssistant = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I will now implement the plan step by step' }],
        },
      })
      fs.writeFileSync(execLogPath, `${execEntry}\n${execAssistant}\n`)

      // Start the server with log polling ENABLED so it discovers session B's log
      port = await getFreePort()
      const codexDir = createAgentHomeDir('agentboard-codex-')
      const piDir = createAgentHomeDir('agentboard-pi-')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(port),
        TMUX_SESSION: sessionName,
        DISCOVER_PREFIXES: '',
        AGENTBOARD_LOG_POLL_MS: '2000',
        AGENTBOARD_DB_PATH: dbPath,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexDir,
        PI_HOME: piDir,
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

      await waitForHealth(port, serverProcess)
    }, 15000)

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
      if (claudeConfigDir) {
        try {
          fs.rmSync(claudeConfigDir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
      for (const dir of extraAgentHomeDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
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
      'execution session supersedes planning session via slug match',
      async () => {
        // Poll DB until the execution session appears and supersedes the planning session.
        // The server's log poller discovers exec-session.jsonl, sees the same slug as
        // plan-session, and transfers the window via slug-based supersede.
        const start = Date.now()
        const timeoutMs = 30_000
        let execRecord: AgentSessionRecord | null = null
        let planRecord: AgentSessionRecord | null = null

        while (Date.now() - start < timeoutMs) {
          try {
            const db = initDatabase({ path: dbPath })
            execRecord = db.getSessionById(execSessionId)
            planRecord = db.getSessionById(planSessionId)
            db.close()

            // Success: exec session has a window AND plan session is orphaned
            if (
              execRecord &&
              execRecord.currentWindow &&
              planRecord &&
              planRecord.currentWindow === null
            ) {
              break
            }
          } catch {
            // DB may be locked by server — retry
          }
          await delay(500)
        }

        // Verify the execution session claimed the window
        expect(execRecord).not.toBeNull()
        expect(execRecord!.currentWindow).not.toBeNull()
        expect(execRecord!.slug).toBe(testSlug)

        // Verify the planning session was orphaned
        expect(planRecord).not.toBeNull()
        expect(planRecord!.currentWindow).toBeNull()
        expect(planRecord!.slug).toBe(testSlug)

        // Both sessions share the same slug and project
        expect(execRecord!.projectPath).toBe(planRecord!.projectPath)
      },
      35_000
    )

    test(
      'pin state transfers during slug supersede',
      async () => {
        // Stop server, set up a pinned session, restart with new log
        if (serverProcess) {
          try {
            serverProcess.kill()
            await serverProcess.exited
          } catch {
            // ignore
          }
          serverProcess = null
        }

        const pinnedPlanId = `pinned-plan-${Date.now()}`
        const pinnedExecId = `pinned-exec-${Date.now()}`
        const pinnedSlug = `pinned-slug-${Date.now()}`

        // Get current tmux window
        const listResult = Bun.spawnSync(
          ['tmux', 'list-windows', '-t', sessionName, '-F', '#{session_name}:#{window_id}'],
          { stdout: 'pipe', stderr: 'pipe', env: tmuxEnv() }
        )
        const defaultWindow = listResult.stdout
          .toString()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)[0]!

        // Seed pinned planning session
        const db = initDatabase({ path: dbPath })
        db.insertSession({
          sessionId: pinnedPlanId,
          logFilePath: path.join(
            claudeConfigDir!,
            'projects',
            encodeProjectPath(projectPath),
            'pinned-plan.jsonl'
          ),
          projectPath,
          slug: pinnedSlug,
          agentType: 'claude',
          displayName: 'pinned-plan',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          lastUserMessage: null,
          currentWindow: defaultWindow,
          isPinned: true,
          lastResumeError: null,
          lastKnownLogSize: null,
          isCodexExec: false,
        })
        db.close()

        // Write execution session log with same slug
        const logDir = path.join(
          claudeConfigDir!,
          'projects',
          encodeProjectPath(projectPath)
        )
        const pinnedPlanLogPath = path.join(logDir, 'pinned-plan.jsonl')
        fs.writeFileSync(
          pinnedPlanLogPath,
          JSON.stringify({
            type: 'user',
            sessionId: pinnedPlanId,
            cwd: projectPath,
            slug: pinnedSlug,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'plan the pinned feature' }],
            },
          }) +
            '\n' +
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'here is the pinned plan' }] },
            }) +
            '\n'
        )

        const execLogPath = path.join(logDir, 'pinned-exec.jsonl')
        fs.writeFileSync(
          execLogPath,
          JSON.stringify({
            type: 'user',
            sessionId: pinnedExecId,
            cwd: projectPath,
            slug: pinnedSlug,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'implement the pinned plan now' }],
            },
          }) +
            '\n' +
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'implementing pinned plan now' }] },
            }) +
            '\n'
        )

        // Restart server
        port = await getFreePort()
        const codexDir = createAgentHomeDir('agentboard-codex-')
        const piDir = createAgentHomeDir('agentboard-pi-')
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '2000',
          AGENTBOARD_DB_PATH: dbPath,
          CLAUDE_CONFIG_DIR: claudeConfigDir!,
          CODEX_HOME: codexDir,
          PI_HOME: piDir,
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
        await waitForHealth(port, serverProcess)

        // Poll DB until execution session supersedes
        const start = Date.now()
        let execRecord: AgentSessionRecord | null = null

        while (Date.now() - start < 30_000) {
          try {
            const pollDb = initDatabase({ path: dbPath })
            execRecord = pollDb.getSessionById(pinnedExecId)
            pollDb.close()

            if (execRecord && execRecord.currentWindow) {
              break
            }
          } catch {
            // retry
          }
          await delay(500)
        }

        // Execution session should have inherited the pin
        expect(execRecord).not.toBeNull()
        expect(execRecord!.currentWindow).not.toBeNull()
        expect(execRecord!.isPinned).toBe(true)

        // Planning session should be orphaned and unpinned (pin transferred)
        const finalDb = initDatabase({ path: dbPath })
        const planRecord = finalDb.getSessionById(pinnedPlanId)
        finalDb.close()
        expect(planRecord).not.toBeNull()
        expect(planRecord!.currentWindow).toBeNull()
        expect(planRecord!.isPinned).toBe(false)
      },
      40_000
    )
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
