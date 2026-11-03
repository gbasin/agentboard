import { describe, expect, test } from 'bun:test'
import type { ChatWireDirection } from '../../shared/chat'
import { createLineSplitter, createWireTappedSpawn } from '../chat/wireTap'

function recorder() {
  const frames: Array<{ dir: ChatWireDirection; raw: string }> = []
  return { frames, record: (dir: ChatWireDirection, raw: string) => frames.push({ dir, raw }) }
}

function waitForExit(emitter: { once(event: 'exit', listener: (code: number | null) => void): void }): Promise<number | null> {
  return new Promise(resolve => emitter.once('exit', code => resolve(code)))
}

// Echoes each stdin line to stdout as `{"echo":<line>}`, writes one stderr
// line, and exits when stdin ends.
const ECHO_SCRIPT = `
process.stderr.write('ready\\n')
let buffered = ''
process.stdin.on('data', chunk => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\\n')) !== -1) {
    process.stdout.write(JSON.stringify({ echo: buffered.slice(0, index) }) + '\\n')
    buffered = buffered.slice(index + 1)
  }
})
process.stdin.on('end', () => process.exit(0))
`

describe('createLineSplitter', () => {
  test('joins lines split across chunks and keeps content verbatim', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(line => lines.push(line))
    splitter.write('{"a":')
    splitter.write(Buffer.from('1}\n{"b":2}\r\n{"c"'))
    splitter.write(':3}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}\r', '{"c":3}'])
  })

  test('reassembles multi-byte characters split across chunks', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(line => lines.push(line))
    const bytes = Buffer.from('héllo — 日本\n', 'utf8')
    for (let index = 0; index < bytes.length; index += 1) {
      splitter.write(bytes.subarray(index, index + 1))
    }
    expect(lines).toEqual(['héllo — 日本'])
  })

  test('flushes a trailing partial line on end, once', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(line => lines.push(line))
    splitter.write('first\nlast')
    expect(lines).toEqual(['first'])
    splitter.end()
    splitter.end()
    splitter.write('ignored\n')
    expect(lines).toEqual(['first', 'last'])
  })

  test('emits empty lines', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(line => lines.push(line))
    splitter.write('\n\nx\n')
    expect(lines).toEqual(['', '', 'x'])
  })

  test('a line spanning many chunks, then more lines in its closing chunk, splits exactly', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(line => lines.push(line))
    splitter.write('ab')
    splitter.write('cd')
    splitter.write(Buffer.from('ef'))
    splitter.write('g\nh\n\ni')
    splitter.write('j\n')
    expect(lines).toEqual(['abcdefg', 'h', '', 'ij'])
  })

  // A resumed Codex thread answers with its whole history on one line; the
  // old splitter re-scanned the growing buffer per chunk (64 MB took ~3.5 s,
  // hundreds of MB pinned the server). Linear splitting takes ~30 ms here.
  test('a 64 MB line in 64 KB chunks splits in linear time', () => {
    let length = -1
    const splitter = createLineSplitter((line) => { length = line.length })
    const chunk = Buffer.alloc(64 * 1024, 'a'.charCodeAt(0))
    const started = performance.now()
    for (let index = 0; index < 1024; index += 1) splitter.write(chunk)
    splitter.write('\n')
    expect(performance.now() - started).toBeLessThan(1500)
    expect(length).toBe(64 * 1024 * 1024)
  })
})

describe('createWireTappedSpawn', () => {
  test('records out, in, stderr, and lifecycle frames while forwarding bytes unchanged', async () => {
    const { frames, record } = recorder()
    const spawn = createWireTappedSpawn({ record })
    const child = spawn({
      command: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: new AbortController().signal,
    })
    const received: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => received.push(chunk))
    const drained = new Promise(resolve => child.stdout.once('end', resolve))
    const exited = waitForExit(child)
    child.stdin.write('{"type":"user","text":"hi"}\n')
    child.stdin.write('{"type":"control_request"}\n')
    child.stdin.end()
    expect(await exited).toBe(0)
    await drained

    const expectedOut = ['{"type":"user","text":"hi"}', '{"type":"control_request"}']
    const expectedIn = expectedOut.map(line => JSON.stringify({ echo: line }))
    expect(Buffer.concat(received).toString()).toBe(expectedIn.map(line => `${line}\n`).join(''))
    expect(frames.filter(frame => frame.dir === 'out').map(frame => frame.raw)).toEqual(expectedOut)
    expect(frames.filter(frame => frame.dir === 'in').map(frame => frame.raw)).toEqual(expectedIn)
    expect(frames.filter(frame => frame.dir === 'stderr').map(frame => frame.raw)).toEqual(['ready'])

    const lifecycle = frames.filter(frame => frame.dir === 'lifecycle').map(frame => JSON.parse(frame.raw))
    expect(lifecycle[0]).toEqual({ event: 'spawn', command: process.execPath, args: ['-e', ECHO_SCRIPT], cwd: process.cwd() })
    expect(lifecycle.at(-1)).toEqual({ event: 'exit', code: 0, signal: null })
    expect(frames[0]!.dir).toBe('lifecycle')
    expect(frames.at(-1)!.dir).toBe('lifecycle')
    expect(child.exitCode).toBe(0)
    expect(child.killed).toBe(false)
  })

  test('never records the spawn environment', async () => {
    const { frames, record } = recorder()
    const secret = 'sk-ant-secret-value-123'
    const child = createWireTappedSpawn({ record })({
      command: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      env: { ...process.env, ANTHROPIC_API_KEY: secret, CLAUDE_CODE_OAUTH_TOKEN: secret },
      signal: new AbortController().signal,
    })
    const exited = waitForExit(child)
    child.stdin.end('{"type":"user"}\n')
    await exited
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame.raw).not.toContain(secret)
      expect(frame.raw).not.toContain('ANTHROPIC_API_KEY')
    }
  })

  test('kill is delegated and the exit signal is recorded', async () => {
    const { frames, record } = recorder()
    const child = createWireTappedSpawn({ record })({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: { ...process.env },
      signal: new AbortController().signal,
    })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    expect(child.kill('SIGTERM')).toBe(true)
    await exited
    expect(child.killed).toBe(true)
    expect(child.signalCode).toBe('SIGTERM')
    expect(JSON.parse(frames.at(-1)!.raw)).toEqual({ event: 'exit', code: null, signal: 'SIGTERM' })
  })

  test('a missing executable records an error frame and emits the child error', async () => {
    const { frames, record } = recorder()
    const child = createWireTappedSpawn({ record })({
      command: '/nonexistent/claude-binary',
      args: [],
      env: {},
      signal: new AbortController().signal,
    })
    const error = await new Promise<Error>(resolve => child.once('error', resolve))
    expect(error.message).toContain('ENOENT')
    const errorFrame = frames.find(frame => frame.dir === 'lifecycle' && JSON.parse(frame.raw).event === 'error')
    expect(errorFrame).toBeDefined()
    expect(JSON.parse(errorFrame!.raw).message).toContain('ENOENT')
  })
})
