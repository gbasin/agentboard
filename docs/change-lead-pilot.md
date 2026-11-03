# Change Lead pilot

A bounded, opt-in protocol that delegates detailed coordination of one complex
OpenSpec change to a named Change Lead, while the Team Lead keeps priorities,
cross-change contracts, final integration, and landing. This document is the
common protocol every repository role links to.

**This is an operating protocol, not a new enforcement layer.** Kawai's
existing service authorization (creator rights, group rights, worktree
staffing, result binding) remains the mechanical boundary. The protocol
instructs agents within those rights; it adds no tool, server, API, schema, or
CI behavior. Installing these artifacts enrolls no work and starts no agent.

## 1. Scope, eligibility, and enrollment

One change participates at a time. The pilot is installed once; each
enrollment is a separate, explicitly recorded decision.

A change is eligible when all of these hold:

- It contains at least two coherent implementation groups and meaningful local
  coordination. Trivial fixes, inseparable same-file work, and single-writer
  changes are excluded — they would only acquire another handoff.
- It is not owned by a running plan execution. Execution-owned changes keep
  Kawai's own task creation, dispatch, review, and landing; the pilot never
  dispatches into them.
- Its tasks are not linked to an approved plan, or the parent direction states
  the plan exception explicitly: decision cards (`decision_ask`) on
  plan-linked tasks route to the plan's Lead role, never to the Change Lead,
  and plan-supervision stall handling stays with that role.
- Its scope and contracts are stable enough that local interpretation, not
  renegotiation, is the expected work.

Enrollment is a human decision. The Team Lead proposes a named candidate
change and a named coordinator session; the human approves both and the
coordinator session exists before anything is recorded as enrolled. A session's
group is fixed at creation, so an existing developer or senior session is
never silently promoted; the human creates the coordinator session in the
`change-leads` group, in a stable repository checkout outside developer
worktrees. Group mail to `change-leads` never spawns a member
(`worktreeScoped: false`): there is no automatic coordinator.

Before the first dispatch, the Team Lead records the enrollment in the parent
task (Section 3), including the activation checklist:

- the enrolled change id and the parent task id;
- the named coordinator session and its profile;
- the quota pool that profile shares — a Claude coordinator shares the Team
  Lead's five-hour and seven-day windows; a GLM or MiMo coordinator shares the
  developers' and reviewers' pools — so shared-window effects are known before
  they are blamed on the hierarchy;
- the baseline task/change ids or the baseline-selection criteria, and the
  model/resource conditions held constant (Section 9);
- the evaluation window: 14 calendar days from the first assignment by
  default, ending earlier on landing or withdrawal. This is an operational
  review point, not a statistical claim;
- known evidence gaps (for example, cost records that will not cover every
  participant).

Further enrollment or any expansion beyond one change requires a new human
decision.

## 2. Authority matrix

Who may do what under the pilot. Existing service rights are unchanged; this
matrix is how the protocol uses them. "—" means the role takes no part.

| Operation | Human | Team Lead | Change Lead | Developer | Reviewer |
|---|---|---|---|---|---|
| Enroll one change | Decides; names the candidate change and coordinator session | Records the enrollment in the parent before any dispatch | Never self-enrolls; is named by the Team Lead and confirmed by the human | — | — |
| Create the parent task | Yes | Yes (its creation, its creator rights) | No | No | No |
| Amend or close the parent | Yes | Yes | No | No | No |
| Create child tasks | Yes | No — it owns the parent, not the children | Yes, with `parent_id`, the change link, and a real worktree; it is the children's creator | No | No |
| Amend child tasks | Yes | No — requests the amendment from the child's creator, or asks the human | Yes, its own children, via `task_amend`; dependent work waits for acknowledgment | Points to a journal note or message | No |
| Close child tasks | Yes | No — child closure belongs to the child's creator | Yes, its own children, when the child's own acceptance holds; the closure note states that closure is not result acceptance | No | No |
| Dispatch local assignments | — | Cross-change dispatch only; never dispatches inside an enrolled change's children | Discovers a developer, creates the worktree first, sends the task mail | Receives one writer/one worktree | Receives |
| Formal review / fix handoff | — | Never dispatches a formal review inside an enrolled change (Section 5); after assembled-ready, hands code changes back as an assembly-correction child, including its own conflict resolutions | Exactly one dispatch per submitted result (Section 5); coordinates the fix round when findings block | Submits results; performs fixes; a fix produces a new result on its own commit | Produces findings bound to the exact result and handoff |
| Result acceptance | **Accept result** — the only recording path outside an execution; no agent tool records acceptance | None — closing its parent after assembled evidence and checks hold is a closure, not a result acceptance | None — closing a child is a closure, not a result acceptance, and says so | None | None |
| Push | — | Pushes the assembled branch (pre-push requires a recorded full pass), opens the PR, watches CI, merges | Never; child branches are never pushed | Never | No (read-only) |
| Withdrawal | Decides | Stops new pilot dispatch, records the handover to the default Lead path through authorized amendments, reconciles outstanding work | Coordinates the safe checkpoint; the role is retained while unresolved pilot work depends on it | Follows the safe-checkpoint instruction; no automatic restart | Completes the pending review before reporting changes |
| Replacement / recovery | Names the replacement; performs creator-bound amendments and closures when the original creator is gone | Reconciles outstanding assignments, mail, branches, results, and next actions | A replacement coordinates within existing rights; it cannot amend or close the original coordinator's children | Acknowledges new direction before following it | Acknowledges |

Two separations this matrix depends on:

- **Closure is not acceptance.** No agent tool records result acceptance; only
  the human's **Accept result** does (Kawai records acceptance only under a
  plan execution, whose changes are excluded here). The Change Lead's closure
  of a child and the Team Lead's closure of the parent are status records, and
  both state what evidence they rest on.
- **The Change Lead is not a plan Lead.** Plan-supervision's plan Lead role
  (`leadGroup`) and the Plans view's Lead binding are plan-scoped Team Lead
  roles; a Change Lead holds neither, receives no `plan-stall` alerts as its
  own, and answers no decision cards for plan-linked tasks (Section 1).

## 3. Parent task and child tasks

Delegation is expressed through real creator rights: the Team Lead creates the
parent, the Change Lead creates the children. A parent link grants no
authority over a child — amending and closing a child belong to its creator
(or the human).

**Parent** (created by the Team Lead, linked to the OpenSpec change). Its
published direction records, and its revisions keep current:

- pilot state (enrolled, paused, withdrawn), the change id, and the named
  coordinator session;
- approved scope and revision, and the contract boundaries with their owners —
  what the Change Lead may interpret locally, and what is reserved to the
  Team Lead (cross-change contracts, shared schema or protocol commitments)
  or the human;
- the approved dependency and integration order;
- the activation checklist facts of Section 1 (baseline, window, quota pool,
  evidence gaps);
- current subtasks, participants, next action, and escalation/recovery
  contacts.

**Children** (created by the Change Lead). Each implementation child carries
`parent_id`, the linked change, a real worktree, the requirement or task
groups it covers, its dependencies, and acceptance criteria naming the checks
that decide. Its direction contains a small coordination block:

```
Pilot parent: <parent task id>
Change: <openspec change id>
Coordinator: <coordinator session id>
Reporting: routine reports → direct mail to the coordinator, no task_id
           (docs/change-lead-pilot.md §4); escalations → lead group
```

Material direction changes go through `task_amend` and recipients acknowledge
the new revision before dependent work continues. Only a class-3 contract
question (`docs/agent-collaboration.md`, "Classify implementation questions
before escalating") is material: an answered question needs a citation, a
local one the writer's journal note, and neither an amendment nor an
acknowledgement gate. Decisions live in revisions
and journals, not in conflicting mailbox instructions. The Change Lead may
settle an artifact clarification inside the approved scope itself; scope or
cross-change contract amendments return to the Team Lead (reconciliation) and,
where a gate applies, to the human.

## 4. Dispatching local assignments and reporting

The Change Lead discovers a suitable developer at dispatch time (developers
remain the shared senior/middle/junior groups — no dedicated pools, no raised
caps), creates the child's worktree before dispatch, and sends the assignment
as task mail through the existing tools. Each implementation assignment names
one writer and one worktree; a candidate already committed elsewhere is
reconciled with the responsible coordinator or recorded as a named wait, never
assumed exclusive.

Before retrying a dispatch, the Change Lead inspects the standing assignment:
a duplicate naming another recipient is not a reassignment, and an existing
handoff is never duplicated to route around a busy reviewer.

Every participant carries the same narrow reporting exception, worded
identically in the three developer roles and `reviewers.md`:

> **Pilot reporting exception.** If your task's direction names a Change Lead
> coordinator for the change-lead pilot, send that session your routine
> status, result, and findings reports as direct session mail without
> `task_id`, naming the child task, its revision, the result or findings ids,
> your next action, and anything you wait on; bind the child task only to
> technical exchanges about it. If the named coordinator stops answering, or
> your report to it is refused (context exhausted) or dead-lettered, send one
> escalation to the `lead` group, journal a named wait, and do not start
> duplicate work or request a second review; if an assignment names a
> different coordinator than the task's current direction, ask for
> reconciliation instead of reading the message as reassignment. Every task
> without that delegation keeps the ordinary rule: report to `lead`. Under
> the pilot, only the unavailable-coordinator escalation goes to `lead`.
> Contract questions (class 3, `docs/agent-collaboration.md`) go to the
> Change Lead, which escalates them; local ones stay with the writer.

The Team Lead receives milestones, unresolved boundary questions, named
blockers requiring its action, and the final assembled evidence. It does not
approve each local decision and does not duplicate child dispatch. Developers
and reviewers clarify technical mechanisms directly with each other and the
Change Lead, journaling outcomes.

## 5. Formal review — exactly one dispatch per result

Independent review survives delegation unchanged. The Change Lead coordinates
review; it never substitutes its own sign-off for findings, and a
coordinator's agreement is not review evidence. Each submitted result gets
**exactly one** formal dispatch, through today's per-task reviewer path:

1. **Review worktree.** A disposable checkout detached at the exact head under
   review (never a developer's worktree, never the coordinator's).
2. **Review child.** The Change Lead creates a review child task for it, with
   acceptance = findings bound to the exact result id and commit.
3. **Group dispatch to a cross-model reviewers group.** Group mail goes to
   `reviewers-opus` for GPT-written work, `reviewers-sol` otherwise, so
   review is always cross-model; the lead role's routing rules apply. A
   session-targeted `task_handoff` (`target_kind: session`) is used only when
   an eligible reviewer session already exists.
4. **One dispatch, no duplicates.** Before any retry the Change Lead checks
   the standing handoff; the tool returns the standing equivalent instead of
   dispatching again. Reviewer absence is a named wait with the next
   availability check — never an approval of the coordinated work.

The Team Lead dispatches no formal review inside an enrolled change. When a
developer fixes blocking findings, the new result is reviewed on its own
commit — it inherits no approval from the earlier result.

**Assembly corrections.** Any code change after the change is assembled-ready
— a defect found at integration, a contract check failure, or a cross-change
conflict resolution the Team Lead itself decides — goes back through the
Change Lead as an **assembly-correction child**, with its own writer, result,
and review for the resulting head. The Team Lead never edits assembled code
into shape directly.

## 6. Assembly, completion evidence, and acceptance

The Change Lead coordinates; it writes no production code. When multiple
branches need integration, one developer/worktree is allocated for assembly
under an explicit child assignment. The Team Lead determines base and order
and owns cross-change conflicts; the Change Lead coordinates local assembly
and corrections.

Assembly records, in the assembly child or the parent journal: the assembled
commit, requirement coverage, each child's result and findings ids, the
relevant contract and workflow checks, and unresolved risks.

Closure rules:

- A child is closed by its creator (the Change Lead) only when that child's
  own acceptance holds. Stage completion never proves assembled acceptance,
  and the closure note states that closure is not result acceptance.
- The Team Lead closes the parent only after the assembled evidence and
  checks hold, and makes the final landing decision. Subtask completion does
  not imply parent completion: if all component reviews pass but the assembled
  change violates a contract, the change stays incomplete and correction work
  gets new evidence and review before landing (an assembly-correction child,
  Section 5).
- Result acceptance is the human's **Accept result**, on specific results —
  never implied by any closure (Section 2).

## 7. Recovery: unavailable coordinator and replacement

Continuity rule: **prefer compacting the same session over replacing it.**
Auto-compaction or the owner's `/compact` keeps every creator right in the
session that holds them; a replacement inherits none of the original
coordinator's children. Treat a flagged, exhausted coordinator as recoverable
first — a report refused because the coordinator is flagged context-exhausted,
or a dead-lettered report, is the escalation trigger below, not a replacement
order.

If the coordinator is genuinely unavailable, exactly one escalation goes to
the `lead` group with a journal note naming the wait; nobody dispatches a
second implementation or review while recovery is recorded. The Team Lead
reconciles outstanding assignments, queued and delivered mail, branches,
results, creator sessions, and next actions.

A replacement may coordinate within its own existing rights: it can create new
children, dispatch, and journal. It **cannot amend or close the original
coordinator's children** — ownership is not transferred by hierarchy or by
the replacement record. The handover path:

- If the original creator is available, it publishes the handover itself
  (amendments, closures, acknowledgments requested).
- Otherwise the human amends direction and performs creator-bound closure.
- Recipients acknowledge the updated direction before following the new
  coordinator, and in-flight handoffs are reconciled before new dispatch.
- Existing subtasks are never recreated merely to obtain creator rights;
  branch, result, findings, and mail references survive as they are.

## 8. Withdrawal

Withdrawal happens at a safe checkpoint, on the human's decision, and
preserves all work:

1. **Stop new pilot dispatch.** The Team Lead records the withdrawal in the
   parent and no further pilot assignments are sent.
2. **Reconcile creators and standing handoffs.** Every outstanding
   implementation assignment and the outstanding review handoff are accounted
   for; a pending review stays singular — its result and next coordinator are
   recorded before reporting changes.
3. **Restore default reporting through authorized direction updates.** The
   reporting exception is removed by amending the affected tasks' direction
   (the creator, or the human where the creator is gone); participants
   acknowledge and fall back to reporting to `lead`.
4. **Let safe in-flight work settle.** The `change-leads` role is retained
   until its dependent work is resolved; the role file and protocol are
   removed or reverted only after reconciliation.
5. **Preserve evidence.** Journals, results, findings, and mail history stay
   in place for the evaluation report (Section 9).

Withdrawal never kills a session, deletes work, duplicates a pending handoff,
or closes the parent prematurely. Running participants whose role text is
older than the files receive an explicit safe-checkpoint instruction —
adoption is by that instruction or the agent's next ordinary start, never an
automatic restart. Human-created coordinator sessions are archived by the
human.

## 9. Evaluation protocol and templates

The Team Lead owns the evaluation report; the Change Lead supplies evidence
but gains no process-report rights. Evidence comes from parent/child journals,
results, findings, assignments, mail history, and process reports — no new
instrumentation. Missing measurements stay unknown; the report never infers a
missing value or attributes provider quota percentages as costs.

**Baseline selection.** Record the matching baseline task/change ids in the
parent *before* outcomes are known. Match, or list as mismatches: scope and
risk, dependency coupling, model mix, review policy, checks, and resource
conditions. Prefer recent work under the implemented parallel-suite /
per-result-suite baseline. If no comparable baseline exists, publish a
descriptive pilot report — not a causal comparison.

**Template** (one per pilot):

```
Pilot: <change id> · parent <task id> · coordinator <session/profile>
Window: <start> → <end> (14d default or landing/withdrawal)
Baseline: <task/change ids> · matched: <conditions> · mismatches: <list>
Timestamps: enrollment · first dispatch · each result · findings ·
  correction rounds · assembled-ready · landing or withdrawal
Waits (named, non-overlapping): quota · suite · reviewer · human ·
  coordinator · unclassified residual
Defects: by class and discovery phase · repeated correction rounds ·
  integration defects · missed acceptance criteria
Costs: token/cost records per participant (implementation, review,
  coordination, assembly) · coverage gaps marked · quota meters excluded
Failures: failed or abandoned work included, with its elapsed time
Limitations: <what this report cannot claim>
Conclusion: continue | revise | withdraw, with the evidence behind it
```

Waits are reported without double-counting overlapping intervals: when two
waits share time, the report counts the interval once under the dominant
cause and says so, and reports the residual as unclassified.

**Sample — complete evidence.** Baseline matched on all five conditions; all
timestamps present; token records cover the developer, reviewer, and
coordinator. Conclusion: "elapsed 9d vs baseline 11d; one correction round vs
three; coordination overhead ≈ 4% of tokens; recommend continue."

**Sample — partial evidence.** Token records cover only the developer (the
reviewer ran on a shared login), and no comparable baseline exists. Conclusion
is explicit: "elapsed 9d, one correction round — observed but not comparable;
total cost unknown (coverage gap: reviewer, coordinator); quota meters are not
costs; recommend revise: continue only with a matched baseline." A report
whose correctness or authority evidence shows an unaddressed regression, or
whose overhead exceeds any observed benefit, recommends withdraw. Missing
baseline or cost evidence makes benefit conclusions inconclusive — stated as
inconclusive, never resolved by assumption. No percentage promises; expansion
requires a human decision.

## 10. Worked example: one change, two subtasks

Example change `add-export-csv` (illustrative): add CSV export of a chat's
transcript. Two implementation groups, an assembly step, and a contract
boundary. The Change Lead maps every implementation requirement to a writer,
dependency, and acceptance check:

| # | Requirement | Coordinator decision | Writer · worktree | Depends on | Acceptance check |
|---|---|---|---|---|---|
| R1 | CSV serializer: quote/escape rules, stable column order | local: pure module in `src/server/export/`, table tests incl. embedded commas/quotes/newlines | dev A · `wt-export-server` / `feat/export-server` | — | unit suite file for the serializer; no snapshot of raw output |
| R2 | `session-export` protocol message (contract boundary) | reserved: message name and shape touch the client/server contract → confirmed with the Team Lead before R3 dispatch | dev A · same worktree | R1 | handler test: request → rows; shape pinned in the delta spec |
| R3 | Composer menu action renders and downloads the file | local: client-only; reuse the store's history, no new fetch | dev B · `wt-export-client` / `feat/export-client` | R2 (message shape, not code) | client test for the menu action; typecheck |
| R4 | Assembled head: R1+R2+R3 together, contract checks | assembly child on a fresh worktree; writer C assembles, does not design | dev C · `wt-export-assemble` | R1–R3 | `bun run check` on the assembled head; the change's spec scenarios walked |

Walkthrough of one full pass:

1. **Enrollment.** The Team Lead proposes `add-export-csv` — two coherent
   implementation groups, stable contracts, and not owned by a running plan
   execution; the human names the change and the coordinator session; the
   parent records baseline, 14-day window, and the quota pool.
2. **Children.** The Change Lead creates R1/R2 (one child, dev A) and R3
   (another child, dev B) with the coordination block, separate worktrees,
   R3 depending on R2's message shape only.
3. **Local clarification.** Dev B asks which menu the action belongs in; the
   Change Lead decides within scope and journals it — no Team Lead approval
   sought. Midway, R2's proposed field name collides with another change's
   published contract: the Change Lead records the impact and escalates to the
   Team Lead; dependent R3 work waits (independent R1 work continues).
4. **Result and review.** Dev A submits a result; the Change Lead reports it
   onward as a milestone and dispatches exactly one formal review for that
   result (Section 5). Findings block; dev A fixes and submits a new result on
   its own commit; that result gets its own review, inheriting nothing.
5. **Assembly.** R1–R3 reviews pass; the assembly child (R4) assembles the
   branches. `bun run check` fails on the assembled head — a genuine
   integration defect. It goes back through the Change Lead as an
   assembly-correction child with its own writer, result, and review.
6. **Evidence and landing.** The Change Lead presents the assembled head,
   child results/findings, coverage, contract evidence, and remaining risks to
   the Team Lead. The Team Lead pushes the assembled branch (pre-push full
   pass), opens the PR, watches CI, and merges. The human accepts results;
   the Change Lead closes its children (closure notes say closure is not
   acceptance); the Team Lead closes the parent last.

If the coordinator's session is compacted mid-pass, work continues with the
same session. If it is lost, one escalation to `lead` freezes dispatch; a
replacement coordinates new children but cannot amend or close R1–R4 — the
human does the creator-bound closures.

## 11. Verification map

What the repository verifies mechanically, and what is walked through only.
A documented tabletop walkthrough (this document's Section 10, and the
scenarios of the `change-coordination` delta) covers interpretation,
reporting, escalation, assembled-head review, and withdrawal; it demonstrates
the protocol, and does not claim that agents will obey prompts.

Delta-scenario coverage (4.1): the Section 10 walkthrough plus the sections it
references cover every `change-coordination` delta scenario — enrollment (§1),
the ordinary-task fallback and reporting routes (§4), execution-owned
exclusion (§1), child creation and parent/child asymmetry (§2, §3; tested),
local clarification versus contract escalation (§10 step 3), shared caps and
one writer per worktree (§4, §10 step 2), result reporting and the
conflicting-coordinator case (§4, §10 step 4), one review per result, fix
results, and reviewer absence (§5), assembled evidence and closure versus
acceptance (§2, §6, §10 steps 5–6), coordinator loss and replacement (§7, §10
final paragraph), evaluation (§9), and withdrawal with a pending review (§8).

Mechanically tested (cited `file › title`):

- Role rights (2.1): `src/server/__tests__/teamGroupCatalog.test.ts` ›
  `the tracked change-leads file grants task creation and cross-worktree
  coordination, and denies plan, mailbox-management, and process-report
  rights`.
- Pilot composition (3.1, 3.2): `src/server/__tests__/teamTaskService.test.ts`
  › `parent/child creator asymmetry under the pilot: the parent creator
  cannot amend or close the Change Lead's child; the human can; the child
  records parent, change, and creator` and › `a replacement Change Lead
  cannot amend or close the original coordinator's children, but can
  coordinate within existing rights`.
- Reused existing coverage, not duplicated: `taskHandoffs.test.ts` › `a
  session-targeted review dispatches ordinary direct task mail to that
  session: identity, actor, result reference, and atomic supersession` (child
  result with a session-target review handoff); › `a session retry returns
  the standing handoff; a different session or a group request names both
  recipients and reassigns nothing` (duplicate handoff returns the standing
  one); › `a standing handoff survives recipient lifecycle changes: a killed,
  archived, or unknown retry returns it before validation, restoring nothing`
  (coordinator loss — references survive); `teamTaskService.test.ts` › `the
  human reopens, closes, and amends a task whose creator was killed`
  (authorized closure when the original creator is gone).

Affected-test selection (3.4), as `scripts/affected-tests.ts` selects it with
`.kawai/groups/change-leads.md` and `docs/change-lead-pilot.md` staged: kind
`docs-only`, declaration pass (@reads matches) = `scripts/__tests__/
affectedTests.test.ts`, `scripts/__tests__/preCommit.test.ts`,
`scripts/__tests__/reads.test.ts`, `src/server/__tests__/docsOnlyChanges.test.ts`,
`src/server/__tests__/shippedCatalog.test.ts`,
`src/server/__tests__/teamGroupCatalog.test.ts`; changed-pass candidates 0;
one slow-tier file excluded. With the two fixture files staged as well the
kind is `source`: the same declaration pass, and `teamTaskService.test.ts` in
the changed pass (Bun's `--changed` import following also carries
`teamGroupCatalog.test.ts`, which is itself changed). No new `@reads`
declarations were needed: the catalog fixture already declares
`.kawai/groups/**`, and the task-service fixtures write their group files
into a temporary repository instead of reading this one.

## 12. Pilot readiness note

Installing this protocol is not activation: the artifacts add role and
protocol files only — no server, API, schema, or CI behavior — so
installation alone sends no mail and starts or enrolls no sessions.

**References.** `.kawai/groups/change-leads.md` (coordinator role, D2); this
protocol; `lead.md`'s "Change Lead pilot" section (Team Lead duties); the
reporting exception in the three developer roles, `reviewers.md`, and the
user-level reviewer roles (I1); `docs/agent-collaboration.md` (composition,
one dispatcher per result). Mechanical evidence: Section 11.

**Candidate-selection checklist.** At least two coherent implementation
groups and meaningful local coordination; stable scope and contracts; not
execution-owned; not plan-linked, or the parent states the plan-Lead
exception; a baseline per the method below, else a descriptive report.

**Baseline-selection method** (Section 9): record matching task/change ids in
the parent before outcomes are known; match scope and risk, dependency
coupling, model mix, review policy, checks, and resource conditions, listing
mismatches; prefer recent work under the implemented parallel-suite /
per-result-suite baseline; without one, publish a descriptive pilot.

**Human session and enrollment action.** Create the coordinator session by
hand in the `change-leads` group, in a stable checkout outside developer
worktrees (a session's group is fixed at creation); approve the candidate
change; the Team Lead records enrollment, baseline, window, and quota pool
in the parent before the first dispatch.

**Owner actions before activation.** Add the Section 4 exception paragraph,
verbatim, to the user-level `~/.kawai/groups/reviewers-sol.md` and
`~/.kawai/groups/reviewers-opus.md`, so per-task reviewers report pilot
findings to the named coordinator like repository roles do (I1). Role and
doc changes reach agents only from the main checkout at each agent's next
start; once this change lands, move any untracked owner copy of
`openspec/changes/change-lead-pilot/` in the main checkout aside before
pulling, so the landed artifacts are authoritative (M4).

**Report cutoff.** The window ends 14 calendar days from the first
assignment, or earlier on landing or withdrawal; post-landing defects count
only through the cutoff recorded in the parent at enrollment (Section 9).

**Rollback checklist** (Section 8): stop new pilot dispatch; reconcile
creators and standing handoffs — the pending review stays singular; restore
default reporting by amending the affected tasks' direction (creator, or the
human where gone) and require acknowledgments; let in-flight work settle,
retaining the role until its dependent work resolves; preserve journals,
results, findings, and mail; archive human-created coordinator sessions by
hand. Never kill a session, delete work, duplicate a pending handoff, or
remove the role while unresolved pilot work depends on it.
