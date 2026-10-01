import { createContext, useContext } from 'react';
import type { Area, Priority, State, Task } from './types';

export const AREA: Record<Area, { c: string; on: string }> = {
  Work: { c: 'var(--work)', on: 'var(--on-work)' },
  Personal: { c: 'var(--pers)', on: 'var(--on-pers)' },
  Health: { c: 'var(--health)', on: 'var(--on-health)' },
};
export const AREAS: Area[] = ['Work', 'Personal', 'Health'];
export const RANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };

export type Screen = 'today' | 'week' | 'inbox' | 'usage';

export interface AskOpts { label: string; priority?: Priority; taskId?: string }

export interface Ctx {
  s: State;
  wide: boolean;
  screen: Screen;
  go: (s: Screen) => void;
  /** Runs a REST call, then refreshes state. */
  act: (method: string, path: string, body?: unknown) => Promise<void>;
  /** Queues a request for Claude (or holds it at the reserve). */
  ask: (prompt: string, o: AskOpts) => Promise<void>;
  patchTask: (t: Task, p: Partial<Task>) => Promise<void>;
  openSheet: () => void;
  flash: (msg: string) => void;
}

export const DocketCtx = createContext<Ctx | null>(null);
export const useDocket = () => useContext(DocketCtx)!;

/** Derived numbers shared by several screens. */
export function derive(s: State) {
  const t = s.today;
  const capMin = s.settings.capacity_hours * 60;
  const todays = s.tasks.filter(x => x.day === t);
  const open = todays.filter(x => !x.done).sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const openMin = open.reduce((a, x) => a + x.est, 0);
  const used = s.usage.estimated_used_pct;
  const left = 100 - used;
  return { t, capMin, todays, open, openMin, overMin: Math.max(0, openMin - capMin), used, left };
}
