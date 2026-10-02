import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeStore, task } from './helpers.js';
import { SCHEMA_VERSION, openDbInfo, userVersion } from '../src/db.js';
import { RESTORE_DAYS, Store } from '../src/store.js';
import { createMcpServer } from '../src/tools.js';
import { createApp } from '../src/http.js';

const COWORK = 'https://claude.ai/code/session_01VnRp31sb14rNXNPAx28EQw';

function serve(t: TestContext, store: Store) {
  const server = createApp(store, { token: 'secret' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
}

async function mcp(store: Store) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return async (name: string, args: object = {}) => {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> }) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
}

test('a deleted task is gone from every read: lists, search, overview, state, moves, load, requests', () => {
  const { store } = makeStore();
  const keep = store.addTask({ ...task, title: 'Keep' });
  const gone = store.addTask({ ...task, title: 'Gone today', est: 120, notes: 'findme' });
  store.addSteps(gone.id, ['one', 'two']);
  const late = store.addTask({ ...task, title: 'Gone overdue', day: '2026-09-29' });
  const moving = store.addTask({ ...task, title: 'Gone with a move', day: '2026-10-02' });
  store.proposeMoves([{ id: moving.id, to_day: '2026-10-03', reason: 'room' }]);
  const asked = store.addTask({ ...task, title: 'Gone with a request', origin: { url: COWORK, title: 'Q4' } });
  store.queueRequest({ prompt: 'Break it down', label: 'Break down', task_id: asked.id, priority: 'high' });
  const moveId = store.pendingMoves()[0].id;
  for (const t of [gone, late, moving, asked]) store.deleteTask(t.id);

  const titles = (ts: { title: string }[]) => ts.map(t => t.title);
  assert.deepEqual(titles(store.listTasks({ include_done: true })), ['Keep']);
  assert.deepEqual(titles(store.listTasks({ ids: [gone.id, keep.id] })), ['Keep'], 'by id too');
  const found = store.searchTasks({ q: 'findme' });
  assert.deepEqual([found.total, found.returned], [0, 0]);
  assert.equal(store.searchTasks({ q: 'Gone', include_done: true }).total, 0);
  assert.deepEqual(store.dayLoad(['2026-10-01']), { '2026-10-01': 30 });

  const o = store.overview();
  const today = o.week.days.find(d => d.date === '2026-10-01')!;
  assert.deepEqual(titles(today.tasks!), ['Keep']);
  assert.equal(today.open_min, 30);
  assert.deepEqual(o.overdue, []);
  assert.deepEqual(o.pending_moves, []);
  assert.equal(o.pending_requests[0].origin, undefined, "a deleted task's origin is not carried");

  const s = store.state();
  assert.deepEqual(titles(s.tasks), ['Keep']);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.deleted.map(d => d.title).sort(), ['Gone overdue', 'Gone today', 'Gone with a move', 'Gone with a request']);
  assert.deepEqual(Object.keys(s.deleted[0]), ['id', 'title', 'day', 'area', 'deleted_at']);

  // Writes treat it as missing; a pending move for it can't be applied, one at a time or all at once.
  assert.throws(() => store.getTask(gone.id), /No task with id/);
  assert.throws(() => store.updateTask(gone.id, { title: 'x' }), /No task with id/);
  assert.throws(() => store.completeTask(gone.id), /No task with id/);
  assert.throws(() => store.deleteTask(gone.id), /No task with id/);
  assert.throws(() => store.resolveMove(moveId, true), /No move/);
  assert.deepEqual(store.resolveMoves({ all: true }, true), { resolved: 0 });
  assert.deepEqual({ ...store.db.prepare('SELECT day, deleted_at IS NOT NULL d FROM tasks WHERE id = ?').get(moving.id) }, { day: '2026-10-02', d: 1 });
});

test('restore brings a task back with its steps and its pending move; restore and purge errors', () => {
  const { store } = makeStore();
  const t = store.addTask({ ...task, title: 'Back again', day: '2026-10-02' });
  store.setSteps(t.id, ['a', { text: 'b', done: true }]);
  store.proposeMoves([{ id: t.id, to_day: '2026-10-04' }]);
  store.deleteTask(t.id);
  assert.equal(store.pendingMoves().length, 0);
  const back = store.restoreTask(t.id);
  assert.deepEqual(back.steps, [{ text: 'a', done: false }, { text: 'b', done: true }]);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.pendingMoves().length, 1);
  assert.deepEqual(store.state().deleted, []);
  assert.equal(store.restoreTask(t.id).id, t.id, 'restoring a live task is a no-op');
  assert.throws(() => store.restoreTask('nope'), /No deleted task with id "nope"/);
  // Delete forever only takes a deleted task: one call can never lose a live one.
  assert.throws(() => store.purgeTask(t.id), /Delete it first/);
  store.deleteTask(t.id);
  assert.deepEqual(store.purgeTask(t.id), { purged: 'Back again' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM steps').get()!.n, 0, 'steps go with it');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM moves').get()!.n, 0, 'moves go with it');
  assert.throws(() => store.restoreTask(t.id), /No deleted task/);
});

test('recurring: a deleted next instance does not block the next one; finds added then deleted stay gone', () => {
  const { store } = makeStore();
  const r = store.addTask({ ...task, title: 'Gym', repeat: 'daily' });
  const next = store.completeTask(r.id).next!;
  assert.equal(next.day, '2026-10-02');
  store.deleteTask(next.id);
  store.updateTask(r.id, { done: false });
  const again = store.completeTask(r.id).next!;
  assert.ok(again && again.id !== next.id, 'a live instance is made again');
  assert.deepEqual(store.listTasks().map(t => t.id), [again.id]);

  store.suggestTasks([{ title: 'Pay invoice', priority: 'high' }]);
  const added = store.resolveFind(store.finds()[0].id, true)!;
  assert.equal(store.listTasks({ q: 'invoice' }).length, 1);
  store.deleteTask(added.id);
  assert.equal(store.listTasks({ q: 'invoice' }).length, 0);
  assert.ok(!store.state().tasks.some(t => t.id === added.id));
  assert.deepEqual(store.finds(), []);
});

test('the 30-day sweep purges only tasks deleted more than 30 days ago; Recently deleted shows the last 30 days, newest first', () => {
  const { store, setNow } = makeStore();
  const old = store.addTask({ ...task, title: 'Old' });
  const live = store.addTask({ ...task, title: 'Live' });
  store.deleteTask(old.id);
  setNow('2026-10-10T10:00:00');
  const recent = store.addTask({ ...task, title: 'Recent' });
  store.deleteTask(recent.id);
  assert.deepEqual(store.state().deleted.map(d => d.title), ['Recent', 'Old']);
  setNow('2026-10-31T08:00:00'); // just under 30 days after the first delete, in either test zone
  assert.equal(store.purgeDeletedOlderThan(RESTORE_DAYS), 0);
  setNow('2026-10-31T11:00:00');
  assert.deepEqual(store.state().deleted.map(d => d.title), ['Recent'], 'older than 30 days is not offered');
  assert.equal(store.purgeDeletedOlderThan(30), 1);
  assert.equal(store.purgeDeletedOlderThan(30), 0);
  assert.deepEqual((store.db.prepare('SELECT title FROM tasks ORDER BY title').all() as { title: string }[]).map(r => r.title), ['Live', 'Recent']);
  assert.equal(store.getTask(live.id).title, 'Live');
  // At most 50 are listed.
  for (let i = 0; i < 55; i++) store.deleteTask(store.addTask({ ...task, title: 'x' + i }).id);
  assert.equal(store.state().deleted.length, 50);
});

test('a v4 database (0.4.0) upgrades to v5 and keeps its rows', () => {
  const d = mkdtempSync(join(tmpdir(), 'docket-')), path = join(d, 'docket.db');
  const first = openDbInfo(path);
  first.db.exec('DROP INDEX tasks_deleted');
  first.db.exec('ALTER TABLE tasks DROP COLUMN deleted_at');
  first.db.exec('PRAGMA user_version = 4');
  first.db.prepare(`INSERT INTO tasks (id, title, area, day, est_min, priority, energy, at, repeat, series_id, created_at, updated_at)
    VALUES ('abc', 'Keep me', 'Work', '2026-10-01', 30, 'med', 'low', '09:00', 'daily', 'abc', 'x', 'x')`).run();
  first.db.prepare(`INSERT INTO steps (task_id, idx, text, done) VALUES ('abc', 0, 'Step', 1)`).run();
  first.db.close();
  const second = openDbInfo(path);
  assert.equal(second.migrated_from, 4);
  assert.equal(userVersion(second.db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 5);
  assert.ok(second.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_deleted'`).get());
  const store = new Store(second.db, { now: () => new Date('2026-10-01T10:00:00') });
  const t = store.getTask('abc');
  assert.deepEqual([t.title, t.at, t.repeat, t.steps], ['Keep me', '09:00', 'daily', [{ text: 'Step', done: true }]]);
  store.deleteTask('abc');
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.restoreTask('abc').title, 'Keep me');
  second.db.close();
});

test('REST: delete, restore and delete forever; MCP delete_task and restore_task', async t => {
  const { store } = makeStore();
  const call = serve(t, store);
  const a = (await call('POST', '/tasks', { ...task, title: 'Undo me' })).body;
  assert.equal((await call('DELETE', `/tasks/${a.id}`)).status, 200);
  assert.equal((await call('GET', '/state')).body.tasks.length, 0);
  assert.equal((await call('GET', '/state')).body.deleted[0].id, a.id);
  const back = await call('POST', `/tasks/${a.id}/restore`);
  assert.deepEqual([back.status, back.body.title], [200, 'Undo me']);
  const live = await call('DELETE', `/tasks/${a.id}/purge`);
  assert.deepEqual([live.status, live.body.error], [400, `No deleted task with id "${a.id}". Delete it first.`]);
  await call('DELETE', `/tasks/${a.id}`);
  assert.deepEqual((await call('DELETE', `/tasks/${a.id}/purge`)).body, { purged: 'Undo me' });
  assert.equal((await call('POST', `/tasks/${a.id}/restore`)).status, 400);

  const tool = await mcp(store);
  const b = store.addTask({ ...task, title: 'Via Claude', day: '2026-10-02' });
  assert.deepEqual((await tool('delete_task', { id: b.id })).json(), { deleted: 'Via Claude', restore_within: '30 days' });
  assert.equal((await tool('list_tasks')).json().total, 0);
  const r = (await tool('restore_task', { id: b.id })).json();
  assert.deepEqual(r, { restored: { id: b.id, title: 'Via Claude', day: '2026-10-02', area: 'Work', est: 30, priority: 'med', energy: 'low' } });
  assert.equal((await tool('list_tasks')).json().total, 1);
  assert.match((await tool('restore_task', { id: 'nope' })).text, /No deleted task/);
});
