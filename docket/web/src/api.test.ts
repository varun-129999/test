import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesce, normalizeState, tokenFromUrl } from './api';

test('tokenFromUrl: fragment and query, stripped from the URL', () => {
  assert.deepEqual(tokenFromUrl('', '#token=abc'), { token: 'abc', search: '', hash: '' });
  assert.deepEqual(tokenFromUrl('?token=abc', ''), { token: 'abc', search: '', hash: '' });
  assert.deepEqual(tokenFromUrl('?x=1&token=t', '#week'), { token: 't', search: '?x=1', hash: '#week' });
  assert.deepEqual(tokenFromUrl('', '#week/2026-10-05'), { token: null, search: '', hash: '#week/2026-10-05' });
  assert.deepEqual(tokenFromUrl('?token=fromquery', '#token=fromhash'), { token: 'fromhash', search: '', hash: '' });
});

test('tokenFromUrl: percent-encoding decoded; a raw + stays a +', () => {
  assert.equal(tokenFromUrl('?token=ab%2Bc%2Fd%3D', '').token, 'ab+c/d=');
  assert.equal(tokenFromUrl('?token=ab+c', '').token, 'ab+c');
  assert.equal(tokenFromUrl('', '#token=ab%2F%3D%3D').token, 'ab/==');
  assert.equal(tokenFromUrl('', '#token=bad%E0').token, 'bad%E0');
  assert.equal(tokenFromUrl('?token=', '').token, null);
});

test('normalizeState fills what a 0.2.0 server leaves out', () => {
  const s = normalizeState({
    today: '2026-10-01',
    tasks: [{ id: 't', title: 'x', area: 'Work', day: '2026-10-01', est: 30, priority: 'med', energy: 'low', done: false, steps: [{ text: 'a', done: 0 }] }],
    requests: [{ id: 'r', label: 'l', prompt: 'p', task_id: null, created_at: '2026-10-01T00:00:00Z' }],
    usage: { period_start: '2026-09-28T03:30:00.000Z', resets_at: '2026-10-05T03:30:00.000Z', used_pct: 80, estimated_used_pct: 86, reserve_pct: 15, high_only: true, at_reserve: false },
    settings: { capacity_hours: 6, reserve_pct: 15, high_only: true, claude_url: 'https://claude.ai/new' },
    flags: { sample: true },
  });
  assert.deepEqual(s.recent, []);
  assert.equal(s.week_plan, null);
  assert.equal(s.reset_notice, null);
  assert.equal(s.tasks[0].notes, null);
  assert.equal(s.tasks[0].result, null);
  assert.equal(s.tasks[0].steps[0].done, false);
  assert.equal(s.requests[0].outcome, null);
  assert.equal(s.requests[0].seen, true);
  assert.equal(s.usage.est_pct, 86);
  assert.equal(s.usage.estimated, true);
  assert.equal(s.usage.near_reserve, true); // 100 - 86 <= 15, and not at the reserve by the reported 80
  assert.match(s.usage.resets_label, /^Mon 5 Oct \d\d:\d\d$/);
  assert.equal(s.usage.source, null);
  assert.equal(s.flags.sample, true);
  assert.equal(s.version, '');
  assert.ok(s.tz);
});

test('normalizeState survives an empty or odd payload', () => {
  const s = normalizeState(null);
  assert.deepEqual(s.tasks, []);
  assert.equal(s.settings.capacity_hours, 6);
  assert.equal(s.usage.used_pct, 0);
  assert.equal(normalizeState({ tasks: 'nope', recent: {} }).tasks.length, 0);
});

test('normalizeState keeps 0.3.0 fields as sent', () => {
  const s = normalizeState({
    usage: { used_pct: 40, est_pct: 40, estimated: false, resets_label: 'Tue 6 Oct 14:00', near_reserve: false, source: 'statusline' },
    recent: [{ id: 'r', label: 'l', prompt: 'p', outcome: 'needs_owner', detail: 'which day?', seen: false }],
    week_plan: { week_start: '2026-09-28', text: 'ship it', updated_at: '2026-09-28T04:00:00Z' },
    reset_notice: { n: 2, at: '2026-09-28T04:00:00Z' }, version: '0.3.0', tz: 'Asia/Kolkata',
  });
  assert.equal(s.usage.resets_label, 'Tue 6 Oct 14:00');
  assert.equal(s.usage.source, 'statusline');
  assert.equal(s.recent[0].seen, false);
  assert.equal(s.recent[0].outcome, 'needs_owner');
  assert.equal(s.week_plan?.text, 'ship it');
  assert.equal(s.reset_notice?.n, 2);
  assert.equal(s.tz, 'Asia/Kolkata');
});

test('coalesce: one run at a time, one more for calls that arrive meanwhile, latest wins', async () => {
  let runs = 0;
  const f = coalesce(async () => { runs++; await new Promise(r => setTimeout(r, 10)); return runs; });
  const all = await Promise.all([f(), f(), f(), f()]);
  assert.equal(runs, 2);
  assert.deepEqual(all, [2, 2, 2, 2]);
  assert.equal(await f(), 3);
});

test('coalesce: an error in an earlier run is dropped when a later run succeeds', async () => {
  let n = 0;
  const f = coalesce(async () => { n++; await new Promise(r => setTimeout(r, 5)); if (n === 1) throw new Error('first'); return n; });
  const [a, b] = await Promise.all([f(), f()]);
  assert.equal(a, 2);
  assert.equal(b, 2);
  await assert.rejects(coalesce(async () => { throw new Error('only'); }), /only/);
});
