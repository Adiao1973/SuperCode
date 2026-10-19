// Synthetic P4-12 ACP: no network, no command execution, no file writes.
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('p412-fixture 1.0');process.exit(0)}
let sid='p412-session',timer,pending;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId:sid,update}});
const text=text=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const call=(id,title,kind,rawInput)=>update({sessionUpdate:'tool_call',toolCallId:id,title,kind,rawInput});
const done=(id,status='completed',content=[],locations=[])=>update({sessionUpdate:'tool_call_update',toolCallId:id,status,content,locations});
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.method==='initialize')reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new')reply(r.id,{sessionId:sid});
 else if(r.method==='session/load'){sid=r.params.sessionId;reply(r.id,{});}
 else if(r.method==='session/prompt') {
  pending=r.id;text('## P4-12 工具详情\n\n下列工具均为合成事件，不执行命令。\n');
  call('shell','执行中文命令','execute',{command:"printf '完整中文\\n'\n# 完整命令尾行\n",cwd:'/tmp/sc-p412/project',flags:[true,null,'中文']});
  done('shell','in_progress');
  setTimeout(()=>{
   done('shell','completed',[{type:'content',content:{type:'text',text:'合成输出第一行\n完整输出尾行\n'}}]);
   call('edit','编辑中文文件','edit',{filePath:'/fixture/normal.ts',oldString:'const title = "旧中文";\n',newString:'const title = "新中文";\nconst ready = true;\n'});
   done('edit','completed');
   call('long','长文件完整对照','edit',{filePath:'/fixture/long.txt',oldString:'旧行\n'.repeat(2500),newString:'中文新行\n'.repeat(2500)});done('long','completed');
   call('disk','write 当前磁盘文件','edit',null);done('disk','completed',[],[{path:'/tmp/sc-p412/project/retry.txt',line:1}]);
   call('fail','合成失败工具','delete',null);done('fail','failed',[{type:'content',content:{type:'text',text:'合成拒绝：没有删除文件。'}}]);
   text('\n## 连续正文\n\n');let n=0;
   timer=setInterval(()=>{text(`独立消息 ${++n}：详情操作不阻塞正文。\n`);if(n===1200){clearInterval(timer);reply(pending,{stopReason:'end_turn'});}},50);
  },650);
 }else if(r.method==='session/cancel'){clearInterval(timer);reply(pending,{stopReason:'cancelled'});}
}
