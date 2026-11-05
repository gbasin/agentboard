# Spec Delta

## ADDED Requirements

### Requirement: Groups may route by task owner
A group's frontmatter SHALL accept `affinity: task-owner` and `affinityWait` in whole minutes, defaulting to 30; other values SHALL be reported and ignored. When a message records a task owner who is an eligible candidate, the built-in strategy SHALL pick the owner before applying the group's `strategy`, even when the owner's profile ranks lower or another member has been idle longer.

#### Scenario: Owner preferred over the longest-idle member
- **WHEN** lead `B` has been idle for 10 minutes, lead `A` has just become idle, and a group message records `A` as its task owner
- **THEN** `A` receives the message

#### Scenario: Owner preferred under profile order
- **WHEN** a group uses `profile-order`, an idle member on its first profile exists, and the idle task owner is on its second profile
- **THEN** the task owner receives the message

#### Scenario: Invalid affinity value
- **WHEN** a group file sets `affinity: newest`
- **THEN** the group reports the invalid value and routes without affinity

#### Scenario: No owner recorded
- **WHEN** a message to an affinity group records no task owner
- **THEN** the group's `strategy` routes it as before

### Requirement: A busy task owner holds its mail for a bounded wait
When a message's task owner is a live member excluded only because it is working or awaiting a card, routing SHALL hold the message until `affinityWait` minutes after its creation, then route it by the group's `strategy`. The owner going idle first SHALL end the hold. When the owner is gone, archived, context-exhausted, unavailable, parked, cooling, or excluded by the message's filters, routing SHALL NOT wait for it.

#### Scenario: Owner busy within the wait
- **WHEN** a message to `lead` was created 10 minutes ago with `affinityWait: 30`, its owner `A` is working, and lead `B` is idle
- **THEN** the message stays queued and is routed again at 30 minutes after creation or when candidates change

#### Scenario: Owner frees up within the wait
- **WHEN** that owner `A` becomes idle 12 minutes after the message was created
- **THEN** `A` receives the message

#### Scenario: Wait runs out
- **WHEN** the owner is still working 30 minutes after creation and `B` is idle
- **THEN** `B` receives the message

#### Scenario: Cooling owner does not hold
- **WHEN** the owner's profile is cooling and another member is idle
- **THEN** the other member receives the message without waiting

#### Scenario: Context-exhausted owner does not hold
- **WHEN** the owner is flagged context-exhausted and another member is idle
- **THEN** the other member receives the message without waiting

#### Scenario: No other candidate
- **WHEN** the wait has run out, the owner is still working, and no other member or spawn slot is eligible
- **THEN** the message waits as group mail with no eligible candidate does, and the owner receives it once idle

### Requirement: Rules see the task owner
The route context given to routing rules SHALL include the message's recorded task owner as an additive metadata field, absent when the message has none. A rule's pick or hold SHALL take precedence over the owner preference and the owner hold. When the rule returns default, the built-in strategy SHALL apply both.

#### Scenario: Rule reads the owner
- **WHEN** a message that records owner `A` is routed through a group rule
- **THEN** the rule's context shows `A` beside the message's other metadata

#### Scenario: Rule overrides the owner
- **WHEN** the rule picks member `B` while owner `A` is also idle
- **THEN** `B` receives the message

## MODIFIED Requirements

### Requirement: Eligibility is one reusable pure check
Kawai SHALL decide which members and spawn slots may take group mail with one pure check over a stated routing state: workers, caps, choice, role list, members, task owner, cooldowns, staffing counts, and an evaluation time. It SHALL return eligible candidates in preference order, an eligible task owner first, with every excluded alternative's reasons as waiting-constraint kinds. Routing, waiting reasons, the dispatch preview, the capacity tool, and observers evaluating a past cutoff SHALL all use it, and it SHALL perform no I/O.

#### Scenario: Exclusion reasons per alternative
- **WHEN** a message chose `zai`, an idle `sonnet` member exists, and the `glm` worker is at its cap
- **THEN** the check returns no eligible candidate, the `sonnet` member excluded by `worker-choice`, and the `glm` slot excluded by `profile-cap` with its counts

#### Scenario: Evaluation at an incident cutoff
- **WHEN** an observer supplies the routing state as of an earlier cutoff, including the cooldowns then in force
- **THEN** the check returns the eligibility routing would have computed at that time, and reads no current state

#### Scenario: Same answer as a live pass
- **WHEN** the dispatcher routes a message, and the check is called with the same state
- **THEN** both name the same eligible candidates and the same exclusion reasons

#### Scenario: Task owner ranked first
- **WHEN** the state names task owner `A`, and `A` and `B` are both eligible with `B` idle longer
- **THEN** the check returns `A` before `B`
