import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('scheduler-fixture 1.0');process.exit(0)}
const sid=`fixture-${process.pid}`;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply=(id,result)=>send({id,result});
const update=x=>send({method:'session/update',params:{sessionId:sid,update:x}});
let promptId,timer;
const finish=(reason='end_turn')=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});reply(promptId,{stopReason:reason});};
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);
 if(r.method==='initialize')reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new')reply(r.id,{sessionId:sid});
 else if(r.method==='session/prompt'){
  promptId=r.id;const text=r.params.prompt.map(x=>x.text??'').join('');
  if(text==='fail'){send({id:r.id,error:{code:-32603,message:'fixture failure'}});continue;}
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'started'}});
  if(text==='permission'){send({id:'permission',method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'edit-1',title:'edit',kind:'edit'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}});continue;}
  if(text==='max'){finish('max_tokens');continue;}
  if(text!=='hang')timer=setTimeout(()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});reply(promptId,{stopReason:'end_turn'})},text==='slow'?250:30);
 }
 else if(r.id==='permission' && r.result){finish();}
 else if(r.method==='session/cancel'){clearTimeout(timer);reply(promptId,{stopReason:'cancelled'});}
}
