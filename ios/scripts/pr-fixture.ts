/** Loopback test proxy: real backend traffic, deterministic GitHub check responses. */
const backend = 'http://127.0.0.1:4151'
Bun.serve<{ upstream?: WebSocket }>({
 hostname:'127.0.0.1', port:4190,
 async fetch(request, server) {
  const url = new URL(request.url)
  if(url.pathname === '/ws') {
   if(server.upgrade(request,{data:{}})) return
   return new Response('Upgrade failed',{status:400})
  }
  if(url.pathname === '/api/pr-checks') return Response.json({url:url.searchParams.get('url'),
   title:'Parity pull request fixture', state:'OPEN', author:'fixture-author', isDraft:true,
   checks:[
    {name:'Unit tests',status:'COMPLETED',conclusion:'SUCCESS',link:'https://example.test/checks/unit'},
    {name:'iOS build',status:'IN_PROGRESS',conclusion:null,link:'https://example.test/checks/ios'},
    {name:'Lint',status:'COMPLETED',conclusion:'FAILURE',link:'https://example.test/checks/lint'},
   ]})
  return fetch(new Request(backend + url.pathname + url.search, request))
 },
 websocket:{
  open(socket) {
   const upstream = new WebSocket(backend.replace('http:', 'ws:') + '/ws?catalog=2')
   socket.data.upstream = upstream
   upstream.onmessage = event => socket.send(String(event.data))
   upstream.onclose = () => socket.close()
   upstream.onerror = () => socket.close()
  },
  message(socket, message) { if(socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(message) },
  close(socket) { socket.data.upstream?.close() },
 }
})
console.log('Deterministic PR checks fixture: http://127.0.0.1:4190')
