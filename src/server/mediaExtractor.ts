// Discovers media payloads in an agent JSONL log: images the agent pasted or
// read (Claude `image` blocks, Codex `input_image`/`image_generation_call`),
// pasted documents, and Claude `frame-link` artifact links. Emits descriptors
// (byte offset + block index + metadata), never the payload itself — the
// /api/session-media endpoint re-reads one line and serves the bytes on
// demand. Scans incrementally like prExtractor: cached per file offset so
// polling only reads appended bytes.

import fs from 'node:fs'
import { logger } from './logger'
import { asRecord, asString } from '../shared/json'

export type SessionMediaKind = 'image' | 'document' | 'link'

/** What the scan emits per payload — safe to broadcast. */
export interface ScannedMedia {
  /** Byte offset of the source line in its log file. */
  offset: number
  /** Position of this payload within the line, in document order. */
  index: number
  kind: SessionMediaKind
  mediaType?: string
  /** Decoded payload size in bytes (absent for external links). */
  bytes?: number
  /** Caption: "Read · hero.png", a frame title, a revised prompt. */
  label?: string
  /** External URL — frame-link hrefs and non-data: image sources. */
  url?: string
  width?: number
  height?: number
}

/** One payload pulled out of a line; `data` stays in-process only. */
export interface ExtractedMediaItem {
  kind: SessionMediaKind
  mediaType?: string
  /** Base64 payload (Claude source.data, codex data: URL body, gen result). */
  data?: string
  url?: string
  label?: string
  /** Result-id context (tool_use_id / call_id) seen while walking to it. */
  toolId?: string
  width?: number
  height?: number
}

const READ_CHUNK_BYTES = 128 * 1024
// See prExtractor: eviction above the number of scanned paths, else the
// dormant sweep re-scans every file each cycle.
const MAX_CACHE_ENTRIES = 5000
const MAX_PENDING_LABELS = 2000
const MAX_MEDIA_PER_FILE = 2000
// /api/session-media rejects index > 256; never emit descriptors that can't
// be addressed.
const MAX_MEDIA_INDEX = 256

// Byte-level candidates. `"image` (no closing quote) over-matches on purpose:
// it covers "type":"image", "input_image", "image_url", data:image URLs,
// "image_generation_call", and "media_type":"image/png". False positives only
// cost a decode + parse; a false negative loses a payload.
const MARKER_BYTES = [
  Buffer.from('"image'),
  Buffer.from('"document"'),
  Buffer.from('frame-link'),
  // Label carriers: tool calls with a path argument give tool_result images
  // their "Read · foo.png" captions.
  Buffer.from('"file_path"'),
]

interface ScanState {
  offset: number
  mtimeMs: number
  // Trailing partial line as copied raw byte pieces (see prExtractor — decoded
  // once whole so multi-byte chars never split and re-joins stay linear).
  partial: Buffer[]
  partialCandidate: boolean
  // tool_use / call ids -> display label, for tool_result payloads.
  pendingLabels: Map<string, string>
  seen: Set<string>
  media: ScannedMedia[]
}

// One read buffer shared by every scan; scans are synchronous.
let readBuffer: Buffer | null = null

const scanCache = new Map<string, ScanState>()

const EMPTY_RESULT: ScannedMedia[] = []

function newScanState(): ScanState {
  return {
    offset: 0,
    mtimeMs: 0,
    partial: [],
    partialCandidate: false,
    pendingLabels: new Map(),
    seen: new Set(),
    media: [],
  }
}

// True when `word` spans the seam between the carried partial line and
// `bytes`. word.length - 1 bytes per side cover every split.
function seamHasWord(partial: Buffer[], bytes: Buffer, word: Buffer): boolean {
  if (partial.length === 0) return false
  const tail = word.length - 1
  const sides: Buffer[] = [bytes.subarray(0, tail)]
  let need = tail
  for (let i = partial.length - 1; i >= 0 && need > 0; i--) {
    const piece = partial[i]
    const take = Math.min(need, piece.length)
    sides.unshift(piece.subarray(piece.length - take))
    need -= take
  }
  return Buffer.concat(sides).includes(word)
}

function hasCandidate(bytes: Buffer): boolean {
  for (const marker of MARKER_BYTES) {
    if (bytes.includes(marker)) return true
  }
  return false
}

function seamHasCandidate(partial: Buffer[], bytes: Buffer): boolean {
  for (const marker of MARKER_BYTES) {
    if (seamHasWord(partial, bytes, marker)) return true
  }
  return false
}

// --- label resolution -----------------------------------------------------

function pathLeaf(p: string): string {
  const clean = p.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const leaf = clean.slice(clean.lastIndexOf('/') + 1)
  return leaf || p
}

/** "Read · hero.png" when the args carry a path, else just the tool name. */
function toolLabel(name: string | null, args: unknown): string {
  let parsed: unknown = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  const record = asRecord(parsed)
  const pathValue =
    asString(record?.file_path) ??
    asString(record?.filePath) ??
    asString(record?.path) ??
    asString(record?.filename)
  if (pathValue) {
    return `${name ?? 'tool'} · ${pathLeaf(pathValue)}`
  }
  return name ?? 'tool'
}

// Registers tool-call ids -> labels for lines carrying a path argument, so
// tool_result payloads on later lines can be captioned. Covers Claude/Pi
// content blocks, Codex payload calls, devin toolCalls, grok tool_calls.
function collectToolLabels(
  record: Record<string, unknown>,
  pending: Map<string, string>
): void {
  const register = (id: unknown, label: string) => {
    if (typeof id !== 'string' || !id) return
    if (!pending.has(id) && pending.size >= MAX_PENDING_LABELS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    pending.set(id, label)
  }

  const content = asRecord(record.message)?.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item)
      if (!block) continue
      const type = asString(block.type)
      if (type !== 'tool_use' && type !== 'toolCall') continue
      register(
        block.id,
        toolLabel(
          asString(block.name),
          block.input ?? block.arguments ?? block.partialJson
        )
      )
    }
  }

  const payload = asRecord(record.payload)
  const payloadType = asString(payload?.type)
  if (
    payloadType === 'function_call' ||
    payloadType === 'custom_tool_call' ||
    payloadType === 'tool_call'
  ) {
    if (!payload) return
    register(
      asString(payload.call_id) ?? asString(payload.id),
      toolLabel(asString(payload.name), payload.arguments ?? payload.input)
    )
  }

  for (const calls of [asRecord(record.message)?.toolCalls, record.tool_calls]) {
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const c = asRecord(call)
      register(c?.id, toolLabel(asString(c?.name), c?.arguments))
    }
  }
}

// --- media walk -----------------------------------------------------------

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,(.*)$/s

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = DATA_URL_RE.exec(url)
  if (!m || !m[2]) return null
  return { mediaType: m[1] || 'application/octet-stream', data: m[3] }
}

// Block types that ARE payloads; everything else is recursed into.
function emitMedia(
  rec: Record<string, unknown>,
  type: string,
  toolId: string | undefined,
  out: ExtractedMediaItem[]
): boolean {
  if (type === 'frame-link') {
    const url = asString(rec.frameUrl)
    if (url) out.push({ kind: 'link', url, label: asString(rec.title) ?? undefined })
    return true
  }
  if (type === 'image' || type === 'document') {
    const source = asRecord(rec.source)
    const data = asString(source?.data)
    if (data) {
      out.push({
        kind: type,
        mediaType: asString(source?.media_type) ?? undefined,
        data,
        toolId,
      })
      return true
    }
    return false
  }
  if (type === 'input_image') {
    const url =
      asString(rec.image_url) ?? asString(asRecord(rec.image_url)?.url)
    if (!url) return false
    const parsed = parseDataUrl(url)
    out.push(
      parsed
        ? { kind: 'image', mediaType: parsed.mediaType, data: parsed.data, toolId }
        : { kind: 'image', url, toolId }
    )
    return true
  }
  if (type === 'image_generation_call') {
    const data = asString(rec.result)
    if (data) {
      out.push({
        kind: 'image',
        mediaType: 'image/png',
        data,
        label: asString(rec.revised_prompt) ?? undefined,
        toolId,
      })
      return true
    }
    return false
  }
  return false
}

function walkMedia(
  value: unknown,
  toolId: string | undefined,
  out: ExtractedMediaItem[]
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkMedia(item, toolId, out)
    return
  }
  const rec = value as Record<string, unknown>
  // Result containers carry the id of the call that produced them.
  const childToolId =
    asString(rec.tool_use_id) ??
    asString(rec.toolCallId) ??
    asString(rec.tool_call_id) ??
    asString(rec.call_id) ??
    toolId
  const type = asString(rec.type)
  if (type && emitMedia(rec, type, childToolId, out)) return
  for (const [key, child] of Object.entries(rec)) {
    // toolUseResult mirrors the message's tool_result payload — including it
    // would double-count every image; its dimensions enrich the item instead.
    if (key === 'toolUseResult') continue
    if (child && typeof child === 'object') {
      walkMedia(child, childToolId, out)
    }
  }
}

/**
 * All media payloads in one JSONL line, in document order. Shared by the
 * scanner and the /api/session-media endpoint so an item's `index` is stable
 * between the descriptor and the served bytes.
 */
export function extractMediaItems(line: string): ExtractedMediaItem[] {
  try {
    const record = JSON.parse(line) as Record<string, unknown>
    return extractMediaItemsFromRecord(record)
  } catch {
    return []
  }
}

function extractMediaItemsFromRecord(
  record: Record<string, unknown>
): ExtractedMediaItem[] {
  if (!record || typeof record !== 'object') return []
  const out: ExtractedMediaItem[] = []
  walkMedia(record, undefined, out)

  // Claude's toolUseResult twin carries pixel dimensions; apply when the line
  // produced exactly one image (the common 1:1 case). Note: its `originalSize`
  // is the *source file's* size, which differs from the embedded payload when
  // the agent resized before embedding — never use it as `bytes`, or the
  // endpoint's integrity check will reject every such descriptor.
  const resultFile = asRecord(asRecord(record.toolUseResult)?.file)
  const dims = asRecord(resultFile?.dimensions)
  const width = typeof dims?.originalWidth === 'number' ? dims.originalWidth : undefined
  const height = typeof dims?.originalHeight === 'number' ? dims.originalHeight : undefined
  const images = out.filter((item) => item.kind === 'image' && item.data)
  if (images.length === 1) {
    if (width) images[0].width = width
    if (height) images[0].height = height
  }
  return out
}

function decodedLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

// Dedupe: codex logs each turn twice (event_msg + response_item) with the
// same payload bytes; endpoints+span are a cheap stand-in for hashing MBs.
function dedupeKey(item: ExtractedMediaItem): string {
  if (item.url) return `u:${item.url}`
  const data = item.data ?? ''
  return `d:${item.kind}:${item.mediaType}:${data.length}:${data.slice(0, 48)}:${data.slice(-16)}`
}

function processLine(state: ScanState, line: string, lineOffset: number): void {
  const hasMedia =
    line.includes('"image') ||
    line.includes('"document"') ||
    line.includes('frame-link')
  const hasLabel =
    line.includes('"file_path"') &&
    (line.includes('"tool_use"') ||
      line.includes('"function_call"') ||
      line.includes('"toolCall"'))
  if (!hasMedia && !hasLabel) return

  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (!record || typeof record !== 'object') return

  if (hasLabel || hasMedia) {
    collectToolLabels(record, state.pendingLabels)
  }
  if (!hasMedia) return

  let index = 0
  for (const item of extractMediaItemsFromRecord(record)) {
    const current = index++
    if (current > MAX_MEDIA_INDEX) continue
    const key = dedupeKey(item)
    if (state.seen.has(key)) continue
    state.seen.add(key)

    const entry: ScannedMedia = {
      offset: lineOffset,
      index: current,
      kind: item.kind,
    }
    if (item.mediaType) entry.mediaType = item.mediaType
    if (item.url) entry.url = item.url
    const label = item.label ?? (item.toolId && state.pendingLabels.get(item.toolId))
    if (label) entry.label = label
    if (item.data) entry.bytes = decodedLength(item.data)
    if (item.width) entry.width = item.width
    if (item.height) entry.height = item.height

    if (state.media.length >= MAX_MEDIA_PER_FILE) {
      state.media.shift()
    }
    state.media.push(entry)
  }
}

// Feeds one read chunk. See prExtractor.consumeChunk: lines a chunk completes
// are decoded only when the chunk, the seam, or the carried partial line can
// hold a candidate — media lines run to MBs, so this skip is most of the win.
function consumeChunk(state: ScanState, bytes: Buffer): void {
  const lastNewline = bytes.lastIndexOf(0x0a)
  const seamCandidate = seamHasCandidate(state.partial, bytes)
  const chunkCandidate = hasCandidate(bytes)
  if (lastNewline === -1) {
    state.partialCandidate ||= seamCandidate || chunkCandidate
    // Copy: `bytes` views the shared read buffer.
    state.partial.push(Buffer.from(bytes))
    return
  }
  if (state.partialCandidate || seamCandidate || chunkCandidate) {
    const head = bytes.subarray(0, lastNewline)
    const partialBytes = state.partial.reduce((n, p) => n + p.length, 0)
    const lines =
      state.partial.length > 0 ? Buffer.concat([...state.partial, head]) : head
    const regionStart = state.offset - partialBytes
    let pos = 0
    while (pos < lines.length) {
      let end = lines.indexOf(0x0a, pos)
      if (end === -1) end = lines.length
      if (end > pos) {
        processLine(state, lines.subarray(pos, end).toString('utf8'), regionStart + pos)
      }
      pos = end + 1
    }
  }
  const tail = bytes.subarray(lastNewline + 1)
  state.partial = tail.length > 0 ? [Buffer.from(tail)] : []
  state.partialCandidate = tail.length > 0 && hasCandidate(tail)
}

/** Parse a complete log (tests and full rescans). */
export function extractSessionMedia(content: string): ScannedMedia[] {
  const state = newScanState()
  let offset = 0
  for (const line of content.split('\n')) {
    processLine(state, line, offset)
    offset += Buffer.byteLength(line) + 1
  }
  return state.media
}

/**
 * Media descriptors for one agent log file. Incremental: re-reads only bytes
 * appended since the last call. A single statSync per call keeps the mtime
 * check authoritative — a same-size rewrite must rescan, so callers cannot
 * skip it by asserting a size.
 */
export function getSessionMedia(logPath: string): ScannedMedia[] {
  let state = scanCache.get(logPath)

  let stat: fs.Stats
  try {
    stat = fs.statSync(logPath)
  } catch {
    return EMPTY_RESULT
  }

  if (state && stat.size <= state.offset && stat.mtimeMs !== state.mtimeMs) {
    // Shrinkage is a rewrite; same size with a new mtime likely is too.
    state = undefined
  }
  if (!state) {
    if (scanCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = scanCache.keys().next().value
      if (oldest) scanCache.delete(oldest)
    }
    state = newScanState()
    scanCache.set(logPath, state)
  }
  if (stat.size === state.offset && stat.mtimeMs === state.mtimeMs) {
    return state.media.length ? state.media.slice() : EMPTY_RESULT
  }
  if (stat.size === state.offset) {
    // Same-size rewrite — rescan from scratch.
    scanCache.set(logPath, (state = newScanState()))
  }

  let fd: number | null = null
  try {
    fd = fs.openSync(logPath, 'r')
    while (state.offset < stat.size) {
      const length = Math.min(READ_CHUNK_BYTES, stat.size - state.offset)
      readBuffer ??= Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const read = fs.readSync(fd, readBuffer, 0, length, state.offset)
      if (read <= 0) break
      consumeChunk(state, readBuffer.subarray(0, read))
      state.offset += read
    }
    state.mtimeMs = stat.mtimeMs
  } catch (error) {
    logger.warn('media_extract_error', {
      logPath,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close errors
      }
    }
  }

  return state.media.length ? state.media.slice() : EMPTY_RESULT
}

/** Test helper: drop cached scan state. */
export function clearMediaScanCache(): void {
  scanCache.clear()
}
