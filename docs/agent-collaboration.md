# Agent collaboration pilot

This protocol moves architectural challenge and production-path evidence
before broad implementation. It uses the existing Lead, developer and
reviewer roles, task journals and ordinary messages. It adds no tool rights,
execution stages or automatic gates. Task revisions and linked specifications
remain authoritative; the Lead must reconcile conflicts before dependent work.

Read this document from the team's main checkout, even when working in a linked
worktree. The main checkout is the first worktree in `git worktree list
--porcelain`. References in notes should name the task revision and the exact
design note or commit examined, so another agent can continue without replaying
the conversation.

This pilot composes with the change-lead pilot (`docs/change-lead-pilot.md`):
for one enrolled change a named Change Lead coordinates the work while this
document's design challenge, production-path evidence, independent review, and
direct technical clarification apply unchanged. The two documents never assign
the same stage twice: under that pilot the Change Lead is the one formal
review/fix dispatcher for the enrolled change's results, and a coordinator's
sign-off or agreement is never presented as independent findings — the formal
review stays on the cross-model reviewer path.

## Choose the appropriate path

The Lead records whether a new assignment changes a state machine, concurrency,
recovery, security parsing, persistence, or behavior across subsystems. Such
work uses the design challenge and production-path checkpoints below. A small,
well-specified change can go directly from implementation to final review.
If the developer discovers architectural decisions inside a small task, report
them and pause only the dependent work until the Lead chooses the path.

For each pilot task, journal the risk, developer, named advisory reviewer,
checkpoint scope and next action. Prefer an eligible reviewer from a different
model family and retain that reviewer through corrections while eligible. A
senior may advise read-only, without becoming a second writer. The Lead uses
the current group definitions, live roster, routing and capacity diagnostics.
Configured caps are not running-agent counts. Recheck membership, eligibility
and availability before each request; an earlier named reviewer may no longer
be available. Discover recipients rather than relying on a fixed team size,
profile count or remembered session. Advisory group mail does not create a new
advisor automatically.

When an advisor leaves or becomes unavailable, the Lead records a replacement
or named wait. Give a replacement the current task revision, design decision,
examined commits, outstanding findings and next action. Continuity is preferred,
but does not depend on any particular agent remaining live. A fresh assessment
is conditional on eligible capacity; never assume that an additional reviewer
exists or relax a mandatory cross-model gate to fill the gap.

An unavailable advisor creates a named wait and wake-up condition, not implicit
approval. The Lead may explicitly defer or narrow a checkpoint with a reason
within authorized scope; a required acceptance check cannot be waived by mail.
Continue independent work while the decision is pending.

## Classify implementation questions before escalating

A standing team rule for every role. Before raising a question raised during
implementation, classify it against the task revision and the linked change's
approved proposal, design, delta specs, and tasks:

1. **Answered.** Those artifacts already answer it. Proceed and cite the line
   in the next note; it is not a question.
2. **Local.** The artifacts are silent, and every candidate answer stays
   inside the files the task owns and keeps every spec scenario, decision-table
   row, and stated property true. The writer decides and journals one note:
   the choice, the alternatives, and why. The formal review judges it at the
   result. It needs no dispatch, direction amendment, acknowledgement, or
   advisory round, and the writer does not wait on one.
3. **Contract.** An answer contradicts the artifacts, changes a spec scenario,
   table row, or property, changes behavior outside the task's files, or
   changes scope. Pause only the dependent work, escalate once with context,
   options, and a recommendation to the coordinator (the Change Lead under
   that pilot, else the Lead), and continue independent work. Only this class
   produces a direction amendment and its acknowledgement gate.

**Shared code is not a gate.** A suspected flaw in code the task calls but does
not own (a shared runner, store, or helper) becomes a follow-up task or change
proposal with its evidence, recorded in the journal. The task uses that code as
the approved design says. The flaw blocks the task only when the task would
make it worse, or would rely on behavior the code does not have in a way the
design did not already rely on; that case is class 3.

When unsure between 2 and 3, it is 3 only if you can name the scenario, row,
property, or outside behavior that would change; otherwise it is 2. A reviewer
or advisor who disagrees with a class-2 choice reports it at the result, as a
finding under the role's blocking rules; it does not reopen the question before
the result exists. Misclassifying a class-3 question as class 2 is a finding
the review catches; the cost of that is one fix round, which is smaller than
gating every local choice.

## Challenge the mechanism before substantial coding

The developer posts a compact `task_note` covering:

- **Invariant:** what must always remain true, including relevant boundaries.
- **Ownership:** which component owns state, transitions and persistence.
- **Production path:** entry point, composition, calls and observable outcome.
- **Failure behavior:** relevant cancellation, retry, restart and event orderings.
- **Evidence:** the test or probe that detects a broken invariant, plus affected
  existing workflows. Distinguish planned evidence from checks already run.

Reference existing design sections instead of duplicating them; name any gap
or interpretation. The Lead sends one ordinary direct message to the named
advisor with the task id, note id, revision, developer session and questions.
The advisor reads surrounding code and contracts, looks for counterexamples
and journals the assessment and unresolved risks. The Lead records proceed,
revise or defer and any required direction amendment. The developer does not
treat silence or an advisory opinion as permission to change task scope.
The challenge examines the mechanism and class-3 questions; it does not turn
class-2 choices or shared-code concerns into gates (see "Classify
implementation questions before escalating").

## Review one real production path before expanding it

The developer implements the smallest meaningful path through the actual
production composition to an observable result, with one relevant failure
case. For example, an execution Start must reach the constructed executor and
produce a state transition; constructing that executor only in a test is not
evidence of production wiring. External boundaries may use controlled doubles,
but those doubles must check their arguments and must not replace the wiring
under examination. An intentionally dormant subset must identify deferred
wiring and its later checkpoint explicitly, rather than claim activation.

Record the exact base/head, paths, checks run, outcomes and remaining scope in
a task note. Check test effectiveness while implementing: removing a guard or
running a new-behavior test on the base must fail the relevant assertion.
Preserved-behavior tests must detect a regression instead. Run only relevant
probes at this checkpoint, under the existing suite scheduling and isolation
rules; it is not a requirement to duplicate the full suite.

The advisor examines the pinned commit and challenges the production path and
failure case. Probe in a disposable checkout; use only read-only git in the
developer's worktree. Record what was actually verified, what remains claimed,
and whether a structural issue prevents expansion. The Lead journals the next
step. A materially changed mechanism needs a new assessment of affected paths;
independent work can continue when the Lead has identified its boundaries.

## Shorten technical clarification without changing authority

The appointed developer and advisor/reviewer may exchange ordinary direct
messages about reproductions, affected paths and proposed mechanisms. Include
the task id and note/result/finding references, use its `task_id` for the
direct exchange, and keep each message focused on the next technical decision.
Journal conclusions and unresolved disagreements. Send one consolidated
outcome to the `lead` group, without `task_id` and with the task id in the body,
so it reaches the current Lead under the existing reporting convention. Under
the change-lead pilot that consolidated outcome goes to the named coordinator
instead, with the `lead` group kept for the unavailable-coordinator escalation
(`docs/change-lead-pilot.md` §4).

When a response is needed, journal the named wait and end the turn at a safe
boundary so normal mail can deliver. Do not busy-poll, send acknowledgement
loops or use urgent interruption for routine clarification. If one exchange
does not resolve a disputed mechanism or criterion, send the evidence and
options to the Lead for a decision rather than continuing an open-ended debate.
Clarification about a class-2 choice never holds the writer: the writer
decides, journals it, and the exchange continues at the result if needed.

The Lead need not relay each question. The Lead still owns direction and
assignment decisions within its rights; creator/human acceptance and amendment
rights remain unchanged. A reviewer cannot assign fixes, amend acceptance or
approve a different commit through conversation. If the criterion is wrong or
ambiguous, ask the Lead to reconcile it rather than invent a code defect.
The Lead coordinates any formal handoff; technical mail must not duplicate it.

## Correct the invariant, then check that it holds

An architectural finding concerns ownership, lifecycle, composition or a
cross-path invariant, rather than an isolated typo or local defect. At the
first such finding, the developer records this correction plan before coding:

```text
Task / revision / examined note or result / base and head:
Violated invariant:
Reproduction and observed outcome:
Affected construction, transition and execution paths:
Correction mechanism and why it covers those paths:
Regression tests, variants and relevant boundaries:
Guard removal or base-commit check and expected failing assertion:
Unresolved decision / responsible actor / next action:
```

The reviewer challenges the plan; the Lead resolves architectural direction
before dependent edits. The correction must cover the defect class as well as
the original reproduction. On re-review, distinguish closed, still open,
regressed and new findings. If the first correction still violates the same
invariant, reopen the design with the Lead before another patch; consider a
read-only senior assessment or an explicit takeover. Keep one writer.

For other defect classes, retain escalation after two unsuccessful correction
rounds. Environmental failures and clarified acceptance criteria should be
recorded separately from code defects. Pause only affected work, keep other
authorized work moving and do not infer permission to stop an execution.

## Keep advisory checkpoints separate from final review

Advisory exchanges use `task_note` and ordinary messages, naming the examined
note or exact commit. They do not use `task_handoff`, `task_submit_findings`,
or an incomplete `task_submit_result` to simulate a new checkpoint stage. A
result submission can advance execution-owned work into its review round;
a handoff can supersede the current assignment. Neither is a harmless way to
ask for advice. Never submit a partial production path as a completed result.

Final review retains the existing exact-result/exact-commit contract and
cross-model routing in the role instructions. Recheck checkpoint evidence
against the final head and review conflict resolutions. The eligible continuing
reviewer may perform the formal review; any design input is disclosed, not
presented as a second independent assessment. The Lead coordinates one formal
handoff for manually managed work; under the change-lead pilot the enrolled
change's handoff belongs to its Change Lead, still exactly one per result and
never the coordinator's own sign-off recorded as findings. For execution-owned
work, Kawai owns review
and fix dispatch; agents must not insert manual stages, reassign it or bypass
retry/stop rights. Advisory notes never satisfy its review or acceptance gates.

For security-sensitive behavior, concurrency, recovery or irreversible effects,
the Lead should seek an additional fresh read-only assessment of the critical
invariant from a non-author who did not shape the mechanism. Request it by
ordinary direct mail before final submission, record its independent probes
and resolve material findings before submission. This additional assessment
is advisory; it does not dispatch a second stage or replace the formal review.
If no suitable fresh assessor is available, record that limitation and the
Lead's next step; do not claim that two independent reviews occurred.

## Write acceptance as oracles

Risky work is accepted against oracles written before any of it is coded: a
decision table of observable results, plus one property per invariant. The
linked change's design carries them, so the developer, the cross-model
reviewer, a replacement and a restarted execution all judge the same rows
instead of re-deriving intent from prose. A small, well-specified change
needs none; decision logic, state machines, parsing or security checks, and
concurrency do (`openspec/config.yaml` `rules:` carries the same rule for
artifact authors).

The design's "Acceptance oracles" subsection holds:

- **Decision tables** of observable results only — inputs × outputs, `*`
  for a don't-care, and unreachable combinations listed with their reasons.
  Every row has an oracle id.
- **One property per invariant**, giving the property, the generator, the
  seams, a fixed seed and a case count, with no new dependency.
- For a state machine with recovery, a **completeness claim** — every
  combination of the axes matches exactly one row or one unreachable claim —
  and model-based tests that run the table as the reference model under
  seeded command sequences with replays, supersessions, and a crash at each
  transaction boundary.

For a state machine with recovery, the tables get a blind second reading
before code starts; other oracle work may opt in:

1. Commit A1 holds the inputs only, with every output `?`.
2. An advisor from another model family fills in the outputs from the spec
   alone, without seeing the author's expectations.
3. Commit A2 holds the author's outputs; the two readings are diffed, and
   each disagreement is resolved in the table, not in mail.
4. The Lead records the resolved oracles as binding before code starts.

The executable forms follow the table into the test tree: each row is
committed verbatim as a table-driven test next to the code it covers, and
each property runs as a seeded generator over the named seams. For a state
machine with recovery, the completeness test expands the axes over the
table and the unreachable list, so it has no gap and no overlap, and the
model-based tests run the table as the reference model; a failing seed
found on the way becomes a named table row.

Keep a coverage map from every requirement and behavioral scenario in the
assigned scope to its oracle row and test, and keep it current across task
revisions: tests for changed behavior must detect its absence, and tests for
preserved behavior must detect regressions. An oracle exercised only through
a hand-built harness is not coverage — at least one oracle test per guarded
seam runs through the production composition, and its mutant removes the
wiring.

The reviewer's verdict rule lives in `.kawai/groups/reviewers.md`: for work
whose acceptance has oracles, a finding blocks only when it shows a missing,
unfaithful or vacuous oracle test, a counterexample to a stated property, or
a security or data-loss bug with a reproducer; from round 2, only
regressions, unfixed findings, and new counterexamples with reproducers
block.

Amendments go through the table, not around it: a defect that is neither in
the tables nor in the verdict rule's three blocking classes is a new defect
class, proposed as an oracle amendment the Lead decides and recorded as an
entry in `docs/oracle-hazards.md` — the hazard catalog organized by change
class. A missing row alone never downgrades a blocking class: a stated
property's counterexample and a reproducible security or data-loss bug
block with or without a row, as does untested production wiring. Add an
entry for every new blocking finding, naming the class, the hazard, the
oracle row or property that would have caught it, and the source finding.

Read the rule's effect through `team_metrics`: first-pass review yield and
fix iterations, with reopen rate as the guard metric. Pilot evidence: RC E
ran 1 failed review over 5 results; its baseline RC D (task-707555cd) ran 2
failed reviews over 10 results. Both samples are n=1, so the comparison is
undetermined.

## Roll out and evaluate

New agent starts load the revised group instructions. Running agents retain
their loaded prompt; do not restart, interrupt or contact them automatically
to apply this pilot. At the next safe checkpoint, the Lead can send ordinary
instructions referencing this protocol, within the current task direction and
without changing execution ownership. Preserve ongoing work and pending mail.

Pilot the protocol on the next few risky tasks. At each design decision,
checkpoint and correction outcome, record a task note with the note/commit
reference, defect class, discovery phase, responsible actor, next action and
timestamp. Use those records to compare:

- Architectural defects first discovered during final review.
- Repeated corrections of the same invariant.
- Elapsed time from a blocking finding to verified closure, separating named
  quota, reviewer, suite and human waits where evidence exists.
- Reviewer waiting time and Lead relay messages, including checkpoint overhead.

These are manual pilot observations, not new built-in metrics. Keep code,
coverage, integration, contract and environment outcomes distinct, and attribute
takeovers explicitly. Report available counts and uncertainty; do not invent
missing timings or infer a model ranking from unlike tasks. Review the pilot
in the existing process reports before proposing broader enforcement.
