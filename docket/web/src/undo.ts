// Undo for the quick actions (tick done, delete, moves, day changes). An undo is the list of
// REST calls that put things back, offered on a toast for UNDO_MS. Pure, so it can be tested.
import type { Move, State, Task } from './types';

export const UNDO_MS = 6000;

export interface UndoCall { method: 'PATCH' | 'POST'; path: string; body?: Record<string, unknown> }

/** Put each task back on the day it had before (pass the tasks as they were). */
export const undoDay = (before: Pick<Task, 'id' | 'day'>[]): UndoCall[] =>
  before.map(t => ({ method: 'PATCH', path: '/tasks/' + t.id, body: { day: t.day } }));
/** Reopen a task that was just ticked. For a recurring task the next instance stays. */
export const undoDone = (id: string): UndoCall[] => [{ method: 'PATCH', path: '/tasks/' + id, body: { done: false } }];
/** Bring back a soft-deleted task. */
export const undoDelete = (id: string): UndoCall[] => [{ method: 'POST', path: `/tasks/${id}/restore` }];
/** Approved moves go back to the day they came from. */
export const undoMoves = (moves: Pick<Move, 'task_id' | 'from_day'>[]): UndoCall[] =>
  moves.map(m => ({ method: 'PATCH', path: '/tasks/' + m.task_id, body: { day: m.from_day } }));

/** Shows an undo at once: applies the PATCH bodies to the local copy before the server answers. */
export function applyUndo(s: State, calls: UndoCall[]): State {
  const by = new Map<string, Record<string, unknown>>();
  for (const c of calls) {
    const m = c.method === 'PATCH' && /^\/tasks\/([^/]+)$/.exec(c.path);
    if (m && c.body) by.set(m[1], { ...by.get(m[1]), ...c.body });
  }
  if (!by.size) return s;
  return { ...s, tasks: s.tasks.map(t => (by.has(t.id) ? ({ ...t, ...by.get(t.id) } as Task) : t)) };
}

/** Runs every call (one failing doesn't stop the rest) and reports how many failed and the first error. */
export async function runUndo(calls: UndoCall[], exec: (c: UndoCall) => Promise<unknown>): Promise<{ failed: number; error?: unknown }> {
  const res = await Promise.allSettled(calls.map(exec));
  const bad = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  return { failed: bad.length, error: bad[0]?.reason };
}

/** An action that runs at most once (a double click on Undo must not restore twice). */
export function once(fn: () => void | Promise<void>): () => void {
  let done = false;
  return () => { if (done) return; done = true; void fn(); };
}
