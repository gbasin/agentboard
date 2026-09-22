/** Shared pending/error handling for user-triggered history operations. */
import { useRef, useState } from 'react'

export function useHistoryAction(onError: (message: string) => void) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    onError('')
    try {
      await fn()
    } catch (error) {
      onError(String(error))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return { busy, act }
}
