# Systemd User Service

Run agentboard as a persistent systemd user service that starts on boot.

## Prerequisites

- Linux with systemd
- `bun` installed and available in PATH
- `loginctl enable-linger $USER` (allows user services to run without an active session)

## Installation

```bash
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

# Restart after code changes
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
