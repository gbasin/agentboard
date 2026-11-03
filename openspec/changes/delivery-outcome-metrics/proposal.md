# Proposal

## Why

In the week of 2026-10-20, by the original author's figures (unverified; no live data was read for this revision), Kawai's process metrics all reported improvement: 227 done tasks against 104, task lead time p50 1.5 h against 4.0 h, fix iterations 1.07 against 2.13. Over the same week, master took 59 first-parent merges against 146, OpenSpec archives fell from 40 to 6, and completed-turn tokens rose from 4.0 B to 7.1 B (about 4.5× the tokens per merge). Nothing told the owner. There were three causes:

1. The metrics count team tasks, not delivered work. Review, advisory, and follow-up tasks inflate the cohort. A develop-review-follow-up loop that spans many short tasks reads as faster work, and `fix_iterations` cannot see it because it counts results within one task.
2. The lead-time guard, `accepted_result_share`, has read 0 in every window ever recorded: no result has ever been accepted. A guard that is always zero cannot move.
3. Metrics are only computed when someone reads them, and no path raises them to the human. The one prose warning (in the 10-26 7d report) stayed inside the report. Agents also struggle to read them: `team_metrics` returns about 1 MB and `process_reports_list` about 2 MB (author-reported sizes).

## What Changes

- **Delivery facts.** Kawai reads the commit the team's default branch names as last fetched (`refs/remotes/origin/HEAD`), and its whole history, with read-only git:
  - first-parent integrations, in chain order;
  - OpenSpec changes landed, meaning their archive directory arrived on the default branch, at the first-parent position where it arrived;
  - for each result commit named by a full literal object id, whether it landed and at which first-parent position. Abbreviations and symbolic names are unresolvable and excluded with a count; no prefix search runs.

  Each landing's time is the interval from its position's committer time to the latest committer time at or before that position, a stated proxy for arrival. "Contained by T" is inclusive, and window membership is half-open, so no landing counts in two adjacent windows. A landing whose interval straddles a window boundary reads unknown there and is excluded. Facts are published whole, for one head, or not at all: a failed, clipped, or shallow read publishes nothing. Kawai never fetches. A facts generation is identified by its head, never by fetch time. Every live return, cache hits included, projects its state from the live ref: unavailable, behind, stale (24 hours old or older), expired, or current, with a defensive refresh-failed state that the controller never reaches; a needed head's failed read is a stated reason, retried after its backoff.
- **A `delivery` metric family** over the existing windows and baselines:
  - changes landed and integrations per window;
  - tokens per landed change;
  - per landed change: cycle time from the first linked task to landing, linked tasks, and review rounds;
  - the age of in-flight changes;
  - how many landed changes have linked tasks, so convergence numbers show their own coverage.
- **A guard that can actually move.** `landed_result_share` is the share of done tasks whose newest result's commit landed on the default branch. It replaces `accepted_result_share` as task lead time's guard. `accepted_result_share` stays a coverage metric with an unchanged definition. Accepting a result remains a separate act; landing never accepts a result.
- **Degradation alerts.** A fixed, constant table of rules compares the 7d window with its baseline. Example: changes landed fell by 40% or more and integrations by 30% or more, while recorded tokens fell by no more than 20%. Each rule names the inputs it needs and compares them by exact integer arithmetic. It fires only when the evidence of every count it reads is complete on both sides and its sample floors are met, so missing usage never reads as unchanged spending. While a rule fires, it raises one `process-degradation` attention item, owned by the human and naming its evidence, which links to the Metrics tab. When the projected state is anything but current, the rules do not fire and the tab states why. Nothing is stored: rules are evaluated at read time like the metrics, and kept current by a background refresh while the export is enabled.
- **Source coverage is an input, and its producer is an unmet prerequisite.** Whether usage and limit records cover a span continuously comes only from a supplied source-coverage input. It is never inferred from migration times, first rows, or retention. No producer supplies it today, and this change builds none (no ledger, migration, or backfill). So in production every token- and limit-dependent rule (`delivery-drop`, `cost-per-change-rise`, and their trend marks and gauges) reads not evaluable. **Real-data alerts for those rules are not implementation-ready** until an approved producer contract exists (task 0.1). Their consumer logic is specified and tested with synthetic fixture coverage. Existing metrics keep their values and flags; completeness rides a separate, additive `evidence` field.
- **Compact agent reads extended.** The compact `team_metrics` and report reads, their drill paging, and the end-keyed reader come from `bounded-metrics-and-task-get`, which lands first. This change only makes that projection carry the delivery family's `unavailable` reasons, `evidence`, and the projected `delivery` header, and accepts the new metric ids.

- **A Trends view.** The Metrics tab gains Trends: every metric as a series of 7d windows over the last 4, 8, or 12 weeks. Each point is exactly the 7d read ending at that point's end over today's records and facts, and points where a degradation rule fired are marked. Opening a point shows that window. The view is recomputed at read time like the metrics, so it shows what today's records say about each past week, not what was known then. It answers "when did this start?", which a single window against its baseline cannot.
- **Delivery metrics for Prometheus.** When the existing optional `/metrics` endpoint is enabled, it also exports:
  - cumulative counters of integrations and landed changes;
  - histograms of change cycle time, tasks, and review rounds per landed change;
  - gauges for facts availability, in-flight changes, fetch age and staleness, and each degradation rule's firing state.

  Token totals are already exported, so a query over the two counters approximates tokens per landed change by when increases were observed; Kawai's own read stays the exact committer-time figure.

Non-goals:
- deploying Prometheus or Grafana;
- adding a charting dependency;
- fetching from origin;
- accepting results automatically;
- notifying agents or sending mail about degradation;
- changing the definition of any existing metric;
- recommendations or the daily digest, which belong to `process-observability`;
- making any metric or alert an input to dispatch, routing, staffing, execution, landing, or acceptance;
- reading, copying, or calibrating against live data (any later real-data check needs its own authorization).

## Capabilities

### New Capabilities

- `delivery-outcomes`: delivery facts read from the default branch (integrations, landed OpenSpec changes, landed result commits) and their freshness, the `delivery` metric family with per-change convergence and in-flight age, the fixed degradation rules evaluated over them, and their export to the optional Prometheus endpoint. The export requirements live here rather than in `prometheus-export`, which `process-observability` introduces and has not archived.

### Modified Capabilities

- `team-process-metrics`: task lead time's guard becomes `landed_result_share`; the compact `team_metrics` form (from `bounded-metrics-and-task-get`) carries the delivery fields; a read can end at a chosen time; and the Metrics tab gains a Trends view of 7d windows over 4–12 weeks.
- `process-reports`: restates `bounded-metrics-and-task-get`'s compact report reads, adding that a report frozen before the delivery family reads its delivery metrics as absent. The Metrics tab is unchanged.
- `team-workspace`: the attention queue lists `process-degradation` items, linked to the Metrics tab.

## Impact

- **Server:**
  - a new `src/server/metrics/delivery/` module: a git reader over `runGitAsync` with an explicit output bound and completeness checks, a pure landing walk with containment and membership, full-literal commit resolution, a facts cache of whole generations per head, the pure return-time projection (`delivery/view.ts`), the degradation monitor, and one `DeliveryRuntime` per manager that owns their refresh;
  - `computeMetrics.ts` and `metricsQuery.ts` take delivery facts, a source-coverage input (supplied as unknown in production), and an explicit end as input, and the load adds every linked task's history and its result checks;
  - `metricsTools.ts` passes the delivery fields through the compact projection that `bounded-metrics-and-task-get` adds (a dependency: that change merges first);
  - `workspaceRead.ts` gains an attention source.
- **Shared:**
  - `src/shared/processMetrics.ts` gains the `delivery` family, new metric ids, the changed guard, and the compact types;
  - `src/shared/teamWorkspace.ts` gains the `process-degradation` kind and a `metrics` link kind.
- **Export:** `src/server/metrics/export/registry.ts` and `snapshot.ts` gain the delivery families, and `route.ts` takes the delivery runtime from `bootstrap.ts`. Adding families leaves the existing ones unchanged.
- **Protocol:** additive `process-metrics-trends-open`/`close` messages answered by `process-metrics-trends`, all in `CHAT_CONNECTION_TYPES`.
- **Client:**
  - the Metrics tab renders the new family and its staleness marker;
  - a Trends sub-view at `#/team/<key>/metrics/trends/<range>`, drawn as SVG small multiples with no chart library;
  - the attention queue opens the `metrics` link.
- **Data:** no migration, no new table, and no coverage ledger. Facts are derived from git and held in memory. Report snapshots frozen before this change keep their stored shape, and readers treat the new metrics as absent there.
- **Coordination:** `process-observability` plans acceptance-time metrics over first durable acceptances. Delivery facts and `landed_result_share` are separate outcome and guard evidence: they are not an acceptance, a substitute for one, or a completion of that change's pending integrations, and neither change redefines the other's metrics.
- **Verification capabilities:** the UI tasks' screenshot and chart checks need the `dev-browser` and `dataviz` skills in the implementing session; without them, those checks wait for a separately reviewed alternative. Backend work does not depend on them.
