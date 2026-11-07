import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OutputThumbnails } from '../outputs/thumbnails'

test('capture is first-open only, persists across instances, and serializes work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-thumbnails-test-'))
  let calls = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const cache = new OutputThumbnails(root, async (_url, file) => {
    calls++; await pending; await fs.writeFile(file, 'image')
  })
  try {
    expect(await cache.read('one')).toBeNull()
    const capture = cache.ensure('one', 'http://localhost:1234')
    await cache.ensure('two', 'http://localhost:1234')
    release(); await capture
    expect(calls).toBe(1)
    expect(String(await new OutputThumbnails(root).read('one'))).toBe('image')
    await cache.ensure('one', 'http://localhost:1234')
    expect(calls).toBe(1)
    expect(await cache.read('two')).toBeNull()
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('capture errors and oversized images leave no cached or temporary file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-thumbnails-test-'))
  try {
    const cache = new OutputThumbnails(root, async (_url, file) => { await fs.writeFile(file, Buffer.alloc(600 * 1024)) })
    await cache.ensure('large', 'http://localhost:1234')
    expect(await cache.read('large')).toBeNull()
    await new OutputThumbnails(root, async () => { throw Error('no browser') }).ensure('missing', 'http://localhost:1234')
    expect(await fs.readdir(root)).toEqual([])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
