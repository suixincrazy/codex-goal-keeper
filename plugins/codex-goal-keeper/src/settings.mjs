import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const THREAD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function effectiveEnabled(globalEnabled, mode = 'inherit') {
  return mode === 'on' || (mode === 'inherit' && globalEnabled);
}

export class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.revision = 0;
    this.value = { version: 1, globalEnabled: true, conversations: {} };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof saved.globalEnabled === 'boolean') this.value.globalEnabled = saved.globalEnabled;
      for (const [id, mode] of Object.entries(saved.conversations ?? {})) {
        if (THREAD_ID.test(id) && ['on', 'off'].includes(mode)) this.value.conversations[id] = mode;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  mode(id) { return this.value.conversations[id] ?? 'inherit'; }
  enabled(id) { return effectiveEnabled(this.value.globalEnabled, this.mode(id)); }

  change({ globalEnabled, threadId, mode }) {
    if (globalEnabled !== undefined && typeof globalEnabled !== 'boolean') throw Error('globalEnabled must be boolean');
    if (mode !== undefined && (!THREAD_ID.test(threadId ?? '') || !['inherit', 'on', 'off'].includes(mode))) {
      throw Error('A valid threadId and inherit/on/off mode are required');
    }
    const next = structuredClone(this.value);
    if (globalEnabled !== undefined) next.globalEnabled = globalEnabled;
    if (mode === 'inherit') delete next.conversations[threadId];
    else if (mode !== undefined) next.conversations[threadId] = mode;
    if (JSON.stringify(next) === JSON.stringify(this.value)) return this.value;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
    this.value = next;
    this.revision++;
    this.emit('change');
    return this.value;
  }
}
