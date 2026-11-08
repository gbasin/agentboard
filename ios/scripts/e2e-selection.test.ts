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
