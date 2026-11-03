# Proposal

## Why

`bounded-task-list` fixed the largest agent read. A measurement of every other
agent read on the live team (2026-11-03: 443 tasks, one umbrella task with
1,993 journal entries, 163 subtasks, and 114 messages) found five responses that are
still larger than most agents' context windows:

| Read | Size | What fills it |
|---|---|---|
| `process_reports_list` (default limit 10) | 2.65 MB | each report's frozen metrics snapshot (99%) |
| `task_get` on the umbrella task | 1.01 MB | 100 full subtask records (78%) |
| `process_report_get` (a 7d report) | 803 KB | the snapshot's drill lists |
| `process_report_submit` | ≈ 803 KB | echoes the snapshot it just froze |
| `team_metrics` with window `7d` | 775 KB | per-metric drill lists: 6,998 message refs and 712 task refs (98%) |
| `task_get` on a task with few subtasks | 412 KB | 8 full revisions, every result whole, repeated instructions |

Even `process_reports_list` with `limit: 1` is about 200k tokens. Agents
cannot call these tools safely today, and the sizes grow with team history.

`delivery-outcome-metrics` already specified a compact metrics read (its D5
and task group 3). It has no paging, and it ships with a large change whose
other tasks wait on an unmet prerequisite. This change takes that part over,
adds per-metric paging, and bounds the sections of `task_get` that
`bounded-log-reads-and-task-get` left whole.

## What Changes

**Metrics and reports**
- **BREAKING (agent tool output):** `team_metrics` returns a compact metric
  set by default: every value, `n`, baseline, and flag, but no drill lists
  and no breakdowns. A new `metrics` argument names metrics to expand. Each
  named metric carries its breakdown, at most 50 entries per drill list, the
  list's total, and a cursor to the next page. An unknown metric id is
  refused, naming the known ids.
- New read-only tool `team_metrics_drill`. Given a cursor, it returns the next
  page (1–200 entries, default 100) of one drill list. A cursor from a live
  read pages over that read's fixed window end; a cursor from a report pages
  over the frozen snapshot. Every entry is reached exactly once.
- **BREAKING:** `process_reports_list` returns reports without their frozen
  snapshots. `process_report_get` and `process_report_submit` return the
  snapshot in the same compact form, with the same `metrics` argument on
  `process_report_get`. Stored snapshots are never rewritten. Unlike
  `delivery-outcome-metrics`, there is no `full` flag: the whole snapshot is
  reachable by paging, and the Metrics tab keeps showing it whole.

**task_get**
- **BREAKING:** subtasks become `bounded-task-list`'s compact `AgentTaskRow`.
  A new `subtasks_before` argument pages through them.
- **BREAKING:** message bodies become previews of at most 2,000 bytes with
  byte metadata, as journal entries are. A new `messages_before` argument pages
  through messages. A new `full_messages` argument (default `false`) returns
  every body in the window whole.
- **BREAKING:** `revisions` become a newest-50 window of rows without text,
  with rationale previews, paged by a new `revisions_before` argument. The
  current direction stays whole in `task`. A new `revision` argument returns
  one revision's full text.
- **BREAKING:** only the outstanding result is returned whole. Other results
  become a newest-50 window of rows, with summary previews, paged by a new
  `results_before` argument. A new `result_id` argument returns one result
  whole. Both whole forms go through the existing blind-first seal. Each
  whole result's `diff` becomes a preview of at most 8,192 bytes with byte
  metadata.
- New read-only tool `task_result_diff_read` returns any result's diff
  losslessly in 8,192-byte chunks, as `task_journal_read` does for journal
  entries. A result may carry a diff without a commit, so the diff can be
  the only record of the change.
- **BREAKING:** assignment history rows drop the verbatim `instruction`,
  which the current assignment keeps in `task`. Assignments, publications,
  and acknowledgements become newest-50 windows, each with its total.
- The tool descriptions and the team prompt's notes say what is compact and
  how to page.

**Not changed:** the human's Metrics tab, Tasks tab, and their WebSocket
reads; stored records; metric definitions and values; `task_list` and
`task_journal_read`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-process-metrics`: `team_metrics` is compact by default, expands named
  metrics with capped drill lists and cursors, and is paged by the new
  `team_metrics_drill` tool.
- `process-reports`: `process_reports_list` drops snapshots;
  `process_report_get` and `process_report_submit` return compact snapshots
  whose drill lists are paged.
- `team-tasks`: the bounded `task_get` gains compact subtask, revision,
  result, assignment, and message sections, more windows, and paging and
  single-record arguments, plus a lossless diff reader. It rewrites the
  "Results and revisions stay whole" scenario: results and revisions become
  windows reached by anchors.

## Impact

- `src/shared/processMetrics.ts`: the compact projection, drill cursors, and
  page types.
- `src/server/metrics/metricsTools.ts`, `computeMetrics.ts` (a read at a
  chosen end, cached by end), a new `metricsDrill.ts`, `reportTools.ts`, and
  `reportService.ts` (agent projections). The human's `list` and `report`
  paths are unchanged.
- `src/server/team/taskJournalWindow.ts`, `taskTools.ts`, `taskStore.ts`, and
  `src/shared/teamTasks.ts`: the new `task_get` sections and arguments, with
  the seal applied as before, and the `task_result_diff_read` reader beside
  `task_journal_read`.
- `src/server/team/teamPrompt.ts`, `docs/architecture/` (the task tools and
  process-metrics bullets).
- Tests: `metricsTools.test.ts`, the report tool tests, the `task_get` tests,
  `teamPrompt.test.ts`, and the tool-table test.
- **Depends on `bounded-task-list` (PR #358)**, which introduces `AgentTaskRow`.
- **Edits `delivery-outcome-metrics`:** its D5, its Table T and property P2,
  task group 3, and its compact-read spec deltas move here. What stays there
  extends this change's projection: it keeps that change's `evidence` field
  and `delivery` header, and its new metric ids.
- `tool-call-metrics` refers to "the Delivery D5 `compactMetrics`
  projection" for its inline Tools drill. That projection is now this
  change's. The 50-entry cap is unchanged.
- Codex threads keep the tool catalogue they had at thread start. The compact
  output reaches them at once. The new arguments and `team_metrics_drill`
  reach only fresh threads.
