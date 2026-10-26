# Combined PR review fixes

Base: `7cb7090` (PR #446, including #439–#445). Validation date: 2026-10-26.

## Changes

- Original transcript payloads use an explicit MIME allowlist, `nosniff`, and a restrictive document CSP. HTML, SVG, scripts, and unknown types download as octet-stream with no caching. Common raster images, PDF, and plain text remain inline. Downloaded files must still be treated as untrusted by the application that opens them.
- Browser payload requests add `delivery=2` to bypass old immutable responses. Canonical media identities, thumbnail keys, external URLs, and neighbor anchors stay unchanged. Old tabs need a reload to use the new URLs.
- A finite discovery stream that has delivered a snapshot ends cleanly at its deadline. The existing client renews at most three times, retaining visible rows. A producer that never yields a snapshot still reports a timeout. Identity changes still report a stale cursor.
- Contention tests target the physical tmux window across relay session names and assert the summary/page protocol with explicit refresh. Output generated during a stalled copy-mode query must still reach the other terminal before release.
- CI runs for stacked PR bases and includes the Media/Links WebKit suite. The dedicated browser config refuses to reuse an unrelated server.

## Evidence

- Required lint and typecheck passed. The full unit/integration runner passed 2,295 tests with zero failures.
- Both contention E2E tests passed against an isolated server and tmux socket (58.9 seconds).
- A real route/client regression drives stream expiry, observes a second subscription, and checks that the original row remains visible through completion.
- Chromium and WebKit security E2E exercise actual HTML/SVG transcript payloads, assert downloads and exact payload bytes, and render a normal PNG original. Browser download events and response headers are the security evidence; the unchanged page title is only supplementary.
- Compiled terminal smoke passed HTTP, real terminal attach, retained reconnect, input echo, worker expiry/pooling, and process survival. Compiled media smoke passed cold snapshot, finite discovery, pagination, neighbors, payload, and persisted restart. On its 2,972,204-byte synthetic fixture: first items 24 ms, discovery 126 ms, restart read 76 ms. These local measurements are not physical iPhone latency measurements.
- An actual Chrome PDF viewer rendered a valid one-page PDF under the exact new response headers. Both a control and sandboxed response rendered the visible text “PDF PREVIEW WORKS.” This check addresses the independent review's potential PDF compatibility concern; it does not establish native iOS PDF behavior.

## Independent review

Claude consultation `20261026-130246-claude-0bcc9549` found no blocker in the four fixes. Its PDF concern was tested in actual Chrome rather than removing the security header speculatively. Its download-filename suggestion is optional; downloads currently keep the existing URL-derived name. Final browser matrix results and screenshots are attached to the follow-up PR.

## Limits

Physical iPhone cellular/background/Home Screen behavior was not revalidated in this pass. Browser automation and private tmux fixtures do not establish that those environments can never regress. CI now exercises the seams that the earlier stack checks missed.

## Additional race found during the full matrix

The first matrix failed the same-size rewrite case once. Five isolated repetitions reproduced it once more (four passes, one failure): the explicit discovery stream ended with the old revision. Investigation uncovered the independently reproducible coordinator races below. Subsequent tracing established a separate fixture baseline issue as the cause of the remaining E2E failures; see the final paragraph. The revision, label, stale cursor, and stale payload assertions were kept intact.

The hand-compute trace uses `watch = {dirty, snapshot}`, `job = {started, again}`, and `cache = {discovery, revision}`:

1. Earlier scan is active: `watch={dirty:false,snapshot:pending}`, `job={started:true,again:false}`, `cache={discovery:indexing,revision:r1}`.
2. Watch reads/yields its cached snapshot. The earlier scan completes before the consumer requests the next frame: `watch={dirty:true,snapshot:r1}`, `job=absent`, `cache={discovery:ready,revision:r1}`.
3. Old behavior enqueues a new job but consumes the existing dirty flag: `watch={dirty:false,snapshot:r1}`, `job={started:true,again:false}`, `cache={discovery:ready,revision:r1}`. It emits ready and done before the new job observes the edited source.
4. Fixed behavior clears that earlier notification before enqueue: `watch={dirty:false,snapshot:r1}`, `job={started:true,again:false}`. It waits for the new scan's notification. The scan observes the rewrite and publishes `cache={discovery:ready,revision:r2}` before the view completes.
5. If the earlier scanner remains in flight at step 3, the view marks `job.again=true`. Its first completion publishes pending and schedules one incremental recheck. The recheck publishes ready. Multiple simultaneous opens coalesce into that same recheck; they do not create parallel scanners or force a full index rebuild.
6. If the view aborts before enqueue, no fresh work is requested. If it aborts later, its listener is removed; existing dormant-job cancellation still applies. Deadline expiry still uses the bounded route/client continuation path.

Two deterministic coordinator tests cover both interleavings. All 25 discovery/coordinator tests passed after the fix. The full browser matrix was restarted against the corrected server; the interrupted run is not counted as a green run.

Adversarial inspection and a controlled test established a second ordering path: a persisted-summary hydration can announce ready after the fresh check is queued. The stream now ignores ready notifications while its scan job remains present. The coordinator removes a completed job synchronously before a waiting stream resumes, so genuine completion still wakes and completes the view. A third controlled test delays persisted hydration until the new view has requested its check, asserts that the view does not settle, and then completes both scanner steps. This guard does not suppress pending/indexing progress or scan failures.


The decisive scanner trace showed `previousSize=40381`, `end=40668`, and an unchanged prefix boundary: fixture matching had appended a prompt after the initial count publication. The later edit was same-size relative to the physical file, but not relative to the committed index checkpoint. Establishing explicit discovery before the edit makes this a true same-size regression. The helper also now requires a ready progress frame: finite `done` alone is not proof of completed discovery. This preserves all correctness assertions without waiting/retrying the final revision check.

Residual scanner contract: incremental append detection checks source identity, size, modification time, and bounded prefix/EOF boundaries. Arbitrary interior rewrites combined with growth (or changes that preserve modification time) are not fully detected without rereading the prefix. This pass does not add full-prefix hashing or force full reindexing on every panel open. The security route still validates each requested payload digest against its source record.

Claude's second review (`20261026-131301-claude-15528bbe`) agreed on the two coordinator interleavings, independently identified the hydration path (now tested and guarded), and recommended requiring ready progress in the E2E helper (implemented). Its caution about attributing the original E2E failure to the coordinator race was correct; the scanner trace established the fixture issue above.

After correcting the baseline, the same-size rewrite E2E passed ten consecutive runs (five Chromium, five WebKit). Final code also passed the required lint/typecheck/unit/integration commit hook with 2,295 tests and zero failures.
