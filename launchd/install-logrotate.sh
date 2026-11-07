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
SCRIPT="$BIN_DIR/agentboard-log-rotate.sh"
PLIST="$LAUNCH_AGENTS/com.agentboard.logrotate.plist"

# Stage both files, check the plist, then move them into place. A failure
# before the moves leaves an existing installation untouched.
STAGED_SCRIPT="$(mktemp "$SCRIPT.XXXXXX")"
STAGED_PLIST="$(mktemp "$PLIST.XXXXXX")"
trap 'rm -f "$STAGED_SCRIPT" "$STAGED_PLIST"' EXIT
install -m 755 "$SCRIPT_DIR/agentboard-log-rotate.sh" "$STAGED_SCRIPT"

# Encode paths for plist XML (shell paths above remain unchanged).
xml_escape() {
    printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
XML_BIN_DIR="$(xml_escape "$BIN_DIR")"
XML_HOME="$(xml_escape "$HOME")"

# --- Logrotate plist.
cat > "$STAGED_PLIST" << EOF
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
chmod 644 "$STAGED_PLIST"
if ! plutil -lint "$STAGED_PLIST" >/dev/null; then
    echo "Error: the generated log rotation plist is not valid. Nothing was installed or changed." >&2
    exit 1
fi

mv -f "$STAGED_SCRIPT" "$SCRIPT"
mv -f "$STAGED_PLIST" "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl load -w "$PLIST"; then
    echo "Error: launchctl could not load $PLIST." >&2
    echo "The log rotation script and plist are installed, but the job is not loaded." >&2
    echo "Correct the problem, then run: launchctl load -w \"$PLIST\"" >&2
    exit 1
fi
