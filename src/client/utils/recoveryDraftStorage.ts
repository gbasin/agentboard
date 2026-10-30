/** Per-terminal durable drafts. Storage events refresh; they never write back. */
export const MAX_RECOVERY_TEXT = 64 * 1024
export const MAX_RECOVERY_DRAFTS = 128
export const RECOVERY_DRAFT_PREFIX = 'agentboard:recovery-draft:v1:'
export interface RecoveryText { text: string; truncated: boolean }
interface StoredDraft extends RecoveryText { version: 1; revision: string; parentRevision: string | null }
export type DraftPersistence = 'saved' | 'memory' | 'conflict' | 'remove-failed' | 'sent-remove-failed'
export interface DraftSnapshot {
  drafts: Record<string, StoredDraft>
  overflow: boolean
  failures: Record<string, Exclude<DraftPersistence, 'saved'>>
}
type StorageAccess = () => Storage
const storageAccess: StorageAccess = () => globalThis.localStorage

function revision(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` }
function key(identity: string): string { return RECOVERY_DRAFT_PREFIX + identity }
function decode(raw: string | null): StoredDraft | null {
  if (!raw || raw.length > MAX_RECOVERY_TEXT * 6 + 1024) return null
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || typeof value.revision !== 'string' || value.revision.length > 100 ||
      !(value.parentRevision === null || (typeof value.parentRevision === 'string' && value.parentRevision.length <= 100)) ||
      typeof value.text !== 'string' || value.text.length > MAX_RECOVERY_TEXT || typeof value.truncated !== 'boolean') return null
    // Persisted text is untrusted; never restore terminal control commands.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value.text)) return null
    return value
  } catch { return null }
}
function bound(text: string, limit: number): string {
  const value = text.slice(0, Math.max(0, limit))
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value
}

export class RecoveryDraftStorage {
  private fallback = new Map<string, StoredDraft>()
  private failures = new Map<string, Exclude<DraftPersistence, 'saved'>>()
  private lastWritten = new Map<string, StoredDraft>()
  private lastRead: Record<string, StoredDraft> = {}
  private overflow = false
  private preferred: string | null = null
  select(identity: string | null): DraftSnapshot { this.preferred = identity; return this.read() }
  constructor(private readonly access: StorageAccess = storageAccess) {}

  read(): DraftSnapshot {
    let drafts: Record<string, StoredDraft>
    try {
      const storage = this.access()
      drafts = Object.create(null)
      this.overflow = false
      let retainedLength = 0
      let retainedCount = 0
      const add = (identity: string, value: StoredDraft | null) => {
        if (identity.length > 4096 || !value) return
        if (retainedCount >= MAX_RECOVERY_DRAFTS || retainedLength + value.text.length > MAX_RECOVERY_TEXT) {
          this.overflow = true
          return // Leave excess durable records untouched until explicit discard.
        }
        drafts[identity] = value
        retainedLength += value.text.length
        retainedCount++
      }
      if (this.preferred) add(this.preferred, decode(storage.getItem(key(this.preferred))))
      for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index)
        if (!name?.startsWith(RECOVERY_DRAFT_PREFIX)) continue
        const identity = name.slice(RECOVERY_DRAFT_PREFIX.length)
        if (identity !== this.preferred) add(identity, decode(storage.getItem(name)))
      }
      this.lastRead = drafts
      for (const [identity, failure] of this.failures) {
        if (failure === 'memory' && !this.fallback.has(identity)) this.failures.delete(identity)
      }
    } catch {
      drafts = this.lastRead
      for (const identity of Object.keys(drafts)) if (!this.failures.has(identity)) this.failures.set(identity, 'memory')
    }
    return { drafts: { ...drafts, ...Object.fromEntries(this.fallback) }, failures: Object.fromEntries(this.failures), overflow: this.overflow }
  }

  /** Preserve conflicting local text; never restore a stale whole-store snapshot. */
  storageChanged(name: string | null, newValue: string | null): DraftSnapshot {
    if (name?.startsWith(RECOVERY_DRAFT_PREFIX)) {
      const identity = name.slice(RECOVERY_DRAFT_PREFIX.length)
      const own = this.lastWritten.get(identity)
      const incoming = decode(newValue)
      // Events may arrive after this tab has written a newer revision. Only
      // the currently durable revision can conflict with our local write.
      try { if (this.access().getItem(name) !== newValue) return this.read() } catch { return this.read() }
      if (own && incoming && incoming.revision !== own.revision && incoming.parentRevision !== own.revision) {
        this.fallback.set(identity, own)
        this.failures.set(identity, 'conflict')
      }
      this.lastWritten.delete(identity)
    } else if (name === null) this.lastWritten.clear()
    return this.read()
  }

  update(identity: string, transform: (text: string) => string, expectedRevision: string | null,
    reviewed = false, replace = false): DraftSnapshot {
    const snapshot = this.read()
    const current = snapshot.drafts[identity]
    const proposed = transform(current?.text ?? '')
    const others = Object.entries(snapshot.drafts).filter(([id]) => id !== identity)
    const room = snapshot.overflow ? current?.text.length ?? 0 : others.length >= MAX_RECOVERY_DRAFTS ? 0 : MAX_RECOVERY_TEXT - others.reduce((sum, [, value]) => sum + value.text.length, 0)
    const text = bound(proposed, room)
    const baseRevision = this.fallback.has(identity) ? current?.parentRevision ?? null : current?.revision ?? null
    const value: StoredDraft = { version: 1, revision: revision(), parentRevision: baseRevision,
      text, truncated: text !== proposed || (!reviewed && !!current?.truncated) }
    // Text transforms always consume the current durable value. Whole-editor
    // replacements require the revision the user actually reviewed.
    const conflict = reviewed && (current?.revision ?? null) !== expectedRevision
    if (!replace && (conflict || this.failures.get(identity) === 'conflict')) {
      // Keep the user's replacement, not a silently merged editor value.
      this.fallback.set(identity, value)
      this.failures.set(identity, 'conflict')
      return this.read()
    }
    try {
      const storage = this.access()
      const latest = decode(storage.getItem(key(identity)))
      if (!replace && (latest?.revision ?? null) !== baseRevision) {
        this.fallback.set(identity, value)
        this.failures.set(identity, 'conflict')
        return this.read()
      }
      if (others.length >= MAX_RECOVERY_DRAFTS && !current) throw new Error('Draft capacity reached')
      value.parentRevision = latest?.revision ?? null
      if (!text && !value.truncated) storage.removeItem(key(identity))
      else storage.setItem(key(identity), JSON.stringify(value))
      this.fallback.delete(identity)
      this.failures.delete(identity)
      if (text || value.truncated) this.lastWritten.set(identity, value)
      else this.lastWritten.delete(identity)
    } catch {
      this.fallback.set(identity, value)
      this.failures.set(identity, 'memory')
    }
    return this.read()
  }

  remove(identity: string, expectedRevision: string | null, sent = false): DraftSnapshot {
    const snapshot = this.read()
    const current = snapshot.drafts[identity]
    if (!current) return snapshot
    try {
      const storage = this.access()
      const saved = decode(storage.getItem(key(identity)))
      const expectedSaved = this.fallback.has(identity) ? current.parentRevision : expectedRevision
      if (this.failures.get(identity) !== 'conflict' && (saved?.revision ?? null) !== expectedSaved) {
        if (sent || snapshot.failures[identity] === 'sent-remove-failed') {
          // The reviewed version was sent. Keep a distinct newer durable draft,
          // never retain the sent fallback as another sendable draft.
          this.fallback.delete(identity)
          this.failures.delete(identity)
          this.lastWritten.delete(identity)
          return this.read()
        }
        this.failures.set(identity, 'conflict')
        return this.read()
      }
      // A local conflicting version is distinct from another tab's saved draft.
      if (this.failures.get(identity) !== 'conflict') storage.removeItem(key(identity))
      this.fallback.delete(identity)
      this.failures.delete(identity)
      this.lastWritten.delete(identity)
    } catch {
      this.fallback.set(identity, { ...current, parentRevision: this.fallback.has(identity) ? current.parentRevision : current.revision })
      this.failures.set(identity, sent || snapshot.failures[identity] === 'sent-remove-failed' ? 'sent-remove-failed' : 'remove-failed')
    }
    return this.read()
  }

  removeOthers(identity: string | null): DraftSnapshot {
    // Explicitly requested deletion also reaches records beyond the display cap.
    const snapshot = this.read()
    try {
      const storage = this.access()
      const keys: string[] = []
      for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index)
        if (name?.startsWith(RECOVERY_DRAFT_PREFIX) && name !== key(identity ?? '')) keys.push(name)
      }
      for (const name of keys) {
        storage.removeItem(name)
        this.lastWritten.delete(name.slice(RECOVERY_DRAFT_PREFIX.length))
      }
      for (const id of this.fallback.keys()) if (id !== identity) { this.fallback.delete(id); this.failures.delete(id); this.lastWritten.delete(id) }
    } catch {
      for (const [id, draft] of Object.entries(snapshot.drafts)) if (id !== identity) this.remove(id, draft.revision)
    }
    return this.read()
  }
}
