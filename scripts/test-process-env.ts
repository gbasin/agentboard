import { join } from 'node:path'

/** Test fixtures must never register PRs with a user's board or GitHub account. */
export function isolatePrStatusEnv(env: NodeJS.ProcessEnv, root: string): void {
  delete env.AGENTBOARD_PR_STATUS_AUTHORITY_URL
  delete env.AGENTBOARD_PR_STATUS_TOKEN
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  env.GH_CONFIG_DIR = join(root, 'gh')
  env.GH_PROMPT_DISABLED = '1'
}

/** Pin every test child (including Workers and unmocked spawns) to a private tmux server. */
export function testProcessEnv(parent: NodeJS.ProcessEnv, socketRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, TMUX_TMPDIR: socketRoot }
  delete env.TMUX
  delete env.TMUX_PANE
  isolatePrStatusEnv(env, socketRoot)
  return env
}
