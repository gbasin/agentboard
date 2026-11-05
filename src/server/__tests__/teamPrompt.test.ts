import { describe, expect, test } from 'bun:test'
import type { OutboundPromptFacts } from '../outbound/destinations'
import type { GroupDefinition } from '../team/groupFile'
import { buildTeamPrompt, SECURITY_NOTE_BODY, TASK_JOURNAL_GUIDANCE } from '../team/teamPrompt'

/** Empty outbound configuration: nothing configured beyond the defaults. */
const outbound: OutboundPromptFacts = { internal: [], modelProviders: [] }

const settings: Omit<GroupDefinition, 'id' | 'label' | 'description' | 'prompt'> = {
  canCreateTasks: false, canCreatePlans: false, canManageMailbox: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, canReportProcess: false,
  max: 1, approval: 'manual', profiles: [], strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: 3 * 3_600_000, otherwise: 'forward' }, warnings: [],
}
const qa: GroupDefinition = { id: 'qa', label: 'QA', description: 'Tests releases', ...settings, prompt: 'You test everything.' }
const devs: GroupDefinition = { id: 'devs', label: 'devs', description: '', ...settings, prompt: 'You build.' }

describe('buildTeamPrompt', () => {
  test('a member gets its role body, its group, and every team group with descriptions', () => {
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-1', group: qa, groups: [devs, qa] })
    expect(prompt.startsWith('# Your role: QA\n\nYou test everything.')).toBe(true)
    expect(prompt).toContain('a member of the `qa` group (QA)')
    expect(prompt).toContain('- `devs` (devs)\n- `qa` (QA): Tests releases')
    expect(prompt).toContain('`mcp__kawai-team__send_message`')
    expect(prompt).toContain('`<kawai-message>`')
    expect(prompt).toContain('urgent message sent directly to you')
  })

  test('a session without a group gets the mailbox and task notes, no role', () => {
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-2', groups: [devs] })
    expect(prompt.startsWith('# Team mailbox')).toBe(true)
    expect(prompt).not.toContain('# Your role')
    expect(prompt).toContain('You belong to no group')
  })

  test('a team without groups says so, and an empty role body adds no role section', () => {
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-3', group: { ...devs, prompt: '' }, groups: [] })
    expect(prompt).not.toContain('# Your role')
    expect(prompt).toContain('(this team defines no groups yet)')
  })

  test('a permitted creator is told it owns the direction of tasks it creates', () => {
    const lead: GroupDefinition = { ...qa, id: 'leads', canCreateTasks: true }
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-4', group: lead, groups: [lead] })
    expect(prompt).toContain('# Team tasks')
    expect(prompt).toContain('Your group may create tasks: `mcp__kawai-team__task_create`')
    expect(prompt).toContain('own its direction')
    expect(prompt).not.toContain('You cannot create tasks')
  })

  test('a member and a session without a group both learn the human is reply-only', () => {
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-7', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-8', groups: [devs] }),
    ]) {
      expect(prompt).toContain('New mail to them is refused: only a reply to a message they sent reaches them.')
      expect(prompt).toContain('A message tagged `context-exhausted` reports that a session you dispatched work to stopped')
      expect(prompt).toContain('Mail and retries to a flagged session are refused, and kawai never compacts it.')
    }
  })

  // @covers: team-tasks › Agents are told task_get is bounded › Prompt names the paging
  test('ordinary contributors and group-less sessions get the tools, journal role, and change authority but no creation right', () => {
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-5', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-6', groups: [devs] }),
    ]) {
      expect(prompt).toContain('You cannot create tasks')
      for (const name of ['task_get', 'task_journal_read', 'task_list', 'task_note', 'task_update_status', 'task_amend', 'task_acknowledge']) {
        expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      }
      // bounded-log-reads-and-task-get D7: task_get is bounded, names its paging, and promises no full journal.
      expect(prompt).toContain('the journal, subtasks, and messages as bounded windows of the newest entries with their totals, each journal entry a byte-bounded preview')
      expect(prompt).toContain('Page older entries with `journal_before` (the returned `nextBefore`) and `journal_limit` (1–200).')
      expect(prompt).toContain('`mcp__kawai-team__task_journal_read`: read any journal entry whole, in byte chunks from `offset_bytes`')
      expect(prompt).not.toMatch(/whole journal|full journal/)
      expect(prompt).toContain(TASK_JOURNAL_GUIDANCE)
      expect(prompt).toContain('add a journal note or message the creator')
      expect(prompt).toContain("that change's proposal, design, and tasks are the authoritative direction")
      expect(prompt).toContain('`done` or `cancelled` (the creator only)')
      // task-revision-publication 4.4: when to acknowledge, and task_amend's new options.
      expect(prompt).toContain('or receive a revision notice (mail tagged `task-revision`), call `mcp__kawai-team__task_acknowledge` with the revision in the task header')
      expect(prompt).toContain('Delivery is not acknowledgement')
      expect(prompt).toContain('optional `rationale` saying why; `notify: true` also sends the assignment\'s claimed agent a revision notice')
    }
  })

  // @covers: team-tasks › Agents are told task_list is compact and paged › Prompt names the default and the paging
  test('every agent is told task_list is compact, open by default, and paged (bounded-task-list D4)', () => {
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-7', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-8', groups: [devs] }),
    ]) {
      const line = prompt.split('\n').find(entry => entry.startsWith('- `mcp__kawai-team__task_list`'))!
      expect(line).toContain('compact rows, newest first')
      expect(line).toContain('read a task\'s direction with `mcp__kawai-team__task_get`')
      expect(line).toContain('Without `status` it lists only open, active, and blocked tasks')
      expect(line).toContain('`status: "all"`')
      expect(line).toContain('`limit` rows (1–200, default 50)')
      expect(line).toContain('page older with `before` (the returned `bounds.nextBefore`)')
      expect(line).not.toContain('optionally by status')
    }
  })

  // @covers: team-tasks › Agents without the journal reader are told to stop › Prompt tells every agent how to read without the reader
  test('every agent, whatever its rights, is told the journal is bounded and to stop without the reader rather than bypass it', () => {
    const creator: GroupDefinition = { ...devs, id: 'leads', canCreateTasks: true, canManageMailbox: true }
    const noRelease: GroupDefinition = { ...devs, id: 'quiet', canReleaseMembers: false }
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-9', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-10', groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-11', group: creator, groups: [creator] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-12', group: noRelease, groups: [noRelease] }),
    ]) {
      // Inside the task note, once.
      const tasks = prompt.slice(prompt.indexOf('# Team tasks'), prompt.indexOf('# Product strategy'))
      expect(prompt.split(TASK_JOURNAL_GUIDANCE)).toHaveLength(2)
      expect(tasks).toContain('`task_get` is bounded on every call, whatever a tool description says.')
      expect(tasks).toContain('check its bounds: `bounds.journal.olderRemaining` and `nextBefore` for older entries, and each preview\'s `cut`, `resumeOffsetBytes`, and null `text` for omitted bytes.')
      expect(tasks).toContain('If `mcp__kawai-team__task_journal_read` is not among your tools (a Codex thread started before it existed keeps its original tools)')
      expect(tasks).toContain('stop before any conclusion that needs omitted entries or bytes: say so, and ask for the work to continue in a fresh Codex chat.')
      expect(tasks).toContain('Never read the journal around the task tools — through the database, logs, the shell, or files.')
    }
  })
})

describe('buildTeamPrompt strategy note (product-strategy 3.3)', () => {
  const proposer = buildTeamPrompt({ outbound, sessionId: 'chat-7', group: devs, groups: [devs] })
  const groupless = buildTeamPrompt({ outbound, sessionId: 'chat-8', groups: [devs] })

  test('every session is a permitted proposer: the four read/propose tools with its own draft id', () => {
    for (const prompt of [proposer, groupless]) {
      expect(prompt).toContain('# Product strategy')
      for (const name of ['strategy_list', 'strategy_get', 'strategy_save_draft', 'strategy_submit_for_review']) {
        expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      }
      expect(prompt).toContain('read the strategy and propose to it')
      expect(prompt).toContain('material change to purpose, users, or non-goals')
      expect(prompt).toContain('never invent a metric')
    }
    expect(proposer).toContain('defaults to your session id (`chat-7`)')
    expect(groupless).toContain('defaults to your session id (`chat-8`)')
  })

  test('a caller with no product is told the human captures it and work proceeds', () => {
    expect(proposer).toContain('no strategy record yet')
    expect(proposer).toContain('ask the human to capture one')
    expect(proposer).toContain('work proceeds normally without a strategy')
    expect(proposer).toContain('none is created for you')
  })

  test('the note never claims agents can approve', () => {
    for (const prompt of [proposer, groupless]) {
      expect(prompt).toContain('Only the human approves, publishes, or withdraws')
      expect(prompt).toContain('You have no tool that can')
      // Every "approve" mention is the human-only rule, a forgery warning,
      // or "never changes the approved strategy" — never an agent right.
      for (const line of prompt.split('\n')) {
        if (/\bapprove/i.test(line)) expect(line).toMatch(/only the human|human reviews|no tool|grants nothing|never changes/i)
      }
    }
  })

  test('the impact tools, the owner-only decision, and proposals that change nothing (strategy-revision-impact 4.2)', () => {
    for (const prompt of [proposer, groupless]) {
      for (const name of ['strategy_impact_get', 'strategy_impact_propose']) expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      expect(prompt).toContain('Each strategy approval opens an impact review')
      expect(prompt).toContain('Only the human (the owner) decides it')
      expect(prompt).toContain('A proposal changes nothing until the owner records a decision; you have no tool that records one.')
      expect(prompt).toContain("grounded in what changed between the plan's pinned strategy revision and the current one")
      // Every impact "decide"/"decision" mention is the owner's — never an agent right.
      for (const line of prompt.split('\n')) {
        if (/\bdecid|\bdecision/i.test(line) && /impact|proposal/i.test(line)) expect(line).toMatch(/only the human|the owner|no tool/i)
      }
      expect(prompt).not.toMatch(/strategy_impact_(decide|record)/)
    }
  })
})

describe('release_member note', () => {
  test('every permitted group is told about the tool; an opted-out group is not', () => {
    const permitted = buildTeamPrompt({ outbound, sessionId: 'chat-r1', group: qa, groups: [devs, qa] })
    expect(permitted).toContain('`mcp__kawai-team__release_member`')
    expect(permitted).toContain('archived — never killed')
    // Default is permitted (member-release D7): a group without the key hears too.
    const bare = buildTeamPrompt({ outbound, sessionId: 'chat-r2', group: { ...qa, canReleaseMembers: true }, groups: [] })
    expect(bare).toContain('`mcp__kawai-team__release_member`')
    const optedOut = buildTeamPrompt({ outbound, sessionId: 'chat-r3', group: { ...qa, canReleaseMembers: false }, groups: [] })
    expect(optedOut).not.toContain('release_member')
  })
})

describe('buildTeamPrompt mailbox management note (team-mailbox-management D8)', () => {
  const manager: GroupDefinition = { ...qa, id: 'leads', canManageMailbox: true }

  test('every agent learns to list its mail and withdraw its own, and is not offered cancel-any', () => {
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-9', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-10', groups: [devs] }),
    ]) {
      expect(prompt).toContain('`mcp__kawai-team__list_mailbox`')
      expect(prompt).toContain('only mail you sent, mail addressed to you, and mail you hold')
      expect(prompt).toContain('withdraw a message you sent')
      expect(prompt).not.toContain('discard_message')
      expect(prompt).not.toContain('parked work')
      expect(prompt).not.toContain('replacing a stuck agent')
    }
  })

  test('a manager group learns cancel-any, parked work, discard, the human-only retry rule, and the replace advice', () => {
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-11', group: manager, groups: [manager] })
    expect(prompt).toContain("the whole team's")
    expect(prompt).toContain('withdraw any team message')
    expect(prompt).toContain('cancel parked work (its waiting resume mail is cancelled with it')
    expect(prompt).toContain('`mcp__kawai-team__discard_message`')
    expect(prompt).toContain('Retry and hand-off stay with the human')
    expect(prompt).toContain('Before archiving or replacing a stuck agent, list and cancel the mail that would restore or respawn it.')
  })
})

describe('buildTeamPrompt worker choice and capacity (dispatch-worker-choice D9)', () => {
  const choice = 'Choosing a worker: `mcp__kawai-team__send_message` and `mcp__kawai-team__schedule_message` (and `mcp__kawai-team__task_handoff` to a group) take an optional `worker` — a provider id, `provider/model`, or a bare model key among the receiving group\'s workers — that limits who may take the mail. It applies to group mail only. A chosen worker that is cooling waits for its cooldown end instead of going elsewhere, and the group\'s caps still apply. Providers that `team_capacity` lists in each other\'s `sharesLoginWith` draw on one quota window.'

  test('every agent, grouped or not, learns team_capacity and the worker choice facts verbatim', () => {
    for (const prompt of [
      buildTeamPrompt({ outbound, sessionId: 'chat-w1', group: devs, groups: [devs] }),
      buildTeamPrompt({ outbound, sessionId: 'chat-w2', groups: [devs] }),
    ]) {
      expect(prompt).toContain('- `mcp__kawai-team__team_capacity`: read your team\'s capacity as routing sees it now — each group\'s workers (model, provider, cap, live members) and each provider\'s usage and cooldown. Usage null means kawai holds no report, not zero use.')
      expect(prompt).toContain(`\n${choice}\n`)
      // The facts sit in the mailbox note, before mail management.
      expect(prompt.indexOf(choice)).toBeGreaterThan(prompt.indexOf('# Team mailbox'))
      expect(prompt.indexOf(choice)).toBeLessThan(prompt.indexOf('Managing mail:'))
    }
  })

  test('the note states no strategy for when to switch providers', () => {
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-w3', group: devs, groups: [devs] })
    const note = prompt.slice(prompt.indexOf('# Team mailbox'), prompt.indexOf('Managing mail:'))
    for (const strategy of [/\bswitch\b/i, /\bprefer\b/i, /\bshould\b/i, /\bwhen (a|the) (provider|worker|limit)/i, /\bbefore\b.*\blimit\b/i]) {
      expect(note).not.toMatch(strategy)
    }
  })
})

describe('buildTeamPrompt plan note (durable-plans 6.2)', () => {
  const creator = buildTeamPrompt({ outbound, sessionId: 'chat-p1', group: { ...devs, canCreatePlans: true }, groups: [devs] })
  const member = buildTeamPrompt({ outbound, sessionId: 'chat-p2', group: devs, groups: [devs] })
  const groupless = buildTeamPrompt({ outbound, sessionId: 'chat-p3', groups: [devs] })

  test('every session learns the plan tools, its draft id, the direction rule, and task links', () => {
    for (const prompt of [creator, member, groupless]) {
      expect(prompt).toContain('# Plans')
      for (const name of ['plan_list', 'plan_get', 'plan_save_draft', 'plan_submit_for_review']) expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      expect(prompt).toContain('drafts and revisions in review are proposals, not direction')
      expect(prompt).toContain('pass `plan_id` and `plan_change` together')
      expect(prompt).not.toMatch(/plan_(approve|withdraw|close|reopen)/)
    }
    expect(creator).toContain('Draft ids default to your session id (`chat-p1`)')
  })

  test('the note teaches decisions and stall alerts and claims no agent overrides, retries, or stops (plan-supervision 6.4)', () => {
    for (const prompt of [creator, member, groupless]) {
      expect(prompt).toContain('ask decisions with `mcp__kawai-team__decision_ask`, not with a question to the human')
      expect(prompt).toContain("decide a card addressed to your group with `mcp__kawai-team__decision_record`, giving a choice")
      expect(prompt).toContain('A reply to an open card\u2019s question is refused and nothing is sent')
      expect(prompt).toContain('Stall alerts come from Kawai')
      expect(prompt).toContain('rather than replying to Kawai')
      expect(prompt).toContain('Only the owner answers a card addressed to the owner, overrides a decision')
      expect(prompt).toContain('No agent can override, retry, or stop')
      expect(prompt).not.toMatch(/(?<!No )agents? (can|may) (override|retry|stop)/i)
      expect(prompt).not.toMatch(/decision_(answer|override|dismiss)|plan_(retry|stop)/)
    }
  })

  test('the note teaches the plan-pause checkpoint rule and claims no pause or resolve right (revision-control D15)', () => {
    for (const prompt of [creator, member, groupless]) {
      expect(prompt).toContain('A `plan-pause` mail asks you to stop at a safe point')
      expect(prompt).toContain('then call `task_checkpoint`')
      expect(prompt).toContain('Kawai pushes the checkpoint; wait for the owner’s decision')
      expect(prompt).toContain('nothing lands until the owner releases it')
      expect(prompt).not.toMatch(/plan_(pause|resolve|hold|release)/)
    }
  })

  test('the creation right follows canCreatePlans', () => {
    expect(creator).toContain('Your group may create plans: `mcp__kawai-team__plan_create`')
    for (const prompt of [member, groupless]) {
      expect(prompt).toContain('You cannot create plans')
      expect(prompt).not.toContain('plan_create')
    }
  })

  test('the note teaches validation without ever claiming an agent decides or approves (plan-validation 9.2)', () => {
    for (const prompt of [creator, member, groupless]) {
      const note = prompt.slice(prompt.indexOf('# Plans'))
      for (const name of ['plan_validate', 'plan_validation_get', 'plan_assess']) expect(note).toContain(`\`mcp__kawai-team__${name}\``)
      expect(note).toContain('never approves it')
      for (const value of ['aligned-with-conditions', 'exploratory', 'insufficient-information']) expect(note).toContain(value)
      expect(note).toContain('ready/start/acceptance')
      expect(note).toContain('Mandatory questions block until the owner answers them')
      expect(note).toContain('agents never decide')
      // No decision, acceptance, or approval tool is ever offered.
      for (const forbidden of ['plan_decide', 'plan_accept', 'plan_authorize', 'plan_approve', 'plan_resolve']) {
        expect(note).not.toContain(`mcp__kawai-team__${forbidden}`)
      }
    }
  })

  test('the note states owner-only approval and never claims an agent can approve', () => {
    for (const prompt of [creator, member, groupless]) {
      expect(prompt).toContain("Only the human — every plan's owner — approves, withdraws, completes, cancels, or reopens a plan")
      const note = prompt.slice(prompt.indexOf('# Plans'))
      for (const line of note.split('\n')) {
        if (/\bapprove/i.test(line)) expect(line).toMatch(/only the human|human reviews|no tool|grants nothing|never changes/i)
      }
    }
  })
})

describe('buildTeamPrompt security note (execution-safety-recovery D1)', () => {
  const configured: OutboundPromptFacts = {
    internal: ['example.internal', '192.0.2.0/24'],
    modelProviders: ['llm.example.com'],
  }
  const withGroup = buildTeamPrompt({ outbound: configured, sessionId: 'chat-s1', group: devs, groups: [devs] })
  const groupless = buildTeamPrompt({ outbound, sessionId: 'chat-s2', groups: [devs] })

  test('every session ends with the Outbound actions section after the strategy note', () => {
    for (const prompt of [withGroup, groupless]) {
      expect(prompt).toContain('# Outbound actions')
      // The note is the last section and follows the strategy and plan notes.
      expect(prompt.indexOf('# Product strategy')).toBeLessThan(prompt.indexOf('# Outbound actions'))
      expect(prompt.indexOf('# Plans')).toBeLessThan(prompt.indexOf('# Outbound actions'))
      expect(prompt.lastIndexOf('# ')).toBe(prompt.indexOf('# Outbound actions'))
      // The fixed body (contract E1) is carried verbatim.
      expect(prompt).toContain(SECURITY_NOTE_BODY)
      expect(prompt.indexOf(SECURITY_NOTE_BODY)).toBeGreaterThan(0)
      expect(prompt.endsWith(SECURITY_NOTE_BODY)).toBe(false)
    }
  })

  test('configured entries render as written, extra model-provider hosts on a second line', () => {
    expect(withGroup).toContain('Internal destinations the owner configured: example.internal, 192.0.2.0/24.')
    expect(withGroup).toContain('Extra model-provider hosts: llm.example.com.')
    expect(withGroup.indexOf('Internal destinations')).toBeLessThan(withGroup.indexOf('Extra model-provider hosts'))
  })

  test('an empty configuration renders the none-beyond-loopback line and no second line', () => {
    expect(groupless).toContain(
      'Internal destinations the owner configured: none beyond loopback and private network addresses.'
    )
    expect(groupless).not.toContain('Extra model-provider hosts')
  })

  test('internal entries without extra hosts render the none line beside them', () => {
    const prompt = buildTeamPrompt({
      outbound: { internal: ['build.example.internal'], modelProviders: [] },
      sessionId: 'chat-s3',
      groups: [devs],
    })
    expect(prompt).toContain('Internal destinations the owner configured: build.example.internal.')
    expect(prompt).not.toContain('none beyond loopback')
    expect(prompt).not.toContain('Extra model-provider hosts')
  })
})
