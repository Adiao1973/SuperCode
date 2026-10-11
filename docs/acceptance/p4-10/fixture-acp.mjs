// P4-10 synthetic ACP: finite 20Hz Markdown replay, no network/key/tools/file writes.
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('p410-fixture 1.0'); process.exit(0); }
let sid=`p410-${process.pid}`, pending, timer;
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const reply = (id,result) => send({id,result});
const message = (text,id='markdown') => send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text}}}});
const sample = '## 中文流式阅读\n\n这是 **增量正文**，`inline` 与中文标点正常。\n\n```typescript\nconst greeting: string = "你好，世界";\nconsole.log(greeting);\n```\n\n| 模型 | 状态 |\n| --- | --- |\n| 合成对端 | 完成 |\n\n[外链确认](https://example.com/p410)\n\n![不会请求的远端图片](https://example.invalid/p410.png)\n\n<script>window.p410Unsafe = true</script>\n\n[危险协议](javascript:alert%281%29)\n\n';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.method==='initialize') reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(r.method==='session/new') reply(r.id,{sessionId:sid});
 else if(r.method==='session/load') {sid=r.params.sessionId;reply(r.id,{});}
 else if(r.method==='session/prompt') {
  pending=r.id;const label=r.params.prompt.map(x=>x.text??'').join('');
  const body=label.includes('长消息') ? sample+'中文原文回退\n'.repeat(24000) : sample+'```json\n'+JSON.stringify({中文:'代码横向滚动'+ '长内容'.repeat(70),ok:true})+'\n```\n\n'+Array.from({length:28},(_,i)=>`- 增量条目 ${i+1}：中文内容，不逐 token 入场。\n`).join('');
  const pieces=Array.from(body); const step=Math.ceil(pieces.length/640);let i=0;
  timer=setInterval(()=>{message(pieces.slice(i,i+step).join(''));i+=step;if(i>=pieces.length){clearInterval(timer);reply(pending,{stopReason:'end_turn'});}},50);
 } else if(r.method==='session/cancel'){clearInterval(timer);reply(pending,{stopReason:'cancelled'});}
}
