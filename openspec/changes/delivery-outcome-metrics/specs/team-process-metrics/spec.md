# Spec Delta

## ADDED Requirements

### Requirement: Landed-result share measures delivery of done tasks
Kawai SHALL report `landed_result_share`: of the tasks first done in the window that have a result, the share whose newest result's commit is contained by the window's end on the default branch. Unresolvable commits (anything but a known full literal id), commits whose containment at the end is unknown, and tasks without a result SHALL be excluded and counted in the coverage note. While delivery facts are unavailable, the metric SHALL read as unavailable.

#### Scenario: Done but not merged
- **WHEN** 10 tasks are first done in the window with results and 4 of those commits have landed by the window's end
- **THEN** `landed_result_share` reads 0.4 with `n` 10

#### Scenario: Acceptance is independent
- **WHEN** no result was ever accepted but all 10 commits landed
- **THEN** `landed_result_share` reads 1.0 and `accepted_result_share` still reads 0

#### Scenario: Landing unknown at the end
- **WHEN** one of 10 commits first landed at a first-parent position whose containment by the window's end is unknown
- **THEN** `landed_result_share` has `n` 9, and its coverage note counts one unknown landing

#### Scenario: Abbreviated commit
- **WHEN** one of 10 results names a 7-digit commit prefix
- **THEN** `landed_result_share` has `n` 9, and its coverage note counts one unresolvable commit

### Requirement: Trends are series of 7d reads
Kawai SHALL compute trends for a team over a range of 4, 8, or 12 weeks: one point per week for every metric, ending at the read time and stepping back 7 days. Each point SHALL equal the 7d read ending at that point's end over the same records and delivery facts, with its value, `n`, baseline, flags, and markers, and SHALL carry the rules that fired at it. Points are recomputed from current records and facts, not what was known then. Trends SHALL NOT be stored.

#### Scenario: A point is a past read
- **WHEN** the 12-week trend's point ending 2026-10-27 is compared with a 7d read ending at the same moment over the same facts
- **THEN** every value, `n`, and baseline is identical

#### Scenario: Rule marks
- **WHEN** the delivery-drop rule fired for the 7d window ending 2026-10-27 and not one week earlier
- **THEN** only the 2026-10-27 point carries `delivery-drop`

#### Scenario: Unknown range
- **WHEN** a trends request names range `6w`
- **THEN** it is refused, naming 4w, 8w, and 12w

#### Scenario: Recomputed, not remembered
- **WHEN** a fetch brings a commit backdated into a past point's window
- **THEN** that point's values change on the next read, and the view states when and from which head it was recomputed

### Requirement: Trend points state incomplete inputs
A metric at a trend point SHALL keep the legacy flags its 7d read computes, and SHALL separately be marked incomplete evidence when either side's evidence is incomplete: an unknown membership or containment, approximate history, or source coverage not supplied as supported over its required span. A rule mark SHALL need complete evidence and a current projected state. A point before the team's first recorded data SHALL read as no data.

#### Scenario: Limit tax beyond coverage
- **WHEN** the 8-week trend includes a point ending 40 days ago and supplied coverage starts 30 days ago
- **THEN** that point's limit tax is marked incomplete evidence, and its legacy flags are unchanged

#### Scenario: Baseline beyond usage retention
- **WHEN** the 12-week trend's oldest point has a window starting 84 days ago and a baseline starting 91 days ago
- **THEN** that point's token metrics keep the partial flags the 7d read computes today

#### Scenario: Coverage unknown
- **WHEN** no producer supplies source coverage
- **THEN** every token and limit metric at every point is marked incomplete evidence, and no token rule mark appears

### Requirement: A metrics read can end at a chosen time
The Metrics tab SHALL accept a read ending at a chosen past time. Such a read SHALL equal that trend point, and every refresh or re-send of that view SHALL keep the chosen end until another is chosen. A read without one SHALL end now, as today.

#### Scenario: Refresh keeps the end
- **WHEN** the human opens the 7d window ending 2026-10-20 and presses Refresh
- **THEN** the refreshed read still ends 2026-10-20

### Requirement: The Metrics tab has a Trends view
The Metrics tab SHALL offer a Trends view with a range choice of 4, 8, or 12 weeks. It SHALL show one chart per metric, grouped by family, with marks on points where a rule fired. It SHALL show the delivery state projected at return, and an accessible table alternative listing every point's value and `n`. Choosing a point SHALL open the 7d window that point represents. The location SHALL name the view and range, and controls SHALL disable while disconnected.

#### Scenario: Open a point
- **WHEN** the human chooses the point ending 2026-10-27 on the changes-landed chart
- **THEN** the Metrics tab shows the 7d window ending at that moment, with its drill-down

#### Scenario: Location restored
- **WHEN** the human reloads on `#/team/<key>/metrics/trends/12w`
- **THEN** the Trends view opens with the 12-week range

#### Scenario: Keyboard and screen reader
- **WHEN** a keyboard user reaches a chart
- **THEN** its table alternative lists each point's end date, value, `n`, and fired rules

### Requirement: Live drill cursors expire with their facts generation
A live drill cursor SHALL carry the identity of the delivery facts generation it was issued under. `team_metrics_drill` SHALL serve it only while that generation is still the accepted one, and otherwise SHALL refuse it as expired, telling the agent to read `team_metrics` again. Report cursors SHALL NOT expire with a generation.

#### Scenario: Generation changes between pages
- **WHEN** an agent reads a live drill page, a new facts generation is accepted, and the agent asks for the next page
- **THEN** the call is refused as an expired cursor naming the generation change, through either tool runtime

#### Scenario: Unchanged generation
- **WHEN** no new generation is accepted during the walk
- **THEN** every page is served for the issuing read's end and generation

#### Scenario: Report cursor during a generation change
- **WHEN** a new generation is accepted while an agent pages a report's drill list
- **THEN** the pages are still served from the frozen snapshot

## MODIFIED Requirements

### Requirement: Guard metrics are paired and shown together
Each efficiency metric SHALL be shown beside its fixed guard:
- task lead time with the share of done tasks whose result landed on the default branch;
- group mail share, fix iterations, and finding fail rate with reopen rate;
- tokens per task with first-pass review yield for the same slice;
- tokens per landed change with reopen rate.

No surface or tool SHALL change a metric's definition or its guard.

#### Scenario: Faster but unverified
- **WHEN** lead time drops while the landed-result share also drops
- **THEN** both appear side by side for the same window

#### Scenario: Acceptance share is coverage only
- **WHEN** the Metrics tab shows task lead time
- **THEN** its guard is the landed-result share, and the accepted-result share appears among the coverage metrics

### Requirement: Agents read metrics through a read-only tool
The `kawai-team` server SHALL offer `team_metrics`, taking a window, an optional slice, and optional metric ids, and returning the caller's team metrics with the values the Metrics tab computes. By default every metric SHALL be compact: its value, `n`, baseline, flags, `unavailable` reason, evidence, and the projected delivery header, without drill lists or breakdowns, with slice rows only when a slice is asked. An unsliced compact read SHALL stay under 32 KB. It SHALL be allowed without approval cards and SHALL change nothing, and no agent tool SHALL change a metric definition, guard pairing, or sample threshold.

#### Scenario: Lead reads its team
- **WHEN** the lead calls `team_metrics` with window `7d`
- **THEN** it receives its own team's metric set with `n`, baselines, flags, and guards, without drill lists, in under 32 KB

#### Scenario: Same values as the tab
- **WHEN** the Metrics tab and a compact `team_metrics` call read the 7d window at the same moment over the same delivery facts
- **THEN** every value, `n`, baseline, and flag is identical

#### Scenario: Flags survive compaction
- **WHEN** a metric is insufficient, partial, approximate, not sliceable, unavailable, or has incomplete evidence
- **THEN** the compact read carries the same flag, reason, evidence, and projected delivery state

#### Scenario: Sliced compact read
- **WHEN** an agent calls `team_metrics` with window `7d` and slice `{kind: "group"}`
- **THEN** the metrics carry their slice rows, without drill lists

#### Scenario: Unknown window
- **WHEN** an agent calls `team_metrics` with window `30d`
- **THEN** the call is refused naming the allowed windows
