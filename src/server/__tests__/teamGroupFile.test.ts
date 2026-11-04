// @reads: docs/routing/README.md
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS, parseDuration, parseGroupFile, type GroupDefinition, type GroupEffort } from '../team/groupFile'

const ROUTING_DEFAULTS = {
  canCreatePlans: false,
  canManageMailbox: false,
  profiles: [],
  strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' },
  warnings: [],
} as const satisfies Partial<GroupDefinition>

describe('parseGroupFile', () => {
  test('reads label, description, hop limit, and the body as role prompt', () => {
    const parsed = parseGroupFile('architects', [
      '---',
      '# owners of the system shape',
      'label: Architects',
      'description: "Owns system design"',
      'hopLimit: 8',
      'futureSetting: ignored',
      '---',
      '',
      'You review designs.',
      '',
      'Keep answers short.',
      '',
    ].join('\n'))
    expect(parsed).toEqual({
      ok: true,
      group: {
        id: 'architects',
        label: 'Architects',
        description: 'Owns system design',
        hopLimit: 8,
        canCreateTasks: false,
        releaseOnTaskClose: true,
        worktreeScoped: true,
        canReleaseMembers: true, canReportProcess: false,
        max: 1,
        ...ROUTING_DEFAULTS,
        prompt: 'You review designs.\n\nKeep answers short.',
      },
    })
  })

  test('a body-only file defaults the label to the id', () => {
    expect(parseGroupFile('qa', 'Test everything.\n')).toEqual({
      ok: true,
      group: { id: 'qa', label: 'qa', description: '', canCreateTasks: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, canReportProcess: false, max: 1, ...ROUTING_DEFAULTS, prompt: 'Test everything.' },
    })
  })

  test('an empty label also falls back to the id; CRLF and BOM are tolerated', () => {
    const parsed = parseGroupFile('devs', "﻿---\r\nlabel: ''\r\n---\r\nBuild it.")
    expect(parsed.ok && parsed.group).toMatchObject({ label: 'devs', prompt: 'Build it.' })
  })

  test('malformed frontmatter is an error, not a group', () => {
    for (const [content, error] of [
      ['---\nlabel: A\nBuild', 'not closed'],
      ['---\njust words\n---\n', 'line 2'],
      ['---\nlabel: "open\n---\n', 'unterminated quote'],
      ['---\nlabel: A\nlabel: B\n---\n', 'repeated'],
      ['---\nhopLimit: 0\n---\n', 'positive integer'],
      ['---\nhopLimit: many\n---\n', 'positive integer'],
      ['---\ncanCreateTasks: yes\n---\n', 'canCreateTasks must be true or false'],
      ['---\nmax: 0\n---\n', 'max must be a positive integer'],
      ['---\nmax: 1.5\n---\n', 'max must be a positive integer'],
      ['---\nprofile: GLM Pro\n---\n', 'not a valid profile id'],
      ['---\napproval: always\n---\n', 'approval must be manual or auto'],
      ['---\nprofile: glm\nprofiles: [glm]\n---\n', 'either profile or profiles'],
      ['---\nprofiles: glm, mimo\n---\n', 'expected [ ... ] or { ... }'],
      ['---\nprofiles: [glm, mimo\n---\n', 'not closed'],
      ['---\nprofiles: [glm, [mimo]]\n---\n', 'nested'],
      ['---\nprofiles: { glm: { cap: 2 } }\n---\n', 'nested'],
      ['---\nprofiles: [glm, , mimo]\n---\n', 'empty item'],
      ['---\nprofiles: []\n---\n', 'at least one'],
      ['---\nprofiles: [glm, glm]\n---\n', 'listed twice'],
      ['---\nprofiles: [GLM]\n---\n', 'not a valid profile id'],
      ['---\nprofiles: { glm: 0 }\n---\n', 'positive integer'],
      ['---\nprofiles: { glm }\n---\n', 'not "key: value"'],
      ['---\nstrategy: random\n---\n', 'strategy must be'],
    ] as const) {
      const parsed = parseGroupFile('x', content)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(error)
    }
  })

  test('reads team-task settings: creation right, member cap, profile, approval', () => {
    const parsed = parseGroupFile('leads', [
      '---',
      'canCreateTasks: true',
      'max: 3',
      'profile: glm',
      "approval: 'auto'",
      '---',
      'Lead.',
    ].join('\n'))
    expect(parsed.ok && parsed.group).toMatchObject({ canCreateTasks: true, max: 3, profiles: [{ profileId: 'glm' }], approval: 'auto' })
  })

  test('task settings default to no creation right, one member, default profile, unset approval', () => {
    const parsed = parseGroupFile('devs', '---\ncanCreateTasks: false\n---\nBuild.')
    expect(parsed.ok && parsed.group).toEqual({
      id: 'devs', label: 'devs', description: '', canCreateTasks: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, canReportProcess: false, max: 1, ...ROUTING_DEFAULTS, prompt: 'Build.',
    })
  })

  // team-approval-default design table P1–P4, verbatim.
  // | id | frontmatter        | parsed `approval`      |
  const APPROVAL_TABLE: Array<[id: string, frontmatter: string, expected: 'manual' | 'auto' | undefined | 'refused']> = [
    ['P1', '', undefined],
    ['P2', 'approval: manual', 'manual'],
    ['P3', 'approval: auto', 'auto'],
    ['P4', 'approval: yes', 'refused'],
  ]
  for (const [id, frontmatter, expected] of APPROVAL_TABLE) {
    test(`${id}: ${frontmatter || 'no approval key'} parses as ${expected ?? 'unset'}`, () => {
      const parsed = parseGroupFile('devs', `---\nlabel: Developers\n${frontmatter}\n---\nBuild.`)
      if (expected === 'refused') {
        expect(parsed).toEqual({ ok: false, error: 'approval must be manual or auto, got "yes"' })
        return
      }
      expect(parsed.ok).toBe(true)
      const group = parsed.ok ? parsed.group : null
      expect(group?.approval).toBe(expected)
      expect(group !== null && 'approval' in group).toBe(expected !== undefined)
    })
  }

  test('release settings read explicit opt-outs', () => {
    const parsed = parseGroupFile('qa', '---\nreleaseOnTaskClose: false\nworktreeScoped: false\ncanReleaseMembers: false\n---\nCheck.')
    expect(parsed.ok && parsed.group).toMatchObject({
      releaseOnTaskClose: false, worktreeScoped: false, canReleaseMembers: false,
    })
  })

  test('canCreatePlans (durable-plans 3.3): true, false, missing, and an invalid value rejecting the file', () => {
    const read = (frontmatter: string) => parseGroupFile('leads', `---\n${frontmatter}\n---\nLead.`)
    expect(read('canCreatePlans: true')).toMatchObject({ ok: true, group: { canCreatePlans: true } })
    expect(read('canCreatePlans: false')).toMatchObject({ ok: true, group: { canCreatePlans: false } })
    expect(read('label: Leads')).toMatchObject({ ok: true, group: { canCreatePlans: false } })
    const invalid = read('canCreatePlans: yes')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toContain('canCreatePlans must be true or false')
  })

  test('canReportProcess (team-process-metrics 8.1): true, false, default false, and an invalid value rejecting the file', () => {
    const read = (frontmatter: string) => parseGroupFile('lead', `---\n${frontmatter}\n---\nLead.`)
    expect(read('canReportProcess: true')).toMatchObject({ ok: true, group: { canReportProcess: true } })
    expect(read('canReportProcess: false')).toMatchObject({ ok: true, group: { canReportProcess: false } })
    expect(read('label: Lead')).toMatchObject({ ok: true, group: { canReportProcess: false } })
    const invalid = read('canReportProcess: yes')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toContain('canReportProcess must be true or false')
  })

  test('release settings reject values other than true or false', () => {
    for (const key of ['releaseOnTaskClose', 'worktreeScoped', 'canReleaseMembers']) {
      const parsed = parseGroupFile('x', `---\n${key}: maybe\n---\nBody.`)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(`${key} must be true or false`)
    }
  })

  test('profiles list: preference order, no caps, max stays 1', () => {
    const parsed = parseGroupFile('devs', "---\nprofiles: [claude, 'glm']\n---\nBuild.")
    expect(parsed.ok && parsed.group).toMatchObject({
      profiles: [{ profileId: 'claude' }, { profileId: 'glm' }], max: 1,
    })
  })

  test('profiles map: caps in preference order, max defaults to their sum', () => {
    const parsed = parseGroupFile('devs', '---\nprofiles: { glm: 2, mimo: 1, claude: 1 }\n---\nBuild.')
    expect(parsed.ok && parsed.group).toMatchObject({
      profiles: [{ profileId: 'glm', cap: 2 }, { profileId: 'mimo', cap: 1 }, { profileId: 'claude', cap: 1 }],
      max: 4,
    })
  })

  test('an explicit max still limits a capped group', () => {
    const parsed = parseGroupFile('devs', '---\nmax: 3\nprofiles: { glm: 2, mimo: 1, claude: 1 }\n---\nBuild.')
    expect(parsed.ok && parsed.group.max).toBe(3)
  })

  test('strategy profile-order', () => {
    const parsed = parseGroupFile('devs', '---\nstrategy: profile-order\n---\nBuild.')
    expect(parsed.ok && parsed.group.strategy).toBe('profile-order')
  })

  test('onLimit: all keys', () => {
    const parsed = parseGroupFile('devs', '---\nonLimit: { parkIfResetWithin: 90m, otherwise: release, forwardTo: architects }\n---\nBuild.')
    expect(parsed.ok && parsed.group).toMatchObject({
      onLimit: { parkIfResetWithinMs: 90 * 60_000, otherwise: 'release', forwardTo: 'architects' },
      warnings: [],
    })
  })

  test('onLimit: invalid values are warnings and the defaults apply', () => {
    const parsed = parseGroupFile('devs', '---\nonLimit: { parkIfResetWithin: soon, otherwise: pause, forwardTo: "a b", extra: 1 }\n---\nBuild.')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.group.onLimit).toEqual({ parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' })
    expect(parsed.group.warnings).toHaveLength(4)
    expect(parsed.group.warnings[0]).toContain('"soon"')
    expect(parsed.group.warnings[0]).toContain('using 3h')
  })

  test('onLimit: a malformed value warns and keeps every default', () => {
    for (const raw of ['3h', '[park]', '{ parkIfResetWithin: { x: 1 } }']) {
      const parsed = parseGroupFile('devs', `---\nonLimit: ${raw}\n---\nBuild.`)
      expect(parsed.ok && parsed.group.warnings).toHaveLength(1)
      expect(parsed.ok && parsed.group.onLimit.otherwise).toBe('forward')
    }
  })

  test('effort: every level is read, quoted or not; absent is unset', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const raw of [level, `"${level}"`, `'${level}'`]) {
        const parsed = parseGroupFile('devs', `---\neffort: ${raw}\n---\nBuild.`)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        expect(parsed.group.effort).toBe(level as GroupEffort)
        expect(parsed.group.warnings).toEqual([])
      }
    }
    const parsed = parseGroupFile('devs', '---\nlabel: Developers\n---\nBuild.')
    expect(parsed.ok && 'effort' in parsed.group).toBe(false)
  })

  test('effort: an invalid level warns, stays unset, and the rest of the file applies', () => {
    for (const raw of ['extreme', 'auto', 'ultracode', 'MAX', '']) {
      const parsed = parseGroupFile('devs', `---\nlabel: Developers\neffort: ${raw}\napproval: auto\n---\nBuild.`)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.group.effort).toBeUndefined()
      expect(parsed.group).toMatchObject({ label: 'Developers', approval: 'auto', prompt: 'Build.' })
      expect(parsed.group.warnings).toEqual([
        `effort must be low, medium, high, xhigh, max, got "${raw}"; ignored`,
      ])
    }
  })

  describe('profileEffort (group-profile-effort D3)', () => {
    const parse = (frontmatter: string) => {
      const parsed = parseGroupFile('juniors', `---\n${frontmatter}\n---\nJunior.`)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.group
    }

    test('valid entries are read, quoted or not, beside the group effort', () => {
      const group = parse("effort: low\nprofileEffort: { haiku: 'xhigh', glm-flash: max }\nprofiles: [haiku, glm-flash]")
      expect(group.effort).toBe('low')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh', 'glm-flash': 'max' })
      expect(group.warnings).toEqual([])
    })

    test('absent or empty is unset, without a group effort too', () => {
      expect('profileEffort' in parse('label: A')).toBe(false)
      expect('profileEffort' in parse('profileEffort: {}')).toBe(false)
      const group = parse('profileEffort: { default: high }')
      expect(group.profileEffort).toEqual({ default: 'high' })
      expect(group.effort).toBeUndefined()
    })

    test('an unknown level is ignored alone', () => {
      const group = parse('effort: low\nprofileEffort: { haiku: extreme, sonnet: high }\nprofiles: [haiku, sonnet]')
      expect(group.profileEffort).toEqual({ sonnet: 'high' })
      expect(group.warnings).toEqual([
        'profileEffort.haiku must be low, medium, high, xhigh, max, got "extreme"; ignored',
      ])
    })

    test('a key that is not a profile id is ignored alone', () => {
      const group = parse('profileEffort: { Haiku: high, sonnet: low }\nprofile: sonnet')
      expect(group.profileEffort).toEqual({ sonnet: 'low' })
      expect(group.warnings).toEqual(['profileEffort: "Haiku" is not a valid profile id; ignored'])
    })

    test('a repeated profile keeps the first and the file still parses', () => {
      const group = parse('profileEffort: { haiku: xhigh, haiku: low }\nprofile: haiku')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh' })
      expect(group.warnings).toEqual(['profileEffort: "haiku" is listed twice; the later entry is ignored'])
    })

    test('the first occurrence decides: an invalid first entry is not replaced by a later valid one', () => {
      const group = parse('effort: low\nprofileEffort: { haiku: extreme, haiku: high }\nprofile: haiku')
      expect('profileEffort' in group).toBe(false)
      expect(group.effort).toBe('low')
      expect(group.warnings).toEqual([
        'profileEffort.haiku must be low, medium, high, xhigh, max, got "extreme"; ignored',
        'profileEffort: "haiku" is listed twice; the later entry is ignored',
      ])
    })

    test('a list, a bare scalar, or a malformed map ignores the whole key', () => {
      for (const raw of ['[haiku]', 'haiku', '{ haiku }', '{ haiku: high', '{ a: { b: high } }']) {
        const group = parse(`effort: low\nprofileEffort: ${raw}`)
        expect('profileEffort' in group).toBe(false)
        expect(group.effort).toBe('low')
        expect(group.warnings).toHaveLength(1)
        expect(group.warnings[0]).toStartWith('profileEffort: ')
        expect(group.warnings[0]).toEndWith('; ignored')
      }
    })

    test('an unlisted profile warns but is kept; no listed profiles means default', () => {
      const group = parse('profiles: { glm-flash: 3 }\nprofileEffort: { haiku: xhigh }')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh' })
      expect(group.warnings).toEqual([
        'profileEffort: "haiku" is not one of the group\'s profiles; it applies only to members on that profile',
      ])
      const noProfiles = parse('profileEffort: { default: high, haiku: low }')
      expect(noProfiles.profileEffort).toEqual({ default: 'high', haiku: 'low' })
      expect(noProfiles.warnings).toHaveLength(1)
      expect(noProfiles.warnings[0]).toContain('"haiku"')
    })
  })

  test('profiles and onLimit still refuse a repeated map key (only profileEffort allows repeats)', () => {
    expect(parseGroupFile('g', '---\nprofiles: { glm: 2, glm: 1 }\n---\nx')).toEqual({
      ok: false, error: 'profiles: key "glm" is repeated',
    })
    const parsed = parseGroupFile('g', '---\nonLimit: { otherwise: forward, otherwise: release }\n---\nx')
    expect(parsed.ok && parsed.group.warnings).toEqual(['onLimit: key "otherwise" is repeated; using defaults'])
    expect(parsed.ok && parsed.group.onLimit.otherwise).toBe('forward')
  })

  test('parseDuration', () => {
    expect(parseDuration('90m')).toBe(5_400_000)
    expect(parseDuration('3h')).toBe(10_800_000)
    for (const bad of ['0h', '1d', 'h', '1.5h', 'soon']) expect(parseDuration(bad)).toBeNull()
  })

  describe('workers and modelEffort (D12)', () => {
    const parse = (frontmatter: string) => parseGroupFile('juniors', `---\n${frontmatter}\n---\nJunior.`)

    test('the workers map parses like profiles: caps in preference order, max from their sum', () => {
      const group = parse('workers: { glm-flash: 3, haiku: 2 }')
      if (!group.ok) throw new Error(group.error)
      expect(group.group.profiles).toEqual([
        { profileId: 'glm-flash', cap: 3 }, { profileId: 'haiku', cap: 2 },
      ])
      expect(group.group.max).toBe(5)
      expect(group.group.warnings).toEqual([])
    })

    test('the workers list parses like the profiles list', () => {
      const group = parse('workers: [haiku]')
      if (!group.ok) throw new Error(group.error)
      expect(group.group.profiles).toEqual([{ profileId: 'haiku' }])
      expect(group.group.max).toBe(1)
    })

    test('old and new keys together: workers wins with one warning per ignored key', () => {
      const group = parse('workers: [haiku]\nprofiles: [glm-flash]')
      if (!group.ok) throw new Error(group.error)
      expect(group.group.profiles).toEqual([{ profileId: 'haiku' }])
      expect(group.group.warnings).toEqual(['profiles is ignored; workers is set'])
      const withProfile = parse('workers: [haiku]\nprofile: glm\nprofiles: [glm-flash]')
      if (!withProfile.ok) throw new Error(withProfile.error)
      expect(withProfile.group.profiles).toEqual([{ profileId: 'haiku' }])
      expect(withProfile.group.warnings).toEqual([
        'profile is ignored; workers is set', 'profiles is ignored; workers is set',
      ])
    })

    test('the new names have the same effect as the old ones', () => {
      const old = parse('profile: haiku\neffort: low\nprofileEffort: { haiku: xhigh }')
      const newKeys = parse('workers: [haiku]\neffort: low\nmodelEffort: { haiku: xhigh }')
      for (const parsed of [old, newKeys]) {
        if (!parsed.ok) throw new Error(parsed.error)
        expect(parsed.group.profiles).toEqual([{ profileId: 'haiku' }])
        expect(parsed.group.effort).toBe('low')
        expect(parsed.group.profileEffort).toEqual({ haiku: 'xhigh' })
      }
    })

    test('both spellings of the effort key: modelEffort applies and names the ignored old key', () => {
      const group = parse('workers: [haiku]\nmodelEffort: { haiku: xhigh }\nprofileEffort: { haiku: high }')
      if (!group.ok) throw new Error(group.error)
      expect(group.group.profileEffort).toEqual({ haiku: 'xhigh' })
      expect(group.group.warnings).toEqual(['profileEffort is ignored; modelEffort is set'])
    })

    test('a qualified key parses under the new keys and waits for groupCatalog', () => {
      const group = parse('workers: [zai/glm, claude/haiku]\nmodelEffort: { claude/haiku: xhigh }')
      if (!group.ok) throw new Error(group.error)
      expect(group.group.profiles.map(entry => entry.profileId)).toEqual(['zai/glm', 'claude/haiku'])
      expect(group.group.profileEffort).toEqual({ 'claude/haiku': 'xhigh' })
      expect(group.group.warnings).toEqual([])
    })

    test('the old keys keep their grammar: a qualified name still rejects or drops as today', () => {
      // Under `profiles` the qualified name rejects the file (not a valid id).
      expect(parseGroupFile('g', '---\nprofiles: [zai/glm]\n---\nx')).toEqual({
        ok: false, error: 'profiles: "zai/glm" is not a valid profile id',
      })
      // Under `profileEffort` the whole key drops with a warning (strict flow).
      const parsed = parseGroupFile('g', '---\nprofileEffort: { zai/glm: high }\n---\nx')
      expect(parsed.ok && 'profileEffort' in parsed.group).toBe(false)
      expect(parsed.ok && parsed.group.warnings[0]).toStartWith('profileEffort: ')
    })

    test("the routing README's group-settings example parses through the real parser", () => {
      const readme = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/routing/README.md'), 'utf8')
      const block = /## Group settings[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)?.[1]
      expect(block).toBeTruthy()
      // The example's trailing comments are prose; the file format takes the
      // bare values, so the test strips them the way an owner would.
      const frontmatter = block!.split(/\r?\n/).map(line => line.replace(/\s+#.*$/, '')).join('\n')
      const parsed = parseGroupFile('readme', `${frontmatter}\nBuild.`)
      if (!parsed.ok) throw new Error(parsed.error)
      // The example keeps the old keys beside the new ones (the switch-over
      // advice), so the parse names each ignored old key.
      expect(parsed.group.profiles.map(entry => entry.profileId)).toEqual(['zai/glm', 'mimo'])
      expect(parsed.group.max).toBe(3)
      expect(parsed.group.profileEffort).toEqual({ 'claude/haiku': 'xhigh' })
      expect(parsed.group.warnings).toEqual([
        'profiles is ignored; workers is set', 'profileEffort is ignored; modelEffort is set',
      ])
    })
  })
})

describe('canManageMailbox', () => {
  const parse = (value?: string) => parseGroupFile('lead', `---\n${value === undefined ? '' : `canManageMailbox: ${value}\n`}---\nLead.`)

  test('true, false, and absent', () => {
    for (const [value, expected] of [['true', true], ['false', false], [undefined, false]] as const) {
      const parsed = parse(value)
      expect(parsed.ok && parsed.group).toMatchObject({ canManageMailbox: expected, warnings: [] })
    }
  })

  test('an invalid value is a warning that keeps the group and the right off', () => {
    const parsed = parse('maybe')
    expect(parsed.ok && parsed.group).toMatchObject({ canManageMailbox: false, prompt: 'Lead.' })
    expect(parsed.ok && parsed.group.warnings).toEqual(['canManageMailbox must be true or false, got "maybe"; ignored'])
  })
})
