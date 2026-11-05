# launchd User Agents (macOS)

Run Agentboard as a launchd user agent. launchd starts it at login and restarts it after a crash. For Linux, see [`systemd/`](../systemd/).

## Install a published release (default)

Requirements: macOS, tmux, [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`),
and Node.js 20+ with npm. Node and npm are needed only for installation and
upgrades. The running service uses the compiled binary. Keep this repository
checkout to run future upgrades.

Agentboard uses `rg` to match agent transcripts to tmux windows. The installer
does not check for it. See [Notes](#notes) for the directories where the
service looks for `rg`.

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
# Equivalent:
./launchd/upgrade.sh --recover
```

Recovery uses `~/.agentboard/release-pending.json` and does not contact npm.
If the installer was killed or the computer restarted during an upgrade, its lock
can remain at `~/.agentboard/release-install.lock`. Read the PID in that directory.
Verify that the installer is no longer running before removing the lock directory.
Then run recovery. A failed recovery keeps the journal and reports the failure.
A reboot during activation can start the candidate from the new plist; run recovery
to restore the saved configuration before attempting another upgrade.

## Install from source

Requirements: Bun, tmux, ripgrep (`rg`), and a local checkout with dependencies
and frontend assets.

```bash
bun install --frozen-lockfile
bun run build
./launchd/install.sh --source
```

Source mode runs `bun run start` from the checkout. Update and build the checkout
before restarting the service. This mode retains the existing developer workflow;
it does not provide the release upgrade transaction.

### Configure the source service

The source service reads environment variables from two places:

- `EnvironmentVariables` in `~/Library/LaunchAgents/com.agentboard.plist`.
- A `.env` or `.env.local` file in the checkout. Bun loads these files when
  the server starts.

The log rotation job and the watchdog read only the plist. They do not read
`.env` or `.env.local`. If you change one of these variables, set it in the
plist, so that the server and both jobs use the same value:

- `TMUX_SESSION`
- `TMUX_TMPDIR`
- `AGENTBOARD_DATA_DIR`
- `AGENTBOARD_TMUX_PID_FILE`
- `LOG_FILE`

1. Set the variable in the plist.

   ```bash
   plutil -replace EnvironmentVariables.TMUX_SESSION -string work \
     ~/Library/LaunchAgents/com.agentboard.plist
   ```

2. Reload the service. `launchctl kickstart` does not read the plist again.

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.agentboard.plist
   launchctl load -w ~/Library/LaunchAgents/com.agentboard.plist
   ```

`./launchd/install.sh --source` writes a new plist without your variables.
Set them again after each source installation.

## Installed jobs

Both modes install `com.agentboard` and `com.agentboard.logrotate` in
`~/Library/LaunchAgents/`. launchd starts the service at login and restarts it after
a crash or nonzero exit. The ten-second throttle spaces retries. It cannot repair
a broken installation.

The log rotation job runs every hour. It rotates a log file when the file
reaches 50 MB, and it keeps five compressed copies. The server keeps its log file
open, so the job copies the file and then truncates it. Lines that the server
writes between the copy and the truncate can be lost.

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
for label in com.agentboard.tmux-watchdog com.agentboard com.agentboard.logrotate; do
  launchctl unload ~/Library/LaunchAgents/$label.plist 2>/dev/null || true
  rm -f ~/Library/LaunchAgents/$label.plist
done
rm -rf ~/.agentboard/bin
# Release mode: remove the installed release binaries.
rm -rf ~/.agentboard/releases
# To also remove data: rm -rf ~/.agentboard
```

Uninstalling does not stop tmux or the agent sessions in it.

## Optional: tmux-crash watchdog

Agentboard checks its tmux session on every refresh. If the session is
missing, Agentboard creates it again. If the tmux server still runs but its
socket file is gone, Agentboard asks tmux to recreate the socket.

The watchdog is a second check that runs outside the Agentboard process.
Every 30 seconds, it looks for the managed tmux session. If the session is
missing, the watchdog restarts Agentboard. Install the watchdog only if
Agentboard did not recover by itself after tmux stopped on your machine.

Install it:

```bash
./launchd/install-watchdog.sh
```

The installer copies [`tmux-watchdog.sh`](tmux-watchdog.sh) to
`~/.agentboard/bin/tmux-agentboard-watchdog.sh` and loads
`~/Library/LaunchAgents/com.agentboard.tmux-watchdog.plist`. launchd starts jobs
with a bare `PATH`, so the plist sets `PATH` to the tmux directory that the
installer found. Run the installer again if tmux moves. If the watchdog cannot
find tmux, it logs an error to `/tmp/agentboard-tmux-watchdog.log` and does not
restart Agentboard.

### Settings

The watchdog uses the same `TMUX_SESSION`, `AGENTBOARD_DATA_DIR`,
`AGENTBOARD_TMUX_PID_FILE`, and `TMUX_TMPDIR` as the service. It reads them from
the `EnvironmentVariables` of `~/Library/LaunchAgents/com.agentboard.plist`
on each run.

- Release mode: set them in `~/.agentboard/service-env.json` and run
  `./launchd/upgrade.sh`. The upgrade rewrites the service plist and restarts
  the service.
- Source mode: set them in the plist. See
  [Configure the source service](#configure-the-source-service).

Use an absolute path for `TMUX_TMPDIR`. If the value is relative, the watchdog
logs an error and does nothing. The watchdog resolves a relative
`AGENTBOARD_DATA_DIR` or `AGENTBOARD_TMUX_PID_FILE` against the working
directory of the service, as the server does.

### What the watchdog does

While the session is healthy, the watchdog records the PID of the tmux server.
When the session is missing, the watchdog does one of these:

| Condition | Action |
| --- | --- |
| The tmux server answers, and only the managed session is missing. | Restarts Agentboard. |
| The recorded tmux server still runs, and `lsof` shows that it holds the service's socket. | Sends `SIGUSR1`, so that tmux recreates the socket file. If the socket does not come back, the watchdog logs an error and does not restart Agentboard. |
| The recorded process is gone, or it is a tmux process that does not hold the service's socket. | Restarts Agentboard. |
| `lsof` reports nothing for the recorded tmux process. | Logs an error. Does not signal the process and does not restart Agentboard. |

The watchdog does not start a replacement tmux server while the recorded one
still runs. A replacement server would leave the live panes unreachable behind
the removed socket.

If you run `tmux kill-session -t agentboard` while the service is loaded,
Agentboard or the watchdog creates the session again. To stop the service
first, run `launchctl unload ~/Library/LaunchAgents/com.agentboard.plist`.

## Notes

- The plist sets `LANG=en_US.UTF-8`. LaunchAgents start with a bare environment. Without this setting, tmux shows non-ASCII characters as `?` or drops them.
- Source mode changes into the repo directory before `bun run start`. Release mode starts a pinned binary with an absolute frontend asset path.
- The service looks for `tmux` and `rg` in the Homebrew directories (`/opt/homebrew/bin`, `/usr/local/bin`), `~/.local/bin`, `~/bin`, `~/.cargo/bin`, and the system directories. If `command -v rg` prints another directory, link the program: `mkdir -p ~/.local/bin && ln -s "$(command -v rg)" ~/.local/bin/rg`.
- To change the log path, set `LOG_FILE` in the service plist (release mode: `service-env.json`). The rotate script reads `LOG_FILE` and `AGENTBOARD_DATA_DIR` from the service plist on each run. It rotates the same file as the server: `LOG_FILE`, else `$AGENTBOARD_DATA_DIR/agentboard.log`, else `~/.agentboard/agentboard.log`. An empty `LOG_FILE` disables file logging, so only the launchd capture logs rotate. Run `~/.agentboard/bin/agentboard-log-rotate.sh --print-paths` to list the files that it rotates.
- To change the tmux session name, set `TMUX_SESSION` in the service plist. Agentboard and the watchdog use it.
- Set a distinct `AGENTBOARD_TMUX_PID_FILE` for each Agentboard instance that uses a separate tmux socket.
