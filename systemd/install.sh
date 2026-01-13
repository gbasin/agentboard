#!/bin/bash
# Install agentboard as a systemd user service

set -e

SERVICE_NAME="agentboard.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"

# Find bun executable
BUN_PATH="$(which bun)"
if [ -z "$BUN_PATH" ]; then
    echo "Error: bun not found in PATH"
    exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

# Generate the service file
cat > "$SCRIPT_DIR/$SERVICE_NAME" << EOF
[Unit]
Description=Agentboard - Terminal session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$BUN_PATH run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=$BUN_DIR:$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF

echo "Generated $SERVICE_NAME with:"
echo "  WorkingDirectory: $REPO_DIR"
echo "  Bun: $BUN_PATH"

mkdir -p "$USER_SYSTEMD_DIR"

# Symlink the service file
ln -sf "$SCRIPT_DIR/$SERVICE_NAME" "$USER_SYSTEMD_DIR/$SERVICE_NAME"

# Reload systemd
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo ""
echo "Agentboard service installed and started!"
echo ""
echo "Useful commands:"
echo "  systemctl --user status agentboard   # Check status"
echo "  systemctl --user restart agentboard  # Restart"
echo "  systemctl --user stop agentboard     # Stop"
echo "  journalctl --user -u agentboard -f   # View logs"
