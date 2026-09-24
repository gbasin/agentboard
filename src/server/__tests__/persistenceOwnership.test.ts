/** Real process contention and crash release, without a user tmux/database. */
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { acquireDatabaseOwner } from '../persistence/ownership'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lock-audit-'))
const file = path.join(root, 'agentboard.db')
const children: ReturnType<typeof Bun.spawn>[] = []
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function contender(hold = false, gate?: string) {
  const source = `import fs from 'node:fs';import {acquireDatabaseOwner} from './src/server/persistence/ownership';
    if(process.argv[3])while(!fs.existsSync(process.argv[3]))await Bun.sleep(5);
    try {acquireDatabaseOwner(process.argv[1]);console.log('owned');if(process.argv[2]==='hold')await Bun.sleep(60000)}
    catch(error){console.log(error.message.includes('Another Agentboard')?'blocked':String(error))}`
  const child = Bun.spawn(
    ['bun', '-e', source, file, hold ? 'hold' : 'release', gate || ''],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  children.push(child)
  return child
}

test('simultaneous contenders cannot both own the database, and SIGKILL releases the winner', async () => {
  const gate = path.join(root, 'start')
  const contenders = [contender(true, gate), contender(true, gate)]
  fs.writeFileSync(gate, 'go')
  const outcomes = await Promise.all(
    contenders.map(async (child) => {
      const chunk = await child.stdout.getReader().read()
      return new TextDecoder().decode(chunk.value).trim()
    })
  )
  expect(outcomes.sort()).toEqual(['blocked', 'owned'])
  for (const child of contenders) {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
  const retry = contender()
  expect((await new Response(retry.stdout).text()).trim()).toBe('owned')
}, 10000)

test('releasing one connection does not release another connection in the same process', async () => {
  const first = acquireDatabaseOwner(file),
    second = acquireDatabaseOwner(file)
  first.release()
  first.release()
  const blocked = contender()
  expect((await new Response(blocked.stdout).text()).trim()).toBe('blocked')
  second.release()
  const next = contender()
  expect((await new Response(next.stdout).text()).trim()).toBe('owned')
})

test('failed database initialization closes its connection and releases ownership', async () => {
  const broken = path.join(root, 'broken.db')
  fs.writeFileSync(broken, 'not a database')
  expect(() => initDatabase({ path: broken, exclusive: true })).toThrow()
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import {acquireDatabaseOwner} from './src/server/persistence/ownership'; const owner=acquireDatabaseOwner(process.argv[1]); owner.release()`,
      broken,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  children.push(child)
  expect(await child.exited).toBe(0)
})

test('a database created through a directory symlink retains the same owner', () => {
  const alias = path.join(root, 'alias')
  fs.symlinkSync(root, alias, 'dir')
  const first = initDatabase({
    path: path.join(alias, 'new.db'),
    exclusive: true,
  })
  const second = initDatabase({
    path: path.join(root, 'new.db'),
    exclusive: true,
  })
  try {
    first.setAppSetting('shared', 'yes')
    expect(second.getAppSetting('shared')).toBe('yes')
  } finally {
    first.close()
    second.close()
  }
})
