/** Isolated real-browser fault injection; never wraps the production tmux. */
import { defineConfig } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import base from './playwright.config'

const root = process.env.E2E_TMUX_TMPDIR!
const bin = join(root, 'shim')
const gate = join(root, 'copy-mode-gate')
const metadataGate = join(root, 'metadata-gate')
mkdirSync(metadataGate, { recursive: true })
process.env.AB_METADATA_GATE = metadataGate
process.env.AGENTBOARD_SKIP_MATCHING_PATTERNS = ''
const realTmux = process.env.AB_REAL_TMUX || spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim()
if (!realTmux.startsWith('/')) throw new Error('Expected an absolute tmux executable')
mkdirSync(bin, { recursive: true })
mkdirSync(gate, { recursive: true })
process.env.AB_COPY_MODE_GATE = gate
process.env.AB_REAL_TMUX = realTmux
// Hold exactly one selected pane-mode query. Other commands still reach the
// real private tmux server. The 4s cap also bounds failures in the test runner.
writeFileSync(join(bin, 'tmux'), `#!/bin/sh
mode=0
target=''
prev=''
for arg in "$@"; do
  [ "$arg" = '#{pane_in_mode},#{alternate_on},#{mouse_any_flag}' ] && mode=1
  [ "$prev" = '-t' ] && target="$arg"
  prev="$arg"
done
gate="$AB_COPY_MODE_GATE"
if [ "$mode" = 1 ] && [ -f "$gate/arm" ] && [ "$(cat "$gate/arm")" = "$target" ]; then
  if mv "$gate/arm" "$gate/held" 2>/dev/null; then
    echo "$$" > "$gate/started"
    n=0
    while [ ! -f "$gate/release" ] && [ "$n" -lt 400 ]; do
      sleep 0.01
      n=$((n + 1))
    done
  fi
fi
exec "$AB_REAL_TMUX" "$@"
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.PI_CODING_AGENT_DIR = join(root, 'omp')
process.env.LOG_LEVEL = 'debug'

export default defineConfig({
  ...base,
  testDir: './tests/contention',
  webServer: {
    ...base.webServer as object,
    command: (base.webServer as { command: string }).command.replace(
      'bun src/server/index.ts', 'bun --preload ./tests/contention/metadata-preload.ts src/server/index.ts'),
    reuseExistingServer: false,
  },
  workers: 1,
  retries: 0,
})
