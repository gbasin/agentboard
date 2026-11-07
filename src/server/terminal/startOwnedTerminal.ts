import type { ITerminalProxy } from './types'

/** Startup is shared by attaches; only the connection owner releases a proxy. */
export async function startOwnedTerminal(
  terminal: ITerminalProxy,
  owner: { owns: () => boolean; current: () => boolean; release: () => void }
): Promise<ITerminalProxy | null> {
  try {
    await terminal.start()
    // A stale attach may have created the proxy a newer attach now uses.
    // Replacement and connection cleanup, rather than this waiter, dispose it.
    return owner.current() && owner.owns() ? terminal : null
  } catch (error) {
    if (owner.owns()) {
      owner.release()
      await Promise.resolve(terminal.dispose()).catch(() => {})
    }
    throw error
  }
}

/** Remote standalone sessions belong to one proxy, including late cleanup. */
export function sshTerminalSessionName(base: string, connectionId: string, sequence: number): string {
  return `${base}-ws-${connectionId}-ssh-${sequence}`
}
