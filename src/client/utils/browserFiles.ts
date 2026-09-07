/** Browser-owned clipboard files and uploads; never reads the server's clipboard. */
import { MAX_PASTE_FILE_BYTES, PASTE_FILE_LIMIT_LABEL } from '@shared/pasteFiles'

export function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? []).filter((file) => file instanceof File)
  if (files.length) return files
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile?.())
    .filter((file): file is File => file instanceof File)
}

export function validateFiles(files: File[]): string | null {
  const emptyImage = files.find(file => file.type.startsWith('image/') && file.size === 0)
  if (emptyImage) return `${emptyImage.name} contains no image data. Choose the file to upload it.`
  const oversized = files.find((file) => file.size > MAX_PASTE_FILE_BYTES)
  return oversized ? `${oversized.name} exceeds the ${PASTE_FILE_LIMIT_LABEL} limit` : null
}

export async function uploadBrowserFile(file: File, signal?: AbortSignal): Promise<string> {
  const error = validateFiles([file])
  if (error) throw new Error(error)
  const form = new FormData()
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
  form.append(isImage ? 'image' : 'file', file, file.name)
  let response: Response
  try {
    response = await fetch(isImage ? '/api/paste-image' : '/api/paste-file', { method: 'POST', body: form, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`Could not upload ${file.name}. Check your connection and try again.`)
  }
  const body = await response.json().catch(() => null) as { path?: unknown; error?: unknown } | null
  if (!response.ok || typeof body?.path !== 'string' || !body.path.startsWith('/')) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Could not upload ${file.name}. Try again.`)
  }
  return body.path
}

/** Quote uploaded paths for both agent prompts and shell input. */
export function quotedFilePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return `'${path.replace(/[\x00-\x1f\x7f]/g, '').replace(/'/g, "'\\''")}'`
}

export async function readBrowserClipboard(): Promise<{ text: string; files: File[] }> {
  try {
    const items = await navigator.clipboard.read()
    const files: File[] = []
    let text = ''
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (imageType) {
        files.push(new File([await item.getType(imageType)], `clipboard.${imageType.split('/')[1] || 'png'}`, { type: imageType }))
      } else if (item.types.includes('text/plain')) {
        text += await (await item.getType('text/plain')).text()
      }
    }
    return { text, files }
  } catch {
    return { text: await navigator.clipboard.readText(), files: [] }
  }
}
