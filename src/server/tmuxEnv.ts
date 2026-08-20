// Env hygiene for spawned tmux clients.
//
// agentboard's launch chain injects env vars the user never exported:
// bin/agentboard forces NODE_ENV=production (the compiled binary's logger
// needs it), npx adds the npm_* family, and the launcher adds
// AGENTBOARD_STATIC_DIR. If a tmux client we spawn is the one that boots the
// tmux server daemon, the daemon captures that environment as its global
// environment permanently — and every pane created afterwards (i.e. every
// agent shell) inherits it. An ambient NODE_ENV=production breaks test
// runners and React's dev-only `act`, npm_* confuses nested package-manager
// runs, and a leaked AGENTBOARD_STATIC_DIR makes locally-started dev servers
// silently serve the published client bundle.
//
// Stripping these from every tmux client we spawn keeps a daemon we boot as
// clean as one the user boots from their own terminal. Vars the user really
// exports still reach panes: interactive pane shells re-source dotfiles, and
// everything outside this denylist passes through untouched.

export function isLeakedLaunchEnvVar(name: string): boolean {
  return (
    name === 'NODE_ENV' ||
    name === 'AGENTBOARD_STATIC_DIR' ||
    name.startsWith('npm_')
  )
}

export function sanitizedTmuxEnv(
  source: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isLeakedLaunchEnvVar(key)) continue
    env[key] = value
  }
  return env
}
