# Production-sized catalog and heartbeat experiment

**Large metadata bursts reproduce repeated heartbeat timeouts in both builds.**
Reducing metadata size eliminates those timeouts under the same update schedule
and transport limits. This confirms a shared payload-related failure mode; it
still does not explain why the physical iPhone regressed only after PR #439.
Keep the PR's live-trial blocker and the stable port-4040 release in place.

## Results

Real compiled 0.36.3 and failed-trial cf7a630 binaries/frontends were used.
Artifact provenance is in the sibling
[cellular comparison](../cellular-comparison/environment.json).

| Condition | 0.36.3 | PR cf7a630 |
| --- | --- | --- |
| Large catalog, 128 KiB/s, 80 seconds | 0 timeouts; pongs 1–4 | 0 timeouts; pongs 1–4 |
| Large catalog, 256 KiB/s, 80 seconds | 0 timeouts; pongs 1–4 | 0 timeouts; pongs 1–4 |
| Large catalog, six updates, 128 KiB/s, 100 seconds | 2 timeouts; 3 connections; pong 3 | 2 timeouts; 3 connections; pong 3 |
| Small catalog, same six updates and rate, 100 seconds | 0 timeouts; pongs 1–5 | 0 timeouts; pongs 1–5 |

A second large-burst A/B with server-side TCP frame observation reproduced the
same two timeouts and recovery in both builds (10 completed runs total). Its
`serverFrames` records show ~1.35 MB `agent-sessions-active` updates queued
ahead of later traffic. The observer itself is downstream of server/kernel
buffering and source backpressure: its timestamps are not server send times.
It did not observe pongs 1 or 2 before those connections closed, so it cannot
distinguish delayed pong generation from a pong queued beyond the bytes read.
The size-reduction control establishes payload sensitivity; exact server pong
handling during congestion remains uninstrumented in these shipped binaries.

Every listed run ended with explicit terminal input independently verified in
its private tmux pane. The large-burst runs recovered after updates stopped.
The reduction control kept 23 windows and the same terminal output, browser
settings, heartbeat policy, transport rate, and update schedule.

## Fixture and transport

Read-only production measurements established the target: 23 active sessions,
a 1,359,316-byte HTTP catalog, and a largest session of about 929 KB containing
2,366 media descriptors (919,628 bytes). These are metadata records, not inline
image data. No real user messages, media, or database were copied.

The fixture creates real synthetic transcript files, database associations,
and 23 private tmux windows for each compiled server. The server's actual
extractor and registry produce the payload. Both servers must report all
23 hydrated media lists before browser testing starts. Recorded catalog sizes
are about 1.366 MB; the small control is about 40 KB. The first window has
2,366 media entries in the large fixture and one in the small fixture.

The initial WebSocket sends both `sessions` (about 1.37 MB) and `agent-sessions`
(about 1.35 MB). Thus the HTTP catalog size understates initial socket traffic.
The burst uses six real `session-rename` commands through a separate control
socket, at approximately 15, 20, 25, 30, 35, and 40 seconds. The application
produces its normal broadcasts; the harness does not fabricate responses.
This is a controlled metadata-update workload, not a claim that production
renames sessions at this frequency.

Playwright WebKit uses iPhone 13 emulation, `navigator.platform = iPhone`, five
touch points, and the user's recorded WebGL-disabled setting. It is desktop
WebKit with an iPhone identity, not physical iOS Safari or an OS suspension test.
Only WebSocket traffic passes through the TCP proxy. HTTP assets and client logs
remain local. Each direction has a 150 ms latency and a per-connection rate
limit of 128 or 256 KiB/s. Bytes remain ordered. The proxy pauses its source
above 1 MiB queued and resumes below 512 KiB; it does not discard bytes or kill
connections at an artificial queue cap. Kernel buffering remains possible.
The application uses the unchanged 20-second ping and 10-second deadline.

## Interpretation and limits

| Claim | Evidence | Status / next action |
| --- | --- | --- |
| Production-sized metadata can cause repeated heartbeat reconnects | Large-burst A/B and small-payload control | POC-confirmed for this workload |
| A large initial snapshot alone causes the observed loop | Both tested rates passed without bursts | Contradicted for these rates; not universal |
| Moving terminal work to a relay isolates it from metadata congestion | Both message classes still share the client socket; PR fails the large-burst case | Contradicted as a network-isolation claim |
| This explains the PR-only physical-phone regression | Stable release fails the synthetic burst too | Unresolved; retain live-trial blocker |
| Production CPU or tmux count is the cause | Same 23-window workload passes with small metadata | Not established; no full DB/CPU load replay |

The next design change should reduce traffic on the interactive path: send
lightweight session summaries, fetch media on demand, avoid resending unchanged
media on ordinary status/name updates, and coalesce replaceable metadata for
slow clients. A dedicated terminal/control socket is a separate option for
network isolation; moving work into a worker alone does not provide it.
Do not treat a longer heartbeat timeout as the root-cause fix.

Before changing the protocol, preserve compatibility for media browsing and
reconnecting clients, and use this fixture as a regression acceptance case.
The shared weakness can be fixed independently of resolving the PR-specific
phone incident. This experiment does not clear that incident.

## Reproduction and evidence

Copy `harness.mjs.txt` to `.poc-stress-test/run.mjs` and `seed.ts.txt` to
`.poc-stress-test/seed/seed.ts` at this worktree's root. Install dependencies.
The seed imports repository database/extractor code; the served application
always comes from the installed compiled artifacts. See `seed-notes.md`.

Run with a fresh output directory each time:

```sh
PROBE_OUTPUT_DIR=.poc-stress-test/snapshot PROBE_PROFILES=rate128,rate256 PROBE_DURATION_MS=80000 PROBE_IOS=1 PROBE_PHONE_SETTINGS=1 node .poc-stress-test/run.mjs
PROBE_OUTPUT_DIR=.poc-stress-test/bursts PROBE_PROFILES=rate128 PROBE_DURATION_MS=100000 PROBE_IOS=1 PROBE_PHONE_SETTINGS=1 PROBE_BURST=1 node .poc-stress-test/run.mjs
PROBE_OUTPUT_DIR=.poc-stress-test/small-bursts PROBE_PROFILES=rate128 PROBE_DURATION_MS=100000 PROBE_IOS=1 PROBE_PHONE_SETTINGS=1 PROBE_BURST=1 PROBE_SMALL=1 node .poc-stress-test/run.mjs
```

Use only one profile per burst invocation: control commands affect every
client of that private server. The harness stops its servers and private tmux
sessions in `finally`. No live service is changed. Retained JSON contains
summaries, frame timing, payload sizes, and input-delivery results, not synthetic
transcript contents. Port 4198's pre-existing diagnostic service is separate.
