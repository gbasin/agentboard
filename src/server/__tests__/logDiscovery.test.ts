import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  encodeProjectPath,
  extractProjectPath,
  extractSessionId,
  getLogWatchParentDirs,
  getLogSearchDirs,
  inferAgentTypeFromPath,
  isCodexExec,
  isCodexSubagent,
  isPiSubagent,
  scanAllLogDirs,
} from '../logDiscovery'

let tempRoot: string
let claudeDir: string
let codexDir: string
let piDir: string
let ompAgentDir: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME
const originalPi = process.env.PI_HOME
const originalAgentboardData = process.env.AGENTBOARD_DATA_DIR
const originalGrok = process.env.GROK_HOME
const originalOmpAgent = process.env.PI_CODING_AGENT_DIR

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logs-'))
  claudeDir = path.join(tempRoot, 'claude')
  codexDir = path.join(tempRoot, 'codex')
  piDir = path.join(tempRoot, 'pi')
  ompAgentDir = path.join(tempRoot, 'omp-agent')
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = codexDir
  process.env.PI_HOME = piDir
  process.env.AGENTBOARD_DATA_DIR = path.join(tempRoot, 'agentboard')
  process.env.GROK_HOME = path.join(tempRoot, 'grok')
  process.env.PI_CODING_AGENT_DIR = ompAgentDir
})

afterEach(async () => {
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  if (originalPi) process.env.PI_HOME = originalPi
  else delete process.env.PI_HOME
  if (originalAgentboardData) process.env.AGENTBOARD_DATA_DIR = originalAgentboardData
  else delete process.env.AGENTBOARD_DATA_DIR
  if (originalGrok) process.env.GROK_HOME = originalGrok
  else delete process.env.GROK_HOME
  if (originalOmpAgent) process.env.PI_CODING_AGENT_DIR = originalOmpAgent
  else delete process.env.PI_CODING_AGENT_DIR
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('encodeProjectPath matches Claude path convention', () => {
  const encoded = encodeProjectPath('/Users/example/project')
  expect(encoded).toBe('-Users-example-project')
})

describe('log discovery', () => {
  test('scans Claude and Codex roots for jsonl files', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    await fs.mkdir(claudeProjectDir, { recursive: true })
    const claudeLog = path.join(claudeProjectDir, 'session-1.jsonl')
    await fs.writeFile(claudeLog, '{}\n')

    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const codexLog = path.join(codexLogDir, 'session-2.jsonl')
    await fs.writeFile(codexLog, '{}\n')

    // omp sessions live at <agentDir>/sessions/<encoded-cwd>/*.jsonl
    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const ompLog = path.join(ompSessionDir, 'session-3.jsonl')
    await fs.writeFile(ompLog, '{}\n')

    const found = scanAllLogDirs()
    expect(found).toContain(claudeLog)
    expect(found).toContain(codexLog)
    expect(found).toContain(ompLog)
  })

  test('skips Claude subagent logs', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    const subagentDir = path.join(claudeProjectDir, 'subagents')
    await fs.mkdir(subagentDir, { recursive: true })
    const subagentLog = path.join(subagentDir, 'agent-1.jsonl')
    await fs.writeFile(subagentLog, '{}\n')

    const found = scanAllLogDirs()
    expect(found).not.toContain(subagentLog)
  })

  test('extracts sessionId and projectPath from Claude logs', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    await fs.mkdir(claudeProjectDir, { recursive: true })
    const logPath = path.join(claudeProjectDir, 'session-claude.jsonl')
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-123',
      cwd: projectPath,
      content: 'hello',
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractSessionId(logPath)).toBe('claude-session-123')
    expect(extractProjectPath(logPath)).toBe(projectPath)
  })

  test('extracts sessionId and projectPath from Codex logs', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'session-codex.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'codex-session-456',
        cwd: '/Users/example/codex-project',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractSessionId(logPath)).toBe('codex-session-456')
    expect(extractProjectPath(logPath)).toBe('/Users/example/codex-project')
  })

  test('discovers Grok transcripts and derives id/project from path', async () => {
    const sessionDir = path.join(
      process.env.GROK_HOME!,
      'sessions',
      encodeURIComponent('/Users/example/grok-proj'),
      'grok-session-789'
    )
    await fs.mkdir(sessionDir, { recursive: true })
    const log = path.join(sessionDir, 'chat_history.jsonl')
    await fs.writeFile(
      log,
      JSON.stringify({
        type: 'user',
        prompt_index: 0,
        content: [{ type: 'text', text: '<user_query>hi</user_query>' }],
      }) + '\n'
    )
    // Sibling telemetry files are not transcripts and must be ignored.
    const telemetry = path.join(sessionDir, 'events.jsonl')
    await fs.writeFile(telemetry, '{"ts":"x","type":"loop_started"}\n')

    const found = scanAllLogDirs()
    expect(found).toContain(log)
    expect(found).not.toContain(telemetry)

    expect(extractSessionId(log)).toBe('grok-session-789')
    expect(extractProjectPath(log)).toBe('/Users/example/grok-proj')
  })

  test('expands tilde overrides for log roots', () => {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) {
      return
    }

    process.env.CLAUDE_CONFIG_DIR = '~/claude-config'
    process.env.CODEX_HOME = '~/codex-config/'
    const [claudeRoot, codexRoot] = getLogSearchDirs()

    expect(claudeRoot).toBe(path.join(home, 'claude-config', 'projects'))
    expect(codexRoot).toBe(path.join(home, 'codex-config', 'sessions'))
  })

  test('returns parent directories for file watching', () => {
    const [claudeParent, codexParent, piParent, devinParent, grokParent, ompParent] =
      getLogWatchParentDirs()

    expect(claudeParent).toBe(claudeDir)
    expect(codexParent).toBe(codexDir)
    expect(piParent).toBe(path.join(piDir, 'agent'))
    expect(devinParent).toBe(path.join(tempRoot, 'agentboard'))
    expect(grokParent).toBe(path.join(tempRoot, 'grok'))
    expect(ompParent).toBe(ompAgentDir)
  })

  test('extracts sessionId and projectPath from pi/omp logs', async () => {
    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const logPath = path.join(ompSessionDir, 'session-omp.jsonl')
    const line = JSON.stringify({
      type: 'session',
      version: 3,
      id: 'omp-session-789',
      timestamp: '2026-09-22T10:00:00.000Z',
      cwd: '/Users/example/project',
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractSessionId(logPath)).toBe('omp-session-789')
    expect(extractProjectPath(logPath)).toBe('/Users/example/project')
  })

  test('infers omp agent type from session log path', async () => {
    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const logPath = path.join(ompSessionDir, 'session-omp.jsonl')
    await fs.writeFile(logPath, '{}\n')

    expect(inferAgentTypeFromPath(logPath)).toBe('omp')
    expect(inferAgentTypeFromPath(path.join(piDir, 'agent', 'sessions', 'x.jsonl'))).toBe('pi')
  })

  describe('omp session dir resolution', () => {
    const originalHome = process.env.HOME
    const originalXdg = process.env.XDG_DATA_HOME
    const originalPiConfigDir = process.env.PI_CONFIG_DIR
    let fakeHome: string
    let xdgData: string

    beforeEach(async () => {
      fakeHome = path.join(tempRoot, 'home')
      xdgData = path.join(tempRoot, 'xdg-data')
      await fs.mkdir(fakeHome, { recursive: true })
      delete process.env.PI_CODING_AGENT_DIR
      process.env.HOME = fakeHome
      process.env.XDG_DATA_HOME = xdgData
    })

    afterEach(() => {
      if (originalHome) process.env.HOME = originalHome
      else delete process.env.HOME
      if (originalXdg) process.env.XDG_DATA_HOME = originalXdg
      else delete process.env.XDG_DATA_HOME
      if (originalPiConfigDir) process.env.PI_CONFIG_DIR = originalPiConfigDir
      else delete process.env.PI_CONFIG_DIR
    })

    test('redirects sessions to $XDG_DATA_HOME/omp/sessions when it exists', async () => {
      const xdgSessions = path.join(xdgData, 'omp', 'sessions', 'proj')
      await fs.mkdir(xdgSessions, { recursive: true })
      const logPath = path.join(xdgSessions, 'x.jsonl')
      await fs.writeFile(logPath, '{}\n')

      expect(getLogSearchDirs()).toContain(path.join(xdgData, 'omp', 'sessions'))
      expect(scanAllLogDirs()).toContain(logPath)
      expect(inferAgentTypeFromPath(logPath)).toBe('omp')
    })

    test('falls back to ~/.omp/agent/sessions when no XDG omp dir exists', async () => {
      const defaultSessions = path.join(fakeHome, '.omp', 'agent', 'sessions', 'proj')
      await fs.mkdir(defaultSessions, { recursive: true })
      const logPath = path.join(defaultSessions, 'x.jsonl')
      await fs.writeFile(logPath, '{}\n')

      expect(scanAllLogDirs()).toContain(logPath)
      expect(inferAgentTypeFromPath(logPath)).toBe('omp')
    })

    test('honors PI_CONFIG_DIR for the config root name', async () => {
      process.env.PI_CONFIG_DIR = '.omp-custom'
      const customSessions = path.join(fakeHome, '.omp-custom', 'agent', 'sessions', 'proj')
      await fs.mkdir(customSessions, { recursive: true })
      const logPath = path.join(customSessions, 'x.jsonl')
      await fs.writeFile(logPath, '{}\n')

      expect(scanAllLogDirs()).toContain(logPath)
      expect(inferAgentTypeFromPath(logPath)).toBe('omp')
    })

    test('ignores the XDG redirect when PI_CODING_AGENT_DIR is set', async () => {
      process.env.PI_CODING_AGENT_DIR = ompAgentDir
      await fs.mkdir(path.join(xdgData, 'omp'), { recursive: true })
      const overridden = path.join(ompAgentDir, 'sessions', 'proj')
      await fs.mkdir(overridden, { recursive: true })
      const logPath = path.join(overridden, 'x.jsonl')
      await fs.writeFile(logPath, '{}\n')

      expect(scanAllLogDirs()).toContain(logPath)
      expect(inferAgentTypeFromPath(logPath)).toBe('omp')
    })
  })

  test('normalizes Windows project paths from logs', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'session-win.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'codex-session-win',
        cwd: 'C:\\Users\\Example\\project\\',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractProjectPath(logPath)).toBe('c:/Users/Example/project')
  })
})

describe('isCodexSubagent', () => {
  test('returns false for CLI sessions (source is string)', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'cli-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'cli-session-123',
        cwd: '/Users/example/project',
        source: 'cli',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(false)
  })

  test('returns true for subagent sessions (source is object)', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'subagent-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'subagent-session-456',
        cwd: '/Users/example/project',
        source: { subagent: 'review' },
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(true)
  })

  test('returns false for non-existent files', () => {
    expect(isCodexSubagent('/nonexistent/path.jsonl')).toBe(false)
  })

  test('returns false for empty files', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'empty.jsonl')
    await fs.writeFile(logPath, '')

    expect(isCodexSubagent(logPath)).toBe(false)
  })

  test('returns false for non-session_meta first line', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'other.jsonl')
    const line = JSON.stringify({
      type: 'response_item',
      payload: { role: 'user' },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(false)
  })
})

describe('isCodexExec', () => {
  test('returns false for CLI sessions (source is "cli")', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'cli-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'cli-session-123',
        cwd: '/Users/example/project',
        source: 'cli',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(false)
  })

  test('returns true for exec sessions (source is "exec")', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'exec-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'exec-session-456',
        cwd: '/private/var/folders/tmp',
        source: 'exec',
        originator: 'codex_exec',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(true)
  })

  test('returns false for subagent sessions', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'subagent.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'subagent-789',
        cwd: '/Users/example/project',
        source: { subagent: 'review' },
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(false)
  })

  test('returns false for non-existent files', () => {
    expect(isCodexExec('/nonexistent/path.jsonl')).toBe(false)
  })

  test('returns false for empty files', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'empty-exec.jsonl')
    await fs.writeFile(logPath, '')

    expect(isCodexExec(logPath)).toBe(false)
  })
})

describe('isPiSubagent', () => {
  test('returns true for sessions with a session_init entry', async () => {
    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const logPath = path.join(ompSessionDir, 'subagent.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'sub-1', timestamp: '2026-09-22T10:00:00.000Z', cwd: '/Users/example/project' }),
      JSON.stringify({ type: 'session_init', id: 'a1b2c3d4', parentId: null, timestamp: '2026-09-22T10:00:01.000Z', systemPrompt: 'sp', task: 'do thing', tools: ['read'] }),
    ]
    await fs.writeFile(logPath, `${lines.join('\n')}\n`)

    expect(isPiSubagent(logPath)).toBe(true)
  })

  test('returns false for regular interactive sessions', async () => {
    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const logPath = path.join(ompSessionDir, 'interactive.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'main-1', timestamp: '2026-09-22T10:00:00.000Z', cwd: '/Users/example/project' }),
      JSON.stringify({ type: 'message', id: 'b2c3d4e5', parentId: null, timestamp: '2026-09-22T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    ]
    await fs.writeFile(logPath, `${lines.join('\n')}\n`)

    expect(isPiSubagent(logPath)).toBe(false)
  })

  test('returns false for non-existent and empty files', async () => {
    expect(isPiSubagent('/nonexistent/path.jsonl')).toBe(false)

    const ompSessionDir = path.join(ompAgentDir, 'sessions', '--Users-example-project--')
    await fs.mkdir(ompSessionDir, { recursive: true })
    const logPath = path.join(ompSessionDir, 'empty.jsonl')
    await fs.writeFile(logPath, '')

    expect(isPiSubagent(logPath)).toBe(false)
  })
})
