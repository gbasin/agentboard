import { defineConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.E2E_PORT) || 4173
const tmuxSession =
  process.env.E2E_TMUX_SESSION || `agentboard-e2e-${Date.now()}`

process.env.E2E_TMUX_SESSION = tmuxSession

// Run the whole suite against a private tmux server. The agentboard server
// creates per-connection grouped sessions (`<base>-ws-<uuid>`) that only its
// own dispose() or its next startup's pruner can reap; when Playwright
// SIGKILLs the webServer they used to leak onto the user's live tmux server
// (which also received the server-global set-clipboard write). With a private
// socket, teardown just kill-servers it — nothing to enumerate, nothing shared.
//
// TMUX_TMPDIR is silently ignored unless the directory exists, and an
// inherited $TMUX (suite run from inside a tmux session) overrides the socket
// choice entirely — hence the mkdir and the delete. Both propagate to the
// webServer, the test workers (paste.spec shells out to tmux), and teardown.
const tmuxTmpDir =
  process.env.E2E_TMUX_TMPDIR || join(tmpdir(), `abe2e-${Date.now()}`)
process.env.E2E_TMUX_TMPDIR = tmuxTmpDir
mkdirSync(tmuxTmpDir, { recursive: true })
process.env.TMUX_TMPDIR = tmuxTmpDir
delete process.env.TMUX

// The tmux server isn't the only shared state: without these, the e2e
// webServer opens the user's live ~/.agentboard/agentboard.db and watches
// their real Claude/Codex/Pi logs. It then rewrites each agent session's
// current_window mapping against ITS tmux view — which contains none of the
// user's windows — desyncing the live dashboard's status and last-message
// display until every session's log happens to grow again. Point all of it
// into the same throwaway directory teardown already removes. Set via
// process.env (like TMUX_TMPDIR above) so the webServer, the test workers,
// and any future setup/teardown code all see the same isolated paths.
const claudeDir = join(tmuxTmpDir, 'claude')
const codexDir = join(tmuxTmpDir, 'codex')
const piDir = join(tmuxTmpDir, 'pi')
mkdirSync(claudeDir, { recursive: true })
mkdirSync(codexDir, { recursive: true })
mkdirSync(piDir, { recursive: true })
process.env.AGENTBOARD_DB_PATH = `${tmuxTmpDir}/agentboard.db`
process.env.LOG_FILE = `${tmuxTmpDir}/agentboard.log`
process.env.AGENTBOARD_TMUX_PID_FILE = `${tmuxTmpDir}/tmux-server.pid`
process.env.CLAUDE_CONFIG_DIR = claudeDir
process.env.CODEX_HOME = codexDir
process.env.PI_HOME = piDir

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    // AGENTBOARD_STATIC_DIR is pinned to the repo build: when e2e runs from a
    // shell inside a live agentboard session, the inherited env points at the
    // installed npm package's bundle and the tests would exercise stale code.
    command: `[ -d dist/client ] || bun run build && PORT=${port} TMUX_SESSION=${tmuxSession} AGENTBOARD_STATIC_DIR=dist/client bun src/server/index.ts`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  globalSetup: './tests/e2e/setup.ts',
  globalTeardown: './tests/e2e/teardown.ts',
})
