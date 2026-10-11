// P4-8 synthetic protocol peer: no network, credentials, tools or file writes.
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('p48-fixture 1.0'); process.exit(0); }
let sid = `p48-${process.pid}`, pending, timer;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const reply = (id,result) => send({id,result});
const message = text => send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.method==='initialize') reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new') reply(r.id,{sessionId:sid});
 else if(r.method==='session/load') { sid=r.params.sessionId; reply(r.id,{}); }
 else if(r.method==='session/prompt') {
  pending=r.id; const label=r.params.prompt.map(x=>x.text??'').join(''); let count=0;
  message(`合成对端 ${label} · ${sid}\n`);
  timer=setInterval(()=>{message(`${label} 独立片段 ${++count}\n`);if(count===120){clearInterval(timer);reply(pending,{stopReason:'end_turn'});}},500);
 } else if(r.method==='session/cancel') {clearInterval(timer);reply(pending,{stopReason:'cancelled'});}
}
