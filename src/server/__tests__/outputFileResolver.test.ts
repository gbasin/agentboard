/** Filename recovery uses this session's evidence, never a filesystem search. */
import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { OutputFileResolver } from '../outputs/fileResolver'
import { collectFileEvidence } from '../outputs/fileEvidence'
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const write = (file: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: 'hello' } }] } })

test('extracts structured paths, shell output and recorded working directories without treating user prose as evidence', () => {
  expect(collectFileEvidence(write('/tmp/my report.html'), '/repo').paths).toEqual(['/tmp/my report.html'])
  expect(collectFileEvidence({ ...write('report.html'), cwd: '/other' }, '/repo').paths).toEqual(['/other/report.html'])
  expect(collectFileEvidence(assistant('`~/Desktop/report.html`'), '/repo').paths).toEqual([path.join(os.homedir(), 'Desktop/report.html')])
  expect(collectFileEvidence(assistant('`report.html` in Desktop'), '/repo').paths).toEqual([])
  expect(collectFileEvidence({ type: 'user', message: { role: 'user', content: '`/tmp/private.html`' } }, '/repo').paths).toEqual([])
  expect(collectFileEvidence({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ cmd: 'open "./my report.html"', workdir: '/tmp' }) } }, '/repo').paths).toEqual(['/tmp/my report.html'])
  expect(collectFileEvidence({ type: 'response_item', payload: { type: 'function_call_output', output: 'Saved /tmp/report.html\n' } }, '/repo').paths).toEqual(['/tmp/report.html'])
  expect(collectFileEvidence({ type: 'session_meta', payload: { cwd: '/other' } }, '/repo').cwd).toBe('/other')
  expect(collectFileEvidence(write('/tmp/$unknown/report.html'), '/repo').paths).toEqual([])
})

test('resolves subagent outputs, refreshes cached evidence, rejects forged choices and keeps explicit paths exact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-resolver-'))
  const project = path.join(root, 'project'), output = path.join(root, 'Desktop', 'report.html')
  const log = path.join(root, 'session.jsonl'), children = path.join(root, 'session', 'subagents')
  const record = { sessionId: 'session', agentType: 'claude' as const, logFilePath: log, projectPath: project }
  const resolver = new OutputFileResolver()
  try {
    await fs.mkdir(project); await fs.mkdir(path.dirname(output)); await fs.mkdir(children, { recursive: true })
    await fs.writeFile(output, '<h1>report</h1>')
    await fs.writeFile(log, JSON.stringify(assistant('`report.html`')) + '\n')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'missing', attemptedPath: path.join(project, 'report.html') })
    await fs.writeFile(path.join(children, 'agent-one.jsonl'), JSON.stringify(write(output)) + '\n')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'resolved', file: output })
    expect((await resolver.resolve('./report.html', record)).kind).toBe('missing')
    const other = path.join(root, 'report.html')
    await fs.writeFile(other, 'other')
    await fs.appendFile(log, JSON.stringify(write(other)) + '\n')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'ambiguous', candidates: [output, other].sort() })
    expect(await resolver.resolve('report.html', record, output)).toEqual({ kind: 'resolved', file: output })
    await expect(resolver.resolve('report.html', record, '/etc/passwd')).rejects.toThrow('no longer')
    await fs.unlink(other)
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'resolved', file: output })
    // A direct project path wins even with several historical references.
    const direct = path.join(project, 'report.html')
    await fs.writeFile(direct, 'direct')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'resolved', file: direct })
    await fs.unlink(direct)
    await fs.writeFile(path.join(children, 'agent-one.jsonl'), JSON.stringify(assistant('removed')) + '\n')
    expect((await resolver.resolve('report.html', record)).kind).toBe('missing')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('keeps session caches separate, follows each log cwd and handles malformed records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-resolver-scope-'))
  const file = path.join(root, 'report.html'), log = path.join(root, 'one.jsonl'), other = path.join(root, 'two.jsonl')
  const resolver = new OutputFileResolver()
  const record = { sessionId: 'one', agentType: 'codex' as const, logFilePath: log, projectPath: path.join(root, 'project') }
  try {
    await fs.writeFile(file, 'report')
    await fs.writeFile(log, 'invalid\n' + JSON.stringify({ type: 'session_meta', payload: { cwd: root } }) + '\n' + JSON.stringify(write('report.html')))
    await fs.writeFile(other, JSON.stringify(assistant('`report.html`')) + '\n')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'resolved', file })
    expect((await resolver.resolve('report.html', { ...record, logFilePath: other })).kind).toBe('missing')
    expect(await resolver.resolve('report.html', record)).toEqual({ kind: 'resolved', file })
    await fs.rename(log, log + '.old')
    await fs.writeFile(log, JSON.stringify(assistant('`report.html`')) + '\n')
    expect((await resolver.resolve('report.html', record)).kind).toBe('missing')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('fails closed on scan limits and retries after evidence becomes readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-resolver-limit-'))
  const log = path.join(root, 'session.jsonl'), file = path.join(root, 'report.html')
  const record = { sessionId: 'limited', agentType: 'claude' as const, logFilePath: log, projectPath: path.join(root, 'project') }
  const resolver = new OutputFileResolver()
  try {
    await fs.writeFile(log, '')
    await fs.truncate(log, 513 * 1024 * 1024)
    await expect(resolver.resolve('report.html', record)).rejects.toThrow('too large')
    await fs.writeFile(file, 'report')
    await fs.writeFile(log, JSON.stringify(write(file)) + '\n')
    const answers = await Promise.all(Array.from({ length: 5 }, () => resolver.resolve('report.html', record)))
    expect(answers).toEqual(Array(5).fill({ kind: 'resolved', file }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
