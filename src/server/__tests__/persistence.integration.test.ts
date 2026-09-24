/** Real crash/reboot recovery on a private tmux socket and throwaway database. */
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import type {
  HistoryPage,
  SavedSession,
} from '../../shared/persistence'
import type { Session } from '../../shared/types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-recovery-'))
const socket = path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default')
const env = {
  ...process.env,
  TMUX_TMPDIR: root,
  TMUX: undefined,
  AGENTBOARD_DB_PATH: path.join(root, 'agentboard.db'),
  AGENTBOARD_TMUX_PID_FILE: path.join(root, 'tmux-server.pid'),
  LOG_FILE: path.join(root, 'agentboard.log'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_HOME: path.join(root, 'codex'),
  PI_HOME: path.join(root, 'pi'),
  AGENTBOARD_PERSISTENCE_MAINTENANCE_MS: '1000',
  TMUX_SESSION: 'recovery-test',
  AGENTBOARD_STATIC_DIR: 'dist/client',
  AGENTBOARD_SKIP_MATCHING_PATTERNS: '',
  NODE_ENV: 'production',
}
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_HOME'] as const)
  fs.mkdirSync(env[key], { recursive: true })
let server: ReturnType<typeof Bun.spawn> | null = null,
  base = ''
let port = 0
async function eventually<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  timeout = 15000
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (valid(value)) return value
    } catch {
      /* server starting */
    }
    await Bun.sleep(100)
  }
  throw new Error(
    `Recovery condition timed out. Log: ${fs.readFileSync(env.LOG_FILE, 'utf8').slice(-4000)}`
  )
}
async function start() {
  if (!port) {
    const listener = net.createServer()
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve)
    )
    port = (listener.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    base = `http://127.0.0.1:${port}`
  }
  server = Bun.spawn(['bun', 'src/server/index.ts'], {
    env: { ...env, PORT: String(port) },
    stdout: 'ignore',
    stderr: Bun.file(path.join(root, 'stderr.log')),
  })
  await eventually(() => fetch(`${base}/api/health`).then((r) => r.ok), Boolean)
}
async function crash() {
  server!.kill('SIGKILL')
  await server!.exited
  server = null
}
async function api<T>(
  suffix: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) options.body = JSON.stringify(body)
  const response = await fetch(`${base}/api/library${suffix}`, options)
  const result = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(result))
  return result as T
}
async function create(name: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Create timed out'))
    }, 10000)
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'session-create',
          projectPath: root,
          name,
          command: 'sh',
          operationId: `create-${name}`,
        })
      )
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const message = JSON.parse(event.data)
      if (message.type === 'session-created') {
        clearTimeout(timer)
        ws.close()
        resolve(message.session)
      }
      if (message.type === 'error') {
        clearTimeout(timer)
        ws.close()
        reject(new Error(message.message))
      }
    }
  })
}
const savedSessions = () =>
  api<HistoryPage>('?limit=100').then((p) =>
    p.sessions.filter((s) => s.origin === 'managed')
  )
afterAll(async () => {
  if (server) {
    server.kill()
    await server.exited
  }
  if (fs.existsSync(socket))
    Bun.spawnSync(['tmux', '-S', socket, 'kill-server'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('A/B/C survive backend crashes, tmux replacement, and repeated reopen', async () => {
  await start()
  for (const prefix of ['A', 'B', 'C']) {
    const live = await create(prefix)
    if (prefix === 'A')
      expect((await create(prefix)).tmuxWindow).toBe(live.tmuxWindow)
    expect(live.boardSessionId).toBeDefined()
    await api(`/${live.boardSessionId}`, 'PATCH', { name: `${prefix}-Saved` })
  }
  const before = await savedSessions()
  const invalid = await fetch(`${base}/api/library/${before[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'invalid name' }),
  })
  expect(invalid.status).toBe(400)
  expect((await invalid.json()).error).toContain('Name must use')
  expect(before.map((s) => s.name).sort()).toEqual([
    'A-Saved',
    'B-Saved',
    'C-Saved',
  ])
  expect(before.every((s) => s.providerId === null)).toBe(true)
  await crash()
  await start()
  const sameServer = await eventually(
    savedSessions,
    (s) => s.length === 3 && s.every((x) => x.state === 'running')
  )
  expect(sameServer.map((s) => s.id).sort()).toEqual(
    before.map((s) => s.id).sort()
  )

  await crash()
  expect(Bun.spawnSync(['tmux', '-S', socket, 'kill-server']).exitCode).toBe(0)
  await start()
  const interrupted = await eventually(
    savedSessions,
    (s) => s.length === 3 && s.every((x) => x.state === 'interrupted')
  )
  expect(interrupted.map((s) => s.name).sort()).toEqual([
    'A-Saved',
    'B-Saved',
    'C-Saved',
  ])
  for (const saved of interrupted)
    await api<Session>(`/${saved.id}/resume`, 'POST', {})
  const id = interrupted[0].id
  const [first, second] = await Promise.all([
    api<Session>(`/${id}/resume`, 'POST', { operationId: 'repeat' }),
    api<Session>(`/${id}/resume`, 'POST', { operationId: 'repeat' }),
  ])
  expect(first.tmuxWindow).toBe(second.tmuxWindow)
  expect(
    (await savedSessions()).filter((s) => s.state === 'running')
  ).toHaveLength(3)
  await api(`/${id}`, 'PATCH', { state: 'hibernating' })
  await api(`/${id}`, 'PATCH', { name: 'Later-name' })
  await crash()
  await start()
  const after = await api<{ session: SavedSession }>(`/${id}`)
  expect(after.session.state).toBe('hibernating')
  expect(after.session.name).toBe('Later-name')
  expect(
    (await savedSessions()).filter((s) => s.state === 'running')
  ).toHaveLength(2)
}, 60000)

test('a pane created before tag commands finish is adopted by its launch identity', async () => {
  await crash()
  const code = `import {initDatabase} from './src/server/db'; import {SessionCatalog} from './src/server/persistence/catalog';
    const db=initDatabase();const catalog=new SessionCatalog(db.db,db.getAppSetting('persistence_host_id')!);
    const saved=catalog.create({name:'D-Gap-Recovery',projectPath:process.argv[1],command:'sh'});
    const run=catalog.beginRun(saved.id);console.log(JSON.stringify({id:saved.id,run:run.id}));db.close();`
  const seed = Bun.spawnSync(['bun', '-e', code, root], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(seed.exitCode).toBe(0)
  const { id, run } = JSON.parse(seed.stdout.toString())
  expect(
    Bun.spawnSync([
      'tmux',
      '-S',
      socket,
      'new-window',
      '-t',
      'recovery-test',
      '-n',
      `__ab_launch__${id}__${run}`,
      '-c',
      root,
      'sh',
    ]).exitCode
  ).toBe(0)
  await start()
  const recovered = await eventually(
    () => api<{ session: SavedSession }>(`/${id}`),
    (r) => r.session.state === 'running'
  )
  expect(recovered.session.name).toBe('D-Gap-Recovery')
  await eventually(
    async () =>
      Bun.spawnSync([
        'tmux',
        '-S',
        socket,
        'show-options',
        '-wqv',
        '-t',
        recovered.session.window!,
        '@agentboard-run-id',
      ])
        .stdout.toString()
        .trim(),
    (value) => value === run
  )
  expect(
    (await savedSessions()).filter((s) => s.name === 'D-Gap-Recovery')
  ).toHaveLength(1)
}, 30000)

test('opt-in automatic recovery reopens interrupted runs and saves bounded terminal previews', async () => {
  await api('/settings', 'PUT', { autoResume: true, capturePreviews: true })
  const active = (await savedSessions()).filter((s) => s.state === 'running')
  await crash()
  Bun.spawnSync(['tmux', '-S', socket, 'kill-server'])
  await start()
  const recovered = await eventually(
    savedSessions,
    (s) => s.filter((x) => x.state === 'running').length === active.length
  )
  expect(recovered.find((s) => s.state === 'hibernating')).toBeDefined()
  const target = recovered.find((s) => s.state === 'running')!
  Bun.spawnSync([
    'tmux',
    '-S',
    socket,
    'send-keys',
    '-t',
    target.window!,
    "printf 'RECOVERY_PREVIEW_TEST\\n'",
    'Enter',
  ])
  const detail = await eventually(
    () =>
      api<{ terminalPreview: string | null; terminalPreviewAt: string | null }>(
        `/${target.id}`
      ),
    (d) => Boolean(d.terminalPreview?.includes('RECOVERY_PREVIEW_TEST'))
  )
  expect(detail.terminalPreviewAt).toBeTruthy()
  expect(detail.terminalPreview!.length).toBeLessThanOrEqual(32768)
}, 30000)
