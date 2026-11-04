// Clipboard writes from the browser.
//
// `copyText` is the fire-and-forget copy used by the session rows, the debug
// panel, the mailbox, and the terminal clipboard offer: a textarea
// select-and-copy, falling back to the async Clipboard API, result discarded.
//
// `copyTextExact` (copy-chat-message-markdown D3) reports its outcome and keeps
// the string byte for byte: the async Clipboard API in a secure context, else
// (or after a rejection) a one-shot `copy` listener that sets `text/plain`
// directly. A textarea would normalize CR/CRLF line endings. Plain-HTTP LAN
// and Tailscale addresses are not secure contexts, so the fallback matters.

/**
 * Copy text to clipboard using a textarea fallback for broad browser/mobile support.
 * Falls back to navigator.clipboard if execCommand is unavailable.
 */
export function copyText(text: string): void {
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

/** Copy `text` unchanged; resolves true only when the clipboard took it. */
export async function copyTextExact(text: string): Promise<boolean> {
  const clipboard = globalThis.window?.isSecureContext === true ? globalThis.navigator?.clipboard : undefined
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Refused (permission, focus): try the copy-event route below.
    }
  }
  return copyViaEvent(text)
}

/** The legacy copy command with the payload set on its `copy` event. */
function copyViaEvent(text: string): boolean {
  let wrote = false
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    wrote = true
  }
  try {
    document.addEventListener('copy', onCopy, true)
    return document.execCommand('copy') && wrote
  } catch {
    return false
  } finally {
    try { document.removeEventListener('copy', onCopy, true) } catch { /* no document */ }
  }
}
