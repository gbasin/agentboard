/// <reference lib="webworker" />
/** One terminal per realm: slow tmux setup/paste/disposal cannot stop sibling clients. */
import { config } from './config'
import { TerminalRuntime, createTerminalPeerData, type TerminalPeer } from './relay/terminalRuntime'
import type { TerminalSession } from './relay/protocol'
import type { RelayToTerminal, TerminalToRelay } from './relay/protocol'

const ctx = self as DedicatedWorkerGlobalScope
const sessions = new Map<string, TerminalSession>()
let epoch = 0
let serial = 0
let pendingBytes = 0
const pending = new Map<number, number>()
let peer: TerminalPeer | null = null
let readyState = 1
const post = (message: TerminalToRelay) => ctx.postMessage(message)
const runtime = new TerminalRuntime({
  getSession: id => sessions.get(id),
  onGroupedSessionCreated: () => post({ type: 'group-created' }),
  onSubmit: sessionId => post({ type: 'submit', sessionId }),
})

ctx.onmessage = async (event: MessageEvent<RelayToTerminal>) => {
  const message = event.data
  if (message.type === 'sessions' || message.type === 'init') {
    sessions.clear()
    for (const session of message.sessions) sessions.set(session.id, session)
    config.terminalColorsEnabled = message.terminalColorsEnabled
    if (message.type === 'init') {
      const nextPeer: TerminalPeer = {
        data: createTerminalPeerData(message.id), get readyState() { return peer === nextPeer ? readyState : 3 },
        send(payload) {
          if (peer !== nextPeer || readyState !== 1) return
          const bytes = Buffer.byteLength(payload)
          if (pendingBytes + bytes > 2 * 1024 * 1024) {
            runtime.suspend(peer)
            readyState = 3
            post({ type: 'overflow' })
            return
          }
          const sequence = ++serial
          pending.set(sequence, bytes)
          pendingBytes += bytes
          post({ type: 'send', epoch, sequence, payload })
        },
      }
      peer = nextPeer
      runtime.open(peer)
    }
    return
  }
  if (message.type === 'credit') {
    pendingBytes -= pending.get(message.sequence) ?? 0
    pending.delete(message.sequence)
    return
  }
  if (message.type === 'shutdown') {
    if (peer) await runtime.dispose(peer)
    post({ type: 'stopped' })
    peer = null
    readyState = 3
    return
  }
  if (!peer) return
  if (message.type === 'suspend') {
    runtime.suspend(peer)
    readyState = 3
  } else if (message.type === 'resume') {
    runtime.suspend(peer)
    epoch = message.epoch
    readyState = 1
  } else if (message.type === 'message' && message.epoch === epoch && peer.readyState === 1) {
    runtime.handle(peer, message.message)
  }
}
