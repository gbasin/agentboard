import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import type { AgentSessionRecord } from '../db'
import { encodeProjectPath } from '../logDiscovery'
import { collectLogEntryBatch, collectLogEntriesForPaths } from '../logPollData'
import { LogPoller } from '../logPoller'
import type { MatchWorkerRequest, MatchWorkerResponse } from '../logMatchWorkerTypes'
import { SessionRegistry } from '../SessionRegistry'

class CollectingMatchWorkerClient {
  async poll(
    request: Omit<MatchWorkerRequest, 'id'>,
    _options?: { timeoutMs?: number }
  ): Promise<MatchWorkerResponse> {
    const entries =
      request.preFilteredPaths && request.preFilteredPaths.length > 0
        ? collectLogEntriesForPaths(
            request.preFilteredPaths,
            request.knownSessions ?? []
          )
        : collectLogEntryBatch(request.maxLogsPerPoll, {
            knownSessions: request.knownSessions ?? [],
          }).entries

    return {
      id: 'slug-supersede-test',
      type: 'result',
      entries,
      matches: [],
      orphanMatches: [],
      noMessageWindows: [],
    }
  }

  dispose(): void {}
}

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalCodexHome = process.env.CODEX_HOME
const originalPiHome = process.env.PI_HOME

let tempRoot = ''
let claudeConfigDir = ''
let projectPath = ''

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-slug-'))
  claudeConfigDir = path.join(tempRoot, 'claude')
  projectPath = process.cwd()
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  process.env.CODEX_HOME = path.join(tempRoot, 'codex')
  process.env.PI_HOME = path.join(tempRoot, 'pi')
})

afterEach(() => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (originalPiHome === undefined) {
    delete process.env.PI_HOME
  } else {
    process.env.PI_HOME = originalPiHome
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('slug-based session supersede integration', () => {
  test('execution session supersedes planning session via slug match', async () => {
    const db = initDatabase({ path: ':memory:' })
    const currentWindow = 'agentboard-slug:%1'
    const planSessionId = 'plan-session'
    const execSessionId = 'exec-session'
    const slug = 'test-supersede-slug'
    const logDir = createClaudeLogDir()
    const planLogPath = writeClaudeLog(logDir, 'plan-session.jsonl', {
      sessionId: planSessionId,
      slug,
      userText: 'plan this feature for me',
      assistantText: 'Here is the plan for the feature',
    })
    writeClaudeLog(logDir, 'exec-session.jsonl', {
      sessionId: execSessionId,
      slug,
      userText: 'Implement the following plan with detailed steps and code changes',
      assistantText: 'I will now implement the plan step by step',
    })

    insertSession(db, {
      sessionId: planSessionId,
      logFilePath: planLogPath,
      slug,
      displayName: 'plan-session',
      currentWindow,
      isPinned: false,
    })

    const poller = new LogPoller(db, new SessionRegistry(), {
      matchWorkerClient: new CollectingMatchWorkerClient(),
    })
    await poller.pollOnce()

    const execRecord = db.getSessionById(execSessionId)
    const planRecord = db.getSessionById(planSessionId)

    expect(execRecord).not.toBeNull()
    expect(execRecord!.currentWindow).toBe(currentWindow)
    expect(execRecord!.slug).toBe(slug)
    expect(planRecord).not.toBeNull()
    expect(planRecord!.currentWindow).toBeNull()
    expect(planRecord!.slug).toBe(slug)
    expect(execRecord!.projectPath).toBe(planRecord!.projectPath)

    db.close()
  })

  test('hibernation marker transfers during slug supersede', async () => {
    const db = initDatabase({ path: ':memory:' })
    const currentWindow = 'agentboard-slug:%1'
    const planSessionId = 'hibernate-plan'
    const execSessionId = 'hibernate-exec'
    const slug = 'hibernate-slug'
    const logDir = createClaudeLogDir()
    const planLogPath = writeClaudeLog(logDir, 'hibernate-plan.jsonl', {
      sessionId: planSessionId,
      slug,
      userText: 'plan the hibernating feature',
      assistantText: 'here is the hibernating plan',
    })
    writeClaudeLog(logDir, 'hibernate-exec.jsonl', {
      sessionId: execSessionId,
      slug,
      userText: 'implement the hibernating plan now',
      assistantText: 'implementing hibernating plan now',
    })

    insertSession(db, {
      sessionId: planSessionId,
      logFilePath: planLogPath,
      slug,
      displayName: 'hibernate-plan',
      currentWindow,
      isPinned: true,
    })

    const poller = new LogPoller(db, new SessionRegistry(), {
      matchWorkerClient: new CollectingMatchWorkerClient(),
    })
    await poller.pollOnce()

    const execRecord = db.getSessionById(execSessionId)
    const planRecord = db.getSessionById(planSessionId)

    expect(execRecord).not.toBeNull()
    expect(execRecord!.currentWindow).toBe(currentWindow)
    expect(execRecord!.isPinned).toBe(true)
    expect(planRecord).not.toBeNull()
    expect(planRecord!.currentWindow).toBeNull()
    expect(planRecord!.isPinned).toBe(false)

    db.close()
  })
})

function createClaudeLogDir(): string {
  const logDir = path.join(
    claudeConfigDir,
    'projects',
    encodeProjectPath(projectPath)
  )
  fs.mkdirSync(logDir, { recursive: true })
  return logDir
}

function writeClaudeLog(
  logDir: string,
  filename: string,
  {
    sessionId,
    slug,
    userText,
    assistantText,
  }: {
    sessionId: string
    slug: string
    userText: string
    assistantText: string
  }
): string {
  const logPath = path.join(logDir, filename)
  const userEntry = JSON.stringify({
    type: 'user',
    sessionId,
    cwd: projectPath,
    slug,
    message: {
      role: 'user',
      content: [{ type: 'text', text: userText }],
    },
  })
  const assistantEntry = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: assistantText }],
    },
  })
  fs.writeFileSync(logPath, `${userEntry}\n${assistantEntry}\n`)
  return logPath
}

function insertSession(
  db: ReturnType<typeof initDatabase>,
  overrides: Pick<
    AgentSessionRecord,
    'sessionId' | 'logFilePath' | 'slug' | 'displayName' | 'currentWindow' | 'isPinned'
  >
): void {
  db.insertSession({
    sessionId: overrides.sessionId,
    logFilePath: overrides.logFilePath,
    projectPath,
    slug: overrides.slug,
    agentType: 'claude',
    displayName: overrides.displayName,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lastUserMessage: null,
    currentWindow: overrides.currentWindow,
    isPinned: overrides.isPinned,
    lastResumeError: null,
    lastKnownLogSize: null,
    isCodexExec: false,
    launchCommand: null,
  })
}
