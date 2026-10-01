// Date and duration helpers, matching the prototype. Days are `YYYY-MM-DD`.
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dt = (s: string) => new Date(s + 'T12:00:00');
export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(dt(s)) === s;
export const addDays = (s: string, n: number) => { const d = dt(s); d.setDate(d.getDate() + n); return iso(d); };
export const weekStart = (s: string) => addDays(s, -((dt(s).getDay() + 6) % 7));
export const isoWeek = (s: string) => {
  const d = dt(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const fy = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - fy.getTime()) / 864e5 - 3 + ((fy.getDay() + 6) % 7)) / 7);
};
export const fmtDur = (m: number) => { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm'; };
export const fmtDay = (s: string) => { const d = dt(s); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
export const hhmm = (at: Date | number) => { const d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const ago = (at: string | null, now = Date.now()) => {
  if (!at) return 'never';
  const mins = Math.round((now - new Date(at).getTime()) / 6e4);
  return mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
};
/** Short age for queue rows: "now", "5m", "3h", "2d". */
export const age = (at: string | null, now = Date.now()) => {
  if (!at) return '';
  const mins = Math.floor((now - new Date(at).getTime()) / 6e4);
  return mins < 1 ? 'now' : mins < 60 ? mins + 'm' : mins < 1440 ? Math.floor(mins / 60) + 'h' : Math.floor(mins / 1440) + 'd';
};
export const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** "Tue" within the last week, otherwise "24 Sep". */
export const shortDay = (day: string, today: string) => {
  const d = dt(day);
  return day < today && day >= addDays(today, -6) ? DOW[d.getDay()] : `${d.getDate()} ${MON[d.getMonth()]}`;
};
/** The Monday after `today` (a week ahead when today is Monday). */
export const nextMonday = (today: string) => addDays(weekStart(today), 7);
/** "Mon 5 Oct 09:00" in the device's local time. */
export const fmtMoment = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${hhmm(d)}`;
};
/** Today's date in a time zone (the server's), falling back to the device's. */
export const todayIn = (tz: string, now = Date.now()) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch { return iso(new Date(now)); }
};
