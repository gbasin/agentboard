import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { visualizationFile } from '../outputs/visualization'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

test('uses only a standalone export containing the exact current fragment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-viz-')); dirs.push(root)
  const source = path.join(root, 'report.html')
  await fs.writeFile(source, '<p>Current report</p>')
  await fs.writeFile(path.join(root, 'a-stale.html'), '<html data-visualize-standalone>&lt;p&gt;Old report&lt;/p&gt;</html>')
  const current = path.join(root, 'b-current.html')
  await fs.writeFile(current, '<html data-visualize-standalone>&lt;p&gt;Current report&lt;/p&gt;</html>')
  expect(await visualizationFile(source, root)).toBe(current)
})

test('full documents bypass the optional fragment runtime; missing sources fail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-viz-')); dirs.push(root)
  const source = path.join(root, 'report.html')
  await fs.writeFile(source, '<!doctype html><h1>Report</h1>')
  expect(await visualizationFile(source, root)).toBe(source)
  await fs.unlink(source)
  await expect(visualizationFile(source, root)).rejects.toThrow()
})
