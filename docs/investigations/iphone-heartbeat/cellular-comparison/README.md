# Compiled release versus PR under delayed WebSocket transport

**Result: no PR-only persistent reconnect loop reproduced.** The physical
cellular regression remains unresolved. Do not use these results to clear
PR #439 for merge or replace the stable port-4040 service.

The comparison used the installed 0.36.3 executable and frontend, and the exact
`cf7a630` executable/frontend deployed during the failed phone trial. It did
not substitute the later diagnostic build. Artifact hashes and tool versions
are in [environment.json](environment.json).

## Results

Each row below had the same outcome in both builds and all three browser
configurations: 30 completed runs, representing 15 paired comparisons.

| WebSocket condition | 0.36.3 | PR cf7a630 | Input after observation |
| --- | --- | --- | --- |
| Local baseline | No reconnect; pongs 1,2,3 | No reconnect; pongs 1,2,3 | Delivered in both |
| Latency plus jitter | No reconnect; pongs 1,2,3 | No reconnect; pongs 1,2,3 | Delivered in both |
| Uplink-only long stall | One timeout/reconnect; pongs 2,3 | One timeout/reconnect; pongs 2,3 | Delivered in both |
| Downlink-only long stall | One timeout/reconnect; pongs 2,3 | One timeout/reconnect; pongs 2,3 | Delivered in both |
| Both directions stalled | One timeout/reconnect; pongs 2,3 | One timeout/reconnect; pongs 2,3 | Delivered in both |

No run had a connection-opening timeout. The first pong is absent in the stall
cases because its connection timed out and was replaced. Subsequent sequences
matched on the replacement; neither build continued reconnecting after the
impairment ended.

An uplink-only stall reproduced the partial symptom of a heartbeat timeout
while terminal output still arrived: in desktop WebKit the last-message age
at timeout was 474 ms for the release and 179 ms for the PR. Thus recent
incoming data does not establish that outgoing heartbeat traffic reached the
server. It does not explain why the PR failed on the user's cellular path
while rollback restored stability.

## Setup and scope

- Two independent compiled servers, each with a private tmux socket, database,
  transcript directories, and five disposable terminal windows.
- Native macOS Playwright WebKit. Each case uses a fresh context and the real
  application. Only the WebSocket URL is redirected to a raw TCP proxy; no
  application reply is synthesized or intercepted with routeWebSocket.
- 75 seconds of observation, followed by an explicit marker input and an
  independent tmux capture proving delivery.
- Baseline has no configured delay. Other profiles have 150 ms one-way
  latency and a 32 KiB/s per-direction, per-connection byte budget. Jitter adds
  0–350 ms one-way delay, determined by a fixed time-bucket function rather
  than the builds' different chunk counts.
- Stall profiles hold one or both directions from 18 to 34 seconds after
  that case's first TCP connection. Bytes remain ordered; none are discarded.
- Each terminal prints a short line every 500 ms. This is a low-load transport
  test, not a production catalog/history load or output-flood test.
- The application heartbeat uses its real 20-second interval and 10-second
  deadline. No clocks or timeouts are accelerated.

Browser configurations:

1. Desktop WebKit at a 390×844 viewport: narrow layout, desktop detection.
2. Playwright iPhone 13 identity: logs confirm `isiOS:true`; the runtime still
   reports `platform:MacIntel`, `maxTouchPoints:0`, and WebGL enabled.
3. The same context with JavaScript identifiers and renderer preference
   matching the failing phone log: `platform:iPhone`, `maxTouchPoints:5`,
   `isiOS:true`, `useWebGL:false`. These are emulated identifiers, not an actual
   iPhone or the phone's Safari engine version.

The final iPhone variants also gate writes after destination backpressure,
flush queued bytes before forwarding EOF, and prevent prequeued bytes from
leaking through a stall window. The earlier desktop variant delayed newly
arriving chunks during the window; tiny preexisting queues could still drain.
Each A/B pair used identical proxy behavior. The provided harness includes
these corrections.

HTML, assets, and HTTP telemetry bypass the proxy. There is no actual radio,
Tailscale tunnel, packet retransmission, MTU change, OS suspension, process
freeze, or Home Screen lifecycle transition. The result cannot clear those
paths. A proxy that discards bytes after TCP receipt would corrupt WebSocket
framing rather than model ordinary packet loss; this harness does not do that.
See [TCP's reliable byte-stream model](https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2)
and [browser WebSocket buffering semantics](https://websockets.spec.whatwg.org/#dom-websocket-bufferedamount).

## Harness corrections and excluded attempts

Initial typing checks tried to focus the intentionally disabled mobile
textarea. Serializing focus alone did not fix that. The corrected desktop
harness clicks the existing Show keyboard control before sending text.

The iPhone-identity setup initially selected a hidden duplicate of the session
card. It now waits for session discovery and selects the visible drawer card.
Emulated pointer geometry rejected the offscreen keyboard-button click, and
insertText did not generate printable xterm input in the iOS path. The final
emulated cases dispatch the existing keyboard control's click handler, then
use keydown/keyup typing. This verifies terminal delivery after recovery, not
physical touch geometry or the iOS software keyboard/IME.

Those development attempts are excluded from the 30 completed runs above.
They were harness failures in both builds, not evidence of a PR regression.

## Proof table

| Claim | Impact if false | Evidence | Missing evidence | Status | Next action |
| --- | --- | --- | --- | --- | --- |
| Steady latency/jitter uniquely breaks PR heartbeats | Would reproduce the regression | Native frame traces show matching sequences in both builds | Actual cellular path | Contradicted within tested profiles | Keep physical trial as next discriminator |
| A temporary one-way stall can coexist with recent incoming data | Could misdiagnose an app timer bug | Uplink-stall traces show recent output at timeout in both builds | Whether this occurred on the phone | POC-confirmed | Correlate instrumented phone send/relay/receive records |
| PR gets stuck after a completed stall | Would explain continued reconnects | Every tested replacement receives later pongs and input | OS suspension and larger workloads | Contradicted within tested profiles | Do not change retry policy without new evidence |
| These simulations validate the phone fix | Could ship the regression again | No fix or physical reproduction was established | Phone cellular reproduction | Unresolved | Keep live 4040 on 0.36.3 and PR blocked |

## Evidence and reproduction

[Combined summaries](summary.json), [desktop traces](desktop-webkit/summary.json),
[iPhone-identity traces](iphone-identity/summary.json), and
[phone-settings traces](phone-settings/summary.json) retain every case's native
ping/pong sequence, reconnects, client diagnostics, output-arrival events,
input verification, and network counters. Individual case JSON files live
beside their summary. The sample [recovered terminal](recovered-pr-phone-settings.png)
contains only synthetic fixture output.

To repeat on this machine from the repository root:

```sh
mkdir -p .poc-stress-test/cellular
cp docs/investigations/iphone-heartbeat/cellular-comparison/harness.mjs.txt .poc-stress-test/run.mjs
PROBE_IOS=1 PROBE_PHONE_SETTINGS=1 node .poc-stress-test/run.mjs
```

Update the two artifact paths in `definitions` on another machine. Use a fresh
output directory for each run with `PROBE_OUTPUT_DIR`. Omit the two flags for
desktop WebKit. The harness cleans up its server processes and private tmux
sessions in `finally`; retain the result files, then remove the POC directory.

No production code, runtime version, compression setting, or retry deadline
was changed. The diagnostic server on 4198 remains available for a later
physical-phone trial. Port 4040 was not changed during this comparison.
