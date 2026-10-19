// Synthetic approval only: never executes commands, writes project files or accesses network.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('p416-fixture 1.0');process.exit(0)}
const sid=`p416-session-${process.pid}`;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId:sid,update}});
let promptId;
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);
 appendFileSync('/tmp/sc-p416/rpc.jsonl',JSON.stringify({pid:process.pid,method:r.method,id:r.id,result:r.result})+'\n');
 if(r.method==='initialize')reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new')reply(r.id,{sessionId:sid});
 else if(r.method==='session/prompt'){
  promptId=r.id;
  const command=r.params.prompt.some(item=>item.text?.includes('command'));
  const rawInput=command?{command:"printf '中文审批'\n# "+'完整命令用于复制验收。'.repeat(30)+'\nCOMMAND_END'}:{filePath:'/tmp/sc-p416/project/中文.ts',oldString:'const title = "旧中文";\n',newString:'const title = "新中文";\nconst checked = true;\n'};
  const toolCall={toolCallId:'same-tool',title:'同名工具',kind:command?'execute':'edit',rawInput};
  update({sessionUpdate:'tool_call',...toolCall});
  send({id:'permission',method:'session/request_permission',params:{sessionId:sid,toolCall,options:[{optionId:'ok',name:'允许一次',kind:'allow_once'},{optionId:'no',name:'拒绝',kind:'reject_once'},{optionId:'persistent',name:'永久放行',kind:'allow_always'}]}});
 }else if(r.id==='permission' && r.result){
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'合成裁决已收到：'+JSON.stringify(r.result)+'。没有执行命令或写入文件。'}});
  reply(promptId,{stopReason:'end_turn'});
 }else if(r.method==='session/cancel')reply(promptId,{stopReason:'cancelled'});
}
