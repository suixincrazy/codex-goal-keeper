(() => {
  'use strict';
  const threadId = new URLSearchParams(location.search).get('thread');
  const token = location.hash.slice(1) || sessionStorage.getItem('goal-keeper-token');
  if (location.hash) { sessionStorage.setItem('goal-keeper-token', token); history.replaceState(null, '', location.pathname + location.search); }
  const labels = { active: '执行中', blocked: '已停滞', complete: '已完成', paused: '已暂停', usage_limited: '用量受限', budget_limited: '预算受限', usageLimited: '用量受限', budgetLimited: '预算受限' };
  const phases = { watching: '监测中', checking: '检查会话状态', continuing: '正在继续目标', running: '目标正在执行', waiting: '等待状态变化', disabled: '已关闭', complete: '已完成，停止检测', 'no-goal': '暂无目标', 'waiting-desktop': '等待会话连接', retrying: '等待重试' };
  let state, pending = false;
  const $ = id => document.getElementById(id);

  function showMessage(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  async function api(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw Error(response.status === 401 ? '连接已更新，请在会话中重新打开 Goal Keeper 面板。' : '操作未完成，请重试。');
    const result = await response.json(); if (result.error) throw Error(result.error); return result;
  }
  async function change(body) {
    if (pending) return;
    pending = true;
    try { state = await api('/api/settings', body); render(); showMessage('设置已立即生效'); }
    catch (error) { showMessage(error.message, true); }
    finally { pending = false; }
  }
  function render() {
    $('connection').textContent = state.desktopConnected ? '已连接 Codex' : '等待 Codex 连接';
    $('global').disabled = false;
    $('global').setAttribute('aria-checked', String(state.globalEnabled));
    $('global').querySelector('.switch-label').textContent = state.globalEnabled ? '开启' : '关闭';
    const current = state.conversations.find(thread => thread.id === threadId);
    if (threadId) {
      $('current').hidden = false;
      $('thread-title').textContent = current?.title || '本会话';
      const mode = current?.mode || 'inherit';
      const enabled = current?.enabled ?? state.globalEnabled;
      document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
      $('effective').textContent = enabled ? '当前有效：开启' : '当前有效：关闭';
      $('goal-status').textContent = labels[current?.status] || '暂无目标';
      $('phase').textContent = enabled ? phases[current?.phase] || '等待目标' : '已关闭';
    }
    const container = $('conversations');
    container.replaceChildren();
    for (const thread of state.conversations) {
      const row = document.createElement('div'); row.className = 'conversation';
      const info = document.createElement('div');
      const title = document.createElement('div'); title.className = 'conversation-title'; title.textContent = thread.title || thread.id; title.title = title.textContent;
      const status = document.createElement('span'); status.className = 'conversation-status'; status.textContent = `${labels[thread.status] || '暂无目标'} · ${thread.enabled ? '开启' : '关闭'}`;
      const open = document.createElement('button'); open.className = 'open-panel'; open.textContent = '会话面板';
      open.addEventListener('click', async () => { try { await api('/api/open', { threadId: thread.id }); showMessage('已打开会话面板'); } catch (error) { showMessage(error.message, true); } });
      info.append(title, status, open);
      const select = document.createElement('select'); select.setAttribute('aria-label', `${thread.title || thread.id} 的自动续跑设置`);
      for (const [value, text] of [['inherit', '继承全局'], ['on', '开启'], ['off', '关闭']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      select.value = thread.mode; select.addEventListener('change', () => change({ threadId: thread.id, mode: select.value }));
      row.append(info, select); container.append(row);
    }
    if (state.conversations.length === 0) { const text = document.createElement('p'); text.textContent = '等待会话连接'; container.append(text); }
  }
  $('global').addEventListener('click', () => change({ globalEnabled: !state.globalEnabled }));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => change({ threadId, mode: button.dataset.mode })));
  if (!token) { showMessage('请从 Codex 会话打开 Goal Keeper 面板。', true); return; }
  api('/api/state').then(result => { state = result; render(); }).catch(error => showMessage(error.message, true));
  const events = new EventSource(`/api/events?key=${encodeURIComponent(token)}`);
  events.onmessage = event => { state = JSON.parse(event.data); render(); };
  events.onerror = () => { $('connection').textContent = '连接中断，正在重连'; };
})();
