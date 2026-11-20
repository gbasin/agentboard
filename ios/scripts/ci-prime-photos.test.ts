import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { photoFixturePNG } from './photo-fixture'

const script = join(import.meta.dir, 'ci-prime-photos.sh')
async function run(...batches: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ab-prime-photos-test-'))
  const log = join(root, 'calls.log')
  writeFileSync(join(root, 'xcrun'), `#!/bin/bash\necho "$*" >> "${log}"\nif [ "$2" = addmedia ]; then cp "$4" "${root}/imported.png"; fi\n`)
  chmodSync(join(root, 'xcrun'), 0o755)
  const proc = Bun.spawn(['/bin/bash', script, 'mock-udid', ...batches], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  const imported = join(root, 'imported.png')
  for (let i = 0; i < 100 && !existsSync(imported) && batches.some(b => b.endsWith(':media')); i++) await Bun.sleep(50)
  return { calls: existsSync(log) ? readFileSync(log, 'utf8') : '', imported }
}

test('workers without a photo batch start no import', async () => {
  const { calls } = await run('light:catalog', 'dark:lifecycle', ':')
  expect(calls).toBe('')
})

test('a later media batch starts the fixture photo import after boot', async () => {
  const { calls, imported } = await run('light:lifecycle', 'dark:media', ':')
  expect(calls).toBe('simctl bootstatus mock-udid -b\nsimctl addmedia mock-udid ' + calls.split(' ').at(-1))
  expect(readFileSync(imported)).toEqual(photoFixturePNG)
})
