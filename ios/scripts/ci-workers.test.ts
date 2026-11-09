import { expect, test } from 'bun:test'
import { ciWorkers } from './ci-workers'
import { shards } from './e2e-selection'

for (const shard of ['all', ...shards]) {
  for (const appearance of ['all', 'light', 'dark']) {
    test(`balanced workers preserve ${shard}/${appearance} batches exactly once`, () => {
      const { include } = ciWorkers(shard, appearance)
      const actual = include.flatMap(w => [
        `${w.firstShard}/${w.firstMode}`,
        ...(w.secondShard ? [`${w.secondShard}/${w.secondMode}`] : []),
      ])
      const expected = shards.filter(s => shard === 'all' || s === shard)
        .flatMap(s => ['light', 'dark'].filter(mode => appearance === 'all' || mode === appearance).map(mode => `${s}/${mode}`))
      expect(actual.sort()).toEqual(expected.sort())
      expect(include.length).toBeLessThanOrEqual(5)
      expect(new Set(include.map(w => w.worker)).size).toBe(include.length)
    })
  }
}
test('reject invalid workflow filters', () => {
  expect(() => ciWorkers('unknown')).toThrow('Unknown shard')
  expect(() => ciWorkers('all', 'unknown')).toThrow('Unknown appearance')
})

test('build and simulator workers share the pinned Xcode 27 toolchain', async () => {
  const source = await Bun.file(new URL('../../.github/workflows/ios.yml', import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as { env: { DEVELOPER_DIR: string }, jobs: Record<string, { 'runs-on': string }> }
  expect(workflow.env.DEVELOPER_DIR).toBe('/Applications/Xcode_27.2.app/Contents/Developer')
  expect(workflow.jobs.build?.['runs-on']).toBe('xcode-27')
  expect(workflow.jobs.simulator?.['runs-on']).toBe('xcode-27')
})

test('workflow keeps batch failures and uploads diagnostics before continuing', async () => {
  const source = await Bun.file(new URL('../../.github/workflows/ios.yml', import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    jobs: { simulator: { strategy: { 'max-parallel': number, 'fail-fast': boolean }, steps: Array<{
      name?: string, if?: string, run?: string, uses?: string,
      'continue-on-error'?: boolean, with?: { path: string },
    }> } }
  }
  const job = workflow.jobs.simulator
  expect(job.strategy['max-parallel']).toBe(5)
  expect(job.strategy['fail-fast']).toBe(false)
  const batches = job.steps.filter(step => step.run?.includes('ios/scripts/ci-e2e.sh'))
  expect(batches).toHaveLength(2)
  for (const batch of batches) expect(batch['continue-on-error']).toBeUndefined()
  // An explicit !cancelled() bypasses GitHub's implicit success() condition,
  // while requiring successfully restored products and a nonempty second slot.
  expect(batches[1]!.if).toBe("${{ !cancelled() && steps.products.outcome == 'success' && matrix.secondShard != '' }}")
  for (const batch of batches) {
    const upload = job.steps[job.steps.indexOf(batch) + 1]!
    expect(upload.uses).toContain('actions/upload-artifact@')
    expect(upload.if).toContain('always()')
    expect(upload.with?.path).toContain('/tmp/ab-ios-diagnostics/**')
    expect(upload.with?.path).toContain('ios/evidence/')
    expect(upload.with?.path).toContain('/tmp/ab-ios-fixture-logs/')
  }
})
