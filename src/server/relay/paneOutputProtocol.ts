/** Internal shared-output broker RPC; subscription IDs are unique across lease realms. */
export type PaneOutputRequest =
  | { type: 'pane-subscribe'; id: string; key: string; target: string }
  | { type: 'pane-release'; id: string }
  | { type: 'pane-credit'; id: string; bytes: number }
export type PaneOutputResponse =
  | { type: 'pane-ready' | 'pane-exit' | 'pane-released' | 'pane-overflow'; id: string }
  | { type: 'pane-data'; id: string; data: string }
  | { type: 'pane-error'; id: string; error: string }

export type PaneBrokerRequest = PaneOutputRequest | { type: 'pane-shutdown' }
export type PaneBrokerResponse = PaneOutputResponse
  | { type: 'pane-stopped' }
  | { type: 'pane-resource'; key: string; target: string; root: string; pid?: number; closed?: true }
