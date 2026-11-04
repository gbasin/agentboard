// The team default approval end to end (team-approval-default L1, L3): a real
// ChatSessionManager with fixture agents and no ChatConnections at all — no
// browser is connected — spawns a member of a group without an `approval:`
// key under an `auto` team default; the member starts on auto and its first
// tool approval is granted without a card. Setting the default leaves an
// existing chat's stored policy untouched.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { mailboxHandlers } from '../team/mailboxTools'
import { taskHandlers } from '../team/taskTools'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// @covers: team-worktree-staffing › A member is spawned when none is available › Auto works with no browser connected
// @covers: team-worktree-staffing › A team has a default approval policy for spawned members › The default does not change existing chats
test('with no browser connected, an auto team default spawns an auto member whose tools run without cards; existing chats keep their policy', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-approval-default-')))
  const repo = path.join(root, 'repo')
  const featX = path.join(root, 'feat-x')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nCoordinate work')
  // No `approval:` key: the team default decides.
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 1\n---\nBuild features')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  // Every agent's SDK options by working directory, so the spawned member's permission callback can be driven.
  const optionsByCwd = new Map<string, Options>()
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    // The manager's event sink; nothing forwards it to a browser here.
    onEvent: () => {},
    queryFactory: params => {
      if (params.options.cwd) optionsByCwd.set(params.options.cwd, params.options)
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      const prompt = (async function* () {
        for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        let turnStarted = false
        for await (const message of fixture) {
          if (!turnStarted) {
            turnStarted = true
            yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
          }
          yield message
        }
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const team = await resolveTeam(repo)
    // A chat that exists before the default is set (L1).
    const existing = await manager.createAvailableSession({ projectPath: repo, approvalPolicy: 'manual' })
    if (!existing.ok) throw new Error(existing.error)

    manager.setTeamApprovalDefault(team.teamId, 'auto')
    expect(manager.teamApprovalDefault(team.teamId)).toBe('auto')
    expect(db.getChatSession(existing.session.id)?.approvalPolicy).toBe('manual')

    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    if (!lead.ok) throw new Error(lead.error)
    await manager.start(lead.session.id)
    const task = await taskHandlers(manager.tasks, lead.session.id).task_create({ title: 'Export', direction: 'CSV export', worktree: featX })
    const mail = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Please build this', task_id: task.id })

    await waitFor(() => db.getChatSessions().some(row => row.spawned), 'a spawned member')
    const spawned = db.getChatSessions().find(row => row.spawned)!
    expect(spawned).toMatchObject({ projectPath: featX, groupId: 'devs', approvalPolicy: 'auto', taskId: task.id })
    await waitFor(() => manager.mailbox.store.get(mail.id)?.state === 'delivered', 'first-turn delivery')
    await waitFor(() => optionsByCwd.has(featX), 'the member’s agent start')

    // The member's first tool approval: granted by the policy, no card.
    const grant = optionsByCwd.get(featX)!.canUseTool!(
      'Bash', { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1' } as Parameters<NonNullable<Options['canUseTool']>>[2],
    )
    await expect(grant).resolves.toMatchObject({ behavior: 'allow' })
    expect(manager.getPendingRequests(spawned.sessionId)).toEqual([])

    // L1 again after the spawn: the pre-existing chat never moved.
    expect(db.getChatSession(existing.session.id)?.approvalPolicy).toBe('manual')
    await manager.dispatcher.settled()
  } finally {
    manager.shutdown()
    db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
