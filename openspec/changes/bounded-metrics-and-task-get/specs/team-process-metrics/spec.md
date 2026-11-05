# Spec Delta

## ADDED Requirements

### Requirement: The agent tool expands named metrics
A `team_metrics` call naming metric ids SHALL return those metrics with their breakdowns and their drill lists, sorted by id. Each list SHALL hold at most its first 50 entries, its total, and a cursor to the rest, null when nothing remains. An unknown metric id SHALL be refused, naming the known ids.

#### Scenario: Expand one metric
- **WHEN** the lead calls `team_metrics` with window `7d` and metrics `["mail_share"]`, and 2,595 messages are behind that metric
- **THEN** `mail_share` carries its breakdown, the first 50 message refs by id, total 2,595, and a messages cursor
- **AND** every other metric stays compact

#### Scenario: Short list needs no cursor
- **WHEN** a named metric has 12 task refs
- **THEN** all 12 are returned with total 12 and a null tasks cursor

#### Scenario: Unknown metric id
- **WHEN** an agent names metric `velocity`
- **THEN** the call is refused naming the known metric ids, through either tool runtime

### Requirement: Drill lists are paged by cursor
`team_metrics_drill` SHALL page one drill list in id order, with its total and next cursor. It takes a cursor and optional integer `limit` (1–200, default 100). Live cursors SHALL keep the issuing read's window end over current retained records; report cursors SHALL use the frozen snapshot. Malformed cursors, invalid limits, and reports outside the caller's team SHALL be refused.

#### Scenario: Paging to the end
- **WHEN** an agent pages a list of 2,595 refs from its first cursor with limit 200 until the cursor is null
- **THEN** every ref of the unchanged team is returned exactly once, in id order, and each page states total 2,595

#### Scenario: Live pages keep their window end
- **WHEN** an agent reads page 2 an hour after the read that gave the first cursor, with source records unchanged
- **THEN** the page is computed for the first read's window end, not for now

#### Scenario: Malformed cursor
- **WHEN** the cursor has malformed base64url JSON, missing or unknown fields, or invalid field values
- **THEN** the call is refused saying the cursor is invalid, through either tool runtime

#### Scenario: Limit out of range
- **WHEN** `limit` is 0, 201, or 1.5
- **THEN** the call is refused naming the range 1–200, through either tool runtime

#### Scenario: Another team's report
- **WHEN** a cursor names a report of another team
- **THEN** the call is refused as an unknown report

### Requirement: The Metrics tab reads metrics whole
The Metrics tab's reads SHALL NOT be compacted or capped. Every drill entry and breakdown stays reachable there, and compacting an agent read SHALL NOT change the value the tab shares with it.

#### Scenario: Tab keeps the whole drill list
- **WHEN** the human opens `mail_share` in the Metrics tab for a 7d window with 2,595 messages behind it
- **THEN** all 2,595 messages are listed

## MODIFIED Requirements

### Requirement: Agents read metrics through a read-only tool
The `kawai-team` server SHALL offer `team_metrics`, taking a window, an optional slice, and optional metric ids, and returning the caller's team metrics with the values the Metrics tab computes. By default every metric SHALL be compact: its value, `n`, baseline, and flags, without drill lists or breakdowns, with slice rows only when a slice is asked. An unsliced compact read SHALL stay under 32 KB. It SHALL be allowed without approval cards and SHALL change nothing, and no agent tool SHALL change a metric definition, guard pairing, or sample threshold.

#### Scenario: Lead reads its team
- **WHEN** the lead calls `team_metrics` with window `7d`
- **THEN** it receives its own team's metric set with `n`, baselines, flags, and guards, without drill lists, in under 32 KB

#### Scenario: Same values as the tab
- **WHEN** the Metrics tab and a compact `team_metrics` call read the 7d window at the same moment
- **THEN** every value, `n`, baseline, and flag is identical

#### Scenario: Flags survive compaction
- **WHEN** a metric is insufficient, partial, approximate, or not sliceable
- **THEN** the compact read carries the same flag

#### Scenario: Sliced compact read
- **WHEN** an agent calls `team_metrics` with window `7d` and slice `{kind: "group"}`
- **THEN** the metrics carry their slice rows, without drill lists

#### Scenario: Unknown window
- **WHEN** an agent calls `team_metrics` with window `30d`
- **THEN** the call is refused naming the allowed windows

