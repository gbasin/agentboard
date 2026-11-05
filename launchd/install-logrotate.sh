#!/bin/bash
# Shared log rotation setup for source and release installations.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTBOARD_DIR="$HOME/.agentboard"
BIN_DIR="$AGENTBOARD_DIR/bin"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS"
# --- Logrotate script (copytruncate, so the server's open fd stays valid).
# Rotates the server log at the path the service uses (LOG_FILE /
# AGENTBOARD_DATA_DIR from the service plist) plus the launchd stdout/stderr
# capture files; KeepAlive crash-loops can otherwise fill $HOME with them.
install -m 755 "$SCRIPT_DIR/agentboard-log-rotate.sh" "$BIN_DIR/agentboard-log-rotate.sh"

# Encode paths for plist XML (shell paths above remain unchanged).
xml_escape() {
    printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
XML_BIN_DIR="$(xml_escape "$BIN_DIR")"
XML_HOME="$(xml_escape "$HOME")"

# --- Logrotate plist.
cat > "$LAUNCH_AGENTS/com.agentboard.logrotate.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.logrotate</string>
  <key>ProgramArguments</key>
  <array><string>$XML_BIN_DIR/agentboard-log-rotate.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$XML_HOME</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/agentboard-logrotate.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-logrotate.log</string>
</dict>
</plist>
EOF

launchctl unload "$LAUNCH_AGENTS/com.agentboard.logrotate.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENTS/com.agentboard.logrotate.plist"
