#!/bin/bash
# Start agentboard inside a tmux session for proper TTY support.
# Used by the launchd agent for auto-start on login.

export PATH="/Users/kenneth/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export TLS_CERT="/Users/kenneth/.agentboard/tls-cert.pem"
export TLS_KEY="/Users/kenneth/.agentboard/tls-key.pem"
export DISCOVER_PREFIXES="infra"

# Prevent Claude Code nesting detection in tmux children
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

WORKING_DIR="/Users/kenneth/Desktop/lab/infra/agentboard"

# Ensure the managed "agentboard" tmux session exists
if ! tmux has-session -t agentboard 2>/dev/null; then
    tmux new-session -d -s agentboard
fi

# Ensure the "infra" session exists with the agentboard-server window
if tmux has-session -t infra 2>/dev/null; then
    if ! tmux list-windows -t infra -F '#{window_name}' | grep -q "^agentboard-server$"; then
        tmux new-window -t infra -n agentboard-server -c "$WORKING_DIR"
        tmux send-keys -t infra:agentboard-server "TLS_CERT=$TLS_CERT TLS_KEY=$TLS_KEY DISCOVER_PREFIXES=$DISCOVER_PREFIXES bun run start" Enter
    fi
else
    tmux new-session -d -s infra -n agentboard-server -c "$WORKING_DIR"
    tmux send-keys -t infra:agentboard-server "TLS_CERT=$TLS_CERT TLS_KEY=$TLS_KEY DISCOVER_PREFIXES=$DISCOVER_PREFIXES bun run start" Enter
fi
