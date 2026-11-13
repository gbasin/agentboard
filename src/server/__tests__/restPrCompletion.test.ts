import { test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractPullRequests, getSessionPullRequests, clearPrScanCache } from '../prExtractor'
import { restCompletion, restCommand, pythonRestCommand, restPrUrl } from '../../../tests/fixtures/restPr'
const line = (entry: object) => JSON.stringify(entry) + '\n'
const expected = [{ url: restPrUrl, repo: 'e2e/rest-pr', number: 15 }]

test('completed shell and Python REST creates recover URLs after exec yielded, once', () => {
  const log = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'create', input: 'text(await tools.exec_command({cmd:"gh api repos/e2e/rest-pr/pulls --method POST"}))' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'create', output: '{"session_id":66236,"output":""}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'poll', input: 'text(await tools.write_stdin({session_id:66236,chars:""}))' } },
    restCompletion(), restCompletion(pythonRestCommand), restCompletion(),
  ].map(line).join('')
  expect(extractPullRequests(log)).toEqual(expected)
  expect(extractPullRequests(line(restCompletion(pythonRestCommand)))).toEqual(expected)
})

for (const command of [
  restCommand, restCommand.replace('--method POST', '-X POST'),
  restCommand.replace('--method POST', '--method=POST'),
  restCommand.replace('--method POST', '-XPOST'),
  `echo ready; ${restCommand}`, `env FOO=bar ${restCommand}`,
  `echo "$( ${restCommand} )"`, pythonRestCommand,
  pythonRestCommand.replace('subprocess.run', 'subprocess.check_output'),
]) test(`recognizes literal REST creation: ${command.split('\n')[0]}`, () => {
  expect(extractPullRequests(line(restCompletion(command)))).toEqual(expected)
})

for (const command of [
  restCommand.replace('--method POST', '--method GET'),
  restCommand.replace('--method POST', '--method PATCH'),
  restCommand.replace('--method POST', ''),
  restCommand.replace('/pulls ', '/pulls/15 '),
  restCommand.replace('/pulls ', '/issues '),
  `echo '${restCommand}'`, `grep '${restCommand}' another.jsonl`,
  `cat <<'PY'\n${pythonRestCommand}\nPY`,
  pythonRestCommand.replace('r=subprocess.run', '# r=subprocess.run'),
  pythonRestCommand.replace('r=subprocess.run', 'example="""subprocess.run').replace("x=json.loads", '"""\nx=json.loads'),
  pythonRestCommand.replace('r=subprocess.run', 'if False:\n r=subprocess.run'),
  pythonRestCommand.replace("'POST'", "'GET'"),
  pythonRestCommand.replace('r=subprocess.run', 'r=False and subprocess.run'),
]) test(`ignores reads and inert source: ${command.split('\n')[0]}`, () => {
  expect(extractPullRequests(line(restCompletion(command)))).toEqual([])
})

test('requires a successful completed command and matching repository', () => {
  for (const overrides of [{ status: 'failed' }, { status: 'in_progress' }, { exit_code: 1 },
    { aggregated_output: 'https://github.com/other/repo/pull/15' }]) {
    expect(extractPullRequests(line(restCompletion(restCommand, overrides)))).toEqual([])
  }
  expect(extractPullRequests(line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: restPrUrl } }))).toEqual([])
})

test('incremental byte prefilter retains REST completions across every pulls seam', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rest-pr-'))
  const file = path.join(dir, 'log.jsonl')
  const content = line(restCompletion())
  try {
    for (let split = 1; split < 'pulls'.length; split++) {
      clearPrScanCache()
      const cut = content.indexOf('pulls') + split
      fs.writeFileSync(file, content.slice(0, cut))
      expect(getSessionPullRequests(file)).toEqual([])
      fs.appendFileSync(file, content.slice(cut))
      expect(getSessionPullRequests(file)).toEqual(expected)
      expect(getSessionPullRequests(file)).toEqual(expected)
    }
    clearPrScanCache()
    fs.writeFileSync(file, '')
    for (const byte of Buffer.from(content)) {
      fs.appendFileSync(file, Buffer.from([byte]))
      getSessionPullRequests(file)
    }
    expect(getSessionPullRequests(file)).toEqual(expected)
  } finally { clearPrScanCache(); fs.rmSync(dir, { recursive: true, force: true }) }
})
