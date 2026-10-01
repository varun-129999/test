import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeStore } from './helpers.js';
import { createMcpServer } from '../src/tools.js';
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

test('exposes the documented tool set', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  for (const n of ['get_overview', 'list_tasks', 'add_task', 'update_task', 'complete_task', 'delete_task', 'set_steps', 'toggle_step', 'propose_moves', 'resolve_move', 'attach_draft', 'get_usage', 'set_usage', 'set_settings', 'get_pending_requests', 'complete_request', 'save_review'])
    assert.ok(names.includes(n), n);
});

test('a planning conversation through MCP', async () => {
  const { store, client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  const deck = json(await call('add_task', { title: 'Deck', area: 'Work', est: 300, priority: 'high', energy: 'high' }));
  const gym = json(await call('add_task', { title: 'Gym', area: 'Health', est: 90, priority: 'low', energy: 'high' }));
  const o = json(await call('get_overview'));
  assert.equal(o.day.over_min, 30);
  const moved = json(await call('propose_moves', { moves: [{ id: gym.id, to_day: '2026-10-02', reason: 'Fri has room' }] }));
  assert.equal(store.getTask(gym.id).day, '2026-10-01');
  await call('resolve_move', { move_id: moved.proposed[0].id, approve: true });
  assert.equal(store.getTask(gym.id).day, '2026-10-02');
  await call('set_steps', { id: deck.id, steps: ['Outline', 'Slides'] });
  await call('toggle_step', { id: deck.id, index: 0 });
  assert.equal(json(await call('list_tasks', {})).find((t: any) => t.id === deck.id).steps[0].done, true);
  await call('complete_task', { id: deck.id });
  assert.equal(store.getTask(deck.id).done, true);
  // Each call was logged for the estimate.
  assert.ok(store.usage().calls_since_reset >= 8);
});

test('bad input and held requests come back as tool errors', async () => {
  const { client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  const bad = await call('update_task', { id: 'missing', title: 'x' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /No task/);
  const t = json(await call('add_task', { title: 'Plan trip', area: 'Personal', est: 60, priority: 'low', energy: 'low' }));
  await call('set_usage', { used_pct: 85 });
  const held = await call('set_steps', { id: t.id, steps: ['a'] });
  assert.equal(held.isError, true);
  assert.match(text(held), /^Budget at reserve: request held/);
  assert.equal(json(await call('get_overview')).held_requests.length, 1);
});

test('pending requests from the app round-trip through Claude', async () => {
  const { store, client } = await connect();
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> });
  store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day' });
  const [req] = json(await call('get_pending_requests'));
  assert.equal(req.prompt, 'Plan my day');
  await call('complete_request', { id: req.id, reply: 'Your day fits.' });
  assert.equal(text(await call('get_pending_requests')), 'No pending requests.');
  assert.equal(store.state().reply, 'Your day fits.');
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
    assert.equal(json(await bearer.callTool({ name: 'list_tasks', arguments: {} })).length, 2);
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
