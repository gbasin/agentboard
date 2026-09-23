/**
 * Client settings that are persisted server-side and synced across all
 * connected browsers/devices. These describe the shared world (sessions,
 * server host, other clients) rather than the local device, so a value set
 * in one browser should apply everywhere.
 *
 * Synced keys are stored in the app_settings table under the
 * `synced_settings.` prefix and pushed to clients in a `synced-settings`
 * WebSocket message on connect and after every write.
 */
import type { AgentType } from './types'

export interface SyncedCommandPreset {
  id: string
  label: string
  command: string
  isBuiltIn: boolean
  agentType?: AgentType
}

export interface SyncedSettings {
  theme?: 'dark' | 'light'
  commandPresets?: SyncedCommandPreset[]
  defaultPresetId?: string
  defaultProjectDir?: string
  lastProjectPath?: string | null
  recentPaths?: string[]
  sessionSortMode?: 'status' | 'created' | 'manual'
  sessionSortDirection?: 'asc' | 'desc'
  manualSessionOrder?: string[]
  projectFilters?: string[]
  hostFilters?: string[]
}

export const SYNCED_SETTINGS_KEYS = [
  'theme',
  'commandPresets',
  'defaultPresetId',
  'defaultProjectDir',
  'lastProjectPath',
  'recentPaths',
  'sessionSortMode',
  'sessionSortDirection',
  'manualSessionOrder',
  'projectFilters',
  'hostFilters',
] as const

export type SyncedSettingsKey = (typeof SYNCED_SETTINGS_KEYS)[number]

const AGENT_TYPES: readonly string[] = [
  'claude',
  'claude-rp',
  'codex',
  'pi',
  'devin',
  'grok',
  'omp',
]

function isStringArray(value: unknown, maxLen: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxLen &&
    value.every((item) => typeof item === 'string')
  )
}

function isValidSyncedPreset(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 128 &&
    typeof p.label === 'string' && p.label.trim().length >= 1 && p.label.length <= 64 &&
    typeof p.command === 'string' && p.command.trim().length >= 1 && p.command.length <= 1024 &&
    typeof p.isBuiltIn === 'boolean' &&
    (p.agentType === undefined || AGENT_TYPES.includes(p.agentType as string))
  )
}

const VALIDATORS: Record<SyncedSettingsKey, (value: unknown) => boolean> = {
  theme: (v) => v === 'dark' || v === 'light',
  commandPresets: (v) =>
    Array.isArray(v) && v.length <= 50 && v.every(isValidSyncedPreset),
  defaultPresetId: (v) => typeof v === 'string' && v.length <= 128,
  defaultProjectDir: (v) => typeof v === 'string' && v.length <= 4096,
  lastProjectPath: (v) =>
    v === null || (typeof v === 'string' && v.length <= 4096),
  recentPaths: (v) => isStringArray(v, 50),
  sessionSortMode: (v) => v === 'status' || v === 'created' || v === 'manual',
  sessionSortDirection: (v) => v === 'asc' || v === 'desc',
  manualSessionOrder: (v) => isStringArray(v, 1000),
  projectFilters: (v) => isStringArray(v, 500),
  hostFilters: (v) => isStringArray(v, 500),
}

export function isSyncedSettingsKey(key: string): key is SyncedSettingsKey {
  return (SYNCED_SETTINGS_KEYS as readonly string[]).includes(key)
}

export function isValidSyncedSetting(
  key: SyncedSettingsKey,
  value: unknown
): boolean {
  return VALIDATORS[key](value)
}
