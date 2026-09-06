/** Draft text and device files together before inserting them into a terminal. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentType } from '@shared/types'
import { PASTE_FILE_LIMIT_LABEL } from '@shared/pasteFiles'
import { clipboardFiles, quotedFilePath, uploadBrowserFile, validateFiles } from '../utils/browserFiles'
import { imagePathInput } from '../utils/paste'

export interface PasteDraft {
  text: string
  files: File[]
}

interface PasteDialogProps {
  initial?: PasteDraft
  clipboard?: Promise<PasteDraft>
  fileUploadsAllowed?: boolean
  agentType?: AgentType
  disabled?: boolean
  onPasteText: (text: string) => void
  onSendKey: (text: string) => void
  onClose: () => void
}

type UploadState = { status: 'idle' } | { status: 'uploading' } | { status: 'error'; message: string }
const isAttachableImage = (file: File) => /^image\/(png|jpeg|gif|webp)$/.test(file.type)

export default function PasteDialog({ initial, clipboard, agentType, fileUploadsAllowed = true, disabled, onPasteText, onSendKey, onClose }: PasteDialogProps) {
  const [text, setText] = useState(initial?.text ?? '')
  const [files, setFiles] = useState<File[]>(initial?.files ?? [])
  const [upload, setUpload] = useState<UploadState>({ status: 'idle' })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const activeRef = useRef(true)
  const editedRef = useRef(false)
  const uploading = upload.status === 'uploading'

  useLayoutEffect(() => {
    activeRef.current = true
    if (!clipboard) dialogRef.current?.showModal()
    return () => { activeRef.current = false; requestRef.current?.abort() }
  }, [])

  useEffect(() => {
    void clipboard?.then((draft) => {
      if (!activeRef.current || editedRef.current) return
      const error = validateFiles(draft.files)
      if (error) { setUpload({ status: 'error', message: error }); return }
      setText(draft.text)
      setFiles(draft.files)
    }).catch(() => { /* Native paste and file selection remain available. */ }).finally(() => {
      // Let Safari finish its native Paste confirmation before opening a modal
      // or focusing the textarea (which can open the software keyboard).
      if (activeRef.current) dialogRef.current?.showModal()
    })
  }, [clipboard])

  // Revoking input while an upload is pending must not send into a new attachment.
  useLayoutEffect(() => {
    if (disabled) { requestRef.current?.abort(); onClose() }
  }, [disabled, onClose])

  const close = () => {
    activeRef.current = false
    requestRef.current?.abort()
    onClose()
  }

  const addFiles = (incoming: File[]) => {
    editedRef.current = true
    const error = validateFiles(incoming)
    if (error) { setUpload({ status: 'error', message: error }); return }
    setUpload({ status: 'idle' })
    setFiles((current) => [...current, ...incoming])
  }

  const send = async () => {
    if (disabled || requestRef.current || (!fileUploadsAllowed && files.length > 0) || (!text && !files.length)) return
    editedRef.current = true
    const controller = new AbortController()
    requestRef.current = controller
    setUpload({ status: 'uploading' })
    try {
      const uploaded: Array<{ file: File; path: string }> = []
      for (const file of files) uploaded.push({ file, path: await uploadBrowserFile(file, controller.signal) })
      if (!activeRef.current || controller.signal.aborted) return
      const documents = uploaded.filter(({ file }) => !isAttachableImage(file))
      const images = uploaded.filter(({ file }) => isAttachableImage(file))
      const combined = [text, ...documents.map(({ path }) => quotedFilePath(path))].filter(Boolean).join('\n')
      if (combined) onPasteText(combined + (images.length ? '\n' : ''))
      for (const { path } of images) onSendKey(imagePathInput(path, agentType) + ' ')
      close()
    } catch (error) {
      if (activeRef.current && !controller.signal.aborted) {
        setUpload({ status: 'error', message: error instanceof Error ? error.message : 'Upload failed. Try again.' })
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }

  const content = (
    <dialog
      ref={dialogRef}
      aria-labelledby="paste-dialog-title"
      onCancel={(event) => { event.preventDefault(); close() }}
      onPaste={(event) => {
        if (uploading) { event.preventDefault(); return }
        const incoming = clipboardFiles(event.clipboardData)
        if (incoming.length) { event.preventDefault(); addFiles(incoming) }
      }}
      style={{ top: 'calc(var(--viewport-offset-top, 0px) + 1rem)', bottom: 'auto', maxHeight: 'calc(var(--visual-viewport-height, 100dvh) - 2rem)' }}
      className="mx-auto my-0 w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto rounded-lg border border-border bg-elevated p-4 text-primary backdrop:bg-black/50"
    >
      <h3 id="paste-dialog-title" className="mb-1 text-base font-medium text-primary">Paste</h3>
      <p className="mb-3 text-sm text-secondary">Paste text or add files from this device.</p>
      <textarea
        autoFocus
        aria-label="Paste text"
        placeholder="Paste or type a message…"
        rows={4}
        value={text}
        disabled={uploading}
        onChange={(event) => { editedRef.current = true; setText(event.target.value) }}
        className="block w-full min-h-24 resize-y rounded-md border border-border bg-surface px-3 py-2 text-base text-primary placeholder:text-secondary focus:outline-none focus:border-accent"
      />
      {files.length > 0 && (
        <ul aria-label="Files to send" className="mt-3 space-y-1 text-primary">
          {files.map((file, index) => (
            <li key={index} className="flex min-h-11 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 break-all">{file.name}</span>
              <button type="button" aria-label={`Remove ${file.name}`} disabled={uploading} className="min-h-11 shrink-0 px-2 text-secondary hover:text-primary focus-visible:outline focus-visible:outline-accent disabled:opacity-50" onClick={() => { editedRef.current = true; setFiles((current) => current.filter((_, i) => i !== index)) }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <input ref={pickerRef} type="file" multiple aria-label="Choose files" className="hidden" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={uploading || !fileUploadsAllowed} onClick={() => pickerRef.current?.click()} className="min-h-11 rounded-md border border-border bg-surface px-3 text-sm text-primary hover:bg-hover focus-visible:outline focus-visible:outline-accent disabled:opacity-50">Choose files</button>
        <span className="text-xs text-secondary">Up to {PASTE_FILE_LIMIT_LABEL} per file</span>
      </div>
      {!fileUploadsAllowed && <p className="mt-3 text-sm text-secondary">File uploads are available for sessions on this Agentboard host.</p>}
      {upload.status === 'error' && <p role="alert" className="mt-3 text-sm text-danger">{upload.message}</p>}
      {uploading && <p role="status" className="mt-3 text-sm text-secondary">Uploading files…</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={close} className="min-h-11 rounded-md border border-border bg-surface px-4 text-sm font-medium text-secondary hover:bg-hover focus-visible:outline focus-visible:outline-accent">Cancel</button>
        <button type="button" disabled={disabled || uploading || (!fileUploadsAllowed && files.length > 0) || (!text && !files.length)} onClick={send} className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-white focus-visible:outline focus-visible:outline-accent disabled:opacity-50">Send</button>
      </div>
    </dialog>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
