import { expect, test } from 'bun:test'
import { CopyModeQuery } from '../copyModeQuery'

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
