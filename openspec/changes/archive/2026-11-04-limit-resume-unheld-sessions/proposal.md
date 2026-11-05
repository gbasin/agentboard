# Proposal

## Why

A chat the human started stays idle after a provider limit resets. Recovery
after a limit only exists for team mail: the turn's work is parked and a resume
message goes out at the reset. A human instruction is not mail, so there is
nothing to park. In the incident on 2026-11-03, the session `mcp-optimization`
hit the five-hour limit at 20:20Z. Kawai recorded the final limit event with
the correct 21:50Z reset. Its two background agents died with HTTP 429, and the
session then sat idle for ten hours, until the human typed "continue". The
human wants such a session to continue unattended once the limit resets.

## What Changes

- When a human-created session (one not spawned by staffing) has a turn end
  after a final limit, and the session holds no team work for the limit to
  park, Kawai schedules one direct **limit-resume** message to that session at
  the reset. Human turns and turns the agent started itself are both covered.
- The resume names the limit and lists the session's agent workers that failed
  on a limit error, so the agent knows which delegated work was lost and can
  re-dispatch it. A worker that fails on a limit while the resume is pending
  is added to it.
- A session has at most one pending limit-resume. A later limit moves it to
  the later reset.
- A successful human turn before the reset cancels the pending resume.
  Archiving the session cancels it too.
- A limit-resume message is never parked, released, or forwarded. If the turn
  that handles it hits a limit again, the next resume is scheduled, up to 3
  consecutive resumes. After that Kawai stops and leaves the session to the
  human.
- While a limit-resume is pending, the session shows as paused with the reason
  and resume time, like parked work.
- Credit limits (HTTP 402) schedule nothing, because they have no reset, which
  matches parking. Spawned sessions are unchanged: their work arrives as mail
  and already recovers through parking.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `profile-limit-handling`: adds the limit-resume for human-created sessions
  that hold no work. It covers scheduling, the failed-worker list, supersession
  and cancellation, the consecutive-resume cap, and the paused display.

## Impact

- `src/server/team/routing/limitOutcomes.ts`: the no-held-work branch of
  `turnEnded`. Limit-resume messages are excluded from `currentWork`, and a
  delivered limit-resume is never resolved by the group policy.
- `src/server/team/mailboxStore.ts`: a query for a session's pending
  limit-resume, used to supersede and cancel it.
- `src/server/team/sessionMailbox.ts` and
  `src/server/chat/ChatSessionManager.ts`: pass in the session's `spawned` flag
  and worker roster. Cancel the resume on archive. Extend `parkedState` so a
  pending limit-resume shows as paused.
- `docs/recovery-matrix.md`: a new row for the fault "human session limited,
  never resumed". `docs/architecture/routing.md`: the Limits bullet.
- No schema migration: the resume is an ordinary scheduled team message, and
  its attempt number is carried in its tags. No new dependency, setting, or
  client protocol message.
