/** Copy during the initiating user gesture, including HTTP Safari without Clipboard API. */
export async function copyTextWithResult(text: string): Promise<boolean> {
  // The synchronous fallback runs first: awaiting a rejected clipboard permission
  // request would lose Safari's user activation before execCommand can run.
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const previous = document.activeElement as HTMLElement | null
    const selection = document.getSelection?.()
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.readOnly = true // Avoid opening the software keyboard on iOS.
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    textarea.style.fontSize = '16px'
    document.body.appendChild(textarea)
    let copied = false
    try {
      textarea.focus({ preventScroll: true })
      textarea.select()
      textarea.setSelectionRange(0, text.length)
      copied = document.execCommand('copy')
    } catch { /* Try the modern API below, still within the initiating gesture. */ }
    finally {
      textarea.remove()
      previous?.focus?.({ preventScroll: true })
      if (selection) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    }
    if (copied) return true
  }
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch { return false }
}

