import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('p414-fixture 1.0');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 appendFileSync('/tmp/sc-p414/rpc.jsonl',JSON.stringify({method:r.method})+'\n');
 if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(r.method==='session/new')send({id:r.id,result:{sessionId:'p414-session-'+process.pid}});
 else if(r.method==='session/prompt') {
  send({method:'session/update',params:{sessionId:'p414-session-'+process.pid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'合成任务完成；没有写文件或访问网络。'}}}});
  setTimeout(()=>send({id:r.id,result:{stopReason:'end_turn'}}),1500);
 }
}
