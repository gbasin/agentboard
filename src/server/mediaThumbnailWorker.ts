/** Single-admission worker: source parsing and image codecs never run on the HTTP thread. */
import { MediaThumbnails } from './mediaThumbnails'
import type { ThumbnailRef, ThumbnailResponse } from './mediaThumbnailTypes'
const thumbnails = new MediaThumbnails()
self.onmessage = (event: MessageEvent<{ id: number; ref: ThumbnailRef; kind?: never } | { kind: 'shutdown' }>) => {
  if (event.data.kind === 'shutdown') { self.close(); return }
  void handle(event.data)
}

async function handle({ id, ref }: { id: number; ref: ThumbnailRef }) {
  try {
    const body = await thumbnails.get(ref)
    self.postMessage({ id, body } satisfies ThumbnailResponse)
  } catch (error) {
    const code = (error as { code?: string }).code
    self.postMessage({ id, code: code === 'ENOENT' ? 'NOT_FOUND' : code ?? 'UNSUPPORTED' } satisfies ThumbnailResponse)
  }
}
