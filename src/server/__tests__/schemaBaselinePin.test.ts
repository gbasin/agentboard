// Pins the baseline (execution-safety-recovery D13) to master's schema: a
// fresh database must have exactly the tables, columns (name, type, notnull,
// default, pk), and indexes that master bdc0131's own code produced, recorded
// in fixtures/masterSchemaShape.json. A baseline that dropped one of master's
// ALTERs or migrate steps fails here.
//
// Regenerate the fixture with the command in fixtures/generateMasterSchemaShape.ts
// (a temp extract of bdc0131, then one bun run); only a change to the pinned
// commit calls for it. The baseline is frozen, so the first test never
// changes. A later numbered migration changes the second test's expectation
// on purpose: that migration's change applies its delta to `expected` there
// (added tables, columns, indexes), and the fixture itself stays master's.
// Migration 2 (`strategy-impact`) adds the three strategy impact tables,
// migration 3 (`plan-validation`) the three validation tables;
// migration 4 (`task-status-events`) adds the task transition table;
// migration 5 (`agent-starts`) adds agent starts and memory manifests;
// migration 6 (`chat-turn-usage`) adds per-turn usage;
// migration 7 (`process-reports`) adds the process report tables;
// migration 8 (`plan-execution`) the seven execution tables and
// `team_messages.allowed_profiles`; migration 9 (`outbound-audit`) the three
// outbound audit tables below; migration 10 (`context-exhausted`) the two
// `chat_sessions` flag columns and the exhaustion episode table; migration
// 11 (`process-observations`) the observation tables; migration 12
// (`provider-limit-window`) adds the nullable `provider_id` and
// `limit_window` to `profile_limit_events`; migration 13
// (`integration-candidates`) the four integration tables and the
// one-running-promotion index; migration 14
// (`process-observation-indexes`) indexes `chat_turn_usage.ended_at` and
// `profile_limit_events.at`; migration 15 (`codex-chat-runtime`) the
// creation-fixed `runtime` and `codex_home` plus the `transcript_path` on
// `chat_sessions`; migration 16 (`plan-supervision`) the decision cards,
// decisions, fix tasks, and stall alerts; migration 17
// (`revision-control`) the hold, pause, checkpoint, and execution-revision
// tables; migration 18 (`worker-choice`) the nullable `worker_choice` on
// `team_messages` and `team_task_assignments`; migration 19
// (`plan-workspace`) the bindings, document references, turn-context
// snapshots, and command-ledger tables.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { schemaShape, type SchemaShape } from './fixtures/schemaShape'
import master from './fixtures/masterSchemaShape.json'
import migration11 from './fixtures/processObservationSchemaShape.json'

const expected = master as SchemaShape

const column = (name: string, notnull = 1, pk = 0) => ({ name, type: 'TEXT', notnull, dflt_value: null, pk })
const id = column('id', 0, 1)
const optional = (name: string) => column(name, 0)
const integer = (name: string) => ({ name, type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 })
const optionalInteger = (name: string) => ({ ...integer(name), notnull: 0 })
const counter = (name: string, value: string) => ({ ...integer(name), dflt_value: value })
const keyPart = (name: string, pk: number) => ({ ...column(name), pk })

/** Migration 2's delta: the impact proposal, decision, and request tables (strategy-revision-impact D1). */
const migration2: SchemaShape['tables'] = {
  strategy_impact_proposals: {
    columns: [id, ...['strategy_id', 'review_id', 'plan_id', 'disposition', 'rationale', 'author_session', 'created_at'].map(name => column(name))],
    indexes: [{ name: 'strategy_impact_proposals_plan', unique: 0, columns: ['review_id', 'plan_id', 'created_at'] }],
  },
  strategy_impact_decisions: {
    columns: [
      id, ...['strategy_id', 'review_id', 'plan_id', 'disposition', 'rationale'].map(name => column(name)),
      optional('proposal_id'), optional('supersedes_decision_id'),
      ...['plan_snapshot_json', 'actor_kind', 'command_id', 'payload_json', 'created_at'].map(name => column(name)),
    ],
    // The chain index's third column is the expression IFNULL(supersedes_decision_id, ''), which has no name.
    indexes: [{ name: 'strategy_impact_decisions_chain', unique: 1, columns: ['review_id', 'plan_id', null as unknown as string] }],
  },
  strategy_impact_requests: {
    columns: [id, ...['strategy_id', 'review_id', 'target_group', 'message_id', 'command_id', 'payload_json', 'created_at'].map(name => column(name))],
    indexes: [],
  },
}

/** Migration 4's delta: task status transitions (team-process-metrics D3). */
const migration4: SchemaShape['tables'] = {
  team_task_status_events: {
    columns: [
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      column('task_id'), column('team_id'), optional('from_status'), column('to_status'),
      column('actor_kind'), optional('actor_session'), column('at'),
    ],
    indexes: [
      { name: 'team_task_status_events_task', unique: 0, columns: ['task_id', 'id'] },
      { name: 'team_task_status_events_team', unique: 0, columns: ['team_id', 'at'] },
    ],
  },
}

/** Migration 5's delta: agent-start provenance (team-process-metrics D2). */
const migration5: SchemaShape['tables'] = {
  agent_starts: {
    columns: [
      id, column('session_id'), ...['team_id', 'group_id', 'profile_id', 'model', 'effort'].map(optional), column('cwd'),
      ...['group_file_hash', 'prompt_append_hash', 'memory_hash'].map(optional),
      { name: 'memory_files', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      optional('instructions_hash'), optional('unavailable'), column('started_at'),
    ],
    indexes: [
      { name: 'agent_starts_session', unique: 0, columns: ['session_id', 'started_at'] },
      { name: 'agent_starts_team', unique: 0, columns: ['team_id', 'started_at'] },
    ],
  },
  memory_manifests: { columns: [column('memory_hash', 0, 1), column('files')], indexes: [] },
}

/** Migration 6's delta: per-turn usage (team-process-metrics D1). */
const migration6: SchemaShape['tables'] = {
  chat_turn_usage: {
    columns: [
      column('session_id', 1, 1), column('turn_id', 1, 2),
      ...['team_id', 'group_id', 'profile_id', 'model', 'task_id', 'start_id'].map(optional),
      ...['ok', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'num_turns'].map(integer),
      column('ended_at'),
    ],
    indexes: [
      { name: 'chat_turn_usage_ended', unique: 0, columns: ['ended_at'] },
      { name: 'chat_turn_usage_task', unique: 0, columns: ['task_id'] },
      { name: 'chat_turn_usage_team', unique: 0, columns: ['team_id', 'ended_at'] },
    ],
  },
}

/** Migration 7's delta: process reports, proposals, decisions, link events, and commands (team-process-metrics D6). */
const migration7: SchemaShape['tables'] = {
  process_reports: {
    columns: [id, ...['team_id', 'author_session', 'window', 'period_start', 'period_end', 'summary', 'snapshot', 'created_at'].map(name => column(name))],
    indexes: [{ name: 'process_reports_team', unique: 0, columns: ['team_id', 'created_at'] }],
  },
  process_proposals: {
    columns: [
      id, column('report_id'), column('team_id'), integer('position'),
      ...['kind', 'target_kind', 'target', 'edit', 'rationale', 'expected'].map(name => column(name)), optional('revert_to_hash'),
    ],
    indexes: [
      { name: 'process_proposals_report', unique: 0, columns: ['report_id', 'position'] },
      { name: 'process_proposals_team', unique: 0, columns: ['team_id'] },
    ],
  },
  process_proposal_decisions: {
    columns: [column('proposal_id', 0, 1), column('team_id'), column('decision'), optional('reason'), optional('target_hash_at_decision'), column('decided_at')],
    indexes: [],
  },
  process_proposal_link_events: {
    columns: [
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }, column('proposal_id'), column('team_id'), column('action'),
      ...['change_start_id', 'change_hash', 'change_at'].map(optional), column('actor_kind'), optional('actor_session'), column('at'),
    ],
    indexes: [{ name: 'process_proposal_link_events_proposal', unique: 0, columns: ['proposal_id', 'id'] }],
  },
  process_commands: {
    columns: [column('team_id', 1, 1), column('command_id', 1, 2), column('kind'), column('payload'), column('outcome'), column('at')],
    indexes: [],
  },
}

test('a fresh baseline reproduces master bdc0131 schema exactly', () => {
  const db = new Database(':memory:')
  applyBaselineSchema(db)
  expect(schemaShape(db)).toEqual(expected)
  db.close()
})

/** Migration 3's delta: the report, assessment, and decision tables (plan-validation D1). */
const migration3: SchemaShape['tables'] = {
  plan_validation_reports: {
    columns: [
      id, column('plan_id'), integer('revision'), integer('seq'), column('input_hash'),
      ...['inputs_json', 'findings_json', 'relations_json', 'evidence_json', 'readiness_json'].map(name => column(name)),
      integer('ready'), column('requested_kind'), optional('requested_session'), column('created_at'),
    ],
    indexes: [],
  },
  plan_assessments: {
    columns: [id, column('plan_id'), integer('revision'), column('kind'), column('payload_json'), column('author_kind'), optional('author_session'), optional('command_id'), column('created_at')],
    indexes: [{ name: 'plan_assessments_revision', unique: 0, columns: ['plan_id', 'revision', 'created_at'] }],
  },
  plan_validation_decisions: {
    columns: [id, column('plan_id'), integer('revision'), column('kind'), column('target'), column('text'), optional('scope'), column('actor_kind'), column('command_id'), column('payload_json'), column('created_at')],
    indexes: [{ name: 'plan_validation_decisions_revision', unique: 0, columns: ['plan_id', 'revision', 'created_at'] }],
  },
}

/** Migration 8's delta: the execution tables and the routing column (plan-execution D3, D15). */
const migration8: SchemaShape['tables'] = {
  plan_executions: {
    columns: [
      id, ...['team_id', 'plan_id'].map(name => column(name)), integer('revision'),
      ...['content_hash', 'report_id', 'input_hash', 'landing_mode', 'base_branch', 'base_commit', 'floor_json'].map(name => column(name)),
      integer('max_parallel'), column('merge_method'), column('state'), optional('outcome'), optional('stop_reason'),
      column('started_at'), optional('finished_at'),
    ],
    indexes: [
      { name: 'plan_executions_one_running', unique: 1, columns: ['plan_id'] },
      { name: 'plan_executions_team', unique: 0, columns: ['team_id', 'state'] },
    ],
  },
  plan_execution_changes: {
    columns: [
      keyPart('execution_id', 1), keyPart('change', 2), column('team_id'), integer('position'), column('state'),
      ...['step', 'stop_reason', 'stop_detail_json', 'task_id', 'worktree', 'branch', 'baseline_commit'].map(optional),
      optionalInteger('pr_number'), optional('pr_url'), optionalInteger('pr_opened_by_kawai'),
      counter('fix_rounds', '0'), counter('owns', '1'), optional('passed_at'), counter('generation', '0'), column('updated_at'),
    ],
    indexes: [
      { name: 'plan_execution_changes_owner', unique: 1, columns: ['team_id', 'change'] },
      { name: 'plan_execution_changes_task', unique: 0, columns: ['task_id'] },
    ],
  },
  plan_landing_slots: {
    columns: [{ ...column('team_id', 0), pk: 1 }, ...['holder_kind', 'holder_id', 'since'].map(name => column(name))],
    indexes: [],
  },
  plan_execution_attempts: {
    columns: [
      id, column('execution_id'), column('change'), integer('number'), column('kind'), optional('assignment_id'),
      column('manifest_json'), column('manifest_hash'), column('created_at'),
    ],
    indexes: [],
  },
  plan_execution_rounds: {
    columns: [
      id, ...['execution_id', 'change', 'attempt_id'].map(name => column(name)), integer('number'), column('result_id'), column('commit_sha'),
      integer('fix_round'),
      ...['carried_from', 'pushed_at', 'ci_window_from', 'ci_json', 'rerun_at', 'review_assignment_id', 'verdict_findings_id', 'extra_json',
        'outcome', 'outcome_detail_json', 'decided_at'].map(optional),
    ],
    indexes: [],
  },
  plan_execution_effects: {
    columns: [
      id, column('execution_id'), optional('change'), optional('round_id'), column('kind'), column('effect_key'), column('command_json'),
      column('state'), counter('tries', '0'), optional('next_at'), optional('outcome_json'), optional('error'),
      column('created_at'), optional('started_at'), optional('finished_at'),
    ],
    indexes: [{ name: 'plan_execution_effects_execution', unique: 0, columns: ['execution_id', 'state'] }],
  },
  plan_change_landings: {
    columns: [
      keyPart('plan_id', 1), keyPart('change', 2), column('execution_id'), column('team_id'), column('mechanism'),
      optionalInteger('pr_number'), optional('pr_url'), ...['head_sha', 'base_sha', 'merge_sha', 'landed_at'].map(name => column(name)),
      integer('tree_verified'), optional('post_ci_json'),
    ],
    indexes: [],
  },
}

/** Migration 9's delta: the three append-only outbound audit tables (execution-safety-recovery D6). */
const migration9: SchemaShape['tables'] = {
  outbound_calls: {
    columns: [
      { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'team_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'session_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'spawn_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'group_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'profile_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'task_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'agent_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'tool', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'mcp_server', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'tool_use_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'command', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'truncated', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'rule', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'verdict', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'destination', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'matches', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'classifier_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'cwd', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ],
    indexes: [{ name: 'outbound_calls_team_time', unique: 0, columns: ['team_id', 'created_at', 'id'] }],
  },
  outbound_outcomes: {
    columns: [
      ...['session_id', 'tool_use_id', 'outcome'].map(name => column(name)),
      optional('detail'),
      { name: 'duration_ms', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      column('created_at'),
    ],
    indexes: [],
  },
  outbound_acknowledgements: {
    columns: [
      id,
      ...['team_id', 'command_id', 'rule', 'destination', 'through_created_at', 'through_call_id'].map(name => column(name)),
      optional('note'),
      column('acknowledged_at'),
    ],
    indexes: [],
  },
}

/** Migration 10's table: one row per context-exhausted episode (chat-context-exhaustion D6/D8). */
const migration10 = {
  team_exhaustion_episodes: {
    columns: [
      keyPart('session_id', 1), keyPart('flagged_at', 2), column('team_id'), column('reason'),
      ...['task_id', 'dropped_id', 'recipient_session', 'note_id'].map(optional), column('created_at'),
    ],
    indexes: [],
  },
}

/** Migration 13's delta: integration branches, candidates, promotions, and promotion effects (integration-candidates D3). */
const migration13: SchemaShape['tables'] = {
  plan_integration_branches: {
    columns: [
      keyPart('team_id', 1), keyPart('branch', 2),
      ...['plan_id', 'target_branch', 'created_by', 'created_sha', 'created_at'].map(name => column(name)),
    ],
    indexes: [],
  },
  plan_integration_candidates: {
    columns: [
      id, column('team_id'), column('branch'), integer('seq'), column('kind'),
      ...['execution_id', 'change', 'result_id', 'round_id', 'promotion_id'].map(optional),
      ...['baseline_sha', 'commit_sha', 'tree_sha'].map(name => column(name)), optional('outside_json'),
      column('state'), column('created_at'), optional('decided_at'),
    ],
    indexes: [],
  },
  plan_promotions: {
    columns: [
      id, ...['team_id', 'plan_id', 'branch'].map(name => column(name)), integer('number'),
      column('command_id'), column('from_sha'), integer('through_seq'),
      ...['target_branch', 'promotion_branch', 'floor_json'].map(name => column(name)),
      optionalInteger('pr_number'), optional('pr_url'), optional('head_sha'), optional('step'), counter('moves', '0'),
      ...['ci_json', 'rerun_at', 'ci_window_from'].map(optional), column('state'),
      ...['outcome', 'outcome_detail_json', 'merge_sha'].map(optional),
      optionalInteger('tree_verified'), optionalInteger('fast_forwarded'), optional('fast_forward_note'), optional('cancel_reason'),
      column('started_at'), optional('finished_at'),
    ],
    indexes: [{ name: 'plan_promotions_one_running', unique: 1, columns: ['plan_id'] }],
  },
  plan_promotion_effects: {
    columns: [
      id, ...['promotion_id', 'kind', 'effect_key', 'command_json', 'state'].map(name => column(name)), counter('tries', '0'),
      optional('next_at'), optional('outcome_json'), optional('error'), column('created_at'), optional('started_at'), optional('finished_at'),
    ],
    indexes: [],
  },
}

/** Migration 16's delta: decision cards, decisions, fix tasks, and stall alerts (plan-supervision D3). */
const migration16: SchemaShape['tables'] = {
  plan_decision_cards: {
    columns: [
      id, column('team_id'), column('plan_id'), optionalInteger('revision'), optional('change'), optional('task_id'),
      column('question'), column('options_json'), optional('context'), column('asked_by_session'),
      optional('asked_by_group'), optional('asked_by_profile'), column('addressed_to'), optional('addressed_group'),
      optional('message_id'), column('created_at'),
    ],
    indexes: [
      { name: 'plan_decision_cards_plan', unique: 0, columns: ['plan_id', 'created_at'] },
      { name: 'plan_decision_cards_task', unique: 0, columns: ['task_id'] },
    ],
  },
  plan_decisions: {
    columns: [
      id, ...['card_id', 'plan_id', 'team_id'].map(name => column(name)), integer('seq'), column('kind'), column('choice'),
      optionalInteger('option_index'), optional('rationale'), column('decided_by_kind'),
      ...['decided_by_session', 'decided_by_group', 'decided_by_profile'].map(optional), column('affected_json'),
      ...['command_id', 'payload_json', 'reply_message_id'].map(optional), column('created_at'),
    ],
    indexes: [{ name: 'plan_decisions_team', unique: 0, columns: ['team_id', 'created_at'] }],
  },
  plan_fix_tasks: {
    columns: [{ ...column('task_id', 0, 1) }, ...['team_id', 'plan_id', 'source_kind', 'source_id', 'created_at'].map(name => column(name))],
    indexes: [{ name: 'plan_fix_tasks_plan', unique: 0, columns: ['plan_id'] }],
  },
  plan_stall_alerts: {
    columns: [
      id, ...['team_id', 'plan_id', 'execution_id', 'change', 'kind', 'episode_key', 'detail_json'].map(name => column(name)),
      optional('message_id'), column('raised_at'),
    ],
    indexes: [
      { name: 'plan_stall_alerts_plan', unique: 0, columns: ['plan_id', 'raised_at'] },
      { name: 'plan_stall_alerts_team', unique: 0, columns: ['team_id', 'raised_at'] },
    ],
  },
}

/** Migration 17's delta: holds and their change rows, pauses and their targets, checkpoints, and the execution revision history (revision-control D2). */
const migration17: SchemaShape['tables'] = {
  plan_holds: {
    columns: [
      id, ...['team_id', 'plan_id', 'scope', 'rationale', 'deadline'].map(name => column(name)),
      optional('cites_kind'), optional('cites_id'), column('created_at'), column('command_id'),
      optional('released_at'), optional('release_reason'), optional('release_command_id'),
    ],
    indexes: [{ name: 'plan_holds_active', unique: 0, columns: ['plan_id'] }],
  },
  plan_hold_changes: {
    columns: [keyPart('hold_id', 1), keyPart('change', 2), optional('released_at'), optional('release_command_id')],
    indexes: [],
  },
  plan_pauses: {
    columns: [
      id, ...['team_id', 'plan_id', 'execution_id', 'hold_id', 'deadline'].map(name => column(name)),
      optional('note'), column('created_at'), column('command_id'), optional('closed_at'),
    ],
    indexes: [],
  },
  plan_pause_targets: {
    columns: [
      keyPart('pause_id', 1), keyPart('change', 2), column('stage'), optional('attempt_id'),
      column('assignment_id'), optional('holder_session'), optional('message_id'), counter('withdrawn', '0'),
      optional('paused_at'), optional('checkpoint_id'), optional('decision'), optional('decision_detail_json'),
      optional('decided_at'), optional('decision_command_id'),
    ],
    indexes: [],
  },
  plan_checkpoints: {
    columns: [
      id, ...['execution_id', 'change', 'pause_id'].map(name => column(name)), optional('attempt_id'),
      column('session_id'), column('kind'), optional('commit_sha'), optional('baseline_commit'),
      optional('manifest_hash'), optional('result_id'), column('summary'), optional('unfinished'),
      optional('errors_tests'), column('next_steps'), optional('effect_id'), optional('superseded_by'),
      column('created_at'),
    ],
    indexes: [],
  },
  plan_execution_revisions: {
    columns: [
      keyPart('execution_id', 1), { ...integer('seq'), pk: 2 }, integer('revision'), column('content_hash'),
      column('report_id'), column('input_hash'), optional('rationale'), optional('command_id'),
      optional('payload_json'), column('applied_at'),
    ],
    indexes: [],
  },
  plan_execution_publication_changes: {
    columns: [
      keyPart('execution_id', 1), { ...integer('seq'), pk: 2 }, keyPart('change', 3), column('class'),
      optional('choice'), optional('fields_json'), optional('task_id'), optionalInteger('task_revision'),
    ],
    indexes: [],
  },
}

// Migration 19's delta: the plan-workspace tables (plan-workspace 1.2). The
// roles' and refs' CHECK constraints and every UNIQUE key are autoindexes,
// which the shape skips.
const migration19: SchemaShape['tables'] = {
  plan_workspace_chats: {
    columns: [keyPart('team_id', 1), keyPart('role', 2), column('session_id'), integer('version'), column('bound_at')],
    indexes: [],
  },
  plan_document_refs: {
    columns: [
      id, ...['team_id', 'plan_id'].map(name => column(name)), optional('change_name'), column('label'), column('kind'),
      optional('worktree_id'), optional('relative_path'), optional('url'), column('created_at'),
    ],
    indexes: [],
  },
  chat_workspace_turn_context: {
    columns: [
      keyPart('session_id', 1), keyPart('message_uuid', 2), optional('turn_id'), column('context_json'),
      optional('team_id'), optional('plan_id'), column('recorded_at'),
    ],
    indexes: [],
  },
  plan_workspace_commands: {
    columns: [keyPart('team_id', 1), keyPart('command_id', 2), column('kind'), column('payload'), column('outcome'), column('at')],
    indexes: [],
  },
}

// Migration 20's delta: result checks and coverage maps (independent-
// verification D4). The UNIQUE (result_id, seq) key is a named index (not an
// autoindex, which the shape skips); the one-pending partial index and the
// team-pending lookup are named too. Migration 20 also adds the nullable
// `coverage` column to team_task_results, applied beside the tables below.
const migration20: SchemaShape['tables'] = {
  team_task_result_checks: {
    columns: [
      id, ...['team_id', 'task_id', 'result_id'].map(name => column(name)), integer('seq'), column('trigger'),
      column('requested_by_kind'), optional('requested_by_session'), column('status'), optional('facts'), optional('reason'),
      column('created_at'), optional('finished_at'),
    ],
    indexes: [
      { name: 'team_task_result_checks_one_pending', unique: 1, columns: ['result_id'] },
      { name: 'team_task_result_checks_seq', unique: 1, columns: ['result_id', 'seq'] },
      { name: 'team_task_result_checks_team_pending', unique: 0, columns: ['team_id', 'status', 'created_at'] },
    ],
  },
  team_task_coverage_maps: {
    columns: [id, ...['team_id', 'task_id', 'result_id', 'author_session', 'coverage', 'created_at'].map(name => column(name))],
    indexes: [],
  },
}

// Migration 21's delta (compact-observation-detail D5): migration 11's team
// association table is dropped, and the unread `team_time` and `task` indexes
// give way to `(team_id, seq)`.
const { process_observation_teams: _teams, ...observationTables } = migration11 as SchemaShape['tables']
const observations = observationTables.process_observations!
const migration11And21: SchemaShape['tables'] = {
  ...observationTables,
  process_observations: {
    ...observations,
    indexes: [
      { name: 'process_observations_kind', unique: 0, columns: ['kind', 'recorded_at'] },
      { name: 'process_observations_team', unique: 0, columns: ['team_id', 'seq'] },
      { name: 'process_observations_turn', unique: 0, columns: ['session_id', 'turn_id', 'seq'] },
    ],
  },
}

// Migration 22's delta (team-approval-default D3): one default approval row
// per team; its TEXT primary key's autoindex is skipped by the shape.
const migration22: SchemaShape['tables'] = {
  team_approval_defaults: { columns: [column('team_id', 0, 1), column('policy'), column('updated_at')], indexes: [] },
}

test('a fresh database opened by this build has the same shape plus each migration\'s delta and schema_migrations', () => {
  const session = initDatabase({ path: ':memory:' })
  const added = { ...migration2, ...migration3, ...migration4, ...migration5, ...migration6, ...migration7, ...migration8, ...migration9, ...migration10, ...migration11And21, ...migration13, ...migration16, ...migration17, ...migration19, ...migration20, ...migration22 }
  expect(Object.keys(added).filter(table => table in expected.tables)).toEqual([])
  // Migration 20's: the submitter's nullable coverage map (independent-
  // verification D4), appended after the baseline columns.
  const results = expected.tables.team_task_results!
  const withCoverage = { ...results, columns: [...results.columns, optional('coverage')] }
  const messages = expected.tables.team_messages!
  // Migration 18's: the sender's worker choice (dispatch-worker-choice D1).
  const withProfiles = { ...messages, columns: [...messages.columns, optional('allowed_profiles'), optional('worker_choice')] }
  const assignments = expected.tables.team_task_assignments!
  const withChoice = { ...assignments, columns: [...assignments.columns, optional('worker_choice')] }
  // Migration 10's delta: the chat_sessions exhaustion flags; migration 11's
  // the process-observations tables (in `added` above); migration 12's: limit
  // events record their provider and window (providers-and-workers D7), both
  // nullable, after the baseline columns; migration 14's: the `at` index here
  // and the `ended_at` index on chat_turn_usage (in migration 6's delta);
  // migration 15's (codex-chat-sessions 3.3): the creation-fixed runtime (NOT
  // NULL DEFAULT 'claude') and, for Codex chats, the resolved home, plus the
  // transcript path.
  const chats = expected.tables.chat_sessions!
  const withFlag = {
    ...chats,
    columns: [
      ...chats.columns,
      optional('context_exhausted_at'),
      optional('context_exhausted_reason'),
      { name: 'runtime', type: 'TEXT', notnull: 1, dflt_value: "'claude'", pk: 0 },
      optional('codex_home'),
      optional('transcript_path'),
    ],
  }
  const limitEvents = expected.tables.profile_limit_events!
  const withLimitContext = {
    columns: [...limitEvents.columns, optional('provider_id'), optional('limit_window')],
    indexes: [{ name: 'profile_limit_events_at', unique: 0, columns: ['at'] }, ...limitEvents.indexes],
  }
  expect(schemaShape(session.db)).toEqual({
    tables: { ...expected.tables, ...added, team_messages: withProfiles, team_task_assignments: withChoice, chat_sessions: withFlag, profile_limit_events: withLimitContext, team_task_results: withCoverage },
  })
  const extra = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  expect(extra).toEqual({ name: 'schema_migrations' })
  session.close()
})
