import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeStore, task } from './helpers.js';
import { createApp } from '../src/http.js';
import { INTERNAL_ERROR, createMcpServer } from '../src/tools.js';
import type { Store } from '../src/store.js';

/** A server on a random port with a small fetch helper that sends the token header. */
function serve(t: TestContext, store: Store) {
  const server = createApp(store, { token: 'secret' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(base + '/api' + path, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.json().catch(() => null) as any };
  };
  return { base, call };
}

test('REST validation: 400 with the bad fields named, aliases normalised, caps enforced', async t => {
  const { store } = makeStore();
  const { call } = serve(t, store);
  const bad: [string, string, unknown, RegExp][] = [
    ['POST', '/tasks', {}, /title: .*; area: /],
    ['POST', '/tasks', { ...task, title: 5 }, /^title: /],
    ['POST', '/tasks', { ...task, title: 'x'.repeat(300) }, /^title: .*200/],
    ['POST', '/tasks', { ...task, day: '2026-09-31' }, /day: "2026-09-31" is not a real date/],
    ['POST', '/tasks', { ...task, priority: 'urgent' }, /^priority: /],
    ['PUT', '/usage', {}, /^used_pct: /],
    ['PUT', '/usage', { used_pct: 50, resets_at: 'monday' }, /^resets_at: /],
    ['PATCH', '/settings', { capacity_hours: 'abc' }, /^capacity_hours: /],
    ['PATCH', '/settings', { reset: 'whenever' }, /^reset: /],
    ['POST', '/requests', {}, /^prompt: /],
    ['POST', '/requests', { prompt: 'x'.repeat(2001) }, /^prompt: /],
    ['PUT', '/week-plan', { text: '' }, /^text: /],
    ['POST', '/tasks', { ...task, link: 'javascript:alert(1)' }, /^link: must start/],
    ['PATCH', '/tasks/x', { link: 'data:text/html,x' }, /^link: /],
  ];
  for (const [method, path, body, re] of bad) {
    const r = await call(method, path, body);
    assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(r.body.error, re);
  }
  const ok = await call('POST', '/tasks', { ...task, area: 'personal', priority: 'medium', energy: 'High' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.area, ok.body.priority, ok.body.energy], ['Personal', 'med', 'high']);
  const id = ok.body.id;
  const notBool = await call('PATCH', `/tasks/${id}`, { done: 'false' });
  assert.equal(notBool.status, 400, '"false" is not a boolean');
  assert.equal(store.getTask(id).done, false);
  assert.equal((await call('PATCH', `/tasks/${id}`, { notes: 'Bring the form', result: null })).body.notes, 'Bring the form');
  assert.equal((await call('POST', `/moves/m1/resolve`, {})).status, 400);
  assert.equal(store.settings().reset, 'Mon 09:00');
  assert.match((await call('PATCH', `/tasks/nope`, { title: 'x' })).body.error, /No task/);
});

test('REST errors are JSON: unknown routes, malformed JSON, large bodies, no token in the URL', async t => {
  const { store } = makeStore();
  const { base, call } = serve(t, store);
  const nope = await call('GET', '/nope');
  assert.deepEqual([nope.status, nope.body], [404, { error: 'Not found' }]);
  assert.equal((await call('POST', '/tasks/x/y/z', {})).status, 404);
  const malformed = await call('POST', '/tasks', undefined, '{"title": ');
  assert.deepEqual([malformed.status, malformed.body], [400, { error: 'Invalid JSON' }]);
  assert.match(malformed.type, /json/);
  const big = await call('POST', '/tasks', undefined, JSON.stringify({ title: 'x'.repeat(1_100_000) }));
  assert.deepEqual([big.status, big.body], [413, { error: 'Body too large' }]);
  // Unauthenticated: 401 before any body is parsed.
  const anon = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title": ' });
  assert.equal(anon.status, 401);
  // ?token= works only where a header can't be sent.
  assert.equal((await fetch(base + '/api/state?token=secret')).status, 401);
  const events = new AbortController();
  const sse = await fetch(base + '/api/events?token=secret', { signal: events.signal });
  assert.equal(sse.status, 200);
  events.abort();
  assert.equal((await fetch(base + '/mcp?token=secret', { method: 'GET' })).status, 405, 'authorised, then no sessions');
  assert.equal((await fetch(base + '/mcp?token=wrong', { method: 'GET' })).status, 401);
});

test('REST: steps, moves, requests, held, week plan and the state shape', async t => {
  const { store, setNow } = makeStore();
  const { call } = serve(t, store);
  const tk = (await call('POST', '/tasks', { ...task, title: 'Deck', priority: 'low' })).body;
  await call('PUT', `/tasks/${tk.id}/steps`, { steps: ['Outline', 'Slides'] });
  assert.equal((await call('PATCH', `/tasks/${tk.id}/steps/0`, { done: true })).body.steps[0].done, true);
  const added = (await call('POST', `/tasks/${tk.id}/steps`, { steps: ['Numbers'], at: 1 })).body;
  assert.deepEqual(added.steps.map((s: any) => [s.text, s.done]), [['Outline', true], ['Numbers', false], ['Slides', false]]);
  const replaced = (await call('PUT', `/tasks/${tk.id}/steps`, { steps: ['Outline', 'Send'] })).body;
  assert.deepEqual(replaced.steps.map((s: any) => s.done), [true, false]);
  assert.equal((await call('POST', `/tasks/${tk.id}/steps/1/toggle`)).body.steps[1].done, true);
  assert.equal((await call('PATCH', `/tasks/${tk.id}/steps/7`, { done: true })).status, 400);

  store.proposeMoves([{ id: tk.id, to_day: '2026-10-02' }]);
  assert.deepEqual((await call('POST', '/moves/resolve-all', { approve: true })).body, { resolved: 1 });
  assert.equal(store.getTask(tk.id).day, '2026-10-02');

  const q1 = (await call('POST', '/requests', { prompt: 'Plan my day', label: 'Plan my day', priority: 'high' })).body;
  const q2 = (await call('POST', '/requests', { prompt: 'Plan my day', label: 'Plan my day', priority: 'high' })).body;
  assert.equal(q1.status, 'pending');
  assert.equal(q2.existing, true);
  assert.equal(q2.request.id, q1.request.id);
  await call('PUT', '/usage', { used_pct: 90, source: 'statusline', resets_at: '2026-10-05T03:30:00Z' });
  const held = (await call('POST', '/requests', { prompt: `Break down task ${tk.id}`, label: 'Break down', task_id: tk.id })).body;
  assert.equal(held.status, 'held');
  assert.equal(held.held.priority, 'low');

  await call('PUT', '/week-plan', { text: 'Ship the deck' });
  store.completeRequest(q1.request.id, { reply: 'Planned.' });
  let s = (await call('GET', '/state')).body;
  assert.deepEqual(Object.keys(s), ['today', 'now', 'tz', 'tasks', 'deleted', 'moves', 'held', 'requests', 'recent', 'usage', 'settings', 'emails', 'finds', 'review', 'week_plan', 'reset_notice', 'last_cmd', 'reply', 'reply_at', 'inbox_checked_at', 'flags', 'version']);
  assert.match(s.now, /^2026-10-01T10:00:00[+-]\d\d:\d\d$/);
  assert.deepEqual([s.usage.used_pct, s.usage.source, s.usage.at_reserve], [90, 'statusline', true]);
  assert.equal(s.week_plan.text, 'Ship the deck');
  assert.deepEqual(s.recent.map((r: any) => [r.label, r.outcome, r.seen]), [['Plan my day', 'done', false]]);
  assert.deepEqual(Object.keys(s.held[0]).sort(), ['created_at', 'id', 'label', 'priority', 'prompt', 'task_id']);
  assert.equal(s.tasks[0].completed_at, null);
  assert.equal(typeof s.version, 'string');
  assert.deepEqual((await call('POST', '/requests/seen')).body, { seen: 1 });

  setNow('2026-10-05T10:00:00');
  s = (await call('GET', '/state')).body;
  assert.equal(s.reset_notice.n, 1);
  assert.deepEqual((await call('POST', '/held/queue-all')).body, { queued: 1 });
  s = (await call('GET', '/state')).body;
  assert.equal(s.reset_notice, null);
  assert.deepEqual(s.requests.map((r: any) => [r.label, r.override]), [['Break down', true]]);
  assert.equal(s.week_plan, null, 'a new week has no plan yet');
  await call('PUT', '/week-plan', { week_start: '2026-09-28', text: 'old' });
  assert.equal((await call('DELETE', '/week-plan/2026-09-28')).status, 200);
  assert.equal(store.weekPlan('2026-09-28'), null);
  assert.deepEqual((await call('POST', '/reset-notice/dismiss')).body, { ok: true });
  const r = (await call('DELETE', `/requests/${s.requests[0].id}`));
  assert.equal(r.status, 200);
  assert.equal(store.recentRequests()[0].outcome, 'cancelled');
});

async function connect(store: Store) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

test('MCP hides internal errors from Claude and logs them', async t => {
  const { store } = makeStore();
  const call = await connect(store);
  const logged = t.mock.method(console, 'error', () => {});
  store.overview = () => { throw new Error('SQLITE_ERROR: no such table: tasks'); };
  const r = await call('get_overview');
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, INTERNAL_ERROR);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0].arguments.slice(0, 2), ['[docket] tool failed', 'get_overview']);
  // A closed database is the same: no raw SQLite text.
  store.db.close();
  const closed = await call('add_task', task);
  assert.equal(closed.content[0].text, INTERNAL_ERROR);
  assert.equal(logged.mock.callCount(), 2);
  // Docket's own errors still come through as written.
  const { store: s2 } = makeStore();
  const call2 = await connect(s2);
  assert.match((await call2('delete_task', { id: 'nope' })).content[0].text, /No task with id "nope"/);
});

test('MCP: brain dump, bulk edit and pickup at the reserve', async () => {
  const { store } = makeStore();
  const call = await connect(store);
  const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  const dump = json(await call('add_tasks', { tasks: [
    { title: 'Groceries', area: 'personal', est: 45, priority: 'Medium', energy: 'low' },
    { title: 'Visa form', area: 'Personal', est: 30, priority: 'high', energy: 'low', day: '2026-10-02', notes: 'passport in drawer' },
  ] }));
  assert.equal(dump.added.length, 2);
  assert.deepEqual(dump.day_load, { '2026-10-01': 45, '2026-10-02': 30 });
  assert.equal(store.getTask(dump.added[0].id).priority, 'med');
  const bulk = json(await call('update_tasks', { ids: dump.added.map((a: any) => a.id), set: { day: '2026-10-03', area: 'work' } }));
  assert.equal(bulk.updated, 2);
  assert.deepEqual(bulk.before[1], { id: dump.added[1].id, day: '2026-10-02', area: 'Personal' });
  assert.equal(store.getTask(dump.added[1].id).area, 'Work');
  assert.equal(json(await call('list_tasks', { q: 'PASSPORT' })).tasks[0].title, 'Visa form');
  const plan = json(await call('set_week_plan', { text: 'Visa done by Friday' }));
  assert.equal(plan.week_start, '2026-09-28');
  assert.equal(json(await call('get_overview')).week.plan, 'Visa done by Friday');
  const result = json(await call('attach_result', { id: dump.added[1].id, text: 'Filled in; needs your signature.', url: 'https://example.com/form' }));
  assert.equal(result.result_url, 'https://example.com/form');
  // A below-high request queued before the reserve is moved at pickup.
  store.queueRequest({ prompt: 'Scan Gmail', label: 'Scan Gmail', priority: 'med' });
  store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day', priority: 'high' });
  await call('set_usage', { used_pct: 92 });
  assert.equal(store.usage().source, 'claude');
  const picked = json(await call('get_pending_requests'));
  assert.equal(picked.held_now, 1);
  assert.deepEqual(picked.requests.map((r: any) => r.prompt), ['Plan my day']);
  assert.match(picked.note, /Waiting for budget/);
  store.queueRequest({ prompt: 'Draft the reply', label: 'Draft', priority: 'high' });
  store.db.prepare(`UPDATE pending_requests SET priority = 'low' WHERE label = 'Draft'`).run();
  const o = json(await call('get_overview'));
  assert.equal(o.held_now, 1, 'the overview carries requests, so it applies the same rule');
  assert.deepEqual(o.pending_requests.map((r: any) => r.prompt), ['Plan my day']);
  const res = json(await call('complete_request', { id: picked.requests[0].id, outcome: 'needs_owner', detail: 'Which day for the gym?' }));
  assert.deepEqual([res.status, res.outcome], ['done', 'needs_owner']);
  assert.equal(store.request(picked.requests[0].id)!.detail, 'Which day for the gym?');
  assert.equal(text(await call('get_pending_requests')), 'No pending requests.');
  const all = json(await call('resolve_moves', { all: true, approve: false }));
  assert.deepEqual(all, { resolved: 0 });
});

const text = (r: { content: { text: string }[] }) => r.content[0].text;
