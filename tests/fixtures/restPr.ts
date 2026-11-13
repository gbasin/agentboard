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
export function restCompletion(command = restCommand, overrides: Record<string, unknown> = {}) {
  return { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CommandExecution', id: 'exec-rest', process_id: '66236',
    command: ['/bin/zsh', '-lc', command], status: 'completed', exit_code: 0,
    aggregated_output: JSON.stringify({ number: 15, html_url: restPrUrl }), ...overrides,
  } } }
}
