import { test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractPullRequests, getSessionPullRequests, clearPrScanCache } from '../prExtractor'
import { restCompletion, restCommand, pythonRestCommand, pythonComprehensionRestCommand, restPrUrl } from '../../../tests/fixtures/restPr'
const line = (entry: object) => JSON.stringify(entry) + '\n'
const expected = [{ url: restPrUrl, repo: 'e2e/rest-pr', number: 15 }]
const chainedPython = "git status -sb && git diff --cached --check && PATH=/tmp/bin:$PATH git commit -m 'create PR' > /tmp/commit.log 2>&1 && git push -u origin HEAD && " + pythonRestCommand

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

test('recognizes the trailing Python heredoc in a successful Git chain', () => {
  const output = `To https://github.com/e2e/rest-pr.git\nbranch 'feature' set up to track 'origin/feature'.\n${restPrUrl}\n`
  expect(extractPullRequests(line(restCompletion(chainedPython, { aggregated_output: output })))).toEqual(expected)
  expect(extractPullRequests(line(restCompletion(chainedPython, {
    aggregated_output: output, formatted_output: restPrUrl,
  })))).toEqual(expected)
  expect(extractPullRequests(line(restCompletion(chainedPython, {
    aggregated_output: `https://github.com/e2e/rest-pr/pull/16\n${output}`,
  })))).toEqual([])
  expect(extractPullRequests(line(restCompletion(chainedPython, {
    aggregated_output: `${restPrUrl}\nFinished pushing\n`, formatted_output: restPrUrl,
  })))).toEqual([])
  expect(extractPullRequests(line(restCompletion(chainedPython, {
    aggregated_output: output, exit_code: 1,
  })))).toEqual([])
})

test('ignores branching, quoted Python and other Git chain lookalikes', () => {
  for (const command of [
    `git push || ${pythonRestCommand}`,
    `git push && true||/usr/bin/${pythonRestCommand}`,
    `git push && python3 - <<'PY'\npass\nPY\n: <<'PY'\n${pythonRestCommand.split('\n').slice(1).join('\n')}`,
    `git push && cat <<'EXAMPLE'\n${pythonRestCommand}\nEXAMPLE`,
    `git commit -m 'git push && ${pythonRestCommand}'`,
    `exit 0 && git push && ${pythonRestCommand}`,
    `git push ${'x'.repeat(16_384)} || ${pythonRestCommand}`,
  ]) {
    expect(extractPullRequests(line(restCompletion(command, { aggregated_output: restPrUrl })))).toEqual([])
  }
})

for (const command of [
  restCommand, restCommand.replace('--method POST', '-X POST'),
  restCommand.replace('--method POST', '--method=POST'),
  restCommand.replace('--method POST', '-XPOST'),
  `echo ready; ${restCommand}`, `env FOO=bar ${restCommand}`,
  `echo "$( ${restCommand} )"`, pythonRestCommand,
  pythonRestCommand.replace('subprocess.run', 'subprocess.check_output'),
  pythonComprehensionRestCommand,
  pythonComprehensionRestCommand.replace("v[k] for k in ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL']", "v[k] for k in ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL'] if k in v"),
  pythonRestCommand.replace("p=pathlib.Path", "unused=[x for x in []]\np=pathlib.Path"),
  pythonRestCommand.replace("p=pathlib.Path", "unused=(x for x in [])\np=pathlib.Path"),
  pythonRestCommand.replace("p=pathlib.Path", "unused={'[': ')', '#': '}'}\np=pathlib.Path"),
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
  pythonRestCommand.replace('r=subprocess.run', 'def create():\n r=subprocess.run'),
  pythonRestCommand.replace('r=subprocess.run', 'for x in []:\n r=subprocess.run'),
  pythonRestCommand.replace('r=subprocess.run', 'r=lambda: subprocess.run'),
  pythonRestCommand.replace('r=subprocess.run', 'r=True or subprocess.run'),
  pythonRestCommand.replace('r=subprocess.run', 'r=[subprocess.run').replace('check=True)', 'check=True) for x in []]'),
  pythonRestCommand.replace('r=subprocess.run', 'r=(subprocess.run').replace('check=True)', 'check=True) for x in [])'),
  pythonRestCommand.replace('r=subprocess.run', 'r=(False and subprocess.run').replace('check=True)', 'check=True))'),
  pythonRestCommand.replace('r=subprocess.run', 'r=(subprocess.run').replace('check=True)', 'check=True) if False else None)'),
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

test.each([pythonComprehensionRestCommand, chainedPython])('incremental byte prefilter retains REST completions across every pulls seam', command => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rest-pr-'))
  const file = path.join(dir, 'log.jsonl')
  const content = line(restCompletion(command, { aggregated_output: restPrUrl }))
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
