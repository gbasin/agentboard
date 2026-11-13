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
      (!method.includes('/SpikeUITests/') || method.endsWith('/testPasteWaitsForEnterAndRestoresKeyboard')) && (!method.includes('/LiveUITests/') ||
        method.endsWith('/testLiveShellPasteAndBackgroundRecovery') || method.endsWith('/testMultilinePasteWaitsForExplicitEnter') ||
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
  expect(e2eFixtures('light', 'terminal')).toEqual(['backend', 'live', 'parity', 'warm', 'shell-server', 'parity-gap-fixture', 'media-activity-fixture'])
  expect(e2eFixtures('dark', 'terminal')).toEqual(['backend', 'live', 'shell-server', 'parity-gap-fixture', 'media-activity-fixture'])
  expect(e2eFixtures('all', 'lifecycle')).toEqual(['backend', 'parity', 'warm'])
  expect(e2eFixtures('all', 'media')).toEqual(['backend', 'live', 'parity', 'warm', 'media-activity-fixture', 'photos', 'files'])
  expect(e2eFixtures('all', 'settings')).toEqual(['backend', 'live', 'parity', 'warm', 'pr-fixture'])
  expect(e2eFixtures('all')).toEqual((await import('./e2e-fixtures')).fixtureNames as unknown as string[])
  expect(() => e2eFixtures('typo')).toThrow()
  expect(() => e2eFixtures('light', 'typo')).toThrow()
})

// Infer integration resources from Swift fixture identities, independently of
// the setup map. Whole-target XCTest selectors must expand to their sources.
// This catches native tests added beside pure unit tests, including references
// that use a provider UUID rather than a human-readable fixture name.
test('selected native test target provisions the fixture identities its Swift tests consume', async () => {
  const { e2eFixtures } = await import('./e2e-fixtures')
  const nativeDirectory = new URL('../Tests/', import.meta.url)
  const nativeSources = readdirSync(nativeDirectory).filter(file => file.endsWith('.swift'))
    .map(file => ({ file, source: readFileSync(new URL(file, nativeDirectory), 'utf8') }))
  const resources = [
    { fixture: 'backend', token: /127\.0\.0\.1:4151/ },
    { fixture: 'parity', token: /11111111-2222-4333-8444-555555555555|parity-saved-transcript|\/tmp\/ab-ios-parity\/project/ },
    // The warm step establishes the saved conversation's history association.
    { fixture: 'warm', token: /api\/library\/parity-saved-transcript/ },
    { fixture: 'media-activity-fixture', token: /22222222-3333-4444-8555-666666666666/ },
    { fixture: 'live', token: /native-live-(?:one|two)/ },
  ]
  const consumed = new Set<string>()
  let checkedSelections = 0
  for (const appearance of ['light', 'dark']) for (const shard of [...shards, 'all']) {
    if (!e2eSelection(appearance, shard).includes('AgentboardSpikeTests')) continue
    checkedSelections++
    const plan = e2eFixtures(appearance, shard)
    for (const { file, source } of nativeSources) for (const { fixture, token } of resources) {
      if (!token.test(source)) continue
      consumed.add(`${file}:${fixture}`)
      expect(plan, `${appearance}/${shard}: ${file} consumes ${fixture}`).toContain(fixture)
    }
  }
  expect(checkedSelections).toBe(2)
  // Ensure this source-derived regression actually observes both failed suites.
  expect(consumed).toContain('NativeParityTests.swift:parity')
  expect(consumed).toContain('MediaBackendTests.swift:parity')
  expect(consumed).toContain('MediaBackendTests.swift:media-activity-fixture')
})

// These exercise real terminal input and must cover the accessibility-size sheet transition.
test('both appearances run real-shell paste and recovery regressions', () => {
  const required = [
    'LiveUITests/testLiveShellPasteAndBackgroundRecovery',
    'LiveUITests/testMultilinePasteWaitsForExplicitEnter',
    'SpikeUITests/testPasteWaitsForEnterAndRestoresKeyboard',
  ].map(name => `AgentboardSpikeUITests/${name}`)
  for (const appearance of ['light', 'dark']) {
    const selected = expand(e2eSelection(appearance, 'terminal'))
    for (const test of required) expect(selected).toContain(test)
  }
})

test('document export runs in CI with real media and Files fixtures in both appearances', async () => {
  const { e2eFixtures } = await import('./e2e-fixtures')
  for (const appearance of ['light', 'dark']) {
    expect(expand(e2eSelection(appearance, 'media'))).toContain('AgentboardSpikeUITests/DocumentExportUITests/testDocumentShareToFiles')
    for (const fixture of ['backend', 'parity', 'warm', 'files']) expect(e2eFixtures(appearance, 'media')).toContain(fixture)
  }
})
