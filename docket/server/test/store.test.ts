import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, task } from './helpers.js';
import { HeldError } from '../src/store.js';
import { periodStart } from '../src/dates.js';

test('add_task defaults day to today and rounds estimates', () => {
  const { store } = makeStore();
  const t = store.addTask({ ...task, est: 2.4 });
  assert.equal(t.day, '2026-10-01');
  assert.equal(t.est, 5);
  assert.equal(t.done, false);
  assert.match(t.id, /^[a-z0-9]{6}$/);
});

test('validation errors are user-facing', () => {
  const { store } = makeStore();
  assert.throws(() => store.addTask({ ...task, area: 'Fun' as never }), /area must be/);
  assert.throws(() => store.addTask({ ...task, day: 'Friday' }), /YYYY-MM-DD/);
  assert.throws(() => store.updateTask('nope', { title: 'x' }), /No task/);
});

test('steps can be set and toggled', () => {
  const { store } = makeStore();
  const t = store.addTask(task);
  store.setSteps(t.id, ['a', ' b ', '']);
  const after = store.toggleStep(t.id, 1);
  assert.deepEqual(after.steps, [{ text: 'a', done: false }, { text: 'b', done: true }]);
  assert.throws(() => store.toggleStep(t.id, 5), /index must be/);
});

test('propose_moves never moves; resolve_move applies on approval', () => {
  const { store } = makeStore();
  const a = store.addTask(task), b = store.addTask(task);
  const [m1, m2] = store.proposeMoves([{ id: a.id, to_day: '2026-10-02', reason: 'room Fri' }, { id: b.id, to_day: '2026-10-03', reason: 'x' }]);
  assert.equal(store.getTask(a.id).day, '2026-10-01');
  assert.equal(store.pendingMoves().length, 2);
  store.resolveMove(m1.id, true);
  store.resolveMove(m2.id, false);
  assert.equal(store.getTask(a.id).day, '2026-10-02');
  assert.equal(store.getTask(b.id).day, '2026-10-01');
  assert.equal(store.pendingMoves().length, 0);
  assert.throws(() => store.resolveMove(m1.id, true), /already approved/);
});

test('a new proposal for the same task replaces the old one', () => {
  const { store } = makeStore();
  const a = store.addTask(task);
  store.proposeMoves([{ id: a.id, to_day: '2026-10-02', reason: '' }]);
  store.proposeMoves([{ id: a.id, to_day: '2026-10-03', reason: '' }]);
  assert.deepEqual(store.pendingMoves().map(m => m.to_day), ['2026-10-03']);
});

test('overview reports capacity, over-days and usage', () => {
  const { store } = makeStore();
  store.addTask({ ...task, est: 300 });
  store.addTask({ ...task, est: 100 });
  store.addTask({ ...task, est: 60, day: '2026-09-28' });
  const o = store.overview();
  assert.equal(o.today, '2026-10-01');
  assert.equal(o.weekday, 'Thursday');
  assert.equal(o.week.start, '2026-09-28');
  assert.equal(o.week.end, '2026-10-04');
  assert.equal(o.week.number, 40);
  assert.equal(o.day.open_min, 400);
  assert.equal(o.day.over_min, 40);
  assert.equal(o.week.days_over, 1);
  assert.equal(o.overdue.length, 1);
  assert.equal(o.usage.used_pct, 0);
});

test('usage period starts Monday 09:00 and resets to 0', () => {
  const { store, setNow } = makeStore('2026-10-04T20:00:00');
  assert.equal(periodStart(new Date('2026-10-05T08:59:00')).getDate(), 28);
  assert.equal(periodStart(new Date('2026-10-05T09:00:00')).getDate(), 5);
  store.setUsage(65);
  assert.equal(store.usage().used_pct, 65);
  setNow('2026-10-05T08:30:00');
  assert.equal(store.usage().used_pct, 65);
  setNow('2026-10-05T09:01:00');
  assert.equal(store.usage().used_pct, 0);
  assert.equal(store.usage().resets_at, new Date('2026-10-12T09:00:00').toISOString());
});

test('tool calls drive the usage estimate and calibrate it', () => {
  const { store } = makeStore();
  store.setUsage(40);
  for (let i = 0; i < 10; i++) store.logCall('get_overview');
  const u = store.usage();
  assert.equal(u.used_pct, 40);
  assert.equal(u.estimated, true);
  assert.equal(u.estimated_used_pct, 43); // 10 × weight 1 × 0.3%
  store.setUsage(50); // observed 1% per call, so the rate moves towards it
  assert.equal(store.usage().estimated, false);
  assert.ok(store.settings().pct_per_call > 0.3);
});

test('budget guard holds low-priority breakdowns at the reserve, and Run anyway applies them', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  const high = store.addTask({ ...task, priority: 'high' });
  store.setUsage(85); // 15% left, reserve 20%
  assert.equal(store.usage().at_reserve, true);
  assert.throws(() => store.setSteps(low.id, ['a', 'b']), (e: unknown) => e instanceof HeldError && /Budget at reserve: request held/.test(e.message));
  assert.equal(store.getTask(low.id).steps.length, 0);
  store.setSteps(high.id, ['x']); // high priority passes
  const [held] = store.heldRequests();
  assert.equal(held.label, 'Break down: Task');
  assert.deepEqual(store.runHeld(held.id), { applied: true });
  assert.deepEqual(store.getTask(low.id).steps.map(s => s.text), ['a', 'b']);
  assert.equal(store.heldRequests().length, 0);
  assert.equal(store.pendingRequests().length, 0);
});

test('guard is off when high_only is off', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  store.setUsage(95);
  store.setSettings({ high_only: false });
  assert.equal(store.attachDraft(low.id, 'Hi').draft, 'Hi');
  assert.equal(store.saveReview('2026-09-28', 'ok').text, 'ok');
  assert.equal(store.heldRequests().length, 0);
});

test('saving a gmail id for the existing draft is not guarded', () => {
  const { store } = makeStore();
  const t = store.addTask(task);
  store.attachDraft(t.id, 'Hello Sam');
  store.setUsage(90);
  const after = store.attachDraft(t.id, 'Hello Sam', 'g-123');
  assert.equal(after.gmail_draft_id, 'g-123');
  assert.throws(() => store.attachDraft(t.id, 'New text'), HeldError);
});

test('UI requests: queued normally, held when low priority at the reserve, released with override', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  const q = store.queueRequest({ prompt: 'Plan my day', label: 'Plan my day' });
  assert.equal(q.status, 'pending');
  store.setUsage(90);
  const r = store.queueRequest({ prompt: `Break down task ${low.id}`, task_id: low.id });
  assert.equal(r.status, 'held');
  assert.equal(store.queueRequest({ prompt: 'Urgent', priority: 'high' }).status, 'pending');
  const held = store.heldRequests()[0];
  const out = store.runHeld(held.id);
  assert.equal(out.applied, false);
  assert.equal(out.request!.override, true);
  // Claude handles it: the override lets set_steps through.
  store.setSteps(low.id, ['one'], { request_id: out.request!.id });
  store.completeRequest(out.request!.id, 'Split into one step.');
  assert.equal(store.state().reply, 'Split into one step.');
  assert.equal(store.pendingRequests().length, 2);
});

test('inbox: recorded emails and suggestions that can be added', () => {
  const { store } = makeStore();
  const [e] = store.recordEmails([{ from: 'Acme', subject: 'Invoice due Friday' }]);
  const [f] = store.suggestTasks([{ title: 'Pay Acme invoice', due: '2026-10-02', est: 10, priority: 'high', email_id: e.id }]);
  const t = store.resolveFind(f.id, true)!;
  assert.equal(t.source, 'gmail');
  assert.equal(t.due, '2026-10-02');
  assert.equal(store.finds().length, 0);
});

test('weekly review is stored by week and can be dismissed', () => {
  const { store } = makeStore();
  store.saveReview('2026-10-01', 'Good week.');
  assert.deepEqual(store.latestReview()?.week_start, '2026-09-28');
  store.dismissReview('2026-09-28');
  assert.equal(store.latestReview(), null);
});

test('sample data matches the prototype', () => {
  const { store } = makeStore();
  store.loadSample();
  const o = store.overview();
  assert.equal(o.day.open.length, 10);
  assert.equal(o.day.over_min, 100); // "You're 1h 40m over today."
  assert.equal(store.emails().length, 5);
});
