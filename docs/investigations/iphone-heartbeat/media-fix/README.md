# Scroll-driven media and small reconnect catalogs

Implemented the payload-related fix without changing heartbeat deadlines or the
live port-4040 service. PR #439's separate physical-cellular regression is not
proven resolved by these results; keep its live-trial blocker.

## Final behavior

- Live session/lifecycle messages and `/api/sessions` carry media summaries,
  never descriptor collections. Registry/store comparisons use small summaries.
  Library conversation details also omit media lists. Sidebar prompt previews
  are capped at 250 characters.
- The metadata worker owns a separate SQLite index in the private data directory.
  Scan responses contain counts/revisions, not cloned descriptor arrays. The
  index retains all ordinary source records, including more than 2,000 items per
  log and more than 257 items in one record.
- Opening Media requests its first page. Scrolling forward requests subsequent
  pages. There is no polling or automatic collection download on reconnect.
  Pages are oldest first and limited to 40 items and 64 KiB. The client retains
  three pages (at most 120 rendered items), plus a bounded cursor trail.
- New arrivals advertise a change without moving the browsing position or
  automatically downloading pages. Refresh is explicit. Requests are cancelled
  on hide, collapse, lost terminal readiness, or identity change; late responses
  cannot populate another session.
- Known local images up to 64 KiB can preview inline. Large, external, unknown-size,
  and excessive-dimension assets require explicit opening. This deliberately
  replaces the old 12 MiB original-image thumbnail allowance. Generated thumbnails
  are deferred: the bounded explicit-open fallback avoids a new native decoder
  dependency in compiled releases.
- Digest-backed payload URLs reject changed source records, including same-size
  rewrites. Legacy digestless URLs are no longer advertised immutable. Existing
  validated path/offset references are retained with digests rather than adding
  a new opaque-reference database. External URLs are resolved through bounded
  local descriptor references and redirect only to HTTP(S), without server-side
  remote fetching.
- Catalog protocol 2 is negotiated before snapshots. The client waits for the
  versioned config before terminal handshake/input. Old tabs receive small reload
  notices and pongs, without catalogs or terminal allocation. No automatic reload
  discards a draft. Positive incompatibility stops the new client's retries;
  silence during negotiation uses normal retry behavior.

## Compiled transport experiment

Both cases used the exact installed 0.36.3 executable/frontend and a freshly
compiled candidate, private databases/logs/tmux sockets, and 23 synthetic windows.
The first window contained 2,366 generated media entries. Six real rename commands
caused normal registry updates at approximately 15–40 seconds. No user data was
copied. The client used Playwright WebKit with iPhone identity and WebGL disabled.
Heartbeat intervals remained 20 seconds with a 10-second deadline.

| 100-second run, 128 KiB/s transport | Stable 0.36.3 | Candidate |
| --- | --- | --- |
| Initial `sessions` + `agent-sessions` bytes | 2,719,688 | 45,012 |
| Heartbeat timeouts | 2 | 0 |
| Connections | 3 | 1 |
| Matched pongs | 3 only | 1, 2, 3, 4, 5 |
| Explicit terminal input, independently captured | Delivered | Delivered |

Initial catalog traffic fell **98.3%**. HTTP `/api/sessions` was 1,366,846 bytes
in the release and 25,422 bytes in the candidate. Six candidate update bursts
were observed on the wire; this was not a quiet-client comparison.

The first comparison shapes WebSocket traffic only, using the same impairment
as the reproducer. A second candidate run shares a per-direction 128 KiB/s FIFO
budget across **all HTTP and WebSocket connections**, including assets, media
pages, and previews. It opened and scrolled Media under the same six updates:
one connection, zero timeouts, pongs 1–4, and verified terminal input. The cold
page load consumed part of the 100-second window. No network packets were
fabricated/dropped, and the proxy uses backpressure rather than forced queue-cap
closures. Synthetic small PNGs do not reproduce every possible image workload.

Results/traces are in `final-bursts/` and `shared-link/`; harness sources and seed
are alongside this report. `artifacts.json` records executable hashes. The final
candidate and assets are retained outside Git at
`/tmp/agentboard-media-validation-release/` for another isolated trial.

## Regression validation

| Check | Result |
| --- | --- |
| `bun run lint`, `bun run typecheck`, `bun run test` | Passed (full runner) |
| Final real-media Chromium/WebKit matrix | 18 passed |
| Attention/layout cases from the broader matrix | 22 passed |
| Additional mobile resize-without-refetch visual cases | 2 passed |
| Existing Chromium/WebKit terminal recovery matrix | 25 passed, 1 expected engine-specific skip |
| Compiled release smoke | Passed: HTTP, attach, retained reconnect, echo, worker expiry/reuse, pane survival, clean shutdown |
| Actual old 0.36.3 frontend against candidate server | One connection, 7 reload notices, 1 pong, no catalogs or terminal frames |
| Native iOS Safari on remote M5P | Passed; details below |

The recovery skip is the Chromium-renderer scheduling-gap test in WebKit.
Other recovery checks cover input gates, stale readiness, A–B–A switching,
network offline/reload, foreground sizing, overload recovery, draft review/send,
and draft persistence/discard. The old-frontend test uses real installed assets;
its first attempt hit a duplicate/hidden-banner selector and was corrected before
the accepted 25-second observation.

New lower-level regressions cover all catalog/lifecycle message projections,
page byte bounds, 2,366 items, a 258-item single record, append snapshot cursors,
rewrites/truncation/deletion, index reopen, late responses and reassociation,
oversized records, bounded pending label context, missing/backward timestamps,
forced repair, worker errors, and timed-out request admission slots.

Independent review found and fixed these issues before final acceptance:

1. Timed-out page RPCs had released capacity while work remained in the worker
   mailbox. Slots now remain reserved until a response or worker retirement.
2. Missing/backward timestamps could put newer records before older records in
   the same log. A persisted nondecreasing per-file ordering timestamp fixes it.
3. Pending labels were only entry-bounded. They now have a 1 MiB context budget,
   bounded labels, and consistent hashed keys for oversized tool IDs.
4. The legacy 257-block-per-record cap silently omitted valid indexed media.
   Disk indexing and digest-backed payload routes now support later blocks.

## Native Safari and visual inspection

A dedicated iPhone 17 Pro / iOS 26.4 Simulator on **M5P**, not the local Mac,
ran native XCTest taps/swipes, Home/background, resume, and keyboard input.
A transparent proxy counted actual page requests:

- Closed Media: 0 requests.
- First open: 1.
- Native horizontal swipe: 2.
- Ten-second background and resume: still 2, with the panel preserved.
- Native keyboard marker: delivered exactly once to the private tmux pane.

[Native report, artifacts, and limits](ios/README.md). That native binary predates
final RPC/index edge hardening; the final compiled workload and browser matrices
cover the later implementation. Native testing was Safari Simulator, not physical
cellular or an installed Home Screen app. Do not equate desktop WebKit identity
emulation or Simulator results with the user's original radio/Tailscale path.

Root independently used dev-browser on the actual compiled application at a
390px viewport: one request/40 items on open, two requests/80 items after scrolling.
The media panel fits the viewport and terminal controls remain accessible.
See [mobile screenshot](mobile-media.png) and the real E2E browser screenshots.

## Operational limits and cleanup

- A single JSONL record above 64 MiB is skipped with an explicit incomplete-media
  warning. Incomplete oversized tails are tracked so scans do not repeatedly
  rebuffer them. Ordinary history is not capped by item count.
- Incremental append detection uses filesystem identity/stat and boundary
  checkpoints. A deep prefix edit combined with growth can evade those cheap
  checks. Per-record digests prevent returning incorrect bytes; a digest mismatch
  queues a coalesced, identity-fenced reindex. Cross-file unknown timestamps use
  deterministic fallback ordering; no unavailable chronology is invented.
- The disk index is derived metadata, not an archive of deleted source payloads.
  It grows with indexed history. No recovery-draft data is stored there.
- Initial summaries still scale with session count. History sidebar rows are
  capped at 100; hibernating rows remain uncapped. This change removes dependence
  on media count, not every possible catalog scaling limit.
- No second terminal socket or generic update coalescer was needed to pass the
  reproduced workload. Lifecycle results, commands, and terminal output are not
  silently dropped or coalesced.
- Temporary POC data, fixture servers, private tmux sessions, browser page, SSH
  tunnel, and the dedicated remote simulator were cleaned up. Native raw results
  remain outside Git as recorded in the native report. Existing diagnostic 4198
  was left alone. Stable 4040 remains the original PID 23622 on 0.36.3.
