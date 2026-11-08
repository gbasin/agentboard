/** Disposable native E2E fixtures. Refuses to write outside its private /tmp tree. */
import { mkdir, writeFile } from 'node:fs/promises'
import { nativePDFFixture } from './pdf-fixture'
import { initDatabase } from '../../src/server/db'
const root = '/tmp/ab-ios-parity'
const db = initDatabase({path: `${root}/data/agentboard.db`})
const now = new Date().toISOString()
const id = '11111111-2222-4333-8444-555555555555'
await mkdir(`${root}/project/child`, {recursive:true})
const lines = Array.from({length: 240}, (_, i) => JSON.stringify({type:i % 2 ? 'assistant':'user', timestamp:now, sessionId:id,
 message:{role:i % 2 ? 'assistant':'user', content:`Parity transcript message ${i} — **native** rendering.`}}))
const image = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPgSvlAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAOVLeEwhyp0SAAAAAElFTkSuQmCC'
lines.push(JSON.stringify({type:'user', timestamp:now, sessionId:id, message:{role:'user', content:[{type:'image', source:{type:'base64',media_type:'image/png',data:image}}]}}))
const document = Buffer.from('<!doctype html><html><body><h1>Native document fixture</h1><p>Loaded from the real session-media endpoint.</p></body></html>').toString('base64')
lines.push(JSON.stringify({type:'user', timestamp:now, sessionId:id, message:{role:'user', content:[
 {type:'document', source:{type:'base64',media_type:'text/html',data:document}},
 {type:'document', source:{type:'base64',media_type:'application/pdf',data:nativePDFFixture().toString('base64')}},
 {type:'frame-link',title:'Native link fixture',frameUrl:'http://127.0.0.1:4151/api/library/health'},
 {type:'text',text:'Review https://github.com/gbasin/agentboard/pull/1'}
]}}))
lines.push(JSON.stringify({type:'assistant', timestamp:now, sessionId:id, message:{role:'assistant', content:[{type:'tool_use',id:'parity-pr',name:'Bash',input:{command:'gh pr create --title test --body test'}}]}}))
lines.push(JSON.stringify({type:'user', timestamp:now, sessionId:id, message:{role:'user', content:[{type:'tool_result',tool_use_id:'parity-pr',content:'https://github.com/gbasin/agentboard/pull/1'}]}}))
await writeFile(`${root}/photo.png`, Buffer.from(image, 'base64'))
const log = `${root}/${id}.jsonl`
await writeFile(log, lines.join('\n')+'\n')
if (!db.getSessionById(id)) db.insertSession({sessionId:id, logFilePath:log, projectPath:`${root}/project`, slug:null, agentType:'claude', displayName:'parity-saved-transcript', createdAt:now, lastActivityAt:now, lastUserMessage:'Parity transcript fixture', currentWindow:null, isHibernating:false, lastResumeError:null, lastKnownLogSize:null, isCodexExec:false, launchCommand:'/bin/zsh -f'})
const savedID = 'parity-saved-transcript'
db.db.query(`INSERT OR IGNORE INTO board_sessions(id,name,project_path,host_id,agent_type,provider_id,command,state,created_at,last_activity_at,origin,terminal_preview) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run(savedID,'parity-saved-transcript',`${root}/project`,'native-test','claude',id,'/bin/zsh -f','archived',now,now,'imported','Synthetic saved terminal preview')
db.db.query('INSERT OR IGNORE INTO session_conversations(session_id,provider_id,linked_at) VALUES(?,?,?)').run(savedID,id,now)
db.close()
const settings = {defaultProjectDir:`${root}/project`, lastProjectPath:`${root}/project`, defaultPresetId:'native-shell',
 commandPresets:[{id:'native-shell',label:'Test shell',command:'/bin/zsh -f',isBuiltIn:false}], recentPaths:[`${root}/project`], projectFilters:[], hostFilters:[], theme:'system'}
const response = await fetch('http://127.0.0.1:4151/api/settings/synced',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings})})
if (!response.ok) throw new Error(await response.text())
await writeFile(`${root}/upload.txt`, 'Native E2E upload fixture\n')
console.log(JSON.stringify({savedID, transcriptID:id, project:`${root}/project`, mediaPath:log, mediaOffset:Buffer.byteLength(lines.slice(0,240).join('\n')+'\n')}))
