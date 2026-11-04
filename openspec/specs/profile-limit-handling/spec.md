# profile-limit-handling Specification

## Purpose
Keeps team work moving when a provider profile hits its limit: limit events are recorded per profile, profiles cool down, and interrupted work is parked, released, or handed off.

## Requirements

### Requirement: Limit events are recorded per profile
The system SHALL record a limit event when a chat agent's request fails with a rate-limit, billing, or overload error, marking whether it was a retried attempt or the final failure, with the profile, its provider, session, group, time, HTTP status, error message, the limit window when named, and provider reset time when given, read from error text in the provider's `limitResetTimeZone` when it has no zone. Limit events SHALL persist across restart for at least 24 hours.

#### Scenario: Final rate-limit failure
- **WHEN** an agent on profile `glm` of provider `zai` ends its turn with a rate-limit error after retries
- **THEN** a final limit event naming `glm` and `zai` is recorded

#### Scenario: Reset written in the error text
- **WHEN** a `glm` agent's final error says its limit resets at `2026-10-13 17:17:00` and the provider of `glm` sets `limitResetTimeZone: Asia/Shanghai`
- **THEN** the event's reset time is 09:17 UTC that day; without the field the text sets no reset time

#### Scenario: Window recorded
- **WHEN** an agent on profile `opus` receives a rejected rate-limit report for the `seven_day_opus` window and its turn then ends with a rate-limit error
- **THEN** the final limit event records window `seven_day_opus` with that report's reset time

#### Scenario: Survives restart
- **WHEN** the server restarts 10 minutes after a final limit event
- **THEN** routing still sees the event

### Requirement: Profiles cool down after a final limit event
After a final limit event, its provider SHALL be in cooldown until the provider's reset time when known, otherwise for one hour, unless a routing rule decides otherwise; an event whose window covers one model only SHALL instead cool its own profile alone. A profile SHALL be cooling while its provider or the profile itself is, in every group of every team. Profiles of other providers SHALL NOT cool. Retried attempts alone SHALL NOT start a cooldown.

#### Scenario: Only the limited profile cools
- **WHEN** `glm` of provider `zai` has a final limit event and `devs` has idle members on `glm` and on `claude` of another provider
- **THEN** group mail goes to the `claude` member

#### Scenario: Profiles of one provider cool together
- **WHEN** `glm` and `glm-flash` are profiles of provider `zai`, `glm` has a final limit event, and `juniors` allows `glm-flash` and `haiku` of another provider
- **THEN** `glm-flash` is cooling until the same time, so `juniors` group mail goes to a `haiku` member and no `glm-flash` member is spawned for it

#### Scenario: A model-scoped window cools one profile
- **WHEN** `opus` and `sonnet` are profiles of provider `claude` with idle members, and an `opus` agent's final limit event names window `seven_day_opus`
- **THEN** only `opus` cools, and group mail goes to the `sonnet` member

#### Scenario: A short later window does not release a weekly one
- **WHEN** `opus` and `sonnet` are profiles of provider `claude`, `opus` has a final limit event for window `seven_day` that resets in three days, and `sonnet` later has one for window `five_hour` that resets in two hours
- **THEN** both stay cooling until the `seven_day` reset

#### Scenario: Events recorded before providers
- **WHEN** a final limit event recorded without a provider is still within its cooldown
- **THEN** only the profile that recorded it is cooling

#### Scenario: Transient retry
- **WHEN** a request is retried after a 429 and then succeeds
- **THEN** no cooldown starts

### Requirement: Limit failures on claimed messages are resolved
When the turn handling a delivered message fails with a final limit event, the system SHALL resolve the message as park, release, or forward. A routing rule's `onLimit` SHALL decide when present; otherwise the group's `onLimit` frontmatter. The default SHALL be park when the agent made progress and the reset is within `parkIfResetWithin` (default 3h), forward to the same group when it made progress and the reset is later, and release otherwise.

#### Scenario: Close reset parks
- **WHEN** an agent that already ran tool calls for a message hits a limit that resets in 40 minutes
- **THEN** the message is parked on that agent

#### Scenario: Far reset forwards
- **WHEN** an agent that made progress hits a limit resetting in 5 hours
- **THEN** the message is forwarded to its group with a handoff package

#### Scenario: No progress releases
- **WHEN** an agent hits a limit before any tool call for the message
- **THEN** the message returns to its group's queue

### Requirement: Group frontmatter configures limit outcomes
A group's frontmatter SHALL accept an `onLimit` map with `parkIfResetWithin` (a duration such as `90m` or `3h`), `otherwise` (`forward` or `release`, default `forward`) applied when the agent made progress and the reset is later, and `forwardTo` (a group id or team session id, default the same group). Invalid values SHALL be reported and the defaults used.

#### Scenario: Release instead of forward
- **WHEN** `devs` sets `onLimit: { parkIfResetWithin: 1h, otherwise: release }` and a member with progress hits a limit resetting in 2 hours
- **THEN** the message returns to the `devs` queue without a handoff package

#### Scenario: Forward to another group
- **WHEN** `devs` sets `onLimit: { forwardTo: architects }` and a member with progress hits a limit resetting in 5 hours
- **THEN** the message is forwarded to `architects` with a handoff package

#### Scenario: Invalid duration
- **WHEN** `parkIfResetWithin` is set to `soon`
- **THEN** the problem is reported and 3h is used

### Requirement: Parked work resumes on the same agent
Parking SHALL keep the message with the agent and schedule a resume message to that agent at the reset time, delivered before other direct mail. A parked agent SHALL receive no group mail and SHALL be shown as paused with the reason and resume time. If the resume fails on a limit again, the message SHALL be resolved again; after 3 parks it SHALL be released.

#### Scenario: Resume after reset
- **WHEN** the parked agent's resume time arrives
- **THEN** it receives a message to continue the task

#### Scenario: Resume goes before other direct mail
- **WHEN** the resume time arrives while other normal direct mail waits for the parked agent
- **THEN** the agent receives the resume first, and the other mail after it

#### Scenario: Parked agent skipped
- **WHEN** a group message arrives while a member is parked
- **THEN** the parked member does not receive it

#### Scenario: Human message to parked agent
- **WHEN** the user sends a message to a parked agent and the turn succeeds
- **THEN** the scheduled resume is cancelled and the agent is no longer paused

### Requirement: Forwarded work carries a handoff package
A forwarded message SHALL include the task context, the message thread, a progress digest of the previous agent's tool calls and touched files since claim, its last error, the repository commit at claim time, and an instruction to inspect the working directory to reconstruct progress before acting. Forwarding SHALL exclude from routing the limited profile, and the other profiles of its provider while that provider cools.

#### Scenario: Handoff received
- **WHEN** a message is forwarded from a `glm` dev to the `devs` group while `glm` and `glm-flash` of provider `zai` cool
- **THEN** a member on another provider receives it with the progress digest, claim commit, and the instruction to inspect the working directory first, and no `glm-flash` member does

### Requirement: The original agent is released and notified
After forwarding, the original agent SHALL no longer hold the message. When its profile leaves cooldown, it SHALL receive a note naming the task and the agent that took it over.

#### Scenario: Notified on recovery
- **WHEN** the forwarding agent's profile leaves cooldown
- **THEN** it receives a note that the task was handed to the new agent

### Requirement: Users can hand off parked work
The UI SHALL offer a Hand off action on a parked message that forwards it, with a handoff package, to a group or agent the user chooses, regardless of the rule's decision.

#### Scenario: Manual handoff
- **WHEN** the user hands off a parked message to `architects`
- **THEN** the message is forwarded with a handoff package and the parked agent's resume is cancelled

### Requirement: Urgent direct mail to a cooling profile is refused
An urgent message sent directly to an agent whose profile is in cooldown SHALL be refused with an error to the sender stating the agent's profile, its provider when the provider is in cooldown, and the cooldown end time.

#### Scenario: Refused urgent mail
- **WHEN** a team lead sends urgent mail directly to a dev whose `glm` profile cools until 15:40
- **THEN** the send fails with a message naming `glm` and 15:40, and nothing is queued

#### Scenario: Refused for a cooling provider
- **WHEN** a team lead sends urgent mail directly to a dev on `glm-flash` while its provider `zai` cools until 15:40 after a `glm` limit
- **THEN** the send fails with a message naming `glm-flash`, `zai`, and 15:40, and nothing is queued

### Requirement: Limits in agent-started turns park the current work
When a turn the agent started itself (a task notification, a Monitor, or resumed) ends after a final limit event, the system SHALL park the session's current work on that agent with a resume at the reset, whatever the policy, progress, or result subtype. Current work SHALL be the newest message delivered to, parked on, or resumed by the session that it still holds. It SHALL never be released or forwarded; with no current work nothing SHALL be resolved.

#### Scenario: Monitor turn after delivered work
- **WHEN** an agent that was delivered a message later starts a turn from a Monitor event and that turn ends after a final limit resetting in 2 hours
- **THEN** the message is parked on that agent and its resume is scheduled at the reset

#### Scenario: Far reset still parks
- **WHEN** the same happens with a reset 5 hours away and the group sets `otherwise: forward`
- **THEN** the message is parked on that agent, not forwarded

#### Scenario: No current work
- **WHEN** an agent that holds no delivered or parked message hits a final limit in a turn it started itself
- **THEN** no message is parked, released, or forwarded

#### Scenario: Human turn
- **WHEN** a human turn with no delivered message ends after a final limit
- **THEN** no message is parked, released, or forwarded, as before

### Requirement: Agent-started limits respect parked work and the park limit
When the current work is already parked, an agent-started final limit SHALL keep it parked with its resume at the later reset and its park count unchanged. Work parked 3 times SHALL be left as it is, neither parked again nor released. A successful agent-started turn SHALL NOT unpark work; only a human turn or the work's own resume SHALL.

#### Scenario: Already parked
- **WHEN** a parked agent's Monitor turn ends after a final limit resetting later than the scheduled resume
- **THEN** the work stays parked, its resume moves to the later reset, and its park count is unchanged

#### Scenario: Park limit reached
- **WHEN** an agent-started turn ends after a final limit while its current work has been parked 3 times
- **THEN** the work stays delivered to that agent and is not released

#### Scenario: Successful resume unparks
- **WHEN** work parked by an agent-started limit receives its resume and that turn succeeds
- **THEN** the work is no longer parked and the agent is no longer paused

#### Scenario: Successful agent-started turn
- **WHEN** a parked agent's background-task turn succeeds
- **THEN** the work stays parked and its resume is still delivered at the reset

### Requirement: Codex limit failures are recorded as limit events
A Codex turn failing on a usage, rate, spend, credit, or overload limit SHALL record a final limit event. Its reset SHALL be the latest known reset among applicable exhausted windows; cooldown and parked-work resume SHALL use that reset. Non-exhausted windows SHALL NOT extend it. Codex retries SHALL record non-final events only. Other failures SHALL NOT record limit events.

#### Scenario: Usage limit ends the turn
- **WHEN** a Codex member's turn fails because its plan's usage limit was reached and the weekly window resets in 2 days
- **THEN** a final limit event is recorded with that reset time, and the message it was handling is resolved as park, release, or forward

#### Scenario: Multiple exhausted windows
- **WHEN** a Codex turn fails with both the five-hour and weekly windows exhausted, resetting in 1 hour and 2 days respectively
- **THEN** the final limit event and shared-home cooldown use the 2-day reset, and if the work is parked its resume is scheduled for that reset rather than the five-hour reset

#### Scenario: Only one exhausted window
- **WHEN** a Codex turn fails with the five-hour window exhausted and resetting in 1 hour, while the weekly window is below its limit and resets in 2 days
- **THEN** the final limit event and cooldown use the 1-hour reset

#### Scenario: Unrelated failure
- **WHEN** a Codex turn fails because the context window was exceeded
- **THEN** no limit event is recorded

### Requirement: Codex login limits cool the home's provider
A login- or plan-scoped Codex limit event SHALL be recorded once, naming the limited session's Codex home provider (`codex-home-<hash of the resolved home>`), and SHALL cool that home through the shared cooldown, so every profile on the home cools down together. No per-profile copies SHALL be written. A limit scoped to one session's own budget SHALL be recorded for that session's profile only, without a provider. Claude profiles and Codex profiles on other homes SHALL NOT be affected.

#### Scenario: Two profiles on one home
- **WHEN** `codex` and `codex-fast` both use `~/.codex` and a `codex` member hits its usage limit
- **THEN** one limit event names the home's provider, both profiles cool down, and group mail skips members on either one

#### Scenario: Separate homes
- **WHEN** `codex` uses `~/.codex`, `codex-2` uses `~/.codex-2`, and a `codex` member hits its limit
- **THEN** only `codex` cools down

#### Scenario: Session budget
- **WHEN** `codex` and `codex-fast` both use `~/.codex` and a `codex` member's turn fails because its own session budget is exhausted
- **THEN** only `codex` cools down, its event carries no provider, and members on `codex-fast` keep receiving group mail

#### Scenario: Forwarding avoids the shared login
- **WHEN** work from a limited `codex` member is forwarded to a group with members on `codex-fast` and `default`
- **THEN** a `default` member receives it

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
