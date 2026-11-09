/** Exercise provider wake/hibernate only against the disposable shell-resume backend. */
if(process.env.NATIVE_PARITY_SHELL_RESUME !== '1') throw new Error('Start the private backend with a shell resume template, then set NATIVE_PARITY_SHELL_RESUME=1.')
const ws = new WebSocket('ws://127.0.0.1:4151/ws?catalog=2')
const id = '11111111-2222-4333-8444-555555555555'
const timer = setTimeout(() => { throw new Error('Fixture lifecycle timed out') }, 20000)
let started = false
ws.onmessage = async event => {
 const message = JSON.parse(String(event.data))
 if(message.type === 'sessions' && !started) { started = true; ws.send(JSON.stringify({type:'session-wake',sessionId:id})) }
 if(message.type === 'session-wake-result' && message.sessionId === id) {
  if(!message.ok) throw new Error(JSON.stringify(message))
  console.log('Fixture woke as', message.session?.id)
  setTimeout(() => ws.send(JSON.stringify({type:'session-hibernate',sessionId:id})), 1500)
 }
 if(message.type === 'session-hibernate-result' && message.sessionId === id) {
  if(!message.ok) throw new Error(JSON.stringify(message))
  ws.send(JSON.stringify({type:'session-move-to-history',sessionId:id}))
 }
 if(message.type === 'session-move-to-history-result' && message.sessionId === id) {
  if(!message.ok) throw new Error(JSON.stringify(message))
  const response = await fetch('http://127.0.0.1:4151/api/library/parity-saved-transcript',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'parity-saved-transcript'})})
  if(!response.ok) throw new Error(await response.text())
  console.log('Fixture hibernated and returned to history');clearTimeout(timer);ws.close()
 }
}
