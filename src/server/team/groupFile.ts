// One group definition file (`.kawai/groups/<id>.md`): optional frontmatter
// between `---` fences, then a markdown body that is the group's role prompt.
// The frontmatter is a deliberately small YAML subset — flat `key: value`
// scalars, optionally quoted, `#` comment lines — so the parser needs no YAML
// dependency and an agent-written file cannot smuggle structure in. Known
// keys are validated; unknown keys are ignored so later changes can add
// settings without breaking older readers. Team tasks add `canCreateTasks`,
// `max`, `profile`, and `approval` (team-tasks design D2/D6); team mailbox
// management adds `canManageMailbox`; profile routing
// adds `profiles`, `strategy`, and `onLimit`; group effort adds `effort`, the
// reasoning effort members' agents launch with, and `profileEffort` (a flow
// map from profile id to level) overrides it per profile; member release adds
// `releaseOnTaskClose`, `worktreeScoped`, and `canReleaseMembers` (all strict
// booleans, default true); durable plans add `canCreatePlans` (a strict
// boolean like `canCreateTasks`, default false); process reports add
// `canReportProcess` (strict, default false: members may submit process
// reports and link proposals). `profiles` and `onLimit` take
// one single-line flow value (`[a, b]` or `{ k: v }`, scalars only — never
// nested), as does `profileEffort`. Defaults are applied here so every reader
// sees the same effective values. Bad `onLimit`, `effort`, and `profileEffort`
// values are warnings (the defaults apply) rather than a rejected file, as the
// profile-routing spec asks.
import type { ChatApprovalPolicy } from '../../shared/chat'
import { PROFILE_ID_PATTERN } from '../chat/profileCatalog'

/** One allowed profile of a group, in preference order. */
export interface GroupProfile {
  profileId: string
  /** Live group members allowed on this profile (map form only). */
  cap?: number
}

export type RoutingStrategy = 'first-available' | 'profile-order'
export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ['first-available', 'profile-order']

/** The group's built-in limit outcome policy (profile-routing D4b). */
export interface GroupLimitPolicy {
  parkIfResetWithinMs: number
  /** Applied when the agent made progress and the reset is later. */
  otherwise: 'forward' | 'release'
  /** Group id or team session id; unset = the same group. */
  forwardTo?: string
}

/** Reasoning effort a group's members launch with (the SDK's `effort` option). */
export type GroupEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const GROUP_EFFORTS: readonly GroupEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const DEFAULT_PARK_IF_RESET_WITHIN_MS = 3 * 60 * 60 * 1000

export interface GroupDefinition {
  id: string
  /** Display name; the id when the file sets none. */
  label: string
  /** One line shown to other agents; empty when unset. */
  description: string
  /** Per-thread hop limit override (agent-mailbox); unset = default. */
  hopLimit?: number
  /** Members may create team tasks (team-tasks); default false. */
  canCreateTasks: boolean
  /** Members may create plans with `plan_create` (durable-plans D11); default false. */
  canCreatePlans: boolean
  /** Spawned members are released when their task closes (member-release); default true. */
  releaseOnTaskClose: boolean
  /** Task mail is scoped to the task's worktree (member-release); default true. */
  worktreeScoped: boolean
  /** Members may call `release_member` (member-release); default true. */
  canReleaseMembers: boolean
  /** Members may submit process reports and link proposals (team-process-metrics D6); default false. */
  canReportProcess: boolean
  /** Members may cancel any team message and discard dead/uncertain mail (team-mailbox-management); default false. */
  canManageMailbox: boolean
  /** Live-member cap for worktree staffing spawns; default the sum of profile caps, else 1. */
  max: number
  /** The max came from the cap sum, so the resolver re-sums resolved caps. */
  maxFromCaps?: boolean
  /** Profiles spawned members may use, preferred first; empty = the default profile. */
  profiles: GroupProfile[]
  /** Built-in routing strategy when no rule decides. */
  strategy: RoutingStrategy
  /** Built-in limit outcome policy. */
  onLimit: GroupLimitPolicy
  /**
   * The `approval:` key, unset when the file has none (team-approval-default
   * D1): spawns resolve it with the team default via `resolveSpawnApproval`.
   */
  approval?: ChatApprovalPolicy
  /** Effort every member's agent launches with; unset = Claude Code settings decide. */
  effort?: GroupEffort
  /** Per-profile effort overriding `effort` for members on that profile; valid entries only. */
  profileEffort?: Record<string, GroupEffort>
  /** Problems that fell back to defaults instead of rejecting the file. */
  warnings: string[]
  /** The role prompt appended to members' system prompts. */
  prompt: string
}

export type GroupFileParse =
  | { ok: true; group: GroupDefinition }
  | { ok: false; error: string }

const FENCE = /^---[ \t]*$/

/** Parse a group file's content; `id` comes from the file name. */
export function parseGroupFile(id: string, content: string): GroupFileParse {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/)
  let fields: Map<string, string> = new Map()
  let bodyStart = 0
  if (lines.length > 0 && FENCE.test(lines[0]!)) {
    const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
    if (close < 0) return { ok: false, error: 'frontmatter is not closed by ---' }
    const parsed = parseFields(lines.slice(1, close))
    if (!parsed.ok) return parsed
    fields = parsed.fields
    bodyStart = close + 1
  }

  const label = fields.get('label')?.trim()
  const description = fields.get('description')?.trim() ?? ''
  const rawHopLimit = fields.get('hopLimit')
  let hopLimit: number | undefined
  if (rawHopLimit !== undefined) {
    if (!/^[1-9]\d*$/.test(rawHopLimit.trim())) {
      return { ok: false, error: `hopLimit must be a positive integer, got "${rawHopLimit}"` }
    }
    hopLimit = Number(rawHopLimit.trim())
  }
  const settings = parseTaskSettings(fields)
  if (!settings.ok) return settings

  return {
    ok: true,
    group: {
      id,
      label: label || id,
      description,
      ...(hopLimit !== undefined ? { hopLimit } : {}),
      ...settings.settings,
      prompt: lines.slice(bodyStart).join('\n').trim(),
    },
  }
}

type TaskSettings = Pick<GroupDefinition,
  'canCreateTasks' | 'canCreatePlans' | 'canManageMailbox' | 'releaseOnTaskClose' | 'worktreeScoped' | 'canReleaseMembers'
  | 'canReportProcess' | 'max' | 'maxFromCaps' | 'profiles' | 'strategy' | 'onLimit' | 'approval' | 'effort' | 'profileEffort' | 'warnings'>

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function parseTaskSettings(
  fields: Map<string, string>
): { ok: true; settings: TaskSettings } | { ok: false; error: string } {
  const warnings: string[] = []
  const settings: TaskSettings = {
    canCreateTasks: false, canCreatePlans: false, canManageMailbox: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true,
    canReportProcess: false, max: 1, profiles: [], strategy: 'first-available',
    onLimit: parseOnLimit(fields.get('onLimit'), warnings), warnings,
  }
  const canCreate = fields.get('canCreateTasks')?.trim()
  if (canCreate !== undefined) {
    if (canCreate !== 'true' && canCreate !== 'false') {
      return { ok: false, error: `canCreateTasks must be true or false, got "${canCreate}"` }
    }
    settings.canCreateTasks = canCreate === 'true'
  }
  settings.canManageMailbox = parseCanManageMailbox(fields.get('canManageMailbox'), warnings)
  for (const key of ['canCreatePlans', 'releaseOnTaskClose', 'worktreeScoped', 'canReleaseMembers', 'canReportProcess'] as const) {
    const raw = fields.get(key)?.trim()
    if (raw === undefined) continue
    if (raw !== 'true' && raw !== 'false') {
      return { ok: false, error: `${key} must be true or false, got "${raw}"` }
    }
    settings[key] = raw === 'true'
  }
  const profile = fields.get('profile')?.trim()
  const profiles = fields.get('profiles')?.trim()
  // `workers` is the new name of `profiles` (D12): when it is set, the old
  // keys are ignored with one warning each — so setting both `profile` and
  // `profiles` beside it no longer rejects the file, since neither is read.
  const workers = fields.get('workers')?.trim()
  if (workers !== undefined) {
    if (profile !== undefined) warnings.push('profile is ignored; workers is set')
    if (profiles !== undefined) warnings.push('profiles is ignored; workers is set')
    const parsed = parseProfiles(workers, 'workers', true)
    if (!parsed.ok) return parsed
    settings.profiles = parsed.value
  } else {
    if (profile !== undefined && profiles !== undefined) {
      return { ok: false, error: 'set either profile or profiles, not both' }
    }
    if (profile !== undefined) {
      if (!PROFILE_ID_PATTERN.test(profile)) return { ok: false, error: `profile "${profile}" is not a valid profile id` }
      settings.profiles = [{ profileId: profile }]
    }
    if (profiles !== undefined) {
      const parsed = parseProfiles(profiles, 'profiles')
      if (!parsed.ok) return parsed
      settings.profiles = parsed.value
    }
  }
  // Map form: every entry has a cap, and their sum is the default max —
  // marked, so the resolver can re-sum the RESOLVED caps after dropping
  // entries while an explicit max always stays (finding N2).
  const capSum = settings.profiles.length > 0 && settings.profiles.every(entry => entry.cap !== undefined)
    ? settings.profiles.reduce((sum, entry) => sum + entry.cap!, 0)
    : null
  const max = fields.get('max')?.trim()
  if (max !== undefined) {
    if (!/^[1-9]\d*$/.test(max)) return { ok: false, error: `max must be a positive integer, got "${max}"` }
    settings.max = Number(max)
  } else if (capSum !== null) {
    settings.max = capSum
    settings.maxFromCaps = true
  }
  const strategy = fields.get('strategy')?.trim()
  if (strategy !== undefined) {
    if (!ROUTING_STRATEGIES.includes(strategy as RoutingStrategy)) {
      return { ok: false, error: `strategy must be ${ROUTING_STRATEGIES.join(' or ')}, got "${strategy}"` }
    }
    settings.strategy = strategy as RoutingStrategy
  }
  const approval = fields.get('approval')?.trim()
  if (approval !== undefined) {
    if (approval !== 'manual' && approval !== 'auto') {
      return { ok: false, error: `approval must be manual or auto, got "${approval}"` }
    }
    settings.approval = approval
  }
  const effort = fields.get('effort')?.trim()
  if (effort !== undefined) {
    if (GROUP_EFFORTS.includes(effort as GroupEffort)) settings.effort = effort as GroupEffort
    else warnings.push(`effort must be ${GROUP_EFFORTS.join(', ')}, got "${effort}"; ignored`)
  }
  // `modelEffort` is the new name of `profileEffort` (D12); the old key is
  // ignored with a warning when both are set.
  const rawModelEffort = fields.get('modelEffort')
  if (rawModelEffort !== undefined) {
    if (fields.get('profileEffort') !== undefined) warnings.push('profileEffort is ignored; modelEffort is set')
    const modelEffort = parseProfileEffort(rawModelEffort.trim(), settings.profiles, warnings, 'modelEffort', true)
    if (modelEffort) settings.profileEffort = modelEffort
  } else {
    const profileEffort = parseProfileEffort(fields.get('profileEffort'), settings.profiles, warnings)
    if (profileEffort) settings.profileEffort = profileEffort
  }
  return { ok: true, settings }
}

/**
 * `profileEffort: { haiku: xhigh }`. Every problem is a warning that drops
 * only the bad entry (or the whole key when it is not a map); an entry for a
 * profile the group does not list is kept, since a human-created member can
 * run on any profile.
 */
function parseProfileEffort(
  raw: string | undefined, listed: GroupProfile[], warnings: string[],
  label = 'profileEffort', qualifiedKeys = false,
): Record<string, GroupEffort> | undefined {
  if (raw === undefined) return undefined
  const flow = parseFlow(raw.trim(), true, qualifiedKeys)
  if (!flow.ok || flow.value.kind !== 'map') {
    warnings.push(`${label}: ${flow.ok ? 'expected { profile: level, ... }' : flow.error}; ignored`)
    return undefined
  }
  const groupProfiles = new Set(listed.length > 0 ? listed.map(entry => entry.profileId) : ['default'])
  const result: Record<string, GroupEffort> = {}
  const seen = new Set<string>()
  for (const [profileId, level] of flow.value.entries) {
    if (seen.has(profileId)) {
      warnings.push(`${label}: "${profileId}" is listed twice; the later entry is ignored`)
      continue
    }
    seen.add(profileId)
    // A `provider/model` key is left for groupCatalog to resolve against the
    // catalog; a bare key must be an id.
    if (!isFlowKeyValid(profileId, qualifiedKeys)) {
      warnings.push(`${label}: "${profileId}" is not a valid profile id; ignored`)
    } else if (!GROUP_EFFORTS.includes(level as GroupEffort)) {
      warnings.push(`${label}.${profileId} must be ${GROUP_EFFORTS.join(', ')}, got "${level}"; ignored`)
    } else {
      result[profileId] = level as GroupEffort
      // A qualified key cannot be checked against the list until groupCatalog
      // resolves it; a bare key not among the group's profiles warns here.
      if (!profileId.includes('/') && !groupProfiles.has(profileId)) {
        warnings.push(`${label}: "${profileId}" is not one of the group's profiles; it applies only to members on that profile`)
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** `id` always; `provider/model` too when the new group keys allow it (D5). */
function isFlowKeyValid(key: string, qualifiedKeys: boolean): boolean {
  if (PROFILE_ID_PATTERN.test(key)) return true
  if (!qualifiedKeys) return false
  const parts = key.split('/')
  return parts.length === 2 && parts.every(part => PROFILE_ID_PATTERN.test(part))
}

/**
 * A rights flag degrades alone: a typo warns and leaves the right off rather
 * than dropping the group's role and membership. The one place to change if an
 * invalid value should reject the file instead.
 */
function parseCanManageMailbox(raw: string | undefined, warnings: string[]): boolean {
  const value = raw?.trim()
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  warnings.push(`canManageMailbox must be true or false, got "${value}"; ignored`)
  return false
}

/** `[a, b]` (no caps) or `{ a: 2, b: 1 }` (caps); order is preference. */
function parseProfiles(raw: string, label = 'profiles', qualifiedKeys = false): Parsed<GroupProfile[]> {
  const flow = parseFlow(raw, false, qualifiedKeys)
  if (!flow.ok) return { ok: false, error: `${label}: ${flow.error}` }
  const entries: GroupProfile[] = []
  const seen = new Set<string>()
  for (const [key, value] of flow.value.entries) {
    const profileId = flow.value.kind === 'list' ? value : key
    if (!isFlowKeyValid(profileId, qualifiedKeys)) {
      return { ok: false, error: `${label}: "${profileId}" is not a valid profile id` }
    }
    if (seen.has(profileId)) return { ok: false, error: `${label}: "${profileId}" is listed twice` }
    seen.add(profileId)
    if (flow.value.kind === 'list') {
      entries.push({ profileId })
      continue
    }
    if (!/^[1-9]\d*$/.test(value)) {
      return { ok: false, error: `${label}: cap for "${profileId}" must be a positive integer, got "${value}"` }
    }
    entries.push({ profileId, cap: Number(value) })
  }
  if (entries.length === 0) return { ok: false, error: `${label}: list at least one profile` }
  return { ok: true, value: entries }
}

const ON_LIMIT_KEYS = new Set(['parkIfResetWithin', 'otherwise', 'forwardTo'])
/** A group id or a team session id. */
const FORWARD_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Invalid values are warnings: the spec keeps the defaults for them. */
function parseOnLimit(raw: string | undefined, warnings: string[]): GroupLimitPolicy {
  const policy: GroupLimitPolicy = { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' }
  if (raw === undefined) return policy
  const flow = parseFlow(raw.trim())
  if (!flow.ok || flow.value.kind !== 'map') {
    warnings.push(`onLimit: ${flow.ok ? 'expected { key: value, ... }' : flow.error}; using defaults`)
    return policy
  }
  for (const [key, value] of flow.value.entries) {
    if (!ON_LIMIT_KEYS.has(key)) {
      warnings.push(`onLimit: unknown key "${key}" ignored`)
    } else if (key === 'parkIfResetWithin') {
      const ms = parseDuration(value)
      if (ms === null) warnings.push(`onLimit.parkIfResetWithin "${value}" is not a duration like 90m or 3h; using 3h`)
      else policy.parkIfResetWithinMs = ms
    } else if (key === 'otherwise') {
      if (value === 'forward' || value === 'release') policy.otherwise = value
      else warnings.push(`onLimit.otherwise must be forward or release, got "${value}"; using forward`)
    } else if (FORWARD_TARGET_PATTERN.test(value)) {
      policy.forwardTo = value
    } else {
      warnings.push(`onLimit.forwardTo "${value}" is not a group or session id; using the same group`)
    }
  }
  return policy
}

/** `<n>m` or `<n>h` in milliseconds; null when malformed. */
export function parseDuration(value: string): number | null {
  const match = /^([1-9]\d*)(m|h)$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * (match[2] === 'h' ? 3_600_000 : 60_000)
}

type Flow = { kind: 'list' | 'map'; entries: Array<[string, string]> }

/**
 * One single-line flow collection of scalars: `[a, 'b']` or `{ k: v }`.
 * List entries carry their index as key. Nesting, empty items, and stray
 * brackets are errors — the frontmatter stays a flat, scalar-only format. A
 * repeated map key is an error unless `allowRepeats` (the caller handles it).
 * With `qualifiedKeys`, a map key may take one `/` between two id-shaped
 * parts (`zai/glm`) — the new group keys' `provider/model` form (D5); the
 * old keys keep their grammar and reject it as today.
 */
function parseFlow(raw: string, allowRepeats = false, qualifiedKeys = false): Parsed<Flow> {
  const open = raw[0]
  const close = open === '[' ? ']' : open === '{' ? '}' : null
  if (!close) return { ok: false, error: `expected [ ... ] or { ... }, got "${raw}"` }
  if (raw[raw.length - 1] !== close) return { ok: false, error: `"${raw}" is not closed by ${close}` }
  const inner = raw.slice(1, -1).trim()
  if (/[[\]{}]/.test(inner)) return { ok: false, error: 'nested values are not supported' }
  const kind = open === '[' ? 'list' : 'map'
  if (inner === '') return { ok: true, value: { kind, entries: [] } }
  const entries: Array<[string, string]> = []
  for (const [index, item] of inner.split(',').entries()) {
    const text = item.trim()
    if (text === '') return { ok: false, error: 'empty item' }
    if (kind === 'list') {
      const value = unquote(text)
      if (value === null || value === '') return { ok: false, error: `bad item "${text}"` }
      entries.push([String(index), value])
      continue
    }
    const match = qualifiedKeys
      ? /^([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)\s*:\s*(.+)$/.exec(text)
      : /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(text)
    const value = match ? unquote(match[2]!.trim()) : null
    if (!match || value === null || value === '') return { ok: false, error: `"${text}" is not "key: value"` }
    if (!allowRepeats && entries.some(([key]) => key === match[1])) return { ok: false, error: `key "${match[1]}" is repeated` }
    entries.push([match[1]!, value])
  }
  return { ok: true, value: { kind, entries } }
}

function parseFields(
  lines: string[]
): { ok: true; fields: Map<string, string> } | { ok: false; error: string } {
  const fields = new Map<string, string>()
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (!match) {
      return { ok: false, error: `frontmatter line ${index + 2} is not "key: value"` }
    }
    const key = match[1]!
    if (fields.has(key)) {
      return { ok: false, error: `frontmatter key "${key}" is repeated` }
    }
    const value = unquote(match[2]!.trim())
    if (value === null) {
      return { ok: false, error: `frontmatter value for "${key}" has an unterminated quote` }
    }
    fields.set(key, value)
  }
  return { ok: true, fields }
}

/** Strip one pair of matching quotes; null for an unbalanced quote. */
function unquote(value: string): string | null {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return value
  if (value.length < 2 || value[value.length - 1] !== quote) return null
  return value.slice(1, -1)
}
