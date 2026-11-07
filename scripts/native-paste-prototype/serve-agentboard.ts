/** Isolated full-app native paste experiment. No live tmux or app data. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const repo = resolve(import.meta.dir, '../..')
const root = mkdtempSync('/tmp/abnp-')
const workspace = join(root, 'workspace')
mkdirSync(workspace)
const env = { ...process.env, TMUX: undefined, CLAUDECODE: undefined, TMUX_TMPDIR: root }
const session = 'native-paste-test'
function tmux(args: string[]) {
  const result = Bun.spawnSync(['tmux', '-L', 'default', ...args], { env, cwd: workspace })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
// The test terminal records bytes; it never runs pasted text as commands.
const agents = process.argv.includes('--agents')
const instruction = 'This is a terminal clipboard and text selection test. Do not use tools. When asked for test output, print exactly 20 numbered lines, each containing SELECTABLE_OUTPUT, then finish. Otherwise reply OK only.'
const commands = agents ? {
  claude: ['claude', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--append-system-prompt', instruction],
  codex: ['codex', '--sandbox', 'read-only', '-c', `developer_instructions=${JSON.stringify(instruction)}`],
} : {
  terminal: ['/usr/bin/python3', join(import.meta.dir, 'terminal.py'), join(root, 'input.jsonl')],
}

function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'" }
for (const [index, [name, args]] of Object.entries(commands).entries()) {
  const command = args.map(quote).join(' ')
  tmux(index === 0 ? ['new-session', '-d', '-s', session, '-n', name, '-x', '80', '-y', '30', command]
    : ['new-window', '-t', session, '-n', name, command])
}
for (const name of ['claude', 'codex', 'pi', 'devin', 'grok']) mkdirSync(join(root, name))
const appEnv = { ...env, LOG_LEVEL: 'debug', PORT: '18512', TMUX_SESSION: session, DISCOVER_PREFIXES: session,
  AGENTBOARD_DATA_DIR: root, AGENTBOARD_DB_PATH: join(root, 'agentboard.db'), LOG_FILE: join(root, 'app.log'),
  AGENTBOARD_STATIC_DIR: join(repo, 'dist/client'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'), DEVIN_CLI_DIR: join(root, 'devin'), GROK_HOME: join(root, 'grok'),
}
const app = Bun.spawn(['bun', 'src/server/index.ts'], { cwd: repo, env: appEnv, stdout: Bun.file(join(root, 'server.log')), stderr: Bun.file(join(root, 'server.err')) })
writeFileSync(join(root, 'run.json'), JSON.stringify({root, workspace, session, port:18512, appPid:app.pid}, null, 2))
console.log(JSON.stringify({root, session, port:18512, appPid:app.pid}))
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  app.kill('SIGTERM')
  await app.exited
  // Stop only sessions on the private socket created by this run.
  try { for (const name of tmux(['list-sessions', '-F', '#{session_name}']).split('\n')) tmux(['kill-session', '-t', `=${name}`]) } catch { /* server exits when its final session closes */ }
  process.exit(0)
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
await app.exited
