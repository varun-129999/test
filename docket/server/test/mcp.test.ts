import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeStore } from './helpers.js';
import { createMcpServer } from '../src/tools.js';
import { CALL_WEIGHTS } from '../src/store.js';
import { createApp } from '../src/http.js';

const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

async function connect() {
  const { store } = makeStore();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return { store, client };
}

const TOOLS = [
  'get_overview', 'list_tasks', 'add_task', 'add_tasks', 'update_task', 'update_tasks', 'complete_task', 'delete_task',
  'set_steps', 'add_steps', 'set_step', 'propose_moves', 'resolve_moves', 'attach_draft', 'attach_result',
  'get_usage', 'set_usage', 'set_settings', 'get_pending_requests', 'complete_request', 'hold_request',
  'save_review', 'set_week_plan', 'record_emails', 'suggest_tasks',
];

test('exposes exactly the documented 25 tools, each weighted, described and annotated', async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), [...TOOLS].sort());
  assert.deepEqual(Object.keys(CALL_WEIGHTS).sort(), [...TOOLS].sort());
  for (const t of tools) {
    assert.match(t.description!, /Docket/, t.name);
    assert.equal(t.annotations?.openWorldHint, false, t.name);
  }
  const ann = (n: string) => tools.find(t => t.name === n)!.annotations!;
  for (const n of ['list_tasks', 'get_usage']) assert.equal(ann(n).readOnlyHint, true, n);
  // Both reads apply the pickup rule, which moves requests: honest hints, and the description says so.
  for (const n of ['get_overview', 'get_pending_requests']) {
    assert.deepEqual([ann(n).readOnlyHint, ann(n).destructiveHint, ann(n).idempotentHint], [false, false, true], n);
    assert.match(tools.find(t => t.name === n)!.description!, /held list/, n);
  }
  for (const n of ['delete_task', 'set_steps', 'record_emails']) assert.equal(ann(n).destructiveHint, true, n);
  for (const n of ['set_step', 'complete_task', 'set_usage', 'set_settings', 'complete_request', 'save_review', 'set_week_plan']) assert.equal(ann(n).idempotentHint, true, n);
});

test('a planning conversation through MCP', async () => {
  const { store, client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  const deck = json(await call('add_task', { title: 'Deck', area: 'Work', est: 300, priority: 'high', energy: 'high' }));
  const gym = json(await call('add_task', { title: 'Gym', area: 'Health', est: 90, priority: 'low', energy: 'high' }));
  const o = json(await call('get_overview'));
  assert.equal(o.day.over_min, 30);
  const moved = json(await call('propose_moves', { moves: [{ id: gym.id, to_day: '2026-10-02', reason: 'Fri has room' }] }));
  assert.equal(moved.proposed[0].to_day_open_min, 90);
  assert.equal(store.getTask(gym.id).day, '2026-10-01');
  assert.deepEqual(json(await call('resolve_moves', { move_ids: [moved.proposed[0].id], approve: true })), { resolved: 1 });
  assert.equal(store.getTask(gym.id).day, '2026-10-02');
  await call('set_steps', { id: deck.id, steps: ['Outline', 'Slides'] });
  await call('set_step', { id: deck.id, index: 0, done: true });
  await call('set_step', { id: deck.id, index: 0, done: true }); // idempotent
  const list = json(await call('list_tasks', {}));
  assert.equal(list.total, 2);
  assert.equal(list.truncated, false);
  assert.equal(list.tasks.find((t: any) => t.id === deck.id).steps, '1/2');
  const full = json(await call('list_tasks', { ids: [deck.id], detail: 'full' }));
  assert.equal(full.tasks[0].steps[0].done, true);
  await call('complete_task', { id: deck.id });
  assert.equal(store.getTask(deck.id).done, true);
  // Each call was logged for the estimate.
  assert.ok(store.usage().calls_since_reset >= 10);
});

test('bad input is a tool error; at the reserve work is saved with a budget note', async () => {
  const { store, client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  const bad = await call('update_task', { id: 'missing', title: 'x' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /No task/);
  const long = await call('add_task', { title: 'x'.repeat(300), area: 'Work', est: 30, priority: 'med', energy: 'low' });
  assert.equal(long.isError, true);
  assert.match(text(long), /title/);
  const t = json(await call('add_task', { title: 'Plan trip', area: 'personal', est: 60, priority: 'medium', energy: 'Low' }));
  assert.deepEqual([t.area, t.priority, t.energy], ['Personal', 'med', 'low']);
  const high = json(await call('add_task', { title: 'Deck', area: 'Work', est: 60, priority: 'high', energy: 'high' }));
  await call('set_usage', { used_pct: 85 });
  const low = json(await call('set_steps', { id: t.id, steps: ['a'] }));
  assert.deepEqual(low.steps, [{ text: 'a', done: false }]);
  assert.match(low.budget_note, /^Saved\. You're at your reserve/);
  assert.equal(json(await call('set_steps', { id: high.id, steps: ['a'] })).budget_note, undefined);
  assert.ok(json(await call('attach_draft', { id: t.id, text: 'Hi' })).budget_note);
  const gid = json(await call('attach_draft', { id: t.id, text: 'Hi', gmail_draft_id: 'g-1' }));
  assert.deepEqual([gid.gmail_draft_id, gid.budget_note], ['g-1', undefined], 'same text plus a Gmail id is not new work');
  assert.ok(json(await call('save_review', { week_start: '2026-09-28', text: 'ok' })).budget_note);
  assert.equal(store.heldRequests().length, 0, 'nothing is held by the tools themselves');
  // Claude parks the next one instead of doing it.
  const h1 = json(await call('hold_request', { label: 'Draft: Plan trip', prompt: `Draft for task ${t.id}`, task_id: t.id }));
  const h2 = json(await call('hold_request', { label: 'Draft: Plan trip', prompt: `Draft the trip email for task ${t.id}`, task_id: t.id }));
  assert.equal(h1.id, h2.id, 'upsert on (task, label)');
  assert.equal(h2.priority, 'med');
  assert.deepEqual(json(await call('get_overview')).held_requests, [{ id: h1.id, label: 'Draft: Plan trip' }]);
});

test('pending requests from the app round-trip through Claude', async () => {
  const { store, client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day' });
  const o = json(await call('get_overview'));
  assert.equal(o.pending_requests.length, 1);
  const { requests: [req], held_now } = json(await call('get_pending_requests'));
  assert.equal(req.prompt, 'Plan my day');
  assert.equal(held_now, 0);
  const done = json(await call('complete_request', { id: req.id, reply: 'Your day fits.' }));
  assert.equal(done.outcome, 'done');
  assert.equal(text(await call('get_pending_requests')), 'No pending requests.');
  assert.equal(store.state().reply, 'Your day fits.');
  const again = await call('complete_request', { id: req.id });
  assert.equal(again.isError, true);
  assert.match(text(again), /not pending/);
});

test('remote MCP over Streamable HTTP requires the token', async () => {
  const { store } = makeStore();
  const server = createApp(store, { token: 'secret' }).listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const anon = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    for (const url of [`http://127.0.0.1:${port}/mcp?token=secret`, `http://127.0.0.1:${port}/mcp/secret`]) {
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const r = await client.callTool({ name: 'add_task', arguments: { title: 'Remote', area: 'Work', est: 20, priority: 'med', energy: 'low' } });
      assert.equal(json(r).title, 'Remote');
      await client.close();
    }
    const bearer = new Client({ name: 'test', version: '1' });
    await bearer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer secret' } } }));
    assert.equal(json(await bearer.callTool({ name: 'list_tasks', arguments: {} })).total, 2);
    await bearer.close();
  } finally {
    server.close();
  }
});

test('REST API: auth, state and edits', async () => {
  const { store } = makeStore();
  const server = createApp(store, { token: 'secret' }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer secret' };
  try {
    assert.equal((await fetch(base + '/state')).status, 401);
    assert.equal((await fetch(base.replace('/api', '/healthz'))).status, 200);
    const t = await (await fetch(base + '/tasks', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Call mum', area: 'Personal', est: 20, priority: 'med', energy: 'low' }) })).json();
    await fetch(`${base}/tasks/${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ day: '2026-10-02' }) });
    const bad = await fetch(`${base}/tasks/${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ area: 'Fun' }) });
    assert.equal(bad.status, 400);
    const q = await (await fetch(base + '/requests', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'Plan my day' }) })).json();
    assert.equal(q.status, 'pending');
    const s = await (await fetch(base + '/state', { headers: H })).json();
    assert.equal(s.tasks[0].day, '2026-10-02');
    assert.equal(s.requests.length, 1);
    assert.equal(s.last_cmd, 'Plan my day');
  } finally {
    server.close();
  }
});

test('without a token only local Host headers are served', async () => {
  const { store } = makeStore();
  const server = createApp(store, {}).listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    assert.equal((await fetch(`http://localhost:${port}/api/health`)).status, 200);
    const status = await new Promise<number>(resolve => {
      request({ port, path: '/api/health', headers: { host: 'evil.example' } }, res => resolve(res.statusCode!)).end();
    });
    assert.equal(status, 403);
  } finally {
    server.close();
  }
});
