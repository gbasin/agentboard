/**
 * useCommitField - local editing state for a settings text/number input.
 *
 * The input shows the stored value until the user types; from then on it
 * shows a local draft that is committed on blur or Enter. A draft is never
 * overwritten by store updates (e.g. a synced-settings broadcast), and an
 * untouched input follows the store live. `commit` validates and writes; when
 * it returns an error string the draft stays local and nothing is written,
 * so an invalid value never reaches a synced key. Escape reverts a dirty
 * draft and calls preventDefault so the dialog does not also close.
 *
 * Unmounting with a dirty draft (the dialog closed by shortcut or backdrop
 * while the input still had focus) commits it too: React does not fire blur
 * for a removed node, and a close should not silently drop a valid edit.
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

/** Returns an error message to keep the draft local, or null on success. */
export type CommitFn = (draft: string) => string | null

export interface CommitField {
  value: string
  error: string | null
  dirty: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function useCommitField(stored: string, commit: CommitFn): CommitField {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ draft, stored, commit })
  latest.current = { draft, stored, commit }

  useEffect(() => {
    return () => {
      const { draft, stored, commit } = latest.current
      if (draft !== null && draft !== stored) commit(draft)
    }
  }, [])

  const tryCommit = () => {
    if (draft === null) return
    if (draft === stored) {
      setDraft(null)
      setError(null)
      return
    }
    const message = commit(draft)
    if (message) {
      setError(message)
      return
    }
    setDraft(null)
    setError(null)
  }

  return {
    value: draft ?? stored,
    error,
    dirty: draft !== null,
    onChange: (event) => {
      setDraft(event.target.value)
      setError(null)
    },
    onBlur: tryCommit,
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        tryCommit()
      } else if (event.key === 'Escape' && draft !== null) {
        event.preventDefault()
        setDraft(null)
        setError(null)
      }
    },
  }
}
