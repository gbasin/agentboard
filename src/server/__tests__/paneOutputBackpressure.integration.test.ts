import { expect, test } from 'bun:test'
import { privateTmuxEnv } from './testEnvironment'

test('shared broker bounds a slow subscriber while a credited subscriber continues', async () => {
  const child = Bun.spawn([process.execPath, 'src/server/__tests__/fixtures/paneOutputBackpressure.ts'], {
    env: { ...privateTmuxEnv(null), LOG_LEVEL: 'error' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(stderr).toBe('')
  expect(exit).toBe(0)
  const result = JSON.parse(stdout.trim())
  expect(result.slowFailed).toBe(true)
  expect(result.terminalError).toBe(false)
  expect(result.fastFailed).toBe(false)
  expect(result.fastBytes).toBeGreaterThan(2 * 1024 * 1024)
}, 20000)
