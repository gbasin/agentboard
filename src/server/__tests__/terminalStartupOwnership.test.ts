import { expect, mock, test } from 'bun:test'
import type { ITerminalProxy } from '../terminal/types'
import { startOwnedTerminal } from '../terminal/startOwnedTerminal'

function harness() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const started = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const dispose = mock(async () => {})
  const terminal = { start: () => started, dispose } as unknown as ITerminalProxy
  let owned: ITerminalProxy | null = terminal
  let sequence = 1
  const attach = (seq: number) => startOwnedTerminal(terminal, {
    owns: () => owned === terminal,
    current: () => sequence === seq,
    release: () => { owned = null },
  })
  return { terminal, dispose, resolve, reject, attach, next: () => ++sequence,
    owned: () => owned,
    replace: (replacement: ITerminalProxy | null) => { sequence++; owned = replacement; return terminal.dispose() },
  }
}

test('concurrent same-host attaches share startup; stale creator leaves latest owner alive', async () => {
  const h = harness()
  const first = h.attach(1)
  const latest = h.attach(h.next())
  h.resolve()
  expect(await first).toBeNull()
  expect(await latest).toBe(h.terminal)
  expect(h.owned()).toBe(h.terminal)
  expect(h.dispose).not.toHaveBeenCalled()
})

for (const reason of ['detach', 'close', 'different-host', 'process-exit']) {
  test(`${reason} during startup prevents readiness and preserves owner cleanup`, async () => {
    const h = harness()
    const first = h.attach(1)
    const replacement = reason === 'different-host' ? {} as ITerminalProxy : null
    if (reason === 'detach') h.next() // Detach retains the observer.
    else await h.replace(replacement)
    h.resolve()
    expect(await first).toBeNull()
    expect(h.owned()).toBe(reason === 'detach' ? h.terminal : replacement)
    expect(h.dispose).toHaveBeenCalledTimes(reason === 'detach' ? 0 : 1)
  })
}

test('shared startup failure releases and disposes the owned proxy once', async () => {
  const h = harness()
  const first = h.attach(1).catch(error => error)
  const latest = h.attach(h.next()).catch(error => error)
  const failure = new Error('SSH startup failed')
  h.reject(failure)
  expect(await first).toBe(failure)
  expect(await latest).toBe(failure)
  expect(h.owned()).toBeNull()
  expect(h.dispose).toHaveBeenCalledTimes(1)
})

test('obsolete startup failure cannot release a replacement proxy', async () => {
  const h = harness()
  const first = h.attach(1).catch(error => error)
  const replacement = {} as ITerminalProxy
  await h.replace(replacement)
  h.reject(new Error('old host failed'))
  await first
  expect(h.owned()).toBe(replacement)
  expect(h.dispose).toHaveBeenCalledTimes(1)
})
