import test from 'node:test';
import assert from 'node:assert/strict';
import { Desktop } from '../plugins/codex-goal-keeper/src/desktop.mjs';

test('continuation invokes the native goal control without starting a message turn', async () => {
  const desktop = new Desktop();
  desktop.owners.set('old-conversation', 'owner');
  const calls = [];
  desktop.snapshot = async () => ({ title: 'Old conversation', goalStatus: 'blocked', running: false, pendingRequests: 0, lastTurnId: 'previous-turn' });
  desktop.showConversation = async () => ({});
  desktop.request = async (method, params) => { calls.push({ method, params }); return {}; };
  desktop.invokeGoalControl = async (options, guard) => { calls.push({ control: 'resume-goal', id: 'old-conversation' }); return guard() ? { status: 'clicked' } : null; };
  await desktop.resumeGoal('old-conversation');
  assert.deepEqual(calls, [{ control: 'resume-goal', id: 'old-conversation' }]);
});

test('switch off while showing a conversation prevents the native click', async () => {
  const desktop = new Desktop();
  let enabled = true, clicks = 0;
  desktop.snapshot = async () => ({ title: 'Old conversation', goalStatus: 'blocked', running: false, pendingRequests: 0, lastTurnId: 'previous-turn' });
  desktop.showConversation = async () => { enabled = false; return {}; };
  desktop.invokeGoalControl = async () => { clicks++; return { status: 'clicked' }; };
  assert.equal(await desktop.resumeGoal('old-conversation', () => enabled), null);
  assert.equal(clicks, 0);
});

test('fresh running turns, pending requests, changed goals, and limits prevent a native click', async () => {
  for (const state of [{ running: true }, { pendingRequests: 1 }, { goalStatus: 'complete' }, { goalStatus: 'paused' },
    { goalStatus: 'usageLimited' }, { goalStatus: 'budgetLimited' }, { persisted: true }, { goalObjective: 'Another goal' }, { disabledPluginIds: ['test-plugin'] }]) {
    const desktop = new Desktop();
    let snapshots = 0, clicks = 0;
    const base = { title: 'Old conversation', goalStatus: 'blocked', goalObjective: 'Original goal', running: false, pendingRequests: 0, lastTurnId: 'previous-turn' };
    desktop.snapshot = async () => ({ ...base, ...(snapshots++ ? state : {}) });
    desktop.showConversation = async () => ({});
    desktop.invokeGoalControl = async () => { clicks++; return { status: 'clicked' }; };
    assert.equal(await desktop.resumeGoal('old-conversation', () => true, { objective: 'Original goal', pluginId: 'test-plugin' }), null);
    assert.equal(clicks, 0);
  }
});

test('different conversation goal controls are serialized and recheck cancellation', async () => {
  const desktop = new Desktop();
  let release, enabled = true;
  const shown = [];
  desktop.snapshot = async () => ({ title: 'Conversation', goalStatus: 'blocked', running: false, pendingRequests: 0, lastTurnId: 'previous-turn' });
  desktop.showConversation = async id => { shown.push(id); return {}; };
  desktop.invokeGoalControl = () => new Promise(resolve => { release = resolve; });
  const first = desktop.resumeGoal('first');
  const second = desktop.resumeGoal('second', () => enabled);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, ['first']);
  enabled = false;
  release({ status: 'clicked' });
  assert.equal((await first).status, 'clicked');
  assert.equal(await second, null);
  assert.deepEqual(shown, ['first']);
});
