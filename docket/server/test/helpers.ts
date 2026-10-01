process.env.TZ = 'Europe/London';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

/** A store on an in-memory database with a movable clock (default Thu 1 Oct 2026, 10:00). */
export function makeStore(start = '2026-10-01T10:00:00') {
  let now = new Date(start);
  const store = new Store(openDb(':memory:'), { now: () => now });
  return { store, setNow: (s: string) => { now = new Date(s); } };
}

export const task = { title: 'Task', area: 'Work', est: 30, priority: 'med', energy: 'low' } as const;
