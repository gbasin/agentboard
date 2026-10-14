#!/bin/bash
# Shared log rotation setup for source and release installations.
set -euo pipefail
AGENTBOARD_DIR="$HOME/.agentboard"
BIN_DIR="$AGENTBOARD_DIR/bin"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS"
# --- Logrotate script: copytruncate pattern so pino's open fd stays valid.
# Rotates agentboard.log (pino output) plus the launchd stdout/stderr capture
# files — without this, KeepAlive crash-loops can fill $HOME with the launchd
# capture logs while pino's rotation only ever touched agentboard.log.
cat > "$BIN_DIR/agentboard-log-rotate.sh" << 'EOF'
#!/bin/bash
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
LOG_DIR="${LOG_DIR:-$HOME/.agentboard}"
MAX_BYTES=$((50 * 1024 * 1024))
KEEP=5

rotate_if_large() {
    local log="$1"
    [ -f "$log" ] || return 0
    local size
    size=$(stat -f%z "$log" 2>/dev/null || echo 0)
    [ "$size" -ge "$MAX_BYTES" ] || return 0

    rm -f "$log.$KEEP.gz"
    for i in $(seq $((KEEP - 1)) -1 1); do
        [ -f "$log.$i.gz" ] && mv "$log.$i.gz" "$log.$((i+1)).gz"
    done

    cp "$log" "$log.1"
    : > "$log"
    gzip -f "$log.1"
}

# Rotate pino output and the launchd stdout/stderr captures.
rotate_if_large "$LOG_DIR/agentboard.log"
rotate_if_large "$LOG_DIR/launchd.out.log"
rotate_if_large "$LOG_DIR/launchd.err.log"
EOF
chmod +x "$BIN_DIR/agentboard-log-rotate.sh"

# Encode paths for plist XML (shell paths above remain unchanged).
xml_escape() {
    printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
XML_BIN_DIR="$(xml_escape "$BIN_DIR")"
XML_HOME="$(xml_escape "$HOME")"
XML_AGENTBOARD_DIR="$(xml_escape "$AGENTBOARD_DIR")"

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
    <key>LOG_DIR</key><string>$XML_AGENTBOARD_DIR</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/agentboard-logrotate.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-logrotate.log</string>
</dict>
</plist>
EOF

launchctl unload "$LAUNCH_AGENTS/com.agentboard.logrotate.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENTS/com.agentboard.logrotate.plist"
