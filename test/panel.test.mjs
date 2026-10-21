import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { panelTabId, startService } from '../plugins/codex-goal-keeper/src/service.mjs';

const THREAD = 'old-conversation';

async function fixture(t, tabs = new Map()) {
  const home = mkdtempSync(join(tmpdir(), 'goal-keeper-panel-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, title TEXT, archived INTEGER, source TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, 0, ?, 1)').run(THREAD, 'Old conversation', 'cli');
  db.close();
  const desktop = new EventEmitter();
  desktop.connect = async () => { desktop.connected = true; };
  desktop.snapshot = async id => ({ id, lastTurnId: 'previous-turn', running: false, pendingRequests: 0 });
  desktop.unwatch = () => {};
  desktop.close = () => {};
  const rpc = { start: async () => {}, close: () => {} };
  const calls = [];
  let sequence = 0;
  const openTab = async (id, turn, tool, args) => {
    calls.push({ id, turn, tool, args });
    const key = args.target.tabId ?? `new-tab-${++sequence}`;
    tabs.set(key, args.target.url);
    return { status: 'queued', tabId: key };
  };
  const service = await startService({ home, dataDir: join(home, 'data'), port: 0, rpc, desktop, openTab });
  t.after(() => service.close());
  await new Promise(resolve => setImmediate(resolve));
  return { service, tabs, calls };
}

test('startup does not queue panels for hidden old conversations', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0, 'Opening a historical chat must not flush startup panel requests');
});

test('repeated and concurrent panel requests reuse one conversation tab', async t => {
  const f = await fixture(t);
  await Promise.all([f.service.panel(THREAD), f.service.panel(THREAD), f.service.panel(THREAD)]);
  assert.equal(f.tabs.size, 1);
  await f.service.panel(THREAD);
  assert.equal(f.tabs.size, 1);
});

test('service restart reuses the tab identity saved by Codex', async t => {
  const tabs = new Map();
  const first = await fixture(t, tabs);
  await first.service.panel(THREAD);
  first.service.close();
  const second = await fixture(t, tabs);
  await second.service.panel(THREAD);
  assert.equal(tabs.size, 1);
});

test('tab identity is stable, valid, and distinct for each conversation', () => {
  assert.equal(panelTabId(THREAD), panelTabId(THREAD));
  assert.match(panelTabId(THREAD), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(panelTabId(THREAD), panelTabId('another-conversation'));
});
