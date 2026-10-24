import { expect, test } from 'bun:test'
import { TerminalProxyBase } from '../terminal/TerminalProxyBase'
import { SshTerminalProxy } from '../terminal/SshTerminalProxy'
import { TerminalState, type TerminalProxyOptions } from '../terminal/types'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => Bun.sleep(0)
class Proxy extends TerminalProxyBase {
  tty: string | null = '/dev/size-test'
  mode: 'pty' | 'pipe-pane' = 'pty'
  calls: string[][] = []
  hold: Promise<void> | null = null
  released = false
  fail = false
  constructor(initial = true) {
    super({ connectionId: 'size', sessionName: 'size-session', baseSession: 'size', onData() {}, initialSizeParticipation: initial })
    this.state = TerminalState.READY
  }
  protected async doStart() {}
  protected async doSwitch() { return true }
  protected async runParsedTmuxNonBlocking(args: string[]) {
    this.calls.push(args)
    await this.hold
    if (this.fail) throw new Error('tmux unavailable')
    return ''
  }
  write() {}
  paste() {}
  resize() {}
  getClientTty() { return this.tty }
  getMode() { return this.mode }
  die() { this.state = TerminalState.DEAD }
  async dispose() { this.die(); await this.drainSizeParticipation(); this.released = true; this.tty = null }
}

test('hide then show serialize flag changes; repeated requests do not spawn extra commands', async () => {
  const proxy = new Proxy()
  const held = deferred(); proxy.hold = held.promise
  const hide = proxy.setSizeParticipation(false)
  await tick()
  const show = proxy.setSizeParticipation(true)
  expect(proxy.calls).toEqual([['refresh-client', '-t', '/dev/size-test', '-f', 'ignore-size']])
  held.resolve(); await hide; await show
  await proxy.setSizeParticipation(true)
  expect(proxy.calls.map(args => args.at(-1))).toEqual(['ignore-size', '!ignore-size'])
})

test('dispose waits for an in-flight mutation and skips queued foreground work before releasing tty', async () => {
  const proxy = new Proxy()
  const held = deferred(); proxy.hold = held.promise
  const hide = proxy.setSizeParticipation(false); await tick()
  const show = proxy.setSizeParticipation(true)
  const dispose = proxy.dispose(); await tick()
  expect(proxy.released).toBe(false)
  held.resolve(); await Promise.all([hide, show, dispose])
  expect(proxy.released).toBe(true)
  expect(proxy.calls).toHaveLength(1)
})

test('natural exit or replaced tty cancels a queued sizing mutation', async () => {
  for (const expire of [(p: Proxy) => p.die(), (p: Proxy) => { p.tty = '/dev/replacement' }]) {
    const proxy = new Proxy()
    const operation = proxy.setSizeParticipation(false)
    expire(proxy)
    await operation
    expect(proxy.calls).toEqual([])
  }
})

test('relay observers start ignored and foreground command failures propagate for retry', async () => {
  const proxy = new Proxy(false)
  await proxy.setSizeParticipation(false)
  expect(proxy.calls).toEqual([])
  proxy.fail = true
  await expect(proxy.setSizeParticipation(true)).rejects.toThrow('tmux unavailable')
  proxy.fail = false
  await proxy.setSizeParticipation(true)
  expect(proxy.calls.map(args => args.at(-1))).toEqual(['!ignore-size', '!ignore-size'])
})

test('pipe-pane has no PTY sizing flags', async () => {
  const proxy = new Proxy()
  proxy.mode = 'pipe-pane'
  await proxy.setSizeParticipation(false)
  expect(proxy.calls).toEqual([])
})

test('SSH sizing uses its asynchronous remote command path', async () => {
  class Remote extends SshTerminalProxy {
    calls: string[][] = []
    constructor(options: TerminalProxyOptions) { super(options); this.state = TerminalState.READY }
    getClientTty() { return '/dev/remote-tty' }
    protected async runTmuxAsync(args: string[]) { this.calls.push(args); return '' }
  }
  const proxy = new Remote({ connectionId: 'remote', sessionName: 'remote-session', baseSession: '', host: 'test-host', onData() {} })
  await proxy.setSizeParticipation(false)
  expect(proxy.calls).toEqual([['-u', 'refresh-client', '-t', '/dev/remote-tty', '-f', 'ignore-size']])
})
