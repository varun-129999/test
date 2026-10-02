import { createContext, useContext } from 'react';
import { addDays, dayTimeIn } from './format';
import type { AskSpec } from './prompts';
import type { Area, PendingRequest, Priority, State, Task, TaskInput, TaskPatch } from './types';
import type { UndoCall } from './undo';

export const AREA: Record<Area, { c: string; on: string }> = {
  Work: { c: 'var(--work)', on: 'var(--on-work)' },
  Personal: { c: 'var(--pers)', on: 'var(--on-pers)' },
  Health: { c: 'var(--health)', on: 'var(--on-health)' },
};
export const AREAS: Area[] = ['Work', 'Personal', 'Health'];
export const RANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };
/** A day's order: tasks with a time first, by time, then by priority (as the server's overview sorts). */
export const byPlan = (a: Pick<Task, 'at' | 'priority'>, b: Pick<Task, 'at' | 'priority'>) =>
  (a.at ? 0 : 1) - (b.at ? 0 : 1) || (a.at && b.at ? a.at.localeCompare(b.at) : 0) || RANK[a.priority] - RANK[b.priority];

export type Screen = 'today' | 'week' | 'inbox' | 'usage';
export const SCREENS: Screen[] = ['today', 'week', 'inbox', 'usage'];
export interface Route { screen: Screen; week?: string }

/** "#week/2026-10-05" → { screen: 'week', week: '2026-10-05' }. Anything unknown is Today. */
export function parseRoute(hash: string): Route {
  const [h, arg] = hash.replace(/^#/, '').split('/');
  const screen = (SCREENS as string[]).includes(h) ? (h as Screen) : 'today';
  return screen === 'week' && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? { screen, week: arg } : { screen };
}

/**
 * A toast action: a plain button, the "Open Claude" link for the current queue, or "Continue in …"
 * for a queued request whose task came from a chat or session with a link.
 */
export type ToastAction = { label: string; run: () => void } | 'open-claude' | { continue: string };
/** `ms`: how long the toast stays (default 5 s, 8 s with an action, 10 s for errors). */
export interface NotifyOpts { kind?: 'info' | 'error'; action?: ToastAction; ms?: number }

export interface Ctx {
  s: State;
  wide: boolean;
  route: Route;
  /** Ticks every minute so "2h ago" and countdowns stay current. */
  now: number;
  go: (s: Screen, arg?: string) => void;
  /** Runs a REST call, shows any error, then refreshes state. Resolves true on success. */
  act: (method: string, path: string, body?: unknown) => Promise<boolean>;
  /** Like act, but resolves with the response (undefined on error). */
  call: <T>(method: string, path: string, body?: unknown) => Promise<T | undefined>;
  /** Queues a request for Claude (or holds it at the reserve). */
  ask: (q: AskSpec) => Promise<void>;
  /** Updates a task, showing the change at once and reconciling with the server's answer. */
  patchTask: (t: Task, p: TaskPatch) => Promise<boolean>;
  addTask: (t: TaskInput, o?: { quiet?: boolean }) => Promise<Task | undefined>;
  /** Changes the local copy at once (before the server answers). */
  optimistic: (fn: (s: State) => State) => void;
  openSheet: (o?: { recent?: boolean }) => void;
  /** The phone's hero mic: opens the sheet, focuses the composer and starts listening, all in the tap. */
  mic: () => void;
  notify: (msg: string, o?: NotifyOpts) => void;
  /** A toast with Undo for UNDO_MS; Undo runs the calls once (shown at once, then refreshed). */
  undo: (msg: string, calls: UndoCall[]) => void;
  /** Client-side search, shared by Today and Week. */
  q: string;
  setQ: (q: string) => void;
  signOut: () => void;
}

export const DocketCtx = createContext<Ctx | null>(null);
export const useDocket = () => useContext(DocketCtx)!;

const sum = (ts: Task[]) => ts.reduce((a, x) => a + x.est, 0);

/** Derived numbers shared by several screens. */
export function derive(s: State) {
  const t = s.today;
  const capMin = s.settings.capacity_hours * 60;
  const todays = s.tasks.filter(x => x.day === t);
  const open = todays.filter(x => !x.done).sort(byPlan);
  const openMin = sum(open);
  // Open tasks from earlier days. They stay out of today's capacity until the owner moves them.
  const overdue = s.tasks.filter(x => !x.done && x.day < t).sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.day.localeCompare(b.day));
  // The headline is what the owner reported; the estimate (reported plus Docket calls since) is shown beside it.
  const used = s.usage.used_pct, left = 100 - used;
  const est = s.usage.est_pct, estLeft = 100 - est;
  return { t, capMin, todays, open, openMin, overMin: Math.max(0, openMin - capMin), overdue, used, left, est, estLeft };
}

/**
 * One day's load. Over capacity counts open tasks only, and only for today and later:
 * a day mostly done is not "over", and nothing can be done about past days.
 */
export function dayLoad(s: State, day: string) {
  const its = s.tasks.filter(x => x.day === day);
  const planned = sum(its), open = sum(its.filter(x => !x.done));
  const over = day >= s.today ? Math.max(0, open - s.settings.capacity_hours * 60) : 0;
  return { its, planned, open, done: planned - open, over };
}

/** The done tasks the state holds: open ones plus everything done in the last 60 days. */
export const DONE_DAYS = 60;
export interface DoneItem { x: Task; day: string; time: string }

/**
 * "Done this week": tasks completed in the week starting `ws`, by the day they were completed
 * (in the server's time zone; the planned day when there is no completion time), newest first.
 * `older`: the week starts before the 60 days the state holds, so the list may be incomplete.
 */
export function doneWeek(s: Pick<State, 'tasks' | 'today' | 'tz'>, ws: string) {
  const we = addDays(ws, 6);
  const items: DoneItem[] = [];
  for (const x of s.tasks) {
    if (!x.done) continue;
    const at = x.completed_at ? dayTimeIn(s.tz, x.completed_at) : null;
    const day = at?.day ?? x.day;
    if (day >= ws && day <= we) items.push({ x, day, time: at?.time ?? '' });
  }
  items.sort((a, b) => b.day.localeCompare(a.day) || b.time.localeCompare(a.time) || a.x.title.localeCompare(b.x.title));
  const groups: { day: string; items: DoneItem[] }[] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g?.day === it.day) g.items.push(it); else groups.push({ day: it.day, items: [it] });
  }
  const areas = AREAS.map(area => ({ area, min: sum(items.filter(i => i.x.area === area).map(i => i.x)) })).filter(a => a.min > 0);
  return { groups, n: items.length, min: sum(items.map(i => i.x)), areas, older: ws < addDays(s.today, -DONE_DAYS) };
}

/** Tasks whose title, project or notes contain every word of the query. */
export function search(tasks: Task[], q: string): Task[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return tasks
    .filter(x => { const hay = [x.title, x.project, x.notes].filter(Boolean).join(' ').toLowerCase(); return words.every(w => hay.includes(w)); })
    .sort((a, b) => Number(a.done) - Number(b.done) || a.day.localeCompare(b.day) || byPlan(a, b));
}

/**
 * The requests Claude finished (any outcome). `recent` also holds rows the owner removed and
 * rows the pickup rule held (status cancelled); those are not Claude's work.
 */
export const finished = (rs: PendingRequest[]) => rs.filter(r => r.status === 'done');

/** Only http(s) links become hrefs, so stored text can never become a javascript: link. */
export const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

export const isStandalone = () => {
  try { return (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches; } catch { return false; }
};

const AREA_KEY = 'docket-area';
export const lastArea = (): Area => {
  try { const a = localStorage.getItem(AREA_KEY) as Area | null; return a && AREAS.includes(a) ? a : 'Work'; } catch { return 'Work'; }
};
export const rememberArea = (a: Area) => { try { localStorage.setItem(AREA_KEY, a); } catch { /* private mode */ } };
