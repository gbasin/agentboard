/** Progress/errors and a device paste/file dialog; freeform text and attachments wait for Submit. */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clipboardFiles } from '../utils/browserFiles'
import type { BrowserPaste, PasteState } from '../hooks/useBrowserPaste'

export default function PasteStatus({ state, cancel, retry, paste, allowFiles }: {
  state: PasteState
  cancel: () => void
  retry: () => void
  paste: (input: BrowserPaste) => void
  allowFiles?: boolean
}) {
  if (state.status === 'idle') return null
  if (state.status === 'awaiting-paste') return <PasteComposer cancel={cancel} paste={paste} allowFiles={allowFiles} />
  return <div className="flex items-center gap-3 border-t border-border bg-elevated px-3 py-2 text-sm text-primary">
    <span role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? state.message : state.status === 'reading' ? 'Reading clipboard…' : 'Uploading files…'}</span>
    {state.status === 'error' && <button type="button" className="min-h-[44px] px-2" onClick={retry}>Retry</button>}
    <button type="button" className="min-h-[44px] px-2 text-secondary" onClick={cancel}>{state.status === 'error' ? 'Dismiss' : 'Cancel'}</button>
  </div>
}

function PasteComposer({ cancel, paste, allowFiles }: {
  cancel: () => void
  paste: (input: BrowserPaste) => void
  allowFiles?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const fallback = <dialog ref={dialog} aria-label="Paste from this device" onCancel={cancel}
    style={{ top: 'calc(var(--viewport-offset-top, 0px) + 1rem)', bottom: 'auto', maxHeight: 'calc(var(--visual-viewport-height, 100dvh) - 2rem)' }}
    className="mx-auto my-0 w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto rounded-lg border border-border bg-elevated p-4 text-primary backdrop:bg-black/50">
    <form onSubmit={(event) => { event.preventDefault(); if (text || files.length) { cancel(); paste({ text, files }) } }}>
      <p className="mb-3 text-sm text-primary">Type or paste text, then submit it to your terminal.</p>
      <textarea autoFocus aria-label="Paste here" placeholder="Type or paste here" rows={4}
        value={text} onChange={(event) => setText(event.target.value)}
        className="w-full rounded border border-border bg-surface p-3 text-base text-primary"
        onPaste={(event) => {
          const attached = clipboardFiles(event.clipboardData)
          if (!attached.length) return
          event.preventDefault()
          setFiles(pending => [...pending, ...attached])
          const pastedText = event.clipboardData.getData('text/plain')
          if (pastedText && pastedText.trim() !== attached.map(file => file.name).join('\n')) setText(value => value + pastedText)
        }} />
      {allowFiles && <label className="mt-3 block text-sm">Attach files
        <input type="file" multiple aria-label="Choose files" className="mt-2 block w-full text-sm"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? [])
            setFiles(pending => [...pending, ...selected])
            event.target.value = ''
          }} />
      </label>}
      {files.length > 0 && <ul className="mt-2 text-sm">{files.map((file, index) => <li key={index} className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <button type="button" className="min-h-[44px] px-2" aria-label={`Remove ${file.name}`}
          onClick={() => setFiles(pending => pending.filter((_, i) => i !== index))}>Remove</button>
      </li>)}</ul>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="min-h-[44px] px-3 text-secondary" onClick={cancel}>Cancel</button>
        <button type="submit" disabled={!text && files.length === 0}
          className="min-h-[44px] rounded bg-accent px-3 text-white disabled:opacity-50">Submit</button>
      </div>
    </form>
  </dialog>
  return typeof document === 'undefined' ? fallback : createPortal(fallback, document.body)
}
