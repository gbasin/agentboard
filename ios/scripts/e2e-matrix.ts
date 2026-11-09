/** Independent simulator jobs, longest first using recent hosted cold-run timings. */
import { shards } from './e2e-selection'

type SimulatorJob = { shard: typeof shards[number]; appearance: 'light' | 'dark' }
const orderedJobs: SimulatorJob[] = [
  { shard: 'terminal', appearance: 'light' },
  { shard: 'media', appearance: 'light' },
  { shard: 'lifecycle', appearance: 'dark' },
  { shard: 'lifecycle', appearance: 'light' },
  { shard: 'catalog', appearance: 'light' },
  { shard: 'media', appearance: 'dark' },
  { shard: 'settings', appearance: 'dark' },
  { shard: 'settings', appearance: 'light' },
  { shard: 'catalog', appearance: 'dark' },
  { shard: 'terminal', appearance: 'dark' },
]

export function e2eMatrix(event: string, shard = 'all', appearance = 'all') {
  // Dispatch inputs must never narrow pull-request coverage.
  if (event !== 'workflow_dispatch') return { include: orderedJobs.map(job => ({ ...job })) }
  if (shard !== 'all' && !shards.includes(shard as typeof shards[number])) throw new Error(`Unknown shard: ${shard}`)
  if (!['all', 'light', 'dark'].includes(appearance)) throw new Error(`Unknown appearance: ${appearance}`)
  return { include: orderedJobs.filter(job => (shard === 'all' || job.shard === shard) &&
    (appearance === 'all' || job.appearance === appearance)).map(job => ({ ...job })) }
}

if (import.meta.main) console.log(JSON.stringify(e2eMatrix(
  process.env.IOS_EVENT_NAME ?? '',
  process.env.IOS_REQUESTED_SHARD || 'all',
  process.env.IOS_REQUESTED_APPEARANCE || 'all',
)))
