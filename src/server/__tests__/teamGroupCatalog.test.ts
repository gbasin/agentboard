// @reads: .kawai/groups, .kawai/groups/**
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { groupCatalogStamp, loadGroupCatalog } from '../team/groupCatalog'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS, type GroupEffort } from '../team/groupFile'

describe('loadGroupCatalog', () => {
  let root: string
  let home: string
  let repo: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-'))
    home = path.join(root, 'home')
    repo = path.join(root, 'repo')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (base: string, name: string, content: string) => {
    const dir = path.join(base, '.kawai', 'groups')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }

  test('discovers project groups in id order and ignores non-markdown files', () => {
    write(repo, 'devs.md', 'Build.')
    write(repo, 'architects.md', '---\nlabel: Architects\n---\nDesign.')
    write(repo, 'notes.txt', 'not a group')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['architects', 'devs'])
    expect(catalog.groups.get('architects')?.group.label).toBe('Architects')
    expect(catalog.errors).toEqual([])
  })

  test('user-level groups are available when the project does not define them', () => {
    write(home, 'qa.md', 'Test.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('qa')?.group.prompt).toBe('Test.')
  })

  test('a project file replaces the user-level file with the same id', () => {
    write(home, 'devs.md', '---\ndescription: home devs\n---\nHome prompt.')
    write(repo, 'devs.md', 'Project prompt.')
    const devs = loadGroupCatalog({ groupsRoot: repo, homeDir: home }).groups.get('devs')?.group
    expect(devs).toEqual({
      id: 'devs', label: 'devs', description: '', canCreateTasks: false, canCreatePlans: false, canManageMailbox: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, canReportProcess: false, max: 1, prompt: 'Project prompt.',
      profiles: [], strategy: 'first-available', warnings: [],
      onLimit: { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' },
    })
  })

  test('project task settings replace user-level settings wholesale, never merge', () => {
    write(home, 'leads.md', '---\ncanCreateTasks: true\nmax: 4\nprofile: glm\napproval: auto\n---\nHome.')
    write(repo, 'leads.md', '---\nmax: 2\n---\nProject.')
    const leads = loadGroupCatalog({ groupsRoot: repo, homeDir: home }).groups.get('leads')?.group
    expect(leads).toMatchObject({ canCreateTasks: false, max: 2, prompt: 'Project.' })
    // The user-level `approval: auto` does not leak through: the project file sets no key.
    expect(leads?.approval).toBeUndefined()
    expect(leads?.profiles).toEqual([])
  })

  test('a malformed task setting skips the project file and keeps the user-level group', () => {
    write(home, 'leads.md', '---\ncanCreateTasks: true\n---\nHome.')
    write(repo, 'leads.md', '---\nmax: lots\n---\nProject.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('leads')?.group).toMatchObject({ canCreateTasks: true, prompt: 'Home.' })
    expect(catalog.errors.some(error => error.includes('leads.md') && error.includes('max must be'))).toBe(true)
  })

  test('invalid ids and malformed files are reported with their path and skipped', () => {
    write(repo, 'Team Lead.md', 'Lead.')
    write(repo, 'broken.md', '---\nlabel: Broken\n')
    write(repo, 'devs.md', 'Build.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['devs'])
    expect(catalog.errors).toHaveLength(2)
    expect(catalog.errors.some(e => e.includes(path.join(repo, '.kawai', 'groups', 'Team Lead.md')))).toBe(true)
    expect(catalog.errors.some(e => e.includes('broken.md') && e.includes('not closed'))).toBe(true)
  })

  test('no groups directories at all is an empty, error-free catalog', () => {
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups).toEqual(new Map())
    expect(catalog.errors).toEqual([])
    expect(catalog.warnings).toEqual([])
  })

  test('a project rooted at home reads its groups directory once', () => {
    write(home, 'devs.md', 'Build.')
    const catalog = loadGroupCatalog({ groupsRoot: home, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['devs'])
  })

  test('an unreadable groups path is reported', () => {
    fs.mkdirSync(path.join(repo, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'groups'), 'a file, not a directory')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.errors).toHaveLength(1)
  })

  test('profile ids the profile catalog does not define are dropped with a warning', () => {
    write(repo, 'devs.md', '---\nprofiles: { glm: 2, nope: 1, default: 1 }\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    const devs = catalog.groups.get('devs')!.group
    expect(devs.profiles).toEqual([{ profileId: 'glm', cap: 2 }, { profileId: 'default', cap: 1 }])
    expect(devs.warnings).toEqual(['profile "nope" is not defined; ignored'])
    expect(catalog.warnings).toEqual([`${path.join(repo, '.kawai', 'groups', 'devs.md')}: profile "nope" is not defined; ignored`])
    expect(catalog.errors).toEqual([])
  })

  test('a project profile catalog makes its profiles known to groups', () => {
    write(repo, 'devs.md', '---\nprofiles: [mine]\n---\nBuild.')
    fs.writeFileSync(path.join(repo, '.kawai', 'profiles.json'), JSON.stringify({ mine: { label: 'Mine' } }))
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('devs')?.group.profiles).toEqual([{ profileId: 'mine' }])
    expect(catalog.warnings).toEqual([])
  })

  test('file fallback warnings are reported with the path', () => {
    write(repo, 'devs.md', '---\nonLimit: { parkIfResetWithin: soon }\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.warnings).toHaveLength(1)
    expect(catalog.warnings[0]).toContain('devs.md: onLimit.parkIfResetWithin "soon"')
  })

  test('an invalid effort is a path-prefixed warning; the group stays available', () => {
    write(repo, 'devs.md', '---\neffort: extreme\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.errors).toEqual([])
    expect(catalog.groups.get('devs')?.group.effort).toBeUndefined()
    expect(catalog.warnings).toEqual([
      `${path.join(repo, '.kawai', 'groups', 'devs.md')}: effort must be low, medium, high, xhigh, max, got "extreme"; ignored`,
    ])
  })

  test('the change stamp moves when a profile catalog file changes', () => {
    write(repo, 'devs.md', 'Build.')
    const before = groupCatalogStamp({ groupsRoot: repo, homeDir: home })
    fs.writeFileSync(path.join(repo, '.kawai', 'profiles.json'), '{}')
    expect(groupCatalogStamp({ groupsRoot: repo, homeDir: home })).not.toBe(before)
  })

  // team-workspace 2.1: the catalog keeps the file each group came from, so
  // Members can name the source of every setting (design D7).
  test('a single-layer group names one source file in effect', () => {
    write(home, 'qa.md', 'Test.')
    write(repo, 'devs.md', 'Build.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('qa')?.sources).toEqual([
      { file: path.join(home, '.kawai', 'groups', 'qa.md'), layer: 'user', inEffect: true },
    ])
    expect(catalog.groups.get('devs')?.sources).toEqual([
      { file: path.join(repo, '.kawai', 'groups', 'devs.md'), layer: 'project', inEffect: true },
    ])
  })

  test('a project file overriding a user file lists both sources, the project one in effect', () => {
    write(home, 'devs.md', 'Home prompt.')
    write(repo, 'devs.md', 'Project prompt.')
    const devs = loadGroupCatalog({ groupsRoot: repo, homeDir: home }).groups.get('devs')
    expect(devs?.file).toBe(path.join(repo, '.kawai', 'groups', 'devs.md'))
    expect(devs?.sources).toEqual([
      { file: path.join(home, '.kawai', 'groups', 'devs.md'), layer: 'user', inEffect: false },
      { file: path.join(repo, '.kawai', 'groups', 'devs.md'), layer: 'project', inEffect: true },
    ])
  })

  test('a skipped file appears only in errors, never as a source', () => {
    write(home, 'leads.md', '---\ncanCreateTasks: true\n---\nHome.')
    write(repo, 'leads.md', '---\nmax: lots\n---\nProject.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    const leads = catalog.groups.get('leads')
    expect(leads?.group.prompt).toBe('Home.')
    expect(leads?.sources.map(source => source.layer)).toEqual(['user'])
    const projectFile = path.join(repo, '.kawai', 'groups', 'leads.md')
    expect(catalog.errors.some(error => error.startsWith(projectFile))).toBe(true)
    expect(leads?.sources.some(source => source.file === projectFile)).toBe(false)
  })
})

describe('tracked change-leads role (change-lead-pilot D2)', () => {
  test('the tracked change-leads file grants task creation and cross-worktree coordination, and denies plan, mailbox-management, and process-report rights', () => {
    // The real tracked file, loaded exactly as CI resolves it: a copy of the
    // tracked group files with an empty temp HOME, so no user-level layer
    // can shadow the asserted rights.
    const trackedGroups = path.resolve(import.meta.dir, '../../../.kawai/groups')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-change-leads-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-cl-home-'))
    try {
      fs.cpSync(trackedGroups, path.join(root, '.kawai', 'groups'), { recursive: true })
      const catalog = loadGroupCatalog({ groupsRoot: root, homeDir: home })
      const changeLeads = catalog.groups.get('change-leads')
      expect(changeLeads?.file).toBe(path.join(root, '.kawai', 'groups', 'change-leads.md'))
      expect(changeLeads?.group.canCreateTasks).toBe(true)
      expect(changeLeads?.group.worktreeScoped).toBe(false)
      expect(changeLeads?.group.canCreatePlans).toBe(false)
      expect(changeLeads?.group.canManageMailbox).toBe(false)
      expect(changeLeads?.group.canReportProcess).toBe(false)
      expect(changeLeads?.group.releaseOnTaskClose).toBe(false)
      expect(changeLeads?.group.canReleaseMembers).toBe(true)
      expect(changeLeads?.group.max).toBe(1)
      expect(catalog.errors).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('tracked groups against the shipped profile catalog', () => {
  test('every profile a tracked group file references is defined by the shipped catalog alone', () => {
    // A fresh clone has no project catalog (the root .kawai/profiles.json is
    // untracked), so the groups are loaded from a copy of the tracked files
    // with an empty temp HOME — exactly CI's resolution.
    const trackedGroups = path.resolve(import.meta.dir, '../../../.kawai/groups')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-shipped-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-home-'))
    try {
      fs.cpSync(trackedGroups, path.join(root, '.kawai', 'groups'), { recursive: true })
      const catalog = loadGroupCatalog({ groupsRoot: root, homeDir: home })
      const unknown = catalog.warnings.filter(warning => warning.includes('is not defined'))
      expect(unknown).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('qualified worker names resolve against the catalog (D5)', () => {
  let root: string
  let home: string
  let repo: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-qualified-'))
    home = path.join(root, 'home')
    repo = path.join(root, 'repo')
    // Both user-level catalog files, so the shipped defaults never leak in.
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), '{}')
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } },
      claude: { label: 'Claude', models: { haiku: {} } },
    }))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const writeGroup = (frontmatter: string) => {
    fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'juniors.md'), `---\n${frontmatter}\n---\nJunior.`)
  }

  test('qualified names resolve to the bare model keys', () => {
    writeGroup('workers: [zai/glm, claude/haiku]')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles.map(entry => entry.profileId)).toEqual(['glm', 'haiku'])
    expect(warnings).toEqual([])
  })

  test('a qualifier naming the wrong provider is reported and ignored', () => {
    writeGroup('workers: [zai/haiku, glm]')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles.map(entry => entry.profileId)).toEqual(['glm'])
    expect(warnings).toEqual([expect.stringContaining('profile "zai/haiku" is not defined; ignored')])
  })

  test('a qualified name resolving to an already-listed key is ignored with a warning', () => {
    writeGroup('workers: [glm, zai/glm]')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles.map(entry => entry.profileId)).toEqual(['glm'])
    expect(warnings).toEqual([expect.stringContaining('"zai/glm" is already listed')])
  })

  test('a qualified modelEffort key resolves; an unknown one is dropped with a warning', () => {
    writeGroup('workers: [glm, haiku]\nmodelEffort: { claude/haiku: xhigh, zai/haiku: high }')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profileEffort).toEqual({ haiku: 'xhigh' })
    expect(warnings).toEqual([expect.stringContaining('modelEffort: "zai/haiku" is not defined; ignored')])
  })

  test('a modelEffort duplicate resolves the same in either order, with a warning (L1)', () => {
    // First occurrence wins in file order, whatever spelling named it; the
    // later entry warns instead of silently overwriting.
    const cases: Array<[string, Record<string, GroupEffort>, string]> = [
      ['---\nworkers: [glm]\nmodelEffort: { zai/glm: high, glm: low }\n---\nJunior.', { glm: 'high' }, 'modelEffort: "glm" is already listed; the later entry is ignored'],
      ['---\nworkers: [glm]\nmodelEffort: { glm: low, zai/glm: high }\n---\nJunior.', { glm: 'low' }, 'modelEffort: "zai/glm" is already listed; the later entry is ignored'],
    ]
    for (const [content, effort, warning] of cases) {
      fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'juniors.md'), content)
      const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
      expect(groups.get('juniors')?.group.profileEffort).toEqual(effort)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(warning)
    }
  })

  test('a bare entry after a qualified one is dropped with the entry named (L2)', () => {
    writeGroup('workers: [zai/glm, glm]')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles.map(entry => entry.profileId)).toEqual(['glm'])
    expect(warnings).toEqual([expect.stringContaining('profile "glm" is already listed; the later entry is ignored')])
  })

  test('a qualified map key keeps its cap (L4)', () => {
    writeGroup('workers: { zai/glm: 2 }')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles).toEqual([{ profileId: 'glm', cap: 2 }])
    expect(groups.get('juniors')?.group.max).toBe(2)
    expect(warnings).toEqual([])
  })

  test('the default max sums the resolved caps, not the dropped written ones, with the warning (N2)', () => {
    writeGroup('workers: { zai/glm: 2, zai/nope: 3 }')
    const { groups, warnings } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles).toEqual([{ profileId: 'glm', cap: 2 }])
    expect(groups.get('juniors')?.group.max).toBe(2)
    expect(warnings).toEqual([expect.stringContaining('profile "zai/nope" is not defined; ignored')])
  })

  test('an explicit max equal to the written cap sum stays (N2)', () => {
    writeGroup('workers: { zai/glm: 2, zai/nope: 3 }\nmax: 5')
    const { groups } = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(groups.get('juniors')?.group.profiles).toEqual([{ profileId: 'glm', cap: 2 }])
    expect(groups.get('juniors')?.group.max).toBe(5)
  })
})
