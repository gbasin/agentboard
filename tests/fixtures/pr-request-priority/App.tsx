/** Actual sidebar and media components sharing a real HTTP/1 connection pool. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { PrChips } from '../../../src/client/components/PrChips'
import MediaRail from '../../../src/client/components/MediaRail'
const session = { id:'window', agentSessionId:'00000000-0000-4000-8000-000000000001', logFilePath:'/fixture.jsonl', agentType:'claude', mediaSummary:{identity:'fixture',revision:'r1',total:1,images:1,documents:0,links:0,additions:1,discovery:{status:'ready'}} } as any
createRoot(document.getElementById('root')!).render(<><main style={{width:300}}>{Array.from({length:18},(_,i)=><div key={i}><PrChips prs={[{url:`https://github.com/example/test/pull/${i+1}`,repo:'example/test',number:i+1}]}/></div>)}</main><MediaRail session={session} ready/></>)
const socket=new WebSocket(location.origin.replace('http','ws')+'/ws');(window as any).pongs=0
socket.onopen=()=>socket.send('ping');socket.onmessage=()=>{(window as any).pongs++}
