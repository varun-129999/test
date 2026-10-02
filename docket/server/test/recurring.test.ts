import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeStore, task } from './helpers.js';
import { SCHEMA_VERSION, openDbInfo, userVersion } from '../src/db.js';
import { Store } from '../src/store.js';
import * as S from '../src/schemas.js';
import { INSTRUCTIONS, createMcpServer } from '../src/tools.js';
import { createApp } from '../src/http.js';

const COWORK = 'https://claude.ai/code/session_01VnRp31sb14rNXNPAx28EQw';

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

function serve(t: TestContext, store: Store) {
  const server = createApp(store, { token: 'secret' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
}

test('a v3 database (0.3.1) upgrades to v4 and keeps its rows', () => {
  const d = mkdtempSync(join(tmpdir(), 'docket-')), path = join(d, 'docket.db');
  // The 0.3.1 shape: today's schema without the v4 columns and index, at user_version 3.
  const first = openDbInfo(path);
  first.db.exec('DROP INDEX tasks_series');
  for (const c of ['at', 'repeat', 'repeat_from', 'series_id']) first.db.exec(`ALTER TABLE tasks DROP COLUMN ${c}`);
  first.db.exec('PRAGMA user_version = 3');
  first.db.prepare(`INSERT INTO tasks (id, title, area, day, est_min, priority, energy, notes, origin_kind, origin_title, origin_url, created_at, updated_at)
    VALUES ('abc', 'Keep me', 'Work', '2026-10-01', 30, 'med', 'low', 'n', 'cowork', 'Q4', '${COWORK}', 'x', 'x')`).run();
  first.db.prepare(`INSERT INTO steps (task_id, idx, text, done) VALUES ('abc', 0, 'Step', 1)`).run();
  first.db.close();
  const second = openDbInfo(path);
  assert.equal(second.migrated_from, 3);
  assert.equal(userVersion(second.db), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 4);
  const store = new Store(second.db, { now: () => new Date('2026-10-01T10:00:00') });
  const t = store.getTask('abc');
  assert.deepEqual([t.title, t.notes, t.origin_title, t.steps], ['Keep me', 'n', 'Q4', [{ text: 'Step', done: true }]]);
  assert.deepEqual([t.at, t.repeat, t.repeat_from, t.series_id], [null, null, 'planned', null]);
  const r = store.updateTask('abc', { at: '09:30', repeat: 'daily' });
  assert.deepEqual([r.at, r.repeat], ['09:30', 'daily']);
  assert.ok((second.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_series'`).get()));
  second.db.close();
  assert.ok(readdirSync(join(d, 'backups')).some(f => f.endsWith('-pre-migration.db')));
});

test('time of day: validated, cleared by null, timed tasks first in the overview, in the compact shapes', () => {
  const { store } = makeStore();
  for (const at of ['5pm', '24:00', '9:30', '12:60']) assert.equal(S.TaskInput.safeParse({ ...task, at }).success, false, at);
  assert.equal(S.TaskInput.safeParse({ ...task, at: '09:30' }).success, true);
  assert.equal(S.TaskPatch.safeParse({ at: null }).success, true);
  assert.throws(() => store.addTask({ ...task, at: '9am' }), /HH:MM/);
  store.addTask({ ...task, title: 'High untimed', priority: 'high' });
  const late = store.addTask({ ...task, title: 'Late', at: '17:30', priority: 'low' });
  store.addTask({ ...task, title: 'Early', at: '08:00' });
  store.addTask({ ...task, title: 'Low untimed', priority: 'low' });
  const day = store.overview().week.days.find(d => d.today)!.tasks!;
  assert.deepEqual(day.map(x => x.title), ['Early', 'Late', 'High untimed', 'Low untimed']);
  assert.equal(day[1].at, '17:30');
  assert.equal('at' in day[2], false, 'left out when not set');
  assert.equal((store.searchTasks().tasks[0] as { at?: string }).at, '08:00');
  assert.equal(store.updateTask(late.id, { at: null }).at, null);
  const bulk = store.updateTasks([late.id], { at: '07:00' });
  assert.deepEqual(bulk.before, [{ id: late.id, at: null }]);
});

test('repeat: normalised on the way in, compact shapes carry it, null stops it', () => {
  const { store } = makeStore();
  const a = store.addTask({ ...task, repeat: 'every mon, thu' });
  assert.equal(a.repeat, 'weekly:Mon,Thu');
  assert.equal(a.repeat_from, 'planned');
  assert.equal(store.addTask({ ...task, day: '2026-10-02', repeat: 'weekly' }).repeat, 'weekly:Fri', 'weekly takes the task day');
  assert.equal(store.addTask({ ...task, repeat: 'monthly', repeat_from: 'done' }).repeat_from, 'done');
  assert.throws(() => store.addTask({ ...task, repeat: 'fortnightly' }), /not a rule Docket knows. Use daily, weekdays/);
  const bad = S.TaskInput.safeParse({ ...task, repeat: 'fortnightly' });
  assert.match(S.issuesText(bad.error!), /^repeat: not a repeat rule; use daily/);
  assert.equal(S.TaskInput.safeParse({ ...task, repeat_from: 'later' }).success, false);
  const compact = store.searchTasks({ ids: [a.id] }).tasks[0] as { repeat?: string };
  assert.equal(compact.repeat, 'weekly:Mon,Thu');
  assert.equal(store.overview().week.days.find(d => d.today)!.tasks!.find(x => x.id === a.id)!.repeat, 'weekly:Mon,Thu');
  assert.equal(store.updateTask(a.id, { repeat: null }).repeat, null);
  assert.equal(store.completeTask(a.id).next, undefined, 'no longer repeating: nothing new');
});

test('completing a recurring task creates the next instance once, with steps unticked, in the same series', () => {
  const { store, setNow } = makeStore();
  const a = store.addTask({ ...task, title: 'Gym', area: 'Health', project: 'Fit', est: 45, priority: 'high', energy: 'high', notes: 'Legs', link: 'https://example.com/plan',
    origin: { kind: 'cowork', title: 'Plan', url: COWORK }, at: '07:00', repeat: 'weekly:Mon,Thu', due: '2026-10-03' });
  store.setSteps(a.id, ['Warm up', 'Lift']);
  store.setStep(a.id, 0, true);
  const done = store.completeTask(a.id);
  assert.equal(done.done, true);
  assert.deepEqual(done.next && { day: done.next.day }, { day: '2026-10-05' });
  const n = store.getTask(done.next!.id);
  assert.deepEqual(
    [n.title, n.area, n.project, n.est, n.priority, n.energy, n.notes, n.link, n.origin_kind, n.origin_title, n.origin_url, n.at, n.repeat, n.repeat_from, n.done, n.due],
    ['Gym', 'Health', 'Fit', 45, 'high', 'high', 'Legs', 'https://example.com/plan', 'cowork', 'Plan', COWORK, '07:00', 'weekly:Mon,Thu', 'planned', false, null]);
  assert.deepEqual(n.steps, [{ text: 'Warm up', done: false }, { text: 'Lift', done: false }]);
  assert.equal(store.getTask(a.id).series_id, a.id, 'the first one starts the series');
  assert.equal(n.series_id, a.id);
  // Idempotent: completing again, or reopening and completing, adds nothing.
  assert.equal(store.completeTask(a.id).next, undefined);
  store.updateTask(a.id, { done: false });
  assert.equal(store.updateTask(a.id, { done: true }).next, undefined);
  assert.equal(store.getTask(n.id).done, false, 'reopening does not touch the next one');
  assert.equal(store.listTasks({ include_done: true }).length, 2);
  // The series carries on from the copy.
  setNow('2026-10-05T09:00:00');
  const third = store.completeTask(n.id).next!;
  assert.equal(third.day, '2026-10-08');
  assert.equal(store.getTask(third.id).series_id, a.id);
  // Deleting removes only that instance.
  store.deleteTask(third.id);
  assert.equal(store.getTask(n.id).done, true);
  assert.equal(store.getTask(a.id).done, true);
});

test('from completion counts from today; a late planned one lands today, not in the past', () => {
  const { store, setNow } = makeStore();
  const a = store.addTask({ ...task, repeat: 'every 2 weeks', repeat_from: 'done' });
  const b = store.addTask({ ...task, repeat: 'every 2 weeks' });
  const c = store.addTask({ ...task, day: '2026-09-25', repeat: 'daily' });
  setNow('2026-10-03T10:00:00');
  assert.equal(store.completeTask(a.id).next!.day, '2026-10-17');
  assert.equal(store.completeTask(b.id).next!.day, '2026-10-15');
  assert.equal(store.completeTask(c.id).next!.day, '2026-10-03');
});

test('update_tasks with done: true lists the new instances', () => {
  const { store } = makeStore();
  const a = store.addTask({ ...task, repeat: 'daily' });
  const b = store.addTask(task);
  const r = store.updateTasks([a.id, b.id], { done: true });
  assert.equal(r.updated, 2);
  assert.equal(r.next?.length, 1);
  assert.equal(r.next![0].day, '2026-10-02');
});

test('MCP: at and repeat round trip; complete_task returns next; a bad rule is a tool error', async () => {
  const { store } = makeStore();
  const call = await mcp(store);
  const added = (await call('add_task', { ...task, title: 'Pay rent', at: '09:00', repeat: 'monthly 25' })).json();
  assert.deepEqual([added.at, added.repeat], ['09:00', 'monthly:25']);
  const list = (await call('list_tasks', {})).json();
  assert.deepEqual([list.tasks[0].at, list.tasks[0].repeat], ['09:00', 'monthly:25']);
  const done = (await call('complete_task', { id: added.id })).json();
  assert.equal(done.done, true);
  assert.equal(done.next.day, '2026-10-25');
  const again = (await call('complete_task', { id: added.id })).json();
  assert.equal(again.next, undefined);
  const bad = await call('update_task', { id: added.id, repeat: 'every blue moon' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /not a repeat rule; use daily, weekdays/);
  const cleared = (await call('update_task', { id: done.next.id, repeat: null, at: null })).json();
  assert.deepEqual([cleared.repeat, cleared.at], [null, null]);
  const many = (await call('add_tasks', { tasks: [{ ...task, title: 'A', repeat: 'weekdays', repeat_from: 'done' }] })).json();
  assert.equal(store.getTask(many.added[0].id).repeat_from, 'done');
  const tools = await (async () => { const [a, b] = InMemoryTransport.createLinkedPair(); await createMcpServer(store).connect(a); const c = new Client({ name: 't', version: '1' }); await c.connect(b); return (await c.listTools()).tools; })();
  assert.match(tools.find(t => t.name === 'complete_task')!.description!, /next/);
  assert.match(tools.find(t => t.name === 'add_task')!.description!, /repeat/);
  assert.match(INSTRUCTIONS, /Recurring tasks: set repeat \(daily, weekdays, weekly:Mon,Thu, monthly:25, every:2:weeks\); completing one creates the next\./);
  assert.match(INSTRUCTIONS, /set origin\.url to this session.s own link/);
});

test('REST: PATCH done on a recurring task returns next; at and repeat set and clear', async t => {
  const { store } = makeStore();
  const call = serve(t, store);
  const made = await call('POST', '/tasks', { ...task, at: '18:30', repeat: 'every thu', repeat_from: null });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.at, made.body.repeat, made.body.repeat_from], ['18:30', 'weekly:Thu', 'planned']);
  assert.equal((await call('PATCH', `/tasks/${made.body.id}`, { at: '7pm' })).status, 400);
  assert.match((await call('PATCH', `/tasks/${made.body.id}`, { repeat: 'sometimes' })).body.error, /^repeat: /);
  const done = await call('PATCH', `/tasks/${made.body.id}`, { done: true });
  assert.deepEqual([done.status, done.body.done, done.body.next.day], [200, true, '2026-10-08']);
  const state = (await call('GET', '/state')).body;
  const next = state.tasks.find((x: any) => x.id === done.body.next.id);
  assert.deepEqual([next.at, next.repeat, next.series_id], ['18:30', 'weekly:Thu', made.body.id]);
  const cleared = await call('PATCH', `/tasks/${next.id}`, { at: null, repeat: null });
  assert.deepEqual([cleared.body.at, cleared.body.repeat], [null, null]);
});
