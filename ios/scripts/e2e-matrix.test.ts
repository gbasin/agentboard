import { expect, test } from 'bun:test'
import { e2eMatrix } from './e2e-matrix'
import { shards } from './e2e-selection'

test('pull requests include every shard and appearance exactly once, regardless of inputs', () => {
  const expected = shards.flatMap(shard => ['light', 'dark'].map(appearance => `${shard}/${appearance}`)).sort()
  for (const [shard, appearance] of [['all', 'all'], ['terminal', 'dark'], ['invalid', 'invalid']]) {
    const jobs = e2eMatrix('pull_request', shard, appearance).include
    expect(jobs.map(job => `${job.shard}/${job.appearance}`).sort()).toEqual(expected)
  }
})

test('dispatch filters preserve each requested pair and its scheduling order', () => {
  const all = e2eMatrix('workflow_dispatch').include
  expect(all).toEqual(e2eMatrix('pull_request').include)
  expect(all[0]).toEqual({ shard: 'terminal', appearance: 'light' })
  expect(all[all.length - 1]).toEqual({ shard: 'terminal', appearance: 'dark' })
  for (const shard of ['all', ...shards]) for (const appearance of ['all', 'light', 'dark']) {
    const jobs = e2eMatrix('workflow_dispatch', shard, appearance).include
    expect(jobs).toEqual(all.filter(job => (shard === 'all' || job.shard === shard) &&
      (appearance === 'all' || job.appearance === appearance)))
    expect(jobs.length).toBe((shard === 'all' ? shards.length : 1) * (appearance === 'all' ? 2 : 1))
  }
})

test('invalid dispatch filters fail instead of silently skipping coverage', () => {
  expect(() => e2eMatrix('workflow_dispatch', 'typo')).toThrow('Unknown shard')
  expect(() => e2eMatrix('workflow_dispatch', 'all', 'typo')).toThrow('Unknown appearance')
})
