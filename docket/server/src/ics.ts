// The calendar feed (GET /cal/<key>.ics): tasks as an iCalendar (RFC 5545) subscription for
// Apple Calendar and others. Read-only; the key in the URL is the only secret.
import { addDays } from './dates.js';
import type { Task } from './store.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** TEXT values: backslash, semicolon, comma and line breaks are escaped (RFC 5545 3.3.11). */
export const escapeText = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
    // Other control characters are not allowed in a content line.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/** Content lines are at most 75 octets; longer ones continue on lines starting with a space. Never splits a character. */
export function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const out: string[] = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** "+0530" for a zone at a moment, from Intl (the zone need not be the process's own). */
export function tzOffset(tz: string, at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}${m[2]}${m[3] ?? '00'}` : '+0000';
}

/**
 * A VTIMEZONE for `tz`. A zone without daylight saving (Asia/Kolkata) is exact: one STANDARD
 * part. For a zone with daylight saving this emits only the offset in force at `at`, so timed
 * events across a change show an hour off in calendars that use it; Docket's owner is on IST.
 */
export function vtimezone(tz: string, at: Date): string[] {
  const y = at.getUTCFullYear();
  const jan = tzOffset(tz, new Date(Date.UTC(y, 0, 1))), jul = tzOffset(tz, new Date(Date.UTC(y, 6, 1)));
  const off = jan === jul ? jan : tzOffset(tz, at);
  return ['BEGIN:VTIMEZONE', `TZID:${tz}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'END:STANDARD', 'END:VTIMEZONE'];
}

const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateValue = (day: string) => day.replace(/-/g, '');

export interface IcsOptions { now: Date; tz: string; /** The app's address, e.g. "https://docket.example.com/". */ appUrl: string }

/** The whole calendar: one VEVENT per task, CRLF line ends, folded. */
export function buildIcs(tasks: Task[], o: IcsOptions): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Docket//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Docket', `X-WR-TIMEZONE:${o.tz}`,
    // A hint only: Apple Calendar uses the refresh set in the subscription.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...vtimezone(o.tz, o.now),
  ];
  const stamp = utcStamp(o.now);
  for (const t of tasks) {
    const desc = [
      t.project ? `Project: ${t.project}` : '', `Priority: ${t.priority}`, `Area: ${t.area}`,
      t.notes ?? '', `Open: ${o.appUrl}`,
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${t.id}@docket`, `DTSTAMP:${stamp}`);
    if (Number.isFinite(Date.parse(t.updated_at))) lines.push(`LAST-MODIFIED:${utcStamp(new Date(t.updated_at))}`);
    lines.push(`SUMMARY:${escapeText((t.done ? 'Done: ' : '') + t.title)}`);
    if (t.at) {
      lines.push(`DTSTART;TZID=${o.tz}:${dateValue(t.day)}T${t.at.replace(':', '')}00`, `DURATION:PT${t.est}M`);
    } else {
      // An all-day event: DTEND is the next day (exclusive). Transparent, so it does not block the day.
      lines.push(`DTSTART;VALUE=DATE:${dateValue(t.day)}`, `DTEND;VALUE=DATE:${dateValue(addDays(t.day, 1))}`, 'TRANSP:TRANSPARENT');
    }
    lines.push(`DESCRIPTION:${escapeText(desc)}`, `CATEGORIES:${escapeText(t.area)}`);
    if (t.done) lines.push('STATUS:COMPLETED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
