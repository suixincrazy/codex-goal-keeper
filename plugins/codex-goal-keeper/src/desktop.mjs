import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import net from 'node:net';

const PIPE = '\\\\.\\pipe\\codex-ipc';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const data = Buffer.allocUnsafe(body.length + 4);
  data.writeUInt32LE(body.length, 0);
  body.copy(data, 4);
  return data;
}

function decode(socket, callback) {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size > 64 * 1024 * 1024) { socket.destroy(Error('Invalid IPC frame')); return; }
      if (buffer.length < size + 4) return;
      const body = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      try { callback(JSON.parse(body)); } catch (error) { socket.destroy(error); return; }
    }
  });
}

export function compactSnapshot(state) {
  const turns = [...(state.turns ?? []), ...Object.values(state.turnHistory?.history?.entitiesByKey ?? {})]
    .filter(turn => turn.turnId).sort((a, b) => (b.turnStartedAtMs ?? 0) - (a.turnStartedAtMs ?? 0));
  const latest = turns[0];
  return {
    id: state.id,
    goalStatus: state.threadGoal?.status ?? (state.completedThreadGoal ? 'complete' : null),
    goalCreatedAt: state.threadGoal?.createdAt ?? state.completedThreadGoal?.createdAt,
    runtime: state.threadRuntimeStatus?.type,
    pendingRequests: Array.isArray(state.requests) ? state.requests.length : Object.keys(state.requests ?? {}).length,
    running: state.threadRuntimeStatus?.type === 'active' || turns.some(turn => turn.status === 'inProgress'),
    lastTurnId: latest?.turnId,
    lastTurnStatus: latest?.status,
    clientUserMessageId: latest?.params?.clientUserMessageId ?? state.latestTurnStartMessageId,
    model: state.latestModel,
    effort: state.latestReasoningEffort,
    disabledPluginIds: state.latestThreadSettings?.disabledPluginIds ?? [],
  };
}

export class Desktop extends EventEmitter {
  constructor(rpc) {
    super();
    this.rpc = rpc;
    this.pending = new Map();
    this.waiters = new Map();
    this.owners = new Map();
    this.snapshots = new Map();
    this.clientId = 'initializing-client';
  }

  async connect() {
    if (this.connected) return;
    this.socket = net.createConnection(PIPE);
    decode(this.socket, message => {
      if (message.type === 'response') {
        const job = this.pending.get(message.requestId);
        if (!job) return;
        clearTimeout(job.timer);
        this.pending.delete(message.requestId);
        if (message.resultType === 'success') job.resolve(message);
        else job.reject(Error(message.error ?? 'Desktop request failed'));
      } else if (message.method === 'thread-stream-state-changed') {
        const id = message.params.conversationId;
        if (message.params.change?.type === 'snapshot') {
          const snapshot = compactSnapshot(message.params.change.conversationState);
          this.snapshots.set(id, snapshot);
          const job = this.waiters.get(id);
          if (job) { clearTimeout(job.timer); this.waiters.delete(id); job.resolve(snapshot); }
          this.emit('snapshot', snapshot);
        } else this.emit('changed', id);
      } else if (message.method === 'ipc-connection-reset') this.socket.destroy();
    });
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      this.connected = false;
      this.owners.clear();
      this.snapshots.clear();
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(Error('Desktop disconnected')); }
      for (const job of this.waiters.values()) { clearTimeout(job.timer); job.reject(Error('Desktop disconnected')); }
      this.pending.clear(); this.waiters.clear();
      this.emit('disconnect');
    });
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    const result = await this.request('initialize', { clientType: 'desktop' }, 0);
    this.clientId = result.result.clientId;
    this.connected = true;
  }

  request(method, params, version = 1, targetClientId, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error(`${method} timed out`)); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frame({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version, ...(targetClientId ? { targetClientId } : {}) }));
    });
  }

  async owner(id) {
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1, undefined, 800);
    this.owners.set(id, response.handledByClientId);
    return response.handledByClientId;
  }

  async snapshot(id) {
    let owner;
    try { owner = this.owners.get(id) ?? await this.owner(id); }
    catch (error) {
      if (!this.rpc) throw error;
      return this.persistedSnapshot(id);
    }
    if (this.waiters.has(id)) return this.waiters.get(id).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => { this.waiters.delete(id); reject(Error('Desktop snapshot timed out')); }, 3000);
    this.waiters.set(id, { promise, resolve, reject, timer });
    this.socket.write(frame({
      type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [owner],
      params: { hostId: 'local', conversationId: id, following: true },
    }));
    try { return await promise; }
    catch (error) {
      this.owners.delete(id);
      if (!this.rpc) throw error;
      return this.persistedSnapshot(id);
    }
  }

  async persistedSnapshot(id) {
    const [{ thread }, turns] = await Promise.all([
      this.rpc.request('thread/read', { threadId: id, includeTurns: false }),
      this.rpc.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc' }),
    ]);
    const latest = turns.data?.[0];
    return {
      id, persisted: true, running: latest?.status === 'inProgress', pendingRequests: 0,
      lastTurnId: latest?.id, lastTurnStatus: latest?.status, model: thread.model, effort: thread.reasoningEffort,
      disabledPluginIds: thread.extra?.disabledPluginIds ?? [],
    };
  }

  unwatch(id) {
    const owner = this.owners.get(id);
    if (owner && this.connected) this.socket.write(frame({
      type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [owner],
      params: { hostId: 'local', conversationId: id, following: false },
    }));
    this.snapshots.delete(id);
    this.owners.delete(id);
  }

  async startTurn(id, messageId, guard = () => true) {
    let owner;
    try { owner = this.owners.get(id) ?? await this.owner(id); }
    catch (error) {
      if (!this.rpc) throw error;
      const snapshot = await this.persistedSnapshot(id);
      if (!guard() || snapshot.running || !snapshot.lastTurnId) return null;
      return callAppTool(id, snapshot.lastTurnId, 'send_message_to_thread', {
        threadId: id, hostId: 'local', prompt: '继续完成当前目标。检查已完成的工作与停滞原因，继续仍未完成且已获授权的工作，直到目标实际完成。',
      });
    }
    if (!guard()) return null;
    return this.request('thread-follower-start-turn', {
      conversationId: id,
      turnStart: {
        request: {
          threadId: id,
          input: [{ type: 'text', text: '继续完成当前目标。检查已经完成的工作与停滞原因，继续仍未完成且已获授权的工作，直到目标实际完成。', text_elements: [] }],
          clientUserMessageId: messageId,
        },
        context: { inheritThreadSettings: true },
      },
    }, 2, owner, 15000);
  }

  close() {
    for (const id of this.owners.keys()) this.unwatch(id);
    this.socket?.destroy();
  }
}

export function appToolsPipe() {
  const paths = readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith('codex-app-tools-'));
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH && paths.includes(process.env.CODEX_APP_TOOLS_PIPE_PATH.split('\\').at(-1))) return process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (paths.length !== 1) throw Error('A single running Codex desktop is required');
  return `\\\\.\\pipe\\${paths[0]}`;
}

export function callAppTool(threadId, turnId, tool, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(appToolsPipe());
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Codex panel request timed out')); }, 8000);
    socket.once('connect', () => socket.write(frame({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        arguments: args, callerSource: 'codex', callId: randomUUID(), namespace: 'codex_app',
        threadId, turnId, hostId: 'local', tool,
      },
    })));
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    decode(socket, message => {
      clearTimeout(timer); socket.destroy();
      if (message.error) reject(Error(message.error.message));
      else if (message.result?.success === false) reject(Error('Codex panel request was rejected'));
      else resolve(message.result);
    });
  });
}
