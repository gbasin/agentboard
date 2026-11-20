import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { type OutputSink, runChild } from './test-runner-child'

const env = { PATH: process.env.PATH }

function collector() {
  const chunks: string[] = []
  const sink: OutputSink = {
    write: (chunk) => {
      chunks.push(new TextDecoder().decode(chunk))
      return true
    },
    once: () => undefined,
  }
  return { chunks, sink }
}

test('forwards output and records a normal exit', async () => {
  const out = collector()
  const err = collector()
  const result = await runChild({
    label: 'ok',
    cmd: ['sh', '-c', 'echo hello; echo "(fail) broken" >&2; exit 3'],
    env,
    sinks: { stdout: out.sink, stderr: err.sink },
  })
  expect(out.chunks.join('')).toBe('hello\n')
  expect(result.exitCode).toBe(3)
  expect(result.signal).toBeNull()
  expect(result.failedTests).toEqual(['broken'])
  expect(result.outputTruncated).toBeUndefined()
})

test('finishes when a grandchild outlives the child and holds its stdout', async () => {
  const out = collector()
  const startedAt = performance.now()
  // The backgrounded sleep inherits the pipe, so EOF would never arrive.
  const result = await runChild({
    label: 'leaky',
    cmd: ['sh', '-c', 'sleep 30 & echo "$!"; echo done'],
    env,
    graceMs: 200,
    sinks: { stdout: out.sink, stderr: collector().sink },
  })
  const grandchild = Number(out.chunks.join('').split('\n')[0])
  try {
    expect(result.exitCode).toBe(0)
    expect(result.outputTruncated).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(10_000)
    expect(result.tail).toContain('done')
  } finally {
    if (grandchild > 0) process.kill(grandchild, 'SIGKILL')
  }
})

test('reports a spawn failure without running anything', async () => {
  const result = await runChild({ label: 'missing', cmd: ['/nonexistent/test-runner-binary'], env })
  expect(result.spawnError).toBeString()
  expect(result.exitCode).toBeNull()
})

test('a stream error kills the child and waits for it before returning', async () => {
  const failing: OutputSink = {
    write: () => {
      throw new Error('EPIPE')
    },
    once: () => undefined,
  }
  const result = await runChild({
    label: 'epipe',
    cmd: ['sh', '-c', 'echo first; exec sleep 30'],
    env,
    sinks: { stdout: failing, stderr: collector().sink },
  })
  expect(result.streamError).toBe('EPIPE')
  expect(result.signal).toBe('SIGTERM')
})

test('waits for drain when the sink is backed up', async () => {
  const emitter = new EventEmitter()
  let drained = false
  const sink: OutputSink = {
    write: () => {
      setTimeout(() => {
        drained = true
        emitter.emit('drain')
      }, 50)
      return false
    },
    once: (event, listener) => emitter.once(event, listener),
  }
  const result = await runChild({
    label: 'slow sink',
    cmd: ['sh', '-c', 'echo x'],
    env,
    sinks: { stdout: sink, stderr: collector().sink },
  })
  expect(drained).toBe(true)
  expect(result.exitCode).toBe(0)
})
