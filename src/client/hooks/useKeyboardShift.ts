/** Tracks software-keyboard Shift, which iOS omits from arrow-button touch events. */
import { useEffect, useRef } from 'react'

export function useKeyboardShift(sessionKey: string | null, disabled: boolean) {
  const shiftRef = useRef(false)

  useEffect(() => {
    shiftRef.current = false
    if (disabled || typeof document === 'undefined') return

    const doc = document
    const win = window

    // iOS reports an uppercase letter with shiftKey=false before releasing
    // Shift. Only explicit Shift events describe the software toggle reliably.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftRef.current = true
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftRef.current = false
    }
    const reset = () => { shiftRef.current = false }
    const onVisibilityChange = () => {
      if (doc.visibilityState === 'hidden') reset()
    }

    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('keyup', onKeyUp, true)
    doc.addEventListener('focusout', reset, true)
    doc.addEventListener('visibilitychange', onVisibilityChange)
    win.addEventListener('blur', reset)
    return () => {
      reset()
      doc.removeEventListener('keydown', onKeyDown, true)
      doc.removeEventListener('keyup', onKeyUp, true)
      doc.removeEventListener('focusout', reset, true)
      doc.removeEventListener('visibilitychange', onVisibilityChange)
      win.removeEventListener('blur', reset)
    }
  }, [sessionKey, disabled])

  return shiftRef
}
