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
SCRIPT="$BIN_DIR/tmux-agentboard-watchdog.sh"

# Stage both files, check the plist, then move them into place. A failure
# before the moves leaves an existing installation untouched.
STAGED_SCRIPT="$(mktemp "$SCRIPT.XXXXXX")"
STAGED_PLIST="$(mktemp "$PLIST.XXXXXX")"
trap 'rm -f "$STAGED_SCRIPT" "$STAGED_PLIST"' EXIT
install -m 755 "$SCRIPT_DIR/tmux-watchdog.sh" "$STAGED_SCRIPT"

cat > "$STAGED_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.tmux-watchdog</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$SCRIPT")</string></array>
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
chmod 644 "$STAGED_PLIST"
if ! plutil -lint "$STAGED_PLIST" >/dev/null; then
    echo "Error: the generated plist is not valid. Nothing was installed or changed." >&2
    exit 1
fi

mv -f "$STAGED_SCRIPT" "$SCRIPT"
mv -f "$STAGED_PLIST" "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl load -w "$PLIST"; then
    echo "Error: launchctl could not load $PLIST." >&2
    echo "The watchdog script and plist are installed, but the job is not loaded." >&2
    echo "Correct the problem, then run: launchctl load -w \"$PLIST\"" >&2
    exit 1
fi
echo "Installed com.agentboard.tmux-watchdog (tmux: $TMUX_PATH)."
