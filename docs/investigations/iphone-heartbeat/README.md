# Physical iPhone heartbeat investigation

The PR 439 live trial on Tailscale HTTP logged repeated heartbeat timeouts
around 30 seconds after each new connection. The server process remained up.
At one timeout, another WebSocket message had arrived 16 ms earlier. The
client's last matching pong was absent on several replacement connections.
This establishes a reconnect loop, not its cause. Port 4040 was restored to
0.36.3; no timeout policy has been changed to hide the symptom.

## What is known

| Step | Client | Relay | Unknown |
| --- | --- | --- | --- |
| Connection opens | epoch advances; normal heartbeat starts | terminal attaches successfully | — |
| Heartbeat scheduled | ping sequence advances | original logs have no ping receipt event | whether ping reached relay |
| Other data arrives | lastMessageAgeMs resets | dashboard/terminal can send data | type of last received message |
| Deadline fires | lastPongSeq does not match; socket replaced | process still running | missing reply, parsing/dispatch delay, or timer race |

Local Chromium and WebKit ran the exact compiled `cf7a630` release artifact
for 100 seconds using the application's native WebSockets and real heartbeat
timers, with attached disposable terminals. Neither reconnected; all observed
pings had matching pongs. `compiled-baseline.jsonl` contains cumulative browser
observations. These tests do not reproduce physical Safari suspension or the
phone's VPN/radio path.

## Diagnostic changes

- Debug-level `client_ws_ping_sent` records the client's current sequence and
  socket state after WebSocket.send returns.
- Debug-level `terminal_relay_heartbeat` records sequence, connection ID,
  acceptance into Bun's send path, and buffer sizes. Acceptance is not proof
  of delivery to the browser.
- Debug-level `client_ws_pong_received` records the received sequence and
  whether it matches the pending sequence.
- Failure snapshots include time since ping and last parsed message type.
- Client wall-clock and monotonic timestamps preserve ordering when HTTP log
  requests arrive late or out of order. Compare monotonic times only within
  one client document, not against server timestamps.

No terminal contents, clipboard contents, or lease tokens are added to logs.
Enable with LOG_LEVEL=debug; per-heartbeat events stay disabled at normal info
level. The isolated diagnostic server runs on port 4198 with private tmux,
state, transcript directories, and two disposable shell windows.

## Next physical-device experiment

1. Open the diagnostic URL on the iPhone using the same Tailscale route.
2. Leave Safari visible for two minutes.
3. Switch apps, then return to Safari.
4. Repeat with the installed Home Screen app if the Safari path is stable.
5. Correlate client sequence/time with relay receipt and browser pong handling.

If the relay never receives a sent ping, inspect the uplink and browser socket
send path. If the relay accepts a reply but the client never observes it,
inspect the downstream, frame decoding, and browser dispatch. If a matching
pong is observed before a timeout on the same socket, reproduce and fix the
client timer ownership sequence. Do not infer network failure from a timeout
alone. Only then choose a controlled transport comparison, such as compression
enabled/disabled or Wi-Fi/cellular, holding the other variables constant.

The new native-heartbeat E2E test observes three normal heartbeat intervals
without Playwright WebSocket routing, asserts matching sequences and no socket
replacement, then confirms the terminal still accepts explicit input. It runs
in both Chromium and WebKit. Physical-device reproduction remains required.
