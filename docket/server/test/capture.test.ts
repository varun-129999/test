import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeStore } from './helpers.js';
import { createApp } from '../src/http.js';
import type { Store } from '../src/store.js';

const MAIN = 'main-secret', CAPTURE = 'capture-secret';

function serve(t: TestContext, store: Store, opts: { captureToken?: string; token?: string } = { captureToken: CAPTURE }) {
  const server = createApp(store, { token: MAIN, ...opts }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: 'Bearer ' + o.token } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
}

test('POST /api/quick parses the line and applies the defaults', async t => {
  const { store } = makeStore();
  const call = serve(t, store);
  const r = await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'Call Sam fri at 5pm 45m #Wedding p1 weekly' } });
  assert.equal(r.status, 200);
  const x = r.body.task;
  assert.deepEqual([x.title, x.day, x.at, x.est, x.project, x.priority, x.repeat, x.area, x.energy], ['Call Sam', '2026-10-02', '17:00', 45, 'Wedding', 'high', 'weekly:Fri', 'Work', 'low']);
  assert.equal(r.body.message, 'Added "Call Sam" for tomorrow at 17:00; repeats every Fri.');
  const plain = (await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'groceries' } })).body;
  assert.deepEqual([plain.task.title, plain.task.day, plain.task.est, plain.task.priority, plain.task.energy, plain.task.area], ['groceries', '2026-10-01', 30, 'med', 'low', 'Work']);
  assert.equal(plain.message, 'Added "groceries" for today.');
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: '+ Pay bill 1 nov' } })).body.message, 'Added "Pay bill" for Sun 1 Nov.');
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'Marathon 30h' } })).body.task.est, 1440);
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'Email Sam', source: 'gmail' } })).body.task.source, 'gmail');
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'Note', source: 'siri' } })).body.task.source, null);
  const empty = await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'tomorrow 30m' } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Nothing to add/);
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: {} })).body.error.startsWith('text: '), true);
  const long = (await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'word '.repeat(80) } })).body.task;
  assert.equal(long.title.length, 200);
  assert.equal(long.notes, 'word '.repeat(80).trim(), 'the whole line is kept');
});

test('links: a web link is the task link, a Claude chat or session link is its origin, anything else goes in the notes', async t => {
  const { store } = makeStore();
  const call = serve(t, store);
  const post = async (body: object) => (await call('POST', '/api/quick', { token: CAPTURE, body })).body.task;
  const a = await post({ text: 'Read later', link: 'https://example.com/article' });
  assert.equal(a.link, 'https://example.com/article');
  const b = await post({ text: 'Read https://example.com/in-text', link: 'https://example.com/shared' });
  assert.equal(b.link, 'https://example.com/in-text');
  assert.equal(b.notes, 'Link: https://example.com/shared');
  const same = await post({ text: 'Read https://example.com/x', link: 'https://example.com/x' });
  assert.deepEqual([same.link, same.notes], ['https://example.com/x', null]);
  const code = await post({ text: 'Finish the deck', link: 'https://claude.ai/code/session_abc' });
  assert.deepEqual([code.link, code.origin_kind, code.origin_url], [null, 'claude_code', 'https://claude.ai/code/session_abc']);
  const chat = await post({ text: 'Follow up https://claude.ai/chat/0199-abc' });
  assert.deepEqual([chat.title, chat.origin_kind, chat.origin_url], ['Follow up', 'chat', 'https://claude.ai/chat/0199-abc']);
  const mail = await post({ text: 'Reply to Sam', link: 'message://%3c123@mail%3e' });
  assert.deepEqual([mail.link, mail.notes], [null, 'Link: message://%3c123@mail%3e']);
});

test('"ask Claude ..." queues a high-priority request instead of a task', async t => {
  const { store } = makeStore();
  store.setUsage(90); // at the reserve: high priority still queues
  const call = serve(t, store);
  const r = await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'Ask Claude to plan my week around the offsite', link: 'https://example.com/agenda' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.task, undefined);
  assert.deepEqual([r.body.request.priority, r.body.request.status], ['high', 'pending']);
  assert.equal(r.body.request.prompt, 'plan my week around the offsite\n\nLink: https://example.com/agenda');
  assert.equal(r.body.message, 'Queued for Claude: "plan my week around the offsite". Open Claude to run it.');
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'claude: summarise my inbox' } })).body.request.prompt, 'summarise my inbox');
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'ask claude' } })).status, 400);
  assert.equal(store.pendingRequests().length, 2);
  assert.equal(store.listTasks().length, 0);
});

test('the capture token works only on the quick routes; the main token works there too', async t => {
  const { store } = makeStore();
  const call = serve(t, store);
  const body = { text: 'Call mum' };
  assert.equal((await call('POST', '/api/quick', { token: MAIN, body })).status, 200);
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body })).status, 200);
  assert.equal((await call('POST', '/api/quick?token=' + CAPTURE, { body })).status, 200, '?token= for share flows that cannot set headers');
  assert.equal((await call('POST', '/api/quick?token=' + MAIN, { body })).status, 401, 'the main token stays out of URLs');
  assert.equal((await call('POST', '/api/quick', { body })).status, 401);
  assert.equal((await call('POST', '/api/quick', { token: 'wrong', body })).status, 401);
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE + 'x', body })).status, 401);
  const ping = await call('GET', '/api/quick/ping', { token: CAPTURE });
  assert.deepEqual([ping.status, ping.body], [200, { ok: true, today: '2026-10-01' }]);
  assert.equal((await call('GET', '/api/quick/ping?token=' + CAPTURE)).status, 200);
  assert.equal((await call('GET', '/api/quick/ping')).status, 401);
  // Everywhere else the capture token is refused, in the header or the URL.
  for (const [method, path] of [['GET', '/api/state'], ['POST', '/api/tasks'], ['GET', '/api/backup'], ['GET', '/api/export.json'], ['POST', '/api/requests'], ['GET', '/api/quick']] as const) {
    assert.equal((await call(method, path, { token: CAPTURE, body: method === 'POST' ? {} : undefined })).status, 401, path);
  }
  assert.equal((await call('GET', '/api/state?token=' + CAPTURE)).status, 401);
  assert.equal((await call('GET', '/api/events?token=' + CAPTURE)).status, 401);
  assert.equal((await call('POST', '/mcp', { token: CAPTURE, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal((await call('POST', '/mcp?token=' + CAPTURE, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal((await call('POST', '/mcp/' + CAPTURE, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal(store.listTasks().length, 3);
});

test('without DOCKET_CAPTURE_TOKEN only the main token captures', async t => {
  const { store } = makeStore();
  const call = serve(t, store, {});
  assert.equal((await call('POST', '/api/quick', { token: CAPTURE, body: { text: 'x' } })).status, 401);
  assert.equal((await call('POST', '/api/quick?token=', { body: { text: 'x' } })).status, 401);
  assert.equal((await call('POST', '/api/quick', { token: MAIN, body: { text: 'x' } })).status, 200);
});
