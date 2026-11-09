// Use the PWA's event normalization in JavaScriptCore; do not fork agent parsers.
import { parseAndNormalizeAgentLogLine } from '../../src/shared/eventTaxonomy'
;(globalThis as any).normalizeTranscript = (lines: string[]) => JSON.stringify(lines.flatMap((line, index) => {
 const parsed = parseAndNormalizeAgentLogLine(line)
 return parsed.events.map((event, seq) => ({id: `${index}:${seq}`, role:event.role, kind:event.kind, text:event.text}))
}))
import { inferAgentType } from '../../src/shared/agentDetection'
import { commandHasYoloFlag, yoloFlagFor, yoloConflict, addYoloFlag, removeYoloFlag } from '../../src/shared/yolo'
;(globalThis as any).commandPermission = (command: string) => {
 const agent = inferAgentType(command)
 return JSON.stringify({available: !!yoloFlagFor(agent), enabled: commandHasYoloFlag(command, agent), conflict: agent ? yoloConflict(command, agent) : null})
}
;(globalThis as any).setCommandPermission = (command: string, enabled: boolean) => {
 const agent = inferAgentType(command)
 return agent ? (enabled ? addYoloFlag(command, agent) : removeYoloFlag(command, agent)) : command
}

import { selectedSnapshotText } from '../../src/client/utils/snapshotText'
import { findWrappedRows } from '../../src/client/utils/snapshotRejoin'
;(globalThis as any).snapshotCopy = (text: string, offset: number, length: number, columns: number, rejoin: boolean) => {
 const lines = text.split('\n')
 const point = (at: number) => { const prefix = text.slice(0, at).split('\n'); return {line: prefix.length - 1, col: prefix[prefix.length - 1].length} }
 return selectedSnapshotText(lines, point(offset), point(offset + length), rejoin ? findWrappedRows(lines, columns) : [])
}
