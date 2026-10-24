# Output pressure probe

Environment: Bun 1.3.14, macOS ARM64, real private tmux and PTY, production relay implementation. No production sessions or services used. Probe cleanup stops its child and only named sessions on its private socket.

`producer.py` writes numbered 100-character lines in 128-line batches every 10 ms while enabled. `probe.ts` first uses a protocol peer with no output acknowledgments, then one acknowledging every 500 ms, then repeated reconnects while output continues. `manager-probe.ts` repeats the scenario using the production WebSocketManager and native WebSocket, with a thin window/document adapter. This is not a browser rendering benchmark.

| Claim | Strongest evidence | Status | Limitation |
| --- | --- | --- | --- |
| Slow consumer memory at the browser acknowledgment boundary stays bounded | No-ACK connection closed1013 at1,048,537 payload bytes | POC-confirmed | Does not measure whole-process RSS or native PTY buffers |
| Moderate parser delays can recover without reconnection | ACK every500ms sustained2.63MiB over5s without closure | POC-confirmed | One output pattern and local transport |
| Overload recovery retains correct targeting | Stopping output, reconnecting, and typing marker produced exactlyone marker in correct pane | POC-confirmed | Protocol-level screen/input check |
| Original reconnect path backs off after repeated overload | OPEN resets ordinary retry counter; four1013 closes repeated over~12s with1s reconnect pauses | Contradicted | No user/browser renderer involved in baseline peer loop |
| Patched manager bounds repeated overload retry work | Actual manager close→nextOPEN delays1002,2002,4002ms; next8s wait remainedpending at20s stop | POC-confirmed | Native WebSocket + thin DOM adapter; parent validates browserE2E |

The fix keeps a separate capped overload streak for1013 closes. OPEN does not clear it. Absolute cooldown deadlines survive background/foreground events. Verified terminal readiness followed by ACK or matching heartbeat progress over30s clears it, so idle healthy terminals recover without continuous output. Lifecycle changes and detected timer gaps invalidate the stable interval. Ordinary network-close retry behavior stays unchanged.

Focused tests:82 passed across websocketManager/websocketResume. Five new tests exercise escalation/cap, lifecycle deadline preservation, stable ACK recovery, silent suspension exclusion, and quiet-terminal heartbeat recovery. An isolated negative control disabling1013 classification failed three core regressions. Scoped lint and globaltypecheck passed.

Raw files: `results.json` (original protocol behavior), `manager-results.json` (patched production manager), `unit.log`, `negative.log`, `typecheck.log`. Source copies for the negative control were removed after execution.
