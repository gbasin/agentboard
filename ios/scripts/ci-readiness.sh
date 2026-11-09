#!/bin/bash
# Source from CI orchestration. Retry readiness probes, never test execution.
wait_backend_ready() {
  local backend_pid=$1 timeout=$2
  local deadline=$((SECONDS + timeout)) remaining probe_timeout status=28
  while :; do
    if ! kill -0 "$backend_pid" 2>/dev/null; then
      echo "Backend process $backend_pid exited before tests; inspect archived fixture logs." >&2
      return 1
    fi
    remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then return "$status"; fi
    probe_timeout=$remaining
    if [ "$probe_timeout" -gt 10 ]; then probe_timeout=10; fi
    if curl --max-time "$probe_timeout" -fsS http://127.0.0.1:4151/api/library/health >/dev/null; then
      return 0
    else
      status=$?
    fi
    if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
  done
}
