import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const skipIsolated = args.includes('--skip-isolated')
const passthroughArgs = args.filter((arg) => arg !== '--skip-isolated')

function createTempLogDirs() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tests-'))
  const claudeDir = path.join(tempRoot, 'claude')
  const codexDir = path.join(tempRoot, 'codex')
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true })
  return { tempRoot, claudeDir, codexDir }
}

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn({
    cmd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`)
  }
}

async function main() {
  const { tempRoot, claudeDir, codexDir } = createTempLogDirs()
  const tempLogFile = path.join(tempRoot, 'agentboard.log')
  const tempDbPath = path.join(tempRoot, 'agentboard.db')
  const env = {
    ...process.env,
    // React's act() requires the development build; force NODE_ENV=test
    // so tests pass even when the shell has NODE_ENV=production.
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    LOG_FILE: tempLogFile,
    AGENTBOARD_DB_PATH: tempDbPath,
  }

  try {
    // Tests that either mutate globals or are sensitive to global mutations
    // must run in a separate process so they don't race with other test files.
    // PipePaneTerminalProxy reads Bun.spawnSync at construction time — if another
    // test file has patched it, the proxy gets a mock and start() becomes undefined.
    // hydrateSessionsEmptyGuard imports `../index` with an active Bun.spawnSync /
    // Bun.serve / setInterval mock; isolation keeps that mock window from
    // overlapping with any other test that captures globals at module load.
    const ISOLATED_FILES = new Set([
      'sessionRefreshWorker.test.ts',
      'pipePaneTerminalProxy.test.ts',
      'hydrateSessionsEmptyGuard.test.ts',
    ])

    // Client tests that install top-level mock.module(...) hooks must run in a
    // separate process — Bun's module mocks persist for the lifetime of the
    // test process, so they leak into any subsequent file that imports the
    // same module. app.test.tsx stubs ../components/SessionPreviewContent;
    // when bun's readdir order puts it before SessionPreviewModal.test.tsx
    // (e.g. on Linux ext4) the modal test sees the stub and breaks.
    const ISOLATED_CLIENT_FILES = new Set([
      'app.test.tsx',
    ])

    const serverTests: string[] = []
    const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
    for await (const file of serverGlob.scan({ onlyFiles: true })) {
      if (!ISOLATED_FILES.has(path.basename(file))) {
        serverTests.push(file)
      }
    }

    const clientTests: string[] = []
    const clientGlob = new Bun.Glob('src/client/__tests__/*.test.{ts,tsx}')
    for await (const file of clientGlob.scan({ onlyFiles: true })) {
      if (!ISOLATED_CLIENT_FILES.has(path.basename(file))) {
        clientTests.push(file)
      }
    }
    const sharedTestsDir = 'src/shared/__tests__'

    await runCommand(
      ['bun', 'test', ...passthroughArgs, ...serverTests, sharedTestsDir, ...clientTests],
      env
    )

    // Always run global-mutating tests in a separate process to prevent races.
    const isolatedFiles = Array.from(ISOLATED_FILES).map(
      (f) => `src/server/__tests__/${f}`
    )
    await runCommand(
      ['bun', 'test', ...passthroughArgs, ...isolatedFiles],
      env
    )

    const isolatedClientFiles = Array.from(ISOLATED_CLIENT_FILES).map(
      (f) => `src/client/__tests__/${f}`
    )
    await runCommand(
      ['bun', 'test', ...passthroughArgs, ...isolatedClientFiles],
      env
    )

    if (!skipIsolated) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, 'src/server/__tests__/isolated/'],
        env
      )
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
