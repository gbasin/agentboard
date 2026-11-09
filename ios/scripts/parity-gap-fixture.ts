/**
 * Deterministic native UI protocol fixture. Run: bun ios/scripts/parity-gap-fixture.ts
 * Binds only loopback (default port 4192; override with IOS_PARITY_GAP_PORT); never contacts tmux, SSH, GitHub or a live backend.
 * POST /__fixture/reset {scenario:"filters"|"hidden"|"remote"|"recovery"|"reorder"} before each test.
 * POST /__fixture/control {allowed:true} and /__fixture/interrupt simulate server events.
 * POST /__fixture/menu-update injects terminal output and session metadata while a menu is open.
 */
import type { ServerWebSocket } from 'bun'

type Socket = ServerWebSocket<Record<string, never>>
type Settings = Record<string, unknown>
const clients = new Set<Socket>()
let scenario = 'filters'
let allowControl = false
let generation = crypto.randomUUID()
let interruptedIds: string[] = []
let settings: Settings = {}
let input: string[] = []
let pastes: string[] = []
const time = '2026-11-07T12:00:00.000Z'
const sessions = [
  { id: 'alpha-local', name: 'Alpha local', projectPath: '/work/alpha', host: 'laptop', remote: false, source: 'managed', status: 'working' },
  { id: 'alpha-remote', name: 'Alpha remote', projectPath: '/work/alpha', host: 'remote', remote: true, source: 'managed', status: 'waiting' },
  { id: 'beta-approval', name: 'Beta approval', projectPath: '/work/beta', host: 'laptop', remote: false, source: 'managed', status: 'permission' },
  { id: 'remote-external', name: 'External remote', projectPath: '/work/external', host: 'remote', remote: true, source: 'external', status: 'waiting' },
].map((session, index) => ({ ...session, agentType: 'codex', agentSessionId: session.id + '-agent', boardSessionId: session.id + '-saved', command: 'codex', createdAt: new Date(Date.parse(time) - index * 60_000).toISOString(), lastActivity: time, lastUserMessage: '', media: [], prs: [] }))
const glassSessions = sessions.slice(0, 3).map((session, index) => ({
  ...session, lastActivity: new Date().toISOString(),
  lastUserMessage: ['Review the native session switcher and keep every terminal action.', 'Test reconnects after the phone returns from background.', 'Waiting for approval to run the test suite.'][index],
  prs: index === 0 ? [{ repo: 'agentboard', number: 525, url: 'https://github.com/example/agentboard/pull/525' }] : [],
  media: index === 0 ? [{ kind: 'link', url: 'https://example.com', label: 'Implementation notes' }] : [],
  activity: index === 0 ? {
    main: { phase: 'model', label: 'Reviewing changes', tools: [] },
    subagents: [{ id: 'reviewer', name: 'UI reviewer', activity: { phase: 'tool', label: 'Reading tests', tools: ['Read'] } }],
    running: 1, unknown: 0, blocked: 0, total: 1, truncated: false,
  } : undefined,
}))
const conversation = (id: string, name: string, projectPath: string, host: string, sleeping: boolean) => ({
  sessionId: id, displayName: name, projectPath, host, agentType: 'codex', lastActivityAt: time,
  lastUserMessage: '', isHibernating: sleeping, lastResumeError: null, media: [], prs: [],
})
const conversations = (sleeping: boolean) => [
  conversation(`${sleeping}-alpha-local`, `${sleeping ? 'Sleeping' : 'History'} Alpha local`, '/work/alpha', 'laptop', sleeping),
  conversation(`${sleeping}-alpha-remote`, `${sleeping ? 'Sleeping' : 'History'} Alpha remote`, '/work/alpha', 'remote', sleeping),
  conversation(`${sleeping}-beta`, `${sleeping ? 'Sleeping' : 'History'} Beta`, '/work/beta', 'laptop', sleeping),
  conversation(`${sleeping}-dormant`, `${sleeping ? 'Sleeping' : 'History'} Dormant only`, '/work/dormant-only', 'offline-host', sleeping),
]
const send = (socket: Socket, value: unknown) => socket.send(JSON.stringify(value))
const broadcast = (value: unknown) => { for (const socket of clients) send(socket, value) }
const config = () => ({ type: 'server-config', remoteAllowAttach: true, remoteAllowControl: allowControl })
function snapshot(socket: Socket) {
  send(socket, config())
  send(socket, { type: 'synced-settings', settings })
  send(socket, { type: 'host-status', hosts: [{ host: 'laptop', ok: true }, { host: 'remote', ok: true }, { host: 'offline-host', ok: false, error: 'Host unreachable' }] })
  send(socket, { type: 'agent-sessions', hibernating: conversations(true), history: conversations(false) })
  send(socket, { type: 'sessions', sessions: scenario === 'recovery' ? [] : scenario === 'reorder' ? sessions.slice(0, 2) : scenario === 'glass' ? glassSessions : sessions })
}
function reset(next: string) {
  input = []; pastes = []; scenario = next; allowControl = false; generation = crypto.randomUUID()
  interruptedIds = (next === 'recovery' || next === 'glass') ? [generation + '-first'] : []
  settings = { projectFilters: next === 'hidden' ? ['/work/alpha'] : [], hostFilters: [], sessionSortMode: 'created', sessionSortDirection: 'desc', showProjectName: true, theme: 'system' }
  for (const socket of clients) snapshot(socket)
  broadcast({ type: 'library-changed' })
}
reset('filters')
Bun.serve<Record<string, never>>({
  hostname: '127.0.0.1', port: Number(process.env.IOS_PARITY_GAP_PORT) || 4192,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      if (server.upgrade(request, { data: {} })) return
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname === '/__fixture/reset' && request.method === 'POST') {
      const body = await request.json() as { scenario?: string }
      reset(body.scenario ?? 'filters'); return Response.json({ ok: true })
    }
    if (url.pathname === '/__fixture/control' && request.method === 'POST') {
      const body = await request.json() as { allowed?: boolean }
      allowControl = body.allowed === true; broadcast(config()); return Response.json({ ok: true })
    }
    if (url.pathname === '/__fixture/interrupt' && request.method === 'POST') {
      interruptedIds.push(generation + '-' + crypto.randomUUID()); broadcast({ type: 'library-changed' }); return Response.json({ ok: true })
    }
    if (url.pathname === '/__fixture/menu-update' && request.method === 'POST') {
      const lastActivity = new Date().toISOString()
      const session = { ...glassSessions[0], name: 'Alpha updated', lastActivity, lastUserMessage: 'Background update ' + lastActivity }
      broadcast({ type: 'session-update', session })
      broadcast({ type: 'terminal-output', sessionId: glassSessions[0].id, data: 'Background output\r\n' })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/__fixture/input') return Response.json({ input, pastes })
    if (url.pathname === '/api/pr-info') return Response.json([{ url: glassSessions[0].prs[0].url, state: 'MERGED', isDraft: false }])
    if (url.pathname === '/api/settings/synced') {
      if (request.method === 'PUT') {
        const startedAt = new Date().toISOString()
        const body = await request.json() as { settings: Settings }
        const keys = Object.keys(body.settings).sort()
        console.log(JSON.stringify({ event: 'settings-put-start', timestamp: startedAt, keys }))
        settings = { ...settings, ...body.settings }; broadcast({ type: 'synced-settings', settings })
        console.log(JSON.stringify({ event: 'settings-put-result', timestamp: new Date().toISOString(), keys, status: 200,
          manualSessionOrder: settings.manualSessionOrder ?? null, sessionSortMode: settings.sessionSortMode ?? null }))
      }
      return Response.json({ settings })
    }
    if (url.pathname === '/api/library/health') return Response.json({ interrupted: interruptedIds.length, interruptedIds, error: null, matchingAvailable: true, matchingError: null, settings: { autoResume: false, capturePreviews: true } })
    if (url.pathname === '/api/library') {
      const state = url.searchParams.get('state')
      const saved = interruptedIds.map(id => ({ id, name: 'Recovered fixture', projectPath: '/work/alpha', agentType: 'codex', providerId: id, command: 'codex', state: 'interrupted', pinned: false, lastActivityAt: time, error: null, preview: null }))
      return Response.json({ sessions: !state || state === 'all' || state === 'interrupted' ? saved : [], nextCursor: null })
    }
    return Response.json({ error: `Unsupported fixture route: ${url.pathname}` }, { status: 404 })
  },
  websocket: {
    open(socket) { clients.add(socket); snapshot(socket) },
    close(socket) { clients.delete(socket) },
    message(socket, raw) {
      const message = JSON.parse(String(raw)) as { type: string; seq?: number; sessionId?: string; data?: string }
      if (message.type === 'terminal-input' && message.data) input.push(message.data)
      if (message.type === 'terminal-paste' && message.data) pastes.push(message.data)
      if (message.type === 'ping') send(socket, { type: 'pong', seq: message.seq })
      if (message.type === 'terminal-attach') {
        send(socket, { type: 'terminal-ready', sessionId: message.sessionId })
        send(socket, { type: 'terminal-output', sessionId: message.sessionId, data: 'Deterministic capability fixture. No remote shell is running.\r\n' })
      }
      if (message.type === 'sessions-list') snapshot(socket)
    },
  },
})
console.log(`Native parity gap fixture: http://127.0.0.1:${Number(process.env.IOS_PARITY_GAP_PORT) || 4192}`)
