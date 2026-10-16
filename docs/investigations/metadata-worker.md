# Transcript metadata worker

## State trace before the change

1. `main={refresh:hydrating, registry:A}`, `filesystem={A:200 children}`, `terminal={input:queued}`. Hydration calls PR and media extractors synchronously. Even warm caches stat each child.
2. `main={refresh:building sidebar, registry:A}`, `terminal={input:queued}`. `toAgentSession(A)` repeats both scans. No event-loop turn occurs between these phases.
3. `main={refresh:published}`, `terminal={input:handled}`. A slow filesystem operation delays unrelated terminal input for its entire duration.

## State trace after the change

1. `main={registry:A, metadata:empty}`, `worker={scan:A/path1}`, `terminal={input:handled}`. View construction queues one scan and reads only remembered descriptors. The second view coalesces into the same request.
2. `main={registry:B, metadata:empty}`, `worker={scan:A/path1}`. The user reassigns the window to B while the scan runs. Authoritative lifecycle updates remain synchronous on the main thread.
3. `main={registry:B, metadata:A/path1}`, `worker={idle}`. A's result updates only existing views whose session ID, path and provider match. It cannot restore A's window, name, status or lifecycle fields.
4. `main={registry:B/path2}`, `worker={scan:B/path1, queued:B/path2}`. A log-path change queues the latest request. The old result is rejected, then path2 is scanned. No old descriptors appear under the new identity.
5. `main={registry:B, metadata:previous}`, `worker={failed}`. Existing descriptors and queued dormant work remain available; a bounded-backoff retry starts a fresh worker. There is no synchronous scan fallback.
6. `main={stopped}`, `worker={closing}`. Shutdown clears queues and ignores late replies; the worker exits cooperatively.

Metadata results contain only PR/media descriptors. They never carry registry snapshots or lifecycle mutations. Pending records are coalesced by session ID. Active work takes priority over queued dormant work, with one record in flight. Filesystem freshness checks and parsing remain in the worker, including same-size rewrites. Codex links are copied when the main-thread index changes.

## HTTP reads

The library detail endpoint also used the synchronous extractors. It now awaits worker descriptors. While it waits, terminal traffic and mutations continue. After the await, it reads the current catalog and provider rows; a rename, hibernation, deletion or reassociation must not be replaced by a pre-scan snapshot. A changed log identity is scanned again. Explicit detail requests take priority over queued background scans and wait for a scan started after the request. Superseded scans retry against current identities. All conversation fields are materialized after the final descriptor await, including details with multiple linked conversations.

## Regression strategy

The contention harness installs a filesystem gate only in test processes. It holds a metadata stat, submits terminal input through the real browser, and checks output rendering and health before release. The same test fails with the original synchronous index.ts at the render-before-release assertion. The fixed test also waits for fresh library metadata while renaming through the real catalog API, then checks both current names and media. It checks equal-length rewrites, child discovery/deletion and truncation through real logs and UI updates. It runs in the existing contention CI job.

Unit tests cover coalescing, identity replacement, duplicate replies, growth, late transitive Codex links, failure/retry, shutdown, HTTP waiters and lifecycle-safe publication. Registry tests cover media-only changes, labels and removal. Existing browser tests cover full-message refresh, hibernation, served image/document payloads, lightboxes and terminal mouse behavior.

Workers use synchronous JSON logging; nested pretty-print transport workers caused a Bun shutdown crash during validation. Compiled builds also disable pretty transports, which cannot reliably resolve their runtime dependencies. The release build includes the metadata worker entry point.

## Validation (2026-10-16)

- Original implementation: the metadata browser regression fails at terminal rendering before gate release.
- Worker implementation: metadata regression 3/3 and existing copy-mode contention regression 3/3 pass.
- Existing browser suite: 11/11 media, polling lifecycle and terminal mouse checks pass.
- Frontend build and release-style compiled server build pass. A compiled metadata-worker smoke executable scans a private fixture and exits cooperatively.
- Lint, TypeScript and the full unit/isolated/real-tmux test runner run through the normal commit hook.

All fault injection used private data/provider directories and tmux sockets. No production server or live tmux session was modified. PR/media descriptors can appear after the initial session snapshot while a worker scan completes; lifecycle state and terminal input do not wait for that scan. This removes metadata filesystem work from the event loop, not every possible source of event-loop delay.
