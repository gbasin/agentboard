#!/bin/bash
# Install the optional tmux-crash watchdog (see README "Optional: tmux-crash watchdog").
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.agentboard/bin"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.agentboard.tmux-watchdog.plist"

# launchd runs the job with a bare PATH, so record where tmux lives now.
TMUX_PATH="$(command -v tmux || true)"
if [ -z "$TMUX_PATH" ]; then
    echo "Error: tmux not found in PATH (brew install tmux)" >&2
    exit 1
fi
TMUX_DIR="$(dirname "$TMUX_PATH")"

xml_escape() {
    printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS"
install -m 755 "$SCRIPT_DIR/tmux-watchdog.sh" "$BIN_DIR/tmux-agentboard-watchdog.sh"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.tmux-watchdog</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$BIN_DIR/tmux-agentboard-watchdog.sh")</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>PATH</key><string>$(xml_escape "$TMUX_DIR:/usr/bin:/bin:/usr/sbin:/sbin")</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/agentboard-tmux-watchdog.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-tmux-watchdog.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "Installed com.agentboard.tmux-watchdog (tmux: $TMUX_PATH)."
