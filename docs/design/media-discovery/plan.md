# Progressive media discovery

## Evidence and broken flow

Reported parent: 33 MiB; 115 subagents make the source set approximately 498 MiB. A cold private-index run took 783 ms for PR extraction and 1,628 ms for media indexing; a warm page took about 6 ms. This did not reproduce a crash or the reported minute-long wait.

Concrete current trace:

1. Restart: `disk = {items:692,complete:true}`, `metadataCache = {}`, `client = {summary:undefined,panel:closed}`. Catalog queues a scan rather than hydrating the persisted summary.
2. Worker busy with another session: `worker = {operation:fullScan}`, `requested = {queued:true}`. `MediaRail(!summary)` returns null. The user cannot open or retry discovery.
3. Scan starts: `worker = {PRscan:783ms,mediaTransaction:1628ms}`. No partial commit or notification exists. Page reads use the same queue and repeat freshness work.
4. Success finally publishes summary and reveals the button. Failure leaves the cache absent and the button hidden. Unknown is incorrectly rendered as absence.

## Invariants

- A local associated transcript always has an accessible Media entrypoint, including unknown, empty, indexing and failed states.
- Reading an indexed snapshot never scans transcripts or extracts PRs and never waits on the writer queue.
- One writer, one independent read-only SQLite worker, and the existing PR worker have separate queues. No database read runs on the terminal/event-loop thread.
- Indexing yields at checkpointed complete-record boundaries. Byte/time budgets are cooperative; one record can exceed a slice but never the existing bounded record limit. No unbounded worker respawn on timeouts.
- Each committed batch persists file offsets, labels and timestamp-clamp state. Restart loses only the uncommitted batch.
- Cursor watermark and generation freeze a view across insertions. Rewrites/deletions invalidate it. Every page query uses one short read transaction, never held across an await.
- Newest-first means newest among the indexed snapshot. During initial discovery the UI explicitly says results are partial. Once visible, a nonempty page stays fixed; later discoveries offer Refresh rather than inserting above the reader or changing lightbox selection.
- No polling or media payloads on the catalog socket. An open panel has one finite fetch stream, aborted on hide/close/session/query change. A cached snapshot is sent first, then bounded progress and a first nonempty snapshot if the initial snapshot was empty.
- PR extraction is independent of media discovery. Dormant media history is hydrated from the index and indexed on demand, not eagerly scanned on every catalog read.
- Full link destinations are copied, never truncated display values or internal redirect URLs. Oversized descriptors must not make following items inaccessible.

## Proposed contracts

`MediaDiscovery` is pending, indexing (bytes/files progress), ready, or failed (safe message). New streamed snapshots always carry it; legacy bounded JSON pages remain supported during migration. Counts in an indexing snapshot are explicitly partial.

The stream emits snapshot, progress, error and done frames, with independent per-frame, total-byte and lifetime bounds. Each view owns its abort controller and request generation. A stream is not an unbounded event subscription. Slow consumers coalesce progress and cannot grow queues without bound.

The metadata facade keeps existing call sites but delegates media to a dedicated discovery service. Catalog reads synthesize pending summaries immediately and asynchronously hydrate persisted summaries. Page/neighbor reads use the read-only worker. Visible discovery is prioritized over background active-session indexing; closed dormant discovery stops at a checkpoint. Stuck/error states remain visible and retryable without hiding cached items.

## Proof table

| Claim | Evidence | Status / next action |
|---|---|---|
| Missing button conflates unknown with empty | MediaRail guard, cache get, live eventual summary | passed: pending-zero and unknown→ready browser/unit regressions |
| Queue coupling blocks warm pages | synchronous metadata worker before every read | passed: real writer parses 48 MiB while cached reader completes |
| WAL readers can see committed batches during writes | SQLite WAL/isolation documentation | passed: independent real-worker reader and held WAL transaction tests |
| Existing cursors tolerate inserted rows | id watermark + generation tuple | passed: progressive, append, rewrite, rotation, deletion and frozen-cursor tests |
| Forward parsing needs label/time state | mediaExtractor and scanMediaFile | passed: checkpoint reopen preserves labels and timestamp clamp |
| Cold partial results can be global newest | Forward scan has not inspected every source | contradicted; label partial, freeze visible view and offer refresh |
| HTTP Safari can copy via same-gesture fallback | existing helper + WebKit clipboard requirements | unit fallback/failure tests passed; final browser and native evidence recorded separately |
| Specific minute-long delay was a crash | no failure logs, eventual data, cold run ~2.4s | unresolved; add queue/scan/read timings rather than claim reproduced |

Primary references: https://www.sqlite.org/wal.html ; https://www.sqlite.org/isolation.html ; https://bun.sh/docs/runtime/workers . Independent Claude review: 20261026-095942-claude-3592f808. Review supports separating reads/writes and explicit discovery; its ~100ms first-result estimate remains a hypothesis until measured.

## Fixed-flow state walk

1. Restart: `disk={items:692,ready:true}`, `cache={}`, `view={summary:pending,open:false}`. The pending entrypoint is visible. Hydration queues a read; no transcript scan is needed to discover the persisted count.
2. Open while another session indexes: `writer={job:B,offset:1MiB}`, `reader={request:page(A)}`, `view={open:true}`. Reader snapshots A's committed rows and releases its transaction before sending the response. B's queue cannot delay this read.
3. Cold A: `disk(A)={items:0}`, `view={items:[],status:pending}`, `watchers(A)=1`. A gets foreground priority. First committed batch sets `disk(A)={items:12,offset:1MiB,status:indexing}`. The reader sends those twelve rows; `view={items:12,watermark:12,frozen:true}`.
4. Later commit: `disk(A)={items:30,offset:2MiB}`, `view={items:12,watermark:12}`. Progress changes counts; it does not replace visible rows. Refresh explicitly creates a new watermark. Paging retains the previous watermark and revision.
5. Close/background: `watchers(A)=0`. The HTTP stream aborts. If A is dormant, its next scheduler turn cancels its in-memory job at the committed offset. If A is active, indexing may continue at background priority. A subsequent open resumes the persisted checkpoint.
6. Warm unchanged scan: `cache(A)={ready,revision:r}`, final result remains `{ready,revision:r}`. The coordinator still wakes stream listeners even though catalog publication is suppressed. Otherwise an unchanged warm stream would hang until its deadline; this was caught in this walk and corrected.
7. Writer timeout: `rpc.pending={id:7}`, `rpc.stalled={7}`. Caller sees failure; admission remains occupied. New commands fail until id7 actually settles. No second worker is spawned over potentially running native work. Reader remains independent. A later explicit retry can resume the same writer checkpoint.
8. Rewritten source: writer replaces affected rows and changes generation in the same transaction. A reader either sees the old complete snapshot or the new one. An old cursor is rejected explicitly; it is never silently applied to different content.

Worker close/startup failure, admission pressure, active source growth during an existing EOF snapshot, and stream byte/deadline termination now have regression coverage. Browser focus/clipboard evidence is recorded in the validation reports.

## Final review decisions

Claude critique `20261026-103503-claude-2a10f507` independently confirmed the cursor/checkpoint design and identified catalog broadcast density and unconditional active re-scans as performance risks. Both traces were verified in the source. Metadata notifications now require a global batch at the registry boundary; fine-grained progress stays on the open panel stream. Completed active scans use size/link-generation freshness, with a 30-second fallback for child growth and same-size rewrites. Explicitly opening a panel still requests a fresh pass. Size alone is not a sufficient freshness key.

Other verified review points: a persisted interrupted `indexing` state hydrates as `pending`; unknown zero counts must not select Links or display a misleading zero; worker errors must still send a safe failure if persisting the failure state itself fails. Timeout ownership, confirmed-close-only worker replacement, foreground slot admission, and coalesced subagent updates have deterministic lifecycle regressions.

Image neighbor navigation uses the current committed index, whereas the rail uses its frozen cursor watermark. A selected image does not move, but newly discovered neighbors can become reachable. This is intentional and distinct from reordering the visible rail.

The finite stream remains bounded. An open panel may continue a partial discovery a limited number of times while retaining its frozen rows, then offers an explicit retry. Backgrounding/closing cancels the continuation chain. Desktop WebKit tests do not establish physical iPhone/cellular behavior.
