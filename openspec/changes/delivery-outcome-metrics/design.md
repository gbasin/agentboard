# Design

## Context

For motivation, see proposal.md › Why. Its figures and the per-repository counts that follow were supplied by the original author and are unverified: no live database, backup, or timing was read for this design, and none may be until a separate authorization (D9).

Today's metrics pipeline works like this:
- `loadMetricsInputs` (`src/server/metrics/metricsQuery.ts`) reads SQLite inside one read transaction. Its cohorts come from in-range events (first `done`, status events, results, findings), and its projections carry no `openspec_change`, `plan_change`, or `commit_ref`.
- `computeMetrics` derives every family purely, for the window and for the preceding window, at `inputs.end`.
- `MetricsReader` caches one read per (team, window, slice) for 30 s, always ending at the read time, and returns the stored `ProcessMetrics` as is on a hit (`computeMetrics.ts`). Nothing re-derives any state at return time today.
- The Metrics tab, `team_metrics`, and report snapshots all share that reader.
- Definitions, guards, and the sample threshold are constants in `src/shared/processMetrics.ts`. `tokens_total` is a sum whose `n` is the usage rows: with no rows it reads value 0 with `n` 0, and `docs/operations/process-observability.md` states that missing usage is excluded rather than zero.

There is no git input and no push path to the attention queue. `WorkspaceRead.snapshot` (`src/server/team/workspaceRead.ts`) is synchronous and folds the `ATTENTION_SOURCES` over one `AttentionInput`. `WorkspaceConnections` owns the workspace subscriptions and coalesces `publish(teamId)`.

Git: `runGitAsync` (`src/server/git/gitCommand.ts`) is the read-only runner. It kills a call at its timeout and resolves it as a non-success with a null exit code, and it clips a successful stdout at `maxOutputBytes` (1 MiB by default) without saying so. Result checks already treat `refs/remotes/origin/HEAD` as the base "as last fetched".

Export: `registerMetricsRoute(app, service, env)` (`src/server/metrics/export/route.ts`) constructs its own `MetricsSnapshot`. `bootstrap.ts` calls it with `chatSessionManager.observations`. `agent_tokens_total` carries the turn dimensions plus `kind`.

## Goals / Non-Goals

**Goals:**
- Delivery facts become one derivation from one pinned head, consumed by metrics, rules, the tab, and the export alike (oracle hazard "several readers disagreeing on derived state").
- Metric computation stays pure and synchronous. Git runs only in a refresh step outside the SQLite read.
- A fact Kawai cannot establish reads unavailable or unknown, never 0, never landed.
- Currentness is decided once, by the return-time projection over the live ref state (D2), on every live return including cache hits; identity never stands in for it.
- Every rule reads complete evidence on both sides or does not evaluate (D4); existing metrics keep their legacy semantics (D3a).
- Agent reads become small enough to use.

**Non-Goals:**
- No delivery metric is sliceable. All are team-side.
- No per-PR identity from GitHub. Integrations are first-parent commits, read without `gh`.
- No claim about when an observer learned a fact. Committer time is a proxy for arrival, and a trend point is a recomputation (D6).
- No change to `process-observability`'s contracts, its acceptance cohorts, or its pending integrations (D8).

## Decisions

### D1 — Facts come from one pinned head, read whole

**Head.** `DeliveryFactsReader` (`src/server/metrics/delivery/gitReader.ts`) resolves the head H without a process, reading text under the team's git common directory, as `repoFacts.ts` reads config:
- `refs/remotes/origin/HEAD` holds either `ref: <name>` or a hex object id (40 or 64 digits).
- A symbolic name is followed for at most 5 hops. Each hop reads the loose ref file first, then `packed-refs` (comment lines and `^` peel lines skipped). A loose ref wins over a packed one.
- A missing `refs/remotes/origin/HEAD` gives `unavailable: no-default-branch`, whose text names `git remote set-head origin --auto`. A directory with no git common directory gives the same reason and spawns nothing.
- Malformed content, a sixth hop, a loop, or a name found neither loose nor packed gives `unavailable: default-branch-unreadable`.
- A `shallow` file in the common directory gives `unavailable: history-incomplete:shallow` without spawning git.

**Reads.** Every git call names the literal object id H, never a ref, so a fetch during a refresh cannot mix heads. Each runs at the main checkout through `runGitAsync` with `cleanGitEnv`, `git --no-replace-objects -c log.showSignature=false`, a 10 s timeout, and `maxOutputBytes = DELIVERY_READ_BOUND` (64 MiB). There are two reads:
1. **Graph.** `git log --format=%H %ct %P H` loads H's whole history. There is no `--since` and no horizon: `--since` stops a walk at an old-dated commit and would hide newer ancestors behind it.
2. **Archives.** `git log --first-parent --no-renames --diff-filter=A --name-only --format=@%H H -- 'openspec/changes/archive/*/proposal.md'`. `--first-parent` implies first-parent diffs for merges. `--no-renames` makes an archive done by `git mv` read as an addition whatever `diff.renames` says.

The lifetime integration count is the first-parent chain length derived from read 1, so it is pinned with the rest. No `rev-list --count` and no `merge-base` runs.

**Completeness (Table F).** A read is accepted only when:
- it exits 0;
- its stdout is shorter than `DELIVERY_READ_BOUND`, so a clipped output is never read as history;
- every row parses;
- read 1's first row is H, and every parent it names is itself a row. Truncation always drops some commit whose children remain, so this closure check detects any lost tail and any missing object;
- every `@<sha>` of read 2 lies on read 1's first-parent chain, and every path matches the archive pattern.

Any other outcome fails the refresh with a named reason. A non-zero exit, a null exit (timeout or kill), and a spawn failure are all failures; none means "not contained". A history past the bound is `history-exceeds-bound`, never a partial answer. Raising the bound is a reviewed constant change.

**Commit refs** (`resolveResultCommit`, pure) accept only a canonical full literal object id. Its length is set by the repository's actual object format, read as text from the common directory's `config`: 64 hex digits when `extensions.objectformat = sha256`, else 40. Then:
- A literal in H's graph has a known identity and the landing of its position (D3).
- A literal not in H's graph has a known identity only when the same result has corroborating check evidence. That means a `team_task_result_checks` row of the same team, task, and result with `status = 'done'` and `facts.version = 1`, whose `facts.commit.status` is `'pass'`, whose `facts.commit.given` equals the literal `commit_ref`, and whose `facts.commit.sha` equals the same full id. Every field consumed is validated by the metrics read itself, because `ResultCheckStore.parseFacts` only tests the version and casts. The evidence records the check's id, `seq`, and `finished_at`. Such a commit is known and not landed.
- Everything else is **unresolvable**:
  - an abbreviation or symbolic text, even when a check later resolved it;
  - a literal of the wrong length;
  - an off-graph literal with no such check, or with a pending, unavailable, failed, malformed, partial, or other result's check;
  - a literal with two contradictory checks.

  It is never counted as landed, never as known-not-landed, and is excluded from `landed_result_share` and counted in its coverage note.

No prefix search, no read-time ref resolution, and no new checker run happen for a metric read. A metric read never treats a passing commit fact as an accepted result or passing tests.

Alternative considered: keep a 98-day `--since` graph with a `merge-base --is-ancestor` fallback. It loses in-window integrations behind old-dated commits, adds an exit-code ambiguity (exit 1 = not an ancestor, other non-zero = error), and reports "landed, time unknown", which cannot answer "contained by T". The whole graph is bounded by the closure check and the byte bound instead. Its size and time on any real repository are Unknown until measured under D9.

Alternative considered: resolve abbreviations by a unique prefix among H's ancestors, or through the earliest check that resolved them. A prefix unique in H's graph can still be ambiguous in the repository (commit C landed, an unmerged D shares the prefix), and a later check can resolve a moved name. Both were rejected.

### D2 — Immutable facts, live ref state, and one return-time projection

Three kinds of state are kept apart. Identity never stands in for currentness.

**G, an accepted facts generation (immutable).** Its identity is (team's repository, actual object format, H, `DELIVERY_READER_VERSION`). It holds read 1's graph and read 2's archives for H. The facts depend on H alone, so the fetch stamp is not part of it. `DeliveryFactsCache` (`delivery/factsCache.ts`) holds per team at most one accepted G, and consumers never see a half-built one.

**S, the live ref state.** `refState(team)` re-reads S on every call by bounded, synchronous, process-free file reads in the common directory (D1's head resolution plus a stat of `FETCH_HEAD`). It holds:
- `hNow`: a full id, or `unreadable` / `shallow` with the reason. It is freshly resolved, never a cached pending fallback;
- `fetchAt`: `FETCH_HEAD`'s mtime, or unknown;
- `lastAttempt`: the head, outcome, reason, and time of the most recent NONOBSOLETE completed attempt (Z3 or Z4). Its current relevance is still filtered by its target head.

**M, a materialization (cached numbers).** These are a computed `ProcessMetrics`, trends points, or a monitor evaluation. M carries its provenance (G's identity, the end T, `materializedAt`, and its evidence, D3a) and its `maxAge`: 30 s for metrics reads, 5 min for trends, two timer intervals for the monitor. M holds no live header. Rule results inside M are a pure function of M's numbers and evidence.

**The recovery controller** (Tables Q, Z, and CT; the canonical model of Lead note-44b3a9d2).

Invariant: one accepted immutable G, at most one flight, and all new flight decisions go through ONE reconcile function using a fresh ref read. A matching accepted G is reused, never re-read just because an obsolete flight completed or a fetch stamp changed. A transient failure of a NEEDED current head has an explicit retry path without an unrelated ref move or restart. Only a successful nonobsolete complete read publishes facts or clears that head's failure; failed/partial/obsolete reads never create a G.

State: stopped flag; accepted G or none; flight {id, target} or none; retry record {head, failureCount, dueAt} or none; `lastAttempt` for the most recent NONOBSOLETE completed attempt. Backoff = 30 s, 120 s, 600 s capped; a failure for the same retry head increments its chain, a different failed head begins 1. A successful accepted attempt clears its retry. Keep no queue of stale pending heads; when an event needs dispatch, resolve the actual ref again. A backoff record for a head is irrelevant to another head and never blocks reuse of accepted matching facts. One owned retry wake re-enters reconcile with a fresh ref at due; a ref change or check may re-arm it for the actually needed target. `stop()` cancels owned timers and ignores all later completions.

`check(team)`, the retry wake, and every completion's follow-up run the reconcile table Q (rows disjoint, first match). A completion is classified by the completion partition Z. Both tables are in the acceptance oracles.

- A same-head fetch updates live `fetchAt` and re-arms the freshness wake only; it cannot mint facts or bypass these rows.
- A user Metrics refresh may recompute M; it does not re-read immutable matching-H facts.
- A `DELIVERY_READER_VERSION` change is a new identity and a cold controller, not a hidden same-identity revalidation.
- Facts are never patched with partial results.

**Reachability.** Q3 prevents starting a flight for an already accepted matching G, and G cannot change while a different sole flight runs. A flight starts only for an identity that differs from the accepted G. If its completion's target matches the current ref and fails (Z4), that target still differs from G. If the ref reverted to G, the completion is obsolete and discarded (Z2), and Q3 reuses G. If a target that failed earlier is later accepted, its accepting completion records success (Z3). Therefore, in valid controller states, a FAILED nonobsolete `lastAttempt` for the SAME identity as the accepted matching G is unreachable. Failures stay visible:
- no G → `unavailable` plus the refresh-failed reason for the named head;
- G at A, current ref B, and B failed → `behind` plus the refresh-failed reason until B succeeds.

A failed B record does not poison a returned accepted A after the ref reverts.

**The projection.** `view(M, G, S, now)` (`delivery/view.ts`, pure) runs on every live return: Metrics tab reads, `team_metrics`, trends, export scrapes, workspace snapshots, and the monitor's outcome. It runs on cache hits too, and for a chosen past end or a trend point alike. Its `state` is the first match:
1. `unavailable` — no accepted G, `hNow` unreadable or shallow, or M was made under no G;
2. `behind` — `hNow` ≠ the H of M's G, or M's G is no longer the accepted one;
3. `stale` — `fetchAt` unknown, or `now − fetchAt ≥ 24 h` (inclusive boundary);
4. `refresh-failed` — `lastAttempt` is for `hNow`, matches M's G, and failed. This is a pure defensive fail-closed branch for invalid or synthetic input only. It is unreachable from the controller (Reachability above), and no real-data promise depends on reaching it;
5. `expired` — `now − M.materializedAt > M.maxAge`. The caller recomputes rather than serve it as current;
6. `current`.

Every applicable condition is also listed in `reasons`, so a behind generation whose needed head failed shows `behind` with the refresh-failed reason, and a cold failure shows `unavailable` with it. Only `current` makes rule results eligible, for an attention item, a rule gauge, or a trend mark. Every other state returns the numbers with the marker and every rule as "not current: <state>". Unknown is never current.

The monitor owns one freshness wake at `fetchAt + 24 h`, exactly the boundary at which `stale` becomes true. With an otherwise fresh M, 1 ms before it the view is current; at it, the view is stale and the removal is published; 1 ms after it, the view stays stale without another event. A later same-H fetch cancels and re-arms the owned wake. A stale old callback must re-read the actual `fetchAt` and its owner token, and never clears a fresh item. Unknown `fetchAt` is immediately stale. This is the freshness clock only; event membership (D3) stays half-open.

A stored report snapshot is not a live return. It keeps whatever header it was frozen with and is never re-projected.

**Derived caches** key on (G's identity, query). The projection, not the key, decides currentness. A cache hit after a ref move therefore returns `behind`, and a hit after the stale crossing returns `stale`, both without recomputing.

This is new behavior, not a property of the base cache, which returns stored values directly.

The cache is memory only. A restart starts cold (Q5 with no G), and nothing is persisted or recovered.

Alternative considered: make `MetricsReader.read` async and run git inline. `WorkspaceRead.snapshot` and the attention fold are synchronous and push often, so every snapshot would wait on git. That was rejected.

### D3 — Landing is a pure walk by first-parent position

`landingPositions(graph, H)` (`delivery/landing.ts`, pure) derives the first-parent chain F₁…Fₙ from H (oldest first). For k = 1…n, a breadth-first walk from Fₖ through all parents stops at commits already reached and stamps each newly reached commit with **position k**. A commit is landed exactly when it has a position. Its landing carries:
- `at = ct(Fₖ)`, the committer time of its position, as a timestamp proxy. It is never a minimum over other chain commits' times;
- `bound = max(ct(F₁…Fₖ))`, the latest committer time at or before its position.

The landing's time is uncertain within **U = [at, bound]**, with `at ≤ bound` always. Committer time is a stated proxy. Nothing here proves when a commit actually arrived.

Two questions are answered separately, for result commits, integrations (Fₖ itself), and change landings alike.

**Contained by T** (inclusive, for result landings and in-flight status):
- `bound ≤ T` → contained;
- `at > T` → not contained;
- otherwise unknown.

**Member of an event interval [a, b)** (half-open, for every count in a window):
- `a ≤ at` and `bound < b` → in;
- `bound < a` or `at ≥ b` → out;
- otherwise unknown.

For span d at end T, the current interval is [T − d, T) and the baseline is [T − 2d, T − d). Containment never supplies membership: an event can be contained by T yet of unknown membership.

**No double count:** membership in [a, b) needs `bound < b`, and membership in [b, c) needs `at ≥ b`. With `at ≤ bound`, no event is in two adjacent intervals.

Witnesses, with t = at = bound for a monotonic chain (Table I):
- t = T − d is in the current interval and out of the baseline.
- t = T is out of the window ending T, though contained by T, and in the window ending T + d.
- t = T − 2d is in the baseline.

A backdated F₂ at T − 3d after F₁ at T − d + 1 h has U = [T − 3d, T − d + 1 h]. Its membership is unknown in both the current interval and the baseline, while its containment by T is known.

An unknown is excluded from the count, which keeps the legacy-style value, and is recorded per side in the evidence (D3a). There it makes every rule that reads that count not-evaluable (D4).

**Change landings** come from read 2. The directory `<date>-<name>` gives the name, and its first chain position (the oldest `@<sha>`) wins, with that position's `at` and `bound`.

### D3a — Facts enter the metrics as an input, with complete linked history

`MetricsInputs` gains `delivery: DeliveryView | null`, where the view holds the accepted generation's landings and chain with its identity, and no live ref state (D2). `computeMetrics` stays pure and gains `deliveryObservations(ctx)` (`delivery/observations.ts`), which emits:
- `changes_landed` and `integrations` (sum);
- `tokens_per_landed_change` (ratio: `tokens_total` as numerator, changes landed as denominator, `n` = changes landed);
- `change_cycle_time_p50/p90`, `tasks_per_landed_change` (mean), and `review_rounds_per_landed_change` (mean);
- `landed_change_link_coverage`;
- `inflight_change_age_p50/p90`;
- `landed_result_share`, which is in the coverage family.

**Linked history.** `loadMetricsInputs` gains one phase inside its existing read transaction. It loads every team task whose `openspec_change` or `plan_change` is set and that was created before the read's end, whatever its events, with all of its status events, its results with `commit_ref`, and its findings. `MetricTask` gains `openspecChange` and `planChange`, and `MetricResult` gains `commitRef`. This covers:
- an old task with no event in either window whose change lands now;
- a change landed today that was in flight at the baseline's end;
- every end of a trend range.

These tasks feed only the delivery observations. The existing families keep their cohorts unchanged.

**Status at T** is the `to_status` of the task's latest status event at or before T, else `open` from its creation. A task created after T does not exist at T. A status that comes from a backfilled row (`from_status` null), or a T before the team's first recorded status event, makes the derived in-flight values approximate.

**Rules per metric:**
- A change is **linked** to a landing when at least one task naming it was created before the landing's `at`.
- Tasks per landed change counts those tasks.
- Review rounds per landed change counts findings created before `at` on those tasks' results.
- Cycle time runs from the first such task's creation to `at`.
- A change is **in flight at T** when its landing is not contained by T and one of its tasks is open, active, or blocked at T. An unknown containment is excluded, not counted as in flight. Its age runs from its first task's creation.
- `landed_result_share`, for the tasks first done in the window that have a result, takes each task's newest result created before T. The share counts the contained-by-T commits among those whose identity is known and whose containment at T is known. Unresolvable identities and unknown containment are excluded, and the coverage note counts them.

**Unavailable.** When `delivery` is null or unavailable, every delivery metric has `value: null`, `n: 0`, and a new optional `unavailable: string` on `MetricValue`. `ProcessMetrics` gains `delivery: { head, objectFormat, readerVersion, readAt, materializedAt, unknownAtEnd, unresolvable }`, the identity and provenance only.

The live header `{ state, reasons, fetchedAt }` is added by the projection at return (D2). It is never stored in M, and a stored report keeps the header it was frozen with.

**Legacy semantics are unchanged.** Every existing metric keeps its cohort, value, `n`, `baseline`, `insufficient`, `approximate`, and `partial`, including the existing `usageHorizon` (`max(end − 90 d, first team turn)`, `metricsQuery.ts`). The only exceptions are the two guard changes below. Table K8 holds byte for byte at `end = now`.

**Evidence (additive).** Each delivery and token metric gains `evidence: { current, baseline }`, each side `{ complete: boolean | 'unknown', unknown: number, reasons: string[] }`. A side is incomplete when any input it uses has:
- an event of unknown membership in that side's interval (archives, integrations);
- an unknown containment at that side's end (in-flight sets);
- an unresolvable result identity (`landed_result_share`);
- approximate status history;
- source coverage that is not established for that side's required span.

The required span is derived per metric and per side for span d:
- `tokens_total` and `tokens_per_landed_change`: [T − d, T) and [T − 2d, T − d);
- `tokens_per_task`: each cohort task's lifetime from its `createdAt` to T;
- `limit_tax_hours`: the side's interval extended back by the source's 24 h lookback.

No universal 14-day horizon exists, and 1d and 3d reads need only their own spans.

Evidence is what rules (D4) and trend marks consume. It never rewrites a legacy flag.

### D3b — Source coverage is a producer-owned input, not yet available

Whether a usage or limit source recorded continuously over a required span is not established by any current producer.
- `schema_migrations.applied_at` records when a migration ran, not coverage, restore gaps, or writer success.
- `chat_turn_usage` has no row for missing usage.
- `LimitEventStore` records and prunes events, not a covered interval.
- `ObservationRecorder`'s recording start covers its own observations, not the legacy tables.
- The first row, another stream's health, or a table's existence prove nothing either.

So the consumer treats coverage as an **input** named `SourceCoverage`. `MetricsInputs.coverage` maps each source id to `{ status: 'supported' | 'unknown', intervals, gaps, throughAt, retentionFrom, provenance }`. `computeMetrics` reads it and nothing else for that question:
- `supported` over the whole required span makes that part of a side complete;
- anything else makes it `unknown`, and every dependent rule is not-evaluable.

`retentionFrom` is an availability bound only, never a complete bit.

**Unmet prerequisite (blocking).** No producer supplies `SourceCoverage` today, and this change does not build one: no ledger, migration, source hook, or backfill, and no change to `process-observability`. Until an approved, source-backed producer contract exists, the production composition passes `coverage` as unknown for every source. Every token- and limit-dependent rule is then not-evaluable on real data: `delivery-drop`, `cost-per-change-rise`, and the trend marks for token and limit metrics.

The consumer branch is fully specified and testable with fixture coverage. Real-data alert implementation is **not ready**.

The producer contract that must be approved before it is ready names:
- **Owners:** `TurnUsageTracker` / `ChatTurnUsageStore` for `chat_turn_usage`, `LimitEventStore` for `profile_limit_events`, and any further history source a rule turns out to need.
- **Scope:** the exact accounting and version, and the team, profile, and provider scope the consumer may use.
- **Coverage claims:** supported intervals as distinct from unknown spans and gaps, with a through-time watermark and the producer's provenance.
- **Retention:** the effective retention or availability bound, separate from coverage.
- **Semantics:** for writer failure, missing measurement, restart, and backup restore or reset. Absent continuity proof becomes unknown or a gap, never an earlier onset or "complete".
- **Binding:** how the metrics read binds the coverage evidence and its provenance to its materialization and to each side's interval.

Alternative rejected: derive a recording start from `schema_migrations.applied_at` and the retention history. It bounds availability at best, and it cannot see restores or failed writes.

`METRIC_FAMILIES` gains `delivery`, listed first. The guard of `lead_time_p50/p90` changes to `landed_result_share`. `tokens_per_landed_change` is guarded by `reopen_rate`, so splitting a change to cut its cost shows up as rework. No existing metric's definition changes.

The determinism requirement now holds per (team, window, slice, end, G's identity, coverage input), with the projection applied at the same S and `now`. Both surfaces read the same generation through the same reader, so they still agree.

### D4 — Degradation rules are a constant table of total predicates

`DEGRADATION_RULES` (`src/shared/degradationRules.ts`, pure) is evaluated by `evaluateDegradation(metrics7d)`. Each rule returns exactly one of:
- `fires` with its evidence (current and baseline values);
- `holds-not`;
- `not-evaluable` with the first failing input condition.

`evaluateDegradation` is pure over M's numbers and evidence. Whether a result is shown is the projection's decision (D2): only a `current` view makes `fires` eligible.

Input conditions are checked in order, and the first failing one is the `not-evaluable` reason. **Evidence** comes first: the evidence (D3a) of every count the rule reads must be complete on both the current and the baseline side, which includes source coverage (D3b). This is conservative. No bound inference repairs an unknown, and a coverage note never does.

A rule never reads a missing usage record as 0. Write lc/lb for current and baseline changes landed, ic/ib for integrations, tc/tb for tokens, and xc/xb for tasks per landed change. Every comparison is exact integer or rational cross-multiplication:

| id | evidence complete on both sides for | then required, else `not-evaluable` | fires when |
|----|-------------------------------------|-------------------------------------|------------|
| `delivery-drop` | changes landed, integrations, `tokens_total` | lb ≥ 10; ib ≥ 1; tb > 0 | 5·lc ≤ 3·lb, and 10·ic ≤ 7·ib, and 5·tc ≥ 4·tb |
| `cost-per-change-rise` | changes landed, `tokens_total` | lc ≥ 3; lb ≥ 10; tb > 0 | tc·lb ≥ 2·tb·lc, and `delivery-drop` is not `fires` (`holds-not` or `not-evaluable`) |
| `convergence-drift` | linked landed changes, link coverage | linked ≥ 5 on both sides; coverage ≥ 0.5 on both sides | xc ≥ 2·xb |
| `inflight-aging` | in-flight sets at both ends | n ≥ 3 on both sides; neither side approximate; baseline p90 > 0 | current p90 ≥ 72 h, and current p90 ≥ 2 × baseline p90 |

The thresholds are constants. Moving one is a reviewed code change, never configuration, and never done to make a chosen historical window fire (D9).

`DeliveryRuntime` (`src/server/metrics/delivery/runtime.ts`) is one per manager. It owns the facts cache and the `DegradationMonitor` (`delivery/degradationMonitor.ts`) and is the one lifecycle owner of delivery refresh:
- The manager starts it after boot, as it starts the supervision monitor, and stops it at shutdown. Stopping clears every timer and discards later completions.
- `bootstrap.ts` passes it to `registerMetricsRoute(app, observations, env, delivery)`. When the route reports itself enabled, bootstrap calls `delivery.enableExport()`.
- **Export enabled:** an unref'd 60 s timer runs `check` for every registered team and re-evaluates the rules, independent of any browser, subscription, or tool call. Registered teams are the distinct team ids of `team_tasks` and of non-killed chat sessions, each resolved to its main checkout. The first pass runs at start.
- **Export disabled:** the same timer is armed only while the team has at least one subscriber. `WorkspaceConnections` open, close, and disconnect, and the metrics and trends subscriptions, report reference counts to the runtime. At zero subscribers the timer is cleared.
- Re-evaluation also runs on a generation change and on a Metrics refresh.

**Publication.** The monitor keeps, per team, one materialized outcome M: G's identity, the evaluation time, every rule's result, and an evidence fingerprint (rule results plus their evidence values). It calls `WorkspaceConnections.publish(teamId)` whenever the fingerprint changes or the projected state changes, not only when the fired ids change. It owns the freshness wake at `fetchAt + 24 h`, cancelled and re-armed whenever `fetchAt` moves; an old callback re-checks the actual `fetchAt` and its owner token (D2).

**Gating.** Every synchronous consumer reads the outcome through `delivery.outcome(team, now)`, which is `view(M, G, refState(team), now)`. Rule results are eligible only when that view is `current`. Otherwise it returns "not current: <state>" with every reason, which covers unavailable, behind, stale, expired (an outcome older than two intervals), and the defensive refresh-failed branch, with a needed head's failure stated as a reason. So a stale, failing, obsolete, or aged outcome never keeps an item or a gauge alive.

`degradationItems` joins `ATTENTION_SOURCES` with kind `process-degradation`, owned by the human. It is fed by a new `AttentionInput.degradation`. Its link is `{ kind: 'metrics', id: '7d' }`, a new `AttentionLink` kind, which the client opens as `#/team/<key>/metrics/7d`.

Alternative considered: store fired episodes for one toast per episode. The item identity `process-degradation:<rule>` already gives one toast per client session while the rule holds. Storing episodes would add a table and recovery-matrix rows for little gain, so it was rejected.

### D5 — Compact reads extend `bounded-metrics-and-task-get`'s projection

The compact agent reads moved to the change `bounded-metrics-and-task-get` (its D1–D4), which lands first:
- `compactMetrics`, the `metrics` argument of `team_metrics`, `process_reports_list` without snapshots, compact `process_report_get` and `process_report_submit`;
- drill lists capped at 50, sorted by id, with totals and cursors paged by `team_metrics_drill`;
- the end-keyed `MetricsReader.readAt`.

That change has no `full` flag: every drill entry is reachable by paging.

This change extends the projection, and nothing else about the compact reads:
- `compactMetrics` also keeps `unavailable` and its reason, `evidence`, and the whole `delivery` header, including the projected live header of a live return. The new delivery metric ids are valid `metrics` values and drill cursors.
- The reader key gains G's identity on top of `end` (D4 task 2.3), so a live drill cursor's pages are computed over the generation and end of the read that issued it.
- Stored snapshots are never rewritten and never re-projected: a frozen report keeps the header and evidence it was submitted with.
- Readers treat a missing metric id, or a missing `delivery` or `evidence` field, in an old snapshot as absent.

### D6 — Trends recompute the 7d read at past ends

`computeMetrics` gains an explicit `end` (today it reads `inputs.end`). `readTrends(team, range)` (`src/server/metrics/trends.ts`) works in four steps:
1. It takes the current accepted generation once.
2. It loads `MetricsInputs` once over `[now − (weeks + 1) × 7 d, now]` with that generation's view. `loadMetricsInputs` already takes `from`/`end`, and the extra week is the first point's baseline.
3. For each point end `end_k = now − k × 7 d` (k = 0…weeks−1), it calls `computeMetrics(inputs, '7d', null, end_k)` and `evaluateDegradation` on the result.
4. It projects every point through `compactMetrics`.

Landings count at `end_k` by D3's membership and containment rules, with each point's own current and baseline intervals. A point is what today's records and today's generation say about that end. It is **not** what anyone could have read then: a late fetch, a history rewrite, a backdated commit, or a late result changes past points, and the view says "recomputed at <time> from <head>".

A point's rule marks are M's results for that end. They are shown only while `view` of the whole trends read is `current` at return (D2). Freshness, staleness, and failure are today's.

A point's metric is marked **incomplete evidence** when its evidence is incomplete on either side (D3a, D3b). That marker is separate from the legacy `partial`, which is unchanged.

`TrendsReader` caches one read per (team, range, G's identity) for 5 minutes (`maxAge`), and a Metrics refresh drops it. Every hit is projected at return. A 12-week read is 12 computations over one load. Its time on a real database is Unknown. Task 9.2 measures it on the deterministic fixture only, and a slow result is fixed with a longer cache, never different semantics.

**Protocol:**
- `process-metrics-trends-open { teamPath, range }` → `process-metrics-trends { teamId, range, points, delivery, computedAt }`, and `process-metrics-trends-close`, all in `CHAT_CONNECTION_TYPES`.
- The snapshot is re-sent on open, on refresh, on a generation change, and on a change of the projected state or its reasons (unavailable, behind, stale, expired, current, a failed-read reason).
- `process-metrics-open` gains an optional `end` (ISO), so choosing a point opens exactly that window. The connection keeps the subscription's `end`: refreshes and generation re-sends read at that `end`, and a new `process-metrics-open` replaces it. Without `end`, a read is unchanged.

**Client:** `MetricsTrends.tsx` draws SVG small multiples with no dependency. There is one chart per metric with its family heading, a band for `insufficient`, `partial`, and incomplete-evidence points, a mark for fired rules, and a `<table>` alternative per chart. `teamLocation.ts` parses `metrics/trends/<range>`; `trends` is not a window id, so the existing window parse keeps its meaning. The range and collapsed families are per-team `teamWorkspaceStore` state, as windows are today. The `dataviz` and `dev-browser` capabilities this view's verification names are prerequisites (D9).

Alternative considered: store a daily snapshot and chart it. That adds a table, retention, and a second derivation that can drift from the live one (oracle hazard "several readers disagreeing"), so it was rejected. The stored snapshot would also only record what one server observed, which this view does not claim.

### D7 — The Prometheus export reads the same generation, recomputing totals

`registerMetricsRoute` gains an optional fourth parameter, the `DeliveryRuntime`, which it passes to `MetricsSnapshot` as a seam `{ view(teamId, now), outcome(teamId, now) }`. Both are D2 projections computed at the scrape. The seam is synchronous and never runs git. Inside the snapshot's existing read transaction, each registered team gets:

| family | type | value |
|--------|------|-------|
| `delivery_facts_available` | gauge | 1 with an accepted generation, else 0 |
| `delivery_integrations_total` | counter | the generation's first-parent chain length |
| `delivery_changes_landed_total` | counter | the generation's change landings over full history |
| `delivery_change_cycle_seconds` | histogram, `DURATION_BUCKETS` | each landed change with linked tasks, over full history |
| `delivery_change_tasks` | histogram, buckets 1, 2, 5, 10, 20, 50, 100, +Inf | same cohort |
| `delivery_change_review_rounds` | histogram, buckets 0, 1, 2, 5, 10, 20, 50, +Inf | same cohort |
| `delivery_inflight_changes`, `delivery_inflight_oldest_age_seconds` | gauge | now |
| `delivery_facts_stale`, `delivery_fetch_age_seconds` | gauge | S projected at the scrape |
| `delivery_rules_current` | gauge | 1 when the projected `outcome` is `current`, else 0 |
| `degradation_rule_firing` | gauge, label `rule` | 1 for a rule that `fires` in a projected-current outcome, else 0 |

With no accepted generation, the team exports only `delivery_facts_available 0`. The linked-task histograms read team tasks and findings inside the snapshot's transaction.

Labels are `team` (the existing persistent alias through `BoundedLabels`) and `rule`, whose values are enumerated from `DEGRADATION_RULES`. No change name, branch, commit, path, or task id is ever a label.

Until a producer coverage contract exists (D3b), the token-dependent rule gauges read 0 on real data, because those rules are not-evaluable.

The totals are recomputed from records that are never pruned: git history, and team tasks and findings, which have no pruning. So they need no `ExportAccumulator` row and survive restarts by construction, once the first post-restart generation is accepted. A history rewrite lowers them, and Prometheus treats that as a counter reset. The registry adds definitions only, so `DEFINITION_VERSION` stays 1, and no existing family changes.

**The PromQL ratio is approximate.** `sum by (team) (increase(kawai_agent_tokens_total[7d])) / sum by (team) (increase(kawai_delivery_changes_landed_total[7d]))` sums every token kind and turn dimension per team. It divides increases as observed at scrape time:
- tokens advance when turns are reconciled;
- landings advance when a fetch is discovered, all at once after warm-up or after a late fetch;
- a rewrite reads as a reset;
- tokens have the observation coverage limits of `process-observability`.

So it approximates, and does not equal, the read-time `tokens_per_landed_change`, which uses committer-time windows. Exact historical windows stay Kawai's own read.

Alternative considered: accumulate through `ExportAccumulator` like turn tokens. Those totals are kept because their source rows are pruned. Delivery sources are not pruned, and accumulating would add a second truth that could diverge from git, so it was rejected.

### D8 — Delivery is evidence, never a decision input or acceptance

Delivery facts, metrics, and rule results are outcome and guard evidence only:
- No dispatch, routing, staffing, execution, landing, or acceptance path reads them, directly or through another module.
- Landing never accepts a result.
- A landed commit is not a first durable acceptance fact for `process-observability`, whose acceptance cohorts and mechanisms stay as that change defines them.

The boundary is checked behaviorally (Table N) at the real composition seams. The import guard is a second, supplementary check.

### D9 — Validation uses deterministic fixtures; real data needs its own authorization

Thresholds and behavior are validated only on sanitized deterministic fixtures:
- a temporary git repository built with `cleanGitEnv`, with fixed committer times;
- `metricsSeed.ts` rows with fixed UTC instants;
- a declared schema version and fixed read ends (`2026-10-27T00:00:00Z` and the four weeks before it), passed as `now`, never taken from the clock;
- an explicit synthetic `SourceCoverage` input per case: `supported` over the spans a case declares, and `unknown` or gapped where a case tests suppression. It is never derived from migration rows or the fixture database's timestamps.

The calibration cases (Table CAL) are declared in the test before its thresholds are read, and they are separate from the spec scenarios, so neither is tuned to the other. No step copies or reads the live database, its WAL or journal, or a backup. Any check on real data needs a separate explicit authorization and would use the existing consistent, integrity-checked, private backup procedure (`docs/operations/database-backups.md`), with private rows, paths, and credentials kept out of journals and results. This design prescribes none. The original author's historical counts, latencies, and sizes stay Unknown until such a check runs.

UI verification names two capabilities that are not guaranteed to exist in an implementing session: the `dev-browser` skill (screenshots, per AGENTS.md) and the `dataviz` skill (chart conventions). Their availability is a prerequisite of tasks 2.4 and 7.2. When either is missing, the implementer stops that verification and asks the Lead for a separately reviewed alternative. Neither is installed, and their evidence is never substituted. Backend tasks do not depend on them.

### Acceptance oracles

**Table H: head resolution.** Seam: `resolveHead(commonDir)`.

| id | common dir state | → outcome |
|----|------------------|-----------|
| H1 | no git common directory | unavailable `no-default-branch`, no process |
| H2 | `refs/remotes/origin/HEAD` missing | unavailable `no-default-branch`, naming `git remote set-head origin --auto` |
| H3 | symbolic → loose ref | H = the loose ref's id |
| H4 | symbolic → packed only (with a `^` peel line after it) | H = the packed id, peel line ignored |
| H5 | symbolic → loose and packed differ | H = the loose id |
| H6 | the file holds a hex id | H = that id |
| H7 | malformed text, a loop, a sixth hop, or a target found nowhere | unavailable `default-branch-unreadable` |
| H8 | `shallow` file present | unavailable `history-incomplete:shallow`, no process |

**Table F: read completeness.** Seam: `DeliveryFactsReader.read(H)` with a stub runner that checks its arguments: the literal H, `--no-replace-objects`, `--no-renames`, no ref name, and no `fetch`, `push`, `update-ref`, or `remote`.

| id | runner outcome | → read |
|----|----------------|--------|
| F1 | exit 0, rows close under parents, first row H, archives on the chain | accepted |
| F2 | exit non-zero | failed `git-failed:<code>` |
| F3 | exit null (timeout or kill) | failed `git-timeout` |
| F4 | spawn failure | failed `git-unavailable` |
| F5 | stdout length = `DELIVERY_READ_BOUND` (clipped) | failed `history-exceeds-bound` |
| F6 | a row does not parse | failed `history-malformed` |
| F7 | first row is not H | failed `history-malformed` |
| F8 | a named parent has no row (a dropped tail) | failed `history-incomplete` |
| F9 | an archive `@<sha>` not on the chain, or a stray path | failed `archive-malformed` |

**Tables Q and Z: the recovery controller.** Seam: `DeliveryFactsCache` with a fake reader, ref, `FETCH_HEAD` mtime, clock, and flight ids. G's identity is (repository, object format, H, reader version); the fetch time is never part of it. These rows are the canonical model of D2 (Lead note-44b3a9d2), kept verbatim. Currentness is not decided here; it is the projection's (Table V).

*Table Q, RECONCILE* (rows disjoint, first match; every check, retry wake, and completion follow-up):

| id | condition | → result |
|----|-----------|----------|
| Q0 | stopped | no dispatch/publication |
| Q1 | a flight exists | keep that one flight, dispatch nothing; ref state can still change the projection. No second flight or stale pending-id dispatch |
| Q2 | idle and hNow unreadable/shallow/invalid | no flight; projection unavailable, preserve G |
| Q3 | idle, valid hNow, accepted G identity matches repository/objectformat/H/readerVersion | reuse EXACT G, no git/no new generation, irrespective of retry record for some OTHER head |
| Q4 | idle, valid hNow, G absent or different, retry.head == hNow and now < dueAt | preserve G, wait/own one due wake |
| Q5 | all remaining idle valid cases | start exactly one flight for fresh hNow |

*Table Z, COMPLETION* (Z0 first; for an owned flight, clear it once and freshly resolve hNow before classifying BOTH success and failure):

| id | condition | → result |
|----|-----------|----------|
| Z0 | stopped, or callback id does not match the owned flight | ignore completely |
| Z1 | invalid/unreadable hNow | discard completion as unusable/obsolete, preserve G, no pending-id fallback and no manufactured successful currentness. A later actual check can recover |
| Z2 | valid hNow != flight.target | discard completion as obsolete, for BOTH outcomes; do not overwrite lastAttempt/retry with an irrelevant failure. Call reconcile on fresh state. If hNow matches accepted G, Q3 REUSES it; otherwise Q4/Q5 handle only the actual desired target |
| Z3 | valid hNow == target and complete valid read SUCCESS | accept G for target, lastAttempt(target) = success, clear target retry, publish once; reconcile is now Q3 |
| Z4 | valid hNow == target and read/timeout/validation FAILURE | preserve G, lastAttempt(target) = failed, set/update due backoff and own wake; next reconcile is Q4 then Q5 after due. No failure is turned into a successful result or silent error clear |

Every read outcome of Table F that is not F1 is a FAILURE for Z4; a clipped successful stdout is never a Z3 success.

**Unreachable claims:** a FAILED nonobsolete `lastAttempt` for the same identity as the accepted matching G (D2, Reachability); two flights at once (Q1); a flight started for an identity equal to the accepted G (Q3); a Z3–Z4 completion whose callback id is not the owned flight's (Z0). **Completeness claim:** the Q rows partition every controller state over the axes stopped (yes | no), flight (none | owned), hNow (invalid | valid = G's H | valid ≠ G's H, or no G), and retry (none | for hNow, before due | for hNow, at or after due | for another head); the Z rows partition every completion over stopped, callback ownership, fresh hNow (invalid | ≠ target | = target), and outcome (success | failure). The completeness test expands these axes over the tables and the unreachable claims.

*Table CT, finite controller witnesses* (planned, unexecuted; rows keep the canonical ids T1–T7 and are cited as CT T1–CT T7, apart from Table T's tool rows):

| id | sequence | → required |
|----|----------|------------|
| T1 | accepted A, ref A; check or same-H fetch | same G, no read (Q3); a same-H fetch moves only `fetchAt` and re-arms the freshness wake |
| T2 | accepted A, ref B starts B (Q5); ref A while B runs (Q1); B succeeds, OR B fails | Z2 discards B for either outcome; reconcile Q3 reuses A; no flight for A; no failed `lastAttempt` for A |
| T3 | cold, ref B; B fails | Z4: `unavailable` with the failed reason; no retry before due (Q4); the due wake re-checks ref B and retries B (Q5); success → G = B (Z3), retry cleared, a fresh eligible M |
| T4 | accepted A, ref B; B fails | Z4: `behind` with the failed reason; the due wake retries the same B; success → G = B, current with a fresh M. No new external event or restart is required to clear the failure |
| T5 | during B's backoff, ref A | Q3 reuses A without a read; if the ref returns to B before due, wait the remaining B backoff (Q4); after due, Q5 starts B. The retained B failure never poisons A |
| T6 | obsolete B completes with actual ref C (≠ G) | Z2 → reconcile flies C only (Q4/Q5); with an unreadable ref, Z1: no cached pending-target spawn; with the ref restored to the matching A, Q3 reuses A. At most one active flight always |
| T7 | stop while a flight runs | Q0/Z0: no late publication and no retry wake; an old callback id cannot clear or publish a different owned flight |

Reusing A never makes an expired A materialization current: M's expiry and recomputation still apply (Table V). Accepting B never makes an old A materialization current: it reads `behind` until recomputed.

The model-based test runs Tables Q and Z as the reference model under seeded sequences of {move ref, make ref unreadable, touch `FETCH_HEAD`, check, complete ok, complete fail, complete with a stale callback id, advance clock, fire the retry wake, stop}, seed 0x6E4E, 300 sequences of 40 commands. After each command: every accepted generation's facts equal the facts computed offline for its own H (no mixed heads); at most one flight exists; no `FETCH_HEAD` touch alone changes G's identity; and no failed `lastAttempt` matches the accepted G's identity.

**Table V: return-time projection.** Seam: `view(M, G, S, now)` and every live surface over one materialization M (metrics read, `team_metrics`, trends, scrape, workspace snapshot, monitor outcome), each served from its cache. A row holds on a cache hit with no recomputation, and for a chosen end or trend point alike.

| id | after M was materialized under G at H_a | → state on the next return |
|----|------------------------------------------|----------------------------|
| V1 | nothing changed, within `maxAge` | `current`; rule results eligible |
| V2 | the ref moved A → B, no flight completed yet | `behind` (cache hit, no recomputation); every rule "not current: behind" |
| V3a | `now` = `fetchAt` + 24 h − 1 ms, M otherwise fresh | `current` |
| V3b | `now` = `fetchAt` + 24 h exactly, no other event | `stale` at the owned wake; the removal is published |
| V3c | `now` = `fetchAt` + 24 h + 1 ms, no other event | still `stale` |
| V4 | a same-head fetch moves `fetchAt` forward before the crossing | `current`; the owned wake is cancelled and re-armed; same G identity; an already queued old callback re-reads the actual `fetchAt` and its owner token and leaves the view current |
| V5 | synthetic input only: `lastAttempt` failed for H_a while G is at H_a (unreachable from the controller, Tables Q and Z) | `refresh-failed`, fail-closed; the defensive branch, labeled as unreachable in production |
| V6 | the ref moved to B and B's read failed (CT T4) | `behind`, with the refresh-failed reason also in `reasons`; `current` again only after B's retry succeeds and M is recomputed |
| V6b | no G, ref B, and B's read failed (CT T3) | `unavailable`, with the refresh-failed reason |
| V7 | the ref became unreadable or the repository shallow | `unavailable` |
| V8 | a monitor outcome older than two intervals | `expired`; no item, every rule gauge 0 |
| V9 | `fetchAt` unknown (no `FETCH_HEAD`) | `stale` |
| V10 | a report frozen while V1 held, read after V2 | byte-equal to its stored snapshot: never re-projected |

**Table I: window membership.** Seam: `landingPositions` plus the containment and membership predicates (D3), span d, end T, current [T − d, T), baseline [T − 2d, T − d).

| id | chain (committer times) | event | → current | → baseline | → contained by T |
|----|-------------------------|-------|-----------|------------|------------------|
| I1 | monotonic | at = bound = T − d | in | out | yes |
| I2 | monotonic | at = bound = T | out | out | yes; in the window ending T + d |
| I3 | monotonic | at = bound = T − 2d | out | in | yes |
| I4 | monotonic | at = bound = T − 2d − 1 ms | out | out | yes |
| I5 | F₁ at T − d + 1 h, then F₂ at T − 3d | F₂: U = [T − 3d, T − d + 1 h] | unknown | unknown | yes |
| I6 | F₁ at T + 1 h, then F₂ at T − 1 h | F₂: U = [T − 1 h, T + 1 h] | unknown | out | unknown |
| I7 | any | at > T | out | out | no |

Property: for every generated chain and every pair of adjacent intervals, no event is `in` both (P1 extends to it).

**Table L: result landing.** Seam: `landingPositions` plus the commit-ref resolution. Ft is a first-parent commit with committer time t.

| id | graph | T | → landing |
|----|-------|---|-----------|
| L1 | C is the first-parent commit F₂ | * | position 2, `at` = ct(F₂) |
| L2 | C reached only through F₂'s second parent | * | position 2 |
| L3 | C reachable from F₁ (t 100) and from F₂ (t 90) | * | position 1, `at` 100, never 90 |
| L4 | a result names full literal D not in H's graph, with the strict same-result passing check of D1 (as L8b) | * | known, not landed |
| L4b | the same D with only a pending check, or none | * | unresolvable: excluded from `landed_result_share`, never known-not-landed |
| L5a | F₁ t 100, F₂ t 50 brings X through its second parent, F₃ t 200; X has U = [50, 100] | 40 | X not contained by T |
| L5b | same | 75 | X's containment unknown at T: excluded from the share, counted in its coverage note |
| L5c | same | 150 | X contained by T; its membership in [100, 150) is unknown (at 50 < 100), in [40, 150) it is in |
| L6 | F₁ t 1000, F₂ t 10 (old-dated), F₃ t 1100 brings X (ct 1050) through its second parent | 1200 | X landed at position 3, U = [1100, 1100] (no `--since` cut) |
| L7 | `commit_ref` is a 7- or 12-digit abbreviation of a graph commit, including one a later check resolved to a full id; symbolic text (`HEAD`, a branch name); a 39- or 41-digit hex; a 64-digit literal in a sha1 repository | * | unresolvable: excluded from `landed_result_share`, counted in its coverage note, never landed or known-not-landed |
| L8a | a full literal C in H's graph | * | known; C's landing by position |
| L8b | a full literal D off H's graph with one same team/task/result check: `done`, version 1, `commit.status` `pass`, `commit.given` = D, `commit.sha` = D | * | known, not landed; evidence names the check's id, `seq`, `finished_at` |
| L8c | D off-graph with no check, or a check that is pending, unavailable, failed, of another result, missing `commit.sha`, or with `given` ≠ the literal | * | unresolvable |
| L8d | D off-graph with two checks naming different `sha` | * | unresolvable |
| L8e | C landed and an unmerged D share their first 7 digits; the result names the 7-digit prefix | * | unresolvable (no prefix search, whichever commit is unique in H's graph) |
| L8f | `extensions.objectformat = sha256` in the config text; a 64-digit literal in the graph | * | known and landed; a 40-digit literal is unresolvable |

**Table C: change landing.** Seam: `changeLandings` over read 2 with a real temporary repository.

| id | archive history | → landing |
|----|-----------------|-----------|
| C1 | added by a merge commit | at the merge's position |
| C2 | added by a direct first-parent commit | at that commit's position |
| C3 | added twice (re-archived under a new date) | at the first arrival |
| C4 | added on an unmerged branch only | not landed |
| C5 | added, later deleted from master | landed at the arrival (history is not rewritten) |
| C6 | archived by `git mv` from `changes/<name>/`, with `diff.renames=true` | landed at that position |

**Table K: inputs at an end.** Seam: `loadMetricsInputs` plus `computeMetrics(…, end)` over `metricsSeed.ts` rows, fixture facts, and an explicit synthetic `SourceCoverage`, `now` fixed. "Legacy flags" means the flags the base code computes, unchanged.

| id | records | → result |
|----|---------|----------|
| K1 | linked task created and done 30 days before both windows, no later event; its change lands in the window | counted in tasks per landed change and cycle time |
| K2 | change landed at `now − 1 d`, its task active at `now − 7 d` | in flight at the baseline's end, with its age |
| K3 | 12w trend, oldest point: window starts 84 d back, baseline 91 d back, coverage `supported` over both | legacy `partial` on cohort token metrics as the base computes it (`usageHorizon`); `tokens_total` evidence complete |
| K4 | limit tax at an end whose baseline interval plus its 24 h lookback is not inside the coverage's supported intervals | legacy flags unchanged (limit tax has no `partial`); evidence incomplete on that side, reason `coverage` |
| K5 | point before the team's first record | value null, `n` 0 (no data) |
| K6 | the task's status at T comes from a backfilled row | in-flight age approximate; evidence incomplete |
| K7 | linked task created after the landing | not counted (post-archive follow-up) |
| K8 | read at `end = now` | every pre-existing metric's value, `n`, baseline, and legacy flags byte-identical to the base read; only the additive `evidence` and `delivery` fields are new |
| K9 | every migration row present, usage rows on every day of both sides, coverage `unknown` | `tokens_total` value as the base computes it; evidence `unknown`, reason `coverage`; `delivery-drop` and `cost-per-change-rise` not-evaluable `evidence` |
| K10 | 1d read, coverage `supported` over [T − 2 d, T) only | token evidence complete on both sides (no 14-day horizon) |
| K11 | `tokens_per_task` cohort task created 20 d before T, coverage `supported` from T − 10 d | that side's evidence incomplete, reason `coverage` |
| K12 | an archive of unknown membership in the baseline (I5) | `changes_landed` baseline excludes it; baseline evidence incomplete with `unknown: 1` |

**Table R: rules.** Seam: `evaluateDegradation` over M's numbers and evidence (pure). Currentness is not an input: a result is shown only through a `current` projection (Table V), so no row here reads freshness. The notation is D4's: lc/lb, ic/ib, tc/tb, xc/xb. "evidence" names the first side or count whose evidence is incomplete. Every row not shown for a rule is covered by its table's input conditions, which are checked in the order listed. The figures are synthetic arithmetic witnesses, not calibration.

*R-DD, `delivery-drop`:*

| id | evidence | lb | ib | tb | lc/lb | ic/ib | tc/tb | → result |
|----|----------|----|----|----|-------|-------|-------|----------|
| DD1 | incomplete for changes landed, integrations, or `tokens_total` on either side (an unknown membership, coverage `unknown`, 34 archives of unknown membership) | * | * | * | * | * | * | not-evaluable `evidence` |
| DD2 | complete | 9 | * | * | * | * | * | not-evaluable `floor` |
| DD3 | complete | 10 | 0 | * | * | * | * | not-evaluable `no integration baseline` |
| DD4 | complete | 40 | 146 | 0 | 6/40 | 59/146 | 0/0 | not-evaluable `no baseline usage` |
| DD5 | complete | 10 | 10 | 100 | 6/10 | 7/10 | 80/100 | fires (all three boundaries met: 30 ≤ 30, 70 ≤ 70, 400 ≥ 400) |
| DD6 | complete | 10 | 10 | 100 | 7/10 | 7/10 | 100/100 | holds-not (35 > 30) |
| DD7 | complete | 10 | 10 | 100 | 6/10 | 8/10 | 100/100 | holds-not (80 > 70) |
| DD8 | complete | 10 | 10 | 100 | 6/10 | 7/10 | 79/100 | holds-not (395 < 400) |
| DD9 | complete | 10 | 10 | 100 | 6/10 | 7/10 | 0/100 (rows supported, none recorded) | holds-not |
| DD10 | complete | 10 | 10 | 100 | 3/10 | 7/10 | 90/100 | fires |

*R-CR, `cost-per-change-rise` (fires when tc·lb ≥ 2·tb·lc):*

| id | evidence | lc | lb | tb | tc | ic/ib | `delivery-drop` | → result |
|----|----------|----|----|----|----|-------|-----------------|----------|
| CR1 | incomplete for changes landed or `tokens_total` on either side | * | * | * | * | * | * | not-evaluable `evidence` |
| CR2 | complete | 2 | ≥ 10 | * | * | * | * | not-evaluable `floor` |
| CR3 | complete | ≥ 3 | 9 | * | * | * | * | not-evaluable `floor` |
| CR4 | complete | ≥ 3 | ≥ 10 | 0 | * | * | * | not-evaluable `no baseline usage` |
| CR5 | complete | 3 | 10 | 100 | 60 | 8/10 | holds-not | fires (600 ≥ 600, cost exactly 2×) |
| CR6 | complete | 3 | 10 | 100 | 90 | 8/10 | holds-not (80 > 70) | fires (integration-branch case: 900 ≥ 600) |
| CR7 | complete | 3 | 10 | 100 | 90 | 7/0 | not-evaluable (ib = 0) | fires |
| CR8 | complete | 3 | 10 | 100 | 90 | 7/10 | fires (DD10) | holds-not (subsumed) |
| CR9 | complete | 3 | 10 | 100 | 59 | 8/10 | holds-not | holds-not (590 < 600) |

*R-CD, `convergence-drift`:* base tasks per landed change ≥ 1 by construction (a linked change has a task), so a zero denominator is unreachable.

| id | evidence | linked cur / base | coverage cur / base | xc / xb | → result |
|----|----------|-------------------|---------------------|---------|----------|
| CD1 | incomplete for linked landed changes or link coverage on either side | * | * | * | not-evaluable `evidence` |
| CD2 | complete | 4 / ≥ 5 | * | * | not-evaluable `floor` |
| CD3 | complete | ≥ 5 / 4 | * | * | not-evaluable `floor` |
| CD4 | complete | ≥ 5 / ≥ 5 | 49/100 on either side | * | not-evaluable `coverage` |
| CD5 | complete | 5 / 5 | 1/2 / 1/2 | 2 / 1 | fires (2 ≥ 2·1) |
| CD6 | complete | 5 / 5 | 1/2 / 1/2 | 399/200 / 1 | holds-not (399 < 400) |

*R-IA, `inflight-aging`:*

| id | evidence | n cur / base | approximate | base p90 | cur p90 | → result |
|----|----------|--------------|-------------|----------|---------|----------|
| IA1 | incomplete for an in-flight set (an unknown containment at either end) | * | * | * | * | not-evaluable `evidence` |
| IA2 | complete | 2 / ≥ 3, or ≥ 3 / 2 | * | * | * | not-evaluable `floor` |
| IA3 | complete | ≥ 3 / ≥ 3 | either side | * | * | not-evaluable `approximate` |
| IA4 | complete | ≥ 3 / ≥ 3 | no | 0 | * | not-evaluable `no baseline age` |
| IA5 | complete | 3 / 3 | no | 36 h | 72 h | fires |
| IA6 | complete | 3 / 3 | no | 30 h | 71 h | holds-not |
| IA7 | complete | 3 / 3 | no | 38 h | 72 h | holds-not (ratio < 2) |

**Table T: tool surface.** Every refusal uses the tool-error envelope that the existing unknown-window refusal uses (oracle hazard "refusals missing the success envelope").

The compact-read rows themselves (compact default, unknown ids, slices, listing without snapshots, paging) are `bounded-metrics-and-task-get`'s Table T. The rows here cover only this change's extension of that projection.

| id | call | → result |
|----|------|----------|
| T1 | `team_metrics {window:'7d'}` with the delivery family, on the seeded 300-task fixture | compact, < 32 KB; delivery values equal the tab's; the projected `delivery` header present |
| T2 | `{window:'7d', metrics:['tasks_per_landed_change']}` | that metric carries ≤ 50 drill entries sorted by id, their total, and a cursor; `team_metrics_drill` pages it over the issuing read's G and end |
| T7 | compact read of a metric that is partial, approximate, unavailable, or has incomplete evidence | the flag, the `unavailable` reason, and `evidence` present |

**Table TR: trends surface.** Same envelope rule as Table T.

| id | request | → result |
|----|---------|----------|
| TR1 | range `4w` | 4 points, newest ending at the read |
| TR2 | range `6w` | refused, naming 4w, 8w, 12w, with the same error envelope as an unknown window |
| TR3 | unknown `teamPath` | `unknown-team`, no data |
| TR4 | point whose baseline interval plus its 24 h lookback is outside the supplied coverage | `limit_tax_hours` marked incomplete evidence at that point; its legacy flags unchanged; no rule mark that reads it |
| TR5 | `process-metrics-open` with `end`, then a refresh | the window ending at `end` both times; values equal TR1's matching point |
| TR6 | `process-metrics-open` without `end` | unchanged from today |

**Table W: attention.** Seam: the production `WorkspaceRead.snapshot` with the runtime's `outcome`, fake clock.

| id | outcome | → queue |
|----|---------|---------|
| W1 | current, `delivery-drop` fires | one human item `process-degradation:delivery-drop` naming 6 vs 40 and both token totals |
| W2 | next evaluation `holds-not` | item gone, counts drop by one, one publish |
| W3 | same rule fires with new current values | one publish; same identity; the cause shows the new values |
| W4 | fires, then `now` reaches `fetchAt` + 24 h exactly with no other event | at 24 h − 1 ms the item is listed; at the owned wake the removal is published; at + 1 ms still no item |
| W5 | `not-evaluable` | no item |
| W6 | outcome of an older generation, or older than two intervals | no item |
| W7 | fires, then the ref moves to B and B's read fails | no item (`behind` with the failed reason); after B's backoff the owned retry wake retries B, and the item returns only on a current evaluation over the accepted B |
| W8 | fires, then the ref moves and the snapshot is served from cache with no evaluation | no item (`behind`), at the next snapshot without recomputation |
| W9 | the production composition's coverage (`unknown`) with token rows present | no `delivery-drop` or `cost-per-change-rise` item (not-evaluable `evidence`) |

**Table E: export.** Each row is a scrape through the production `registerMetricsRoute` against a fixture team. A spawn spy asserts that no scrape runs git.

| id | endpoint | state | → delivery series |
|----|----------|-------|-------------------|
| E1 | disabled | * | none, and no delivery timer armed without a subscriber |
| E2 | enabled | cold start, no generation yet, no browser or tool call | `delivery_facts_available` 0 only; the background pass starts at boot |
| E3 | enabled | current, all rules `holds-not` | every family; `degradation_rule_firing` 0 per rule; `delivery_rules_current` 1 |
| E4 | enabled | current, `delivery-drop` fires | its gauge 1, the others 0 |
| E5 | enabled | stale | families, `delivery_facts_stale` 1, every rule gauge 0, `delivery_rules_current` 0 |
| E6 | enabled | restart, then the first background generation is accepted, nothing landed | counters and histogram buckets equal before and after; between restart and acceptance, E2 |
| E7 | enabled | 90 landed changes | one histogram series per team alias; no change name in any label |
| E8 | enabled | every workspace subscription closed or disconnected, then the rule's inputs change | the background pass updates the gauge within one interval |
| E9 | enabled | outcome older than two intervals (timer stalled) | every rule gauge 0, `delivery_rules_current` 0 |
| E10 | enabled | `delivery-drop` fired, then the ref moved (behind), with or without B's read failing (the failed reason), scraped before any evaluation | every rule gauge 0, `delivery_rules_current` 0, counters of the accepted generation unchanged |
| E11 | enabled | production coverage `unknown`, facts current, the in-flight inputs of `inflight-aging` met | `delivery_rules_current` 1; `degradation_rule_firing` 0 for `delivery-drop` and `cost-per-change-rise`, 1 for `inflight-aging` |

**Table N: noninterference.** Seam: the production manager composition with a fixture team. The same dispatch, routing, staffing, execution-tick, and acceptance inputs are run under four delivery states: unavailable, current and `delivery-drop` firing, stale, and current with different landings.

| id | check | → result |
|----|-------|----------|
| N1 | dispatcher pass, routing decision log, staffing preview, the execution fixture's tick effects, and Accept result outcomes under each state | identical across the four |
| N2 | mutant: the dispatcher receives `MetricsReader` through an injected dependency and skips a dispatch when `delivery.state` is stale | N1 fails |
| N3 | supplementary import guard: the outbound-isolation modules import nothing from `metrics/delivery/`, `degradationRules`, or `MetricsReader` | no offenders, file list non-empty |

**Table CAL: calibration cases.** Seam: `readTrends` over the D9 fixture at fixed `now = 2026-10-27T00:00:00Z`, with synthetic `SourceCoverage` `supported` over every span unless a row says otherwise. The cases are declared before the thresholds are read. They are synthetic arithmetic over D4's predicates, not a calibration against real data.

| id | fixture week (current vs baseline) | → rules at that point |
|----|------------------------------------|-----------------------|
| CAL1 | landings 6 vs 40, integrations 59 vs 146, tokens 7.1 B vs 4.0 B | `delivery-drop` only (`cost-per-change-rise` subsumed) |
| CAL2 | landings 6 vs 40, integrations 59 vs 146, tokens 70 vs 100 (cost ratio 14/3) | `cost-per-change-rise` only (5·70 < 4·100) |
| CAL3 | landings 6 vs 40, integrations 59 vs 146, tokens 20 vs 100 (cost ratio 4/3) | none |
| CAL4 | landings 3 vs 10, integrations 7 vs 10, tokens 90 vs 100 | `delivery-drop` only (cost 3 subsumed) |
| CAL5 | landings 3 vs 10, integrations 8 vs 10, tokens 90 vs 100 | `cost-per-change-rise` only |
| CAL6 | landings 20 vs 20, integrations steady, tokens 220 vs 100 (cost 2.2×) | `cost-per-change-rise` only |
| CAL7 | CAL1's figures with coverage `supported` but no usage rows in the baseline | no token rule fires (`not-evaluable` `no baseline usage`) |
| CAL8 | CAL1's figures with coverage `unknown` | no token rule fires (`not-evaluable` `evidence`) |

**Properties.** All use a seeded `mulberry32`, defined in the test file the way the existing property tests define it (for example `checkRecords.test.ts`), and no new dependency.

- **P1, landing position equals brute force.**
  - Generator: random DAGs of 30–200 commits with 1–3 parents, a random first-parent chain, and committer times shuffled independently of position.
  - Seam: `landingPositions`.
  - Property: each commit's position is the smallest k whose ancestor closure of Fₖ contains it, its `at` is ct(Fₖ), and its `bound` is the maximum ct over F₁…Fₖ.
  - Seed 0xDE11, 500 cases.
- **P2, the compact form is a projection.**
  - Generator: random `MetricsInputs` built over the existing `metricsSeed.ts` helpers.
  - Property: for every metric, `compactMetrics(m)` keeps `value`, `n`, `baseline`, every flag, `unavailable`, and `evidence` equal to `m`'s, and the `delivery` header equal to `m`'s. This extends `bounded-metrics-and-task-get`'s P2 with the fields this change adds.
  - Seed 0xC0DE, 300 cases.
- **P3, the rules are monotone in delivery.**
  - Holding the token and integration figures and the input conditions fixed, lowering the current changes landed never turns `delivery-drop` from `fires` to `holds-not`.
  - Seed 0xD0D0, 500 cases.
- **P4, a trend point is the read at its end.**
  - Generator: random `MetricsInputs` spanning 13 weeks with random fixture facts, one generation.
  - Property: for every k, point k of `readTrends` equals `computeMetrics` at `end_k` over a load made for that end with the same generation, coverage, and `now`, projected compactly and through `view` at the same S. Values, `n`, baselines, flags, evidence, the projected state, and rule results all match.
  - Seed 0x7E4D, 100 cases.
- **P5, generations never mix heads.** This is the model-based test of Tables Q and Z (seed 0x6E4E).
- **P6, no double count.** Over P1's generator, for random ends T and spans d, no landing is `in` both [T − 2d, T − d) and [T − d, T), and every landing `in` either is contained by T. Seed 0x1A1F, 500 cases.
- **P7, the projection is the only currentness.** Over random sequences of P5's commands, every live return's state equals `view(M, G, S, now)` recomputed from scratch at the same instant, including cache hits. Seed 0x51E3, 300 sequences.

**Production composition (M1).** One test builds the manager and `bootstrap`'s route registration as production does, with export enabled and no browser connection, and the production coverage input (`unknown`, D3b). It uses a temporary git repository (`cleanGitEnv`) whose origin carries 12 archives in the baseline week and 2 in the current week, token rows on every day, and three linked in-flight changes aged 80 h at T against three aged 36 h at the baseline's end. It asserts that the background pass alone makes a scrape show E11, that a workspace snapshot lists `process-degradation:inflight-aging` and no `delivery-drop` item, and that `team_metrics` reports `delivery-drop` not-evaluable `evidence`. There are four mutants: the source removed from `ATTENTION_SOURCES`; bootstrap not passing the runtime to the route; `enableExport` not called; and the composition passing `supported` coverage. Each fails the test.

## Risks / Trade-offs

- **[Archives are lumpy: a change lands its code across many PRs and archives once]** → `delivery-drop` also requires integrations to fall, and its baseline floor is 10. Integrations are reported beside changes landed.
- **[Goodhart: changes get split to raise changes landed]** → tokens per landed change and the convergence metrics travel with it, its guard is reopen rate, and rules detect rather than target.
- **[Committer time is not arrival time]** → landings are ordered by first-parent position, each carries its uncertainty interval [at, bound], membership is half-open and never inferred inside it, and the proxy's limits are stated. A backdated position reads unknown in the windows it straddles and suppresses the rules that read it.
- **[No producer establishes source coverage]** → `SourceCoverage` is a consumer input (D3b) whose producer contract is an unmet, blocking prerequisite. Until it is approved, production passes `unknown`, so `delivery-drop`, `cost-per-change-rise`, and token or limit trend marks never fire on real data. That is the intended conservative outcome, stated in the tab and the export, not a defect to patch with migration timestamps.
- **[Abbreviated result commits are excluded]** → only full literal ids of the repository's object format count (D1); an abbreviation stays unresolvable even when unique, and the share's coverage note counts it.
- **[A team that never fetches is never alerted]** → the tab shows the stale marker with the fetch age, and rules are `not-evaluable` while stale. Kawai does not fetch: that is a write to the repository's refs, and agents fetch routinely.
- **[Whole-history reads grow with the repository]** → the byte bound and closure check make an oversized or truncated history unavailable, never partial. The cost on a real repository is Unknown until measured under D9.
- **[Linked-task coverage is partial]** → convergence carries its coverage metric, and `convergence-drift` requires coverage of at least 0.5 on both sides.
- **[Rule thresholds are judgement]** → they are constants in one table, validated on the declared fixture cases (Table CAL). Moving one is a reviewed code change, never configuration, and never tuned to make a named historical window fire.
- **[A 12-week trend repeats the computation 12 times]** → it runs over one load, is cached 5 minutes per (range, G's identity) and projected on every hit, and is never computed on a workspace push.
- **[Past trend points change after the fact: a late fetch, result, rewrite, or reopened task]** → this is intended and stated: a point is today's read for that end (P4), not what was known then. The view says "recomputed at <time> from <head>".
- **[The PromQL ratio drifts from the read-time ratio]** → it is documented as an observed-increase approximation (D7).
- **[Old report snapshots lack the delivery family and show lead time's new guard as absent]** → readers render absent, and the guard is read from definitions as today.

## Migration Plan

There is no schema migration and no stored state.

**Prerequisite.** Real-data alert implementation for the token- and limit-dependent rules waits on an approved producer coverage contract (D3b, task 0.1). Everything else, including those rules' consumer branch under fixture coverage, can be implemented first; in production those rules read not-evaluable until the contract lands. Deploying adds the family, the rules, the compact tool forms, the Trends view, and the export families. The export families and the background refresh appear only where `KAWAI_METRICS_ENABLED` is already set. Rolling back is a revert: no data was written that older code would misread. Reports frozen after the change carry the delivery family in their snapshot JSON, and older readers ignore unknown metric ids.
