import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('real matching worker reconciles offline and missed-watcher logs into SQLite', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-fair-worker-'))
  const server = path.resolve(import.meta.dir, '..')
  const logDir = path.join(root, 'claude', 'projects', 'fair')
  await fs.mkdir(logDir, { recursive: true })
  const writeLog = async (id: string, age: number) => {
    const file = path.join(logDir, `${id}.jsonl`)
    await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: id, cwd: root, message: { role: 'user', content: `message for ${id}` } }) + '\n')
    await fs.utimes(file, new Date(), new Date(Date.now() - age * 1000))
  }
  for (let i = 0; i < 30; i++) await writeLog(`s${i}`, i)
  // Launch with environment set at process start: Bun Workers otherwise inherit
  // the original environment, not a test's process.env mutations.
  const source = `
    import { initDatabase } from ${JSON.stringify(path.join(server, 'db.ts'))};
    import { LogPoller } from ${JSON.stringify(path.join(server, 'logPoller.ts'))};
    import { SessionRegistry } from ${JSON.stringify(path.join(server, 'SessionRegistry.ts'))};
    import { appendFileSync, writeFileSync } from 'node:fs';
    const db = initDatabase({ path: ':memory:' });
    const poller = new LogPoller(db, new SessionRegistry(), { matchWorker: true, devinSyncClient: null, maxLogsPerPoll: 5 });
    try {
      for (let cycle = 0; cycle < 18; cycle++) {
        const id = 'new-' + cycle;
        writeFileSync(${JSON.stringify(logDir)} + '/' + id + '.jsonl', JSON.stringify({type:'user', sessionId:id, cwd:${JSON.stringify(root)}, message:{role:'user', content:'new activity'}}) + '\\n');
        appendFileSync(${JSON.stringify(path.join(logDir, 's0.jsonl'))}, JSON.stringify({type:'user', sessionId:'s0', cwd:${JSON.stringify(root)}, message:{role:'user', content:'active update ' + cycle}}) + '\\n');
        await poller.pollOnce();
        if (db.getSessionById('s0')?.lastUserMessage !== 'active update ' + cycle) throw new Error('active update delayed');
        if (!db.getSessionById(id)) throw new Error('hot log delayed: ' + id);
      }
      for (let i = 0; i < 30; i++) if (!db.getSessionById('s' + i)) throw new Error('missing s' + i);
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { poller.stop(); db.close(); }
    process.exit(process.exitCode ?? 0);
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', source], {
      env: {
        ...process.env, HOME: root, TMUX: '',
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
        PI_HOME: path.join(root, 'pi'), PI_CODING_AGENT_DIR: path.join(root, 'omp'),
        GROK_HOME: path.join(root, 'grok'), DEVIN_CLI_DIR: path.join(root, 'devin'),
        AGENTBOARD_DATA_DIR: path.join(root, 'data'), XDG_DATA_HOME: path.join(root, 'xdg'),
      }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, output: code === 0 ? '' : stdout + stderr }).toEqual({ code: 0, output: '' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
