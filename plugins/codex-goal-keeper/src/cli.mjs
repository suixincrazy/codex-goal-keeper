import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService } from './service.mjs';

export const home = process.env.CODEX_HOME || join(homedir(), '.codex');
export const dataDir = process.env.GOAL_KEEPER_DATA_DIR || join(home, 'goal-keeper');
const endpointFile = join(dataDir, 'endpoint.json');
const thisFile = fileURLToPath(import.meta.url);

export function findCodex() {
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) return process.env.CODEX_CLI_PATH;
  const root = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
  if (existsSync(root)) {
    const candidates = readdirSync(root).map(name => join(root, name, 'codex.exe')).filter(existsSync);
    if (candidates.length) return candidates.at(-1);
  }
  return 'codex';
}

export async function endpoint() {
  const saved = JSON.parse(readFileSync(endpointFile, 'utf8'));
  const response = await fetch(`${saved.url}/api/state`, { headers: { Authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw Error('Goal Keeper is unavailable');
  return saved;
}

export async function ensureService() {
  try { return await endpoint(); } catch {}
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [thisFile, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CODEX_HOME: home, GOAL_KEEPER_DATA_DIR: dataDir } });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try { return await endpoint(); } catch {}
  }
  throw Error('Goal Keeper could not start');
}

export async function request(path, body) {
  const saved = await ensureService();
  const response = await fetch(`${saved.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${saved.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw Error(result.error || `Goal Keeper request failed (${response.status})`);
  return result;
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'serve') {
    try { await endpoint(); return; } catch {}
    const executable = findCodex();
    const service = await startService({ home, dataDir, executable });
    process.stdout.write(`${service.base}\n`);
  } else if (command === 'status') console.log(JSON.stringify(await request('/api/state'), null, 2));
  else if (command === 'on' || command === 'off') console.log(JSON.stringify(await request('/api/settings', { globalEnabled: command === 'on' })));
  else if (command === 'thread') console.log(JSON.stringify(await request('/api/settings', { threadId: args[0] || process.env.CODEX_THREAD_ID, mode: args[1] || 'inherit' })));
  else if (command === 'panel') {
    const id = args[0] || process.env.CODEX_THREAD_ID;
    const saved = await ensureService();
    if (id) console.log(JSON.stringify(await request('/api/open', { threadId: id })));
    else console.log(`${saved.url}/#${saved.token}`);
  } else if (command === 'stop') {
    try { await endpoint(); console.log(JSON.stringify(await request('/api/shutdown', {}))); } catch {}
  } else if (command === 'runtime') {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({ node: process.execPath, root: resolve(dirname(thisFile), '..'), codex: findCodex() }), { mode: 0o600 });
  } else throw Error('Use status, on, off, thread <id> <inherit|on|off>, panel, serve, or stop');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
