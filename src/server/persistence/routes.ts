/** Session library API: history, recovery, workspace groups and backup management. */
import fs from 'node:fs'
import { Hono } from 'hono'
import type { Session } from '../../shared/types'
import type {
  HistoryQuery,
  Lifecycle,
  PersistenceSettings,
  HistoryDetail,
} from '../../shared/persistence'
import type { AgentSessionRecord } from '../db'
import type { PersistenceRuntime } from './runtime'
import { savePersistenceSettings } from './settings'
import { toAgentSession } from '../agentSessions'

export function registerPersistenceRoutes(
  parent: Hono,
  runtime: PersistenceRuntime,
  options: {
    commandFor: (r: AgentSessionRecord) => string
    changed: () => void
    activated: (s: Session) => void
  }
) {
  const app = new Hono()
  app.onError((error, c) => c.json({ error: error.message }, 400))
  const { sessions, db } = runtime,
    { catalog } = sessions
  const resume = async (
    id: string,
    operationId?: string,
    restoreSource = false
  ) => {
    const saved = catalog.get(id)
    if (!saved) throw new Error('Session not found')
    const existing = sessions.findLive(saved)
    if (!existing && saved.providerId) {
      const record = db.getSessionById(saved.providerId)
      if (record && !fs.existsSync(record.logFilePath)) {
        if (!restoreSource)
          throw new Error(
            'Source conversation is missing. Restore its archived log before resuming.'
          )
        await runtime.archives?.restoreSource(saved.providerId)
      }
    }
    const live =
      existing || sessions.resume(id, options.commandFor, operationId)
    options.activated(live)
    options.changed()
    return live
  }
  const api = '/api/library'
  app.use(`${api}/*`, async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).host !== new URL(c.req.url).host)
        return c.json({ error: 'Cross-origin mutation rejected' }, 403)
    }
    await next()
  })
  app.get(api, (c) => {
    const q = c.req.query()
    return c.json(
      catalog.history({
        q: q.q,
        state: q.state as HistoryQuery['state'],
        project: q.project,
        agent: q.agent,
        pinned: q.pinned === 'true',
        hours: Number(q.hours),
        cursor: q.cursor,
        limit: Number(q.limit),
      })
    )
  })
  app.get(`${api}/health`, (c) => c.json(runtime.health()))
  app.put(`${api}/settings`, async (c) =>
    c.json(
      savePersistenceSettings(
        db,
        await c.req.json<Partial<PersistenceSettings>>()
      )
    )
  )
  app.post(`${api}/reindex`, async (c) => {
    await runtime.indexer.tick(true)
    return c.json(runtime.health())
  })
  app.get(`${api}/workspaces`, (c) => c.json(catalog.workspaces()))
  app.post(`${api}/workspaces`, async (c) => {
    const body = await c.req.json<{ name: string; sessionIds: string[] }>()
    if (
      typeof body.name !== 'string' ||
      !Array.isArray(body.sessionIds) ||
      body.sessionIds.some((x) => typeof x !== 'string')
    )
      throw new Error('Invalid workspace')
    return c.json(catalog.saveWorkspace(body.name, body.sessionIds))
  })
  app.delete(`${api}/workspaces/:id`, (c) => {
    catalog.deleteWorkspace(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post(`${api}/workspaces/:id/resume`, async (c) => {
    const workspace = catalog
      .workspaces()
      .find((w) => w.id === c.req.param('id'))
    if (!workspace) throw new Error('Workspace not found')
    const results = []
    for (const id of workspace.sessionIds)
      try {
        results.push({ id, ok: true, session: await resume(id) })
      } catch (error) {
        results.push({ id, ok: false, error: String(error) })
      }
    return c.json({ results })
  })
  app.get(`${api}/backups`, (c) => c.json(runtime.backups?.list() || []))
  app.post(`${api}/backups`, (c) => {
    if (!runtime.backups) throw new Error('Backups require a file database')
    return c.json(runtime.backups.create())
  })
  app.get(`${api}/backups/:name/download`, (c) => {
    if (!runtime.backups) throw new Error('Backups unavailable')
    const name = c.req.param('name'),
      file = runtime.backups.resolve(name)
    return new Response(Bun.file(file), {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    })
  })
  app.post(`${api}/backups/:name/restore`, (c) => {
    if (!runtime.backups) throw new Error('Backups unavailable')
    runtime.backups.scheduleRestore(c.req.param('name'))
    return c.json({
      ok: true,
      message:
        'Restore scheduled for the next Agentboard restart. The current database will be backed up first.',
    })
  })
  app.get(`${api}/:id`, (c) => {
    const session = catalog.get(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    const preview = db.db
      .query(
        'SELECT terminal_preview AS terminalPreview, terminal_preview_at AS terminalPreviewAt FROM board_sessions WHERE id=?'
      )
      .get(session.id) as Pick<
      HistoryDetail,
      'terminalPreview' | 'terminalPreviewAt'
    >
    return c.json({
      session,
      conversations: (
        db.db
          .query(
            'SELECT provider_id AS id FROM session_conversations WHERE session_id=? ORDER BY linked_at DESC'
          )
          .all(session.id) as { id: string }[]
      ).flatMap(({ id }) => {
        const record = db.getSessionById(id)
        return record
          ? [
              {
                ...toAgentSession(record),
                archive: runtime.archives?.info(id) || null,
              },
            ]
          : []
      }),
      ...preview,
      events: catalog.events(session.id),
    } satisfies HistoryDetail)
  })
  app.post(`${api}/:id/resume`, async (c) => {
    const body: { operationId?: string; restoreSource?: boolean } = await c.req
      .json<{ operationId?: string; restoreSource?: boolean }>()
      .catch(() => ({}))
    if (
      body.restoreSource !== undefined &&
      typeof body.restoreSource !== 'boolean'
    )
      throw new Error('Invalid restore choice')
    if (
      body.operationId !== undefined &&
      (typeof body.operationId !== 'string' || body.operationId.length > 128)
    )
      throw new Error('Invalid operation ID')
    return c.json(
      await resume(c.req.param('id'), body.operationId, body.restoreSource)
    )
  })
  app.patch(`${api}/:id`, async (c) => {
    const saved = catalog.get(c.req.param('id'))
    if (!saved) return c.json({ error: 'Session not found' }, 404)
    const body = await c.req.json<{
      name?: string
      pinned?: boolean
      state?: Lifecycle
    }>()
    if (body.name !== undefined && typeof body.name !== 'string')
      throw new Error('Invalid name')
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean')
      throw new Error('Invalid pin')
    if (
      body.state !== undefined &&
      body.state !== 'archived' &&
      body.state !== 'hibernating'
    )
      throw new Error('Choose archived or hibernating')
    if (body.name !== undefined) {
      if (saved.window) sessions.renameWindow(saved.window, body.name)
      else {
        catalog.rename(saved.id, body.name)
        if (saved.providerId)
          db.updateSession(saved.providerId, { displayName: body.name })
      }
    }
    if (body.pinned !== undefined) {
      catalog.pin(saved.id, body.pinned)
    }
    if (body.state !== undefined) {
      sessions.stop(saved, body.state)
    }
    options.changed()
    return c.json(catalog.get(saved.id))
  })
  app.get(`${api}/:id/archive`, async (c) => {
    const saved = catalog.get(c.req.param('id'))
    const providerId = c.req.query('provider') || saved?.providerId
    if (
      !saved ||
      !providerId ||
      !runtime.archives ||
      !db.db
        .query(
          'SELECT 1 FROM session_conversations WHERE session_id=? AND provider_id=?'
        )
        .get(saved.id, providerId)
    )
      return c.json({ error: 'No conversation archive' }, 404)
    const row = await runtime.archives.verify(providerId)
    return new Response(Bun.file(row.archive_path), {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="conversation-${saved.id}.jsonl"`,
      },
    })
  })
  parent.route('/', app)
  return { resume }
}
