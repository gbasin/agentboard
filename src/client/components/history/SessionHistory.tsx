/** Searchable durable history, interrupted-session recovery and named workspaces. */
import { useEffect, useRef, useState } from 'react'
import type {
  HistoryPage,
  HistoryQuery,
  PersistenceHealth,
  SavedSession,
  SavedWorkspace,
} from '@shared/persistence'
import type { Session, ServerMessage } from '@shared/types'
import { HistoryDetails, type HistoryDetail } from './HistoryDetails'
import { WorkspacePanel } from './WorkspacePanel'
import { createOperationId } from '../../utils/operationId'
import { HistoryRow } from './HistoryRow'
import { StoragePanel } from './StoragePanel'
import { historyButton, libraryRequest } from './api'

export default function SessionHistory({
  open,
  onClose,
  onOpenSession,
  subscribe,
}: {
  subscribe: (listener: (message: ServerMessage) => void) => () => void
  open: boolean
  onClose: () => void
  onOpenSession: (session: Session) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    requestNumber = useRef(0)
  const [tab, setTab] = useState<'sessions' | 'workspaces' | 'storage'>(
    'sessions'
  )
  const [q, setQ] = useState(''),
    [state, setState] = useState<HistoryQuery['state']>('all'),
    [hours, setHours] = useState('0'),
    [pinned, setPinned] = useState(false),
    [agent, setAgent] = useState('')
  const [page, setPage] = useState<HistoryPage>({
      sessions: [],
      nextCursor: null,
    }),
    [health, setHealth] = useState<PersistenceHealth | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const [workspaces, setWorkspaces] = useState<SavedWorkspace[]>([]),
    [notice, setNotice] = useState('')
  const [detail, setDetail] = useState<HistoryDetail | null>(null)
  const query = () =>
    new URLSearchParams({
      q,
      agent,
      state: state || 'all',
      hours,
      pinned: String(pinned),
      limit: '50',
    })
  const refreshHealth = () =>
    libraryRequest<PersistenceHealth>('/health')
      .then(setHealth)
      .catch((e) => setError(String(e)))
  const load = async (append = false) => {
    const number = ++requestNumber.current
    setLoading(true)
    try {
      const params = query()
      if (append && page.nextCursor) params.set('cursor', page.nextCursor)
      const result = await libraryRequest<HistoryPage>(`?${params}`)
      if (number === requestNumber.current)
        setPage((old) => ({
          ...result,
          sessions: append
            ? [...old.sessions, ...result.sessions].filter(
                (s, i, a) => a.findIndex((x) => x.id === s.id) === i
              )
            : result.sessions,
        }))
    } catch (e) {
      if (number === requestNumber.current) setError(String(e))
    } finally {
      if (number === requestNumber.current) setLoading(false)
    }
  }
  const refresh = async () => {
    await Promise.all([
      load(),
      refreshHealth(),
      libraryRequest<SavedWorkspace[]>('/workspaces').then(setWorkspaces),
    ])
  }
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    void refreshHealth()
    void libraryRequest<SavedWorkspace[]>('/workspaces')
      .then(setWorkspaces)
      .catch((e) => setError(String(e)))
    const timer = setInterval(() => {
      void refreshHealth()
    }, 5000)
    return () => {
      clearInterval(timer)
      requestNumber.current++
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    setSelected(new Set())
    const timer = setTimeout(() => {
      void load()
    }, 150)
    return () => clearTimeout(timer)
  }, [open, q, state, hours, pinned, agent])
  useEffect(() => {
    if (!open) return
    return subscribe((message) => {
      if (message.type === 'library-changed') {
        void load()
        void refreshHealth()
      }
    })
  }, [open, subscribe, q, state, hours, pinned, agent])
  const selectAllMatching = async () => {
    const ids = new Set<string>()
    let cursor: string | null = null
    do {
      const params = query()
      if (cursor) params.set('cursor', cursor)
      const result = await libraryRequest<HistoryPage>(`?${params}`)
      result.sessions.forEach((s) => ids.add(s.id))
      cursor = result.nextCursor
    } while (cursor)
    setSelected(ids)
  }
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const reopen = async (id: string, focus = true, restoreSource = false) => {
    const live = await libraryRequest<Session>(
      `/${encodeURIComponent(id)}/resume`,
      'POST',
      { operationId: createOperationId(), restoreSource }
    )
    if (focus) {
      onOpenSession(live)
      onClose()
    }
    return live
  }
  const reopenSelected = () =>
    act(async () => {
      const failures: string[] = []
      for (const id of selected)
        try {
          await reopen(id, false)
        } catch (e) {
          failures.push(String(e))
        }
      setNotice(`Reopened ${selected.size - failures.length} session(s).`)
      setSelected(new Set())
      if (failures.length) throw new Error(failures.join('\n'))
    })
  const showDetails = (session: SavedSession) =>
    act(async () =>
      setDetail(await libraryRequest(`/${encodeURIComponent(session.id)}`))
    )
  if (!open) return null
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="history-title"
      className="m-auto h-[88vh] w-[min(960px,96vw)] max-w-none border border-border bg-elevated p-0 text-primary backdrop:bg-black/60"
      onClick={(e) => {
        if (
          e.target === e.currentTarget &&
          (e.clientX < e.currentTarget.getBoundingClientRect().left ||
            e.clientX > e.currentTarget.getBoundingClientRect().right)
        )
          onClose()
      }}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2
              id="history-title"
              className="text-base font-semibold text-primary"
            >
              History & recovery
            </h2>
            <p className="mt-1 text-[12px] text-muted">
              Your sessions, across restarts and over time.
            </p>
          </div>
          <button
            className={historyButton}
            onClick={onClose}
            aria-label="Close history"
          >
            Close
          </button>
        </header>
        <nav
          className="flex gap-1 border-b border-border px-4 py-2"
          aria-label="History sections"
        >
          {(['sessions', 'workspaces', 'storage'] as const).map((t) => (
            <button
              key={t}
              className={`${historyButton} ${tab === t ? 'border-accent text-accent' : ''}`}
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t)
                setDetail(null)
              }}
            >
              {t === 'storage'
                ? 'Storage & backups'
                : t === 'sessions'
                  ? 'Sessions'
                  : 'Workspaces'}
            </button>
          ))}
        </nav>
        {error && (
          <div
            role="alert"
            className="whitespace-pre-wrap border-b border-danger px-4 py-2 text-[12px] text-danger"
          >
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="px-4 py-2 text-[12px] text-accent">
            {notice}
          </div>
        )}
        {detail ? (
          <HistoryDetails
            detail={detail}
            busy={busy}
            onBack={() => setDetail(null)}
            onRestore={() => act(() => reopen(detail.session.id, true, true))}
          />
        ) : tab === 'sessions' ? (
          <>
            {!!health?.interrupted && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-approval/5 px-4 py-3 text-[12px]">
                <span>
                  {health.interrupted} interrupted or failed sessions remain
                  saved.
                </span>
                <button
                  className={historyButton}
                  onClick={() => {
                    setState('interrupted')
                    setQ('')
                    setHours('0')
                    setPinned(false)
                    setAgent('')
                  }}
                >
                  Review interrupted sessions
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2 border-b border-border p-3">
              <input
                aria-label="Search saved sessions"
                className="input min-w-40 flex-1"
                placeholder="Search names, projects, messages…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <select
                className="input w-auto"
                aria-label="Session state"
                value={state}
                onChange={(e) =>
                  setState(e.target.value as HistoryQuery['state'])
                }
              >
                {[
                  'all',
                  'previously-open',
                  'interrupted',
                  'running',
                  'hibernating',
                  'archived',
                  'failed',
                ].map((s) => (
                  <option key={s} value={s}>
                    {s === 'all'
                      ? 'All sessions'
                      : s === 'previously-open'
                        ? 'Previously open'
                        : s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <select
                className="input w-auto"
                aria-label="Agent provider"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                <option value="">All providers</option>
                {['claude', 'claude-rp', 'codex', 'pi'].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <select
                className="input w-auto"
                aria-label="History period"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              >
                <option value="0">All time</option>
                <option value="24">Today</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
              </select>
              <label className="flex items-center gap-1 text-[12px]">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(e) => setPinned(e.target.checked)}
                />
                Pinned
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[12px]">
              <button
                className={historyButton}
                onClick={() =>
                  setSelected(new Set(page.sessions.map((s) => s.id)))
                }
              >
                Select visible
              </button>
              <button
                className={historyButton}
                disabled={busy}
                onClick={() => act(selectAllMatching)}
              >
                Select all matching
              </button>
              <span>{selected.size} selected</span>
              <button
                className={historyButton}
                disabled={busy || !selected.size}
                onClick={reopenSelected}
              >
                Reopen selected
              </button>
              <button
                className={historyButton}
                disabled={!selected.size}
                onClick={() => setTab('workspaces')}
              >
                Save as workspace
              </button>
              <button
                className={`${historyButton} ml-auto`}
                disabled={loading}
                onClick={() => {
                  void load()
                }}
              >
                Refresh
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
              {!page.sessions.length && (
                <p className="p-8 text-center text-sm text-muted">
                  {loading
                    ? 'Loading saved sessions…'
                    : 'No saved sessions match these filters.'}
                </p>
              )}
              {page.sessions.map((session) => (
                <HistoryRow
                  key={session.id}
                  session={session}
                  selected={selected.has(session.id)}
                  busy={busy}
                  onSelect={() =>
                    setSelected((old) => {
                      const next = new Set(old)
                      if (next.has(session.id)) next.delete(session.id)
                      else next.add(session.id)
                      return next
                    })
                  }
                  onResume={() => act(() => reopen(session.id))}
                  onChange={(patch) =>
                    act(() => libraryRequest(`/${session.id}`, 'PATCH', patch))
                  }
                  onDetails={() => showDetails(session)}
                />
              ))}
              {page.nextCursor && (
                <div className="p-4 text-center">
                  <button
                    className={historyButton}
                    disabled={loading}
                    onClick={() => {
                      void load(true)
                    }}
                  >
                    Load more sessions
                  </button>
                </div>
              )}
            </div>
          </>
        ) : tab === 'workspaces' ? (
          <WorkspacePanel
            workspaces={workspaces}
            selected={selected}
            busy={busy}
            act={act}
            setNotice={setNotice}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <StoragePanel
              health={health}
              onRefresh={() => {
                void refreshHealth()
              }}
              onError={setError}
            />
          </div>
        )}
      </div>
    </dialog>
  )
}
