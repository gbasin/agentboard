import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
const requests=[];
const log=(kind,url)=>{const entry={time:new Date().toISOString(),kind,url};requests.push(entry);fs.appendFileSync('.poc-stress-test/ios/http.jsonl',JSON.stringify(entry)+'\n')};
const server=http.createServer((req,res)=>{
 if(req.url.startsWith('/__probe/')){
  if(req.url.startsWith('/__probe/stage'))log('stage',req.url);
  const result={items:requests.filter(r=>r.kind==='http'&&r.url.includes('/items')).length,requests};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return;
 }
 log('http',req.url);
 const upstream=http.request({hostname:'127.0.0.1',port:55040,path:req.url,method:req.method,headers:req.headers},u=>{res.writeHead(u.statusCode,u.headers);u.pipe(res)});
 upstream.on('error',()=>{res.writeHead(502);res.end()});req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
 log('upgrade',req.url);const upstream=net.connect(55040,'127.0.0.1',()=>{upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`+Object.entries(req.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket)});
 upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
server.listen(55042,'127.0.0.1',()=>console.log('PROXY_READY'));
