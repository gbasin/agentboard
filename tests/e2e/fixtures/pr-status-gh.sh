#!/bin/sh
# Resemble `gh api --include` without contacting GitHub, even on bad arguments.
root=${E2E_TMUX_TMPDIR:?}
printf '%s\n' "$*" >> "$root/gh-calls"
case "$*" in
  'api --hostname github.com --include --method GET repos/e2e/shared-pr-status/pulls?'*)
    printf 'HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n'
    cat "$root/gh-response.json"
    ;;
  *)
    exit 2
    ;;
esac
