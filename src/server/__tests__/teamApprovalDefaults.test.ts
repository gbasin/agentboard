// @reads: src/server/**/*.ts
// Team default approval store (team-approval-default D3) and the agent
// boundary A1: only the human's Team page action reaches the write, and no
// `kawai-team` tool is named for it or calls it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { TeamApprovalDefaults } from '../team/teamApprovalDefaults'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { createMailboxServer } from '../team/mailboxTools'

let dir: string
let db: SessionDatabase

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-approval-defaults-'))
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('TeamApprovalDefaults', () => {
  // @covers: team-worktree-staffing › A team has a default approval policy for spawned members › A new install has no team default
  test('no row reads as not set; set round-trips and upserts', () => {
    const store = new TeamApprovalDefaults(db.db, () => Date.parse('2026-11-04T10:00:00.000Z'))
    expect(store.get('/repo/.git')).toBeNull()
    store.set('/repo/.git', 'auto')
    expect(store.get('/repo/.git')).toBe('auto')
    store.set('/repo/.git', 'manual')
    expect(store.get('/repo/.git')).toBe('manual')
    expect(store.get('/other/.git')).toBeNull()
    expect(db.db.prepare('SELECT team_id, policy, updated_at FROM team_approval_defaults').all())
      .toEqual([{ team_id: '/repo/.git', policy: 'manual', updated_at: '2026-11-04T10:00:00.000Z' }])
  })

  test('every read sees the committed value: a second store over the same database observes the first one’s writes', () => {
    const reader = new TeamApprovalDefaults(db.db)
    const writer = new TeamApprovalDefaults(db.db)
    expect(reader.get('t')).toBeNull()
    writer.set('t', 'auto')
    expect(reader.get('t')).toBe('auto')
    writer.set('t', 'manual')
    expect(reader.get('t')).toBe('manual')
  })

  test('the table refuses a policy outside manual and auto', () => {
    new TeamApprovalDefaults(db.db)
    expect(() => db.db.prepare("INSERT INTO team_approval_defaults (team_id, policy, updated_at) VALUES ('t', 'always', '')").run()).toThrow()
  })
})

/** Every non-test server source file, relative to the repository root. */
function serverSources(): string[] {
  const root = path.resolve(import.meta.dir, '..')
  const out: string[] = []
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full) } else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(root)
  return out.map(file => path.relative(path.resolve(root, '..', '..'), file)).sort()
}

describe('A1: no agent tool writes the team default', () => {
  // @covers: team-worktree-staffing › A team has a default approval policy for spawned members › Agents cannot set the default
  test('the write is reached only from the human workspace action', () => {
    const writers = serverSources().filter(file => {
      const text = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', '..', file), 'utf8')
      return /setTeamApprovalDefault\(|approvalDefaults\.set\(|INSERT INTO team_approval_defaults/.test(text)
    })
    expect(writers).toEqual([
      'src/server/chat/ChatSessionManager.ts',
      'src/server/team/teamApprovalDefaults.ts',
      'src/server/team/workspaceConnections.ts',
    ])
  })

  test('no registered kawai-team tool is named for approval defaults', async () => {
    const mailbox = new TeamMailbox(new MailboxStore(db.db), { getSession: () => undefined, homeDir: dir })
    const server = await createMailboxServer(mailbox, 'dev', {})
    const registered = Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
    expect(registered.length).toBeGreaterThan(0)
    expect(registered.filter(name => /approval/i.test(name))).toEqual([])
    await server.instance.close()
  })
})
