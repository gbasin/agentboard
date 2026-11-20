/** Whole appearance batches balanced by median XCTest seconds per batch; the pull
 * request that set this assignment records the measured runs. Keep each simulator
 * warm while ci-e2e.sh resets fixtures and app data per batch.
 */
import { shards } from './e2e-selection'
type Batch = readonly [typeof shards[number], 'light' | 'dark']
const workers: readonly (readonly Batch[])[] = [
  [['terminal', 'light'], ['catalog', 'dark']],
  [['live', 'light'], ['live', 'dark'], ['settings', 'dark']],
  [['media', 'light'], ['terminal', 'dark']],
  [['lifecycle', 'light'], ['media', 'dark']],
  [['catalog', 'light'], ['lifecycle', 'dark'], ['settings', 'light']],
]
export const batchSlots = ['first', 'second', 'third'] as const

export function ciWorkers(shard = 'all', appearance = 'all') {
  if (shard !== 'all' && !shards.includes(shard as typeof shards[number])) throw Error(`Unknown shard: ${shard}`)
  if (!['all', 'light', 'dark'].includes(appearance)) throw Error(`Unknown appearance: ${appearance}`)
  return { include: workers.flatMap((batches, index) => {
    const selected = batches.filter(([s, mode]) => (shard === 'all' || s === shard) && (appearance === 'all' || mode === appearance))
    if (!selected.length) return []
    const worker: Record<string, string | number> = {
      worker: index + 1, label: selected.map(([s, mode]) => `${mode} ${s}`).join(', '),
    }
    batchSlots.forEach((slot, i) => {
      worker[`${slot}Shard`] = selected[i]?.[0] ?? ''
      worker[`${slot}Mode`] = selected[i]?.[1] ?? ''
    })
    return [worker]
  }) }
}
if (import.meta.main) console.log(JSON.stringify(ciWorkers(process.argv[2], process.argv[3])))
