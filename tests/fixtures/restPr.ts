// Sanitized shapes from a Codex transcript: Python subprocess and shell REST,
// with the final command record emitted after write_stdin polls.
export const restPrUrl = 'https://github.com/e2e/rest-pr/pull/15'
export const restCommand = 'gh api repos/e2e/rest-pr/pulls --method POST --input /tmp/pr.json'
export const pythonRestCommand = `python3 - <<'PY'
import json,pathlib,subprocess
p=pathlib.Path('/tmp/pr.json')
r=subprocess.run(['gh','api','repos/e2e/rest-pr/pulls','--method','POST','--input',str(p)],capture_output=True,text=True,check=True)
x=json.loads(r.stdout);print(x['html_url'])
PY`
// The reported session builds Git identity env with a dict comprehension
// before an unconditional REST create. Neither command is executed by tests.
export const pythonComprehensionRestCommand = pythonRestCommand.replace(
  'import json,pathlib,subprocess',
  `import json,pathlib,subprocess,os
v={'GIT_AUTHOR_NAME':'fixture','GIT_AUTHOR_EMAIL':'fixture@example.com'}
env={**os.environ,**{k:v[k] for k in ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL']}}`
).replace('check=True)', 'check=True,env=env)')
export function restCompletion(command = restCommand, overrides: Record<string, unknown> = {}) {
  return { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CommandExecution', id: 'exec-rest', process_id: '66236',
    command: ['/bin/zsh', '-lc', command], status: 'completed', exit_code: 0,
    aggregated_output: JSON.stringify({ number: 15, html_url: restPrUrl }), ...overrides,
  } } }
}
