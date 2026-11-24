import type { TerminalSession } from './protocol'
/** Terminal-only asynchronous tmux reads; never read the dashboard database. */
import { config } from '../config'
import { copyModeCommand, resolveLocalCopyModeTarget } from '../copyModeQuery'
import { splitSshOptions } from '../remoteSessions'
import { shellQuote } from '../shellQuote'
import { timedSpawnAsync } from '../syncSpawnTiming'
import { withTmuxUtf8Flag } from '../tmuxFormat'
import { sanitizedTmuxEnv } from '../tmuxEnv'
import { normalizeCapturedHistory } from '../terminal/tmuxText'
import type { TerminalPeer } from './terminalRuntimeTypes'
import { sendTerminal } from './terminalRuntimeTypes'

export function terminalSshOptions(): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...splitSshOptions(config.remoteSshOpts)]
}

export async function runTerminalTmux(args: string[], host?: string) {
  const command = host
    ? ['ssh', ...terminalSshOptions(), host, `tmux -u ${args.map(shellQuote).join(' ')}`]
    : ['tmux', ...withTmuxUtf8Flag(args)]
  return timedSpawnAsync(command, { timeout: host ? config.remoteTimeoutMs : config.tmuxTimeoutMs, env: sanitizedTmuxEnv() })
}

export async function captureTerminalScreen(target: string, host?: string): Promise<string | null> {
  try {
    const result = await runTerminalTmux(['capture-pane', '-t', target, '-p', '-J', ...(config.terminalColorsEnabled ? ['-e'] : [])], host)
    return result.exitCode === 0 && result.stdout.trim() ? normalizeCapturedHistory(result.stdout) : null
  } catch {
    return null
  }
}

function copyModeEndpoint(peer: TerminalPeer, session: TerminalSession) {
  const attached = peer.data.currentSessionId === session.id
  const terminal = attached ? peer.data.terminal : null
  const selectedTarget = (attached ? peer.data.currentTmuxTarget : null) ?? session.tmuxWindow
  return {
    target: resolveLocalCopyModeTarget(selectedTarget, terminal),
    tty: terminal?.getMode() === 'pty' ? terminal.getClientTty() : null,
  }
}

export async function checkTerminalCopyMode(peer: TerminalPeer, session: TerminalSession, isCurrent: () => boolean = () => true): Promise<void> {
  const sequence = peer.data.terminalAttachSeq
  const { target, tty } = copyModeEndpoint(peer, session)
  const status = await peer.data.copyModeQuery.read(async () => {
    const result = await runTerminalTmux(copyModeCommand(target, tty), session.remote ? session.host : undefined)
    return result.exitCode === 0 ? result.stdout : ''
  }, () => peer.readyState === 1 && sequence === peer.data.terminalAttachSeq && isCurrent())
  if (status) sendTerminal(peer, { type: 'tmux-copy-mode-status', sessionId: session.id, ...status })
}

export async function cancelTerminalCopyMode(peer: TerminalPeer, session: TerminalSession): Promise<void> {
  const { target } = copyModeEndpoint(peer, session)
  try { await runTerminalTmux(['send-keys', '-X', '-t', target, 'cancel'], session.remote ? session.host : undefined) } catch { /* Already out of copy mode or pane gone. */ }
}
