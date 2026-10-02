import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLoad, derive, doneWeek, parseRoute, search } from './ctx';
import { normalizeState } from './api';

const T = '2026-10-01';
const task = (o: Record<string, unknown>) => ({ area: 'Work', project: null, due: null, est: 30, priority: 'med', energy: 'low', done: false, steps: [], ...o });
const state = (tasks: Record<string, unknown>[], extra: Record<string, unknown> = {}) => normalizeState({
  today: T,
  tasks: tasks.map(task),
  usage: { used_pct: 40, est_pct: 52, reserve_pct: 10, high_only: true, at_reserve: false, near_reserve: false, resets_at: '2026-10-05T03:30:00.000Z', period_start: '2026-09-28T03:30:00.000Z' },
  settings: { capacity_hours: 6, reserve_pct: 10, high_only: true, claude_url: 'https://claude.ai/new' },
  ...extra,
});

test('derive: carried-over tasks are listed but kept out of today', () => {
  const s = state([
    { id: 'a', day: T, est: 120, priority: 'low' },
    { id: 'b', day: T, est: 60, priority: 'high' },
    { id: 'c', day: T, est: 300, done: true },
    { id: 'old1', day: '2026-09-29', est: 45, priority: 'low' },
    { id: 'old2', day: '2026-09-30', est: 400, priority: 'high' },
    { id: 'oldDone', day: '2026-09-30', done: true },
    { id: 'later', day: '2026-10-09' },
  ]);
  const d = derive(s);
  assert.deepEqual(d.open.map(x => x.id), ['b', 'a']);
  assert.equal(d.openMin, 180);
  assert.equal(d.overMin, 0);
  assert.deepEqual(d.overdue.map(x => x.id), ['old2', 'old1']); // high priority first
  assert.deepEqual(d.todays.map(x => x.id).sort(), ['a', 'b', 'c']);
});

test('derive: capacity counts today\'s open tasks only', () => {
  const s = state([
    { id: 'a', day: T, est: 300 },
    { id: 'b', day: T, est: 120 },
    { id: 'done', day: T, est: 600, done: true },
    { id: 'old', day: '2026-09-30', est: 600 },
  ]);
  const d = derive(s);
  assert.equal(d.capMin, 360);
  assert.equal(d.openMin, 420);
  assert.equal(d.overMin, 60);
});

test('derive: the headline is the reported figure; the estimate is separate', () => {
  const d = derive(state([]));
  assert.equal(d.left, 60);
  assert.equal(d.estLeft, 48);
});

test('dayLoad: over from open tasks, never for past days', () => {
  const s = state([
    { id: 'a', day: T, est: 300, done: true },
    { id: 'b', day: T, est: 120 },
    { id: 'p', day: '2026-09-30', est: 500 },
    { id: 'f1', day: '2026-10-02', est: 400 },
  ]);
  assert.deepEqual({ ...dayLoad(s, T), its: undefined }, { its: undefined, planned: 420, open: 120, done: 300, over: 0 });
  assert.equal(dayLoad(s, '2026-09-30').over, 0);
  assert.equal(dayLoad(s, '2026-10-02').over, 40);
});

test('search: every word, in titles, projects and notes; open first', () => {
  const s = state([
    { id: 'a', day: T, title: 'Pay Acme invoice' },
    { id: 'b', day: '2026-09-20', title: 'Acme call', done: true },
    { id: 'c', day: T, title: 'Deck', project: 'Q4 planning' },
    { id: 'd', day: T, title: 'Flights', notes: 'Lisbon under 40k' },
  ]);
  assert.deepEqual(search(s.tasks, 'acme').map(x => x.id), ['a', 'b']);
  assert.deepEqual(search(s.tasks, 'q4').map(x => x.id), ['c']);
  assert.deepEqual(search(s.tasks, 'lisbon 40k').map(x => x.id), ['d']);
  assert.deepEqual(search(s.tasks, '  '), []);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute('#week/2026-10-05'), { screen: 'week', week: '2026-10-05' });
  assert.deepEqual(parseRoute('#week'), { screen: 'week' });
  assert.deepEqual(parseRoute('#usage'), { screen: 'usage' });
  assert.deepEqual(parseRoute(''), { screen: 'today' });
  assert.deepEqual(parseRoute('#nonsense'), { screen: 'today' });
});

test('doneWeek: by completion day in the server zone, newest first, with times and area totals', () => {
  const s = state([
    // 18:40 UTC on 30 Sep is 00:10 on 1 Oct in Kolkata.
    { id: 'late', title: 'Late', day: '2026-09-30', done: true, est: 60, completed_at: '2026-09-30T18:40:00.000Z' },
    { id: 'a', title: 'A', day: T, done: true, est: 90, area: 'Work', completed_at: '2026-10-01T09:02:00.000Z' },
    { id: 'b', title: 'B', day: '2026-09-29', done: true, est: 40, area: 'Health', completed_at: '2026-09-29T03:00:00.000Z' },
    { id: 'nostamp', title: 'Old row', day: '2026-09-28', done: true, est: 20, area: 'Personal', completed_at: null },
    { id: 'lastweek', title: 'L', day: '2026-09-27', done: true, completed_at: '2026-09-27T05:00:00.000Z' },
    // Planned next week, done early this week: counts here, on the day it was done.
    { id: 'early', title: 'Early', day: '2026-10-06', done: true, est: 30, area: 'Personal', completed_at: '2026-09-30T05:00:00.000Z' },
    { id: 'open', title: 'Open', day: T },
  ], { tz: 'Asia/Kolkata' });
  const dw = doneWeek(s, '2026-09-28');
  assert.deepEqual(dw.groups.map(g => [g.day, g.items.map(i => i.x.id + ' ' + i.time)]), [
    ['2026-10-01', ['a 14:32', 'late 00:10']],
    ['2026-09-30', ['early 10:30']],
    ['2026-09-29', ['b 08:30']],
    ['2026-09-28', ['nostamp ']],
  ]);
  assert.equal(dw.n, 5);
  assert.equal(dw.min, 240);
  assert.deepEqual(dw.areas, [{ area: 'Work', min: 150 }, { area: 'Personal', min: 50 }, { area: 'Health', min: 40 }]);
  assert.equal(dw.older, false);
  assert.deepEqual(doneWeek(s, '2026-09-21').groups.map(g => g.day), ['2026-09-27']);
});

test('doneWeek: weeks before the 60 days the state holds are flagged', () => {
  const s = state([]);
  assert.equal(doneWeek(s, '2026-08-03').older, false);
  assert.equal(doneWeek(s, '2026-07-27').older, true);
  assert.deepEqual(doneWeek(s, '2026-07-27'), { groups: [], n: 0, min: 0, areas: [], older: true });
});
