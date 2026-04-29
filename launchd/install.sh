#!/bin/bash
# Install agentboard as a persistent launchd user agent on macOS.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
AGENTBOARD_DIR="$HOME/.agentboard"
BIN_DIR="$AGENTBOARD_DIR/bin"

BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
    echo "Error: bun not found in PATH (brew install oven-sh/bun/bun)"
    exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

TMUX_PATH="$(command -v tmux || true)"
if [ -z "$TMUX_PATH" ]; then
    echo "Error: tmux not found in PATH (brew install tmux)"
    exit 1
fi
TMUX_DIR="$(dirname "$TMUX_PATH")"

# Guard against paths containing characters that would corrupt plist XML or
# allow shell re-evaluation inside the generated wrapper. The generated scripts
# embed these paths inside double-quoted shell strings, so shell metachars
# (especially $, `, \) could trigger command substitution at service launch
# even if the user's path only looked unusual (e.g. a repo cloned under
# /tmp/foo$(bar)). Reject up front instead of trying to escape correctly.
for var in HOME REPO_DIR BUN_PATH TMUX_PATH; do
    case "${!var}" in
        *[\<\>\&\"\'\$\`\\\;\|\(\)]*)
            echo "Error: \$$var contains characters unsafe for plist XML or shell: ${!var}"
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
export NODE_ENV=production
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
cd "$REPO_DIR"
exec "$BUN_PATH" run start
EOF
chmod +x "$BIN_DIR/agentboard-run.sh"

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

# --- Main service plist.
cat > "$LAUNCH_AGENTS/com.agentboard.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-run.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
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
    <key>LOG_DIR</key><string>$AGENTBOARD_DIR</string>
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
