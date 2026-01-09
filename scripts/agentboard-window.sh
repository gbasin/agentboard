#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME=${TMUX_SESSION:-agentboard}
WINDOW_NAME=${1:-$(basename "$PWD")}

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux new-session -d -s "$SESSION_NAME"
fi

tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$PWD" "claude"
