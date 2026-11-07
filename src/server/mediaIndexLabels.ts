/** Tool-caption context is bounded by bytes as well as entry count. */
import { createHash } from 'node:crypto'

export const MEDIA_LABEL_BUDGET = 1024 * 1024
const cost = (key: string, value: string) => Buffer.byteLength(JSON.stringify([key, value])) + 1
export function mediaLabelKey(id: string): string {
  return id.length <= 256 ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
}

export class MediaLabelMap extends Map<string, string> {
  private bytes = 2
  constructor(entries: [string, string][] = []) {
    super()
    for (const [id, label] of entries) this.set(id, label)
  }
  override set(id: string, value: string): this {
    const key = mediaLabelKey(id), label = value.slice(0, 512)
    this.delete(key)
    const added = cost(key, label)
    while (this.size >= 2000 || this.bytes + added > MEDIA_LABEL_BUDGET) {
      const oldest = this.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.bytes += added
    return super.set(key, label)
  }
  override delete(key: string): boolean {
    const previous = this.get(key)
    if (previous === undefined) return false
    this.bytes -= cost(key, previous)
    return super.delete(key)
  }
  override clear() { super.clear(); this.bytes = 2 }
}
