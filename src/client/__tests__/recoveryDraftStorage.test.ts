import { expect, test } from 'bun:test'
import { RecoveryDraftStorage, RECOVERY_DRAFT_PREFIX, MAX_RECOVERY_TEXT, MAX_RECOVERY_DRAFTS } from '../utils/recoveryDraftStorage'
import { recoveryDraftIdentity } from '../utils/recoveryDraftIdentity'
import type { Session } from '@shared/types'

export function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value) },
    removeItem: name => { values.delete(name) }, clear: () => values.clear() }
}
const capture = (store: RecoveryDraftStorage, id: string, text: string) => store.update(id, previous => previous + text, null)

test('durable records survive store recreation and explicit discard removes them', () => {
  const local = memoryStorage()
  const first = new RecoveryDraftStorage(() => local)
  capture(first, 'A', 'remember\nme')
  const second = new RecoveryDraftStorage(() => local)
  const restored = second.read().drafts.A!
  expect(restored.text).toBe('remember\nme')
  second.remove('A', restored.revision)
  expect(new RecoveryDraftStorage(() => local).read().drafts.A).toBeUndefined()
})

test('independent terminal writes and stale editor updates never resurrect a deleted record', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const b = new RecoveryDraftStorage(() => local)
  const original = capture(a, 'A', 'old').drafts.A!
  capture(b, 'B', 'other')
  a.remove('A', original.revision)
  const conflict = b.update('A', () => 'old plus stale edit', original.revision, true)
  expect(conflict.failures.A).toBe('conflict')
  expect(conflict.drafts.A!.text).toBe('old plus stale edit')
  expect(local.getItem(RECOVERY_DRAFT_PREFIX + 'A')).toBeNull()
  expect(new RecoveryDraftStorage(() => local).read().drafts.B!.text).toBe('other')
})

test('captures use latest text; stale whole-editor replacement requires explicit save', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const b = new RecoveryDraftStorage(() => local)
  const original = capture(a, 'A', 'one').drafts.A!
  capture(b, 'A', ' two')
  expect(capture(a, 'A', ' three').drafts.A!.text).toBe('one two three')
  expect(b.update('A', () => 'my replacement', original.revision, true).failures.A).toBe('conflict')
  expect(new RecoveryDraftStorage(() => local).read().drafts.A!.text).toBe('one two three')
  b.update('A', () => 'my replacement', null, false, true)
  expect(new RecoveryDraftStorage(() => local).read().drafts.A!.text).toBe('my replacement')
})

test('delayed storage events cannot mark a newer local write as conflicting', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const b = new RecoveryDraftStorage(() => local)
  capture(a, 'A', 'one')
  capture(b, 'A', ' two')
  const eventValue = local.getItem(RECOVERY_DRAFT_PREFIX + 'A')
  capture(a, 'A', ' three')
  const result = a.storageChanged(RECOVERY_DRAFT_PREFIX + 'A', eventValue)
  expect(result.drafts.A!.text).toBe('one two three')
  expect(result.failures.A).toBeUndefined()
})

test('conflicting simultaneous revision preserves local text without rewriting the winner', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const mine = capture(a, 'A', 'mine').drafts.A!
  const competitor = JSON.stringify({ ...mine, revision: 'competitor', parentRevision: null, text: 'theirs' })
  local.setItem(RECOVERY_DRAFT_PREFIX + 'A', competitor)
  const result = a.storageChanged(RECOVERY_DRAFT_PREFIX + 'A', competitor)
  expect(result.drafts.A!.text).toBe('mine')
  expect(result.failures.A).toBe('conflict')
  expect(local.getItem(RECOVERY_DRAFT_PREFIX + 'A')).toBe(competitor)
})

test('storage failure preserves memory but recovery cannot overwrite a newer saved version', () => {
  const local = memoryStorage()
  let unavailable = false
  const a = new RecoveryDraftStorage(() => { if (unavailable) throw new Error('denied'); return local })
  const b = new RecoveryDraftStorage(() => local)
  capture(a, 'A', 'saved')
  unavailable = true
  expect(capture(a, 'A', ' local').failures.A).toBe('memory')
  capture(b, 'A', ' other')
  unavailable = false
  const result = capture(a, 'A', '!')
  expect(result.failures.A).toBe('conflict')
  expect(result.drafts.A!.text).toBe('saved local!')
  expect(b.read().drafts.A!.text).toBe('saved other')
})

test('failed cleanup after accepted send remains distinct and cannot become unsent on retry failure', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const value = capture(a, 'A', 'sent').drafts.A!
  const remove = local.removeItem
  local.removeItem = () => { throw new Error('quota policy') }
  expect(a.remove('A', value.revision, true).failures.A).toBe('sent-remove-failed')
  expect(a.remove('A', value.revision).failures.A).toBe('sent-remove-failed')
  local.removeItem = remove
  expect(a.remove('A', value.revision).drafts.A).toBeUndefined()
})

test('corrupt/control records are ignored and imported excess stays durable without unbounded restoration', () => {
  const local = memoryStorage()
  local.setItem(RECOVERY_DRAFT_PREFIX + 'bad', '{')
  local.setItem(RECOVERY_DRAFT_PREFIX + 'control', JSON.stringify({ version: 1, revision: 'x', parentRevision: null, text: '\x1b[31m', truncated: false }))
  for (let i = 0; i < MAX_RECOVERY_DRAFTS + 10; i++) local.setItem(RECOVERY_DRAFT_PREFIX + i,
    JSON.stringify({ version: 1, revision: String(i), parentRevision: null, text: 'x'.repeat(1024), truncated: false }))
  const store = new RecoveryDraftStorage(() => local)
  const snapshot = store.select('130')
  expect(snapshot.drafts.bad).toBeUndefined()
  expect(snapshot.drafts.control).toBeUndefined()
  expect(snapshot.drafts['130']!.text).toHaveLength(1024)
  expect(Object.values(snapshot.drafts).reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(MAX_RECOVERY_TEXT)
  expect(Object.keys(snapshot.drafts).length).toBeLessThanOrEqual(MAX_RECOVERY_DRAFTS)
  expect(snapshot.overflow).toBe(true)
  expect(local.length).toBe(MAX_RECOVERY_DRAFTS + 12)
  store.removeOthers('130')
  expect(local.length).toBe(1)
})

test('draft identity follows immutable window incarnation rather than labels or status', () => {
  const session = { id: 'board:@1', tmuxWindow: 'board:@1', createdAt: '2026-10-15T00:00:00Z', host: 'mac',
    agentboardTags: { boardId: 'board', runId: 'run', serverPid: 123 } } as Session
  const identity = recoveryDraftIdentity(session)
  expect(recoveryDraftIdentity({ ...session, name: 'renamed', status: 'waiting' })).toBe(identity)
  expect(recoveryDraftIdentity({ ...session, createdAt: '2026-10-16T00:00:00Z' })).toBe(identity)
  expect(recoveryDraftIdentity({ ...session, agentboardTags: { ...session.agentboardTags!, boardId: '', runId: '' } })).toBe(identity)
  expect(recoveryDraftIdentity({ ...session, agentboardTags: { ...session.agentboardTags!, serverPid: 124 } })).not.toBe(identity)
})


test('accepted send of a stale reviewed version leaves only the distinct newer draft', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const b = new RecoveryDraftStorage(() => local)
  const old = capture(a, 'A', 'reviewed and sent').drafts.A!
  b.update('A', () => 'newer version', old.revision, true)
  const result = a.remove('A', old.revision, true)
  expect(result.drafts.A!.text).toBe('newer version')
  expect(result.failures.A).toBeUndefined()
  expect(new RecoveryDraftStorage(() => local).read().drafts.A!.text).toBe('newer version')
})

test('discard others clears local writer ancestry and cannot restore it on a later event', () => {
  const local = memoryStorage()
  const a = new RecoveryDraftStorage(() => local)
  const first = capture(a, 'A', 'discarded').drafts.A!
  a.removeOthers('B')
  const fresh = JSON.stringify({ ...first, revision: 'fresh', text: 'fresh user text' })
  local.setItem(RECOVERY_DRAFT_PREFIX + 'A', fresh)
  const result = a.storageChanged(RECOVERY_DRAFT_PREFIX + 'A', fresh)
  expect(result.drafts.A!.text).toBe('fresh user text')
  expect(result.failures.A).toBeUndefined()
})


test('storage record suffixes cannot alter the restored draft map prototype', () => {
  const local = memoryStorage()
  local.setItem(RECOVERY_DRAFT_PREFIX + '__proto__', JSON.stringify({ version: 1, revision: 'safe', parentRevision: null, text: 'plain', truncated: false }))
  const snapshot = new RecoveryDraftStorage(() => local).read()
  expect(Object.getPrototypeOf(snapshot.drafts)).toBe(Object.prototype)
  expect(Object.hasOwn(snapshot.drafts, '__proto__')).toBe(true)
  expect(snapshot.drafts.__proto__.text).toBe('plain')
})


test('retry cleanup after another tab removed a sent copy clears local state without enabling resend', () => {
  const local = memoryStorage()
  const store = new RecoveryDraftStorage(() => local)
  const draft = capture(store, 'A', 'already sent').drafts.A!
  const remove = local.removeItem
  local.removeItem = () => { throw new Error('denied') }
  expect(store.remove('A', draft.revision, true).failures.A).toBe('sent-remove-failed')
  local.removeItem = remove
  local.removeItem(RECOVERY_DRAFT_PREFIX + 'A')
  const cleared = store.remove('A', draft.revision)
  expect(cleared.drafts.A).toBeUndefined()
  expect(cleared.failures.A).toBeUndefined()
})


test('known tmux server identity survives rediscovery timestamps; legacy identity stays conservative', () => {
  const original = { id: 'board:@42', tmuxWindow: 'board:@42', createdAt: '2026-10-24T20:26:00Z',
    agentboardTags: { boardId: '', runId: '', serverPid: 7831 } } as Session
  const rediscovered = { ...original, createdAt: '2026-10-24T20:31:00Z' }
  expect(recoveryDraftIdentity(rediscovered)).toBe(recoveryDraftIdentity(original))
  expect(recoveryDraftIdentity({ ...rediscovered, tmuxWindow: 'board:@43' })).not.toBe(recoveryDraftIdentity(original))
  const legacy = { ...original, agentboardTags: undefined }
  expect(recoveryDraftIdentity({ ...legacy, createdAt: rediscovered.createdAt })).not.toBe(recoveryDraftIdentity(legacy))
  expect(recoveryDraftIdentity({ ...legacy, agentboardTags: { boardId: '', runId: '', serverPid: 0 } })).toBe(recoveryDraftIdentity(legacy))
})
