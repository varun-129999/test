import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, task } from './helpers.js';
import { fmtMoment } from '../src/dates.js';

const iso = (s: string) => new Date(s).toISOString();

test('the reported figure drives the guard; the estimate only nudges (near_reserve)', () => {
  const { store } = makeStore();
  store.setUsage(75);
  for (let i = 0; i < 20; i++) store.logCall('get_overview');
  const u = store.usage();
  assert.deepEqual([u.used_pct, u.est_pct, u.estimated, u.at_reserve, u.near_reserve], [75, 81, true, false, true]);
  assert.equal(u.source, 'owner');
  assert.equal(u.resets_label, 'Mon 5 Oct 09:00');
  store.setUsage(85);
  assert.deepEqual([store.usage().at_reserve, store.usage().near_reserve], [true, false]);
  store.setSettings({ high_only: false });
  assert.deepEqual([store.usage().at_reserve, store.usage().near_reserve], [false, false]);
});

test('calibration: bounded, and never from a stale or falling report', () => {
  const calls = (s: ReturnType<typeof makeStore>['store'], n: number) => { for (let i = 0; i < n; i++) s.logCall('get_overview'); };
  // Upper bound: a big jump over few calls is mostly other Claude use.
  const a = makeStore();
  a.store.setUsage(10); calls(a.store, 4); a.store.setUsage(90);
  assert.equal(a.store.settings().pct_per_call, 1);
  // An unchanged figure is a sample too: the rate falls, but not below 0.05.
  const b = makeStore();
  b.store.setUsage(50); calls(b.store, 10); b.store.setUsage(50);
  assert.equal(b.store.settings().pct_per_call, 0.24);
  for (let i = 0; i < 30; i++) { calls(b.store, 10); b.store.setUsage(50); }
  assert.equal(b.store.settings().pct_per_call, 0.05);
  // Too few calls, a falling figure, or a report older than 3 days: no change.
  const c = makeStore('2026-09-28T10:00:00');
  c.store.setUsage(20); calls(c.store, 3); c.store.setUsage(30);
  assert.equal(c.store.settings().pct_per_call, 0.3);
  calls(c.store, 10); c.store.setUsage(25);
  assert.equal(c.store.settings().pct_per_call, 0.3);
  calls(c.store, 10); c.setNow('2026-10-02T10:00:00'); c.store.setUsage(60);
  assert.equal(c.store.settings().pct_per_call, 0.3);
  // The first report of a week has nothing to compare with.
  const d = makeStore();
  calls(d.store, 10); d.store.setUsage(30);
  assert.equal(d.store.settings().pct_per_call, 0.3);
});

test('a status-line resets_at sets the window, which rolls forward by whole weeks', () => {
  const { store, setNow } = makeStore('2026-10-01T10:00:00');
  store.setUsage(30);
  store.holdRequest({ label: 'Draft: x', prompt: 'Draft x' });
  const resets = '2026-10-03T06:30:00Z';
  store.setUsage(40, { resets_at: resets, source: 'statusline' });
  let u = store.usage();
  assert.equal(u.resets_at, iso(resets));
  assert.equal(u.period_start, iso('2026-09-26T06:30:00Z'));
  assert.equal(u.resets_label, fmtMoment(new Date(resets)));
  assert.deepEqual([u.used_pct, u.source], [40, 'statusline']);
  assert.equal(store.resetNotice(), null, 'a moved boundary is not a reset');
  setNow('2026-10-04T10:00:00');
  u = store.usage();
  assert.equal(u.period_start, iso(resets));
  assert.equal(u.resets_at, iso('2026-10-10T06:30:00Z'));
  assert.deepEqual([u.used_pct, u.updated_at, u.source], [0, null, null]);
  assert.deepEqual(store.resetNotice(), { n: 1, at: iso(resets) });
  setNow('2026-10-18T10:00:00');
  assert.equal(store.usage().period_start, iso('2026-10-17T06:30:00Z'), 'two weeks later');
});

test('changing the reset time keeps this week\'s figure', () => {
  const { store } = makeStore();
  store.setUsage(65);
  store.setSettings({ reset: 'Tue 09:00' });
  assert.equal(store.usage().used_pct, 65);
  assert.equal(store.usage().period_start, iso('2026-09-29T09:00:00'));
  assert.throws(() => store.setSettings({ reset: 'whenever' }), /reset must look like/);
});

test('reset notice on a new week; Queue all releases every held request with an override', () => {
  const { store, setNow } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  store.setUsage(90);
  store.queueRequest({ prompt: `Break down task ${low.id}`, label: 'Break down', task_id: low.id });
  store.queueRequest({ prompt: 'Weekly review', label: 'Weekly review', priority: 'med' });
  assert.equal(store.heldRequests().length, 2);
  setNow('2026-10-04T20:00:00');
  assert.equal(store.usage().used_pct, 90, 'same week');
  assert.equal(store.resetNotice(), null);
  setNow('2026-10-05T09:30:00');
  assert.equal(store.usage().used_pct, 0);
  assert.deepEqual(store.state().reset_notice, { n: 2, at: iso('2026-10-05T09:00:00') });
  assert.equal(store.heldRequests().length, 2, 'not queued automatically');
  assert.deepEqual(store.queueAllHeld(), { queued: 2 });
  assert.equal(store.resetNotice(), null);
  assert.equal(store.heldRequests().length, 0);
  assert.deepEqual(store.pendingRequests().map(r => [r.label, r.override]), [['Break down', true], ['Weekly review', true]]);
  // Dismiss without queueing.
  store.setUsage(95);
  store.queueRequest({ prompt: 'Scan Gmail', priority: 'med' });
  setNow('2026-10-12T09:30:00');
  assert.equal(store.resetNotice()?.n, 1);
  store.dismissResetNotice();
  assert.equal(store.resetNotice(), null);
  assert.equal(store.heldRequests().length, 1);
});

test('queueRequest returns an existing request instead of a duplicate, and holds at the reserve', () => {
  const { store } = makeStore();
  const t = store.addTask({ ...task, priority: 'low' });
  const a = store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day', priority: 'high' });
  const b = store.queueRequest({ prompt: 'Plan my day, gym first', label: 'Plan my day', priority: 'high' });
  assert.equal(b.status, 'pending');
  assert.equal(b.status === 'pending' && b.existing, true);
  assert.equal(b.status === 'pending' && a.status === 'pending' && b.request.id === a.request.id, true);
  assert.equal(store.pendingRequests().length, 1);
  assert.equal(store.pendingRequests()[0].prompt, 'Plan my day, gym first', 'newest wording kept');
  assert.equal(store.queueRequest({ prompt: 'x', label: 'Break down', task_id: t.id }).status, 'pending');
  assert.equal(store.pendingRequests().length, 2, 'a different task is a different request');
  store.setUsage(90);
  const h1 = store.queueRequest({ prompt: 'Draft it', label: 'Draft', task_id: t.id });
  const h2 = store.queueRequest({ prompt: 'Draft it again', label: 'Draft', task_id: t.id });
  assert.equal(h1.status, 'held');
  assert.equal(h2.status === 'held' && h1.status === 'held' && h2.held.id === h1.held.id, true, 'held once');
  assert.equal(store.heldRequests().length, 1);
  assert.equal(store.queueRequest({ prompt: 'Urgent', label: 'Urgent', priority: 'high' }).status, 'pending');
});

test('hold_request upserts on (task, label)', () => {
  const { store } = makeStore();
  const t = store.addTask({ ...task, priority: 'low' });
  const a = store.holdRequest({ label: 'Draft: Task', prompt: 'one', task_id: t.id });
  const b = store.holdRequest({ label: 'Draft: Task', prompt: 'two', task_id: t.id });
  assert.equal(a.id, b.id);
  assert.deepEqual([b.prompt, b.priority], ['two', 'low']);
  const r1 = store.holdRequest({ label: 'Weekly review', prompt: 'r' });
  const r2 = store.holdRequest({ label: 'Weekly review', prompt: 'r2', priority: 'med' });
  assert.equal(r1.id, r2.id, 'no task: matched on label');
  assert.equal(r1.priority, 'med');
  assert.notEqual(store.holdRequest({ label: 'Break down: Task', prompt: 'x', task_id: t.id }).id, a.id);
  assert.equal(store.heldRequests().length, 3);
  assert.throws(() => store.holdRequest({ label: 'x', prompt: 'y', task_id: 'nope' }), /No task/);
});

test('pickup re-checks the reserve: below-high requests without an override leave the queue', () => {
  const { store } = makeStore();
  const med = store.queueRequest({ prompt: 'Scan Gmail', label: 'Scan Gmail', priority: 'med' });
  store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day', priority: 'high' });
  const h = store.holdRequest({ label: 'Weekly review', prompt: 'Review' });
  const approved = store.runHeld(h.id).request!;
  assert.equal(store.holdAtPickup(), 0, 'not at the reserve');
  store.setUsage(90);
  assert.equal(store.holdAtPickup(), 1);
  assert.deepEqual(store.pendingRequests().map(r => r.label), ['Plan my day', 'Weekly review']);
  assert.equal(store.pendingRequests()[1].id, approved.id);
  assert.deepEqual(store.heldRequests().map(x => x.label), ['Scan Gmail']);
  const moved = store.request(med.status === 'pending' ? med.request.id : '')!;
  assert.deepEqual([moved.status, moved.outcome, moved.seen], ['cancelled', 'held', true]);
  assert.throws(() => store.completeRequest(moved.id), /waiting for budget/);
  assert.equal(store.holdAtPickup(), 0);
});

test('complete_request records outcomes and refuses requests that are not pending', () => {
  const { store } = makeStore();
  const q = (label: string) => { const r = store.queueRequest({ prompt: label, label }); return r.status === 'pending' ? r.request.id : ''; };
  const a = q('Give to Claude: visa'), b = q('Draft'), c = q('Scan'), d = q('Removed');
  const na = store.completeRequest(a, { outcome: 'needs_owner', detail: 'Which passport number?' });
  assert.deepEqual([na.status, na.outcome, na.detail, na.reply, na.seen], ['done', 'needs_owner', 'Which passport number?', 'Claude needs something from you.', false]);
  assert.equal(store.completeRequest(b, { outcome: 'failed', reply: 'Gmail was not connected.' }).outcome, 'failed');
  assert.equal(store.completeRequest(c).outcome, 'done');
  assert.equal(store.state().reply, 'Done.');
  assert.ok(store.state().reply_at);
  store.cancelRequest(d);
  assert.throws(() => store.completeRequest(a), /already complete/);
  assert.throws(() => store.completeRequest(d), /owner removed it/);
  assert.throws(() => store.completeRequest('r-nope'), /No request/);
});

test('attach_result, the recent list and seen', () => {
  const { store, setNow } = makeStore();
  const t = store.addTask(task);
  const r = store.queueRequest({ prompt: `Do task ${t.id}: book the dentist`, label: 'Give to Claude: Task', task_id: t.id });
  const reqId = r.status === 'pending' ? r.request.id : '';
  store.attachResult(t.id, 'Booked Tue 10:00.', 'https://example.com/booking');
  setNow('2026-10-01T10:05:00');
  store.completeRequest(reqId, { reply: 'Booked.' });
  setNow('2026-10-01T10:10:00');
  const other = store.queueRequest({ prompt: 'Remove me', label: 'Remove me' });
  store.cancelRequest(other.status === 'pending' ? other.request.id : '');
  const recent = store.state().recent;
  assert.deepEqual(recent.map(x => [x.label, x.outcome, x.seen]), [['Remove me', 'cancelled', true], ['Give to Claude: Task', 'done', false]]);
  assert.equal(recent[1].task_id, t.id);
  assert.equal(store.state().tasks[0].result, 'Booked Tue 10:00.');
  assert.deepEqual(store.markSeen([reqId]), { seen: 1 });
  assert.equal(store.recentRequests()[1].seen, true);
  assert.deepEqual(store.markSeen(), { seen: 0 });
  for (let i = 0; i < 12; i++) { const x = store.queueRequest({ prompt: 'p' + i, label: 'p' + i }); if (x.status === 'pending') store.completeRequest(x.request.id); }
  assert.equal(store.recentRequests().length, 10);
  assert.deepEqual(store.markSeen(), { seen: 12 });
});

test('a resets_at reported again with a little jitter keeps the same window', () => {
  const { store } = makeStore();
  store.setUsage(40, { resets_at: '2026-10-05T03:30:00Z', source: 'statusline' });
  const key = store.usage().period_start;
  store.setUsage(41, { resets_at: '2026-10-05T03:31:07Z', source: 'statusline' });
  store.setUsage(42, { resets_at: '2026-10-12T03:29:30Z', source: 'statusline' }); // next week's form of the same moment
  assert.equal(store.usage().period_start, key);
  assert.equal(store.usage().used_pct, 42);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM usage').get() as { n: number }).n, 1);
  store.setUsage(42, { resets_at: '2026-10-05T06:00:00Z' });
  assert.equal(store.usage().resets_at, new Date('2026-10-05T06:00:00Z').toISOString(), 'a real change moves it');
  assert.equal(store.usage().used_pct, 42);
});
