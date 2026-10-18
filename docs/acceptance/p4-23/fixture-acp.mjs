// Synthetic ACP only. No project writes, subprocesses or network requests.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('p423-fixture 1.0'); process.exit(0); }
const sid=`p423-${process.pid}`;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const reply=(id,result)=>send({id,result});
const update=value=>send({method:'session/update',params:{sessionId:sid,update:value}});
const audit=value=>appendFileSync(process.env.P423_AUDIT,JSON.stringify({pid:process.pid,time:Date.now(),...value})+'\n');
let promptId;
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line); audit({method:r.method??'response'});
 if(r.method==='initialize')reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new') {audit({cwd:r.params.cwd});reply(r.id,{sessionId:sid});}
 else if(r.method==='session/load')reply(r.id,{});
 else if(r.method==='session/prompt') {
  promptId=r.id;
  const prompt=r.params.prompt.map(x=>x.text??'').join('');
  if(prompt==='child') {update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'P423_CHILD'}});reply(promptId,{stopReason:'end_turn'});continue;}
  const toolCall={toolCallId:'same-tool',title:'合成审批（不执行命令）',kind:'execute',rawInput:{command:'synthetic-no-execution'}};
  update({sessionUpdate:'tool_call',...toolCall,status:'pending'});
  send({id:'permission',method:'session/request_permission',params:{sessionId:sid,toolCall,options:[{optionId:'allow',name:'允许一次',kind:'allow_once'},{optionId:'reject',name:'拒绝',kind:'reject_once'}]}});
 } else if(r.id==='permission'&&r.result) {
  audit({decision:r.result.outcome});
  update({sessionUpdate:'tool_call_update',toolCallId:'same-tool',status:r.result.outcome?.optionId==='allow'?'completed':'failed'});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'合成裁决已接收；无工具执行。'}});
  reply(promptId,{stopReason:'end_turn'});
 } else if(r.method==='session/cancel') {audit({cancelled:true});reply(promptId,{stopReason:'cancelled'});}
}
