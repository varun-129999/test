// Recurring tasks, in the server's canonical vocabulary (contract section 3): `daily`, `weekdays`,
// `weekly:Mon,Thu` (one or more days), `every:<N>:days|weeks|months`, `monthly:<1-31>`.
import { DOW, dt } from './format';

export type RepeatFrom = 'planned' | 'done';
export type RepeatUnit = 'days' | 'weeks' | 'months';
/** The parts of a canonical rule, for the edit form. */
export type RepeatRule =
  | { kind: 'daily' } | { kind: 'weekdays' }
  | { kind: 'weekly'; days: number[] }
  | { kind: 'every'; n: number; unit: RepeatUnit }
  | { kind: 'monthly'; date: number };

/** Monday first, the order weekly rules are written in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
export const dayIndex = (w: string): number | undefined => DAY_NAMES[w.toLowerCase()];
const sortDays = (ds: number[]) => WEEK_ORDER.filter(d => ds.includes(d));
export const weeklyRule = (days: number[]) => 'weekly:' + sortDays(days).map(d => DOW[d]).join(',');

export function parseRule(canonical: string | null | undefined): RepeatRule | null {
  const c = (canonical ?? '').trim();
  if (c === 'daily') return { kind: 'daily' };
  if (c === 'weekdays') return { kind: 'weekdays' };
  let m = /^weekly:([A-Z][a-z]{2}(?:,[A-Z][a-z]{2})*)$/.exec(c);
  if (m) {
    const days = m[1].split(',').map(dayIndex);
    return days.every(d => d !== undefined) ? { kind: 'weekly', days: sortDays(days as number[]) } : null;
  }
  if ((m = /^every:(\d{1,3}):(days|weeks|months)$/.exec(c)) && +m[1] >= 1) return { kind: 'every', n: +m[1], unit: m[2] as RepeatUnit };
  if ((m = /^monthly:(\d{1,2})$/.exec(c)) && +m[1] >= 1 && +m[1] <= 31) return { kind: 'monthly', date: +m[1] };
  return null;
}

export function formatRule(r: RepeatRule): string {
  switch (r.kind) {
    case 'weekly': return weeklyRule(r.days);
    case 'every': return `every:${r.n}:${r.unit}`;
    case 'monthly': return 'monthly:' + r.date;
    default: return r.kind;
  }
}

const ordinal = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const one: Record<RepeatUnit, string> = { days: 'day', weeks: 'week', months: 'month' };

/**
 * "Repeats every Mon, Thu", for the edit form and the preview; the same text as the server's. Empty for no rule or one this
 * app does not know (a newer server), so nothing wrong is shown.
 */
export function describeRepeat(canonical: string | null | undefined, from?: RepeatFrom | null): string {
  const r = parseRule(canonical);
  if (!r) return '';
  const tail = from === 'done' ? ', counted from when it is done' : '';
  switch (r.kind) {
    case 'daily': return 'Repeats daily' + tail;
    case 'weekdays': return 'Repeats on weekdays' + tail;
    case 'weekly': return 'Repeats every ' + r.days.map(d => DOW[d]).join(', ') + tail;
    case 'every': return 'Repeats every ' + (r.n === 1 ? one[r.unit] : `${r.n} ${r.unit}`) + tail;
    case 'monthly': return `Repeats monthly on the ${ordinal(r.date)}` + tail;
  }
}

/** The tag on a block: "Daily", "Weekly", "Mon, Thu", "Every 2 weeks", "Monthly". */
export function shortRepeat(canonical: string | null | undefined): string {
  const r = parseRule(canonical);
  if (!r) return '';
  switch (r.kind) {
    case 'daily': return 'Daily';
    case 'weekdays': return 'Weekdays';
    case 'weekly': return r.days.length === 1 ? 'Weekly' : r.days.map(d => DOW[d]).join(', ');
    case 'every': return r.n === 1 ? { days: 'Daily', weeks: 'Weekly', months: 'Monthly' }[r.unit] : `Every ${r.n} ${r.unit}`;
    case 'monthly': return 'Monthly';
  }
}

/** A sensible rule of each kind for a task planned on `day`, when the owner picks it in the form. */
export function defaultRule(kind: RepeatRule['kind'], day: string): RepeatRule {
  const d = dt(day);
  switch (kind) {
    case 'weekly': return { kind, days: [d.getDay()] };
    case 'every': return { kind, n: 2, unit: 'weeks' };
    case 'monthly': return { kind, date: d.getDate() };
    default: return { kind };
  }
}
