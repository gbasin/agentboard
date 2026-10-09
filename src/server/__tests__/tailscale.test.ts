// tailscale.test.ts - getTailscaleIp against a fake `tailscale` CLI on PATH
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getTailscaleIp } from '../tailscale'

// Prints $AB_TS_FAKE_DIR/out, or hangs like a CLI waiting on a stuck
// tailscaled when $AB_TS_FAKE_DIR/hang exists.
const FAKE_TAILSCALE = `#!/bin/sh
dir="$AB_TS_FAKE_DIR"
printf '%s\\n' "$*" >> "$dir/calls.log"
[ -f "$dir/hang" ] && exec sleep 5
cat "$dir/out"
`

const savedPath = process.env.PATH
const savedFakeDir = process.env.AB_TS_FAKE_DIR
let binDir = ''

function calls(): string[] {
  try {
    return fs.readFileSync(path.join(binDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tailscale-fakebin-'))
  fs.writeFileSync(path.join(binDir, 'tailscale'), FAKE_TAILSCALE, { mode: 0o755 })
  process.env.PATH = `${binDir}:${savedPath ?? ''}`
  process.env.AB_TS_FAKE_DIR = binDir
})

afterAll(() => {
  process.env.PATH = savedPath
  if (savedFakeDir === undefined) delete process.env.AB_TS_FAKE_DIR
  else process.env.AB_TS_FAKE_DIR = savedFakeDir
  fs.rmSync(binDir, { recursive: true, force: true })
})

describe('getTailscaleIp', () => {
  test('returns the address the CLI prints', async () => {
    fs.rmSync(path.join(binDir, 'hang'), { force: true })
    fs.writeFileSync(path.join(binDir, 'out'), '100.64.0.9\n')
    expect(await getTailscaleIp(2000)).toBe('100.64.0.9')
  })

  test('gives up at the timeout and returns null without trying the app bundle', async () => {
    fs.writeFileSync(path.join(binDir, 'hang'), '')
    fs.rmSync(path.join(binDir, 'calls.log'), { force: true })
    const startedAt = performance.now()
    expect(await getTailscaleIp(200)).toBeNull()
    expect(performance.now() - startedAt).toBeLessThan(2000)
    // One hung lookup, not one per candidate path.
    expect(calls()).toEqual(['ip -4'])
  })
})
