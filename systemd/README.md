# Systemd User Service

Run agentboard as a persistent systemd user service that starts on boot.

## Prerequisites

- Linux with systemd
- `bun` 1.3.14 or later, available in PATH
- `tmux`, available in PATH
- A local checkout of this repository. The service runs from the checkout, so do not move or delete it after installation.
- `loginctl enable-linger $USER` (allows user services to run without an active session)

## Installation

```bash
# Install dependencies and build the frontend.
# The service serves the UI from dist/client; the install script refuses to
# continue until dist/client/index.html exists.
bun install --frozen-lockfile
bun run build

# Enable lingering for your user (required for service to run after logout)
loginctl enable-linger $USER

# Run the install script
./systemd/install.sh
```

The install script will:
1. Check that `bun`, `tmux`, and the built frontend are present
2. Generate `agentboard.service` with correct paths for your system
3. Install and start the service

Run the script again after updating the checkout to regenerate the unit.

## tmux sessions and service restarts

If no tmux server is running when Agentboard starts, Agentboard starts one.
That tmux server and its panes then run inside the service's control group.
The unit sets `KillMode=process`, so `systemctl --user restart agentboard` and
`systemctl --user stop agentboard` stop only the Agentboard server. The tmux
server and all agent sessions keep running, and the restarted service
reattaches to them. `systemctl --user status agentboard` lists the tmux
processes under the unit, and systemd can log that processes remain after the
unit stopped. This is expected.

The tmux sessions still end when the whole user manager stops, for example at
shutdown, or at logout without lingering.

To verify on your machine:

```bash
systemctl --user show agentboard -p KillMode   # KillMode=process
systemd-cgls --user-unit agentboard.service    # tmux is listed if Agentboard started it
systemctl --user restart agentboard
tmux list-sessions                             # the agentboard session is still listed
```

## Commands

```bash
# Check status
systemctl --user status agentboard

# View logs
journalctl --user -u agentboard -f

# Restart after code changes (run `bun run build` first)
systemctl --user restart agentboard

# Stop the service
systemctl --user stop agentboard

# Disable (won't start on boot)
systemctl --user disable agentboard
```

## Log rotation

Standard output goes to the journal, which journald rotates. The server also
writes `~/.agentboard/agentboard.log` (or `LOG_FILE`, or
`$AGENTBOARD_DATA_DIR/agentboard.log`), and it does not rotate that file.
The server opens the file once in append mode and never reopens it, so use
`copytruncate`. A rename-based rotation leaves the server writing to the
renamed file. `copytruncate` can lose the lines written between the copy and
the truncate.

Run logrotate hourly as a user timer:

```bash
mkdir -p ~/.config/agentboard
cat > ~/.config/agentboard/logrotate.conf << EOF
$HOME/.agentboard/agentboard.log {
    size 50M
    rotate 5
    compress
    missingok
    notifempty
    copytruncate
}
EOF

cat > ~/.config/systemd/user/agentboard-logrotate.service << 'EOF'
[Unit]
Description=Rotate the Agentboard log

[Service]
Type=oneshot
ExecStart=/usr/sbin/logrotate --state %h/.agentboard/logrotate.state %h/.config/agentboard/logrotate.conf
EOF

cat > ~/.config/systemd/user/agentboard-logrotate.timer << 'EOF'
[Unit]
Description=Rotate the Agentboard log hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agentboard-logrotate.timer
```

If you set `LOG_FILE` or `AGENTBOARD_DATA_DIR` for the service, put that path
in `logrotate.conf` instead. Check the logrotate path with `command -v logrotate`.

## Uninstall

```bash
systemctl --user stop agentboard
systemctl --user disable agentboard
rm ~/.config/systemd/user/agentboard.service
# If you installed log rotation:
systemctl --user disable --now agentboard-logrotate.timer
rm -f ~/.config/systemd/user/agentboard-logrotate.{service,timer}
systemctl --user daemon-reload
```

Stopping the service does not stop tmux. To end the agent sessions as well,
close them in tmux.
