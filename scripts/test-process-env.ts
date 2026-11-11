/** Pin every test child (including Workers and unmocked spawns) to a private tmux server. */
export function testProcessEnv(parent: NodeJS.ProcessEnv, socketRoot: string): NodeJS.ProcessEnv {
  const env = { ...parent, TMUX_TMPDIR: socketRoot }
  delete env.TMUX
  delete env.TMUX_PANE
  return env
}
