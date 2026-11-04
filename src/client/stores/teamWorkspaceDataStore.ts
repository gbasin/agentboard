// The Team page's workspace read model (team-workspace D6): the attention
// queue, task rows, members, and morning summary, keyed by team key. The
// server's snapshot and change pushes are the same full-set replace, so
// `apply` replaces the view wholesale and counts are derived from the items,
// never incremented — a reconnect converges by construction. Toast identity
// lives here too: a set of `kind:sourceId` identities seen this client
// session (the page's lifetime, not the connection's or the team's), so a
// replayed snapshot raises nothing and an item that resolves and returns
// never re-toasts. The first snapshot of a team is its baseline: items
// already waiting when the page opens are visible in the queue, not news.
// The team default approval save (team-approval-default D4) keeps only its
// in-flight flag and the server's last refusal per team key; the value
// itself is the snapshot's `approvalDefault`, so every view follows a push.
import { create } from 'zustand'
import type { AttentionItem, TeamWorkspaceSnapshot } from '@shared/teamWorkspace'

type WorkspaceSnapshotMessage = TeamWorkspaceSnapshot & { teamPath: string; teamId: string }

export interface TeamWorkspaceData {
  /** Server team id of the last snapshot; null before the first. */
  teamId: string | null
  /** The last authoritative read, null until the first snapshot arrives. */
  snapshot: TeamWorkspaceSnapshot | null
}

/** A team default approval save: waiting for its result, and the last refusal. */
export interface ApprovalSave {
  pending: boolean
  error: string | null
}

type ApprovalResultMessage = { teamPath: string } & ({ ok: true } | { ok: false; error: string })

interface TeamWorkspaceDataState {
  views: Record<string, TeamWorkspaceData>
  /** Per team key; absent = no save attempted this page lifetime. */
  approvalSaves: Record<string, ApprovalSave>
  beginApprovalSave: (teamKey: string) => void
  /** The server's answer: clears the wait, keeps a refusal to show inline. */
  applyApprovalResult: (message: ApprovalResultMessage) => void
  /** The connection dropped: an in-flight save will never answer. */
  cancelApprovalSave: (teamKey: string) => void
  /** Identities already toasted or seen at baseline, for the client session. */
  seen: Set<string>
  /** Create the team's slot; an existing one keeps its last read. */
  open: (teamKey: string) => void
  /**
   * Replace the team's read model. Returns the items that just became
   * human-required and were never seen — the caller toasts exactly those.
   */
  apply: (message: WorkspaceSnapshotMessage) => AttentionItem[]
  /** Move a view to the chat's new team key; a view already there wins. */
  rekey: (from: string, to: string) => void
}

export const useTeamWorkspaceDataStore = create<TeamWorkspaceDataState>((set, get) => ({
  views: {},
  seen: new Set(),
  approvalSaves: {},
  beginApprovalSave: teamKey => set(state => ({ approvalSaves: { ...state.approvalSaves, [teamKey]: { pending: true, error: null } } })),
  applyApprovalResult: message => set(state => ({
    approvalSaves: { ...state.approvalSaves, [message.teamPath]: { pending: false, error: message.ok ? null : message.error } },
  })),
  cancelApprovalSave: teamKey => set(state => state.approvalSaves[teamKey]?.pending
    ? { approvalSaves: { ...state.approvalSaves, [teamKey]: { pending: false, error: state.approvalSaves[teamKey]!.error } } }
    : state),
  open: teamKey => set(state => state.views[teamKey]
    ? state
    : { views: { ...state.views, [teamKey]: { teamId: null, snapshot: null } } }),
  apply: message => {
    const { teamPath, teamId, ...snapshot } = message
    const state = get()
    const view = state.views[teamPath]
    // Only a team whose page opened has a slot: a reply for a team never
    // opened here (or whose slot a rekey moved away) is dropped.
    if (!view) return []
    const humanIds = snapshot.attention.filter(item => item.requiresHuman).map(item => item.id)
    const fresh = view.snapshot === null
      ? []
      : snapshot.attention.filter(item => item.requiresHuman && !state.seen.has(item.id))
    const seen = new Set(state.seen)
    for (const id of humanIds) seen.add(id)
    set({ seen, views: { ...state.views, [teamPath]: { teamId, snapshot } } })
    return fresh
  },
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
}))

/** Attention counts derived from the items — replaced, never incremented. */
export function attentionCounts(items: readonly AttentionItem[]): { human: number; agent: number } {
  const human = items.filter(item => item.requiresHuman).length
  return { human, agent: items.length - human }
}
