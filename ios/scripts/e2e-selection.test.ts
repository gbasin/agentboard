import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { e2eSelection, shards } from './e2e-selection'

const uiDirectory = new URL('../UITests/', import.meta.url)
const optIn = new Set(['TailnetSmokeTests', 'ExternalAcceptanceUITests'])
const methods = readdirSync(uiDirectory).filter(file => file.endsWith('.swift')).flatMap(file => {
  const source = readFileSync(new URL(file, uiDirectory), 'utf8')
  const name = source.match(/final class (\w+): XCTestCase/)?.[1]
  if (!name || optIn.has(name)) return []
  return [...source.matchAll(/func (test\w+)\(/g)].map(match => `AgentboardSpikeUITests/${name}/${match[1]}`)
})
const expand = (selectors: string[]) => selectors.flatMap(selector => selector === 'AgentboardSpikeTests'
  ? [selector] : methods.filter(method => method === selector || method.startsWith(selector + '/')))

for (const appearance of ['light', 'dark']) {
  test(`${appearance} shards cover every intended test exactly once`, () => {
    const expected = methods.filter(method => appearance === 'light' || (
      !method.includes('/SpikeUITests/') && (!method.includes('/LiveUITests/') ||
        method.endsWith('/testFrozenSnapshotRefreshCopyAndReturnToInput') || method.endsWith('/testSessionOverviewSwitchesWithStatus'))
    ))
    if (appearance === 'light') expected.push('AgentboardSpikeTests')
    const actual = shards.flatMap(shard => expand(e2eSelection(appearance, shard)))
    expect(actual.length).toBe(new Set(actual).size)
    expect(actual.sort()).toEqual(expected.sort())
    expect(expand(e2eSelection(appearance)).sort()).toEqual(expected.sort())
    for (const shard of shards) for (const selector of e2eSelection(appearance, shard)) {
      expect(expand([selector]).length).toBeGreaterThan(0)
    }
  })
}
test('invalid selections fail instead of silently running no tests', () => {
  expect(() => e2eSelection('dark', 'typo')).toThrow()
  expect(() => e2eSelection('typo')).toThrow()
})

// Check setup against Swift source as well as selectors: additions to a class can
// introduce a new service dependency even when its shard selector does not change.
test('fixture plans cover the loopback endpoints referenced by every selected test class', async () => {
  const { e2eFixtures } = await import('./e2e-fixtures')
  const endpoints: Record<string, string> = { '4151': 'backend', '4149': 'shell-server', '4190': 'pr-fixture', '4192': 'parity-gap-fixture', '4193': 'media-activity-fixture' }
  for (const appearance of ['light', 'dark']) for (const shard of shards) {
    const plan = e2eFixtures(appearance, shard)
    for (const selector of e2eSelection(appearance, shard)) {
      const name = selector.split('/')[1]
      if (!name) continue
      // Method selectors share helpers with other methods. Endpoint assertions
      // for these are covered by the explicit media/settings plans below.
      if (selector.split('/').length > 2) continue
      const source = readFileSync(new URL(`${name}.swift`, uiDirectory), 'utf8')
      for (const [port, fixture] of Object.entries(endpoints)) {
        if (source.includes(`127.0.0.1:${port}`)) expect(plan).toContain(fixture)
      }
    }
  }
})

test('setup keeps media dependencies on terminal and restricts simulator imports to media', async () => {
  const { e2eFixtures } = await import('./e2e-fixtures')
  expect(e2eFixtures('light', 'catalog')).toEqual(['parity-gap-fixture'])
  expect(e2eFixtures('light', 'terminal')).toEqual(['backend', 'live', 'shell-server', 'media-activity-fixture'])
  expect(e2eFixtures('dark', 'terminal')).toEqual(['backend', 'live', 'media-activity-fixture'])
  expect(e2eFixtures('all', 'lifecycle')).toEqual(['backend', 'parity', 'warm'])
  expect(e2eFixtures('all', 'media')).toEqual(['backend', 'live', 'parity', 'warm', 'media-activity-fixture', 'photos', 'files'])
  expect(e2eFixtures('all', 'settings')).toEqual(['backend', 'live', 'parity', 'warm', 'pr-fixture'])
  expect(e2eFixtures('all')).toEqual((await import('./e2e-fixtures')).fixtureNames as unknown as string[])
  expect(() => e2eFixtures('typo')).toThrow()
  expect(() => e2eFixtures('light', 'typo')).toThrow()
})
