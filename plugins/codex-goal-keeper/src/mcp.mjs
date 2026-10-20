import readline from 'node:readline';
import { ensureService, request } from './cli.mjs';

const tools = [
  { name: 'goal_keeper_status', description: 'Read Goal Keeper global and per-conversation settings and goal monitoring status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'goal_keeper_switch', description: 'Immediately change globalEnabled or a conversation mode (inherit/on/off). A conversation override takes precedence over the global default.', inputSchema: { type: 'object', properties: { globalEnabled: { type: 'boolean' }, threadId: { type: 'string' }, mode: { type: 'string', enum: ['inherit', 'on', 'off'] } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: 'goal_keeper_open_panel', description: 'Open the Goal Keeper switch panel inside the selected Codex conversation.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];

const ready = ensureService();
ready.catch(() => {});
async function handle(message) {
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codex-goal-keeper', version: '0.1.3' } };
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call') {
    await ready;
    const args = message.params.arguments ?? {};
    const id = args.threadId || process.env.CODEX_THREAD_ID || message.params._meta?.threadId || message.params._meta?.thread_id;
    let output;
    if (message.params.name === 'goal_keeper_status') output = await request('/api/state');
    else if (message.params.name === 'goal_keeper_switch') output = await request('/api/settings', { ...args, ...(args.mode ? { threadId: id } : {}) });
    else if (message.params.name === 'goal_keeper_open_panel') {
      if (!id) throw Error('Provide the current conversation threadId');
      output = await request('/api/open', { threadId: id });
    } else throw Error('Unknown tool');
    result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
  } else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`); return; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch(error => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } })}\n`));
});
