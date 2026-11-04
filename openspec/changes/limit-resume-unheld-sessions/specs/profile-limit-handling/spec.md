# Spec Delta

## ADDED Requirements

### Requirement: Limited human sessions resume at the reset
When a human turn, a limit-resume turn, or an agent-started turn of a session holding no delivered or parked message ends after a final limit event whose reset is still ahead, in a session the human created, the system SHALL schedule a limit-resume message to that session at the reset, telling it to continue where it stopped. Spawned sessions, credit limits, and interrupted turns SHALL schedule nothing. Held messages SHALL be handled as before.

#### Scenario: Human turn hits the limit
- **WHEN** a human-created session with no held mail ends a human turn after a final five-hour limit resetting in 90 minutes
- **THEN** a limit-resume message to that session is scheduled for the reset and delivered then, and the session starts a turn without human input

#### Scenario: Agent-started turn hits the limit
- **WHEN** a background agent's notification starts a turn in a human-created session with no held mail and that turn ends after a final limit
- **THEN** a limit-resume message to that session is scheduled for the reset

#### Scenario: Held work parks instead in an agent-started turn
- **WHEN** an agent-started turn of a human-created session that holds a delivered message ends after a final limit
- **THEN** that message is parked with its resume, as before, and no limit-resume is scheduled

#### Scenario: Human turn while holding mail
- **WHEN** a human turn of a human-created session that holds a delivered message ends after a final limit
- **THEN** a limit-resume is scheduled at the reset and the held message is left as it was

#### Scenario: Spawned session
- **WHEN** a session created by staffing, holding no mail, ends a turn after a final limit
- **THEN** no limit-resume is scheduled

#### Scenario: Credit limit
- **WHEN** a human-created session's turn ends after a credit limit (HTTP 402)
- **THEN** no limit-resume is scheduled

#### Scenario: Reset already passed
- **WHEN** the final limit's reset is not after the turn's end
- **THEN** no limit-resume is scheduled

#### Scenario: Interrupted turn
- **WHEN** the human stops a turn that had recorded a final limit
- **THEN** no limit-resume is scheduled

### Requirement: Limit-resumes name the workers lost to the limit
A limit-resume message SHALL list each of the session's agent workers that ended failed with a limit error since the session's last successful human or limit-resume turn, by description and task id, and SHALL tell the agent that their work was lost and to re-dispatch what is still needed. A worker that fails with a limit error while a limit-resume is pending SHALL be added to that pending resume, keeping its delivery time.

#### Scenario: Two background agents lost
- **WHEN** two background agents of a human-created session fail with HTTP 429 limit errors and the session's turn ends after the final limit
- **THEN** the limit-resume names both agents by description and task id and tells the agent to re-dispatch them if still needed

#### Scenario: Worker fails after scheduling
- **WHEN** a second background agent fails with a limit error after the limit-resume was scheduled and before it is delivered
- **THEN** the delivered limit-resume names that agent too, at the same delivery time

#### Scenario: Worker failing for another reason
- **WHEN** a background agent fails with an error that is not a limit error
- **THEN** the limit-resume does not name it

### Requirement: A session has at most one pending limit-resume
A session SHALL have at most one pending limit-resume. A later final limit SHALL replace it with one scheduled at the later of the two resets, keeping the workers it named. A replaced limit-resume SHALL never be delivered.

#### Scenario: Second limit with a later reset
- **WHEN** a session with a limit-resume pending for 21:50 ends another turn after a final limit resetting at 23:00
- **THEN** exactly one limit-resume is pending, for 23:00, and the 21:50 one is not delivered

#### Scenario: Second limit with an earlier reset
- **WHEN** a session with a limit-resume pending for 23:00 ends a turn after a final limit resetting at 21:50
- **THEN** exactly one limit-resume is pending, for 23:00

### Requirement: The human's own activity cancels a pending limit-resume
A successful human turn in the session SHALL cancel its pending limit-resume and clear its consecutive-resume count. Archiving the session SHALL cancel the pending limit-resume, which SHALL NOT restore the archived session. A successful turn the agent started itself SHALL NOT cancel it.

#### Scenario: Human continues before the reset
- **WHEN** the human sends a message to a session with a pending limit-resume and that turn succeeds
- **THEN** the limit-resume is cancelled and is not delivered

#### Scenario: Session archived while waiting
- **WHEN** the human archives a session with a pending limit-resume
- **THEN** the limit-resume is cancelled, and the session stays archived at the reset

#### Scenario: Background task completes while waiting
- **WHEN** a background task's notification starts a turn in a session with a pending limit-resume and that turn succeeds
- **THEN** the limit-resume stays pending and is delivered at the reset

### Requirement: Limit-resumes are bounded and never re-routed
A limit-resume message SHALL never be parked, released, or forwarded, and SHALL never count as work held by the session. When the turn handling it ends after another final limit, the next limit-resume SHALL be scheduled at that reset, up to 3 consecutive limit-resumes; after the third, none SHALL be scheduled until a successful human or limit-resume turn of the session.

#### Scenario: Resume hits the limit again
- **WHEN** the turn handling a session's first limit-resume ends after a final limit
- **THEN** a second limit-resume is scheduled at the new reset, and the first is neither parked nor released to a group

#### Scenario: Cap reached
- **WHEN** the turn handling a session's third consecutive limit-resume ends after a final limit
- **THEN** no further limit-resume is scheduled

#### Scenario: Count restarts after success
- **WHEN** a session's limit-resume turn succeeds and a later turn ends after a final limit
- **THEN** a limit-resume is scheduled as the first of a new run

#### Scenario: Delivered resume is not held work
- **WHEN** a session whose last delivered message is a limit-resume ends a later turn after a final limit
- **THEN** no message is parked and a limit-resume is scheduled

### Requirement: A pending limit-resume shows the session as paused
While a session has a pending limit-resume, the system SHALL show that session as paused, with the limited profile as the reason and the resume time. The pause SHALL clear when the limit-resume is delivered or cancelled.

#### Scenario: Paused until the reset
- **WHEN** a limit-resume is scheduled for a session at 21:50
- **THEN** the session is shown as paused after a provider limit, resuming at 21:50

#### Scenario: Pause clears on cancel
- **WHEN** the human's successful turn cancels the pending limit-resume
- **THEN** the session is no longer shown as paused
