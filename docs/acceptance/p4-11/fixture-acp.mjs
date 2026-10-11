// Native P4-11 fixture: 999 mixed replay items + active 20Hz message; no network/key/tool effects.
import { createInterface } from 'node:readline';
if(process.argv.includes('--version')){console.log('p411-fixture 1.0');process.exit(0)}
let sid=`p411-${process.pid}`,timer,pending;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');const reply=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId:sid,update}});
const text=(value,thought=false)=>update({sessionUpdate:thought?'agent_thought_chunk':'agent_message_chunk',content:{type:'text',text:value}});
function history(){for(let i=1;i<=333;i++){
 text(`## 历史正文 ${i}\n\n这是中文混合历史 **第 ${i} 组**，可选择与复制。\n\n`);
 text(`思考 ${i}：先检查边界。\n完整思考第二行\n`+'完整中文思考内容。'.repeat(20),true);
 update({sessionUpdate:'tool_call',toolCallId:`read-${i}`,title:`读取合成文件 ${i}`,kind:'read',status:'pending',rawInput:{path:`/fixture/file-${i}.txt`}});
 update({sessionUpdate:'tool_call_update',toolCallId:`read-${i}`,status:'completed',content:[{type:'content',content:{type:'text',text:`工具 ${i} 完整输出\n`+'中文工具输出\n'.repeat(20)}}],locations:[{path:`/fixture/file-${i}.txt`,line:1}]});
}}
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);
 if(r.method==='initialize')reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new'){reply(r.id,{sessionId:sid});}
 else if(r.method==='session/load'){sid=r.params.sessionId;history();reply(r.id,{});}
 else if(r.method==='session/prompt'){
  pending=r.id;let n=0;text('## 实时消息\n\n');
  timer=setInterval(()=>{text(`增量 ${++n}：中文输出，阅读旧消息时不抢滚动。\n`);if(n===1200){clearInterval(timer);reply(pending,{stopReason:'end_turn'});}},50);
 }else if(r.method==='session/cancel'){clearInterval(timer);reply(pending,{stopReason:'cancelled'});}
}
