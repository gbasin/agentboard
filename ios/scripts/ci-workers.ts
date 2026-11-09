/** Whole appearance batches balanced using test-phase seconds from failed runs
 * 42543628215 and 42552097847. Comments show the former, not elapsed forecasts.
 * Keep each simulator warm while ci-e2e.sh resets fixtures and app data per batch.
 */
import { shards } from './e2e-selection'
const workers = [
  [['terminal', 'light'], ['terminal', 'dark']], // 1089s
  [['media', 'light'], ['catalog', 'dark']], // 1135s
  [['catalog', 'light'], ['lifecycle', 'dark']], // 1122s
  [['lifecycle', 'light'], ['media', 'dark']], // 1018s
  [['settings', 'light'], ['settings', 'dark']], // 1085s
] as const

export function ciWorkers(shard = 'all', appearance = 'all') {
  if (shard !== 'all' && !shards.includes(shard as typeof shards[number])) throw Error(`Unknown shard: ${shard}`)
  if (!['all', 'light', 'dark'].includes(appearance)) throw Error(`Unknown appearance: ${appearance}`)
  return { include: workers.flatMap((batches, index) => {
    const selected = batches.filter(([s, mode]) => (shard === 'all' || s === shard) && (appearance === 'all' || mode === appearance))
    if (!selected.length) return []
    return [{ worker: index + 1, firstShard: selected[0]![0], firstMode: selected[0]![1], secondShard: selected[1]?.[0] ?? '', secondMode: selected[1]?.[1] ?? '' }]
  }) }
}
if (import.meta.main) console.log(JSON.stringify(ciWorkers(process.argv[2], process.argv[3])))
