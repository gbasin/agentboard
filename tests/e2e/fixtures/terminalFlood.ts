/** Test-owned pane: bounded producer with commands that remain responsive. */
import { createInterface } from 'node:readline'
import { once } from 'node:events'

let flooding = false
let counter = 0
createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'FLOOD') flooding = true
  else if (line === 'STOP') { flooding = false; process.stdout.write('STOPPED\r\n') }
  else process.stdout.write(`${line}\r\n`)
})

while (true) {
  if (flooding) {
    const block = Array.from({ length: 128 }, () => `${counter++} ${'X'.repeat(100)}\r\n`).join('')
    if (!process.stdout.write(block)) await once(process.stdout, 'drain')
  }
  await Bun.sleep(10)
}
