# Spec Delta

## ADDED Requirements

### Requirement: Waiting reasons name a busy task owner
Group mail held for its busy task owner SHALL have the immediate blocker `owner-busy`, naming the owner session and giving the end of the wait as its retry time. The other members' states SHALL be listed among the other constraints. Once the wait has run out, the reason SHALL no longer name the owner hold.

#### Scenario: Held for the owner
- **WHEN** a message created at 17:00Z with `affinityWait: 30` waits because its owner `A` is working
- **THEN** its reason shows `owner-busy` naming `A` with a retry time of 17:30Z

#### Scenario: Wait over, everyone busy
- **WHEN** it is 17:31Z and every member of the group, including `A`, is working
- **THEN** its reason reports the members as busy and does not show `owner-busy`
