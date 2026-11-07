/** Assert real simulator paste bytes recorded by terminal.py. */
import assert from 'node:assert/strict'
const path = process.argv[2]
if (!path) throw new Error('Usage: bun scripts/native-paste-prototype/check-input.ts INPUT_JSONL')
const frames = (await Bun.file(path).text()).trim().split('\n').map(line => JSON.parse(line) as { hex: string })
const bytes = Buffer.concat(frames.map(frame => Buffer.from(frame.hex, 'hex'))).toString()
// Touch focus, output selection and scrolling may send SGR mouse packets.
const text = bytes.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')
assert.equal(text, '\x1b[200~PWA_native_alpha\rPWA_native_beta\x1b[201~')
console.log('PASS: exactly one multiline bracketed paste; no extra text or Enter')
console.log(JSON.stringify({mousePackets: (bytes.match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []).length, paste: text}))
