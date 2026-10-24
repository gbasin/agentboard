import type { TerminalSession } from './protocol'
/** Keep existing tmux-copy clipboard offers scoped to the current attachment. */
import { buildTmuxFormat, splitTmuxFields, splitTmuxLines } from '../tmuxFormat'
import { runTerminalTmux } from './terminalRuntimeCommands'
import { matchesTerminalIdentity, sendTerminal, type TerminalPeer } from './terminalRuntimeTypes'

const MAX_BYTES = 512 * 1024
const MOUSE = new RegExp(`${String.fromCharCode(0x1b)}\\[<(\\d+);\\d+;\\d+[Mm]`, 'g')
interface BufferSummary { name: string; created: number; size: number; order: number; key: string }

export function parseRelayBuffers(output: string): BufferSummary[] {
  const buffers: BufferSummary[] = []
  for (const line of splitTmuxLines(output)) {
    const fields = splitTmuxFields(line, 3)
    if (!fields) continue
    const name = fields[0]?.trim()
    const created = Number.parseInt(fields[1] ?? '', 10)
    const size = Number.parseInt(fields[2] ?? '', 10)
    if (!name || !Number.isFinite(created) || !Number.isFinite(size)) continue
    const automatic = name.match(/^buffer(\d+)$/)
    buffers.push({ name, created, size, order: automatic ? Number.parseInt(automatic[1], 10) : -1, key: `${name}:${created}:${size}` })
  }
  return buffers.sort((a, b) => b.created - a.created || b.order - a.order || b.size - a.size)
}

async function latestBuffer(): Promise<BufferSummary | null> {
  try {
    const result = await runTerminalTmux(['list-buffers', '-F', buildTmuxFormat(['#{buffer_name}', '#{buffer_created}', '#{buffer_size}'])])
    return result.exitCode === 0 ? parseRelayBuffers(result.stdout)[0] ?? null : null
  } catch { return null }
}

export function stopRelayClipboard(peer: TerminalPeer): void {
  const data = peer.data
  if (data.clipboardPollTimer !== null) clearInterval(data.clipboardPollTimer)
  data.clipboardWatchGen++
  data.clipboardPollTimer = null
  data.clipboardPollInFlight = false
  data.lastClipboardBufferKey = null
  data.clipboardBufferArmedUntil = 0
  data.clipboardArmedAtSec = 0
}

export function armRelayClipboard(peer: TerminalPeer, input: string): void {
  MOUSE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MOUSE.exec(input)) !== null) {
    const button = Number(match[1])
    if ((button & 3) === 0 && (button & 0xc0) === 0) {
      const now = Date.now()
      peer.data.clipboardBufferArmedUntil = now + 5000
      peer.data.clipboardArmedAtSec = Math.floor(now / 1000)
      return
    }
  }
}

export function startRelayClipboard(peer: TerminalPeer, session: TerminalSession, getSession?: (id: string) => TerminalSession | undefined): void {
  stopRelayClipboard(peer)
  if (session.remote) return
  const data = peer.data
  const generation = data.clipboardWatchGen
  const current = () => {
    if (peer.readyState !== 1 || data.clipboardWatchGen !== generation || data.currentSessionId !== session.id) return false
    const latest = getSession?.(session.id)
    return !getSession || (matchesTerminalIdentity(data.attachedIdentity, latest) && !latest?.remote)
  }
  const poll = async () => {
    if (!current() || data.clipboardPollInFlight) return
    data.clipboardPollInFlight = true
    try {
      const latest = await latestBuffer()
      if (!current()) return
      if (!latest) { data.lastClipboardBufferKey = null; return }
      if (data.lastClipboardBufferKey === latest.key) return
      data.lastClipboardBufferKey = latest.key
      if (Date.now() > data.clipboardBufferArmedUntil || latest.created < data.clipboardArmedAtSec || latest.size <= 0 || latest.size > MAX_BYTES) return
      const result = await runTerminalTmux(['show-buffer', '-b', latest.name])
      if (!current() || result.exitCode !== 0 || !result.stdout.trim()) return
      sendTerminal(peer, { type: 'clipboard-offer', sessionId: session.id, text: result.stdout, source: 'tmux-buffer' })
      data.clipboardBufferArmedUntil = 0
      data.clipboardArmedAtSec = 0
    } finally {
      if (data.clipboardWatchGen === generation) data.clipboardPollInFlight = false
    }
  }
  data.clipboardPollTimer = setInterval(() => { void poll().catch(() => {}) }, 750)
  void latestBuffer().then(initial => {
    if (data.clipboardWatchGen === generation && data.lastClipboardBufferKey === null && data.clipboardBufferArmedUntil === 0) data.lastClipboardBufferKey = initial?.key ?? null
  })
}
