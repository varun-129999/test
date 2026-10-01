// Date helpers. Days are local-time `YYYY-MM-DD` strings (set TZ for the owner's zone).

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dt = (s: string) => new Date(s + 'T12:00:00');
export const addDays = (s: string, n: number) => { const d = dt(s); d.setDate(d.getDate() + n); return iso(d); };
export const isIsoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dt(s).getTime());

/** Monday of the week containing `s`. */
export const weekStart = (s: string) => addDays(s, -((dt(s).getDay() + 6) % 7));
export const weekDays = (s: string) => [0, 1, 2, 3, 4, 5, 6].map(i => addDays(weekStart(s), i));

export const isoWeek = (s: string) => {
  const d = dt(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const fy = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - fy.getTime()) / 864e5 - 3 + ((fy.getDay() + 6) % 7)) / 7);
};

export const fmtDay = (s: string) => { const d = dt(s); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };

/** Parses a reset spec like "Mon 09:00". */
export function parseReset(spec: string): { dow: number; hour: number; minute: number } {
  const m = /^(\w{3})\w*\s+(\d{1,2}):(\d{2})$/.exec(spec.trim());
  const dow = m ? DOW.findIndex(d => d.toLowerCase() === m[1].toLowerCase()) : -1;
  if (!m || dow < 0) return { dow: 1, hour: 9, minute: 0 };
  return { dow, hour: Math.min(23, +m[2]), minute: Math.min(59, +m[3]) };
}

/** Start of the usage period containing `now` (the most recent reset moment). */
export function periodStart(now: Date, spec = 'Mon 09:00'): Date {
  const { dow, hour, minute } = parseReset(spec);
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7));
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}
