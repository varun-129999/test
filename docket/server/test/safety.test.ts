import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { makeStore, task } from './helpers.js';
import { SCHEMA_VERSION, openDbInfo, tx, userVersion } from '../src/db.js';
import { checkSnapshot, exportJson, listSnapshots, prune, restore, snapshot } from '../src/backup.js';
import { checkTimeZone, isIsoDay } from '../src/dates.js';
import { Store, isClaudeUrl } from '../src/store.js';
import { createApp } from '../src/http.js';

const dir = () => mkdtempSync(join(tmpdir(), 'docket-'));

test('isIsoDay rejects impossible dates', () => {
  for (const ok of ['2026-10-01', '2024-02-29', '2026-12-31']) assert.equal(isIsoDay(ok), true, ok);
  for (const bad of ['2026-09-31', '2026-02-30', '2023-02-29', '2026-13-01', '2026-1-1', 'Friday']) assert.equal(isIsoDay(bad), false, bad);
  const { store } = makeStore();
  assert.throws(() => store.addTask({ ...task, day: '2026-09-31' }), /YYYY-MM-DD/);
});

test('checkTimeZone accepts the running zone and flags bad values', () => {
  const current = process.env.TZ;
  assert.equal(checkTimeZone(current).ok, true);
  assert.equal(checkTimeZone('Asia/Kolkatta').ok, false);
  assert.equal(checkTimeZone(undefined).ok, true);
  assert.match(checkTimeZone(undefined).problem!, /not set/);
  // A valid name that Node is NOT running under: the offset check must catch it unless it happens to match.
  const other = current === 'Asia/Kolkata' ? 'Europe/London' : 'Asia/Kolkata';
  assert.equal(checkTimeZone(other).ok, false);
});

test('a pre-versioning database upgrades in place and keeps its rows', () => {
  const d = dir(), path = join(d, 'docket.db');
  // Simulate the live database: the v1 tables, user_version 0, one task.
  const first = openDbInfo(path);
  first.db.exec('PRAGMA user_version = 0');
  first.db.prepare(`INSERT INTO tasks (id, title, area, day, est_min, priority, energy, created_at, updated_at) VALUES ('abc', 'Keep me', 'Work', '2026-10-01', 30, 'med', 'low', 'x', 'x')`).run();
  first.db.close();
  const second = openDbInfo(path);
  assert.equal(second.created, false);
  assert.equal(second.migrated_from, 0);
  assert.equal(userVersion(second.db), SCHEMA_VERSION);
  assert.equal((second.db.prepare('SELECT title FROM tasks').get() as { title: string }).title, 'Keep me');
  second.db.close();
  // A database from the future is refused, not silently used.
  const future = new DatabaseSync(path);
  future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  future.close();
  assert.throws(() => openDbInfo(path), /newer than this build/);
});

test('transactions nest: an inner failure rolls back only the inner work', () => {
  const { store } = makeStore();
  const db = store.db;
  tx(db, () => {
    store.addTask({ ...task, title: 'outer' });
    assert.throws(() => tx(db, () => { store.addTask({ ...task, title: 'inner' }); throw new Error('boom'); }), /boom/);
    store.addTask({ ...task, title: 'after' });
  });
  assert.deepEqual(store.listTasks().map(t => t.title), ['outer', 'after']);
  assert.throws(() => tx(db, () => { store.addTask({ ...task, title: 'lost' }); throw new Error('outer boom'); }), /outer boom/);
  assert.equal(store.listTasks().length, 2);
});

test('Run anyway keeps the hold when applying fails, and drops it when the task is gone', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  store.setUsage(90);
  assert.throws(() => store.setSteps(low.id, ['a', 'b']));
  const [held] = store.heldRequests();
  store.deleteTask(low.id);
  assert.throws(() => store.runHeld(held.id), /no longer exists/);
  assert.equal(store.heldRequests().length, 0);
  assert.equal(store.pendingRequests().length, 0, 'no stray override request');
});

test('overview counts only open minutes on today and future days; past days are never over', () => {
  const { store } = makeStore();
  store.addTask({ ...task, est: 300, day: '2026-10-01' });
  store.completeTask(store.addTask({ ...task, est: 120, day: '2026-10-01' }).id);
  store.addTask({ ...task, est: 600, day: '2026-09-29' }); // past, open, way over
  store.completeTask(store.addTask({ ...task, est: 500, day: '2026-09-28' }).id);
  const o = store.overview();
  const today = o.week.days.find(x => x.date === '2026-10-01')!;
  assert.equal(o.day.over_min, 0);
  assert.equal(today.over_min, 0);
  assert.equal(today.open_min, 300);
  assert.equal(today.done_min, 120);
  assert.equal(today.free_min, 60);
  assert.equal(o.week.days.find(x => x.date === '2026-09-29')!.over_min, 0);
  assert.equal(o.week.days_over, 0);
  assert.equal(o.overdue.length, 1);
  store.addTask({ ...task, est: 100, day: '2026-10-01' });
  const o2 = store.overview();
  assert.equal(o2.day.over_min, 40);
  assert.equal(o2.week.days.find(x => x.date === '2026-10-01')!.over_min, 40);
  assert.equal(o2.week.days_over, 1);
});

test('claude_url only accepts Claude hosts', () => {
  assert.equal(isClaudeUrl('https://claude.ai/new'), true);
  assert.equal(isClaudeUrl('https://claude.ai/project/abc'), true);
  assert.equal(isClaudeUrl('https://www.claude.com/x'), true);
  assert.equal(isClaudeUrl('https://claude-ai.login-help.example/new'), false);
  assert.equal(isClaudeUrl('http://claude.ai/new'), false);
  assert.equal(isClaudeUrl('https://evilclaude.ai/'), false);
  const { store } = makeStore();
  assert.throws(() => store.setSettings({ claude_url: 'https://example.com' }), /claude\.ai/);
  assert.equal(store.setSettings({ claude_url: 'https://claude.ai/project/p1' }).claude_url, 'https://claude.ai/project/p1');
});

test('snapshots are consistent copies, pruned by age, and restorable', () => {
  const d = dir(), path = join(d, 'docket.db'), backups = join(d, 'backups');
  const { db } = openDbInfo(path);
  const store = new Store(db);
  store.addTask({ ...task, title: 'before' });
  const file = snapshot(db, backups, 'hourly', new Date('2026-10-01T10:00:00'));
  assert.equal(checkSnapshot(file).ok, true);
  assert.equal(checkSnapshot(file).tasks, 1);
  store.addTask({ ...task, title: 'after' });
  // Retention: hourly copies older than 48h collapse to one per day; older than 30d go.
  const old = (iso: string, label: 'hourly' | 'manual' = 'hourly') => snapshot(db, backups, label, new Date(iso));
  old('2026-09-20T01:00:00'); old('2026-09-20T02:00:00'); old('2026-09-20T03:00:00'); old('2026-08-01T01:00:00'); old('2026-09-10T01:00:00', 'manual');
  const removed = prune(backups, new Date('2026-10-01T12:00:00'));
  const left = listSnapshots(backups).map(s => s.file.split('/').pop());
  assert.equal(removed.length, 3, 'two duplicates on 20 Sep and the August copy');
  assert.equal(left.filter(f => f!.includes('20260920')).length, 1, 'one copy of that day kept');
  assert.ok(left.some(f => f!.includes('manual')), 'manual kept');
  assert.ok(!left.some(f => f!.includes('20260801')), 'older than 30 days gone');
  // Export
  const ex = exportJson(db) as { tasks: unknown[]; schema_version: number };
  assert.equal(ex.tasks.length, 2);
  assert.equal(ex.schema_version, SCHEMA_VERSION);
  db.close();
  // Restore the first snapshot: the live file is moved aside, not deleted.
  const r = restore(path, file);
  assert.equal(r.tasks, 1);
  assert.ok(r.moved_aside && existsSync(r.moved_aside));
  const again = openDbInfo(path);
  assert.deepEqual(new Store(again.db).listTasks().map(t => t.title), ['before']);
  again.db.close();
  // A corrupt file is refused.
  const junk = join(d, 'junk.db');
  writeFileSync(junk, 'not a database');
  assert.throws(() => restore(path, junk), /Refusing to restore/);
  utimesSync(junk, new Date(), new Date());
  assert.ok(readdirSync(d).length > 0);
});

test('sample reset is refused unless enabled and confirmed; healthz proves the database', async () => {
  const { store } = makeStore();
  store.addTask({ ...task, title: 'real data' });
  const server = createApp(store, { token: 't', version: '9.9.9' }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try {
    const health = await (await fetch(base + '/healthz')).json();
    assert.deepEqual(health, { ok: true, version: '9.9.9' });
    const off = await fetch(base + '/api/sample', { method: 'POST', headers: H, body: '{"confirm":"wipe"}' });
    assert.equal(off.status, 400);
    assert.match((await off.json()).error, /disabled/);
    assert.equal(store.listTasks()[0].title, 'real data');
    const backup = await fetch(base + '/api/backup', { headers: H });
    assert.equal(backup.status, 200);
    assert.equal((await backup.arrayBuffer()).byteLength > 4096, true);
    const ex = await (await fetch(base + '/api/export.json', { headers: H })).json();
    assert.equal(ex.tasks.length, 1);
  } finally {
    server.close();
  }
  const { store: s2 } = makeStore();
  (s2.flags as { sample: boolean }).sample = true;
  s2.addTask({ ...task, title: 'real data' });
  const srv2 = createApp(s2, { token: 't' }).listen(0);
  const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  try {
    const noConfirm = await fetch(base2 + '/api/sample', { method: 'POST', headers: H, body: '{}' });
    assert.equal(noConfirm.status, 400);
    assert.equal(s2.listTasks()[0].title, 'real data');
    const yes = await fetch(base2 + '/api/sample', { method: 'POST', headers: H, body: '{"confirm":"wipe"}' });
    assert.equal(yes.status, 200);
    assert.ok(s2.listTasks().length > 5);
  } finally {
    srv2.close();
  }
});
