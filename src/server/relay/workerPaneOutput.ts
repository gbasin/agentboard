import type { PaneOutputLease, subscribePaneOutput } from '../terminal/PaneOutputFeed'
import type { PaneOutputRequest, PaneOutputResponse } from './paneOutputProtocol'

/** Lease workers own callbacks; the shared broker owns all pipe/tail resources. */
export function createWorkerPaneOutput(post: (message: PaneOutputRequest) => void, overflow: () => void) {
  const subscriptions = new Map<string, {
    subscriber: Parameters<typeof subscribePaneOutput>[3]
    resolve: () => void; reject: (error: Error) => void
    release: (() => void) | null; closed: boolean
  }>()
  const subscribe: typeof subscribePaneOutput = (key, target, _transport, subscriber) => {
    const id = crypto.randomUUID()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const entry = { subscriber, resolve, reject, release: null as (() => void) | null, closed: false }
    subscriptions.set(id, entry)
    post({ type: 'pane-subscribe', id, key, target })
    let releasing: Promise<void> | null = null
    const lease: PaneOutputLease = { ready, release: () => {
      if (releasing) return releasing
      if (!subscriptions.has(id)) return Promise.resolve()
      entry.closed = true
      releasing = new Promise<void>((done) => { entry.release = done })
      post({ type: 'pane-release', id })
      return releasing
    } }
    return lease
  }
  const handle = (message: PaneOutputResponse): boolean => {
    if (!message.type.startsWith('pane-')) return false
    const entry = subscriptions.get(message.id)
    if (!entry) return true
    if (message.type === 'pane-ready') entry.resolve()
    else if (message.type === 'pane-data') {
      try { if (!entry.closed) entry.subscriber.onData(message.data) }
      catch { /* Match the direct feed callback isolation. */ }
      finally { post({ type: 'pane-credit', id: message.id, bytes: Buffer.byteLength(message.data) }) }
    }
    else if (message.type === 'pane-exit') {
      try { if (!entry.closed) entry.subscriber.onExit() } catch { /* Viewer callback. */ }
    }
    else if (message.type === 'pane-overflow') {
      const active = !entry.closed
      entry.closed = true
      entry.reject(new Error('Pane output needs resynchronization'))
      entry.release?.()
      subscriptions.delete(message.id)
      if (active) overflow()
    }
    else if (message.type === 'pane-error') {
      entry.reject(new Error(message.error))
      try { if (!entry.closed) entry.subscriber.onExit() } catch { /* Viewer callback. */ }
      entry.closed = true
      entry.release?.()
      subscriptions.delete(message.id)
    } else if (message.type === 'pane-released') {
      entry.resolve()
      entry.release?.()
      subscriptions.delete(message.id)
    }
    return true
  }
  return { subscribe, handle }
}
