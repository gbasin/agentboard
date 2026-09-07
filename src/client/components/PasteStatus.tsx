/** Progress/errors and a native-paste fallback; the TUI remains the composer. */
import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { clipboardFiles } from '../utils/browserFiles'
import type { BrowserPaste, PasteState } from '../hooks/useBrowserPaste'

export default function PasteStatus({ state, cancel, retry, paste, chooseFiles }: {
  state: PasteState
  cancel: () => void
  retry: () => void
  paste: (input: BrowserPaste) => void
  chooseFiles?: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => { if (state.status === 'clipboard-blocked') dialog.current?.showModal() }, [state.status])
  if (state.status === 'idle') return null
  if (state.status === 'clipboard-blocked') {
    const fallback = <dialog ref={dialog} aria-label="Paste from this device" onCancel={cancel}
      style={{ top: 'calc(var(--viewport-offset-top, 0px) + 1rem)', bottom: 'auto', maxHeight: 'calc(var(--visual-viewport-height, 100dvh) - 2rem)' }}
      className="mx-auto my-0 w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto rounded-lg border border-border bg-elevated p-4 text-primary backdrop:bg-black/50">
      <p className="mb-3 text-sm text-primary">Touch and hold in the field, then choose Paste. It goes straight to your terminal.</p>
      <textarea autoFocus aria-label="Paste here" placeholder="Touch and hold to paste" rows={2}
        className="w-full rounded border border-border bg-surface p-3 text-base text-primary"
        onPaste={(event) => {
          event.preventDefault()
          const files = clipboardFiles(event.clipboardData)
          const text = event.clipboardData.getData('text/plain')
          cancel()
          const names = files.map(file => file.name).join('\n')
          paste({ text: files.length && text.trim() === names ? '' : text, files })
        }} />
      <div className="mt-3 flex justify-end gap-2">
        {chooseFiles && <button type="button" className="min-h-[44px] px-3 text-primary" onClick={() => { cancel(); chooseFiles() }}>Choose files</button>}
        <button type="button" className="min-h-[44px] px-3 text-secondary" onClick={cancel}>Cancel</button>
      </div>
    </dialog>
    return typeof document === 'undefined' ? fallback : createPortal(fallback, document.body)
  }
  return <div className="flex items-center gap-3 border-t border-border bg-elevated px-3 py-2 text-sm text-primary">
    <span role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? state.message : state.status === 'reading' ? 'Reading clipboard…' : 'Uploading files…'}</span>
    {state.status === 'error' && <button type="button" className="min-h-[44px] px-2" onClick={retry}>Retry</button>}
    <button type="button" className="min-h-[44px] px-2 text-secondary" onClick={cancel}>{state.status === 'error' ? 'Dismiss' : 'Cancel'}</button>
  </div>
}
