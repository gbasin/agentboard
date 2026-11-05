// Members (team-workspace D7/Q3/Q10): a read-only inspection of the team's
// groups. Each row shows the role description (never the prompt body), live
// membership, and the settings in effect, and names the file that defines the
// group — both layers, the one in effect marked, when both define it. There is
// no control that writes a group file or changes a running agent: the row
// buttons only open a member's chat, and the one team-level control above the
// rows (`teamControl`, team-approval-default D7) writes the team's default
// approval for later spawns. Each row's approval names its source. Prompt
// edits reach future agent starts only.
import type { ReactNode } from 'react'
import type { TeamMemberRow, TeamMemberSession, TeamMemberProfile } from '@shared/teamWorkspace'
import { spawnApprovalSourceLabel } from '@shared/spawnApproval'

const PROMPT_NOTE = 'Prompt changes apply to future agent starts only and never raise a running agent’s permissions.'

const HOUR_MS = 3_600_000
function durationLabel(ms: number): string {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`
}

/** `claude 1 of 2` for a capped profile, `claude 1 live` for an uncapped one. */
export function profileCountLabel(profile: TeamMemberProfile): string {
  return profile.cap === undefined
    ? `${profile.profileId} · ${profile.live} live`
    : `${profile.profileId} · ${profile.live} of ${profile.cap}`
}

/**
 * Workers grouped under their provider (design D13): `Z.AI: glm-flash · 0 of 3,
 * glm · 1 live · Claude: haiku · 0 of 2`. Every model of a provider shares one
 * group, wherever the preference order puts it; providers keep first-seen order.
 */
export function workersLabel(row: TeamMemberRow): string {
  const groups: Array<{ label: string; models: string[] }> = []
  for (const profile of row.profiles) {
    const group = groups.find(candidate => candidate.label === profile.providerLabel)
    if (group) group.models.push(profileCountLabel(profile))
    else groups.push({ label: profile.providerLabel, models: [profileCountLabel(profile)] })
  }
  return groups.map(group => `${group.label}: ${group.models.join(', ')}`).join(' · ')
}

/**
 * The group level, then each per-profile override (group-profile-effort D4):
 * listed profiles in the group's order, unlisted ones alphabetically.
 */
export function effortLabel(row: TeamMemberRow): string {
  const group = row.effort ?? 'Claude Code settings decide'
  const overrides = row.profileEffort ?? {}
  const listed = row.profiles.map(profile => profile.profileId).filter(id => id in overrides)
  const unlisted = Object.keys(overrides).filter(id => !listed.includes(id)).sort()
  return [group, ...[...listed, ...unlisted].map(id => `${id}: ${overrides[id]}`)].join(' · ')
}

function Member({ member, onOpenSession }: { member: TeamMemberSession; onOpenSession: (sessionId: string) => void }) {
  return <li data-testid="member-session" data-session-id={member.sessionId}>
    <button type="button" className="hover:underline" onClick={() => onOpenSession(member.sessionId)}>{member.name}</button>
    <span className="text-secondary"> · {member.spawned ? 'spawned' : 'manual'} · {member.profile} · {member.status}{member.taskId ? ` · task ${member.taskId}` : ''}</span>
  </li>
}

function Group({ row, onOpenSession }: { row: TeamMemberRow; onOpenSession: (sessionId: string) => void }) {
  const limit = row.onLimit
  return <article className="border border-border p-3" data-testid="member-group" data-group-id={row.id}>
    <h3 className="font-medium">{row.label}{row.label !== row.id && <span className="text-secondary"> ({row.id})</span>}</h3>
    <p className="text-chat-body" data-testid="member-description">{row.description || 'No role description.'}</p>
    <div data-testid="member-sources" className="mt-1 text-chat-meta">
      <p className="text-secondary">Defined in:</p>
      <ul>{row.sources.map(source => <li key={source.file} data-in-effect={source.inEffect}>
        <code>{source.file}</code> · {source.layer} file{source.inEffect ? ' · in effect' : ' · overridden'}
      </li>)}</ul>
    </div>
    <p className="mt-1 text-chat-meta text-secondary" data-testid="member-prompt-note">{PROMPT_NOTE}</p>
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 text-chat-meta" data-testid="member-settings">
      <dt className="text-secondary">Can create tasks</dt><dd>{row.canCreateTasks ? 'yes' : 'no'}</dd>
      <dt className="text-secondary">Approval</dt><dd data-testid="member-approval">{row.approval} · {spawnApprovalSourceLabel(row.approvalSource)}</dd>
      <dt className="text-secondary">Member cap</dt><dd>{row.max}</dd>
      <dt className="text-secondary">Workers</dt>
      <dd data-testid="member-profiles">{row.profiles.length === 0 ? 'default profile' : workersLabel(row)}</dd>
      <dt className="text-secondary">Routing strategy</dt><dd>{row.strategy}</dd>
      <dt className="text-secondary">On limit</dt>
      <dd>park if reset within {durationLabel(limit.parkIfResetWithinMs)}, otherwise {limit.otherwise}{limit.forwardTo ? ` to ${limit.forwardTo}` : ''}</dd>
      <dt className="text-secondary">Effort</dt><dd data-testid="member-effort">{effortLabel(row)}</dd>
    </dl>
    {row.warnings.length > 0 && <ul className="mt-2 text-chat-meta" data-testid="member-warnings">
      {row.warnings.map(warning => <li key={warning}>Warning: {warning}</li>)}
    </ul>}
    <h4 className="mt-2 text-chat-meta font-medium">Live members ({row.members.length})</h4>
    {row.members.length === 0
      ? <p className="text-chat-meta text-secondary">No live members.</p>
      : <ul className="text-chat-meta">{row.members.map(member => <Member key={member.sessionId} member={member} onOpenSession={onOpenSession} />)}</ul>}
  </article>
}

export default function TeamMembersPanel({ members, loaded, onOpenSession, teamControl }: {
  members: readonly TeamMemberRow[]
  /** False until the first workspace snapshot arrives. */
  loaded: boolean
  onOpenSession: (sessionId: string) => void
  /** The team-level default approval control (team-approval-default D7); it edits no group. */
  teamControl?: ReactNode
}) {
  return <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3" data-testid="team-members">
    {teamControl}
    <p className="text-chat-meta text-secondary" data-testid="members-note">
      Read-only. Edit a group by changing the file named on its row.
    </p>
    {!loaded && <p role="status" className="text-chat-meta text-secondary">Loading members…</p>}
    {loaded && members.length === 0 && <p className="text-chat-meta text-secondary" data-testid="members-empty">This team has no groups.</p>}
    {members.map(row => <Group key={row.id} row={row} onOpenSession={onOpenSession} />)}
  </div>
}
