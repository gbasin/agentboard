# Spec Delta

## ADDED Requirements

### Requirement: Agents read report snapshots compactly
`process_report_get` and `process_report_submit` SHALL return the report's snapshot in the compact form of `team_metrics`. `process_report_get` SHALL accept the same optional metric ids, expanding those metrics with drill lists capped at 50, their totals, and cursors that `team_metrics_drill` pages over the frozen snapshot. Compacting SHALL NOT change a stored snapshot.

#### Scenario: Reading a 7d report
- **WHEN** an agent calls `process_report_get` for a 7d report whose snapshot holds 6,998 message refs
- **THEN** the snapshot carries every metric's value, `n`, baseline, and flags, without drill lists or breakdowns

#### Scenario: Expanding a metric of a report
- **WHEN** an agent calls `process_report_get` with metrics `["mail_share"]` and pages that metric's messages cursor to the end
- **THEN** every message ref of the frozen snapshot is returned exactly once, in id order

#### Scenario: Paging a report after new activity
- **WHEN** new mail arrives between two pages of a report's drill list
- **THEN** the pages still list the frozen snapshot's refs, and the total is unchanged

#### Scenario: Submit echoes a compact snapshot
- **WHEN** a reporting agent submits a 7d report
- **THEN** the returned report carries the compact snapshot, and the stored snapshot is whole

#### Scenario: Stored snapshot unchanged
- **WHEN** a report is read compactly, expanded, and paged
- **THEN** its stored snapshot is byte-identical before and after

## MODIFIED Requirements

### Requirement: Reports are listed with their freshness
The Metrics tab SHALL list reports newest first with window, author, summary, frozen snapshot, and proposals with their state, and SHALL show the latest report per window and its age. `process_reports_list` SHALL return the same to any team member without frozen snapshots, and `process_report_get` SHALL return one report with its snapshot in compact form.

#### Scenario: Missed daily report
- **WHEN** no 1d report was submitted for 30 hours
- **THEN** the tab shows the latest 1d report's age as 30 hours

#### Scenario: Listing without snapshots
- **WHEN** an agent calls `process_reports_list` with limit 10
- **THEN** each report carries its id, window, author, period, time, summary, and proposals with their state, and no snapshot

#### Scenario: Tab keeps whole snapshots
- **WHEN** the human opens a report in the Metrics tab
- **THEN** its snapshot is shown whole, with every drill list
