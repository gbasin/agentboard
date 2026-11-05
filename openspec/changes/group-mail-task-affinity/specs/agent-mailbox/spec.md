# Spec Delta

## MODIFIED Requirements

### Requirement: Delivery order
Among messages eligible for an agent, the system SHALL deliver urgent messages before normal ones; at equal priority, direct messages before group messages, except that normal group mail due for 15 minutes or longer SHALL come before normal direct mail; and otherwise the oldest first.

#### Scenario: Urgent group mail before normal direct mail
- **WHEN** an idle agent has a normal direct message and an urgent message in its group's mailbox
- **THEN** the urgent group message is delivered first

#### Scenario: Direct before group at equal priority
- **WHEN** an idle agent has a normal direct message and a normal group message that has been due for 5 minutes
- **THEN** the direct message is delivered first

#### Scenario: Aged group mail before direct mail
- **WHEN** an idle agent has a normal direct message and a normal group message that has been due for 20 minutes
- **THEN** the group message is delivered first, and the direct message waits for the agent's next idle moment

#### Scenario: Urgent direct mail still first
- **WHEN** an idle agent has an urgent direct message and a normal group message that has been due for an hour
- **THEN** the urgent direct message is delivered first

#### Scenario: Group mail is not starved by a steady direct stream
- **WHEN** two members of one group keep sending each other normal direct mail, so each finds a direct message waiting every time it goes idle, and a normal group message to that group has been due for 15 minutes
- **THEN** the group message reaches the next of them to go idle

## ADDED Requirements

### Requirement: Group mail records its task owner
When group mail is sent to a group with `affinity: task-owner`, the system SHALL record a task owner on the message. The task SHALL be the message's task, else the sending session's current task. Its owner SHALL be the task's creator when that creator is a session of the target group, else none. Recording the owner SHALL NOT set the message's task or change its envelope.

#### Scenario: Owner from the sender's current task
- **WHEN** a developer working on a task created by lead `A` sends a message to `lead` without `task_id`, and `lead` sets `affinity: task-owner`
- **THEN** the message records `A` as its task owner, and carries no task section

#### Scenario: Explicit task wins
- **WHEN** the same developer sends to `lead` with `task_id` naming a task created by lead `B`
- **THEN** the message records `B` as its task owner

#### Scenario: Creator outside the group
- **WHEN** the resolved task was created by the human or by Kawai
- **THEN** the message records no task owner

#### Scenario: Group without affinity
- **WHEN** a message is sent to a group that does not set `affinity`
- **THEN** the message records no task owner
