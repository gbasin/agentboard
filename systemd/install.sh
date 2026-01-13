#!/bin/bash
# Install agentboard as a systemd user service

set -e

SERVICE_NAME="agentboard.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$USER_SYSTEMD_DIR"

# Symlink the service file
ln -sf "$SCRIPT_DIR/$SERVICE_NAME" "$USER_SYSTEMD_DIR/$SERVICE_NAME"

# Reload systemd
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo "Agentboard service installed and started!"
echo ""
echo "Useful commands:"
echo "  systemctl --user status agentboard   # Check status"
echo "  systemctl --user restart agentboard  # Restart"
echo "  systemctl --user stop agentboard     # Stop"
echo "  journalctl --user -u agentboard -f   # View logs"
