/** Upload browser-owned files and insert directly into the current TUI prompt. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentType } from '@shared/types'
import { quotedFilePath, readBrowserClipboard, uploadBrowserFile, validateFiles } from '../utils/browserFiles'
import { imagePathInput } from '../utils/paste'

export interface BrowserPaste { text: string; files: File[] }
export type PasteState = { status: 'idle' | 'reading' | 'uploading' | 'awaiting-paste' } | { status: 'error'; message: string }
interface Options {
  sessionId: string | null
  disabled?: boolean
  fileUploadsAllowed?: boolean
  agentType?: AgentType
  onPasteText: (text: string) => void
  onPasteImage: (text: string) => void
  onRefocus?: () => void
}

export function useBrowserPaste(options: Options) {
  const [state, setState] = useState<PasteState>({ status: 'idle' })
  const latest = useRef(options)
  latest.current = options
  const generation = useRef(0)
  const queue = useRef(Promise.resolve())
  const request = useRef<AbortController | null>(null)
  const retryPayload = useRef<BrowserPaste | null>(null)
  const cancel = useCallback(() => {
    generation.current++
    request.current?.abort()
    request.current = null
    queue.current = Promise.resolve()
    retryPayload.current = null
    setState({ status: 'idle' })
  }, [])
  useLayoutEffect(() => {
    cancel()
    return () => { generation.current++; request.current?.abort() }
  }, [options.sessionId, options.disabled, cancel])

  const paste = useCallback((input: BrowserPaste | Promise<BrowserPaste>, fromClipboard = false) => {
    // Handle rejection immediately, even if an earlier upload is still queued.
    const read = Promise.resolve(input).then(value => ({ value }), error => ({ error }))
    const epoch = generation.current
    const current = () => epoch === generation.current && !latest.current.disabled
    if (!current()) return Promise.resolve()
    if (fromClipboard) setState({ status: 'reading' })
    queue.current = queue.current.then(async () => {
      if (!current()) return
      const result = await read
      if (!current()) return
      if ('error' in result) { setState({ status: 'awaiting-paste' }); return }
      const payload = result.value
      retryPayload.current = payload
      const controller = new AbortController()
      request.current = controller
      try {
        const error = validateFiles(payload.files)
        if (error) throw new Error(error)
        if (payload.files.length && latest.current.fileUploadsAllowed === false) throw new Error('File uploads are unavailable for SSH sessions.')
        if (payload.files.length) setState({ status: 'uploading' })
        const uploads: Array<{ file: File; path: string }> = []
        for (const file of payload.files) {
          if (!current()) return
          uploads.push({ file, path: await uploadBrowserFile(file, controller.signal) })
        }
        if (!current() || controller.signal.aborted) return
        const documents = uploads.filter(({ file }) => !/^image\/(png|jpeg|gif|webp)$/.test(file.type))
        const images = uploads.filter(({ file }) => /^image\/(png|jpeg|gif|webp)$/.test(file.type))
        const combined = [payload.text, ...documents.map(({ path }) => quotedFilePath(path))].filter(Boolean).join('\n')
        if (combined) latest.current.onPasteText(combined + (uploads.length ? ' ' : ''))
        for (const { path } of images) latest.current.onPasteImage(imagePathInput(path, latest.current.agentType) + ' ')
        retryPayload.current = null
        setState({ status: 'idle' })
        latest.current.onRefocus?.()
      } catch (error) {
        if (current() && !controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : 'Upload failed. Try again.' })
      } finally {
        if (request.current === controller) request.current = null
      }
    })
    return queue.current
  }, [])
  const openDialog = () => {
    if (latest.current.disabled) return
    cancel()
    setState({ status: 'awaiting-paste' })
  }
  const pasteClipboard = () => paste(readBrowserClipboard(), true)
  const retry = () => retryPayload.current ? paste(retryPayload.current) : Promise.resolve()
  const fail = (message: string) => { cancel(); setState({ status: 'error', message }) }
  return { state, paste, pasteClipboard, openDialog, retry, cancel, fail }
}
