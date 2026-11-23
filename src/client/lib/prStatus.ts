import type { PrCheckInfo, PrInfo } from '../../shared/prStatus'
import { createInfoBatcher, schedulePrMetadata } from './prMetadataRequests'

const CHECKS_TTL_MS = 60_000
const infoCache = new Map<string, PrInfo>()
const checksCache = new Map<string, { at: number; checks: PrCheckInfo }>()
const checksInflight = new Map<string, Promise<void>>()
const activeUrls = new Map<string, number>()
const snapshotUrls = new Set<string>()
let snapshotEpoch = 0
const listeners = new Set<() => void>()
function keyFor(url: string): string {
  return url.toLowerCase().replace(/(\/pull\/)0+(?=\d+$)/, '$1')
}

export function subscribePrInfo(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getPrInfo(url: string): PrInfo | undefined {
  return infoCache.get(keyFor(url))
}

export function cachedChecks(url: string): PrCheckInfo | undefined {
  return checksCache.get(keyFor(url))?.checks
}

export function applyPrStatus(infos: PrInfo[], baseline?: ReadonlyMap<string, PrInfo | undefined>) {
  let changed = false
  for (const info of infos) {
    if (info.error) continue
    const key = keyFor(info.url)
    const previous = infoCache.get(key)
    const confirmedAt = info.lastConfirmedAt ?? 0
    const previousAt = previous?.lastConfirmedAt ?? 0
    if (confirmedAt < previousAt ||
        (confirmedAt === previousAt && baseline && baseline.get(key) !== previous)) continue
    if (previous && (previous.headSha !== info.headSha || previous.state !== info.state || previous.isDraft !== info.isDraft)) {
      checksCache.delete(key)
      checksInflight.delete(key)
    }
    infoCache.set(key, info)
    changed = true
  }
  if (changed) listeners.forEach(listener => listener())
}

const SNAPSHOT_RETRY_DELAYS = [500, 2_000]

async function loadSnapshot(urls: string[], epoch: number): Promise<PrInfo[]> {
  for (const delay of [0, ...SNAPSHOT_RETRY_DELAYS]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (epoch !== snapshotEpoch) break
    try {
      const result = await schedulePrMetadata('info', async signal => {
        if (epoch !== snapshotEpoch) return []
        const active = urls.filter(url => activeUrls.has(url))
        if (!active.length) return []
        const baseline = new Map(active.map(url => [url, getPrInfo(url)]))
        const response = await fetch('/api/pr-info', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: active }), signal,
        })
        if (response.status === 408 || response.status === 429 || response.status >= 500) return null
        if (!response.ok) return []
        const infos = await response.json() as PrInfo[]
        if (epoch !== snapshotEpoch) return []
        for (const url of active) snapshotUrls.add(url)
        applyPrStatus(infos, baseline)
        return infos
      })
      if (result) return result
    } catch {
      // Retry transient request/decoding failures without holding the network lane.
    }
  }
  return []
}

function batchSnapshots(epoch: number) {
  return createInfoBatcher<PrInfo>(urls => loadSnapshot(urls, epoch), info => keyFor(info.url))
}

let requestInfo = batchSnapshots(snapshotEpoch)

function requestSnapshot(urls: Iterable<string>) {
  for (const url of urls) void requestInfo(url).catch(() => {})
}

export function refreshPrStatus() {
  // Recovery needs a new request even if a pre-reconnect snapshot is still running.
  requestInfo = batchSnapshots(++snapshotEpoch)
  snapshotUrls.clear()
  requestSnapshot(activeUrls.keys())
}

function onVisible() {
  if (document.visibilityState === 'visible') refreshPrStatus()
}

export function watchPrInfo(urls: string[]): () => void {
  const keys = [...new Set(urls.map(keyFor))]
  if (!keys.length) return () => {}
  if (!activeUrls.size) document.addEventListener?.('visibilitychange', onVisible)
  for (const key of keys) activeUrls.set(key, (activeUrls.get(key) ?? 0) + 1)
  requestSnapshot(keys.filter(key => !infoCache.has(key) || !snapshotUrls.has(key)))
  return () => {
    for (const key of keys) {
      const count = activeUrls.get(key) ?? 0
      if (count <= 1) activeUrls.delete(key)
      else activeUrls.set(key, count - 1)
    }
    if (!activeUrls.size) document.removeEventListener?.('visibilitychange', onVisible)
  }
}

export function fetchChecks(url: string): Promise<void> {
  const key = keyFor(url)
  const cached = checksCache.get(key)
  if (cached && Date.now() - cached.at < CHECKS_TTL_MS) return Promise.resolve()
  const existing = checksInflight.get(key)
  if (existing) return existing
  const promise: Promise<void> = schedulePrMetadata('checks', async signal => {
    const response = await fetch(`/api/pr-checks?url=${encodeURIComponent(url)}`, { signal })
    if (!response.ok) return
    const checks = await response.json() as PrCheckInfo
    if (checksInflight.get(key) !== promise) return
    const currentHead = infoCache.get(key)?.headSha
    if (currentHead && checks.headSha && currentHead !== checks.headSha) return
    const previous = checksCache.get(key)?.checks
    // The server can confirm the PR via REST while the CI lookup is unavailable.
    const lastChecks = !checks.headSha || checks.headSha === previous?.headSha ? previous?.checks : undefined
    const detail = checks.error && previous
      ? { ...(checks.state ? checks : previous), checks: lastChecks, error: checks.error }
      : checks
    checksCache.set(key, { at: Date.now(), checks: detail })
    listeners.forEach(listener => listener())
  }).finally(() => {
    if (checksInflight.get(key) === promise) checksInflight.delete(key)
  })
  checksInflight.set(key, promise)
  return promise
}
