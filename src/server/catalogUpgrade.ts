/** Old clients understand error notices and pongs, but cannot stop their own retries. */
import { CATALOG_RELOAD_MESSAGE } from '../shared/catalogProtocol'

type UpgradePeer = { send: (payload: string) => unknown; getBufferedAmount?: () => number }
export const CATALOG_NOTICE_INTERVAL_MS = 4000

export function startCatalogUpgradeNotice(peer: UpgradePeer): () => void {
  const payload = JSON.stringify({ type: 'error', message: CATALOG_RELOAD_MESSAGE })
  let stopped = false
  const notify = () => {
    if (stopped || (peer.getBufferedAmount?.() ?? 0) > 4096) return
    try { peer.send(payload) } catch { /* Socket close owns cleanup. */ }
  }
  notify()
  const timer = setInterval(notify, CATALOG_NOTICE_INTERVAL_MS)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
