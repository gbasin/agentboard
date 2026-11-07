import { Terminal } from '@xterm/xterm'
import { installIosAutocorrect } from '../../src/client/utils/iosAutocorrect'
const terminal = new Terminal({cols: 36, rows: 5, fontSize: 16, screenReaderMode: true})
const container = document.querySelector<HTMLElement>('#terminal')!
terminal.open(container)
const textarea = terminal.textarea!
textarea.setAttribute('autocorrect', 'on')
textarea.setAttribute('autocapitalize', 'off')
textarea.setAttribute('spellcheck', 'true')
const adapter = new URLSearchParams(location.search).has('adapter') ? installIosAutocorrect(terminal) : null
const probeId = crypto.randomUUID()
let sequence = 0
const socket = new URLSearchParams(location.search).has('pty') ? new WebSocket(`ws://${location.host}/pty`) : null
if (socket) { socket.binaryType = 'arraybuffer'; socket.addEventListener('message', e => terminal.write(new Uint8Array(e.data))) }
let line = ''
const log = (event: unknown) => { void fetch('/events', {method:'POST', body:JSON.stringify({probeId, sequence: sequence++, adapter: !!adapter, event})}) }
for (const name of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend']) {
 container.addEventListener(name, (event) => {
   const e = event as InputEvent & KeyboardEvent
   log({name, key:e.key, data:e.data, inputType:e.inputType, composing:e.isComposing, value:textarea.value, start:textarea.selectionStart, end:textarea.selectionEnd})
 }, true)
}
terminal.onData(data => {
 log({name:'terminal-data', data})
 if (socket?.readyState === WebSocket.OPEN) socket.send(data)
 for (const char of data) {
   if (char === '\r') {log({name:'submit',line}); line = ''}
   else if (char === '\x7f') line = Array.from(line).slice(0,-1).join('')
   else line += char
 }
 if (!socket) terminal.write('\r\x1b[2K> ' + line)
 document.querySelector('#state')!.textContent = JSON.stringify({line, textarea:textarea.value})
})
if (!socket) terminal.write('> ')
document.querySelector('#focus')!.addEventListener('click', () => terminal.focus())
document.querySelector('#reset')!.addEventListener('click', () => {line=''; textarea.value=''; adapter?.reset(); if (socket) socket.send('\x15'); else terminal.write('\r\x1b[2K> '); terminal.focus()})
