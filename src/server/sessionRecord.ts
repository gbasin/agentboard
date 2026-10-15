/** Map persisted provider rows without opening or migrating a database. */
import type { AgentType } from '../shared/types'
import type { AgentSessionRecord } from './db'

export function mapRow(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    logFilePath: String(row.log_file_path ?? ''),
    projectPath: String(row.project_path ?? ''),
    slug:
      row.slug === null || row.slug === undefined
        ? null
        : String(row.slug),
    agentType: row.agent_type as AgentType,
    displayName: String(row.display_name ?? ''),
    createdAt: String(row.created_at ?? ''),
    lastActivityAt: String(row.last_activity_at ?? ''),
    lastUserMessage:
      row.last_user_message === null || row.last_user_message === undefined
        ? null
        : String(row.last_user_message),
    currentWindow:
      row.current_window === null || row.current_window === undefined
        ? null
        : String(row.current_window),
    isHibernating: Number(row.is_hibernating) === 1,
    lastResumeError:
      row.last_resume_error === null || row.last_resume_error === undefined
        ? null
        : String(row.last_resume_error),
    wakeStartedAt:
      row.wake_started_at === null || row.wake_started_at === undefined
        ? null
        : String(row.wake_started_at),
    // Note: null lastKnownLogSize is treated as "unknown", triggering a match check
    // on first poll after upgrade. This is intentional (one-time cost).
    lastKnownLogSize:
      row.last_known_log_size === null || row.last_known_log_size === undefined
        ? null
        : Number(row.last_known_log_size),
    isCodexExec: Number(row.is_codex_exec) === 1,
    launchCommand:
      row.launch_command === null || row.launch_command === undefined
        ? null
        : String(row.launch_command),
  }
}

