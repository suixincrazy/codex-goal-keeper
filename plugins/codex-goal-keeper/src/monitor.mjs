import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function canContinue(goal, snapshot, enabled, pluginId) {
  return enabled && goal?.status === 'blocked' && snapshot &&
    !snapshot.running && snapshot.pendingRequests === 0 &&
    snapshot.goalStatus === 'blocked' &&
    !snapshot.disabledPluginIds?.includes(pluginId);
}

function goalKey(goal) { return goal.goal_id ?? `${goal.threadId}:${goal.createdAt}`; }
function blockedKey(goal) { return `${goalKey(goal)}:${goal.updated_at_ms ?? goal.updatedAt}`; }

export class Monitor extends EventEmitter {
  constructor({ home, settings, desktop, rpc, pluginId, readGoals }) {
    super();
    Object.assign(this, { home, settings, desktop, rpc, pluginId });
    this.readGoals = readGoals ?? (() => this.databaseGoals());
    this.goals = new Map();
    this.records = new Map();
    this.inFlight = new Set();
    this.completed = new Set();
    this.settings.on('change', () => {
      for (const record of this.records.values()) record.retryAt = 0;
      this.emit('change'); this.kick();
    });
    this.desktop.on('snapshot', state => {
      if (state.goalStatus === 'complete') {
        const goal = this.goals.get(state.id);
        if (goal) this.completed.add(goalKey(goal));
        this.setRecord(state.id, { phase: 'complete', status: 'complete' });
        this.desktop.unwatch(state.id);
      }
    });
    this.desktop.on('changed', () => this.kick());
  }

  databaseGoals() {
    const file = join(this.home, 'goals_1.sqlite');
    if (!existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT thread_id, goal_id, status, created_at_ms, updated_at_ms FROM thread_goals').all(); }
    finally { db.close(); }
  }

  setRecord(id, patch) {
    const record = { ...this.records.get(id), ...patch };
    this.records.set(id, record);
    this.emit('change');
    return record;
  }

  kick() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }

  async tick() {
    if (this.closed) return;
    if (this.ticking) { this.again = true; return; }
    this.ticking = true;
    try {
      const rows = this.readGoals();
      const seen = new Set();
      for (const raw of rows) {
        const goal = { ...raw, threadId: raw.thread_id ?? raw.threadId };
        const id = goal.threadId;
        seen.add(id);
        this.goals.set(id, goal);
        if (goal.status === 'complete' || this.completed.has(goalKey(goal))) {
          this.completed.add(goalKey(goal));
          this.setRecord(id, { status: 'complete', phase: 'complete' });
          this.desktop.unwatch(id);
        } else if (!this.settings.enabled(id)) {
          this.setRecord(id, { status: goal.status, phase: 'disabled' });
          this.desktop.unwatch(id);
        } else if (goal.status === 'blocked') {
          if (!this.inFlight.has(id)) {
            this.inFlight.add(id);
            this.evaluate(goal).catch(() => this.setRecord(id, { phase: 'retrying', retryAt: Date.now() + 5000 }))
              .finally(() => this.inFlight.delete(id));
          }
        } else this.setRecord(id, { status: goal.status, phase: goal.status === 'active' ? 'watching' : 'waiting' });
      }
      for (const id of this.goals.keys()) {
        if (!seen.has(id)) {
          this.goals.delete(id);
          const complete = this.records.get(id)?.phase === 'complete';
          this.setRecord(id, { status: complete ? 'complete' : null, phase: complete ? 'complete' : 'no-goal' });
          this.desktop.unwatch(id);
        }
      }
    } catch {
      this.emit('unavailable');
    } finally {
      this.ticking = false;
      if (!this.closed) this.timer = setTimeout(() => this.tick(), this.again ? 0 : 1500);
      this.again = false;
    }
  }

  async evaluate(observed) {
    const id = observed.threadId;
    const key = blockedKey(observed);
    const record = this.records.get(id) ?? {};
    if (record.retryAt > Date.now()) return;
    if (record.sentKey === key && record.sentAt > Date.now() - 1500) return;
    if (!this.settings.enabled(id)) return;
    const revision = this.settings.revision;
    const guard = () => !this.closed && revision === this.settings.revision && this.settings.enabled(id) && !this.completed.has(goalKey(observed));
    this.setRecord(id, { status: 'blocked', phase: 'checking' });
    await this.desktop.connect();
    if (!guard()) return;
    let snapshot;
    try { snapshot = await this.desktop.snapshot(id); }
    catch { this.setRecord(id, { status: 'blocked', phase: 'waiting-desktop', retryAt: Date.now() + 5000 }); return; }
    if (!guard()) return;
    if (!canContinue(observed, snapshot, true, this.pluginId)) {
      this.setRecord(id, { status: 'blocked', phase: snapshot.running ? 'running' : 'waiting' });
      return;
    }
    const { goal } = await this.rpc.request('thread/goal/get', { threadId: id });
    if (!guard() || !goal || goal.status !== 'blocked' || (observed.created_at_ms != null && goal.createdAt !== Math.floor(observed.created_at_ms / 1000))) return;
    this.setRecord(id, { phase: 'continuing' });
    if (!guard()) return;
    try {
      const result = await this.desktop.resumeGoal(id, guard, { objective: goal.objective, settingsFile: this.settings.file, pluginId: this.pluginId });
      if (result?.status !== 'clicked') {
        if (guard()) this.setRecord(id, { status: 'blocked', phase: 'waiting-desktop', retryAt: Date.now() + 5000 });
        return;
      }
      if (!guard()) return;
      this.setRecord(id, { status: 'active', phase: 'running', sentKey: key, sentAt: Date.now(), retryAt: 0, continuedAt: Date.now() });
      this.emit('continued', id);
    } catch {
      const after = await this.desktop.snapshot(id).catch(() => null);
      if (!guard()) return;
      if (after?.running || after?.goalStatus === 'active') {
        this.setRecord(id, { status: 'active', phase: 'running', sentKey: key, sentAt: Date.now(), retryAt: 0, continuedAt: Date.now() });
      } else {
        this.setRecord(id, { status: 'blocked', phase: 'retrying', retryAt: Date.now() + 5000 });
      }
    }
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
