# Systemd User Service

Run agentboard as a persistent systemd user service that starts on boot.

## Prerequisites

- Linux with systemd
- `bun` 1.3.14 or later, available in PATH
- `tmux`
- A local checkout of this repository. The service runs from the checkout, so do not move or delete it after installation.
- `loginctl enable-linger $USER` (allows user services to run without an active session)

## Installation

```bash
# Install dependencies and build the frontend.
# The service serves the UI from dist/client; without this step the UI does not load.
bun install --frozen-lockfile
bun run build

# Enable lingering for your user (required for service to run after logout)
loginctl enable-linger $USER

# Run the install script
./systemd/install.sh
```

The install script will:
1. Detect your bun installation path
2. Generate `agentboard.service` with correct paths for your system
3. Install and start the service

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

## Uninstall

```bash
systemctl --user stop agentboard
systemctl --user disable agentboard
rm ~/.config/systemd/user/agentboard.service
systemctl --user daemon-reload
```
