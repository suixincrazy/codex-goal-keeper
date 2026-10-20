import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class AppServer extends EventEmitter {
  constructor(executable, home) {
    super();
    this.executable = executable;
    this.home = home;
    this.pending = new Map();
    this.nextId = 0;
  }

  async start() {
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.home },
    });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const job = this.pending.get(message.id);
        if (job) {
          clearTimeout(job.timer);
          this.pending.delete(message.id);
          if (message.error) job.reject(Error(message.error.message));
          else job.resolve(message.result);
        } else if (message.method) this.emit('notification', message);
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => { this.fail(Error('Codex app-server stopped')); this.emit('disconnect'); });
    await this.request('initialize', {
      clientInfo: { name: 'codex-goal-keeper', version: '0.1.6' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return this;
  }

  request(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  fail(error) {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear();
  }

  close() { this.child?.kill(); }
}
