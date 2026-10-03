/** Session library API: catalog history and recovery. */
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
  const resume = async (id: string, operationId?: string) => {
    const saved = catalog.get(id)
    if (!saved) throw new Error('Session not found')
    const live =
      sessions.findLive(saved) ||
      sessions.resume(id, options.commandFor, operationId)
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
        return record ? [toAgentSession(record)] : []
      }),
      ...preview,
      events: catalog.events(session.id),
    } satisfies HistoryDetail)
  })
  app.post(`${api}/:id/resume`, async (c) => {
    const body: { operationId?: string } = await c.req
      .json<{ operationId?: string }>()
      .catch(() => ({}))
    if (
      body.operationId !== undefined &&
      (typeof body.operationId !== 'string' || body.operationId.length > 128)
    )
      throw new Error('Invalid operation ID')
    return c.json(await resume(c.req.param('id'), body.operationId))
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
  parent.route('/', app)
  return { resume }
}
