// Codex skill discovery normalization and exact slash references (autocomplete
// D1/D3). Public command metadata and private invocation paths come from the
// same validated catalog; no browser-supplied path or filesystem scan is used.
import path from 'node:path'
import type { ChatCommand } from '../../../shared/chat'

export interface CodexSkillInput { type: 'skill'; name: string; path: string }
export interface CodexCommandCatalog {
  commands: ChatCommand[]
  skills: Map<string, CodexSkillInput>
  loadErrors: number
  conflicts: string[]
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const reserved = new Set(['clear', 'reset', 'new'])
const sources = { repo: 'project', user: 'user', system: 'builtin', admin: 'builtin' } as const

/** Null is a failed discovery; an empty catalog is a successful empty list. */
export function codexCommandCatalog(response: unknown, cwd: string): CodexCommandCatalog | null {
  const data = object(response)?.data
  if (!Array.isArray(data) || !absolute(cwd)) return null
  const entries = data.map(object)
  if (entries.some(entry => !entry || !absolute(entry.cwd))) return null
  const matching = entries.filter(entry => path.resolve(entry!.cwd as string) === path.resolve(cwd))
  if (matching.length !== 1) return null
  const entry = matching[0]!
  if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors)) return null
  const groups = new Map<string, { command: ChatCommand; skill: CodexSkillInput }>()
  const conflicts = new Set<string>()
  for (const raw of entry.skills) {
    const skill = object(raw)
    if (!skill || skill.enabled !== true || typeof skill.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(skill.name) || reserved.has(skill.name.toLowerCase()) ||
      !absolute(skill.path) || typeof skill.description !== 'string' ||
      typeof skill.scope !== 'string' || !Object.hasOwn(sources, skill.scope)) continue
    const previous = groups.get(skill.name)
    if (previous) {
      if (previous.skill.path !== skill.path) conflicts.add(skill.name)
      continue
    }
    const description = [object(skill.interface)?.shortDescription, skill.shortDescription, skill.description]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? ''
    groups.set(skill.name, {
      command: { name: skill.name, description, aliases: [], source: sources[skill.scope as keyof typeof sources] },
      skill: { type: 'skill', name: skill.name, path: skill.path },
    })
  }
  const names = [...groups.keys()].filter(name => !conflicts.has(name)).sort()
  return {
    commands: names.map(name => groups.get(name)!.command),
    skills: new Map(names.map(name => [name, groups.get(name)!.skill])),
    loadErrors: entry.errors.length,
    conflicts: [...conflicts].sort(),
  }
}

/** Resolve only whole whitespace-delimited slash names, once in first-use order. */
export function codexSkillInputs(text: string, catalog: CodexCommandCatalog | null): CodexSkillInput[] {
  const found = new Map<string, CodexSkillInput>()
  for (const word of text.split(/\s+/)) {
    if (!word.startsWith('/')) continue
    const skill = catalog?.skills.get(word.slice(1))
    if (skill && !found.has(skill.name)) found.set(skill.name, { ...skill })
  }
  return [...found.values()]
}
