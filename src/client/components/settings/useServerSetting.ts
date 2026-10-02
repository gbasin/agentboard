/**
 * useServerSetting - one server-wide setting behind /api/settings/<name>.
 *
 * Loads the value on mount (the control stays disabled until it arrives),
 * and `set` applies optimistically and PUTs. Writes are serialized so two
 * quick edits reach the server in order; a failed write reverts the control
 * to the last value the server confirmed (the loaded value or the newest
 * successful write), never to an intermediate optimistic one. The server
 * rolls its own state back on persistence failure, so the UI must follow.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type ServerSettingName =
  | 'tmux-mouse-mode'
  | 'terminal-colors'
  | 'prefer-window-name'
  | 'history-max-age-hours'

/** The JSON field each endpoint uses for its value. */
type ValueField = 'enabled' | 'hours'

export interface ServerSetting<T> {
  value: T
  /** True until the initial load settles and while a write is in flight. */
  loading: boolean
  /** True once the initial load has settled (even if it failed). */
  loaded: boolean
  set: (next: T) => void
}

export function useServerSetting<T extends boolean | number>(
  name: ServerSettingName,
  field: ValueField,
  fallback: T
): ServerSetting<T> {
  const url = `/api/settings/${name}`
  const [value, setValue] = useState<T>(fallback)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  // Last value the server is known to hold; failed writes revert to it.
  const confirmedRef = useRef<T>(fallback)
  // Writes chain on this so they are sent one at a time, in order.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const inFlightRef = useRef(0)
  const mountedRef = useRef(true)
  // A write supersedes a load still in flight.
  const writtenRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    let active = true
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Record<string, unknown>>
      })
      .then((data) => {
        if (!active) return
        const loadedValue = data[field] as T
        // The server holds this value even if a write already superseded
        // it on screen; a failed write must revert here, not to `fallback`.
        if (inFlightRef.current === 0 && !writtenRef.current) confirmedRef.current = loadedValue
        if (!writtenRef.current) setValue(loadedValue)
      })
      .catch(() => {})
      .finally(() => {
        if (!active) return
        setLoaded(true)
        if (inFlightRef.current === 0) setLoading(false)
      })
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [url, field])

  const set = useCallback(
    (next: T) => {
      writtenRef.current = true
      inFlightRef.current += 1
      setValue(next)
      setLoading(true)
      queueRef.current = queueRef.current.then(() =>
        fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: next }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            confirmedRef.current = next
          })
          .catch(() => {
            // Only the newest write may be showing; revert to what the
            // server actually holds.
            if (mountedRef.current && inFlightRef.current === 1) {
              setValue(confirmedRef.current)
            }
          })
          .finally(() => {
            inFlightRef.current -= 1
            if (mountedRef.current && inFlightRef.current === 0) setLoading(false)
          })
      )
    },
    [url, field]
  )

  return { value, loading, loaded, set }
}
