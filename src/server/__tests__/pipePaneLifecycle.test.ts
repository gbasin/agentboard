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
