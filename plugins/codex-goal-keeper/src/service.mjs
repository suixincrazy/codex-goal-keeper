import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Settings, THREAD_ID } from './settings.mjs';
import { Desktop, callAppTool } from './desktop.mjs';
import { AppServer } from './rpc.mjs';
import { Monitor } from './monitor.mjs';

export const PLUGIN_ID = 'codex-goal-keeper@goal-keeper';

export function panelTabId(id) {
  const digest = createHash('sha256').update(`${PLUGIN_ID}:${id}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function startService({ home, dataDir, executable, port = 47831, rpc = new AppServer(executable, home), desktop = new Desktop(rpc), openTab = callAppTool }) {
  mkdirSync(dataDir, { recursive: true });
  const settings = new Settings(join(dataDir, 'state.json'));
  await rpc.start();
  const monitor = new Monitor({ home, settings, desktop, rpc, pluginId: PLUGIN_ID });
  const keyFile = join(dataDir, 'control-key');
  let token;
  try { token = readFileSync(keyFile, 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) {
    token = randomBytes(32).toString('hex');
    writeFileSync(keyFile, token, { mode: 0o600 });
  }
  const sockets = new Set();
  const panels = new Map();
  const conversations = new Map();
  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../ui');
  let base, closing = false, discovering = false, discoveryTimer;

  function authorised(request) {
    const value = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const url = new URL(request.url, base);
    const candidate = value || url.searchParams.get('key') || '';
    const left = Buffer.from(candidate), right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function view() {
    return {
      version: '0.1.7', globalEnabled: settings.value.globalEnabled, desktopConnected: desktop.connected,
      conversations: [...conversations.values()].map(thread => ({
        id: thread.id, title: thread.title, mode: settings.mode(thread.id), enabled: settings.enabled(thread.id),
        status: monitor.records.get(thread.id)?.status ?? monitor.goals.get(thread.id)?.status ?? null,
        phase: monitor.records.get(thread.id)?.phase ?? 'no-goal',
        continuedAt: monitor.records.get(thread.id)?.continuedAt,
      })),
    };
  }

  function publish() {
    const message = `data: ${JSON.stringify(view())}\n\n`;
    for (const response of sockets) response.write(message);
  }
  settings.on('change', publish);
  monitor.on('change', publish);
  desktop.on('disconnect', publish);

  function panel(id) {
    if (!THREAD_ID.test(id)) throw Error('Invalid thread id');
    if (panels.has(id)) return panels.get(id);
    const pending = openPanel(id).finally(() => panels.delete(id));
    panels.set(id, pending);
    return pending;
  }

  async function openPanel(id) {
    await desktop.connect();
    const snapshot = await desktop.snapshot(id);
    if (!snapshot.lastTurnId) return { status: 'waiting-for-first-turn' };
    const url = `${base}/?thread=${encodeURIComponent(id)}#${token}`;
    const result = await openTab(id, snapshot.lastTurnId, 'open_in_codex', { target: { type: 'browser', url, tabId: panelTabId(id) }, threadId: id, placement: 'right' });
    return { status: 'opened', url, result };
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(base).host) { response.writeHead(403); response.end(); return; }
      const origin = request.headers.origin;
      if (origin && origin !== base) { response.writeHead(403); response.end(); return; }
      const url = new URL(request.url, base);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (['/', '/panel.js', '/panel.css', '/icon.svg'].includes(url.pathname)) {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const file = url.pathname === '/' ? 'panel.html' : url.pathname.slice(1);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/svg+xml';
        response.setHeader('Content-Type', `${type}; charset=utf-8`);
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'self'");
        response.end(readFileSync(join(uiRoot, file)));
        return;
      }
      if (!authorised(request)) { response.writeHead(401); response.end(); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(view())); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        sockets.add(response); response.on('close', () => sockets.delete(response));
        response.write(`data: ${JSON.stringify(view())}\n\n`); return;
      }
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415); response.end(); return; }
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 8192) { response.writeHead(413); response.end(); return; }
        }
        const input = JSON.parse(body || '{}');
        let result;
        if (url.pathname === '/api/settings') { settings.change(input); result = view(); }
        else if (url.pathname === '/api/open') result = await panel(input.threadId);
        else if (url.pathname === '/api/check') { monitor.kick(); result = { status: 'checking' }; }
        else if (url.pathname === '/api/shutdown') { result = { status: 'stopping' }; setTimeout(close, 100); }
        else { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  try { await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); }
  catch (error) { monitor.close(); desktop.close(); rpc.close(); throw error; }
  base = `http://127.0.0.1:${server.address().port}`;
  const endpointFile = join(dataDir, 'endpoint.json');
  writeFileSync(`${endpointFile}.tmp`, JSON.stringify({ url: base, token, pid: process.pid }), { mode: 0o600 });
  renameSync(`${endpointFile}.tmp`, endpointFile);

  async function discover() {
    if (closing || discovering) return;
    discovering = true;
    try {
      const file = join(home, 'state_5.sqlite');
      if (!existsSync(file)) return;
      const db = new DatabaseSync(file, { readOnly: true });
      let rows;
      try { rows = db.prepare("SELECT id,title FROM threads WHERE archived=0 AND source IN ('vscode','cli','exec') ORDER BY updated_at DESC").all(); }
      finally { db.close(); }
      const seen = new Set(rows.map(thread => thread.id));
      for (const id of conversations.keys()) if (!seen.has(id)) { conversations.delete(id); desktop.unwatch(id); }
      for (const thread of rows) conversations.set(thread.id, { id: thread.id, title: thread.title });
      publish();
      await desktop.connect();
    } catch { /* The desktop may be closed while the service waits. */ }
    finally { discovering = false; if (!closing) discoveryTimer = setTimeout(discover, 5000); }
  }

  function close() {
    if (closing) return;
    closing = true; clearTimeout(discoveryTimer); monitor.close(); desktop.close(); rpc.close();
    for (const response of sockets) response.end();
    server.close();
    try { if (JSON.parse(readFileSync(endpointFile)).pid === process.pid) unlinkSync(endpointFile); } catch {}
  }
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  monitor.kick(); discover();
  return { server, monitor, settings, desktop, rpc, panel, close, base, token, view };
}
