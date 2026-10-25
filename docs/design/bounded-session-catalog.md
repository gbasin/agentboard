# Bounded session catalog and on-demand media

Status: design exploration. Based on PR #439 at f3aef0d. No runtime change or
production deployment is part of this document. User decisions are recorded
below; unresolved decisions must not be silently converted into requirements.

## Problem and evidence

A connection currently receives two overlapping full views: `sessions` and
`agent-sessions`. The 23-window synthetic fixture matching production emits
about 2.7 MB across those messages. Each replacement connection starts over.
Six metadata mutations at 128 KiB/s caused two heartbeat timeouts in both the
stable release and the failed PR build. A roughly 40 KB catalog under the same
schedule passed. The exact PR-only physical-phone regression remains unresolved.

[Experiment and limits](../investigations/iphone-heartbeat/production-payload/README.md).
The experiment proves payload sensitivity. It does not isolate network queuing
from serialization, parsing, and rendering costs.

The architecture mixes three independently sized resources:

- Live terminal targets and session lifecycle/status.
- Transcript-derived metadata summaries.
- Potentially large media collections and individual payload bytes.

The fix should separate their storage and delivery contracts. Stripping `media`
inside JSON.stringify would leave large worker messages, registry comparisons,
and the library detail path unchanged.

## Product decisions

Confirmed:

- Restore the last terminal before board metadata finishes refreshing.
- Support Safari tabs and installed Home Screen apps over the existing HTTP
  Tailscale access path. Do not depend on service workers or background JS.
- Keep desktop dimensions while the phone is backgrounded; active view controls
  terminal resizing. Preserve existing input recovery/draft safeguards.
- Media remains oldest first; load newer items as the user browses.

- User delegated the history-coverage choice; recommendation adopted for the
  proposal: all media still present in transcripts, indexed incrementally on disk
  and loaded in bounded pages. No silent 2,000-item history cutoff.
- Fetch the first page when Media opens and subsequent pages only as scrolling
  approaches the loaded boundary. No periodic browser polling, background page
  prefetch, or reconnect-driven media collection download.
- Requiring a deliberate reload after upgrade is acceptable. Do not maintain a
  full legacy media protocol solely to keep old tabs working.

Engineering defaults for review: preserve scroll position when new items arrive;
show availability without automatically fetching them. Keep page cache in bounded
memory, separate from persistent recovery drafts. An open panel may revalidate
its small revision after terminal recovery, but must not automatically re-download
all loaded pages.

## Recommended design boundaries

### 1. Session summaries are the live contract

Introduce explicit summary types rather than optional media arrays on a shared
object that sometimes means a summary and sometimes means full details.
A session summary contains existing identity, lifecycle, status, names, and
bounded preview fields. Media contributes only a small summary:

- Availability: pending, ready, or unavailable. Pending must not mean empty.
- Counts by kind and total retained/indexed count.
- Opaque source identity and media revision.
- An additions indicator/version distinct from the revision when deletions or
  label edits must not produce a new-media alert.
- Coverage information if the index is incomplete or intentionally limited.

Compute the summary once when the media collection changes. Propagate it
through the metadata worker, parent registry, and client store. Never build a
full collection solely to compare two session views. A same-count replacement
must still change revision. Revision scope includes server/index incarnation,
transcript identity, and source-file generations; a restart cannot accidentally
reuse an old browser cache key.

Audit every message carrying Session or AgentSession, not only initial lists:
create, update, activation/rematch, orphan, rename, wake, hibernate, and library
responses. A projection at one broadcast call is not a complete boundary.
Enforce the contract with serialization tests for all message variants.

Initially keep the distinct live-window and transcript/history collections.
They drive different lifecycle flows; deleting one because their media overlaps
would be an unrelated migration. Once summaries are small, evaluate whether
remaining duplication merits normalization separately.

A small authoritative snapshot on reconnect is intentional. Do not add durable
per-client replay cursors merely to avoid sending a small catalog. Snapshot
replacement is easier to reason about across server restart and tab eviction.

### 2. A media index owns descriptors

The media worker/index owns descriptor collections. Normal scan responses carry
summaries and changed revisions, not thousands of descriptors. Page requests
return only one bounded page; do not clone the full index to the parent first.
The existing worker already keeps filesystem scans off the dashboard loop;
preserve that separation and its reassociation fences and crash handling.

Use an incremental SQLite media index owned by the metadata worker, separate
from hot session writes, with bounded RAM. The current rolling 2,000-item cache
cannot be its authoritative data source. Index historical transcripts on demand;
do not scan all 9,819 session records at server startup to make the sidebar ready.
Process active-log changes through existing change discovery. View reads and
socket reconnects must not schedule full index rebuilds. A cold index reports
pending/partial coverage rather than zero or a false claim of completeness.

Page data and coverage should become available as indexing progresses. Existing
transcript format adapters and deduplication semantics need explicit tests before
removing the rolling cap. A deleted/pruned source cannot provide missing history;
report that fact without implying the on-disk index is a media archive.

Stable identity is not a bare array offset. Track source identity, file
generation, record byte offset, and item index. A same-size log rewrite or
truncation invalidates the affected generation. Removed subagent logs invalidate
their items. Metadata changes and source changes must be reflected even when
item count stays constant.

Oldest-first order must be explicit across main and subagent logs. Current
code concatenates files; it does not produce a global chronological order.
Preserve per-file record order and define a deterministic cross-file key. If
using transcript timestamps, missing/invalid timestamps need a documented
fallback. Do not claim chronological accuracy for providers without timestamps.
Newly discovered older records must not silently reorder an in-flight page.

### 3. Bounded HTTP pages and payload validation

Add a descriptor-list endpoint separate from the existing individual media-byte
endpoint. Requests identify the transcript and carry a cursor tied to an index
revision/snapshot. Replies include identity, revision, coverage, bounded items,
and an optional next cursor. Set both an item-count limit and an encoded-byte
limit: labels and external URLs can themselves be large. Define an explicit
oversized-item representation/detail fetch rather than returning unbounded rows
or silently corrupting URLs. Candidate defaults are 50 items and 64 KiB/page;
these are POC parameters, not validated performance guarantees.

Prefer a keyset cursor with a fixed index high-watermark captured when browsing
starts. Each cursor includes source/index incarnation, ordering key, and the
high-watermark. Appended/newly discovered rows beyond that watermark appear only
after an explicit refresh; they do not shift existing pages. In-place rewrites,
removal, or an index rebuild invalidate the view and return an explicit stale
cursor result. Preserve the user's visible location where possible when refreshing;
never automatically chase changing revisions in an infinite request loop.

Validate this design against late subagent discovery and missing timestamps in a
POC. A finite immutable snapshot is a fallback only if the cursor model cannot
meet those semantics; do not introduce per-view copies of whole media collections
without byte/time/eviction budgets.

Authorize/resolve the record on each request. Recheck identity after asynchronous
index work; association may change while awaiting a page. Preserve the existing
restriction to the session's main/subagent files. Use opaque references rather
than client-supplied arbitrary filesystem paths for new APIs.

Existing payload URLs use path/offset/index/byte-length and immutable cache
headers. Byte length alone does not establish content identity after a same-size
rewrite. New payload URLs need a generation/content discriminator, and the byte
endpoint must validate it before returning data. Previously cached immutable
responses must not be reused for different content at the same offset. Hashing,
if used, belongs in scan/detail work, not session-view serialization.

An HTTP endpoint removes media descriptors from WebSocket ordering, but it does
not create extra radio bandwidth. Limit concurrent page/image requests and
cancel optional transfers while hidden. The current MediaChip loads original image URLs as thumbnails and permits up to
12 MiB per item; native loading=lazy is not a sufficient transfer budget. Provide
bounded generated previews for supported local image formats, with full originals
loaded only on explicit open. Limit decode dimensions, queue concurrency, response
bytes, and cache size; expensive image work must not run on the dashboard/terminal
loop. Unsupported or oversized sources use an explicit-open chip. Do not introduce
an arbitrary remote-image proxy; preserve external-link behavior without eagerly
fetching those assets. Thumbnail dependency/decoder choice needs a separate small
POC against compiled Bun artifacts before adopting it.

### 4. Client state has separate ownership

The session store owns summaries and selection. A separate bounded media cache
owns page data, keyed by transcript identity and revision. Do not put loaded
pages back into Session or persist them alongside recovery drafts.

Media panel states should be explicit: closed, loading, ready, refreshing,
error. Cached items may remain visible during a failed refresh with a clear
staleness indication. Never replace a previously loaded collection with empty
because an index is restarting. Cap cached bytes/pages and rendered elements;
loading many pages must not eventually recreate thousands of mounted chips.

On selection change, abort the old request and invalidate its request token.
Cancellation is advisory: a response is committed only if identity, revision,
view generation, and request token still match. Transcript rematch within the
same tmux window is a selection-identity change, even if the window ID is stable.

On background/pagehide, stop optional fetching. On visible/pageshow, reconcile
from current state; a process may have been frozen without running cleanup.
Restore/reverify terminal readiness first. A closed media panel does not fetch.
An open panel revalidates only after terminal restoration; unchanged revision
reuses cached pages without fetching them again. Evicted tabs rebuild from a small snapshot. Recovery drafts
continue using their existing local persistence and are never auto-submitted.

### 5. Bound replaceable updates without losing events

First remove large collections and measure. A generic 'drop all but the latest
message' policy is incorrect. The client derives permission/idle sounds from
status transitions and uses lifecycle result messages to resolve pending
kill/hibernate/wake state. Terminal output, user input, command results, errors,
and lifecycle transitions must not be silently coalesced.

If summary traffic still needs coalescing, define separate message classes:
replaceable catalog state versus ordered semantic events/results. Snapshot
revision and tombstones must prevent a queued old snapshot from resurrecting a
removed session. Flush the latest bounded state after drain; never keep an
unbounded list of obsolete snapshots. Bound both the parent-to-relay mailbox
and socket admission; coalescing only in the parent misses relay buffering.
Data already accepted by the socket cannot be reprioritized afterward.

A separate terminal/control socket can isolate ordered streams, but introduces
independent epochs, partial availability, reconnect ownership, and command
routing. It also cannot eliminate shared radio contention. Keep this as a
separately tested stage if bounded summaries do not meet the target; do not
expand the first implementation to dual transport without evidence.

## Call-site audit

| Area | Current behavior | Required treatment |
| --- | --- | --- |
| `shared/types.ts` | Session and AgentSession both embed full media | Explicit summary/detail types; enumerate every message variant |
| `mediaExtractor.ts` | Incremental per-file cache, 2,000 rolling items, byte-offset references | Coverage contract, generations, ordering, bounded indexing |
| `agentSessions.ts` | Merges main/subagent descriptors and generates URLs | Index-owned detail construction; summary generation |
| `sessionMetadataWorker.ts` | Full arrays returned after scans | Summary replies; bounded detail-page requests |
| `sessionMetadataClient.ts` | Full-array cache and JSON comparisons, async waiters | Summary cache, revision comparisons, page RPC cancellation/timeouts and identity fences |
| `sessionMetadataViews.ts` | Patches live windows plus active/hibernating/history rows | Patch summaries without replaying stale lifecycle state |
| `SessionRegistry.ts` | Full-list and single-row emissions; serializes media in equality | Summary equality; lifecycle ordering; avoid media-dependent work |
| `index.ts` | Open-time snapshots, mutation messages, HTTP sessions, payload route | All paths must use consistent projections/contracts; terminal admission stays independent |
| `persistence/routes.ts` | Library detail awaits metadata scans for session records | Separate small PR/summary data from optional media-page fetching; preserve reassociation checks |
| `terminalRelayWorker.ts`, `relay/leases.ts` | Same socket carries metadata and terminal; terminal byte ACK budget | Keep output/control accounting distinct; optional metadata admission must not bypass bounds |
| `relay/client.ts` | Internal terminal catalog already projects only target identity | Preserve this efficient projection; do not add media here |
| `remoteSessions.ts` | SSH tmux polling; no transcript media federation | Preserve remote media unavailability; no new remote-file access implied |
| `client/App.tsx` | Snapshot/update handling and lifecycle transitions; activation merges old rows | Preserve lifecycle behavior; explicitly reset media identity on rematch |
| `stores/sessionStore.ts` | Compares every media URL; contains both catalog representations | Summary equality and separate detail cache |
| `components/MediaRail.tsx` | Closed by default; URL set detects additions; expanded renders all chips | Counts/addition signal, page fetch, stable browsing position, bounded rendering |
| Library/history UI | Uses distinct active/dormant collections and detail requests | Preserve selection, filtering, wake/hibernate, PR links; avoid eager media fetch |

The dormant scanner helper has no production call site in this branch from the
repository search; inspect test/compatibility use before deleting it. Do not
expand this refactor into unrelated remote subprocess/environment cleanup.

## Concrete state traces

Broken, observed-compatible sequence (not proof of exact server pong timing):

1. `client={epoch:1, mediaPanel:closed}`;
   `socket={catalogBytes:~2.7MB, rate:128KiB/s}`.
2. `server={renameUpdates:6}`; full metadata updates append more bytes.
   `client={ping:1, deadline:+10s}`; pong is not observed before deadline.
3. `client={epoch:2}`; `socket={newCatalogBytes:~2.7MB}`. Reconnect repeats
   bulk delivery. Another timeout occurs. After updates stop, epoch 3 recovers.

Proposed closed-panel reconnect:

1. `client={epoch:1, selected:A, panel:closed, draft:preserved}`;
   `server={summaryRevision:9, mediaRevision:40}`.
2. Connection opens: `socket={smallSummaryPending:true, mediaPages:0}`.
   Terminal validates target A and resumes. No media scan/detail request gates it.
3. `client={epoch:2, terminal:ready, panel:closed}`; summary revision 9 applied.
   `mediaCache={A:revision40}` remains unused. Media traffic remains zero.

Switch during page fetch:

1. `view={identity:A, token:7}` sends page request `{A, revision:40}`.
2. Switch/rematch: `view={identity:B, token:8}`; abort A.
3. A responds despite cancellation. A's identity/token mismatch rejects commit.
   B cannot display A's descriptors. Terminal B is independent of this request.

Background and source rewrite:

1. `view={A, revision:40, open:true, page:1}`; phone is suspended.
2. Server indexes a same-size rewrite: `{A, generation:3, revision:41}`.
3. Resume: terminal is revalidated first; old page remains cached/stale, not empty.
4. Summary revision 41 invalidates paging cursor 40. Fetch a bounded new first
   page only if the panel is still open. Old payload references cannot name new
   generation content; no automatic full collection replay occurs.

Deletion during async work:

1. Page request captures `{A, identity:X}` and awaits index work.
2. Session is deleted/rematched; authoritative identity becomes absent/Y.
3. Handler rechecks identity, returns explicit gone/conflict, not old descriptors.
   Client cancels that browsing identity without altering terminal draft state.

## Validation gates and rollout

- Protocol tests assert no full media arrays in every live message and reconnect
  snapshot. Byte budgets depend on visible session count, not media count.
- Index tests cover append, deletion, same-size rewrite, truncate/regrow, late
  subagent discovery, timestamp fallback, worker restart, cache eviction,
  oversized labels/URLs, cursor expiry, and requests racing reassociation.
- Client tests cover count changes without new items, new items at unchanged
  count, first hydration without a false notification, stable open-page position,
  stale responses, cancellation, page errors, and bounded cache/render growth.
- Preserve library detail/PR links, rename, kill, hibernate, wake, rematch,
  pending-kill fencing, terminal ownership/resize, and recovery-draft tests.
- Re-run the compiled 23-window production-sized fixture against baseline and
  candidate at the same rates and update schedule. Require zero payload-induced
  reconnects, all matched heartbeats, explicit terminal input delivery, and
  measured snapshot/summary/page bytes. Do not count a timeout increase as a fix.
- Add scenarios with a media panel open, simultaneous large images and terminal
  output, slow HTTP responses, two clients, background/resume, and tab reload.
  Shape HTTP as well as WebSocket traffic; the earlier proxy shaped only WS.
- Chromium and WebKit automation plus native iOS Simulator on M5P. Physical
  cellular Safari remains a later validation gap, not a simulator guarantee.
- Validate old tab/new server and new tab/old server behavior explicitly. A new
  client cannot negotiate after the server has already sent the large snapshot;
  select protocol before initial delivery (upgrade query/subprotocol or separate
  endpoint) and forward it through the relay. User accepts requiring a reload.
  Implement a minimal upgrade-notice connection for legacy clients, not the old
  full catalog: handle pings to prevent retry storms and use message forms those
  clients actually display. Current generic error banners vanish after six seconds,
  so one error followed by a close is insufficient. Verify visible reload guidance,
  terminal-readiness/input behavior, bounded notice traffic, and draft preservation
  with the actual old frontend. Do not claim a special close code alone can teach
  old JavaScript new behavior. New clients support an explicit update-required state.
  Rollback is also a compatibility case: a new client must not repeatedly retry or
  silently accept an unsupported old protocol.

Suggested implementation slices: (1) summary/index contracts and bounded media
API, (2) paged media client and compatibility handshake integrated end to end,
(3) workload and iOS lifecycle validation, (4) separately justify any catalog
coalescing or dual-socket change. Keep incomplete protocol/client slices behind
an explicit capability boundary until both sides work together.
