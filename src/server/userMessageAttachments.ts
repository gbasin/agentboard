import { asRecord } from '../shared/json'

// Attachment labels are transport metadata, not the user's prompt. Keep text
// around them; give image-only turns a readable preview instead of an old prompt.
const IMAGE_LABEL = /\[Image\s+#\d+\]/gi
const IMAGE_WRAPPER = /<image\s+name=\[Image\s+#\d+\]\s+path="[^"]*"\s*>[\s\S]*?<\/image>/gi
const IMAGE_OPEN = /<image\s+name=\[Image\s+#\d+\]\s+path="[^"]*"\s*\/?\s*>/gi

export function cleanUserImageAttachments(text: string): string {
  const cleaned = text.replace(IMAGE_WRAPPER, ' ').replace(IMAGE_OPEN, ' ').replace(IMAGE_LABEL, ' ')
  return cleaned === text ? text : cleaned.replace(/\s+/g, ' ').trim() || 'Image attached'
}

// Cached previews may stop in the middle of a long attachment path.
export function hasUserImageMarkup(text: string): boolean {
  return /<image\s+name=\[Image\s+#\d+\]|\[Image\s+#\d+\]/i.test(text)
}

export function isContinuationSummary(text: string): boolean {
  return /^This session is being continued from a previous conversation that ran out of context\./i.test(text.trim())
}

export function hasUserImageAttachment(entry: unknown): boolean {
  const record = asRecord(entry)
  if (!record || record.isMeta === true || record.isCompactSummary === true || record.synthetic_reason !== undefined) return false
  const payload = asRecord(record.payload)
  const message = record.type === 'response_item' ? payload : asRecord(record.message)
  if (record.type === 'event_msg' && payload?.type === 'user_message') {
    return [payload.images, payload.local_images].some(value => Array.isArray(value) && value.length > 0)
  }
  if (message?.role !== 'user') return false
  return Array.isArray(message.content) && message.content.some((block: unknown) => {
    const type = asRecord(block)?.type
    return type === 'image' || type === 'input_image'
  })
}
