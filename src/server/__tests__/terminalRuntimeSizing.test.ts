import { expect, test } from 'bun:test'
import { TerminalRuntime, createTerminalPeerData, type TerminalPeer } from '../relay/terminalRuntime'
import { TerminalProxyBase } from '../terminal/TerminalProxyBase'
import { TerminalState, type TerminalProxyOptions } from '../terminal/types'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(done: () => boolean) { for (let i = 0; i < 100; i++) { if (done()) return; await Bun.sleep(1) } throw new Error('Condition not reached') }
class Proxy extends TerminalProxyBase {
  tty: string | null = null
  startHold: Promise<void> | null = null
  flagHold: Promise<void> | null = null
  flags: string[] = []
  readonly startsIgnored: boolean
  constructor(options: TerminalProxyOptions) {
    super(options)
    this.sizeParticipationSupported = true // This fixture models a modern tmux server.
    this.startsIgnored = options.initialSizeParticipation === false
  }
  protected async doStart() { await this.startHold; this.tty = '/dev/runtime-size'; this.state = TerminalState.READY }
  protected async doSwitch(_target: string, onReady?: () => void) { onReady?.(); return true }
  protected async runParsedTmuxNonBlocking(args: string[]) { this.flags.push(args.at(-1)!); await this.flagHold; return '' }
  write() {}
  paste() {}
  resize() {}
  getClientTty() { return this.tty }
  getMode(): 'pty' { return 'pty' }
  async dispose() { this.state = TerminalState.DEAD; await this.drainSizeParticipation(); this.tty = null }
}
function fixture(startHold: Promise<void> | null = null, flagHold: Promise<void> | null = null) {
  let proxy!: Proxy
  const messages: Array<{ type: string; attachId?: number }> = []
  const peer: TerminalPeer = { data: createTerminalPeerData('size'), readyState: 1, send: raw => messages.push(JSON.parse(raw)) }
  const runtime = new TerminalRuntime({
    getSession: id => id === 'A' ? { id: 'A', tmuxWindow: 'board:@1' } : undefined,
    createProxy: options => { proxy = new Proxy(options); proxy.startHold = startHold; proxy.flagHold = flagHold; return proxy },
    capture: async () => 'screen',
    clipboard: { start() {}, stop() {}, arm() {} },
  })
  const attach = (attachId: number) => runtime.handle(peer, { type: 'terminal-attach', sessionId: 'A', attachId, cols: 40, rows: 20 })
  return { runtime, peer, messages, attach, get proxy() { return proxy } }
}

test('hide during startup never enables a late observer; next verified attach enables it', async () => {
  const held = deferred(); const h = fixture(held.promise)
  h.attach(1)
  expect(h.proxy.startsIgnored).toBe(true)
  h.runtime.suspend(h.peer)
  held.resolve(); await Bun.sleep(5)
  expect(h.proxy.flags).toEqual([])
  expect(h.messages.some(message => message.type === 'terminal-ready')).toBe(false)
  h.attach(2)
  await until(() => h.messages.some(message => message.type === 'terminal-ready'))
  expect(h.proxy.flags).toEqual(['!ignore-size'])
  expect(h.messages.filter(message => message.type === 'terminal-ready').map(message => message.attachId)).toEqual([2])
  await h.runtime.dispose(h.peer)
})

test('readiness waits for sizing restoration and rapid hide/show cannot finish ignored', async () => {
  const held = deferred(); const h = fixture(null, held.promise)
  h.attach(1)
  await until(() => h.proxy.flags.length === 1)
  expect(h.messages.some(message => message.type === 'terminal-ready')).toBe(false)
  h.runtime.suspend(h.peer)
  h.attach(2)
  held.resolve()
  await until(() => h.messages.some(message => message.type === 'terminal-ready'))
  expect(h.proxy.flags).toEqual(['!ignore-size', 'ignore-size', '!ignore-size'])
  expect(h.messages.filter(message => message.type === 'terminal-ready').map(message => message.attachId)).toEqual([2])
  await h.runtime.dispose(h.peer)
})
