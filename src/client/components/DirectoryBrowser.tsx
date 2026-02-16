import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectoryListing } from '@shared/types'
import { FolderIcon } from '@untitledui-icons/react/line'
import { useSettingsStore } from '../stores/settingsStore'

interface DirectoryBrowserProps {
  onSelect: (path: string) => void
  onCancel: () => void
  initialPath?: string
}

export function DirectoryBrowser({
  onSelect,
  onCancel,
  initialPath,
}: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '~')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const abortRef = useRef<AbortController | null>(null)
  const recentPaths = useSettingsStore((state) => state.recentPaths)

  const fetchListing = useCallback(async (path: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller

    setLoading(true)
    setError(null)
    setListing(null)
    setHighlightIndex(-1)
    setCurrentPath(path)

    try {
      const response = await fetch('/api/directories', {
        signal,
        headers: {
          'x-directory-path': path,
        },
      })
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        throw new Error(payload.message || 'Failed to load directory')
      }
      const data = (await response.json()) as DirectoryListing
      if (abortRef.current !== controller) {
        return
      }
      setListing(data)
      setCurrentPath(data.path)
    } catch (fetchError) {
      if (abortRef.current !== controller) {
        return
      }
      const errorObj = fetchError as { name?: string; message?: string }
      if (errorObj?.name !== 'AbortError') {
        setError(errorObj?.message || 'Failed to load directory')
      }
    } finally {
      if (abortRef.current === controller) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchListing(initialPath || '~')
    return () => {
      abortRef.current?.abort()
    }
  }, [fetchListing, initialPath])

  const directories = listing?.directories ?? []
  const displayPath = listing?.path || currentPath
  const parentPath = listing?.parent

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }

      if (loading) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightIndex((prev) => {
          if (directories.length === 0) return -1
          if (prev < 0) return 0
          return Math.min(prev + 1, directories.length - 1)
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightIndex((prev) => {
          if (directories.length === 0) return -1
          if (prev < 0) return directories.length - 1
          return Math.max(prev - 1, 0)
        })
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const entry = directories[highlightIndex]
        if (entry) {
          fetchListing(entry.path)
        } else if (displayPath) {
          onSelect(displayPath)
        }
        return
      }

      if (event.key === 'Backspace') {
        if (parentPath) {
          event.preventDefault()
          fetchListing(parentPath)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    directories,
    displayPath,
    fetchListing,
    highlightIndex,
    loading,
    onCancel,
    onSelect,
    parentPath,
  ])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Directory browser"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      data-testid="directory-browser"
    >
      <div className="w-full max-w-lg border border-border bg-elevated p-4">
        <div className="flex items-center gap-3 border-b border-border pb-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (parentPath) {
                fetchListing(parentPath)
              }
            }}
            disabled={!parentPath || loading}
          >
            Up
          </button>
          <div
            className="min-w-0 flex-1 truncate text-xs font-mono text-secondary"
            title={displayPath}
            data-testid="directory-current-path"
          >
            {displayPath}
          </div>
        </div>

        <div className="mt-3 max-h-60 overflow-y-auto border border-border bg-surface">
          {loading ? (
            <div
              className="px-3 py-4 text-xs text-muted"
              data-testid="directory-loading"
            >
              Loading directories...
            </div>
          ) : error ? (
            <div className="px-3 py-4 text-xs" data-testid="directory-error">
              <p className="text-danger">{error}</p>
              <button
                type="button"
                className="btn mt-3"
                onClick={() => fetchListing(currentPath)}
              >
                Retry
              </button>
            </div>
          ) : directories.length === 0 ? (
            <div
              className="px-3 py-4 text-xs text-muted"
              data-testid="directory-empty"
            >
              No subdirectories
            </div>
          ) : (
            <div className="py-1">
              {directories.map((entry, index) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => fetchListing(entry.path)}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
                    index === highlightIndex ? 'bg-hover text-primary' : 'text-secondary'
                  }`}
                  data-testid="directory-entry"
                  data-entry-name={entry.name}
                  data-entry-path={entry.path}
                >
                  <FolderIcon
                    width={14}
                    height={14}
                    className="shrink-0 text-muted"
                    aria-hidden="true"
                  />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {listing?.truncated ? (
          <p className="mt-2 text-[10px] text-muted">
            Showing first 200 directories.
          </p>
        ) : null}

        <div className="mt-4 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wider text-secondary">
            Recent
          </div>
          {recentPaths.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No recent paths yet.</p>
          ) : (
            <div className="mt-2 space-y-1">
              {recentPaths.map((pathEntry) => (
                <button
                  key={pathEntry}
                  type="button"
                  className="block w-full truncate text-left text-xs text-secondary hover:text-primary"
                  onClick={() => fetchListing(pathEntry)}
                  title={pathEntry}
                  data-testid="directory-recent"
                  data-recent-path={pathEntry}
                >
                  {pathEntry}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (displayPath) {
                onSelect(displayPath)
              }
            }}
            className="btn btn-primary"
            disabled={loading || !displayPath}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  )
}
