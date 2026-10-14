# launchd User Agents (macOS)

Run agentboard as a persistent launchd user agent that starts at login and restarts on crash. Parallel to [`systemd/`](../systemd/) for Linux.

## Install a published release (default)

Requirements: macOS, tmux, and Node.js 20+ with npm. Node and npm are needed
only for installation and upgrades. The running service uses the compiled binary.
Keep this repository checkout to run future upgrades.

```bash
./launchd/install.sh
# Or choose an exact release:
./launchd/install.sh --release 0.31.0
```

The installer resolves the version once. It downloads the matching Mac platform
package as a required dependency into a new directory under `~/.agentboard/releases/`.
It checks the package identity, executable, HTML, and referenced JavaScript and CSS
files before stopping the current service. If npm has not published the platform
package yet, installation fails and the current service keeps running. npm policies,
including a configured minimum release age, remain in effect. A policy rejection
also leaves the current service running.

The generated plist points to that installed version. Service startup does not
contact npm, resolve `latest`, or depend on this checkout. The installer also sets
up hourly rotation for the application and launchd logs.

## Upgrade

```bash
./launchd/upgrade.sh
# Or select an exact version:
./launchd/upgrade.sh 0.31.0
```

After preparing the release, the installer saves the previous plist, stops the
service, and starts the candidate. It verifies that the launchd process owns the
port and serves the health endpoint, HTML, and frontend assets. Two consecutive
checks must pass with the same process. A failed check restores the previous plist
and starts it again if it was loaded before the upgrade. The previous disabled override
is also restored. If the previous service was already unhealthy or could not be
verified, recovery reports that fact and clears the transaction so another repair
can proceed. A previously healthy service must pass its recovery check. Existing tmux sessions
are not stopped by the installer.

For managed releases, rollback restores the pinned executable and service
configuration. When migrating from a custom or source launcher, it restores that
launcher, whose checkout or npm dependencies can still change independently.
Rollback does **not** undo
database migrations or other application writes. Check release compatibility before
upgrading across incompatible database changes. Keep a data backup for those upgrades.
Old release directories remain on disk; do not remove a directory referenced by a
service plist or an unfinished recovery journal.

## Configure the release service

Put environment overrides in `~/.agentboard/service-env.json` before installation
or an upgrade. Values must be strings. For example:

```json
{
  "PORT": "4040",
  "ALLOW_KILL_EXTERNAL": "true"
}
```

The installer preserves environment variables from the existing plist and applies
these overrides. It sets `HOME`, `NODE_ENV`, and `AGENTBOARD_STATIC_DIR` itself.
The initial release installer supports HTTP on localhost, 127.0.0.1, or 0.0.0.0.
Use source mode for custom TLS or other bind addresses.

When replacing a custom launcher, copy its required environment settings into this
file first. Shell-script exports, including `ALLOW_KILL_EXTERNAL`, cannot be recovered
from the plist automatically. The previous launcher is kept intact for rollback.
The standard label remains `com.agentboard`; source and release modes replace that
same service rather than running two servers.

## Recover an interrupted upgrade

```bash
./launchd/install.sh --release --recover
```

Recovery uses `~/.agentboard/release-pending.json` and does not contact npm.
If the installer was killed or the computer restarted during an upgrade, its lock
can remain at `~/.agentboard/release-install.lock`. Read the PID in that directory.
Verify that the installer is no longer running before removing the lock directory.
Then run recovery. A failed recovery keeps the journal and reports the failure.
A reboot during activation can start the candidate from the new plist; run recovery
to restore the saved configuration before attempting another upgrade.

## Install from source

Requirements: Bun, tmux, and a local checkout with dependencies and frontend assets.

```bash
bun install --frozen-lockfile
bun run build
./launchd/install.sh --source
```

Source mode runs `bun run start` from the checkout. Update and build the checkout
before restarting the service. This mode retains the existing developer workflow;
it does not provide the release upgrade transaction.

Both modes install `com.agentboard` and `com.agentboard.logrotate` in
`~/Library/LaunchAgents/`. launchd starts the service at login and restarts it after
a crash or nonzero exit. The ten-second throttle spaces retries; it cannot repair
a broken installation.

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

Agentboard tracks Hibernating sessions in `~/.agentboard/agentboard.db`, keeps them dormant across restarts, and lets you wake them manually from the UI. But when the tmux server crashes mid-flight, agentboard's process keeps running with stale handles — attached PTYs are dead and the base tmux session does not come back until agentboard restarts. Until then, the UI stays broken.

A small 30-second polling agent that kickstarts agentboard whenever the base session disappears solves this. Opt-in because it's only needed if you've actually seen tmux crash on your machine.

Create the script:

```bash
cat > ~/.agentboard/bin/tmux-agentboard-watchdog.sh << 'EOF'
#!/bin/bash
export PATH="$(dirname "$(command -v tmux)"):/usr/local/bin:/usr/bin:/bin"
SESSION="${TMUX_SESSION:-agentboard}"
STATE_DIR="${AGENTBOARD_STATE_DIR:-$HOME/.agentboard}"
PID_FILE="${AGENTBOARD_TMUX_PID_FILE:-$STATE_DIR/tmux-server.pid}"

remember_server() {
  local pid temp
  pid="$(tmux display-message -p -t "=$SESSION" '#{pid}')" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  mkdir -p "$STATE_DIR"
  temp="$PID_FILE.$$.tmp"
  (umask 077; printf '%s\n' "$pid" > "$temp")
  mv "$temp" "$PID_FILE"
}

if tmux has-session -t "=$SESSION" 2>/dev/null; then
  remember_server
  exit 0
fi

# The server is reachable but only the managed base session is missing.
# Restart Agentboard so ensureSession() recreates it; no socket repair signal
# is needed.
if tmux list-sessions >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.agentboard"
  exit $?
fi

if read -r pid < "$PID_FILE" 2>/dev/null &&
   [[ "$pid" =~ ^[0-9]+$ ]] &&
   kill -0 "$pid" 2>/dev/null &&
   [[ "$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)")" == tmux ]]; then
  kill -USR1 "$pid"
  sleep 0.2
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    remember_server
    exit 0
  fi
  if tmux list-sessions >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.agentboard"
    exit $?
  fi
  echo "Live tmux server $pid did not recreate its socket; refusing to replace it" >&2
  exit 1
fi

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

The watchdog records the tmux server PID while the session is healthy. If the
socket file disappears while that server is still alive, it sends `SIGUSR1` so
tmux recreates the socket. It restarts Agentboard only when the recorded server
is no longer running. This prevents a replacement tmux server from orphaning
live panes behind an unlinked socket. `ensureSession()` applies the same
fail-closed recovery during normal Agentboard refreshes.

Note: if you `tmux kill-session -t agentboard` while agentboard is loaded, the watchdog will restore it within 30s. To stop cleanly, `launchctl unload ~/Library/LaunchAgents/com.agentboard.plist` first.

## Notes

- The plist sets `LANG=en_US.UTF-8`. LaunchAgents start with a bare environment; without this, tmux renders non-ASCII characters as `?` or stripped bytes.
- Source mode changes into the repo directory before `bun run start`. Release mode starts a pinned binary with an absolute frontend asset path.
- Override the log path via the `LOG_FILE` env var (respected by agentboard and the rotate script).
- Override the tmux session name via `TMUX_SESSION` (respected by agentboard and the watchdog).
- Set a distinct `AGENTBOARD_TMUX_PID_FILE` for each Agentboard instance that uses a separate tmux socket.
