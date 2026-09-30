// Deterministic ACP peer: no model, credentials, filesystem writes, or network.
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const sessionId = 'claude-fixture-session';
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
let promptId;
for await (const line of lines) {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      reply(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: process.argv[2] !== 'no-load' }, authMethods: [] });
      break;
    case 'session/new':
      reply(request.id, { sessionId });
      break;
    case 'session/load':
      if (request.params.sessionId !== sessionId) throw new Error('wrong resume id');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } });
      reply(request.id, {});
      break;
    case 'session/prompt':
      if (process.argv[2] === 'empty') {
        reply(request.id, { stopReason: 'end_turn' });
        break;
      }
      promptId = request.id;
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Write hello.txt', kind: 'edit', status: 'pending', rawInput: { file_path: '/tmp/hello.txt', content: 'hi' } });
      send({ id: 'permission-1', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'edit-1', title: 'Write hello.txt', kind: 'edit' },
        options: [ { optionId: 'accept', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' } ]
      } });
      break;
    default:
      if (request.id === 'permission-1') {
        const accepted = request.result?.outcome?.optionId === 'accept';
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: accepted ? 'completed' : 'failed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: accepted ? 'hi' : 'denied' } });
        reply(promptId, { stopReason: 'end_turn' });
      }
  }
}
