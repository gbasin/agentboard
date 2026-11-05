# Systemd User Service

Run Agentboard as a systemd user service that starts at boot. For macOS, see [`launchd/`](../launchd/).

## Prerequisites

- Linux with systemd.
- `bun` 1.3.14 or later, in your `PATH`.
- `tmux`, in your `PATH`.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`). Agentboard uses it to match agent transcripts to tmux windows. The install script does not check for it. See [Where the service finds programs](#where-the-service-finds-programs).
- A local checkout of this repository. The service runs from the checkout, so do not move or delete it after installation.
- Lingering for your user (`loginctl enable-linger $USER`). Lingering lets user services run without an active login session.

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

The install script does these steps:

1. Checks that `bun`, `tmux`, and the built frontend are present.
2. Generates `agentboard.service` with the paths for your system.
3. Installs and starts the service.

Run the script again after you update the checkout. The script generates the unit again.

### Where the service finds programs

The unit sets `PATH` to these directories: the directories that hold `bun` and
`tmux` at installation, `~/.local/bin`, `~/bin`, `/usr/local/bin`,
`/usr/local/sbin`, `/usr/sbin`, `/usr/bin`, `/sbin`, and `/bin`. A package
manager installs `rg` in `/usr/bin`, which is in that list.

If `command -v rg` prints a directory that is not in the list, link the program:

```bash
mkdir -p ~/.local/bin
ln -s "$(command -v rg)" ~/.local/bin/rg
```

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

### Upgrade from an earlier unit

Earlier versions of the unit had no `KillMode` setting and started the server
through `bun run start`. To move to the current unit:

1. Run `./systemd/install.sh` again. The service keeps running under the
   previous unit.
2. Run `systemctl --user restart agentboard`. The restart stops the old
   server and starts the new unit. The tmux sessions keep running.

If the service then fails to start with a `port_in_use` or instance-lock
error, the old server is still running. This can happen when the old server
does not stop within the stop timeout. Find the process that holds the port
and stop it. The service starts on its next retry.

```bash
ss -ltnp 'sport = :4040'   # shows the PID that holds the port
kill <pid>
```

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

To run logrotate every hour as a user timer:

1. Install logrotate with your package manager.
2. Confirm that this command prints a path. The unit in step 4 uses that path.

   ```bash
   command -v logrotate
   ```

3. Write the logrotate configuration. If you set `LOG_FILE` or
   `AGENTBOARD_DATA_DIR` for the service, replace the first line with the path
   of that log file.

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
   ```

4. Write the service and the timer.

   ```bash
   cat > ~/.config/systemd/user/agentboard-logrotate.service << EOF
   [Unit]
   Description=Rotate the Agentboard log

   [Service]
   Type=oneshot
   ExecStart=$(command -v logrotate) --state %h/.agentboard/logrotate.state %h/.config/agentboard/logrotate.conf
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
   ```

5. Enable the timer.

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now agentboard-logrotate.timer
   ```

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
