const ws = new WebSocket('ws://127.0.0.1:4151/ws?catalog=2')
const timer = setTimeout(() => { console.error('Seed timeout'); process.exit(1) }, 15000)
const names = ['native-live-one', 'native-live-two']
let requested = false
const found = new Map<string, string>()
ws.onmessage = event => {
 const m = JSON.parse(String(event.data))
 if (m.type === 'sessions') {
  for (const s of m.sessions) if(names.includes(s.name)) found.set(s.name, s.id)
  if(!requested) {
   requested = true
   for(const name of names) if(!found.has(name)) ws.send(JSON.stringify({type:'session-create', name, projectPath:'/tmp', command:'/bin/zsh -f'}))
  }
 }
 if(m.type === 'session-created' && names.includes(m.session.name)) found.set(m.session.name, m.session.id)
 if(found.size === 2) { console.log(JSON.stringify(Object.fromEntries(found))); clearTimeout(timer); ws.close() }
 if(m.type === 'error') console.error(m.message)
}
