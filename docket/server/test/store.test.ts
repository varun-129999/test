import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, task } from './helpers.js';
import { BUDGET_NOTE } from '../src/store.js';
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

test('propose_moves never moves; resolving applies on approval', () => {
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
  assert.equal(u.est_pct, 43); // 10 × weight 1 × 0.3%
  store.setUsage(50); // observed 1% per call, so the rate moves towards it
  assert.equal(store.usage().estimated, false);
  assert.ok(store.settings().pct_per_call > 0.3);
});

test('at the reserve, below-high work is saved with a note, never held', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  const high = store.addTask({ ...task, priority: 'high' });
  store.setUsage(85); // 15% left, reserve 20%
  assert.equal(store.usage().at_reserve, true);
  assert.deepEqual(store.setSteps(low.id, ['a', 'b']).steps.map(s => s.text), ['a', 'b']);
  assert.equal(store.budgetNote(store.getTask(low.id)), BUDGET_NOTE);
  assert.equal(store.budgetNote(store.getTask(high.id)), undefined);
  assert.equal(store.budgetNote(null), BUDGET_NOTE, 'a review has no task: below high');
  assert.equal(store.heldRequests().length, 0);
});

test('guard is off when high_only is off', () => {
  const { store } = makeStore();
  const low = store.addTask({ ...task, priority: 'low' });
  store.setUsage(95);
  store.setSettings({ high_only: false });
  assert.equal(store.usage().at_reserve, false);
  assert.equal(store.attachDraft(low.id, 'Hi').draft, 'Hi');
  assert.equal(store.saveReview('2026-09-28', 'ok').text, 'ok');
  assert.equal(store.budgetNote(low), undefined);
  assert.equal(store.heldRequests().length, 0);
});

test('re-attaching the same draft keeps its gmail id; new text replaces both', () => {
  const { store } = makeStore();
  const t = store.addTask(task);
  store.attachDraft(t.id, 'Hello Sam', 'g-123');
  assert.equal(store.attachDraft(t.id, 'Hello Sam').gmail_draft_id, 'g-123');
  const after = store.attachDraft(t.id, 'New text');
  assert.equal(after.draft, 'New text');
  assert.equal(after.gmail_draft_id, null);
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
  // Claude handles it; the override means no budget note.
  store.setSteps(low.id, ['one']);
  assert.equal(store.budgetNote(store.getTask(low.id), out.request!.id), undefined);
  store.completeRequest(out.request!.id, { reply: 'Split into one step.' });
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
  assert.equal(o.week.days.find(d => d.today)!.tasks!.length, 10);
  assert.equal(o.day.over_min, 100); // "You're 1h 40m over today."
  assert.equal(store.emails().length, 5);
});

test('completed_at follows done; a result can be attached and cleared', () => {
  const { store, setNow } = makeStore();
  const t = store.addTask({ ...task, notes: ' call first ', link: 'https://example.com/x' });
  assert.equal(t.notes, 'call first');
  assert.equal(t.completed_at, null);
  const done = store.completeTask(t.id);
  assert.equal(done.completed_at, new Date('2026-10-01T10:00:00').toISOString());
  setNow('2026-10-01T12:00:00');
  assert.equal(store.updateTask(t.id, { done: true }).completed_at, done.completed_at, 'already done: unchanged');
  assert.equal(store.updateTask(t.id, { done: false }).completed_at, null);
  const r = store.attachResult(t.id, ' Booked for Tue. ', 'https://example.com/booking');
  assert.deepEqual([r.result, r.result_url, r.result_at], ['Booked for Tue.', 'https://example.com/booking', new Date('2026-10-01T12:00:00').toISOString()]);
  const cleared = store.updateTask(t.id, { result: null });
  assert.deepEqual([cleared.result, cleared.result_url, cleared.result_at], [null, null, null]);
});

test('set_steps keeps done for unchanged text', () => {
  const { store } = makeStore();
  const t = store.addTask(task);
  store.setSteps(t.id, ['a', 'b', 'c']);
  store.setStep(t.id, 0, true);
  store.setStep(t.id, 2, true);
  const done = (x: { steps: { done: boolean }[] }) => x.steps.map(s => s.done);
  assert.deepEqual(done(store.setSteps(t.id, ['a', 'b', 'c', 'd'])), [true, false, true, false]);
  assert.deepEqual(store.setSteps(t.id, ['c', ' a ', '']).steps, [{ text: 'c', done: true }, { text: 'a', done: true }]);
  assert.deepEqual(done(store.setSteps(t.id, [{ text: 'c', done: false }, 'new', { text: 'a' }])), [false, false, true]);
  // Two identical steps: each old one is matched once.
  store.setSteps(t.id, ['x', 'x']);
  store.setStep(t.id, 0, true);
  assert.deepEqual(done(store.setSteps(t.id, ['x', 'x', 'x'])), [true, false, false]);
});

test('add_steps inserts without touching the rest; set_step is idempotent', () => {
  const { store } = makeStore();
  const t = store.addTask(task);
  assert.throws(() => store.setStep(t.id, 0, true), /no steps/);
  store.setSteps(t.id, ['a', 'b']);
  store.setStep(t.id, 1, true);
  store.setStep(t.id, 1, true);
  assert.deepEqual(store.addSteps(t.id, ['x'], 1).steps, [{ text: 'a', done: false }, { text: 'x', done: false }, { text: 'b', done: true }]);
  assert.deepEqual(store.addSteps(t.id, ['z']).steps.map(s => s.text), ['a', 'x', 'b', 'z']);
  assert.throws(() => store.setStep(t.id, 9, true), /index must be 0 to 3/);
  assert.equal(store.toggleStep(t.id, 1).steps[1].done, true);
  assert.throws(() => store.addSteps(t.id, Array.from({ length: 27 }, (_, i) => 's' + i)), /at most 30 steps/);
});

test('add_tasks adds all or nothing and reports the load of the affected days', () => {
  const { store } = makeStore();
  store.addTask({ ...task, est: 30 });
  const r = store.addTasks([{ ...task, title: 'A', est: 60 }, { ...task, title: 'B', est: 45, day: '2026-10-02' }]);
  assert.deepEqual(r.added.map(a => [a.title, a.day]), [['A', '2026-10-01'], ['B', '2026-10-02']]);
  assert.ok(r.added.every(a => /^[a-z0-9]{6}$/.test(a.id)));
  assert.deepEqual(r.day_load, { '2026-10-01': 90, '2026-10-02': 45 });
  assert.throws(() => store.addTasks([{ ...task, title: 'C' }, { ...task, title: 'D', day: '2026-09-31' }]), /YYYY-MM-DD/);
  assert.equal(store.listTasks().length, 3, 'C was rolled back');
});

test('update_tasks changes many and returns the old values', () => {
  const { store } = makeStore();
  const a = store.addTask({ ...task, title: 'A', priority: 'med' });
  const b = store.addTask({ ...task, title: 'B', priority: 'low', day: '2026-10-02' });
  store.proposeMoves([{ id: a.id, to_day: '2026-10-05' }]);
  const r = store.updateTasks([a.id, b.id, a.id], { day: '2026-10-03', priority: 'high' });
  assert.equal(r.updated, 2);
  assert.deepEqual(r.before, [{ id: a.id, day: '2026-10-01', priority: 'med' }, { id: b.id, day: '2026-10-02', priority: 'low' }]);
  assert.deepEqual(store.listTasks().map(t => [t.title, t.day, t.priority]), [['A', '2026-10-03', 'high'], ['B', '2026-10-03', 'high']]);
  assert.equal(store.pendingMoves().length, 0, 'a manual move makes the proposal stale');
  assert.throws(() => store.updateTasks([a.id, 'nope'], { est: 99 }), /No task/);
  assert.equal(store.getTask(a.id).est, 30, 'nothing changed on error');
});

test('resolve_moves resolves a list or everything pending', () => {
  const { store } = makeStore();
  const [a, b, c] = ['A', 'B', 'C'].map(title => store.addTask({ ...task, title }));
  const [m1] = store.proposeMoves([{ id: a.id, to_day: '2026-10-02' }]);
  assert.deepEqual(store.resolveMoves({ move_ids: [m1.id] }, false), { resolved: 1 });
  assert.throws(() => store.resolveMoves({ move_ids: [m1.id] }, true), /already skipped/);
  store.proposeMoves([{ id: b.id, to_day: '2026-10-03' }, { id: c.id, to_day: '2026-10-04' }]);
  assert.deepEqual(store.resolveMoves({ all: true }, true), { resolved: 2 });
  assert.deepEqual(store.listTasks().map(t => t.day), ['2026-10-01', '2026-10-03', '2026-10-04']);
  assert.throws(() => store.resolveMoves({}, true), /move_ids/);
  assert.deepEqual(store.resolveMoves({ all: true }, true), { resolved: 0 });
});

test('list_tasks: text search, ids, limits and the compact shape', () => {
  const { store } = makeStore();
  const pay = store.addTask({ ...task, title: 'Pay Acme invoice', priority: 'high' });
  store.addTask({ ...task, title: 'Call mum', notes: 'about the ACME party' });
  store.addTask({ ...task, title: 'Trip', project: 'Lisbon trip', day: '2026-10-03' });
  store.addTask({ ...task, title: '100% done?' });
  const done = store.completeTask(store.addTask({ ...task, title: 'Old acme thing' }).id);
  assert.deepEqual(store.listTasks({ q: 'acme' }).map(t => t.title), ['Pay Acme invoice', 'Call mum']);
  assert.deepEqual(store.listTasks({ q: 'acme', include_done: true }).length, 3);
  assert.deepEqual(store.listTasks({ q: 'lisbon' }).map(t => t.title), ['Trip']);
  assert.deepEqual(store.listTasks({ q: '%' }).map(t => t.title), ['100% done?'], '% is literal');
  assert.deepEqual(store.listTasks({ ids: [done.id] }).map(t => t.done), [true], 'ids finds done tasks');
  const page = store.searchTasks({ limit: 2 });
  assert.deepEqual([page.total, page.returned, page.truncated], [4, 2, true]);
  assert.equal(page.tasks[0].id, pay.id, 'high priority first within a day');
  assert.deepEqual(Object.keys(page.tasks[0]), ['id', 'title', 'day', 'area', 'est', 'priority', 'energy']);
  store.setSteps(pay.id, ['a']);
  assert.equal((store.searchTasks({ q: 'acme' }).tasks[0] as { steps: unknown }).steps, '0/1');
  assert.ok((store.searchTasks({ q: 'mum' }).tasks[0] as { has_notes?: boolean }).has_notes);
  const full = store.searchTasks({ ids: [pay.id], detail: 'full' }).tasks[0] as { steps: unknown[]; notes: unknown };
  assert.deepEqual(full.steps, [{ text: 'a', done: false }]);
});

test('a week plan is stored per week and shown in the overview', () => {
  const { store } = makeStore();
  assert.equal(store.weekPlan(), null);
  const p = store.setWeekPlan(undefined, ' Ship the deck; two gym sessions. ');
  assert.deepEqual([p.week_start, p.text], ['2026-09-28', 'Ship the deck; two gym sessions.']);
  store.setWeekPlan('2026-10-07', 'Lisbon prep');
  assert.equal(store.overview().week.plan, 'Ship the deck; two gym sessions.');
  assert.equal(store.overview('2026-10-05').week.plan, 'Lisbon prep');
  store.deleteWeekPlan('2026-10-05');
  assert.equal(store.weekPlan('2026-10-05'), null);
  assert.equal(store.state().week_plan?.text, 'Ship the deck; two gym sessions.');
  assert.throws(() => store.setWeekPlan('2026-02-30', 'x'), /week_start/);
});

test('the overview is slim: no day list, past days without tasks, requests inline', () => {
  const { store } = makeStore();
  const open = store.addTask({ ...task, title: 'Open today', est: 100, notes: 'n', link: 'https://example.com' });
  store.completeTask(store.addTask({ ...task, title: 'Done today', est: 20 }).id);
  store.completeTask(store.addTask({ ...task, title: 'Done Tue', day: '2026-09-29' }).id);
  const late = store.addTask({ ...task, title: 'Late', day: '2026-09-30' });
  store.addTask({ ...task, title: 'Fri', day: '2026-10-02' });
  store.setWeekPlan(undefined, 'Ship it');
  store.saveReview('2026-09-21', 'Last week was fine.');
  for (let i = 0; i < 6; i++) store.queueRequest({ prompt: 'Request ' + i, priority: i ? 'high' : 'med' });
  store.suggestTasks([{ title: 'From email' }]);
  const o = store.overview();
  assert.match(o.now, /^2026-10-01T10:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(o.tz, process.env.TZ);
  assert.deepEqual(Object.keys(o.day), ['date', 'open_min', 'over_min', 'free_min']);
  assert.deepEqual(o.day, { date: '2026-10-01', open_min: 100, over_min: 0, free_min: 260 });
  assert.equal(o.week.plan, 'Ship it');
  assert.equal(o.week.last_review, 'Last week was fine.');
  const tue = o.week.days.find(d => d.date === '2026-09-29')!;
  assert.equal(tue.past, true);
  assert.equal('tasks' in tue, false);
  assert.equal(tue.done_min, 30);
  const today = o.week.days.find(d => d.today)!;
  assert.equal(today.date, '2026-10-01');
  assert.deepEqual(today.tasks!.map(t => t.title), ['Open today'], 'open tasks only');
  assert.deepEqual(today.tasks![0], { id: open.id, title: 'Open today', area: 'Work', est: 100, priority: 'med', energy: 'low', has_notes: true, link: 'https://example.com' });
  assert.equal(o.week.days.filter(d => d.today).length, 1);
  assert.deepEqual(o.overdue.map(t => [t.id, t.day]), [[late.id, '2026-09-30']]);
  assert.deepEqual(Object.keys(o.usage), ['used_pct', 'est_pct', 'left_pct', 'at_reserve', 'near_reserve', 'resets', 'updated']);
  assert.equal(o.usage.resets, 'Mon 5 Oct 09:00');
  assert.equal(o.usage.updated, null);
  assert.equal(o.pending_requests.length, 5);
  assert.equal(o.more_requests, 1);
  assert.deepEqual(o.pending_requests[0], { id: o.pending_requests[0].id, prompt: 'Request 0', priority: 'med' });
  assert.equal(o.inbox_suggestions, 1);
  const empty = makeStore().store.overview();
  assert.equal('more_requests' in empty, false);
  assert.equal('inbox_suggestions' in empty, false);
  assert.equal('plan' in empty.week, false);
});

test('links must be web or mail links', () => {
  const { store } = makeStore();
  assert.throws(() => store.addTask({ ...task, link: 'javascript:alert(1)' }), /link must start/);
  const t = store.addTask({ ...task, link: 'mailto:sam@example.com' });
  assert.throws(() => store.attachResult(t.id, 'x', 'data:text/html,hi'), /url must start/);
});
