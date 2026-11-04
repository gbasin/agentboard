// connectionWaits.ts - waits a dropped socket strands, released app-wide on
// every status change away from connected, whichever view is mounted: an
// in-flight history page (chat-history-window D3; the reconnect's fresh
// attach reloads the window) and in-flight team default approval saves
// (team-approval-default D7; their result never arrives, and a Members tab
// opened after the reconnect must not find its control still waiting).
import type { ConnectionStatus } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'

export function releaseStrandedWaits(status: ConnectionStatus): void {
  if (status === 'connected') return
  useChatStore.getState().clearHistoryLoading()
  useTeamWorkspaceDataStore.getState().dropPendingApprovalSaves()
}
