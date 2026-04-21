#!/bin/bash
# Install agentboard as a persistent launchd user agent on macOS.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
AGENTBOARD_DIR="$HOME/.agentboard"
BIN_DIR="$AGENTBOARD_DIR/bin"

BUN_PATH="$(which bun)"
if [ -z "$BUN_PATH" ]; then
    echo "Error: bun not found in PATH (brew install oven-sh/bun/bun)"
    exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

TMUX_PATH="$(which tmux)"
if [ -z "$TMUX_PATH" ]; then
    echo "Error: tmux not found in PATH (brew install tmux)"
    exit 1
fi
TMUX_DIR="$(dirname "$TMUX_PATH")"

# Guard against paths containing characters that would corrupt plist XML or
# break shell quoting in the generated scripts. The LaunchAgent plist is XML,
# so angle brackets, ampersands, and quotes in any substituted path would
# produce invalid plists that fail `plutil -lint`.
for var in HOME REPO_DIR BUN_PATH TMUX_PATH; do
    case "${!var}" in
        *[\<\>\&\"\']*)
            echo "Error: \$$var contains characters unsafe for plist XML: ${!var}"
            exit 1 ;;
    esac
done

mkdir -p "$LAUNCH_AGENTS" "$BIN_DIR"

echo "Installing agentboard LaunchAgents with:"
echo "  Repo:  $REPO_DIR"
echo "  Bun:   $BUN_PATH"
echo "  Tmux:  $TMUX_PATH"
echo ""

# --- Wrapper script: sets PATH + UTF-8 locale, then execs bun run start.
# LaunchAgents start with a bare env; without LANG set, tmux mangles unicode.
# PATH covers common agent install locations (~/.local/bin for tools like
# claude and cursor-agent, Homebrew, ~/.cargo/bin, ~/go/bin) so that tmux
# windows spawned by agentboard can find whichever CLI the user launches.
cat > "$BIN_DIR/agentboard-run.sh" << EOF
#!/bin/bash
export PATH="$BUN_DIR:$TMUX_DIR:$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/go/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="$HOME"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
cd "$REPO_DIR"
exec "$BUN_PATH" run start
EOF
chmod +x "$BIN_DIR/agentboard-run.sh"

# --- Logrotate script: copytruncate pattern so pino's open fd stays valid.
cat > "$BIN_DIR/agentboard-log-rotate.sh" << 'EOF'
#!/bin/bash
set -u
LOG="${LOG_FILE:-$HOME/.agentboard/agentboard.log}"
MAX_BYTES=$((50 * 1024 * 1024))
KEEP=5

[ -f "$LOG" ] || exit 0
SIZE=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
[ "$SIZE" -ge "$MAX_BYTES" ] || exit 0

rm -f "$LOG.$KEEP.gz"
for i in $(seq $((KEEP - 1)) -1 1); do
    [ -f "$LOG.$i.gz" ] && mv "$LOG.$i.gz" "$LOG.$((i+1)).gz"
done

cp "$LOG" "$LOG.1"
: > "$LOG"
gzip -f "$LOG.1"
EOF
chmod +x "$BIN_DIR/agentboard-log-rotate.sh"

# --- Main service plist.
cat > "$LAUNCH_AGENTS/com.agentboard.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-run.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key><true/>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
    <key>LC_CTYPE</key><string>en_US.UTF-8</string>
  </dict>
  <key>StandardOutPath</key><string>$AGENTBOARD_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$AGENTBOARD_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

# --- Logrotate plist.
cat > "$LAUNCH_AGENTS/com.agentboard.logrotate.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.logrotate</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-log-rotate.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/agentboard-logrotate.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-logrotate.log</string>
</dict>
</plist>
EOF

# --- Load (idempotent: unload first if already loaded).
for label in com.agentboard com.agentboard.logrotate; do
    launchctl unload "$LAUNCH_AGENTS/$label.plist" 2>/dev/null || true
    launchctl load -w "$LAUNCH_AGENTS/$label.plist"
done

echo "Agentboard LaunchAgents installed and loaded."
echo ""
echo "Useful commands:"
echo "  launchctl list | grep agentboard                              # Status"
echo "  tail -f ~/.agentboard/agentboard.log                          # Logs"
echo "  launchctl kickstart -k gui/\$(id -u)/com.agentboard            # Restart"
echo "  launchctl unload ~/Library/LaunchAgents/com.agentboard.plist  # Stop"
echo ""
echo "See launchd/README.md for optional tmux-crash watchdog."
