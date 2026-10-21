import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeGoalControl } from '../plugins/codex-goal-keeper/src/goal-control.mjs';

test('Windows native goal invocation, identity checks, and hot cancellation', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const fixturePath = fileURLToPath(new URL('./fixtures/native-goal.ps1', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], { windowsHide: true });
  t.after(() => child.kill());
  let clicks = 0, fixturePid, buffer = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error(`Native fixture did not start: ${errors}`)), 10000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(deadline); reject(Error(`Native fixture exited: ${errors}`)); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.event === 'ready') { fixturePid = message.pid; clearTimeout(deadline); resolve(); }
        if (message.event === 'clicked') clicks++;
      }
    });
  });
  const options = { title: 'Goal Keeper regression fixture', objective: 'Verify native goal continuation', processId: fixturePid };
  assert.equal((await invokeGoalControl({ ...options, inspectOnly: true })).status, 'available');
  assert.equal(clicks, 0);
  assert.equal((await invokeGoalControl(options)).status, 'clicked');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(clicks, 1);
  assert.equal((await invokeGoalControl({ ...options, objective: 'Different goal' })).status, 'unavailable');
  assert.equal(clicks, 1);

  const directory = mkdtempSync(join(tmpdir(), 'goal-keeper-native-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsFile = join(directory, 'state.json');
  writeFileSync(settingsFile, '{"globalEnabled":true}');
  const changeAtReadiness = (command, args, config) => {
    const adapter = spawn(command, args, config);
    adapter.stdout.on('data', chunk => {
      if (chunk.toString().includes('"ready"')) writeFileSync(settingsFile, '{"globalEnabled":false}');
    });
    return adapter;
  };
  assert.equal((await invokeGoalControl({ ...options, settingsFile }, () => true, changeAtReadiness)).status, 'cancelled');
  assert.equal(clicks, 1);

  let enabled = true;
  const disableAtReadiness = (command, args, config) => {
    const adapter = spawn(command, args, config);
    adapter.stdout.on('data', chunk => { if (chunk.toString().includes('"ready"')) enabled = false; });
    return adapter;
  };
  assert.equal(await invokeGoalControl(options, () => enabled, disableAtReadiness), null);
  assert.equal(clicks, 1);
});
