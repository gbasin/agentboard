// Catalog acceptance table C and seeded ordering property P1 (autocomplete D1).
import { expect, test } from 'bun:test'
import { codexCommandCatalog } from '../chat/codex/codexCommands'

export const skill = (name = 'explore', extra: Record<string, unknown> = {}) => ({
  name, description: `Use ${name}`, path: `/skills/${name}/SKILL.md`, scope: 'repo', enabled: true, ...extra,
})
export const entry = (skills: unknown[] = [skill()], cwd = '/project', errors: unknown[] = []) => ({ cwd, skills, errors })
const names = (response: unknown) => codexCommandCatalog(response, '/project')?.commands.map(command => command.name) ?? null

// Table C verbatim: [Id, Input, Observable result].
export const catalogOracles = [
  ['C1', 'Exactly one matching cwd entry, eligible repo/user/system/admin skills', 'Ready, sorted names/descriptions, project/user/builtin source respectively; no paths on client'],
  ['C2', 'Valid matching entry, no eligible skills', 'Ready, empty commands'],
  ['C3', 'Missing/duplicate matching cwd entry or malformed response container', 'Unavailable, empty commands'],
  ['C4', 'Other cwd entries beside one matching entry', 'Only matching cwd skills offered'],
  ['C5', 'Disabled or malformed record, valid siblings', 'Record excluded; valid siblings offered'],
  ['C6', 'Name clear/reset/new in any case', 'Name excluded'],
  ['C7', 'Repeated enabled eligible exact name and same path', 'One command using first record metadata'],
  ['C8', 'Enabled eligible exact name with different paths', 'Entire name excluded'],
  ['C9', 'Matching entry has skill-load errors and valid skills', 'Ready with valid skills'],
] as const

// @covers: codex-chat-sessions › Codex skills populate the chat command list › Opening a Codex chat discovers skills
test('C1: source and descriptions follow metadata precedence; client metadata contains no paths', () => {
  const result = codexCommandCatalog({ data: [entry([
    skill('z', { scope: 'admin', interface: { shortDescription: 'interface' }, shortDescription: 'legacy' }),
    skill('a', { scope: 'user', shortDescription: 'legacy' }),
    skill('b', { scope: 'system' }), skill('c'),
  ], '/project/./')] }, '/project')!
  expect(result.commands).toEqual([
    { name: 'a', description: 'legacy', aliases: [], source: 'user' },
    { name: 'b', description: 'Use b', aliases: [], source: 'builtin' },
    { name: 'c', description: 'Use c', aliases: [], source: 'project' },
    { name: 'z', description: 'interface', aliases: [], source: 'builtin' },
  ])
  expect([...result.skills.values()]).toContainEqual({ type: 'skill', name: 'z', path: '/skills/z/SKILL.md' })
})

const cases: Array<[string, unknown, string[] | null]> = [
  ['C2', { data: [entry([])] }, []],
  ['C3', {}, null], ['C3', { data: [] }, null],
  ['C3', { data: [entry(), entry()] }, null],
  ['C3', { data: [entry([], '/project-other')] }, null],
  ['C3', { data: [null] }, null], ['C3', { data: [{ cwd: '/project', skills: [] }] }, null],
  ['C3', { data: [{ cwd: 'project', skills: [], errors: [] }] }, null],
  ['C4', { data: [entry([skill('foreign')], '/other'), entry()] }, ['explore']],
  ['C5', { data: [entry([null, skill('off', { enabled: false }), skill('bad name'), skill('bad/path'),
    skill('relative', { path: 'relative' }), skill('null-byte', { path: '/a\0b' }),
    skill('unknown-scope', { scope: 'unknown' }), skill('description', { description: 42 }), skill()])] }, ['explore']],
  ['C6', { data: [entry(['clear', 'reset', 'new', 'CLEAR', 'Reset', 'NEW'].map(name => skill(name)))] }, []],
  ['C7', { data: [entry([skill(), skill('explore', { description: 'second' })])] }, ['explore']],
  ['C8', { data: [entry([skill(), skill('explore', { path: '/other/SKILL.md' }), skill('explore')])] }, []],
  ['C9', { data: [entry([skill()], '/project', [{ message: 'failed sibling' }])] }, ['explore']],
]
for (const [id, response, expected] of cases) {
  // @covers: codex-chat-sessions › Codex skills populate the chat command list › Skills excluded from the list
  // @covers: codex-chat-sessions › Codex skills populate the chat command list › No skills installed
  test(`${id}: ${catalogOracles.find(row => row[0] === id)![1]} ${JSON.stringify(response)}`, () => {
    expect(names(response)).toEqual(expected)
    const catalog = codexCommandCatalog(response, '/project')
    if (id === 'C7') expect(catalog?.commands[0]?.description).toBe('Use explore')
    if (id === 'C8') expect(catalog?.skills.size).toBe(0)
    if (id === 'C9') expect(catalog?.loadErrors).toBe(1)
  })
}

test('P1: 500 seeded unique-record permutations produce identical ordered catalogs', () => {
  let state = 0xC0DE01
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  const records = Array.from({ length: 15 }, (_, i) => skill(`skill-${i}`, { enabled: i % 4 !== 0 }))
  const expected = codexCommandCatalog({ data: [entry(records)] }, '/project')
  for (let i = 0; i < 500; i++) {
    const shuffled = [...records]
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1)); [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!]
    }
    expect(codexCommandCatalog({ data: [entry(shuffled)] }, '/project')).toEqual(expected)
  }
})
