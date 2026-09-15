/** Recovery storage controls and verified backup export/restore. */
import { useEffect, useState } from 'react'
import type {
  BackupInfo,
  PersistenceHealth,
  PersistenceSettings,
} from '@shared/persistence'
import { libraryRequest, historyButton, sizeLabel } from './api'
export function StoragePanel({
  health,
  onRefresh,
  onError,
}: {
  health: PersistenceHealth | null
  onRefresh: () => void
  onError: (text: string) => void
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [restore, setRestore] = useState<string | null>(null)
  const refresh = () =>
    libraryRequest<BackupInfo[]>('/backups')
      .then(setBackups)
      .catch((e) => onError(String(e)))
  useEffect(() => {
    void refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    onError('')
    try {
      await fn()
      await refresh()
      onRefresh()
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const settings = health?.settings
  const change = (patch: Partial<PersistenceSettings>) =>
    act(() => libraryRequest('/settings', 'PUT', patch))
  return (
    <div className="space-y-5 p-4 text-[12px] text-secondary">
      <section>
        <h3 className="mb-2 text-sm font-semibold text-primary">
          Storage & recovery
        </h3>
        <p>
          Session names and history are retained indefinitely. Conversation
          copies, including versions referenced by retained backups, count
          toward the archive budget. Copying pauses when the budget is full;
          saved copies stay available.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <dt>Last saved</dt>
          <dd>
            {health?.lastSavedAt
              ? new Date(health.lastSavedAt).toLocaleString()
              : 'No saved changes yet'}
          </dd>
          <dt>Pending conversations</dt>
          <dd>{health?.pendingIndex ?? '…'}</dd>
          <dt>Conversation archives</dt>
          <dd>{sizeLabel(health?.archiveBytes || 0)}</dd>
          <dt>Terminal matching</dt>
          <dd>
            {health?.matchingAvailable
              ? 'Available'
              : 'Unavailable — install ripgrep; session saving still works'}
          </dd>
        </dl>
        {health?.indexError && (
          <p className="mt-2 text-approval">Indexing: {health.indexError}</p>
        )}
        {health?.matchingError && (
          <p className="mt-2 text-approval">
            Terminal matching: {health.matchingError}
          </p>
        )}
        {health?.archiveError && (
          <p className="mt-2 text-approval">Archives: {health.archiveError}</p>
        )}
        {health?.backupError && (
          <p className="mt-2 text-approval">Backups: {health.backupError}</p>
        )}
        <button
          className={`${historyButton} mt-3`}
          disabled={busy}
          onClick={() => act(() => libraryRequest('/reindex', 'POST', {}))}
        >
          Scan conversation history
        </button>
      </section>
      {settings && (
        <section className="space-y-3 border-t border-border pt-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.autoResume}
              disabled={busy}
              onChange={(e) => change({ autoResume: e.target.checked })}
            />
            Automatically reopen interrupted agents when Agentboard starts
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.archiveEnabled}
              disabled={busy}
              onChange={(e) => change({ archiveEnabled: e.target.checked })}
            />
            Keep local conversation copies
          </label>
          <label className="flex flex-wrap items-center gap-2">
            Archive budget (MB)
            <input
              aria-label="Archive budget (MB)"
              type="number"
              min="1"
              className="input w-28"
              defaultValue={Math.floor(settings.archiveMaxBytes / 1024 ** 2)}
              onBlur={(e) => {
                const n = Number(e.target.value)
                if (n >= 1 && n * 1024 ** 2 !== settings.archiveMaxBytes)
                  void change({ archiveMaxBytes: Math.floor(n * 1024 ** 2) })
              }}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.capturePreviews}
              disabled={busy}
              onChange={(e) => change({ capturePreviews: e.target.checked })}
            />
            Save the last terminal screen for interrupted sessions
          </label>
          <p>
            Automatic backups: one per hour for {settings.backupHourly} hours,
            daily for {settings.backupDaily} days, monthly for{' '}
            {settings.backupMonthly} months.
          </p>
          <div className="flex flex-wrap gap-3">
            {(['backupHourly', 'backupDaily', 'backupMonthly'] as const).map(
              (key, i) => (
                <label key={key}>
                  {['Hours', 'Days', 'Months'][i]}
                  <input
                    className="input mt-1 w-20"
                    type="number"
                    min="1"
                    max="365"
                    defaultValue={settings[key]}
                    onBlur={(e) => {
                      const value = Number(e.target.value)
                      if (value >= 1 && value !== settings[key])
                        void change({ [key]: value })
                    }}
                  />
                </label>
              )
            )}
          </div>
        </section>
      )}
      <section className="border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-primary">
            Database backups
          </h3>
          <button
            className={historyButton}
            disabled={busy}
            onClick={() => act(() => libraryRequest('/backups', 'POST', {}))}
          >
            Back up now
          </button>
        </div>
        <p className="my-2 text-muted">
          Download a backup for safekeeping on another device. A database backup
          contains the catalog; download conversation archives separately from
          session details.
        </p>
        {notice && (
          <p role="status" className="my-2 text-accent">
            {notice}
          </p>
        )}
        {restore && (
          <div className="my-3 border border-approval p-3">
            <p>
              Restore this backup on the next Agentboard restart? Current
              sessions keep running until then. The current database will be
              backed up first.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className={historyButton}
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const r = await libraryRequest<{ message: string }>(
                      `/backups/${encodeURIComponent(restore)}/restore`,
                      'POST',
                      {}
                    )
                    setNotice(r.message)
                    setRestore(null)
                  })
                }
              >
                Schedule restore
              </button>
              <button
                className={historyButton}
                onClick={() => setRestore(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <ul className="divide-y divide-border">
          {backups.map((b) => (
            <li
              key={b.name}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span>
                {new Date(b.createdAt).toLocaleString()} · {sizeLabel(b.bytes)}
              </span>
              <div className="flex gap-2">
                <a
                  className={historyButton}
                  href={`/api/library/backups/${encodeURIComponent(b.name)}/download`}
                  download
                >
                  Download
                </a>
                <button
                  className={historyButton}
                  disabled={busy}
                  onClick={() => setRestore(b.name)}
                >
                  Restore…
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
