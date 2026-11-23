// The CLI serializes each tool argument as JSON inside the planner response.
import path from 'node:path'
import type { ExtractedMediaItem } from './mediaExtractor'
import { asRecord } from '../shared/json'

export function antigravityArtifacts(step: Record<string, unknown>): ExtractedMediaItem[] {
  if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL' || !Array.isArray(step.tool_calls)) return []
  const items: ExtractedMediaItem[] = []
  for (const call of step.tool_calls) {
    if (call?.name !== 'write_file' || !call.args?.ArtifactMetadata) continue
    try {
      const metadata = asRecord(JSON.parse(call.args.ArtifactMetadata))
      if (metadata?.UserFacing !== true) continue
      const file = JSON.parse(call.args.Path), text = JSON.parse(call.args.Content)
      if (typeof file !== 'string' || typeof text !== 'string' || !/\.(md|txt)$/i.test(file)) continue
      items.push({ kind: 'document', mediaType: 'text/plain', label: path.basename(file),
        data: Buffer.from(text).toString('base64') })
    } catch { /* An incomplete tool call does not identify a displayable artifact. */ }
  }
  return items
}
