import {
  syncFeatureEnabled,
  TerminalProxyBase,
  tmuxSupportsClientFeatures,
} from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'
import { resolveGroupedSessionSwitchTarget } from './groupedSessionTarget'
import {
  buildTmuxFormat,
  splitTmuxFields,
  withTmuxUtf8Flag,
} from '../tmuxFormat'
import { sanitizedTmuxEnv } from '../tmuxEnv'

const CLIENT_TTY_FORMAT = buildTmuxFormat([
  '#{client_tty}',
  '#{client_pid}',
])
const TARGET_IDENTITY_FORMAT = buildTmuxFormat([
  '#{session_name}',
  '#{window_id}',
])
const CLIENT_IDENTITY_FORMAT = buildTmuxFormat([
  '#{client_tty}',
  '#{session_name}',
  '#{window_id}',
])

// `set-clipboard` is a server-global tmux option, so enabling it touches the
// user's whole tmux server (and isn't reverted on disconnect). It's on by
// default because the clipboard poll needs a paste buffer to read; set
// AGENTBOARD_TMUX_SET_CLIPBOARD=0 (or =false) to leave the user's setting alone.
const SET_CLIPBOARD_ENABLED =
  process.env.AGENTBOARD_TMUX_SET_CLIPBOARD !== '0' &&
  process.env.AGENTBOARD_TMUX_SET_CLIPBOARD !== 'false'


interface TmuxTargetIdentity {
  sessionName: string
  windowId: string | null
}

class PtyTerminalProxy extends TerminalProxyBase {
  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()
  private cols = 80
  private rows = 24
  private clientTty: string | null = null
  private startAttemptId = 0
  // Set once dispose() runs. Distinct from state === DEAD (which a natural
  // pty death also sets): an in-flight attach that lost the race with a
  // WebSocket close could otherwise resurrect the proxy via switchTo() →
  // start(), recreating the ws session and derived sessions with nobody
  // left to dispose them.
  private disposed = false
  // Grouped sessions created for externally-discovered tmux sessions, keyed
  // by grouped session name. Joining an external session directly would share
  // its current-window pointer with the user's own attached clients, so every
  // switch in the browser would also flip the user's terminal (and vice
  // versa). A per-connection grouped session shares the windows but keeps an
  // independent focus.
  private externalGroupedSessions = new Map<string, string>()
  // Session the client was last switched into (grouped ws session or derived
  // external group). Paste targets its active window so it follows manual
  // in-terminal window switches, which currentWindow (last programmatic
  // switch) does not.
  private lastEffectiveSession: string | null = null

  getMode(): 'pty' {
    return 'pty'
  }

  getClientTty(): string | null {
    return this.clientTty
  }

  ensureEffectiveTarget(target: string): string {
    const resolved = resolveGroupedSessionSwitchTarget(
      target,
      this.options.baseSession,
      this.options.sessionName
    )
    if (resolved !== target) {
      return resolved
    }
    // A disposed proxy must not create tmux sessions: an in-flight attach
    // that lost the race with a WebSocket close would otherwise leak a
    // derived session with nobody left to clean it up. The disposed flag
    // (unlike state, which start() resets) also covers the resurrection path.
    if (this.disposed || this.state === TerminalState.DEAD) {
      return target
    }
    const external = this.resolveExternalGroupedTarget(target)
    if (external === target) {
      return target
    }
    // Callers (scrollback capture, dedup keys, the switch itself) all expect
    // the effective target to be addressable, so the grouped session is
    // created here. Idempotent: guarded by externalGroupedSessions.
    try {
      this.ensureExternalGroupedSession(target, external)
      return external
    } catch (error) {
      this.logEvent('terminal_external_group_failed', {
        sessionName: this.options.sessionName,
        target,
        error: error instanceof Error ? error.message : String(error),
      })
      return target
    }
  }

  private externalGroupedPrefix(): string {
    return `${this.options.sessionName}-x-`
  }

  private resolveExternalGroupedTarget(target: string): string {
    const colonIndex = target.indexOf(':')
    const rawSession = colonIndex > 0 ? target.slice(0, colonIndex) : target
    if (
      !rawSession ||
      rawSession === this.options.baseSession ||
      rawSession === this.options.sessionName ||
      rawSession.startsWith(this.externalGroupedPrefix())
    ) {
      return target
    }
    const sanitized = rawSession.replace(/[^A-Za-z0-9_-]/g, '-')
    // Sanitizing can collapse distinct raw names onto the same derived name
    // (e.g. "a.b" and "a-b" both become "a-b"); a short hash of the raw name
    // keeps derived names collision-free without widening the tmux target
    // charset the validator accepts.
    const suffix = Bun.hash(rawSession).toString(36).slice(0, 6)
    const derived = `${this.externalGroupedPrefix()}${sanitized}-${suffix}`
    const windowPart = colonIndex > 0 ? target.slice(colonIndex + 1) : ''
    return windowPart ? `${derived}:${windowPart}` : derived
  }

  // True when the derived session contains the requested window — the actual
  // precondition switch-client needs. This is deliberately NOT a session-group
  // comparison: tmux groups are keyed by name, so a stale group with any
  // surviving member (another connection's derived session, or the user's own
  // paired session) makes group names lie after a kill/recreate of the raw
  // session, while the window set cannot.
  private derivedContainsWindow(
    effSession: string,
    windowPart: string
  ): boolean {
    let output = ''
    try {
      output = this.runParsedTmux([
        'list-windows',
        '-t',
        `=${effSession}`,
        '-F',
        '#{window_id}',
      ])
    } catch {
      return false
    }
    return output
      .split('\n')
      .some((line) => line.replace(/\r$/, '').trim() === windowPart)
  }

  // Moves our own tmux client off the given session before it gets killed.
  // With the default detach-on-destroy, killing the session a client sits on
  // exits the attach process, which would take the whole proxy down (DEAD)
  // instead of recovering.
  private evacuateClientFrom(effSession: string): void {
    if (!this.clientTty) return
    try {
      const identity = this.readClientIdentity()
      if (identity.sessionName !== effSession) return
      this.runTmux([
        'switch-client',
        '-c',
        this.clientTty,
        '-t',
        `=${this.options.sessionName}`,
      ])
    } catch {
      // Best-effort; worst case the proxy dies and the client reconnects.
    }
  }

  // True when the derived grouped session and the raw session are members of
  // the same (non-empty) session group. Only used for bare-session targets
  // where there is no window id to check; group names can lie after a
  // kill/recreate of the raw session (see derivedContainsWindow), but bare
  // targets never come from the UI.
  private sessionGroupsMatch(effSession: string, rawSession: string): boolean {
    let output = ''
    try {
      output = this.runParsedTmux([
        'list-sessions',
        '-F',
        buildTmuxFormat(['#{session_name}', '#{session_group}']),
      ])
    } catch {
      return false
    }
    let effGroup: string | null = null
    let rawGroup: string | null = null
    for (const line of output.split('\n')) {
      const parts = splitTmuxFields(line.replace(/\r$/, ''), 2)
      if (!parts) continue
      const [name, group] = parts
      if (name === effSession) effGroup = group ?? ''
      if (name === rawSession) rawGroup = group ?? ''
    }
    return Boolean(effGroup) && effGroup === rawGroup
  }

  // Creates the grouped session backing an external effective target if it
  // does not exist yet. No-op for the base grouped session and raw targets.
  // Idempotent: warm targets short-circuit on externalGroupedSessions; the
  // map entry is evicted when a switch through it fails.
  private ensureExternalGroupedSession(
    target: string,
    effectiveTarget: string
  ): void {
    const colonIndex = effectiveTarget.indexOf(':')
    const effSession =
      colonIndex > 0 ? effectiveTarget.slice(0, colonIndex) : effectiveTarget
    if (!effSession.startsWith(this.externalGroupedPrefix())) {
      return
    }
    if (this.externalGroupedSessions.has(effSession)) {
      return
    }
    const windowPart =
      colonIndex > 0 ? effectiveTarget.slice(colonIndex + 1) : ''
    const rawColon = target.indexOf(':')
    const rawSession = rawColon > 0 ? target.slice(0, rawColon) : target
    let exists = false
    try {
      this.runTmux(['has-session', '-t', `=${effSession}`])
      exists = true
    } catch {
      // Create below
    }
    // Window-id targets get the authoritative membership check; bare-session
    // or name/index-style targets (API-only; the UI always sends @ids) fall
    // back to the group heuristic.
    const windowId = windowPart.startsWith('@') ? windowPart : ''
    if (exists) {
      const valid = windowId
        ? this.derivedContainsWindow(effSession, windowId)
        : this.sessionGroupsMatch(effSession, rawSession)
      if (valid) {
        this.externalGroupedSessions.set(effSession, rawSession)
        return
      }
      // Stale leftover: the raw session was killed (and possibly recreated
      // under the same name) while the derived session survived, so it is
      // bound to the old group's windows. Discard it — after moving our own
      // client off it, or the kill would take the proxy down with it.
      this.evacuateClientFrom(effSession)
      try {
        this.runTmuxMutation(['kill-session', '-t', `=${effSession}`])
      } catch {
        // Ignore; new-session below will surface a real conflict
      }
    }
    // new-session -t with a non-matching name silently starts a fresh,
    // unrelated group named after the literal target instead of failing, so
    // confirm the raw session still exists first. (=name also disables the
    // prefix matching that could otherwise group with the wrong session.)
    this.runTmux(['has-session', '-t', `=${rawSession}`])
    this.runTmuxMutation([
      'new-session',
      '-d',
      '-t',
      `=${rawSession}`,
      '-s',
      effSession,
    ])
    const rejoinedStaleGroup = windowId
      ? !this.derivedContainsWindow(effSession, windowId)
      : !this.sessionGroupsMatch(effSession, rawSession)
    if (rejoinedStaleGroup) {
      // tmux resolves new-session -t group names by NAME, so if a stale
      // same-named group still has surviving members (another connection or
      // the user's own paired session), the recreated derived session joins
      // the stale group instead of the recreated raw session. Do not loop on
      // a session bound to the wrong windows — give up so the caller falls
      // back to attaching the raw session directly (shared focus, but
      // functional).
      try {
        this.runTmuxMutation(['kill-session', '-t', `=${effSession}`])
      } catch {
        // Ignore cleanup failures
      }
      throw new Error(
        `Derived session ${effSession} joined a stale group for ${rawSession}`
      )
    }
    this.externalGroupedSessions.set(effSession, rawSession)
    // Same reasoning as the base grouped session: session options come from
    // the global default, so mirror the raw session's mouse setting.
    try {
      const mouseValue = this.runTmux([
        'show-option',
        '-t',
        `=${rawSession}`,
        '-v',
        'mouse',
      ]).trim()
      if (mouseValue) {
        this.runTmuxMutation([
          'set-option',
          '-t',
          `=${effSession}`,
          'mouse',
          mouseValue,
        ])
      }
    } catch {
      // Raw session may not have an explicit mouse override; ignore
    }
  }

  write(data: string): void {
    this.process?.terminal?.write(this.encoder.encode(data))
  }

  paste(data: string): void {
    if (!data || this.state === TerminalState.DEAD) {
      return
    }
    // Target the active window of the session this client is attached to
    // (grouped ws session or derived external group): it tracks manual
    // in-terminal window switches, unlike currentWindow which only records
    // the last programmatic switch. tmux decides bracketing from that real
    // pane's mode. (Targeting the base grouped session unconditionally
    // pasted into its own current window, which for externally-discovered
    // sessions was the bootstrap window, not the window on screen.) NOTE:
    // the name must stay bare — paste-buffer takes a target-PANE, whose
    // parser rejects the `=name` exact-match form that target-session
    // commands accept (verified on tmux 3.7b: "can't find pane: =name").
    // Exact-name collisions are a non-issue here because tmux prefers an
    // exact session match over a prefix match whenever the session exists,
    // and this name comes from a verified identity read.
    this.deliverPasteViaTmux(
      this.lastEffectiveSession ?? this.options.sessionName,
      data
    )
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    try {
      this.process?.terminal?.resize(cols, rows)
    } catch {
      // Ignore resize errors
    }
  }

  async dispose(): Promise<void> {
    // Invalidate any in-flight start attempt so doStart bails out before
    // mutating state after we've disposed.
    this.startAttemptId += 1
    this.disposed = true
    this.state = TerminalState.DEAD
    this.outputSuppressed = false

    if (this.process) {
      try {
        this.process.kill()
        this.process.terminal?.close()
      } catch {
        // Ignore if already exited
      }
      this.process = null
    }

    try {
      this.runTmuxMutation(['kill-session', '-t', this.options.sessionName])
      this.logEvent('terminal_session_cleanup', {
        sessionName: this.options.sessionName,
      })
    } catch {
      // Ignore cleanup failures
    }

    for (const groupedName of this.externalGroupedSessions.keys()) {
      try {
        this.runTmuxMutation(['kill-session', '-t', `=${groupedName}`])
      } catch {
        // Ignore cleanup failures
      }
    }
    this.externalGroupedSessions.clear()
    this.lastEffectiveSession = null

    this.clientTty = null
    this.currentWindow = null
    this.readyAt = null
    this.startPromise = null
  }

  protected async doStart(): Promise<void> {
    if (this.disposed) {
      throw new TerminalProxyError(
        'ERR_NOT_READY',
        'Terminal proxy already disposed',
        true
      )
    }
    if (this.process) {
      return
    }

    const attemptId = ++this.startAttemptId
    const startedAt = this.now()
    this.state = TerminalState.ATTACHING

    this.logEvent('terminal_proxy_start', {
      sessionName: this.options.sessionName,
      baseSession: this.options.baseSession,
      mode: this.getMode(),
    })

    try {
      this.runTmuxMutation([
        'new-session',
        '-d',
        '-t',
        this.options.baseSession,
        '-s',
        this.options.sessionName,
      ])
    } catch (error) {
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_SESSION_CREATE_FAILED',
        error instanceof Error
          ? error.message
          : 'Failed to create grouped session',
        true
      )
    }

    // Grouped sessions get their own session options from the global default,
    // not from the base session. Copy the base session's mouse setting so
    // SGR mouse sequences from the browser aren't silently dropped.
    let mouseValue = ''
    try {
      mouseValue = this.runTmux([
        'show-option',
        '-t',
        this.options.baseSession,
        '-v',
        'mouse',
      ]).trim()
    } catch {
      // Base session may not have an explicit mouse override; ignore
    }

    if (mouseValue) {
      try {
        this.runTmuxMutation([
          'set-option',
          '-t',
          this.options.sessionName,
          'mouse',
          mouseValue,
        ])
      } catch (error) {
        this.logEvent('terminal_mouse_mode_sync_failed', {
          sessionName: this.options.sessionName,
          baseSession: this.options.baseSession,
          mouseValue,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      this.runTmuxMutation([
        'set-option',
        '-t',
        this.options.sessionName,
        'allow-passthrough',
        'on',
      ])
    } catch (error) {
      this.logEvent('terminal_passthrough_enable_failed', {
        sessionName: this.options.sessionName,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Ensure copies inside the session land in a tmux paste buffer so the
    // server-side clipboard poll can deliver them to the browser. This matters
    // most on iOS Safari, where the async OSC 52 path can't satisfy the
    // user-gesture rule. `set-clipboard` is a SERVER option: with the modern
    // `external` default tmux forwards an app's OSC 52 to the outer terminal
    // but stores no buffer for the poll to read; `on` makes it store one.
    // Opt-out via AGENTBOARD_TMUX_SET_CLIPBOARD=0 to avoid the global change.
    if (SET_CLIPBOARD_ENABLED) {
      try {
        this.runTmuxMutation(['set-option', '-s', 'set-clipboard', 'on'])
      } catch (error) {
        this.logEvent('terminal_set_clipboard_failed', {
          sessionName: this.options.sessionName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (attemptId !== this.startAttemptId) {
      await this.dispose()
      return
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      // Agentboard's browser PTY is UTF-8 even when a service manager gives
      // the server a C locale. Force tmux's client to render UTF-8 output.
      proc = this.spawn(
        [
          'tmux',
          ...withTmuxUtf8Flag([
            ...this.clientFeatureArgs(),
            'attach',
            '-t',
            this.options.sessionName,
          ]),
        ],
        {
          env: {
            ...sanitizedTmuxEnv(),
            TERM: 'xterm-256color',
          },
          terminal: {
            cols: this.cols,
            rows: this.rows,
            name: 'xterm-256color',
            data: (_terminal, data) => {
              const text = this.decoder.decode(data, { stream: true })
              if (!text || this.outputSuppressed) {
                return
              }
              this.options.onData(text)
            },
            exit: () => {
              const tail = this.decoder.decode()
              if (tail && !this.outputSuppressed) {
                this.options.onData(tail)
              }
            },
          },
        }
      )
    } catch (error) {
      // Tear down the grouped session created just above; otherwise a failed
      // attach orphans a `…-ws-<uuid>` session that holds a pty until the next
      // restart's reaper.
      await this.dispose()
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to attach tmux client',
        true
      )
    }

    if (attemptId !== this.startAttemptId) {
      try {
        proc.kill()
        proc.terminal?.close()
      } catch {
        // Ignore if already exited
      }
      await this.dispose()
      return
    }

    this.process = proc

    proc.exited.then(() => {
      if (this.process !== proc) return
      this.process = null
      this.state = TerminalState.DEAD
      this.logEvent('terminal_proxy_dead', {
        sessionName: this.options.sessionName,
        mode: this.getMode(),
      })
      this.options.onExit?.()
    })

    try {
      const tty = await this.discoverClientTty(proc.pid)
      if (attemptId !== this.startAttemptId) {
        await this.dispose()
        return
      }
      this.clientTty = tty
      this.readyAt = this.now()
      this.state = TerminalState.READY
      this.logEvent('terminal_proxy_ready', {
        sessionName: this.options.sessionName,
        clientTty: tty,
        durationMs: this.readyAt - startedAt,
        mode: this.getMode(),
      })
    } catch (error) {
      this.state = TerminalState.DEAD
      await this.dispose()
      throw error
    }
  }

  protected async doSwitch(target: string, onReady?: () => void): Promise<boolean> {
    if (!this.clientTty || this.state === TerminalState.DEAD) {
      throw new TerminalProxyError(
        'ERR_NOT_READY',
        'Terminal client not ready',
        true
      )
    }

    const effectiveTarget = this.ensureEffectiveTarget(target)
    this.state = TerminalState.SWITCHING
    this.outputSuppressed = true
    const startedAt = this.now()

    this.logEvent('terminal_switch_attempt', {
      sessionName: this.options.sessionName,
      tmuxWindow: target,
      effectiveTarget,
      clientTty: this.clientTty,
      mode: this.getMode(),
    })

    try {
      const expectedIdentity = this.readTargetIdentity(effectiveTarget)
      this.runTmux(['switch-client', '-c', this.clientTty, '-t', effectiveTarget])
      const actualIdentity = await this.verifyClientTarget(
        effectiveTarget,
        expectedIdentity
      )
      try {
        this.process?.terminal?.resize(this.cols, this.rows)
      } catch {
        // Ignore resize errors; the PTY may already be closing.
      }
      try {
        this.runTmux(['refresh-client', '-t', this.clientTty])
      } catch {
        // Ignore refresh failures
      }
      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }
      this.outputSuppressed = false
      if (effectiveTarget.includes(':') && actualIdentity.windowId) {
        this.setCurrentWindow(`${actualIdentity.sessionName}:${actualIdentity.windowId}`)
      } else {
        this.setCurrentWindow(effectiveTarget)
      }
      this.lastEffectiveSession = actualIdentity.sessionName
      this.releaseUnusedExternalGroupedSessions(actualIdentity.sessionName)
      const durationMs = this.now() - startedAt
      this.logEvent('terminal_switch_success', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        effectiveTarget,
        clientTty: this.clientTty,
        durationMs,
        mode: this.getMode(),
      })
      this.state = TerminalState.READY
      return true
    } catch (error) {
      this.outputSuppressed = false
      this.state = TerminalState.READY
      // A failed switch through a derived grouped session may mean the
      // session went stale (raw session killed/recreated). Kill it and evict
      // it from the warm-path map so the next attach re-validates and
      // recreates it — otherwise it leaks until the process restarts, since
      // releaseUnusedExternalGroupedSessions and dispose() only ever see
      // what's still tracked in the map.
      const effColon = effectiveTarget.indexOf(':')
      const effSession =
        effColon > 0 ? effectiveTarget.slice(0, effColon) : effectiveTarget
      if (this.externalGroupedSessions.has(effSession)) {
        try {
          this.runTmuxMutation(['kill-session', '-t', `=${effSession}`])
        } catch {
          // Best-effort; it may already be gone (that's often why the
          // switch itself failed).
        }
        this.externalGroupedSessions.delete(effSession)
      }
      this.logEvent('terminal_switch_failure', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        effectiveTarget,
        clientTty: this.clientTty,
        error: error instanceof Error ? error.message : 'tmux switch failed',
        mode: this.getMode(),
      })
      throw new TerminalProxyError(
        'ERR_TMUX_SWITCH_FAILED',
        error instanceof Error ? error.message : 'Unable to switch tmux client',
        true
      )
    }
  }

  private clientFeatureArgs(): string[] {
    if (!syncFeatureEnabled()) {
      return []
    }
    try {
      return tmuxSupportsClientFeatures(this.runTmux(['-V']))
        ? ['-T', 'sync']
        : []
    } catch (error) {
      // Attach still proceeds without -T sync; log so a tearing report can be
      // traced to a failed version probe instead of guessing (issue #158).
      this.logEvent('terminal_sync_probe_failed', {
        sessionName: this.options.sessionName,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  // Kills derived grouped sessions the client is no longer attached to.
  // Shrinks the window in which a derived session pins alive the windows of
  // a raw session the user killed (tmux keeps group windows alive while any
  // member session exists), and stops leftover groups from hijacking the
  // user's own `new-session -t <name>` usage.
  private releaseUnusedExternalGroupedSessions(currentSession: string): void {
    for (const name of this.externalGroupedSessions.keys()) {
      if (name === currentSession) continue
      try {
        this.runTmuxMutation(['kill-session', '-t', `=${name}`])
      } catch {
        // Ignore; prune-on-startup is the fallback
      }
      this.externalGroupedSessions.delete(name)
    }
  }

  private readTargetIdentity(target: string): TmuxTargetIdentity {
    const output = this.runParsedTmux([
      'display-message',
      '-p',
      '-t',
      target,
      TARGET_IDENTITY_FORMAT,
    ]).trim()
    const identity = this.parseTargetIdentity(output)
    if (!identity) {
      throw new Error(`Unable to resolve tmux target identity for ${target}`)
    }
    return identity
  }

  private readClientIdentity(): TmuxTargetIdentity {
    if (!this.clientTty) {
      throw new Error('Terminal client not ready')
    }
    // display-message -p -c expands formats against the most recently active
    // session, not the -c client, so it misreports whenever another tmux
    // client is active. list-clients expands formats per client, so filter
    // by tty instead (same approach as discoverClientTty).
    const output = this.runParsedTmux([
      'list-clients',
      '-F',
      CLIENT_IDENTITY_FORMAT,
    ])
    for (const line of output.split('\n')) {
      const cleaned = line.replace(/\r$/, '')
      if (!cleaned) continue
      const parts = splitTmuxFields(cleaned, 3)
      if (!parts) continue
      const [tty, sessionName, windowId] = parts
      if (tty !== this.clientTty) continue
      if (!sessionName) break
      return {
        sessionName,
        windowId: windowId?.trim() || null,
      }
    }
    throw new Error(`Unable to resolve tmux client identity for ${this.clientTty}`)
  }

  private parseTargetIdentity(output: string): TmuxTargetIdentity | null {
    const parts = splitTmuxFields(output, 2)
    if (!parts) return null
    const sessionName = parts[0]?.trim()
    const windowId = parts[1]?.trim() ?? ''
    if (!sessionName) return null
    return {
      sessionName,
      windowId: windowId || null,
    }
  }

  private identitiesMatch(
    actual: TmuxTargetIdentity,
    expected: TmuxTargetIdentity
  ): boolean {
    if (actual.sessionName !== expected.sessionName) return false
    if (!expected.windowId) return true
    return actual.windowId === expected.windowId
  }

  private async verifyClientTarget(
    effectiveTarget: string,
    expected: TmuxTargetIdentity
  ): Promise<TmuxTargetIdentity> {
    const retryDelays = [0, 25, 50, 100, 150]
    let lastActual: TmuxTargetIdentity | null = null

    for (const delay of retryDelays) {
      if (delay > 0) {
        await this.wait(delay)
        try {
          this.runTmux(['switch-client', '-c', this.clientTty!, '-t', effectiveTarget])
        } catch {
          // The final identity check below will surface a precise switch failure.
        }
      }

      const actual = this.readClientIdentity()
      lastActual = actual
      if (this.identitiesMatch(actual, expected)) {
        return actual
      }
    }

    throw new Error(
      `tmux client attached to ${lastActual?.sessionName ?? '<unknown>'}:` +
      `${lastActual?.windowId ?? '<unknown>'}, expected ` +
      `${expected.sessionName}:${expected.windowId ?? '<current>'}`
    )
  }

  private async discoverClientTty(pid: number): Promise<string> {
    const start = this.now()
    let delay = 50
    const maxWaitMs = 2000

    while (this.now() - start <= maxWaitMs) {
      let output = ''
      try {
        output = this.runParsedTmux([
          'list-clients',
          '-F',
          CLIENT_TTY_FORMAT,
        ])
      } catch {
        output = ''
      }
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = splitTmuxFields(trimmed, 2)
        if (!parts) continue
        const [tty, pidValue] = parts
        if (!tty || !pidValue) continue
        if (Number.parseInt(pidValue, 10) === pid) {
          return tty
        }
      }

      await this.wait(delay)
      delay = Math.min(delay * 2, 800)
    }

    throw new TerminalProxyError(
      'ERR_TTY_DISCOVERY_TIMEOUT',
      'Unable to discover tmux client TTY',
      true
    )
  }
}

export { PtyTerminalProxy }
