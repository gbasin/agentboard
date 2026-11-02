// Ephemeral per-process skill discovery (autocomplete D2). Invalidation drops
// both public candidates and private paths immediately. Only the current
// request may publish; a burst coalesces into one latest-context follow-up.
import type { ChatCommandState } from '../../../shared/chat'
import { logger } from '../../logger'
import { codexCommandCatalog, codexSkillInputs, type CodexCommandCatalog } from './codexCommands'
import type { CodexClient } from './codexThread'

export class CodexCommandDiscovery {
  private client: CodexClient | null = null
  private cwd = ''
  private booted = false
  private pending = false
  private forceReload = false
  private identity = {}
  private flight: Promise<void> | null = null
  private catalog: CodexCommandCatalog | null = null
  private state: ChatCommandState = { status: 'unavailable', commands: [] }

  constructor(private readonly publish: (state: ChatCommandState) => void) {}

  snapshot(): ChatCommandState { return this.state }
  inputs(text: string) { return codexSkillInputs(text, this.catalog) }

  start(client: CodexClient, cwd: string): void {
    this.stop()
    this.client = client
    this.cwd = cwd
    this.invalidate(false)
  }

  ready(): void {
    if (!this.client) return
    this.booted = true
    this.scan()
  }

  changeDirectory(cwd: string): void {
    if (cwd === this.cwd) return
    this.cwd = cwd
    this.invalidate(true)
  }

  changed(): void { this.invalidate(true) }

  stop(): void {
    this.client = null
    this.booted = false
    this.pending = false
    this.forceReload = false
    this.flight = null
    this.identity = {}
    this.setState('unavailable')
  }

  private invalidate(forceReload: boolean): void {
    if (!this.client) return
    this.identity = {}
    this.pending = true
    this.forceReload ||= forceReload
    this.setState('loading')
    this.scan()
  }

  private scan(): void {
    if (!this.client || !this.booted || this.flight || !this.pending) return
    const client = this.client
    const cwd = this.cwd
    const identity = this.identity
    const forceReload = this.forceReload
    this.pending = false
    this.forceReload = false
    const current = () => this.client === client && this.cwd === cwd && this.identity === identity
    const flight = Promise.resolve().then(() => client.request('skills/list', { cwds: [cwd], forceReload })).then(response => {
      if (!current()) return
      const catalog = codexCommandCatalog(response, cwd)
      if (!catalog) { this.setState('unavailable'); return }
      if (catalog.loadErrors || catalog.conflicts.length) {
        logger.warn('codex_skill_catalog_partial', { cwd, loadErrors: catalog.loadErrors, conflicts: catalog.conflicts })
      }
      this.setState('ready', catalog)
    }).catch(() => {
      // Discovery is optional; unsupported methods/timeouts never fail a turn.
      if (current()) this.setState('unavailable')
    }).finally(() => {
      if (this.flight !== flight) return
      this.flight = null
      this.scan()
    })
    this.flight = flight
  }

  private setState(status: ChatCommandState['status'], catalog: CodexCommandCatalog | null = null): void {
    this.catalog = catalog
    const next: ChatCommandState = { status, commands: catalog?.commands ?? [] }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.publish(next)
  }
}
