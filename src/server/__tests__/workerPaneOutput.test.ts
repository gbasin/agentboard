import { expect, test } from 'bun:test'
import { createWorkerPaneOutput } from '../relay/workerPaneOutput'
import type { PaneOutputRequest } from '../relay/paneOutputProtocol'

function harness() {
  const requests: PaneOutputRequest[] = []
  const provider = createWorkerPaneOutput(message => requests.push(message))
  const output: string[] = []
  let exits = 0
  const lease = provider.subscribe('socket:100:%0', '%0', { runTmux: () => '', spawn: Bun.spawn }, {
    onData: data => output.push(data), onExit: () => exits++,
  })
  const id = requests[0].id
  return { ...provider, requests, lease, id, output, exits: () => exits }
}

test('worker provider credits consumed output and fences callbacks while releasing', async () => {
  const h = harness()
  h.handle({ type: 'pane-ready', id: h.id })
  await h.lease.ready
  h.handle({ type: 'pane-data', id: h.id, data: 'hello' })
  expect(h.output).toEqual(['hello'])
  expect(h.requests.at(-1)).toEqual({ type: 'pane-credit', id: h.id, bytes: 5 })
  const releasing = h.lease.release()
  expect(h.lease.release()).toBe(releasing)
  h.handle({ type: 'pane-data', id: h.id, data: 'late' })
  h.handle({ type: 'pane-exit', id: h.id })
  expect(h.output).toEqual(['hello'])
  expect(h.exits()).toBe(0)
  h.handle({ type: 'pane-released', id: h.id })
  await releasing
})

test('release acknowledgment also settles pending startup after cancellation', async () => {
  const h = harness()
  const release = h.lease.release()
  h.handle({ type: 'pane-released', id: h.id })
  await Promise.all([release, h.lease.ready])
  expect(h.output).toEqual([])
})

test('broker failure rejects startup and never strands later disposal', async () => {
  const h = harness()
  h.handle({ type: 'pane-error', id: h.id, error: 'worker stopped' })
  await expect(h.lease.ready).rejects.toThrow('worker stopped')
  await h.lease.release()
  expect(h.exits()).toBe(1)
})

test('broker failure settles an already pending disposal', async () => {
  const h = harness()
  const ready = h.lease.ready.catch(() => {})
  const release = h.lease.release()
  h.handle({ type: 'pane-error', id: h.id, error: 'worker stopped' })
  await Promise.all([release, ready])
  expect(h.exits()).toBe(0)
})
