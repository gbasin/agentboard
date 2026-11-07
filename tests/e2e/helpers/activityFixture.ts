// Fixture CLIs render a real prompt in private tmux. Only transcripts are synthetic.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { socketPath } from '../tmuxReap'

export const activityLine = (value: object) => JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + '\n'
function tmux(args: string[]) {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir || !process.env.E2E_TMUX_SESSION) throw new Error('Requires isolated E2E environment')
  const env = { ...process.env }; delete env.TMUX
  const result = spawnSync('tmux', ['-S', socketPath(dir), ...args], { env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
export function seedActivity(kind: 'claude' | 'codex') {
  const root = process.env.E2E_TMUX_TMPDIR!
  const sessionId = randomUUID(), childId = randomUUID()
  const name = `activity-${kind}-${sessionId.slice(0, 8)}`
  const project = path.join(root, name)
  fs.mkdirSync(project)
  const prompt = `Inspect fixture ${sessionId.slice(0, 8)}`
  const userPrompt = () => activityLine(kind === 'claude'
    ? { type: 'user', sessionId, cwd: project, message: { role: 'user', content: prompt } }
    : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } })
  const textFile = path.join(project, 'prompt.txt')
  fs.writeFileSync(textFile, `${kind === 'claude' ? '❯' : '›'} ${prompt}\n`)
  const fixtureCli = path.join(project, kind)
  const gate = path.join(project, 'ready')
  // Print only after setting deterministic private-window geometry. This
  // prevents an earlier phone viewport from wrapping the matching prompt.
  fs.writeFileSync(fixtureCli, `#!/bin/sh\nwhile [ ! -f '${gate}' ]; do sleep 0.01; done\ncat '${textFile}'\nsleep 600\n`, { mode: 0o755 })
  let log: string, child: string
  if (kind === 'claude') {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', project.replace(/\//g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    log = path.join(dir, `${sessionId}.jsonl`)
    fs.writeFileSync(log, userPrompt() + activityLine({ type: 'api-request' }))
    const childDir = path.join(dir, sessionId, 'subagents')
    fs.mkdirSync(childDir, { recursive: true })
    child = path.join(childDir, `agent-${childId}.jsonl`)
    fs.writeFileSync(child, activityLine({ type: 'assistant', sessionId, agentId: childId, isSidechain: true, cwd: project, message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'private command must not appear' } }] } }))
    fs.writeFileSync(child.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Review activity parser' }))
  } else {
    const dir = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '30')
    fs.mkdirSync(dir, { recursive: true })
    log = path.join(dir, `rollout-${sessionId}.jsonl`)
    fs.writeFileSync(log, activityLine({ type: 'session_meta', payload: { id: sessionId, cwd: project, source: 'cli' } }) + userPrompt() + activityLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'main1' } }))
    child = path.join(dir, `rollout-${childId}.jsonl`)
    fs.writeFileSync(child, activityLine({ type: 'session_meta', payload: { id: childId, cwd: project, source: { subagent: { thread_spawn: { parent_thread_id: sessionId, agent_path: '/root/review-parser' } } } } }) + activityLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child1' } }) + activityLine({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'exec1', name: 'exec', input: 'secret body' } }))
  }
  // Publish complete transcripts before the board can discover the window or
  // its prompt. Discovery must never cache a fixture's half-created log tree.
  const windowId = tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `=${process.env.E2E_TMUX_SESSION}`, '-n', name, '-c', project, fixtureCli])
  tmux(['resize-window', '-t', windowId, '-x', '160', '-y', '40'])
  const windowSize = tmux(['display-message', '-p', '-t', windowId, '#{window_width}x#{window_height}'])
  fs.writeFileSync(gate, 'ready')
  return {
    name, log, child, sessionId, project, windowSize,
    // A missed first match is retried on log growth. Model the CLI continuing
    // to emit records until associated, then freeze the parent for child tests.
    refreshPrompt() { fs.appendFileSync(log, userPrompt()) },
    append(value: object) { fs.appendFileSync(child, activityLine(value)) },
    capture() { return tmux(['capture-pane', '-p', '-J', '-t', windowId, '-S', '-100']) },
    stop() { tmux(['kill-window', '-t', windowId]) },
  }
}
