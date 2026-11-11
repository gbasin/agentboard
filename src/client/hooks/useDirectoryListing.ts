/** Cancel stale directory requests; only expose results for the current query. */
import { useEffect, useState } from 'react'
import type { DirectoryListing } from '@shared/types'

export async function readDirectory(path: string, signal: AbortSignal, query = '', showHidden = false): Promise<DirectoryListing> {
  const params = new URLSearchParams({ path, query, hidden: String(showHidden) })
  const response = await fetch(`/api/directories?${params}`, { signal })
  if (!response.ok) {
    const payload = await response.json() as { message?: string }
    throw new Error(payload.message || 'Unable to read folder')
  }
  return response.json()
}

type Result = { key: string; listing: DirectoryListing; error?: never } | { key: string; error: string; listing?: never }

export function useDirectoryListing(path: string | null, query = '', showHidden = false, retry = 0) {
  const key = JSON.stringify([path, query, showHidden, retry])
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    if (path === null) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      readDirectory(path, controller.signal, query, showHidden).then(
        listing => { if (!controller.signal.aborted) setResult({ key, listing }) },
        error => { if (!controller.signal.aborted) setResult({ key, error: error.message || 'Unable to read folder' }) },
      )
    }, query ? 120 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [key, path, query, showHidden])
  const current = result?.key === key ? result : null
  return { listing: current?.listing, error: current?.error, loading: path !== null && !current }
}
