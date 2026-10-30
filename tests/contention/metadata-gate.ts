/** Test-only filesystem stall, installed in both main and metadata worker. */
import fs from 'node:fs'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'

export function installMetadataGate() {
  const gate = process.env.AB_METADATA_GATE!
  if (!gate) throw new Error('Private metadata gate required')
  const original = fs.statSync
  fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
    const arm = path.join(gate, 'arm')
    if (fs.existsSync(arm) && String(args[0]) === fs.readFileSync(arm, 'utf8') &&
        new Error().stack?.includes('agentSessions.ts')) {
      fs.renameSync(arm, path.join(gate, 'held'))
      fs.writeFileSync(path.join(gate, 'started'), JSON.stringify({ isMainThread, at: Date.now() }))
      const deadline = Date.now() + 8000
      const wait = new Int32Array(new SharedArrayBuffer(4))
      while (!fs.existsSync(path.join(gate, 'release')) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10)
    }
    return original(...args)
  }) as typeof fs.statSync
}
