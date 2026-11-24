import { expect, test } from 'bun:test'
import { copyModeCommand, CopyModeQuery, resolveLocalCopyModeTarget } from '../copyModeQuery'

function deferred() {
  let resolve!: (value: string) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const current = () => true

test('preserves all pane-mode flags and error fallback', async () => {
  const query = new CopyModeQuery()
  expect(await query.read(async () => '1,0,1\n', current)).toEqual({ inCopyMode: true, altScreen: false, appMouse: true })
  expect(await query.read(async () => '0,1,0', current)).toEqual({ inCopyMode: false, altScreen: true, appMouse: false })
  expect(await query.read(async () => { throw new Error('unavailable') }, current)).toEqual({ inCopyMode: false, altScreen: false, appMouse: false })
})

test('late success or failure cannot overwrite a newer completed read', async () => {
  for (const fails of [false, true]) {
    const query = new CopyModeQuery()
    const slow = deferred()
    const old = query.read(() => slow.promise, current)
    expect(await query.read(async () => '1,1,1', current)).not.toBeNull()
    if (fails) slow.reject(new Error('timeout'))
    else slow.resolve('0,0,0')
    expect(await old).toBeNull()
  }
})

test('a newer pending poll does not starve the previous completed result', async () => {
  const query = new CopyModeQuery()
  const first = deferred(), second = deferred()
  const a = query.read(() => first.promise, current)
  const b = query.read(() => second.promise, current)
  first.resolve('1,0,0')
  expect((await a)?.inCopyMode).toBe(true)
  second.resolve('0,1,0')
  expect((await b)?.altScreen).toBe(true)
})

test('switch, detach, or disconnect invalidates pending results', async () => {
  const query = new CopyModeQuery()
  let generation = 1
  let open = true
  for (const invalidate of [() => { generation++ }, () => { open = false }]) {
    const captured = generation
    const slow = deferred()
    const result = query.read(() => slow.promise, () => open && captured === generation)
    invalidate()
    slow.resolve('1,1,1')
    expect(await result).toBeNull()
  }
})

test('converts the active pane intersection to visible client cells', async () => {
  const query = new CopyModeQuery()
  const largeClient = await query.read(async () => '0,0,0,11,0,9,8,,,255,99', current)
  expect(largeClient?.wheelBounds).toEqual({ firstCol: 12, firstRow: 1, lastCol: 20, lastRow: 8 })

  const pannedClient = await query.read(async () => '0,1,1,11,5,29,20,15,8,20,8', current)
  expect(pannedClient?.wheelBounds).toEqual({ firstCol: 1, firstRow: 1, lastCol: 20, lastRow: 8 })

  const hiddenPane = await query.read(async () => '0,0,0,41,0,9,8,,,20,8', current)
  expect(hiddenPane?.wheelBounds).toBeNull()

  const invalidGeometry = await query.read(async () => '0,0,0,,,9,8,,,255,99', current)
  expect(invalidGeometry?.wheelBounds).toBeUndefined()
})

test('reads the active grouped window with the correct tmux client', () => {
  const group = 'agentboard-ws-lease-x-external-123'
  const terminal = { getActiveGroupedSession: () => group }
  const target = resolveLocalCopyModeTarget(`${group}:@42`, terminal)
  expect(target).toBe(`=${group}:`)
  expect(copyModeCommand(target, '/dev/pts/2').slice(0, 6)).toEqual([
    'display-message', '-p', '-c', '/dev/pts/2', '-t', `=${group}:`,
  ])
  for (const selectedTarget of [group, `${group}:1`, `${group}:my-window`]) {
    expect(resolveLocalCopyModeTarget(selectedTarget, terminal)).toBe(target)
  }
})

test('preserves explicit pane targets, ungrouped targets and unavailable groups', () => {
  const terminal = { getActiveGroupedSession: () => 'agentboard-ws-lease' }
  for (const target of ['%12', 'agentboard-ws-lease:@42.0', 'agentboard-ws-lease:1.1', 'other:@42']) {
    expect(resolveLocalCopyModeTarget(target, terminal)).toBe(target)
  }
  expect(resolveLocalCopyModeTarget('agentboard-ws-lease:@42', null)).toBe('agentboard-ws-lease:@42')
})
