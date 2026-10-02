// Quick add without Claude ("Call Sam fri at 5pm 45m #Wedding p1 weekly"). A copy of the server's
// parser (server/src/quick.ts, contract section 2b); both replay shared/quick-cases.json in their
// tests so they stay identical. Change both together.
import { addDays, dt, fmtDay, fmtDur, isDay, weekStart } from './format';
import { WEEK_ORDER, dayIndex, describeRepeat, weeklyRule, type RepeatFrom } from './repeat';
import type { Area, Energy, Priority, TaskInput } from './types';

export interface QuickParse {
  title: string; area?: Area; project?: string; day?: string; due?: string; at?: string; est?: number;
  priority?: Priority; energy?: Energy; repeat?: string; repeat_from?: RepeatFrom; link?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const AREAS: Record<string, Area> = { work: 'Work', personal: 'Personal', health: 'Health' };
const PRIORITY: Record<string, Priority> = { p1: 'high', p2: 'med', p3: 'low', high: 'high', med: 'med', medium: 'med', low: 'low' };
// "Enjoy the sun", "sat exam": these three are ordinary words, so alone they are not a day.
const PLAIN_WORDS = new Set(['sun', 'sat', 'wed']);
// "Drive to work", "back at work": an area word right after these is part of the title.
const KEEP_AREA = new Set(['to', 'at', 'from', 'of', 'the', 'my', 'in', 'into', 'after', 'before', 'back']);
// "Set the heating too low", "fly high".
const KEEP_PRIORITY = new Set(['to', 'too', 'very', 'so', 'is', 'are', 'run', 'running', 'set', 'turn', 'keep', 'stay', 'go', 'fly', 'aim']);
const pad = (n: number) => String(n).padStart(2, '0');
const int = (s: string | undefined) => (s !== undefined && /^\d{1,3}$/.test(s) ? +s : NaN);
const dayOfMonth = (k: string | undefined) => { const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(k ?? ''); return m && +m[1] >= 1 && +m[1] <= 31 ? +m[1] : NaN; };

/** A word of the input: `raw` as typed, `k` lower case without trailing punctuation. */
interface Tok { raw: string; k: string }

/** "15 oct" without a year: this year, or next year once it has passed. */
function ymd(y: number | null, m: number, d: number, today: string): string | undefined {
  const mk = (yy: number) => `${yy}-${pad(m)}-${pad(d)}`;
  if (y !== null) return isDay(mk(y)) ? mk(y) : undefined;
  const ty = +today.slice(0, 4);
  if (isDay(mk(ty)) && mk(ty) >= today) return mk(ty);
  return isDay(mk(ty + 1)) ? mk(ty + 1) : undefined;
}

/** A date starting at token i: [day, tokens used], or null. `bare` allows sun/sat/wed alone. */
function date(t: Tok[], i: number, today: string, bare = false): [string, number] | null {
  const k = t[i]?.k, k2 = t[i + 1]?.k, k3 = t[i + 2]?.k;
  if (!k) return null;
  if ((k === 'on' || k === 'this') && k2) { const d = date(t, i + 1, today, true); return d && [d[0], d[1] + 1]; }
  if (k === 'today') return [today, 1];
  if (k === 'tomorrow' || k === 'tmrw') return [addDays(today, 1), 1];
  const wd = dayIndex(k);
  // A weekday is its next occurrence: later this week, or next week if today or already past.
  if (wd !== undefined && (bare || !PLAIN_WORDS.has(k))) return [addDays(today, (wd - dt(today).getDay() + 7) % 7 || 7), 1];
  if (k === 'next' && k2) {
    if (k2 === 'week') return [addDays(weekStart(today), 7), 2];
    const nd = dayIndex(k2);
    // "next fri" is the Friday of next week (Monday to Sunday), even when this Friday is still ahead.
    if (nd !== undefined) return [addDays(weekStart(today), 7 + WEEK_ORDER.indexOf(nd)), 2];
  }
  if (k === 'in' && k2 && k3) {
    const n = k2 === 'a' || k2 === 'one' ? 1 : int(k2);
    if (n >= 0 && /^(days?|weeks?)$/.test(k3)) return [addDays(today, k3.startsWith('w') ? n * 7 : n), 3];
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (m) return isDay(k) ? [k, 1] : null;
  // "24/7" is a phrase, not the 24th of July.
  if (k !== '24/7' && (m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/.exec(k))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, d = ymd(y, +m[2], +m[1], today);
    return d ? [d, 1] : null;
  }
  const dm = dayOfMonth(k);
  if (dm && k2 && MONTHS[k2]) { const d = ymd(null, MONTHS[k2], dm, today); return d ? [d, 2] : null; }
  if (MONTHS[k] && k2) { const md = dayOfMonth(k2); const d = md ? ymd(null, MONTHS[k], md, today) : undefined; return d ? [d, 2] : null; }
  return null;
}

/** A time of day starting at token i ("5pm", "5:30 pm", "17:00"): ["HH:MM", tokens used], or null. */
function time(t: Tok[], i: number): [string, number] | null {
  const k = t[i]?.k, k2 = t[i + 1]?.k;
  if (!k) return null;
  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(k), used = 1;
  if (!m && (k2 === 'am' || k2 === 'pm')) { m = /^(\d{1,2})(?::(\d{2}))?()$/.exec(k); if (m) { m[3] = k2; used = 2; } }
  if (m) {
    const h = +m[1], min = m[2] ? +m[2] : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    return [pad((h % 12) + (m[3] === 'pm' ? 12 : 0)) + ':' + pad(min), used];
  }
  if ((m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(k))) return [pad(+m[1]) + ':' + m[2], 1];
  return null;
}

/** A duration starting at token i ("45m", "1h30", "1.5h", "90 min"): [minutes, tokens used], or null. */
function duration(t: Tok[], i: number): [number, number] | null {
  const k = t[i]?.k, k2 = t[i + 1]?.k;
  if (!k) return null;
  let m = /^(\d+(?:\.\d+)?)(m|mins?|minutes?)$/.exec(k);
  if (m) return [+m[1], 1];
  if ((m = /^(\d+(?:\.\d+)?)(h|hrs?|hours?)$/.exec(k))) return [+m[1] * 60, 1];
  if ((m = /^(\d+)h(\d{1,2})(m|mins?)?$/.exec(k))) return [+m[1] * 60 + +m[2], 1];
  if (/^\d+(\.\d+)?$/.test(k) && k2) {
    if (/^(m|mins?|minutes?)$/.test(k2)) return [+k, 2];
    if (/^(h|hrs?|hours?)$/.test(k2)) return [+k * 60, 2];
  }
  return null;
}

/** A weekday list starting at token i ("mon,thu", "mon, thu", "mon and thu"): [days, tokens used], or null. */
function weekdays(t: Tok[], i: number): [number[], number] | null {
  const days: number[] = [];
  let j = i;
  for (;;) {
    const parts = (t[j]?.raw.toLowerCase().replace(/[.;:!?]+$/, '') ?? '').split(',');
    const trailing = parts[parts.length - 1] === '';
    const names = parts.filter(Boolean).map(dayIndex);
    if (!names.length || names.some(n => n === undefined)) break;
    days.push(...(names as number[]));
    j++;
    if (trailing && dayIndex(t[j]?.k ?? '') !== undefined) continue;
    if ((t[j]?.k === 'and' || t[j]?.k === '&') && dayIndex(t[j + 1]?.k ?? '') !== undefined) { j++; continue; }
    break;
  }
  return days.length ? [days, j - i] : null;
}

/**
 * Parses free text into task fields. Recognised words are removed from the title wherever they
 * are, in any order; anything else stays. Returns only the fields it found.
 */
export function parseQuickAdd(text: string, today: string, _opts: { now?: Date } = {}): QuickParse {
  const out: Omit<QuickParse, 'title'> = {};
  let s = ' ' + text.replace(/\s+/g, ' ') + ' ';
  s = s.replace(/https?:\/\/[^\s<>"]+/i, u => { out.link = u.replace(/[.,;:!?)]+$/, ''); return ' '; });
  // iOS dictation writes "5:30 p.m."; read it as "5:30pm".
  s = s.replace(/(\d)\s*([ap])\.\s?m\.?(?=\s|$)/gi, '$1$2m');
  const tag = (name: string) => {
    const a = AREAS[name.toLowerCase()];
    if (a) { out.area ??= a; return true; }
    if (out.project !== undefined) return false;
    out.project = name;
    return true;
  };
  // Quoted projects take straight or curly quotes (the iPhone keyboard types curly ones).
  s = s.replace(/(\s)#["“”]([^"“”]*)["“”](?=[\s,.;:!?])/g, (all, sp, name) => (name.trim() && tag(name.trim()) ? sp : all));
  s = s.replace(/(\s)#([^\s#"“”]+)(?=\s)/g, (all, sp, name) => { const n = name.replace(/[,.;:!?]+$/, ''); return n && tag(n) ? sp : all; });

  const t: Tok[] = s.split(' ').filter(Boolean).map(raw => ({ raw, k: raw.toLowerCase().replace(/[,.;:!?]+$/, '') }));
  const keep: Tok[] = [];
  let weekly = false, monthly = false;
  for (let i = 0; i < t.length;) {
    const k = t[i].k, k2 = t[i + 1]?.k, k3 = t[i + 2]?.k;
    let used = 0;
    // Repeats first: "every mon" is a rule, not a day.
    if (out.repeat === undefined && !weekly && !monthly) {
      if (k === 'daily') { out.repeat = 'daily'; used = 1; }
      else if (k === 'weekdays') { out.repeat = 'weekdays'; used = 1; }
      else if (k === 'weekly') { weekly = true; used = 1; }
      else if (k === 'monthly') {
        const d = dayOfMonth(k2);
        if (d) { out.repeat = 'monthly:' + d; used = 2; } else { monthly = true; used = 1; }
      } else if (k === 'every' && k2) {
        if (k2 === 'day') { out.repeat = 'daily'; used = 2; }
        else if (k2 === 'weekday') { out.repeat = 'weekdays'; used = 2; }
        else if (k2 === 'week') { weekly = true; used = 2; }
        else if (k2 === 'month') {
          const the = t[i + 3]?.k === 'the' ? 1 : 0, d = k3 === 'on' ? dayOfMonth(t[i + 3 + the]?.k) : NaN;
          if (d) { out.repeat = 'monthly:' + d; used = 4 + the; } else { monthly = true; used = 2; }
        } else if (int(k2) >= 1 && k3 && /^(days?|weeks?|months?)$/.test(k3)) {
          out.repeat = `every:${int(k2)}:${k3.replace(/s?$/, 's')}`; used = 3;
        } else {
          const w = weekdays(t, i + 1);
          if (w) { out.repeat = weeklyRule(w[0]); used = 1 + w[1]; }
        }
      }
    }
    if (!used && out.repeat_from === undefined && (k === 'after' || k === 'from') && k2 === 'done') { out.repeat_from = 'done'; used = 2; }
    if (!used && k === 'due' && out.due === undefined) { const d = date(t, i + 1, today, true); if (d) { out.due = d[0]; used = 1 + d[1]; } }
    if (!used && out.day === undefined) { const d = date(t, i, today); if (d) { out.day = d[0]; used = d[1]; } }
    if (!used && out.at === undefined) {
      const lead = k === 'at' || k === '@' ? 1 : 0;
      const tm = /^@\d/.test(k) ? time([{ raw: '', k: k.slice(1) }, ...t.slice(i + 1)], 0) : time(t, i + lead);
      if (tm) { out.at = tm[0]; used = lead + tm[1]; }
    }
    if (!used && out.energy === undefined && (k === 'high' || k === 'low') && k2 === 'energy') { out.energy = k as Energy; used = 2; }
    if (!used && out.priority === undefined) {
      if (/^p[123]$/.test(k)) { out.priority = PRIORITY[k]; used = 1; }
      else if (/^!(high|med|medium|low)$/.test(k)) { out.priority = PRIORITY[k.slice(1)]; used = 1; }
    }
    if (!used && out.est === undefined) {
      const lead = k === 'for' ? 1 : 0, d = duration(t, i + lead);
      if (d) { out.est = Math.round(d[0]); used = lead + d[1]; }
    }
    if (!used && out.area === undefined) {
      const lead = k === 'for' ? 1 : 0, a = AREAS[t[i + lead]?.k ?? ''];
      if (a && (lead || !KEEP_AREA.has(keep[keep.length - 1]?.k ?? ''))) { out.area = a; used = lead + 1; }
    }
    if (used) i += used;
    else keep.push(t[i++]);
  }
  // "high", "med" and "low" alone are a priority only at the very end, where they can't be part of the title.
  const last = keep[keep.length - 1], before = keep[keep.length - 2];
  if (out.priority === undefined && last && before && ['high', 'med', 'medium', 'low'].includes(last.k) && !KEEP_PRIORITY.has(before.k)) { out.priority = PRIORITY[last.k]; keep.pop(); }
  const base = out.day ?? today;
  if (weekly) out.repeat = weeklyRule([dt(base).getDay()]);
  if (monthly) out.repeat = 'monthly:' + dt(base).getDate();
  // Words that were part of a removed phrase can leave stray punctuation at either end.
  const title = keep.map(x => x.raw).join(' ').replace(/^[\s,;:.!-]+|[\s,;:.!-]+$/g, '');
  const res: QuickParse = { title };
  for (const f of ['area', 'project', 'day', 'due', 'at', 'est', 'priority', 'energy', 'repeat', 'repeat_from', 'link'] as const) {
    if (out[f] !== undefined) Object.assign(res, { [f]: out[f] });
  }
  return res;
}

/** "ask claude …", "claude, …", "claude: …": the rest is a request for Claude, not a task. */
export function askClaude(text: string): string | null {
  const m = /^\s*(?:ask claude\b[\s,:]*(?:to\s+)?|claude\s*[,:]\s*)([\s\S]*)$/i.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * The composer's "+ …" line as a task for POST /api/tasks, with the defaults the server's
 * /api/quick applies (Work or the last area, 30 minutes, med, low energy, today). Null when the
 * line does not start with "+" or has no title left.
 */
export function quickTask(text: string, today: string, defaults: { area?: Area } = {}): (TaskInput & QuickParse) | null {
  const m = /^\s*\+\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const p = parseQuickAdd(m[1], today);
  if (!p.title) return null;
  return {
    ...p,
    area: p.area ?? defaults.area ?? 'Work',
    day: p.day ?? today,
    est: Math.min(24 * 60, Math.max(5, p.est ?? 30)),
    priority: p.priority ?? 'med',
    energy: p.energy ?? 'low',
  };
}

/** The composer's preview after the title: "Fri 3 Oct · 17:30 · 45m · Wedding · Work · high · repeats weekly on Fri". */
export function quickPreview(q: TaskInput & QuickParse, today: string): string[] {
  const day = (d: string) => (d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDay(d));
  const rep = describeRepeat(q.repeat, q.repeat_from);
  return [
    day(q.day ?? today), q.at ?? '', fmtDur(q.est), q.project ?? '', q.area, q.priority !== 'med' ? q.priority : '',
    q.energy === 'high' ? 'high energy' : '', q.due ? 'due ' + fmtDay(q.due) : '', rep ? rep.charAt(0).toLowerCase() + rep.slice(1) : '',
  ].filter(Boolean);
}
