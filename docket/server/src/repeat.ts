// Recurring tasks. Rules are stored in one canonical form: `daily`, `weekdays`,
// `weekly:Mon,Thu` (one or more days, Monday first), `every:<N>:days|weeks|months`, `monthly:<1-31>`.
import { DOW, addDays, dt, iso } from './dates.js';

export type RepeatFrom = 'planned' | 'done';
export const REPEAT_FROM = ['planned', 'done'] as const;

/** For error messages: what parseRepeat understands. */
export const REPEAT_FORMS = 'daily, weekdays, weekly, weekly:Mon,Thu (or "every mon, thu"), every:2:weeks (or "every 2 weeks", days or months too), monthly, monthly:25 (or "monthly 25", "every month on the 25th")';

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
/** Monday first, the order weekly rules are written in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const dayIndex = (w: string): number | undefined => DAY_NAMES[w.toLowerCase()];
export const weeklyRule = (days: number[]) => 'weekly:' + WEEK_ORDER.filter(d => days.includes(d)).map(d => DOW[d]).join(',');
const dom = (s: string | undefined) => { const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(s ?? ''); return m && +m[1] >= 1 && +m[1] <= 31 ? +m[1] : NaN; };

/** "weekly" and "monthly" without a day take it from the task's day (or today). */
export function parseRepeat(human: string, day = iso(new Date())): string | null {
  const s = human.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^repeats? /, '');
  const base = dt(day);
  if (s === 'daily' || s === 'every day') return 'daily';
  if (s === 'weekdays' || s === 'every weekday' || s === 'on weekdays') return 'weekdays';
  if (s === 'weekly' || s === 'every week') return weeklyRule([base.getDay()]);
  if (s === 'monthly' || s === 'every month') return 'monthly:' + base.getDate();
  let m = /^(?:monthly[: ]|every month on (?:the )?)(\S+)$/.exec(s);
  if (m) return dom(m[1]) ? 'monthly:' + dom(m[1]) : null;
  if ((m = /^every[: ](\d{1,3})[: ](day|week|month)s?$/.exec(s))) return +m[1] >= 1 ? `every:${+m[1]}:${m[2]}s` : null;
  if ((m = /^(?:weekly:|weekly on |every )(.+)$/.exec(s))) {
    const days = m[1].split(/\s*(?:,|&|\/|\band\b)\s*|\s+/).filter(Boolean).map(dayIndex);
    return days.length && days.every(d => d !== undefined) ? weeklyRule(days as number[]) : null;
  }
  return null;
}

type Rule = { kind: 'daily' } | { kind: 'weekdays' } | { kind: 'weekly'; days: number[] } | { kind: 'every'; n: number; unit: 'days' | 'weeks' | 'months' } | { kind: 'monthly'; date: number };

function rule(canonical: string): Rule | null {
  if (canonical === 'daily' || canonical === 'weekdays') return { kind: canonical };
  let m = /^weekly:([A-Z][a-z]{2}(?:,[A-Z][a-z]{2})*)$/.exec(canonical);
  if (m) { const days = m[1].split(',').map(dayIndex); return days.every(d => d !== undefined) ? { kind: 'weekly', days: days as number[] } : null; }
  if ((m = /^every:(\d{1,3}):(days|weeks|months)$/.exec(canonical)) && +m[1] >= 1) return { kind: 'every', n: +m[1], unit: m[2] as 'days' };
  if ((m = /^monthly:(\d{1,2})$/.exec(canonical)) && +m[1] >= 1 && +m[1] <= 31) return { kind: 'monthly', date: +m[1] };
  return null;
}

export const isRepeat = (s: string) => rule(s) !== null;

const ordinal = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const ONE = { days: 'day', weeks: 'week', months: 'month' } as const;

/** "Repeats every Mon, Thu". Empty for an unknown rule. */
export function describeRepeat(canonical: string | null | undefined, from?: RepeatFrom | null): string {
  const r = rule(canonical ?? '');
  if (!r) return '';
  const tail = from === 'done' ? ', counted from when it is done' : '';
  const text = r.kind === 'daily' ? 'Repeats daily'
    : r.kind === 'weekdays' ? 'Repeats on weekdays'
    : r.kind === 'weekly' ? 'Repeats every ' + WEEK_ORDER.filter(d => r.days.includes(d)).map(d => DOW[d]).join(', ')
    : r.kind === 'every' ? 'Repeats every ' + (r.n === 1 ? ONE[r.unit] : `${r.n} ${r.unit}`)
    : `Repeats monthly on the ${ordinal(r.date)}`;
  return text + tail;
}

const daysIn = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();
/** The `date` of the month `months` after `from`'s month, clamped to that month's last day. */
function monthDay(from: string, months: number, date: number): string {
  const d = dt(from), y = d.getFullYear(), m0 = d.getMonth() + months;
  const t = new Date(y, m0, 1, 12);
  t.setDate(Math.min(date, daysIn(t.getFullYear(), t.getMonth())));
  return iso(t);
}

/** The first occurrence strictly after `base`. */
function step(r: Rule, base: string): string {
  switch (r.kind) {
    case 'daily': return addDays(base, 1);
    case 'every':
      if (r.unit === 'months') return monthDay(base, r.n, dt(base).getDate());
      return addDays(base, r.unit === 'weeks' ? 7 * r.n : r.n);
    case 'monthly': {
      const here = monthDay(base, 0, r.date);
      return here > base ? here : monthDay(base, 1, r.date);
    }
    default: {
      const ok = r.kind === 'weekdays' ? [1, 2, 3, 4, 5] : r.days;
      let d = addDays(base, 1);
      while (!ok.includes(dt(d).getDay())) d = addDays(d, 1);
      return d;
    }
  }
}

/**
 * The day of the next instance. From 'planned' it follows the rule from the task's day, but never
 * lands before today (a late completion does not leave a trail of overdue copies); from 'done' it
 * counts from today. Monthly rules clamp to the month's last day.
 */
export function nextOccurrence(canonical: string, from: string, repeatFrom: RepeatFrom | null | undefined, today: string): string {
  const r = rule(canonical);
  if (!r) throw new Error(`Unknown repeat rule "${canonical}"`);
  let next = step(r, repeatFrom === 'done' ? today : from);
  while (next < today) next = step(r, next);
  return next;
}
