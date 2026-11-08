/** Optional image extraction and decoding are isolated from terminal and catalog workers. */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { readMediaLine } from './mediaLine'
import { extractMediaItems } from './mediaExtractor'
import { decodeThumbnail, THUMBNAIL_VERSION } from './mediaThumbnailDecoder'
import type { ThumbnailRef } from './mediaThumbnailTypes'

const CACHE_BYTES = 16 * 1024 * 1024
const CACHE_ENTRIES = 1024
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }

export class MediaThumbnails {
  constructor(private readonly decode = decodeThumbnail, private readonly maxCacheBytes = CACHE_BYTES) {}
  private cache = new Map<string, { body: Uint8Array; source: string }>()
  private cacheBytes = 0

  async get(ref: ThumbnailRef): Promise<Uint8Array> {
    const stat = await fs.stat(ref.path, { bigint: true })
    // Even an already-decoded digest must still belong to this version of the log.
    const key = JSON.stringify([THUMBNAIL_VERSION, ref.digest, ref.index, ref.expectedBytes])
    const source = JSON.stringify([ref.path, ref.offset,
      String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)])
    const cached = this.cache.get(key)
    if (cached?.source === source) { this.cache.delete(key); this.cache.set(key, cached); return cached.body }
    const line = await readMediaLine(ref.path, ref.offset)
    if (!line) fail('NOT_FOUND')
    if (createHash('sha256').update(line).digest('hex') !== ref.digest) fail('STALE')
    // Appending a transcript requires revalidation, but never redecoding an old image.
    if (cached) { cached.source = source; this.cache.delete(key); this.cache.set(key, cached); return cached.body }
    const item = extractMediaItems(line)[ref.index]
    if (!item) fail('NOT_FOUND')
    if (item.url || !item.data || !item.mediaType?.startsWith('image/')) fail('UNSUPPORTED')
    if (item.data.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) fail('UNSUPPORTED')
    const input = Buffer.from(item.data, 'base64')
    if (ref.expectedBytes !== undefined && ref.expectedBytes !== input.length) fail('STALE')
    let body: Uint8Array
    try { body = this.decode(input) } catch { fail('UNSUPPORTED') }
    if (body.byteLength > 128 * 1024) fail('UNSUPPORTED')
    if (body.byteLength > this.maxCacheBytes) return body
    while (this.cacheBytes + body.byteLength > this.maxCacheBytes || this.cache.size >= CACHE_ENTRIES) {
      const first = this.cache.keys().next().value!
      this.cacheBytes -= this.cache.get(first)!.body.byteLength
      this.cache.delete(first)
    }
    this.cache.set(key, { body, source }); this.cacheBytes += body.byteLength
    return body
  }

}
