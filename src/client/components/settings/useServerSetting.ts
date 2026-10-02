/**
 * useServerSetting - one server-wide setting behind /api/settings/<name>.
 *
 * Loads the value on mount (the control stays disabled until it arrives),
 * and `set` applies optimistically, PUTs, and reverts to the previous value
 * when the server answers non-OK or the request fails. The server rolls its
 * own state back on persistence failure, so the UI must follow.
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
  // Guards against a slow response landing after unmount or a newer write.
  const generationRef = useRef(0)
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    const generation = ++generationRef.current
    let active = true
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Record<string, unknown>>
      })
      .then((data) => {
        if (active && generationRef.current === generation) {
          setValue(data[field] as T)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true)
        if (active && generationRef.current === generation) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [url, field])

  const set = useCallback(
    (next: T) => {
      const previous = valueRef.current
      const generation = ++generationRef.current
      setValue(next)
      setLoading(true)
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
        })
        .catch(() => {
          if (generationRef.current === generation) setValue(previous)
        })
        .finally(() => {
          if (generationRef.current === generation) setLoading(false)
        })
    },
    [url, field]
  )

  return { value, loading, loaded, set }
}
