import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PipePaneTerminalProxy } from '../terminal/PipePaneTerminalProxy'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('pipe-pane cancellation at filesystem boundaries', () => {
  for (const boundary of ['mkdtemp', 'writeFile'] as const) {
    test(`dispose during ${boundary} cannot install resources or become ready`, async () => {
      const reached = deferred()
      const resume = deferred()
      let createdRoot: string | undefined
      const original = fs[boundary].bind(fs)
      const spy = spyOn(fs, boundary).mockImplementation((async (...args: unknown[]) => {
        if (boundary === 'writeFile') createdRoot = path.dirname(args[0] as string)
        reached.resolve()
        await resume.promise
        const result = await (original as (...args: unknown[]) => unknown)(...args)
        createdRoot = boundary === 'mkdtemp' ? result as string : path.dirname(args[0] as string)
        return result
      }) as never)
      const commands: string[][] = []
      let tails = 0
      const proxy = new PipePaneTerminalProxy({
        connectionId: `cancel-${boundary}`, sessionName: 'cancel', baseSession: 'cancel',
        onData: () => {}, monitorTargets: false,
        spawn: (() => { tails++; throw new Error('Unexpected tail') }) as never,
        spawnSync: ((args: string[]) => {
          commands.push(args)
          return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
        }) as never,
      })
      const switching = proxy.switchTo(`cancel-${boundary}:@1`).catch(() => false)
      try {
        await reached.promise
        const disposing = proxy.dispose()
        resume.resolve()
        await disposing
        await switching
        expect(proxy.isReady()).toBe(false)
        expect(proxy.getCurrentWindow()).toBeNull()
        expect(tails).toBe(0)
        expect(createdRoot).toBeDefined()
        await expect(fs.access(createdRoot!)).rejects.toBeDefined()
        expect(commands.some((args) => args.includes('pipe-pane'))).toBe(false)
        await expect(proxy.switchTo('cancel:@2')).rejects.toMatchObject({ code: 'ERR_NOT_READY' })
      } finally { resume.resolve(); spy.mockRestore(); await proxy.dispose() }
    })
  }
})

test('disposal waits for a pending file writer before removing its root', async () => {
  const reached = deferred()
  const resume = deferred()
  const originalWrite = fs.writeFile.bind(fs)
  const originalRm = fs.rm.bind(fs)
  let root = ''
  let writing = true
  let removedDuringWrite = false
  const write = spyOn(fs, 'writeFile').mockImplementation((async (...args: Parameters<typeof fs.writeFile>) => {
    root = path.dirname(String(args[0]))
    reached.resolve()
    await resume.promise
    try { await originalWrite(...args) } finally { writing = false }
  }) as typeof fs.writeFile)
  const rm = spyOn(fs, 'rm').mockImplementation((async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === root && writing) {
      removedDuringWrite = true
      throw Object.assign(new Error('writer recreated a directory entry during removal'), { code: 'ENOTEMPTY' })
    }
    return originalRm(...args)
  }) as typeof fs.rm)
  const proxy = new PipePaneTerminalProxy({
    connectionId: 'rm-write-race', sessionName: 'rm-write-race', baseSession: 'rm-write-race', monitorTargets: false,
    onData: () => {}, spawn: (() => { throw new Error('Canceled startup spawned a tail') }) as never,
    spawnSync: (() => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })) as never,
  })
  const switching = proxy.switchTo('rm-write-race:@1')
  try {
    await reached.promise
    const disposing = proxy.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(removedDuringWrite).toBe(false)
    resume.resolve()
    await Promise.all([disposing, switching])
    await expect(fs.access(root)).rejects.toBeDefined()
    expect(proxy.isReady()).toBe(false)
  } finally {
    resume.resolve()
    await switching.catch(() => {})
    write.mockRestore(); rm.mockRestore()
    await proxy.dispose()
    if (root) await originalRm(root, { recursive: true, force: true })
  }
})
