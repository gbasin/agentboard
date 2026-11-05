// Task tools on the per-session `kawai-team` MCP server (team-tasks design
// D2). Handlers bind the calling session id and strip unknown arguments, so
// a forged creator or team in the input is never seen by the service.
// `task_get` and `task_journal_read` read through one TaskJournalReads
// (bounded-log-reads-and-task-get D4–D6): bounded windows and byte-bounded
// previews, and any entry whole, behind task_get's caller and team rules.
import { z } from 'zod'
import { TASK_STATUSES, type TaskListStatus, type TaskStatus } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'
import type { TaskResultService } from './TaskResultService'
import { JOURNAL_LIMIT_MAX, TaskJournalReads } from './taskJournalWindow'
import { TASK_LIST_LIMIT_MAX, TASK_LIST_STATUSES } from './taskListWindow'

export const TASK_TOOL_NAMES = ['task_create', 'task_get', 'task_journal_read', 'task_note', 'task_update_status', 'task_amend', 'task_list', 'task_acknowledge',
  'task_submit_result', 'task_submit_coverage', 'task_submit_findings', 'task_handoff', 'task_check_result'] as const

const status = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]])
const taskId = { task_id: z.string().min(1) }
// One message for every failure, so both runtimes' refusals name the range (D5).
const journalLimit = `journal_limit must be an integer from 1 to ${JOURNAL_LIMIT_MAX}`
// The same for task_list (bounded-task-list D2/D3): one message per argument.
const listStatus = `status must be one of ${TASK_LIST_STATUSES.join(', ')}`
const listLimit = `limit must be an integer from 1 to ${TASK_LIST_LIMIT_MAX}`
const offsetBytes = 'offset_bytes must be a safe non-negative integer'
export const taskSchemas = {
  task_create: z.object({
    title: z.string().min(1), direction: z.string().min(1), acceptance: z.string().optional(),
    parent_id: z.string().optional(), worktree: z.string().optional(), openspec_change: z.string().optional(),
    plan_id: z.string().optional(), plan_change: z.string().optional(),
  }),
  task_get: z.object({
    ...taskId, journal_before: z.string().min(1).optional(),
    journal_limit: z.number({ error: journalLimit }).int({ error: journalLimit }).min(1, { error: journalLimit })
      .max(JOURNAL_LIMIT_MAX, { error: journalLimit }).optional(),
  }),
  task_journal_read: z.object({
    ...taskId, entry_id: z.string().min(1),
    offset_bytes: z.number({ error: offsetBytes }).int({ error: offsetBytes }).min(0, { error: offsetBytes })
      .max(Number.MAX_SAFE_INTEGER, { error: offsetBytes }).optional(),
  }),
  task_note: z.object({ ...taskId, text: z.string().min(1) }),
  task_update_status: z.object({ ...taskId, status, note: z.string().optional() }),
  task_amend: z.object({
    ...taskId, direction: z.string().optional(), acceptance: z.string().optional(),
    rationale: z.string().optional(), notify: z.boolean().optional(),
  }),
  task_list: z.object({
    status: z.enum(TASK_LIST_STATUSES as [TaskListStatus, ...TaskListStatus[]], { error: listStatus }).optional(),
    limit: z.number({ error: listLimit }).int({ error: listLimit }).min(1, { error: listLimit })
      .max(TASK_LIST_LIMIT_MAX, { error: listLimit }).optional(),
    before: z.string().min(1).optional(),
  }),
  task_acknowledge: z.object({ ...taskId, revision: z.number().int().min(1) }),
  task_submit_result: z.object({
    ...taskId, summary: z.string().min(1), commit: z.string().optional(), diff: z.string().optional(),
    tests: z.array(z.object({ description: z.string().min(1), outcome: z.string().min(1) })).optional(),
    limitations: z.string().optional(),
    // The coverage map's shape is D5's, checked by validateCoverageMap at the
    // service boundary — a clause-indexed refusal the zod layer cannot name.
    coverage: z.unknown().optional(),
  }),
  task_submit_coverage: z.object({
    ...taskId, result_id: z.string().min(1), coverage: z.unknown(),
  }),
  task_submit_findings: z.object({
    ...taskId, result_id: z.string().min(1), kind: z.enum(['review', 'qa']), verdict: z.enum(['pass', 'fail']), findings: z.string().min(1),
  }),
  task_handoff: z.object({
    ...taskId, kind: z.enum(['review', 'qa', 'fix']), result_id: z.string().min(1), target: z.string().min(1),
    // Explicit recipient kind (session-targeted-task-handoffs D1): omitted
    // means group, even when the id resembles a session id — never inferred.
    target_kind: z.enum(['group', 'session']).optional(),
    instructions: z.string().min(1), expected_response: z.string().optional(),
    // The worker choice (dispatch-worker-choice D7): group targets only.
    worker: z.string().min(1).optional(),
  }),
  task_check_result: z.object({ ...taskId, result_id: z.string().min(1) }),
}

export const taskDescriptions: Record<(typeof TASK_TOOL_NAMES)[number], string> = {
  task_create: 'Create a team task (only if your group may create tasks). Optional parent_id, worktree (a worktree root of this repository), and openspec_change; plan_id with plan_change links the task to a change of an open plan\'s approved revision (both or neither; fixed afterwards). You become its creator.',
  task_get: 'Read a task: current direction and acceptance, every revision, assignment, and result whole; the journal, subtasks, and messages as bounded windows, oldest first, each with its total — the newest 50 journal entries (journal_limit 1–200), 100 subtasks, and 50 messages. A journal entry is a preview of at most 2,000 stored bytes with totalBytes, cut, and resumeOffsetBytes (text null when not valid UTF-8). Page older entries with journal_before set to bounds.journal.nextBefore; read any entry whole with task_journal_read.',
  task_journal_read: 'Read one journal entry of a task losslessly (entry_id from task_get): up to 8,192 stored bytes from offset_bytes (default 0; a preview\'s resumeOffsetBytes continues it) as dataBase64, which is authoritative, with their text when valid UTF-8 (else null), the entry\'s totalBytes, and nextOffsetBytes (null at the end). Read-only.',
  task_note: "Append a note to a task's journal (decisions, findings, progress). Notes are permanent.",
  task_update_status: 'Set a task to active or blocked (any member); done or cancelled (its creator only). Optional note is journaled.',
  task_amend: "Publish a new revision of a task's direction or acceptance criteria (its creator only). Optional rationale says why; notify: true also sends the assignment's claimed agent a revision notice.",
  task_list: `List this team's tasks as compact rows (no direction or acceptance — use task_get), newest first. Without status, only open, active, and blocked tasks; status takes one status or "all". At most limit rows (1–${TASK_LIST_LIMIT_MAX}, default 50); page older with before set to bounds.nextBefore. bounds.total counts every match; statuses names the filter applied.`,
  task_acknowledge: 'State the published task revision you are now working from (the revision in the task header). Call it when you start or take over work on a task, and after a revision notice.',
  task_submit_result: 'Submit a result for a task: a summary, a commit and/or diff reference (at least one), the tests you ran with their outcomes, and known limitations. Your test outcomes are shown as claimed, not verified. Supersedes the task\'s previous result; does not close the task.',
  task_submit_coverage: 'Record your own coverage map for a result (result_id from task_get): the same clause/citation map a submission carries. While you hold a task\'s outstanding review handoff and have recorded no map for its result, the submitter\'s maps stay withheld from you — recording yours unseals them. Maps are append-only; your newest map for a result counts.',
  task_submit_findings: 'Report review or QA findings on one exact result (result_id from task_get): kind review|qa, verdict pass|fail, and the findings. They stay bound to that result — a newer result inherits nothing.',
  task_handoff: 'Hand a result off (kind review, qa, or fix — return for fixes; the result_id, instructions, and an optional expected_response) to a recipient: target_kind "group" (the default when omitted, even for a session-shaped id) with target: <group id>, or target_kind "session" with target: <session id> to dispatch ordinary direct task mail to that exact session — no other member is chosen. While an equivalent handoff (same task, result, kind) is outstanding, this returns it instead of dispatching again; if the standing handoff names another recipient, the notice says so and nothing is reassigned. Optional worker (group targets only) limits who may take it to one provider (e.g. claude) or one model (provider/model, or a bare model key) of the group\'s workers, as on send_message; a handoff naming another worker is another handoff.',
  task_check_result: 'Ask Kawai to check a result again (result_id from task_get): the commit, its worktree state, the recorded full-check pass, and merges against the base and other open tasks\' branches. The check never gates anything; it runs in the background and the newest check rides task_get. A request while a check is pending returns that pending check.',
}

export function taskHandlers(tasks: TaskService, sessionId: string, results?: TaskResultService) {
  const caller = { kind: 'agent' as const, sessionId }
  const reads = new TaskJournalReads(tasks)
  return {
    task_create: async (input: unknown) => tasks.create(caller, taskSchemas.task_create.parse(input)),
    task_get: async (input: unknown) => {
      const { task_id, journal_before, journal_limit } = taskSchemas.task_get.parse(input)
      const detail = await reads.agentGet(caller, task_id, { journalBefore: journal_before, journalLimit: journal_limit })
      // The blind-first seal (independent-verification D6): project the
      // results for the reading session when the server has a result
      // service; the human's path (humanDetail) never seals.
      return results ? results.applySeal(caller, task_id, detail) : detail
    },
    task_journal_read: async (input: unknown) => {
      const { task_id, entry_id, offset_bytes } = taskSchemas.task_journal_read.parse(input)
      return reads.journalRead(caller, task_id, entry_id, offset_bytes ?? 0)
    },
    task_note: async (input: unknown) => {
      const { task_id, text } = taskSchemas.task_note.parse(input)
      return tasks.note(caller, task_id, text)
    },
    task_update_status: async (input: unknown) => {
      const { task_id, status: next, note } = taskSchemas.task_update_status.parse(input)
      return tasks.setStatus(caller, task_id, next, note)
    },
    task_amend: async (input: unknown) => {
      const { task_id, direction, acceptance, rationale, notify } = taskSchemas.task_amend.parse(input)
      return tasks.amend(caller, task_id, { direction, acceptance, rationale, notify })
    },
    task_acknowledge: async (input: unknown) => {
      const { task_id, revision } = taskSchemas.task_acknowledge.parse(input)
      return tasks.acknowledge(caller, task_id, revision)
    },
    // Results (task-results-handoffs): registered only where the server has a result service.
    ...(results ? {
      task_submit_result: async (input: unknown) => {
        const { task_id, ...submission } = taskSchemas.task_submit_result.parse(input)
        return results.submit(caller, task_id, submission)
      },
      task_submit_coverage: async (input: unknown) => {
        const { task_id, result_id, coverage } = taskSchemas.task_submit_coverage.parse(input)
        return results.submitCoverage(caller, task_id, { resultId: result_id, coverage })
      },
      task_submit_findings: async (input: unknown) => {
        const { task_id, result_id, kind, verdict, findings } = taskSchemas.task_submit_findings.parse(input)
        return results.submitFindings(caller, task_id, { resultId: result_id, kind, verdict, findings })
      },
      task_handoff: async (input: unknown) => {
        const { task_id, kind, result_id, target_kind, target, instructions, expected_response, worker } = taskSchemas.task_handoff.parse(input)
        const id = target.trim()
        if (!id) throw new Error('A handoff target needs an identifier')
        return results.handoff(caller, task_id, {
          kind, resultId: result_id, target: { kind: target_kind ?? 'group', id }, instructions, expectedResponse: expected_response ?? null,
          ...(worker !== undefined ? { worker } : {}),
        })
      },
      task_check_result: async (input: unknown) => {
        const { task_id, result_id } = taskSchemas.task_check_result.parse(input)
        return results.recheck(caller, task_id, result_id)
      },
    } : {}),
    task_list: async (input: unknown) => tasks.agentList(caller, taskSchemas.task_list.parse(input)),
  }
}
