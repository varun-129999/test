import { test } from 'node:test';
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
import { norm } from '../src/schemas.js';
import { INSTRUCTIONS, createMcpServer } from '../src/tools.js';
import { createApp } from '../src/http.js';

const COWORK = 'https://claude.ai/code/session_01VnRp31sb14rNXNPAx28EQw';

test('a v2 database (0.3.0) upgrades to v3 and keeps its rows', () => {
  const d = mkdtempSync(join(tmpdir(), 'docket-')), path = join(d, 'docket.db');
  // Build the 0.3.0 shape: today's schema without the v3 columns, at user_version 2.
  const first = openDbInfo(path);
  for (const c of ['origin_kind', 'origin_title', 'origin_url']) first.db.exec(`ALTER TABLE tasks DROP COLUMN ${c}`);
  first.db.exec('PRAGMA user_version = 2');
  first.db.prepare(`INSERT INTO tasks (id, title, area, day, est_min, priority, energy, notes, created_at, updated_at) VALUES ('abc', 'Keep me', 'Work', '2026-10-01', 30, 'med', 'low', 'n', 'x', 'x')`).run();
  first.db.prepare(`INSERT INTO pending_requests (id, label, prompt, task_id, created_at) VALUES ('r1', 'Give', 'Do task abc', 'abc', 'x')`).run();
  first.db.close();
  const second = openDbInfo(path);
  assert.equal(second.migrated_from, 2);
  assert.equal(userVersion(second.db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 3);
  const store = new Store(second.db);
  const t = store.getTask('abc');
  assert.deepEqual([t.title, t.notes, t.origin_kind, t.origin_title, t.origin_url], ['Keep me', 'n', null, null, null]);
  assert.equal(store.pendingRequests()[0].origin, undefined);
  store.updateTask('abc', { origin: { kind: 'cowork', title: 'Q4 deck', url: COWORK } });
  assert.equal(store.getTask('abc').origin_url, COWORK);
  second.db.close();
  assert.ok(readdirSync(join(d, 'backups')).some(f => f.endsWith('-pre-migration.db')));
});

test('origin validation: https links only, kinds normalised', () => {
  const parse = (origin: unknown) => S.TaskInput.safeParse({ ...task, origin });
  for (const url of ['javascript:alert(1)', 'http://claude.ai/chat/x', 'data:text/html,x', 'claude.ai/chat/x', 'https://']) {
    const r = parse({ kind: 'chat', url });
    assert.equal(r.success, false, url);
    assert.match(S.issuesText(r.error!), /^origin\.url: must be an https:\/\/ link/);
  }
  for (const url of [COWORK, 'https://claude.ai/chat/0199-abc', 'https://claude.com/x', 'https://mail.google.com/mail/u/0/#inbox/1']) assert.equal(parse({ url }).success, true, url);
  assert.equal(parse({ title: 'x'.repeat(121) }).success, false);
  assert.equal(parse({ kind: 'telegram' }).success, false);
  assert.equal(norm(parse({ kind: 'claude-code' }).data!).origin?.kind, 'claude_code');
  assert.equal(norm(parse({ kind: 'code' }).data!).origin?.kind, 'claude_code');
  assert.equal(S.TaskPatch.safeParse({ origin: null }).success, true);
  const { store } = makeStore();
  assert.throws(() => store.addTask({ ...task, origin: { url: 'javascript:alert(1)' } }), /origin\.url must be an https/);
  assert.throws(() => store.updateTask(store.addTask(task).id, { origin: { url: 'http://x.com' } }), /origin\.url/);
});

test('origin is stored, replaced as a whole, cleared by null, and guessed from a Claude Code link', () => {
  const { store } = makeStore();
  const t = store.addTask({ ...task, origin: { kind: 'cowork', title: ' Q4 deck ', url: COWORK } });
  assert.deepEqual([t.origin_kind, t.origin_title, t.origin_url], ['cowork', 'Q4 deck', COWORK]);
  assert.deepEqual(store.state().tasks[0].origin_title, 'Q4 deck');
  const chat = store.updateTask(t.id, { origin: { kind: 'chat', title: 'Budget' } });
  assert.deepEqual([chat.origin_kind, chat.origin_title, chat.origin_url], ['chat', 'Budget', null], 'a new origin replaces all three fields');
  const bulk = store.updateTasks([t.id], { origin: null });
  assert.deepEqual(bulk.before, [{ id: t.id, origin: { kind: 'chat', title: 'Budget' } }], 'the old origin, for undo');
  assert.deepEqual([store.getTask(t.id).origin_kind, store.getTask(t.id).origin_title], [null, null]);
  assert.equal(store.addTask({ ...task, origin: { url: COWORK } }).origin_kind, 'claude_code');
  assert.equal(store.addTask({ ...task, origin: { url: 'https://example.com/x' } }).origin_kind, null);
  const { added } = store.addTasks([{ ...task, title: 'A', origin: { kind: 'email', title: 'Sam' } }, { ...task, title: 'B' }]);
  assert.deepEqual(added.map(a => store.getTask(a.id).origin_kind), ['email', null]);
});

test('compact shapes carry a short origin string, never the link', () => {
  const { store } = makeStore();
  const a = store.addTask({ ...task, title: 'A', origin: { kind: 'cowork', title: 'Q4 deck', url: COWORK } });
  store.addTask({ ...task, title: 'B' });
  store.addTask({ ...task, title: 'C', origin: { kind: 'chat' } });
  store.addTask({ ...task, title: 'D', origin: { url: 'https://example.com' } });
  const list = store.searchTasks().tasks as { title: string; origin?: string }[];
  assert.deepEqual(list.map(x => x.origin), ['cowork: Q4 deck', undefined, 'chat', 'link']);
  const today = store.overview().week.days.find(d => d.today)!.tasks!;
  assert.equal(today.find(x => x.id === a.id)!.origin, 'cowork: Q4 deck');
  assert.doesNotMatch(JSON.stringify(store.overview()), /session_01/, 'the overview stays slim');
  const full = store.searchTasks({ ids: [a.id], detail: 'full' }).tasks[0] as { origin_kind: string; origin_title: string; origin_url: string };
  assert.deepEqual([full.origin_kind, full.origin_title, full.origin_url], ['cowork', 'Q4 deck', COWORK]);
});

test('pending requests carry their task origin: overview, get_pending_requests and state', async () => {
  const { store } = makeStore();
  const a = store.addTask({ ...task, priority: 'high', origin: { kind: 'cowork', title: 'Q4 deck', url: COWORK } });
  const b = store.addTask({ ...task, priority: 'high' });
  store.queueRequest({ prompt: 'Do task ' + a.id, task_id: a.id });
  store.queueRequest({ prompt: 'Do task ' + b.id, task_id: b.id });
  store.queueRequest({ prompt: 'Plan my day' });
  const origin = { kind: 'cowork', title: 'Q4 deck', url: COWORK };
  assert.deepEqual(store.state().requests.map(r => r.origin), [origin, undefined, undefined]);
  assert.deepEqual(store.overview().pending_requests.map(r => (r as { origin?: unknown }).origin), [origin, undefined, undefined]);
  const [x, y] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(x);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(y);
  const r = JSON.parse((await client.callTool({ name: 'get_pending_requests', arguments: {} }) as any).content[0].text);
  assert.deepEqual(r.requests.map((q: { origin?: unknown }) => q.origin), [origin, undefined, undefined]);
  const added = JSON.parse((await client.callTool({ name: 'add_task', arguments: { ...task, origin: { kind: 'Cowork', title: 'Here', url: COWORK } } }) as any).content[0].text);
  assert.equal(added.origin_kind, 'cowork');
  const bad = await client.callTool({ name: 'update_task', arguments: { id: a.id, origin: { url: 'javascript:alert(1)' } } }) as any;
  assert.equal(bad.isError, true);
  assert.match(INSTRUCTIONS, /get_session with no session_id/);
  assert.match(INSTRUCTIONS, /leave it unless the owner asks you to do it here/);
});

test('REST: PATCH {origin} sets and clears it', async t => {
  const { store } = makeStore();
  const server = createApp(store, { token: 'secret' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const patch = async (body: unknown) => {
    const res = await fetch(base + '/tasks/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const id = store.addTask(task).id;
  const ok = await patch({ origin: { kind: 'cowork', title: 'Q4', url: COWORK } });
  assert.deepEqual([ok.status, ok.body.origin_kind, ok.body.origin_url], [200, 'cowork', COWORK]);
  const bad = await patch({ origin: { url: 'http://claude.ai/x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^origin\.url: /);
  const cleared = await patch({ origin: null });
  assert.deepEqual([cleared.body.origin_kind, cleared.body.origin_title, cleared.body.origin_url], [null, null, null]);
});
