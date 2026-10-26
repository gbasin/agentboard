# Thumbnail worker validation

The HTTP server dispatches one thumbnail at a time to a dedicated worker. Admission is capped at 16 requests. A 10-second active-work deadline rejects active and queued callers, but retains the occupied worker slot. New requests fail busy until the late response arrives. No replacement worker is spawned. A permanently stuck codec disables previews until process restart. Worker errors likewise fail closed. Structured warnings report deadlines and worker failures without image content. Cancellation removes queued work; a running cancelled request retains its slot until completion or termination.

The worker reads at most 64 MiB of one JSONL record, validates its SHA-256 digest, and extracts embedded images. It never fetches external URLs.

Decoded PNGs use an in-memory LRU capped at 16 MiB and 1,024 entries. The key includes decoder version, record digest, image index, and expected byte count. A separate source signature includes path, offset, inode, size, and nanosecond modification/change timestamps. Appends revalidate the line but reuse decoded bytes; rewrites must pass the digest check. The cache disappears on worker termination or process restart. Browser responses use private immutable caching.

## Compiled smoke

An actual Bun standalone compiled client and worker resolved the embedded worker entrypoint and generated a 128 × 72 PNG from a 1920 × 1080 source. Cold, warm, and post-append request times were 60.77 ms, 0.24 ms, and 0.48 ms. These are local smoke measurements, not production latency guarantees.

To reproduce, restore the retained compiled-smoke.ts.txt as .poc-stress-test/thumbnail-backend/smoke.ts at repository root, then run:

```
bun build .poc-stress-test/thumbnail-backend/smoke.ts src/server/mediaThumbnailWorker.ts --compile --outfile /tmp/agentboard-thumbnail-smoke
/tmp/agentboard-thumbnail-smoke
```

## Regression coverage

Twenty-one tests across mediaRoutes, mediaThumbnailRoutes, mediaThumbnailClient, and mediaThumbnails cover admission, serialization, cancellation, worker deadlines, late responses, and fail-closed worker errors, shutdown, authorization, required digest, record reassociation, error mapping, stale repair, cache reuse after appends, rewrite rejection, LRU eviction, incorrect byte counts, actual worker decoding, real HTTP disconnect cancellation, and refusal of external URLs.

Deadline tests cover mock late replies and an actual worker temporarily blocked in Atomics.wait: the client rejects callers at its deadline, refuses replacement work while occupied, then reuses the same worker after completion. Bun 1.3.14's expect(workerPromise).rejects stalled real-worker message delivery in a test. Awaiting and capturing the rejection before asserting avoids the test-runner artifact.

## Compiled failure-path investigation

The first compiled deadline probe called terminate() on a worker blocked indefinitely in Atomics.wait. The main process continued to answer HTTP and decode on a replacement worker, but did not exit after disposal: the blocked worker survived. The probe process was stopped with SIGTERM. This disproved the assumption that terminate() reliably bounds native work; production no longer uses it.

The initial cooperative shutdown called self.close() from an async onmessage callback. Both the source test process and compiled probe exited with status 133 (SIGTRAP). Moving shutdown to a synchronous onmessage callback, with asynchronous work delegated to a separate handler, resolved this observed failure and matches existing worker dispatch patterns.

The final compiled probe used a finite 1,500 ms native wait and a 1,000 ms deadline. It verified:

- One worker was created, with no replacement after timeout.
- Admission remained busy until the original worker completed.
- A subsequent thumbnail decoded successfully on that same worker.
- A real Bun.serve HTTP request aborted by a fetch AbortController propagated to the route signal. Its queued thumbnail never reached the worker.
- The main event loop delivered 188 heartbeat timer callbacks and answered HTTP after worker disposal.
- The compiled process exited with status 0.

This checks main-thread and HTTP responsiveness; it does not exercise an actual tmux terminal in the failure-path harness.

Restore runtime-check.ts.txt and runtime-blocked.ts.txt as check.ts and blocked.ts under .poc-stress-test/thumbnail-runtime, then run:

```
bun build .poc-stress-test/thumbnail-runtime/check.ts .poc-stress-test/thumbnail-runtime/blocked.ts src/server/mediaThumbnailWorker.ts --compile --outfile /tmp/agentboard-thumbnail-runtime-safe
/tmp/agentboard-thumbnail-runtime-safe
```

## Disposal with in-flight work

A separate compiled probe dispatched a thumbnail backed by a 32 MiB JSONL record, then disposed the client after 0, 1, 25, or 50 ms. All ten requests rejected with STOPPED, the HTTP health endpoint remained responsive after each disposal, and the process exited with status 0. The delays sample startup and in-flight filesystem work; the harness does not instrument the precise instruction at shutdown.

Restore active-dispose.ts.txt to .poc-stress-test/thumbnail-dispose/check.ts and compile with src/server/mediaThumbnailWorker.ts as the additional entrypoint to reproduce.

## Permanent compiled regression

The CI job now builds and runs `scripts/verify-media-thumbnail-worker.ts` with the delayed-worker fixture and production thumbnail worker as additional entrypoints. The script isolates its data directory and disables file logging before importing server configuration. It exercises deadline recovery without replacement, a real HTTP abort, warm/post-append responses, post-disposal HTTP health, and four in-flight disposal timings. The local compiled run passed with one worker, 97 main-loop heartbeat callbacks, observed HTTP cancellation, four active disposals, and exit status 0.

```
bun build scripts/verify-media-thumbnail-worker.ts scripts/fixtures/mediaThumbnailDelayedWorker.ts src/server/mediaThumbnailWorker.ts --compile --outfile /tmp/agentboard-thumbnail-regression
/tmp/agentboard-thumbnail-regression
```
