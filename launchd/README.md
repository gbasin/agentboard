# launchd User Agents (macOS)

Run agentboard as a persistent launchd user agent that starts at login and restarts on crash. Parallel to [`systemd/`](../systemd/) for Linux.

## Prerequisites

- macOS
- `bun` in PATH (`brew install oven-sh/bun/bun`)
- `tmux` in PATH (`brew install tmux`)
- Repository cloned locally (service runs `bun run start` from the repo directory)

## Installation

```bash
./launchd/install.sh
```

The install script will:
1. Detect `bun` and `tmux` paths
2. Generate a wrapper script and a log-rotate script in `~/.agentboard/bin/`
3. Generate two plists in `~/Library/LaunchAgents/`
4. Load them via `launchctl`

Installs two agents:

- **`com.agentboard`** — supervises agentboard. `KeepAlive` respawns on crash or non-zero exit, `ThrottleInterval: 10` prevents tight restart loops.
- **`com.agentboard.logrotate`** — hourly. Rotates `agentboard.log`, `launchd.out.log`, and `launchd.err.log` under `~/.agentboard/` at 50MB each using a copytruncate pattern (preserves pino's open file descriptor), keeps 5 gzipped archives per file.

After install, agentboard listens on `http://localhost:4040`.

## Commands

```bash
# Status
launchctl list | grep agentboard

# Tail logs (structured JSON, same as in systemd setups)
tail -f ~/.agentboard/agentboard.log

# Launchd stdout/stderr (captures startup errors)
tail ~/.agentboard/launchd.{out,err}.log

# Force restart
launchctl kickstart -k gui/$(id -u)/com.agentboard

# Stop (e.g. before running `bun run dev` against port 4040)
launchctl unload ~/Library/LaunchAgents/com.agentboard.plist

# Re-enable
launchctl load -w ~/Library/LaunchAgents/com.agentboard.plist

# Manual log rotation (no-op below 50MB)
~/.agentboard/bin/agentboard-log-rotate.sh
```

## Uninstall

```bash
for label in com.agentboard com.agentboard.logrotate; do
  launchctl unload ~/Library/LaunchAgents/$label.plist 2>/dev/null || true
  rm -f ~/Library/LaunchAgents/$label.plist
done
rm -rf ~/.agentboard/bin
# To also remove data: rm -rf ~/.agentboard
```

## Optional: tmux-crash watchdog

Agentboard resurrects starred sessions at startup from `~/.agentboard/agentboard.db`. But when the tmux server crashes mid-flight, agentboard's process keeps running with stale handles — attached PTYs are dead and starred windows don't come back (the backend poller deliberately won't recreate the session to avoid orphan shells). Until agentboard is restarted, the UI stays broken.

A small 30-second polling agent that kickstarts agentboard whenever the base session disappears solves this. Opt-in because it's only needed if you've actually seen tmux crash on your machine.

Create the script:

```bash
cat > ~/.agentboard/bin/tmux-agentboard-watchdog.sh << 'EOF'
#!/bin/bash
export PATH="$(dirname "$(command -v tmux)"):/usr/local/bin:/usr/bin:/bin"
SESSION="${TMUX_SESSION:-agentboard}"
tmux has-session -t "$SESSION" 2>/dev/null || \
  launchctl kickstart -k "gui/$(id -u)/com.agentboard"
EOF
chmod +x ~/.agentboard/bin/tmux-agentboard-watchdog.sh
```

Create the plist:

```bash
cat > ~/Library/LaunchAgents/com.agentboard.tmux-watchdog.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.tmux-watchdog</string>
  <key>ProgramArguments</key>
  <array><string>$HOME/.agentboard/bin/tmux-agentboard-watchdog.sh</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/agentboard-tmux-watchdog.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-tmux-watchdog.log</string>
</dict>
</plist>
EOF
launchctl load -w ~/Library/LaunchAgents/com.agentboard.tmux-watchdog.plist
```

The watchdog checks `tmux has-session -t agentboard` every 30s. If the session is gone (server crashed, or session killed), it runs `launchctl kickstart -k gui/$(id -u)/com.agentboard` which triggers agentboard's startup path — `ensureSession()` recreates the base session and `resurrectStarredSessions()` rebuilds starred windows from SQLite.

Note: if you `tmux kill-session -t agentboard` while agentboard is loaded, the watchdog will restore it within 30s. To stop cleanly, `launchctl unload ~/Library/LaunchAgents/com.agentboard.plist` first.

## Notes

- The plist sets `LANG=en_US.UTF-8`. LaunchAgents start with a bare environment; without this, tmux renders non-ASCII characters as `?` or stripped bytes.
- The wrapper script `cd`s into the repo directory before `bun run start`, matching the Linux systemd setup.
- Override the log path via the `LOG_FILE` env var (respected by agentboard and the rotate script).
- Override the tmux session name via `TMUX_SESSION` (respected by agentboard and the watchdog).
