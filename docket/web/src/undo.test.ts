import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from './api';
import { applyUndo, once, runUndo, undoDay, undoDelete, undoDone, undoMoves, type UndoCall } from './undo';

test('undo calls: day back, reopen, restore, moves back to from_day', () => {
  assert.deepEqual(undoDay([{ id: 'a', day: '2026-09-29' }, { id: 'b', day: '2026-09-30' }]), [
    { method: 'PATCH', path: '/tasks/a', body: { day: '2026-09-29' } },
    { method: 'PATCH', path: '/tasks/b', body: { day: '2026-09-30' } },
  ]);
  assert.deepEqual(undoDone('a'), [{ method: 'PATCH', path: '/tasks/a', body: { done: false } }]);
  assert.deepEqual(undoDelete('a'), [{ method: 'POST', path: '/tasks/a/restore' }]);
  assert.deepEqual(undoMoves([{ task_id: 't1', from_day: '2026-10-01' }]), [{ method: 'PATCH', path: '/tasks/t1', body: { day: '2026-10-01' } }]);
});

test('applyUndo: shows PATCH undos on the local copy, leaves the rest', () => {
  const s = normalizeState({ today: '2026-10-01', tasks: [
    { id: 'a', title: 'A', day: '2026-10-01', done: true, est: 30 },
    { id: 'b', title: 'B', day: '2026-10-02', est: 30 },
    { id: 'c', title: 'C', day: '2026-10-01', est: 30 },
  ] });
  const out = applyUndo(s, [...undoDone('a'), ...undoDay([{ id: 'b', day: '2026-09-28' }]), ...undoDelete('zz')]);
  assert.equal(out.tasks.find(t => t.id === 'a')!.done, false);
  assert.equal(out.tasks.find(t => t.id === 'b')!.day, '2026-09-28');
  assert.equal(out.tasks.find(t => t.id === 'c'), s.tasks.find(t => t.id === 'c'));
  assert.equal(applyUndo(s, undoDelete('a')), s);
});

test('runUndo: runs every call even when one fails, and reports the first error', async () => {
  const seen: string[] = [];
  const calls: UndoCall[] = [...undoDay([{ id: 'a', day: 'd1' }, { id: 'b', day: 'd2' }, { id: 'c', day: 'd3' }])];
  const r = await runUndo(calls, async c => { seen.push(c.path); if (c.path === '/tasks/b') throw new Error('Task not found'); });
  assert.deepEqual(seen, ['/tasks/a', '/tasks/b', '/tasks/c']);
  assert.equal(r.failed, 1);
  assert.equal((r.error as Error).message, 'Task not found');
  assert.deepEqual(await runUndo(undoDone('a'), async () => ({})), { failed: 0, error: undefined });
});

test('once: Undo clicked twice runs once', async () => {
  let n = 0;
  const run = once(async () => { n++; });
  run(); run(); run();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(n, 1);
});

test('normalizeState: deleted defaults to [] and trash says whether the server sends it', () => {
  const old = normalizeState({ today: '2026-10-01', tasks: [] });
  assert.deepEqual(old.deleted, []);
  assert.equal(old.flags.trash, false);
  const neu = normalizeState({ today: '2026-10-01', tasks: [], deleted: [{ id: 'd', title: 'Gone', day: '2026-09-30', area: 'Health', deleted_at: '2026-10-01T04:00:00.000Z' }] });
  assert.equal(neu.flags.trash, true);
  assert.deepEqual(neu.deleted, [{ id: 'd', title: 'Gone', day: '2026-09-30', area: 'Health', deleted_at: '2026-10-01T04:00:00.000Z' }]);
  // A cached state (already normalized) keeps what it knew about the server.
  assert.equal(normalizeState(JSON.parse(JSON.stringify(old))).flags.trash, false);
  assert.equal(normalizeState(JSON.parse(JSON.stringify(neu))).flags.trash, true);
});
