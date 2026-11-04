// Per-team default approval policy for spawned members (team-approval-default
// D3): one row per team id (the canonical common git dir), absent = not set.
// Written only by the human's Team page action (D4) — no agent tool reaches
// this store — and read uncached at every spawn, preview, and Members read, so
// a spawn always sees the committed value and needs no browser connection.
// The table is schema migration 22 (`team-approval-defaults`); this store
// never creates it.
import type { Database } from 'bun:sqlite'
import type { ChatApprovalPolicy } from '../../shared/chat'

export const CREATE_TEAM_APPROVAL_DEFAULTS_SQL = `
CREATE TABLE team_approval_defaults (
  team_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL CHECK (policy IN ('manual', 'auto')),
  updated_at TEXT NOT NULL
);
`

export class TeamApprovalDefaults {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  /** The team's stored default, or null when it was never set. */
  get(teamId: string): ChatApprovalPolicy | null {
    const row = this.db.prepare('SELECT policy FROM team_approval_defaults WHERE team_id = ?')
      .get(teamId) as { policy: string } | null
    return row?.policy === 'auto' || row?.policy === 'manual' ? row.policy : null
  }

  /** Upsert the team's default; the same value again is a no-op in effect. */
  set(teamId: string, policy: ChatApprovalPolicy): void {
    this.db.prepare(`INSERT INTO team_approval_defaults (team_id, policy, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`)
      .run(teamId, policy, new Date(this.now()).toISOString())
  }
}
