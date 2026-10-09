// P4-1 local synthetic peer. No model, credentials, tools or filesystem changes.
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('p41-fixture 1.0'); process.exit(0); }
const sid = `p41-fixture-${process.pid}`;
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
const reply = (id, result) => send({ id, result });
const update = x => send({ method: 'session/update', params: { sessionId: sid, update: x } });
let prompt, timer, remaining = 0;
const message = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finish = reason => { clearInterval(timer); reply(prompt, { stopReason: reason ?? 'end_turn' }); };
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  if (r.method === 'initialize') reply(r.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  else if (r.method === 'session/new') reply(r.id, { sessionId: sid });
  else if (r.method === 'session/load') reply(r.id, {});
  else if (r.method === 'session/prompt') {
    prompt = r.id;
    const text = r.params.prompt.map(x => x.text ?? '').join('');
    message('P4-1 合成输出，非真实模型。\n');
    if (text === 'permission') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'p41-edit', title: '查看合成编辑请求', kind: 'edit', status: 'pending', rawInput: { file_path: 'fixture-only.ts', content: '// no file will be written' } });
      send({ id: 'permission', method: 'session/request_permission', params: {
        sessionId: sid, toolCall: { toolCallId: 'p41-edit', title: '查看合成编辑请求', kind: 'edit', rawInput: { file_path: 'fixture-only.ts', content: '// no file will be written' } },
        options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝一次', kind: 'reject_once' }]
      } });
    } else if (text === 'stream') {
      remaining = 900;
      timer = setInterval(() => {
        message(`流式片段 ${900 - remaining}：中文、**Markdown** 与阅读位置。\n`);
        if (--remaining === 0) finish();
      }, 50);
    } else { message('## 合成结果\n- 审阅完毕\n```ts\nconst ready = true;\n```\n'); finish(); }
  } else if (r.method === 'session/cancel') finish('cancelled');
  else if (r.id === 'permission' && r.result) {
    const accepted = r.result.outcome?.optionId === 'allow';
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'p41-edit', status: accepted ? 'completed' : 'failed' });
    message(accepted ? '已允许（fixture 不写文件）。' : '已拒绝（fixture 不写文件）。');
    finish();
  }
}
