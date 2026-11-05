# Spec Delta

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

#### Scenario: Report frozen before delivery metrics
- **WHEN** a report frozen before the delivery family existed is read
- **THEN** its snapshot has no delivery metrics, and the reader shows them as absent rather than 0
