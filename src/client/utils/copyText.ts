/**
 * Copy text to clipboard using a textarea fallback for broad browser/mobile support.
 * Falls back to navigator.clipboard if execCommand is unavailable.
 */
export function copyText(text: string): void {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    navigator.clipboard?.writeText(text).catch(() => {})
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw 0
  } catch {
    navigator.clipboard?.writeText(text).catch(() => {})
  }
  document.body.removeChild(textarea)
}
