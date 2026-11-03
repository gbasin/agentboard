# Design

## Context

Every `kawai-team` tool result is a single `JSON.stringify` of the handler's
return value (`src/server/team/mailboxTools.ts:219`, through
`teamToolTable`). Both tool runtimes, the Claude SDK and Codex, register from
that table. So an agent receives whatever record a handler returns.

**Metrics.** `computeMetrics` (`src/server/metrics/computeMetrics.ts`) gives
every `MetricValue` a `drill: { tasks: {id,title}[], messages: {id,threadId}[] }`.
These lists hold every input in the window, de-duplicated by a `Set` in
observation order (`slices.ts:146`), with no cap. The p50 and p90 metrics of
one family repeat the same list.
- `MetricsReader.read(team, window, slice)` caches one read per key for 30 s
  and always reads at "now". `readMetrics(db, team, window, slice, end)`
  already takes an end time.
- `team_metrics` returns the `ProcessMetrics` value unchanged
  (`metricsTools.ts:46`).
- The Metrics tab (`src/client/components/team/metrics/MetricRow.tsx`)
  renders the whole drill lists, over the WebSocket, not through the tool.

**Reports.** `ProcessReport.snapshot` is a frozen `ProcessMetrics`.
- `process_reports_list` returns 10 reports with their snapshots by default
  (`reportTools.ts:62`). `process_report_get` returns one report with its
  snapshot. `process_report_submit` echoes the report it just froze.
- The human's path reads `ProcessReportService.list(…, { keepActionable })`
  and `report(…)` from `metricsConnections.ts:65,91`.

**task_get.** `TaskJournalWindow.agentDetail`
(`src/server/team/taskJournalWindow.ts:95`) windows the journal (50, up to
200, with byte previews), subtasks (100), and messages (50), all in SQL. Each
subtask is a full `TeamTaskSummary` (`store.summary`). The rest is whole:
- `revisions`, each with the full direction and acceptance;
- `assignments`, each with its verbatim `instruction`;
- `publications` and `acknowledgements`;
- every result, with `diff`, `tests`, `findings`, coverage, checks, and
  reviewer maps.

`taskTools.ts:95` then applies the blind-first seal
(`TaskResultService.applySeal`) to `results`.

**Neighbours.**
- `bounded-task-list` (PR #358, unmerged) adds `AgentTaskRow` and its
  projection (`src/server/team/taskListWindow.ts`). This change depends on it.
- `delivery-outcome-metrics` specified `compactMetrics` (its D5) and task
  group 3. Both move here (D10).
- `tool-call-metrics` plans an inline Tools drill "capped at 50 plus the
  total" through that projection, and a tab-only pager. That pager is
  unaffected.

## Goals / Non-Goals

**Goals:**
- Every metrics and report read an agent makes is bounded by construction.
  Every drill entry stays reachable by paging.
- `task_get` keeps one task's working set whole: the current direction,
  acceptance, current instruction, and the outstanding result. Everything
  else becomes a row or a window, and the rest is reachable through an
  argument.
- Agents' numbers stay identical to the tab's: the compact form is a
  projection of the same computation.

**Non-Goals:**
- Changing the human's Metrics tab, Tasks tab, or WebSocket reads.
- Rewriting stored snapshots, journals, or results.
- Bounding `plan_get`, `strategy_get`, or `strategy_impact_get`, which are
  small today. They are a later change.
- A response-size cap in `teamToolTable`.
- A separate tool that reads one message's full body. `task_get`'s
  `full_messages` covers it (D6).

## Decisions

### D1 — `compactMetrics` is a pure projection

`compactMetrics(metrics, { expand?: MetricId[], drillCap = 50, cursorSource })`
lives in `src/shared/processMetrics.ts`. For every metric it keeps `id`,
`value`, `n`, `insufficient`, `baseline`, `approximate`, `partial`,
`notSliceable`, and `slices` (present only when a slice was asked).

Metrics not in `expand` lose `drill` and `breakdown`. Each expanded metric
keeps `breakdown` and gets this in place of `drill`:

```ts
drill: {
  tasks: MetricDrillTask[]; messages: MetricDrillMessage[]     // first ≤ 50 by id
  total: { tasks: number; messages: number }
  next: { tasks: string | null; messages: string | null }      // D2 cursors
}
```

Drill lists are sorted by `id` (code-unit order) before the cap. Paging
needs an order that does not depend on how observations were inserted. Ids
are the only key every entry has. The full `ProcessMetrics` that the tab
reads keeps its current order, so the tab is unchanged.

The projection never mutates its input (the cached value and the stored
snapshot are shared), and it adds no fields that have their own values.

*Alternative considered:* keeping the computed order and paging by offset.
Rejected: a recomputation can reorder entries, which would duplicate or skip
entries across pages.

### D2 — Opaque cursors, one paging tool

A cursor is base64url JSON, versioned:

```ts
{ v: 1, src: { kind: 'live', window, slice, end } | { kind: 'report', reportId },
  metric: MetricId, list: 'tasks' | 'messages', after: string }   // after = last id returned
```

`team_metrics_drill { cursor, limit? }` (limit 1–200, default 100) decodes
the cursor and validates every field (`v`, `src.kind`, a known window and
slice, an ISO `end`, a known metric, the list name, and a string `after`).
Anything else is refused as an invalid cursor.

Its source then resolves for the caller's team, which comes from the
session as in every tool:
- `live`: `MetricsReader.readAt(team, window, slice, end)`.
- `report`: the stored snapshot of `reportId` for the caller's team. A
  foreign or unknown id is refused as `Unknown report: <id>`.

The page holds the entries with `id > after` in id order, at most `limit` of
them. The result is
`{ metric, list, total, entries, next, source: { kind, window, end | reportId } }`.

The team is deliberately left out of the cursor. A forged cursor can only
name a window, an end, or a report, and it is always read against the
caller's own team, so it can never read another team's data.

*Alternative considered:* a `cursor` argument on `team_metrics` and on
`process_report_get`. Rejected: one tool would then have two result shapes,
and a report's drill would need a second copy of the paging code. One tool
pages both kinds of source.

*Alternative considered:* the tab pager's high-water binding from
`tool-call-metrics`. Not needed here. Live pages recompute at a fixed `end`,
and report pages read a frozen snapshot, so the id anchor alone gives
exactly-once paging over an unchanged team (property P1).

### D3 — Reads at a fixed end are cached by end

`MetricsReader` gains `readAt(team, window, slice, end)`. Its cache key is
`[team, window, slice, end]`, with the same 30 s expiry. `read()` keeps its
key and becomes `readAt(…, now)` with `end` reported as `periodEnd`. A
paged walk therefore shares one computation while it runs. A page requested
after the entry expires recomputes at the same end over the same records.

The live cursor's `end` is the issuing read's `periodEnd`. `team_metrics`
returns the value `read()` served, so its cursors name that value's end,
including on a cache hit (hazard "a key input no fixture varies": rows T9
and T10 vary `end` alone).

`delivery-outcome-metrics` later adds "a read can end at a chosen time" and
extends the key with its generation. It builds on `readAt`, without a second
end-keyed path.

### D4 — `team_metrics` and the report tools

`team_metrics` takes `{ window, slice?, metrics?: string[] }` and returns
`compactMetrics(reader.read(…), { expand: metrics, cursorSource: live })`.
An unknown id is refused, naming `METRIC_IDS`, in the same error shape as
an unknown window.

The report tools:
- `process_reports_list` maps each report to `Omit<ProcessReport, 'snapshot'>`.
  Freshness is unchanged.
- `process_report_get { report_id, metrics? }` returns the report with
  `compactMetrics(report.snapshot, { expand, cursorSource: report })`.
- `process_report_submit` returns the stored report through the same
  compact projection, with no metric expanded.

These projections live in the tool handlers. `ProcessReportService.list`
and `report` are unchanged for the human's path.

There is no `full` flag. A full snapshot of a 7d report is 803 KB, which is
the failure this change removes. Every entry is reachable through D2, and the
human's tab still shows the snapshot whole.

### D5 — Subtasks as `AgentTaskRow`, with an anchor

`agentDetail` maps subtask ids through `bounded-task-list`'s compact
projection (one helper, shared with `task_list`, so both readers derive
`assignee` and `result` the same way). That covers hazard "several readers
disagreeing on derived state".

`subtasks_before` resolves an anchor `(created_at, rowid)` among
`team_tasks WHERE parent_id = task`. An unknown id, or an id that is not a
subtask of the task, is refused as
`Unknown subtask of this task: <id>`. The window query adds the
strictly-older predicate that the journal uses.

`bounds.subtasks` gains `nextBefore`: the oldest returned id when more remain.

### D6 — Message bodies as byte previews, with an anchor

`forTaskNewest` gains an anchor and a preview projection. It selects
`length(CAST(body AS BLOB))` and `substr(CAST(body AS BLOB), 1, 2000)`, and
passes them through the journal's `journalPreview`. The result: `body` is the
preview text (null when it is not exact UTF-8), and the message gains
`bodyBytes` and `bodyCut`. Every other `TeamMessage` field is unchanged.

`messages_before` anchors on a message whose `task_id` is the task; any
other id is refused as `Unknown message of this task: <id>`.
`bounds.messages` gains `nextBefore`.

`full_messages: boolean` (zod `z.boolean().optional()`, default false) selects
the whole body in the same query, in place of the `substr` projection. It is
still decoded through the same exact-UTF-8 check, so text is null only for
bytes that are not exact UTF-8. `bodyBytes` is the stored length, and
`bodyCut` is false. Only the projection changes: the window of 50, its
`(created_at, rowid)` order, `messages_before`, and `bounds.messages` are
the same as in the default read. So a walk with `full_messages` returns the
same messages, page by page, as the walk without it. The flag touches no
other section. With it, the response is bounded by message count, not
bytes, which is why it defaults to false.

*Alternative considered:* a per-message argument (`message_id`) returning one
body whole. Rejected for now: the flag is simpler to describe and to use
alongside the existing window, and an agent that wants one long body can
pair it with `messages_before` set just after that message.

*Alternative considered:* the 300-character cut that `list_mailbox` uses.
Rejected: task mail carries instructions, and the 2,000-byte journal bound
is the established agent read size.

### D7 — Revisions as rows, and a `revision` argument

Each revision becomes
`{ revision, author, createdAt, rationale, notify, directionBytes, acceptanceBytes }`.
The byte lengths come from SQL, so the text never reaches JavaScript for
rows. `revision: n` must be an integer in `1..task.revision`; otherwise it
is refused as `Unknown revision of this task: <n>`. When valid, the detail
gains `revisionText: { revision, direction, acceptance }`.

Rationales stay whole. They are written short by the publish tools, and the
tasks view shows them as written.

### D8 — Results: the outstanding one whole, the rest as rows

`results` keeps its order (outstanding first, then superseded ones newest
first):
- The outstanding result is whole.
- Every other result is a row:
  `{ id, summary, commit, taskRevision, submittedBy, supersededBy, acceptedAt, reviewVerdict, createdAt }`.
- `result_id` (a result of the task, else refused as
  `Unknown result of this task: <id>`) also returns that result whole, as
  `resultDetail`.

In every whole result, `diff` becomes an 8,192-byte preview with
`diffBytes` and `diffCut`, using the same exact-UTF-8 trim. The commit is the
authoritative record of the change.

The seal: every whole result passes through the existing
`TaskResultService.applySeal`, the one implementation behind every agent
reader. That covers the outstanding result and `resultDetail`, which goes
through as a one-element list. Rows carry no coverage, maps, checks, or
findings, so they have nothing to seal.

### D9 — Assignment history, publications, acknowledgements

These become newest-50 windows taken in SQL, each with
`{ total, returned, truncated }`. Assignment rows drop `instruction`. The
current outstanding assignment's instruction stays in
`task.assignment.instruction`, so the agent receives it once. They have no
paging arguments. The full history is the human's view, and agents act on
the current assignment and the newest notices.

### D10 — What moves out of `delivery-outcome-metrics`

That change's D5, Table T rows T1–T7, property P2, task group 3, its
ADDED requirement "The agent tool offers drill-down for named metrics", and
the compact parts of its two MODIFIED requirements are replaced by this
change. Its artifacts are edited in the same proposal PR:
- D5 says the projection is defined here, and that the change extends it to
  carry `evidence`, `unavailable`, and the projected `delivery` header.
- Task 3.x becomes one task that extends the projection, with its own
  property row for the extension.
- Its MODIFIED requirements restate this change's text plus its own
  additions.
- It declares that it depends on this change.

## Risks / Trade-offs

- **[Breaking output for running agents]** → the compact forms keep every
  field name they still carry. Running Codex threads see the new output with
  their old catalogue, and the descriptions in fresh threads name the new
  arguments. No stored data changes, so reverting the code restores the old
  output.
- **[Default reads cut long message bodies]** → most task mail is under
  2,000 bytes (measured: 49 KB of bodies across 50 messages), and
  `full_messages: true` returns every body whole. The current instruction
  stays whole in `task`, and findings stay whole in their results.
- **[`full_messages` reopens an unbounded section]** → it is opt-in, false
  by default, and limited to the 50-message window. The descriptions say it
  can be large. On the measured umbrella task it adds about 47 KB over the
  previews.
- **[Diff previews hide part of a submitted diff]** → reviewers read the
  commit in the worktree. The diff field is the submitter's claim, not the
  record.
- **[Live drill pages recompute]** → the end-keyed cache (D3) shares one
  computation per 30 s of a walk. The limit of 200 keeps a 2,595-entry list
  to 13 pages.
- **[Id order is not meaningful]** → the first 50 entries are a stable
  sample, not the "most relevant" ones. The total states how many exist.
- **[Dependency on PR #358]** → if `bounded-task-list` changes
  `AgentTaskRow`, D5 follows it, because both use one helper.

## Acceptance oracles

Every refusal uses the tool-error envelope that the existing unknown-window
refusal uses (hazard "refusals missing the success envelope"). Each row runs
through `teamToolTable` as production composes it, under both runtimes'
registration (hazard M1).

**Table T: metrics and report tools.** Seeded 300-task, 7d fixture with one
metric whose list has 2,595 messages.

| id | call | → result |
|----|------|----------|
| T1 | `team_metrics {window:'7d'}` | no `drill`/`breakdown` key on any metric; serialized < 32 KB; values, `n`, baselines, and flags equal the tab's read at the same moment |
| T2 | `{window:'7d', metrics:['mail_share']}` | `mail_share` has a breakdown, 50 message refs sorted by id, `total.messages` 2,595, and a non-null `next.messages`; other metrics compact |
| T3 | `{…, metrics:['velocity']}` | refused, naming every id in `METRIC_IDS` |
| T4 | `{window:'7d', slice:{kind:'group'}}` | slice rows present; no drill lists |
| T5 | a named metric with 12 task refs | 12 refs, total 12, `next.tasks` null |
| T6 | `process_reports_list {limit:10}` | no `snapshot` key on any report; ids, summaries, and proposals equal the human list's |
| T7 | `process_report_get {report_id}` on a 7d report | compact snapshot; values equal the stored snapshot's |
| T8 | `process_report_submit` (7d) | returned snapshot compact; stored row whole, with 6,998 message refs |
| T9 | two `team_metrics` reads 31 s apart (fake clock) | cursors name different `end`s; each page uses its own end |
| T10 | a page read 1 h after its first cursor (fake clock) | page equals the read at the cursor's `end`, not at now |
| T11 | `team_metrics_drill` with `limit` 0, 201, 1.5 | refused, naming 1–200 |
| T12 | cursor that is not base64url, or has `v:2`, an unknown metric, an unknown list, or a missing `after` | refused as invalid cursor (one row each) |
| T13 | report cursor naming another team's report, or no report | refused `Unknown report: <id>` |
| T14 | a live cursor used from a session of another team | page computed for the caller's team; the first team's ids absent |

**Table G: task_get arguments.** One fixture task with 163 subtasks, 114
messages, 8 revisions, 5 results (1 outstanding), 4 assignments, and 70
acknowledgements.

| id | call | → result |
|----|------|----------|
| G1 | default | subtasks are `AgentTaskRow`s with no `direction` key; `bounds.subtasks` total 163, truncated, `nextBefore` = oldest returned |
| G2 | `subtasks_before` = a task of another parent, an unknown id | refused `Unknown subtask of this task: <id>` |
| G3 | a message body of 6,000 ASCII bytes | body = first 2,000 bytes, `bodyCut` true, `bodyBytes` 6,000 |
| G4 | a body whose 4-byte character straddles byte 2,000 | body ends before it; `bodyBytes` exact |
| G5 | `messages_before` = a message of another task | refused `Unknown message of this task: <id>` |
| G5a | `full_messages: true` on the G3 task | body all 6,000 bytes, `bodyCut` false, `bodyBytes` 6,000; every other section deep-equal to the default read's |
| G5b | `full_messages: true` with `messages_before` walk | same message ids per page as the walk without it; each body equals the stored body |
| G5c | `full_messages` `"yes"`, `1`, `null` | refused, naming `full_messages` as a boolean |
| G6 | default | 8 revision rows with no `direction`/`acceptance` keys; byte lengths equal the stored ones |
| G7 | `revision: 3` | `revisionText` equals revision 3's stored text |
| G8 | `revision` 0, 9, 1.5 | refused `Unknown revision of this task: <n>` |
| G9 | default | `results[0]` whole; 4 rows without `findings`, `coverage`, `reviewerMaps`, or `diff` |
| G10 | `result_id` of a superseded result | `resultDetail` whole, equal to the human detail's record apart from the diff preview |
| G11 | sealed reviewer: default, and `result_id` = the handoff result | submitter coverage withheld in both; own maps only |
| G12 | `result_id` of another task's result, an unknown id | refused `Unknown result of this task: <id>` |
| G13 | a 300 KB diff | `diff` 8,192 bytes or fewer, whole characters, `diffCut` true, `diffBytes` 307,200 |
| G14 | default | no assignment row has `instruction`; `task.assignment.instruction` whole |
| G15 | default | acknowledgements: 50 newest, total 70, truncated |
| G16 | default, serialized | < 256 KB (fixture sized like the live umbrella task: 1,993 journal entries) |
| G17 | the human's detail of the same task | unchanged: every section whole, compared with the pre-change detail fixture |

**Properties.**
- **P1, paging is exactly-once.** Generator: random drill lists of 0–3,000 ids
  with duplicates removed, and random page limits 1–200. The seams are the
  production `team_metrics_drill` handler over a live source (fixed clock)
  and over a stored report. Property: following `next` from the first page
  until it is null returns the sorted list exactly once, and every page
  states the same total. Seed 0xD811, 300 cases.
- **P2, the compact form is a projection.** Generator: random `MetricsInputs`
  built from `metricsSeed.ts`. Property: for every metric, `compactMetrics(m)`
  keeps `value`, `n`, `baseline`, and every flag equal to `m`'s. An expanded
  metric's `breakdown` equals `m`'s. Its drill lists, concatenated with all
  their pages, equal `m`'s, sorted. `m` is deep-equal before and after
  (no mutation). Seed 0xC0DE, 300 cases.
- **P3, subtask and message paging is exactly-once.** Generator: 0–400 rows
  with clustered `created_at` values (ties included), and random anchors.
  Property: walking `nextBefore` covers every row once, newest first.
  Seed 0x5AB7, 200 cases.
- **P4, stored records are unchanged.** For every row of Tables T and G, a
  hash of the stored snapshot, task, revision, result, and message rows
  taken before and after the call is equal.
