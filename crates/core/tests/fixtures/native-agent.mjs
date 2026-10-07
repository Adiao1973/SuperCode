import readline from 'node:readline';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
const mode=process.argv[2]??'ok';
if(process.argv[3]){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[3],JSON.stringify([process.pid,child.pid]));}
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const response=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params:{threadId:'thread-native',turnId:'turn-native',...params}});
const complete=(status='completed')=>notify('turn/completed',{turn:{id:'turn-native',status,error:status==='failed'?{message:'secret-fixture-error'}:null}});
let initialized=false,awaiting=false,requests=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize'){
  if(mode==='init-hang')return;
  if(mode==='init-fail'){send({id:r.id,error:{code:-32600,message:'secret-fixture-error'}});return;}
  if(r.params.capabilities.experimentalApi!==false)process.exit(2);
  response(r.id,{userAgent:'fixture/1'});
 }else if(r.method==='initialized')initialized=true;
 else if(r.method==='thread/start'||r.method==='thread/resume'){
  if(!initialized||r.params.approvalPolicy!=='untrusted'||r.params.sandbox!=='read-only'||r.params.approvalsReviewer!=='user')process.exit(3);
  if(r.method==='thread/resume')notify('codex/event/session_configured',{turnId:'historical-turn'});
  response(r.id,{thread:{id:mode==='load-mismatch'?'wrong-thread':'thread-native'},cwd:r.params.cwd,approvalPolicy:'untrusted',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 }else if(r.method==='turn/start'){
  if(mode==='eof')process.exit(0);
  if(mode==='empty-delta')notify('item/agentMessage/delta',{itemId:'msg',delta:''});
  if(mode==='bad'){process.stdout.write('not JSON secret-fixture-error\n');return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(4*1024*1024+1)+'\n');return;}
  notify('turn/started',{turn:{id:'turn-native',status:'inProgress'}});
  response(r.id,{turn:{id:'turn-native',status:'inProgress'}});
  if(mode==='envelope'){send({});return;}
  if(mode==='hang'||mode==='stubborn')return;
  if(mode==='foreign'){notify('item/agentMessage/delta',{threadId:'foreign',itemId:'msg',delta:'BAD'});return;}
  if(mode==='wrong-turn'){notify('turn/completed',{turn:{id:'other',status:'completed'}});return;}
  if(mode==='unknown'){send({id:'server-unknown',method:'item/permissions/requestApproval',params:{threadId:'thread-native',turnId:'turn-native'}});return;}
  if(mode==='approval'||mode==='bad-decision'){
   awaiting=true;
   send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'thread-native',turnId:'turn-native',itemId:'tool-1',command:'printf fixture',cwd:r.params.cwd}});return;
  }
  notify('item/started',{item:{id:'tool-1',type:'commandExecution',command:'printf fixture',status:'inProgress'}});
  notify('item/completed',{item:{id:'tool-1',type:'commandExecution',status:'completed',aggregatedOutput:'fixture'}});
  notify('item/reasoning/summaryTextDelta',{itemId:'thinking',delta:'thinking'});
  notify('item/agentMessage/delta',{itemId:'msg',delta:'hello'});
  notify('item/completed',{item:{id:'msg',type:'agentMessage',text:'hello'}});
  complete(mode==='failed'?'failed':mode==='interrupted'?'interrupted':'completed');
 }else if(r.method==='turn/interrupt'){
  response(r.id,{}); if(mode!=='stubborn')complete('interrupted');
 }else if(r.id==='approval-1' && awaiting){
  if(!['accept','decline'].includes(r.result?.decision))process.exit(4);
  awaiting=false;requests++;
  notify('item/agentMessage/delta',{itemId:'decision',delta:r.result.decision});
  send({id:'approval-2',method:'item/fileChange/requestApproval',params:{threadId:'thread-native',turnId:'turn-native',itemId:'tool-1'}});
 }else if(r.id==='approval-2'){
  notify('item/agentMessage/delta',{itemId:'decision-2',delta:r.result.decision});complete();
 }
});
