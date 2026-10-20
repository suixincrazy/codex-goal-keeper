import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings, effectiveEnabled } from '../plugins/codex-goal-keeper/src/settings.mjs';
import { Monitor, canContinue } from '../plugins/codex-goal-keeper/src/monitor.mjs';
import { compactSnapshot, Desktop } from '../plugins/codex-goal-keeper/src/desktop.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'goal-keeper-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = new Settings(join(directory, 'state.json'));
  const desktop = new EventEmitter();
  desktop.connect = async () => {};
  let snapshot = { id: 'test-thread', goalStatus: 'blocked', running: false, pendingRequests: 0, disabledPluginIds: [] };
  desktop.snapshot = async () => snapshot;
  desktop.unwatch = () => {};
  const turns = [];
  desktop.startTurn = async (id, messageId, guard) => { if (guard()) { turns.push({ id, messageId }); return {}; } return null; };
  let goal = { threadId: 'test-thread', createdAt: 1000, updatedAt: 1001, status: 'blocked' };
  const calls = [];
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/goal/set') goal = { ...goal, status: params.status, updatedAt: goal.updatedAt + 1 };
    return { goal: structuredClone(goal) };
  } };
  const monitor = new Monitor({ home: directory, settings, desktop, rpc, pluginId: 'test-plugin', readGoals: () => [] });
  monitor.kick = () => {};
  t.after(() => monitor.close());
  const observed = { threadId: 'test-thread', thread_id: 'test-thread', goal_id: 'test-goal', created_at_ms: 1000000, updated_at_ms: 1001000, status: 'blocked' };
  monitor.goals.set(observed.threadId, observed);
  return { settings, desktop, rpc, monitor, observed, turns, calls, getGoal: () => goal, setSnapshot: value => { snapshot = { ...snapshot, ...value }; } };
}

test('conversation overrides take precedence for every global switch combination', () => {
  for (const global of [true, false]) {
    assert.equal(effectiveEnabled(global, 'inherit'), global);
    assert.equal(effectiveEnabled(global, 'on'), true);
    assert.equal(effectiveEnabled(global, 'off'), false);
  }
});

test('switch settings persist across service restarts', t => {
  const f = fixture(t);
  f.settings.change({ globalEnabled: false, threadId: 'test-thread', mode: 'on' });
  const restored = new Settings(f.settings.file);
  assert.equal(restored.enabled('test-thread'), true);
  assert.equal(restored.enabled('another-thread'), false);
  restored.change({ threadId: 'test-thread', mode: 'inherit' });
  assert.equal(restored.enabled('test-thread'), false);
});

test('blocked idle goal is activated and continued exactly once', async t => {
  const f = fixture(t);
  await f.monitor.evaluate(f.observed);
  assert.equal(f.turns.length, 1);
  assert.equal(f.getGoal().status, 'active');
  await f.monitor.evaluate(f.observed);
  assert.equal(f.turns.length, 1);
});

test('only blocked goals are eligible; active, complete, limits and pauses wait', () => {
  const snapshot = { running: false, pendingRequests: 0, disabledPluginIds: [] };
  for (const status of ['active', 'paused', 'complete', 'usageLimited', 'budgetLimited', null]) assert.equal(Boolean(canContinue({ status }, snapshot, true, 'test-plugin')), false);
  assert.equal(Boolean(canContinue({ status: 'blocked' }, snapshot, true, 'test-plugin')), true);
});

test('running turns, user requests, and a native plugin disable prevent continuation', async t => {
  const f = fixture(t);
  for (const value of [{ running: true }, { running: false, pendingRequests: 1 }, { pendingRequests: 0, disabledPluginIds: ['test-plugin'] }]) {
    f.setSnapshot(value); await f.monitor.evaluate(f.observed);
  }
  assert.equal(f.turns.length, 0);
  assert.equal(f.calls.filter(call => call.method === 'thread/goal/set').length, 0);
});

test('a global disable during snapshot cancels a pending continuation', async t => {
  const f = fixture(t);
  let release;
  f.desktop.snapshot = () => new Promise(resolve => { release = resolve; });
  const work = f.monitor.evaluate(f.observed);
  await new Promise(resolve => setImmediate(resolve));
  f.settings.change({ globalEnabled: false });
  release({ running: false, pendingRequests: 0, disabledPluginIds: [] });
  await work;
  assert.equal(f.turns.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a conversation disable after activation restores blocked and sends no turn', async t => {
  const f = fixture(t);
  const original = f.rpc.request;
  f.rpc.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/goal/set' && params.status === 'active') f.settings.change({ threadId: 'test-thread', mode: 'off' });
    return result;
  };
  await f.monitor.evaluate(f.observed);
  assert.equal(f.turns.length, 0);
  assert.equal(f.getGoal().status, 'blocked');
});

test('conversation on continues even when global is off', async t => {
  const f = fixture(t);
  f.settings.change({ globalEnabled: false, threadId: 'test-thread', mode: 'on' });
  await f.monitor.evaluate(f.observed);
  assert.equal(f.turns.length, 1);
});

test('a later blocked transition starts a second continuation', async t => {
  const f = fixture(t);
  await f.monitor.evaluate(f.observed);
  await f.rpc.request('thread/goal/set', { threadId: 'test-thread', status: 'blocked' });
  await f.monitor.evaluate({ ...f.observed, updated_at_ms: 1004000 });
  assert.equal(f.turns.length, 2);
  assert.notEqual(f.turns[0].messageId, f.turns[1].messageId);
});

test('completion remains visible after the desktop clears the persisted goal', async t => {
  const f = fixture(t);
  f.desktop.emit('snapshot', { id: 'test-thread', goalStatus: 'complete' });
  await f.monitor.tick();
  assert.equal(f.monitor.records.get('test-thread').status, 'complete');
  assert.equal(f.monitor.records.get('test-thread').phase, 'complete');
  assert.equal(f.turns.length, 0);
});

test('completion cancels an in-flight pending check and drops its subscription', async t => {
  const f = fixture(t);
  let unwatch = 0;
  f.desktop.unwatch = () => unwatch++;
  f.desktop.snapshot = async () => {
    f.desktop.emit('snapshot', { id: 'test-thread', goalStatus: 'complete' });
    return { goalStatus: 'complete', running: false, pendingRequests: 0 };
  };
  await f.monitor.evaluate(f.observed);
  assert.equal(f.turns.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(unwatch, 1);
  assert.equal(f.monitor.records.get('test-thread').phase, 'complete');
});

test('paginated history detects active turns without storing message contents', () => {
  const result = compactSnapshot({ id: 'test-thread', requests: [], threadRuntimeStatus: { type: 'idle' }, threadGoal: { status: 'blocked' }, turnHistory: { history: { entitiesByKey: { key: { turnId: 'turn-1', status: 'inProgress', turnStartedAtMs: 3, items: [{ text: 'private-message' }] } } } } });
  assert.equal(result.running, true);
  assert.equal(result.lastTurnId, 'turn-1');
  assert.equal(JSON.stringify(result).includes('private-message'), false);
});

test('parallel goal checks share a single desktop connection attempt', async () => {
  const desktop = new Desktop();
  let connections = 0, release;
  desktop.openConnection = async () => {
    connections++;
    await new Promise(resolve => { release = resolve; });
    desktop.connected = true;
  };
  const first = desktop.connect(), second = desktop.connect();
  assert.equal(connections, 1);
  release();
  await Promise.all([first, second]);
  await desktop.connect();
  assert.equal(connections, 1);
});

test('stopping during a monitor tick does not schedule another check', async t => {
  const f = fixture(t);
  f.monitor.readGoals = () => { f.monitor.close(); return []; };
  await f.monitor.tick();
  assert.equal(f.monitor.timer, undefined);
  assert.equal(f.monitor.closed, true);
});
