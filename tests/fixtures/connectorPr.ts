// Synthetic Codex nested MCP completion, matching the reported mixed-exec log.
export const connectorPrUrl = 'https://github.com/gbasin/agentboard/pull/522'
export function connectorPrCompletion(itemOverrides: Record<string, unknown> = {}) {
  return { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'McpToolCall', id: 'exec-create', server: 'codex_apps',
    tool: 'github.create_pull_request', status: 'completed',
    result: { isError: false, structuredContent: { url: connectorPrUrl, number: 522 } },
    ...itemOverrides,
  } } }
}
