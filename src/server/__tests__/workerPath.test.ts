import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { resolveWorkerPath } from '../workerPath'

const discoveryWorkers = ['mediaDiscoveryReaderWorker', 'mediaDiscoveryWriterWorker'] as const

test('discovery worker source paths resolve independently of caller entrypoint', () => {
  for (const name of discoveryWorkers) {
    const url = new URL(resolveWorkerPath(name))
    expect(url.protocol).toBe('file:')
    expect(url.pathname).toEndWith(`/src/server/${name}.ts`)
  }
})

test('release and compiled runtime smoke build include both discovery worker entrypoints', () => {
  for (const workflow of ['release.yml', 'ci.yml']) {
    const yaml = fs.readFileSync(new URL(`../../../.github/workflows/${workflow}`, import.meta.url), 'utf8')
    const serverBuild = yaml.split('\n').find(line => line.includes('bun build src/server/index.ts'))
    expect(serverBuild).toBeDefined()
    for (const name of discoveryWorkers) expect(serverBuild).toContain(`src/server/${name}.ts`)
  }
})
