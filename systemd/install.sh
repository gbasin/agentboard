#!/bin/bash
# Install agentboard as a systemd user service

set -e

SERVICE_NAME="agentboard.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"

# `|| true` keeps `set -e` from exiting before the error message prints.
BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
    echo "Error: bun not found in PATH" >&2
    exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

TMUX_PATH="$(command -v tmux || true)"
if [ -z "$TMUX_PATH" ]; then
    echo "Error: tmux not found in PATH (install it with your package manager)" >&2
    exit 1
fi
TMUX_DIR="$(dirname "$TMUX_PATH")"

# The service serves the UI from dist/client. Without a build, the backend
# starts but the browser gets no UI.
if [ ! -f "$REPO_DIR/dist/client/index.html" ]; then
    echo "Error: $REPO_DIR/dist/client/index.html not found." >&2
    echo "Build the frontend first: (cd \"$REPO_DIR\" && bun install --frozen-lockfile && bun run build)" >&2
    exit 1
fi

# The unit embeds these paths. systemd expands % specifiers everywhere and $
# variables in ExecStart, and " or \ would end the quoting. Reject them up
# front instead of trying to escape each context correctly.
for var in HOME REPO_DIR BUN_PATH TMUX_PATH; do
    case "${!var}" in
        *[%\$\"\\]* | *$'\n'*)
            echo "Error: \$$var contains a character that is unsafe in a systemd unit (% \$ \" \\ or newline): ${!var}" >&2
            exit 1 ;;
    esac
done

# Was the service already running (from a previous install)?
WAS_ACTIVE=0
if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then WAS_ACTIVE=1; fi

# Generate the service file.
#
# KillMode=process: when no tmux server is running, Agentboard starts one
# (`tmux new-session -d`). The tmux daemon double-forks but stays in this
# service's cgroup, and so do all of its panes. The default KillMode
# (control-group) would kill tmux and every agent session on restart or stop.
# With KillMode=process, systemd signals only the main process, so ExecStart
# runs the server directly (not `bun run start`, which adds a parent process
# that would be the only one to receive the stop-timeout SIGKILL).
cat > "$SCRIPT_DIR/$SERVICE_NAME" << EOF
[Unit]
Description=Agentboard - Terminal session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart="$BUN_PATH" src/server/index.ts
KillMode=process
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment="PATH=$BUN_DIR:$TMUX_DIR:$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=default.target
EOF

echo "Generated $SERVICE_NAME with:"
echo "  WorkingDirectory: $REPO_DIR"
echo "  Bun: $BUN_PATH"
echo "  Tmux: $TMUX_PATH"

mkdir -p "$USER_SYSTEMD_DIR"

# Symlink the service file
ln -sf "$SCRIPT_DIR/$SERVICE_NAME" "$USER_SYSTEMD_DIR/$SERVICE_NAME"

# Reload systemd
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo ""
if [ "$WAS_ACTIVE" = 1 ]; then
    # `start` does nothing for a running service, so the old process keeps
    # running under the previous unit until it is restarted.
    echo "Agentboard service updated. It is still running the previous unit."
    echo "Apply the new unit: systemctl --user restart agentboard"
else
    echo "Agentboard service installed and started!"
fi
echo ""
echo "Useful commands:"
echo "  systemctl --user status agentboard   # Check status"
echo "  systemctl --user restart agentboard  # Restart"
echo "  systemctl --user stop agentboard     # Stop"
echo "  journalctl --user -u agentboard -f   # View logs"
