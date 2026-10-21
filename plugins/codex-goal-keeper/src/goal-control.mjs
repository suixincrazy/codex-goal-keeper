import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function invokeGoalControl(options, guard = () => true, launch = spawn) {
  if (!guard()) return Promise.resolve(null);
  if (process.platform !== 'win32') return Promise.reject(Error('Native goal controls require Windows'));
  const settingsHash = options.settingsFile && existsSync(options.settingsFile)
    ? createHash('sha256').update(readFileSync(options.settingsFile)).digest('hex') : null;
  return new Promise((resolve, reject) => {
    const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = fileURLToPath(new URL('../scripts/resume-goal.ps1', import.meta.url));
    const child = launch(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false, buffer = '', ready = false;
    function finish(result, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearInterval(cancellation);
      child.kill();
      if (error) reject(error); else resolve(result);
    }
    const timeout = setTimeout(() => finish(null, Error('Native goal control timed out')), 8000);
    const cancellation = setInterval(() => { if (!guard()) finish(null); }, 25);
    child.on('error', error => finish(null, error));
    child.stdin.on('error', error => finish(null, error));
    child.stderr.on('data', () => {});
    child.on('exit', () => { if (!settled) finish(null, Error('Native goal control exited without a result')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { finish(null, Error('Invalid native goal control response')); return; }
        if (message.status === 'ready') {
          if (ready) { finish(null, Error('Duplicate native control readiness')); return; }
          ready = true;
          if (!guard()) { finish(null); return; }
          child.stdin.write(`${options.inspectOnly ? 'inspect' : 'invoke'}\n`);
        } else finish(message);
      }
    });
    child.stdin.write(`${JSON.stringify({ ...options, settingsHash })}\n`);
  });
}
