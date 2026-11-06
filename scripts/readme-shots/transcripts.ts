// transcripts.ts - Writes agent transcripts (JSONL) for every scene.
//
// The formats match what Claude Code and Codex write, so Agentboard's real
// pipeline does the rest: log matching ties each transcript to its pane, the
// last user message becomes the sidebar's last prompt, `pr-link` records and
// `gh pr create` calls become PR chips, image/document blocks feed the media
// rail, and transcripts without a pane land in History.

import { randomUUID } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, projectDir } from './instance'
import type { MediaSet } from './media'
import { DORMANT, fixtureScene, type Block, type Scene, type Subagent } from './scenes'

export interface WrittenLog {
  sceneId: string
  sessionId: string
  logPath: string
}

const NOW = Date.now()
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

/** Claude encodes the project path into its projects/ directory name. */
const claudeDirName = (cwd: string) => cwd.replace(/[/.]/g, '-')

type Entry = Record<string, unknown>

function claudeEntries(scene: Scene, sessionId: string, cwd: string, media?: MediaSet): Entry[] {
  const entries: Entry[] = []
  const steps = scene.blocks.length + 6
  let step = 0
  const at = () => iso(scene.startedMinutesAgo - (scene.startedMinutesAgo - 1) * (step++ / steps))
  const base = () => ({ sessionId, cwd, timestamp: at(), uuid: randomUUID() })
  const user = (content: unknown, extra: Entry = {}) =>
    entries.push({ type: 'user', ...base(), message: { role: 'user', content }, ...extra })
  const assistant = (content: unknown[]) =>
    entries.push({ type: 'assistant', ...base(), message: { role: 'assistant', content } })
  const toolCall = (name: string, input: Entry, result: unknown, extra: Entry = {}) => {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    assistant([{ type: 'tool_use', id, name, input }])
    user([{ type: 'tool_result', tool_use_id: id, content: result }], extra)
  }
  const image = (name: string) => media?.images.find((i) => i.name === name)

  const emit = (block: Block) => {
    switch (block.t) {
      case 'user': return void user(block.text)
      case 'say': return void assistant([{ type: 'text', text: block.text }])
      case 'todo':
        return toolCall('TodoWrite', { todos: block.items.map(([done, content]) => ({ content, status: done ? 'completed' : 'pending' })) }, 'Todos updated')
      case 'diff':
        return toolCall('Edit', { file_path: join(cwd, block.file), old_string: '…', new_string: '…' }, block.summary)
      case 'tool': {
        const img = block.name === 'Read' ? image(block.arg.split('/').pop()!) : undefined
        if (block.name === 'Read' && media && block.arg.endsWith('.pdf')) {
          return toolCall('Read', { file_path: join(cwd, block.arg) },
            [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.pdf.data } }])
        }
        if (img) {
          return toolCall('Read', { file_path: join(cwd, block.arg) },
            [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } }],
            { toolUseResult: { type: 'image', file: { dimensions: { originalWidth: img.width, originalHeight: img.height } } } })
        }
        const input = block.name === 'Bash' ? { command: block.arg } : { file_path: join(cwd, block.arg) }
        return toolCall(block.name, input, block.out.join('\n'))
      }
    }
  }

  scene.blocks.forEach(emit)
  for (const pr of scene.prs ?? []) {
    entries.push({ type: 'pr-link', sessionId, prNumber: pr.number, prRepository: pr.repo,
      prUrl: `https://github.com/${pr.repo}/pull/${pr.number}`, timestamp: at() })
  }
  return entries
}

function codexEntries(scene: Scene, sessionId: string, cwd: string): Entry[] {
  const entries: Entry[] = []
  const steps = scene.blocks.length + 2
  let step = 0
  const at = () => iso(scene.startedMinutesAgo - (scene.startedMinutesAgo - 1) * (step++ / steps))
  const item = (payload: Entry) => entries.push({ type: 'response_item', timestamp: at(), payload })
  entries.push({ type: 'session_meta', timestamp: at(), payload: {
    id: sessionId, timestamp: iso(scene.startedMinutesAgo), cwd, originator: 'codex_cli_rs', source: 'cli', cli_version: '0.50.0',
  } })
  const shell = (command: string, output: string) => {
    const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    item({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }), call_id: callId })
    item({ type: 'function_call_output', call_id: callId, output })
  }
  for (const block of scene.blocks) {
    if (block.t === 'user') item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: block.text }] })
    else if (block.t === 'say') item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] })
    else if (block.t === 'tool') shell(block.arg, block.out.join('\n'))
    else if (block.t === 'diff') shell(`apply_patch ${block.file}`, block.summary)
  }
  return entries
}

/**
 * Claude keeps subagent transcripts in <session>/subagents/agent-<id>.jsonl
 * with a .meta.json naming the task. The activity reader takes each one's
 * state from its last lifecycle record: a pending tool_use, a user turn
 * (model working), or an assistant end_turn (finished).
 */
function writeSubagents(logPath: string, sessionId: string, cwd: string, subagents: Subagent[]): void {
  const dir = join(logPath.slice(0, -'.jsonl'.length), 'subagents')
  mkdirSync(dir, { recursive: true })
  for (const agent of subagents) {
    const at = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()
    const base = { sessionId, agentId: agent.id, isSidechain: true, cwd }
    const entries: Entry[] = [{ type: 'user', ...base, timestamp: at(agent.secondsAgo + 240), message: { role: 'user', content: agent.task } }]
    const toolId = `toolu_${agent.id}`
    if (agent.state === 'tool') {
      entries.push({ type: 'assistant', ...base, timestamp: at(agent.secondsAgo), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: agent.tool, input: {} }] } })
    } else if (agent.state === 'model') {
      entries.push({ type: 'assistant', ...base, timestamp: at(agent.secondsAgo + 30), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: {} }] } })
      entries.push({ type: 'user', ...base, timestamp: at(agent.secondsAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } })
    } else {
      entries.push({ type: 'assistant', ...base, timestamp: at(agent.secondsAgo), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } })
    }
    const file = join(dir, `agent-${agent.id}.jsonl`)
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ description: agent.task }))
  }
}

function writeJsonl(file: string, entries: Entry[], minutesAgo: number): void {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const when = new Date(NOW - minutesAgo * 60_000)
  utimesSync(file, when, when)
}

function writeScene(scene: Scene, endMinutesAgo: number, media?: MediaSet): WrittenLog {
  const sessionId = randomUUID()
  const cwd = projectDir(scene.project)
  mkdirSync(cwd, { recursive: true })
  let logPath: string
  if (scene.agent === 'claude') {
    const dir = join(paths.claude, 'projects', claudeDirName(cwd))
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, `${sessionId}.jsonl`)
    writeJsonl(logPath, claudeEntries(scene, sessionId, cwd, media), endMinutesAgo)
    if (scene.subagents) writeSubagents(logPath, sessionId, cwd, scene.subagents)
  } else {
    const start = new Date(NOW - scene.startedMinutesAgo * 60_000)
    const day = start.toISOString().slice(0, 10).split('-')
    const dir = join(paths.codex, 'sessions', ...day)
    mkdirSync(dir, { recursive: true })
    const stamp = start.toISOString().slice(0, 19).replace(/:/g, '-')
    logPath = join(dir, `rollout-${stamp}-${sessionId}.jsonl`)
    writeJsonl(logPath, codexEntries(scene, sessionId, cwd), endMinutesAgo)
  }
  return { sceneId: scene.id, sessionId, logPath }
}

/** Transcripts for panes (local scenes and to-be-hibernated sessions). */
export function writeLiveTranscripts(scenes: Scene[], media: MediaSet): WrittenLog[] {
  return scenes.map((scene) => writeScene(scene, 1, scene.media ? media : undefined))
}

/** Dormant sessions: hibernated ones get a pane first; history ones never do. */
export function writeDormantTranscripts(): { hibernate: WrittenLog[]; history: WrittenLog[] } {
  const hibernate: WrittenLog[] = []
  const history: WrittenLog[] = []
  for (const d of DORMANT) {
    const scene = { ...fixtureScene(d.id), prs: d.prs, startedMinutesAgo: d.minutesAgo + 25 }
    const log = writeScene(scene, d.minutesAgo)
    ;(d.hibernate ? hibernate : history).push(log)
  }
  return { hibernate, history }
}
