// seed.ts - Puts the curated scenes onto the isolated instance.
//
// Order matters: transcripts and panes exist before the server boots, so its
// first discovery pass already sees them. Then we wait until the server has
// matched every pane to its transcript, hibernate the two dormant sessions
// through the same WebSocket message the UI sends, and only then switch the
// permission scene to its prompt (a "1. Yes" line would otherwise look like
// a user prompt to the matcher while it is still matching).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from '@playwright/test'
import { baseUrl, paths, projectDir, REMOTE_HOST, TMUX_SESSION, tmux } from './instance'
import { drawMedia } from './media'
import { ACTIVE, REMOTE, type Scene } from './scenes'
import { writeDormantTranscripts, writeLiveTranscripts, type WrittenLog } from './transcripts'

export interface Seeded {
  live: WrittenLog[]
  hibernate: WrittenLog[]
  history: WrittenLog[]
}

export function setMode(sceneId: string, mode: Scene['mode']): void {
  writeFileSync(join(paths.state, `${sceneId}.mode`), mode)
}

function newWindow(id: string, agent: string, project: string, socket?: string, session = TMUX_SESSION): void {
  mkdirSync(projectDir(project), { recursive: true })
  tmux(['new-window', '-d', '-t', `${session}:`, '-n', id, '-c', projectDir(project), `${agent} ${id}`], socket)
}

/** Everything that must exist before the server starts. */
export async function seedFiles(browser: Browser): Promise<Seeded> {
  const media = await drawMedia(browser)
  const live = writeLiveTranscripts(ACTIVE, media)
  const { hibernate, history } = writeDormantTranscripts()

  for (const scene of [...ACTIVE, ...REMOTE]) {
    setMode(scene.id, scene.mode === 'permission' ? 'working' : scene.mode)
  }
  for (const scene of ACTIVE) newWindow(scene.id, scene.agent, scene.project)
  // On the remote host each agent runs in its own tmux session, which is how
  // Agentboard names discovered (external) sessions.
  for (const scene of REMOTE) {
    mkdirSync(projectDir(scene.project), { recursive: true })
    tmux(['new-session', '-d', '-s', scene.id, '-c', projectDir(scene.project), `${scene.agent} ${scene.id}`], paths.remoteSocket)
  }
  for (const log of hibernate) {
    const agent = log.logPath.includes('/.codex/') ? 'codex' : 'claude'
    const project = log.sceneId === 'pricing-a11y' ? 'storefront' : 'acme-api'
    newWindow(log.sceneId, agent, project)
  }
  return { live, hibernate, history }
}

interface ApiSession { name: string; agentSessionId?: string; host?: string; status?: string }

export async function sessions(): Promise<ApiSession[]> {
  return (await (await fetch(`${baseUrl}/api/sessions`)).json()) as ApiSession[]
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(1000)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function putSettings(settings: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/settings/synced`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  if (!res.ok) throw new Error(`settings PUT failed: ${res.status} ${await res.text()}`)
}

/** The full board (local + remote) as the UI receives it. */
export function boardSessions(): Promise<ApiSession[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?catalog=2`)
    const timer = setTimeout(() => { ws.close(); reject(new Error('websocket timeout')) }, 15_000)
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type?: string; sessions?: ApiSession[] }
      if (msg.type === 'sessions') { clearTimeout(timer); ws.close(); resolve(msg.sessions ?? []) }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
  })
}

function sendWs(messages: Record<string, unknown>[], until: (msg: Record<string, unknown>) => boolean, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?catalog=2`)
    let seen = 0
    const timer = setTimeout(() => { ws.close(); reject(new Error('websocket timeout')) }, 30_000)
    ws.onopen = () => messages.forEach((m) => ws.send(JSON.stringify(m)))
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>
      if (until(msg)) {
        if (msg.ok === false) { clearTimeout(timer); ws.close(); reject(new Error(JSON.stringify(msg))); return }
        if (++seen >= count) { clearTimeout(timer); ws.close(); resolve() }
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
  })
}

/** After server start: wait for matching, hibernate, arm the permission prompt. */
export async function settle(seeded: Seeded): Promise<void> {
  const expected = [...seeded.live, ...seeded.hibernate]
  await waitFor('every pane to match its transcript', async () => {
    const list = await sessions()
    return expected.every((log) => list.some((s) => s.name === log.sceneId && s.agentSessionId === log.sessionId))
  })
  await waitFor('remote host sessions', async () => {
    const list = await boardSessions()
    return REMOTE.every((scene) => list.some((s) => s.name === scene.id && s.host === REMOTE_HOST))
  })
  await sendWs(
    seeded.hibernate.map((log) => ({ type: 'session-hibernate', sessionId: log.sessionId })),
    (msg) => msg.type === 'session-hibernate-result',
    seeded.hibernate.length,
  )
  for (const scene of ACTIVE) if (scene.mode === 'permission') setMode(scene.id, 'permission')
}
