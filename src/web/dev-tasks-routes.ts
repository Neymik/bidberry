/**
 * Dev task board — coordination list for developers + Claude Code agents.
 *
 * Routes:
 *   GET  /admin/tasks            → self-contained HTML board (no SPA)
 *   GET  /api/dev-tasks          → list (open read)
 *   GET  /api/dev-tasks/:id      → one task + activity (open read)
 *   POST /api/dev-tasks          → create   (requires X-Trigger-Secret)
 *   PATCH /api/dev-tasks/:id      → update   (requires X-Trigger-Secret)
 *   POST /api/dev-tasks/:id/comment → comment (requires X-Trigger-Secret)
 *   DELETE /api/dev-tasks/:id     → delete   (requires X-Trigger-Secret)
 *
 * Reads are open so anyone (and any agent) can check the list with a plain
 * GET. Mutations reuse the shared TRIGGER_SECRET — the browser board prompts
 * for it once and stores it in localStorage; Claude Code reads it from .env.
 * These endpoints sit OUTSIDE the JWT `/api/*` middleware (see routes.ts skip
 * list) on purpose: this is a dev tool, not tenant data.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'crypto';
import * as tasks from '../db/dev-tasks-repository';
import { DEV_TASK_STATUSES, DEV_TASK_PRIORITIES } from '../db/dev-tasks-repository';

const app = new Hono();

function constantTimeStringEq(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const ab = Buffer.alloc(maxLen);
  const bb = Buffer.alloc(maxLen);
  ab.write(a);
  bb.write(b);
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

async function requireSecret(c: Context, next: Next) {
  const expected = process.env.TRIGGER_SECRET || '';
  if (!expected || expected.length < 16) {
    return c.json({ error: 'TRIGGER_SECRET not configured on server' }, 401);
  }
  const got = c.req.header('X-Trigger-Secret') || '';
  if (!constantTimeStringEq(got, expected)) {
    return c.json({ error: 'unauthorized — set the secret on the board (🔑) or pass X-Trigger-Secret' }, 401);
  }
  await next();
}

const isStatus = (s: any): s is tasks.DevTaskStatus => DEV_TASK_STATUSES.includes(s);
const isPriority = (p: any): p is tasks.DevTaskPriority => DEV_TASK_PRIORITIES.includes(p);

// --- Reads (open) ---

app.get('/api/dev-tasks', async (c) => {
  try {
    const status = c.req.query('status');
    const assignee = c.req.query('assignee');
    const q = c.req.query('q');
    const list = await tasks.listTasks({
      status: isStatus(status) ? status : undefined,
      assignee: assignee || undefined,
      q: q || undefined,
    });
    return c.json({ tasks: list, stats: await tasks.getStats() });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/dev-tasks/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try {
    const task = await tasks.getTask(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    const events = await tasks.getTaskEvents(id);
    return c.json({ task, events });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// --- Mutations (require secret) ---

app.post('/api/dev-tasks', requireSecret, async (c) => {
  try {
    const body = await c.req.json();
    if (!body.title || typeof body.title !== 'string') {
      return c.json({ error: 'title is required' }, 400);
    }
    if (body.status && !isStatus(body.status)) return c.json({ error: 'invalid status' }, 400);
    if (body.priority && !isPriority(body.priority)) return c.json({ error: 'invalid priority' }, 400);
    const task = await tasks.createTask({
      title: body.title.trim(),
      description: body.description,
      status: body.status,
      priority: body.priority,
      assignee: body.assignee,
      tags: body.tags,
      branch: body.branch,
      author: body.author,
    });
    return c.json(task, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.patch('/api/dev-tasks/:id', requireSecret, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try {
    const body = await c.req.json();
    if (body.status && !isStatus(body.status)) return c.json({ error: 'invalid status' }, 400);
    if (body.priority && !isPriority(body.priority)) return c.json({ error: 'invalid priority' }, 400);
    const task = await tasks.updateTask(id, body);
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json(task);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/dev-tasks/:id/comment', requireSecret, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try {
    const body = await c.req.json();
    if (!body.body || typeof body.body !== 'string') {
      return c.json({ error: 'body is required' }, 400);
    }
    const event = await tasks.addComment(id, body.body, body.author);
    if (!event) return c.json({ error: 'not found' }, 404);
    return c.json(event, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/dev-tasks/:id', requireSecret, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try {
    const ok = await tasks.deleteTask(id);
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// --- Board page ---

app.get('/admin/tasks', (c) => c.html(BOARD_HTML));

const BOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Доска задач</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗂️</text></svg>">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: #1e293b; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 10; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  .grow { flex: 1; }
  button, input, select, textarea { font: inherit; }
  button { cursor: pointer; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 6px; padding: 6px 12px; }
  button:hover { background: #475569; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.primary:hover { background: #1d4ed8; }
  button.danger { background: transparent; border-color: #b91c1c; color: #f87171; }
  input, select, textarea { background: #0f172a; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 6px 10px; }
  main { padding: 16px 20px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; align-items: start; }
  .col { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 10px; }
  .col h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin: 4px 6px 10px; color: #94a3b8; display: flex; justify-content: space-between; }
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .card .title { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
  .card .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 11px; color: #94a3b8; }
  .pill { padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pri-urgent { background: #7f1d1d; color: #fecaca; }
  .pri-high { background: #78350f; color: #fed7aa; }
  .pri-medium { background: #334155; color: #cbd5e1; }
  .pri-low { background: #1e293b; color: #64748b; }
  .assignee { background: #1e3a8a; color: #bfdbfe; padding: 1px 7px; border-radius: 999px; }
  .tag { background: #312e81; color: #c7d2fe; padding: 1px 6px; border-radius: 4px; }
  .card .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .card .actions select, .card .actions button { font-size: 12px; padding: 3px 8px; }
  .desc { font-size: 12px; color: #cbd5e1; margin: 6px 0; white-space: pre-wrap; }
  dialog { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 12px; padding: 20px; width: min(520px, 92vw); }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  dialog label { display: block; font-size: 12px; color: #94a3b8; margin: 10px 0 4px; }
  dialog input, dialog select, dialog textarea { width: 100%; }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .muted { color: #64748b; font-size: 12px; }
  .events { margin-top: 8px; border-top: 1px solid #334155; padding-top: 6px; font-size: 11px; color: #94a3b8; }
  .events div { margin: 2px 0; }
  a { color: #60a5fa; }
</style>
</head>
<body>
<header>
  <h1>🗂️ Доска задач</h1>
  <span class="muted" id="stats"></span>
  <span class="grow"></span>
  <input id="search" placeholder="Поиск…" style="width:180px">
  <button onclick="setIdentity()" id="whoBtn" title="Укажите своё имя (автор / исполнитель)">👤 …</button>
  <button onclick="setSecret()" title="Секрет для записи">🔑</button>
  <button class="primary" onclick="openNew()">+ Новая задача</button>
  <button onclick="load()" title="Обновить">↻</button>
</header>
<main>
  <div class="cols" id="board"></div>
</main>

<dialog id="dlg">
  <h3 id="dlgTitle" style="margin-top:0">Новая задача</h3>
  <input type="hidden" id="f_id">
  <label>Название *</label>
  <input id="f_title" placeholder="Что нужно сделать">
  <label>Описание</label>
  <textarea id="f_desc" rows="4" placeholder="Контекст, критерии приёмки, ссылки…"></textarea>
  <div class="row">
    <div><label>Статус</label><select id="f_status"></select></div>
    <div><label>Приоритет</label><select id="f_priority"></select></div>
  </div>
  <div class="row">
    <div><label>Исполнитель</label><input id="f_assignee" placeholder="имя / claude"></div>
    <div><label>Ветка</label><input id="f_branch" placeholder="main (или worktree)"></div>
  </div>
  <label>Теги (через запятую)</label>
  <input id="f_tags" placeholder="orders, frontend">
  <div class="row" style="margin-top:16px">
    <button onclick="document.getElementById('dlg').close()">Отмена</button>
    <button class="primary" onclick="save()">Сохранить</button>
  </div>
</dialog>

<script>
const STATUSES = ${JSON.stringify(DEV_TASK_STATUSES)};
const PRIORITIES = ${JSON.stringify(DEV_TASK_PRIORITIES)};
const LABELS = { backlog:'Бэклог', todo:'К выполнению', in_progress:'В работе', review:'Ревью', done:'Готово', blocked:'Заблокировано' };
const PRI_LABELS = { low:'низкий', medium:'средний', high:'высокий', urgent:'срочно' };
let SECRET = localStorage.getItem('devTaskSecret') || '';
let WHO = localStorage.getItem('devTaskWho') || '';

function setSecret() {
  const v = prompt('Секрет для записи (TRIGGER_SECRET). Хранится только локально в этом браузере.', SECRET);
  if (v !== null) { SECRET = v.trim(); localStorage.setItem('devTaskSecret', SECRET); }
}
function setIdentity() {
  const v = prompt('Ваше имя — записывается как автор/исполнитель:', WHO);
  if (v !== null) { WHO = v.trim(); localStorage.setItem('devTaskWho', WHO); renderWho(); }
}
function renderWho() { document.getElementById('whoBtn').textContent = '👤 ' + (WHO || '…'); }

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-Trigger-Secret'] = SECRET;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) { alert('Нет доступа — нажмите 🔑, чтобы указать секрет для записи.'); }
    throw new Error(e.error || res.statusText);
  }
  return res.json();
}

function esc(s) { return (s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function load() {
  const q = document.getElementById('search').value.trim();
  const data = await api('GET', '/api/dev-tasks' + (q ? '?q=' + encodeURIComponent(q) : ''));
  document.getElementById('stats').textContent =
    STATUSES.map(s => (data.stats[s] ? LABELS[s] + ': ' + data.stats[s] : null)).filter(Boolean).join('  ·  ');
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const status of STATUSES) {
    const items = data.tasks.filter(t => t.status === status);
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = '<h2>' + LABELS[status] + '<span>' + items.length + '</span></h2>';
    for (const t of items) col.appendChild(card(t));
    board.appendChild(col);
  }
}

function card(t) {
  const el = document.createElement('div');
  el.className = 'card';
  const tags = (t.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(tg => '<span class="tag">' + esc(tg) + '</span>').join(' ');
  el.innerHTML =
    '<div class="title">#' + t.id + ' ' + esc(t.title) + '</div>' +
    (t.description ? '<div class="desc">' + esc(t.description) + '</div>' : '') +
    '<div class="meta">' +
      '<span class="pill pri-' + t.priority + '">' + (PRI_LABELS[t.priority] || t.priority) + '</span>' +
      (t.assignee ? '<span class="assignee">@' + esc(t.assignee) + '</span>' : '') +
      (t.branch ? '<span class="muted">⎇ ' + esc(t.branch) + '</span>' : '') +
      tags +
    '</div>' +
    '<div class="actions">' +
      '<select onchange="move(' + t.id + ', this.value)">' +
        STATUSES.map(s => '<option value="' + s + '"' + (s===t.status?' selected':'') + '>' + LABELS[s] + '</option>').join('') +
      '</select>' +
      '<button onclick="claim(' + t.id + ')">Взять</button>' +
      '<button onclick="edit(' + t.id + ')">Изменить</button>' +
      '<button class="danger" onclick="del(' + t.id + ')">✕</button>' +
    '</div>';
  return el;
}

async function move(id, status) { try { await api('PATCH', '/api/dev-tasks/' + id, { status, author: WHO }); load(); } catch(e){ alert(e.message); } }
async function claim(id) {
  if (!WHO) { setIdentity(); if (!WHO) return; }
  try { await api('PATCH', '/api/dev-tasks/' + id, { assignee: WHO, status: 'in_progress', author: WHO }); load(); } catch(e){ alert(e.message); }
}
async function del(id) { if (!confirm('Удалить задачу #' + id + '?')) return; try { await api('DELETE', '/api/dev-tasks/' + id); load(); } catch(e){ alert(e.message); } }

function fillSelects() {
  document.getElementById('f_status').innerHTML = STATUSES.map(s => '<option value="'+s+'">'+LABELS[s]+'</option>').join('');
  document.getElementById('f_priority').innerHTML = PRIORITIES.map(p => '<option value="'+p+'"'+(p==='medium'?' selected':'')+'>'+(PRI_LABELS[p]||p)+'</option>').join('');
}
function openNew() {
  document.getElementById('dlgTitle').textContent = 'Новая задача';
  ['f_id','f_title','f_desc','f_assignee','f_branch','f_tags'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('f_status').value = 'backlog';
  document.getElementById('f_priority').value = 'medium';
  document.getElementById('dlg').showModal();
}
async function edit(id) {
  const { task } = await api('GET', '/api/dev-tasks/' + id);
  document.getElementById('dlgTitle').textContent = 'Задача #' + id;
  document.getElementById('f_id').value = task.id;
  document.getElementById('f_title').value = task.title;
  document.getElementById('f_desc').value = task.description || '';
  document.getElementById('f_status').value = task.status;
  document.getElementById('f_priority').value = task.priority;
  document.getElementById('f_assignee').value = task.assignee || '';
  document.getElementById('f_branch').value = task.branch || '';
  document.getElementById('f_tags').value = task.tags || '';
  document.getElementById('dlg').showModal();
}
async function save() {
  const id = document.getElementById('f_id').value;
  const payload = {
    title: document.getElementById('f_title').value.trim(),
    description: document.getElementById('f_desc').value,
    status: document.getElementById('f_status').value,
    priority: document.getElementById('f_priority').value,
    assignee: document.getElementById('f_assignee').value.trim(),
    branch: document.getElementById('f_branch').value.trim(),
    tags: document.getElementById('f_tags').value.trim(),
    author: WHO,
  };
  if (!payload.title) { alert('Название обязательно'); return; }
  try {
    if (id) await api('PATCH', '/api/dev-tasks/' + id, payload);
    else await api('POST', '/api/dev-tasks', payload);
    document.getElementById('dlg').close();
    load();
  } catch (e) { alert(e.message); }
}

document.getElementById('search').addEventListener('input', () => { clearTimeout(window._t); window._t = setTimeout(load, 250); });
fillSelects();
renderWho();
load();
</script>
</body>
</html>`;

export default app;
