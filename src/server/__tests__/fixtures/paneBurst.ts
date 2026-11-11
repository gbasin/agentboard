/** Drive real pane output by receiver progress, not shell process-launch speed.
 * Only one small chunk can be in flight to the healthy viewer. A subscriber
 * withholding credits still accumulates more than the broker's 2 MiB limit.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { shellQuote } from '../../shellQuote'

export async function sendPaneBurst({ tmux, target, root, marker, received, failure }: {
  tmux: (args: string[]) => string
  target: string
  root: string
  marker: string
  received: () => string
  failure: () => string | undefined
}) {
  const buffer = 'test-burst-' + marker
  const file = path.join(root, buffer)
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 10_000
    while (!received().includes(text)) {
      const failed = failure()
      if (failed) throw Error(failed + ' while waiting for ' + text)
      if (Date.now() > deadline) throw Error('Pane burst made no receiver progress: ' + text)
      await Bun.sleep(10)
    }
  }
  // Raw cat echoes the exact pasted bytes without canonical-input truncation
  // or echo duplication. Wait for stty before injecting the first chunk.
  tmux(['respawn-pane', '-k', '-t', target, `stty raw -echo; printf %s ${shellQuote(marker + '-READY\n')}; exec cat`])
  await waitFor(marker + '-READY')
  try {
    for (let index = 0; index < 64; index++) {
      const end = `${marker}-${index}-END`
      await fs.writeFile(file, 'x'.repeat(48 * 1024) + '\r\n' + end + '\r\n')
      tmux(['load-buffer', '-b', buffer, file])
      tmux(['paste-buffer', '-d', '-b', buffer, '-t', target])
      await waitFor(end)
    }
  } finally {
    try { tmux(['delete-buffer', '-b', buffer]) } catch { /* Last paste deleted it. */ }
    await fs.rm(file, { force: true })
  }
}
