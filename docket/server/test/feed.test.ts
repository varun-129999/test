import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeStore, task } from './helpers.js';
import { createApp } from '../src/http.js';
import { buildIcs, escapeText, fold, tzOffset, vtimezone } from '../src/ics.js';
import { tzName } from '../src/dates.js';
import type { Store, Task } from '../src/store.js';

function serve(t: TestContext, store: Store) {
  const server = createApp(store, { token: 'secret' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + '/api' + path, { method, headers: { authorization: 'Bearer secret', ...headers } });
    return { status: res.status, body: await res.json() as any };
  };
  return { base, call };
}

const unfold = (ics: string) => ics.replace(/\r\n /g, '');
/** The VEVENT blocks of a feed, each as a map of property (with parameters) to value. */
function events(ics: string) {
  return unfold(ics).split('BEGIN:VEVENT\r\n').slice(1).map(block => {
    const props: Record<string, string> = {};
    for (const line of block.split('\r\n')) {
      if (line === 'END:VEVENT') break;
      const i = line.indexOf(':');
      props[line.slice(0, i)] = line.slice(i + 1);
    }
    return props;
  });
}

test('feed key: create once, same URL until revoked, https behind the proxy, main token only', async t => {
  const { store } = makeStore();
  const { base, call } = serve(t, store);
  assert.deepEqual((await call('GET', '/feed')).body, { url: null });
  const made = (await call('POST', '/feed')).body.url as string;
  const m = /^http:\/\/127\.0\.0\.1:\d+\/cal\/([0-9a-f]{32})\.ics$/.exec(made);
  assert.ok(m, made);
  assert.equal(store.meta('feed_key'), m[1]);
  assert.equal((await call('POST', '/feed')).body.url, made, 'a second create keeps the link');
  assert.equal((await call('GET', '/feed')).body.url, made);
  assert.equal((await call('GET', '/feed', { 'x-forwarded-proto': 'https' })).body.url, made.replace('http:', 'https:'));
  assert.equal((await fetch(base + '/api/feed', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/feed?token=secret')).status, 401);

  const ok = await fetch(made);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(ok.headers.get('cache-control'), 'no-cache');
  assert.match(ok.headers.get('content-disposition') ?? '', /filename="docket\.ics"/);
  assert.match(await ok.text(), /^BEGIN:VCALENDAR\r\n/);
  // A wrong key of the same length, a short one, a token, or none: 404, and no body worth reading.
  const wrong = m[1].replace(/^./, c => (c === '0' ? '1' : '0'));
  for (const k of [wrong, m[1].slice(0, 31), 'secret', '']) {
    const r = await fetch(`${base}/cal/${k}.ics`);
    assert.equal(r.status, 404, k);
    assert.doesNotMatch(await r.text(), /VCALENDAR/);
  }
  assert.equal((await fetch(`${base}/cal/${m[1]}`)).status === 200, false, 'the .ics suffix is part of the route');

  assert.equal((await call('DELETE', '/feed')).status, 200);
  assert.deepEqual((await call('GET', '/feed')).body, { url: null });
  assert.equal((await fetch(made)).status, 404, 'revoked');
  const fresh = (await call('POST', '/feed')).body.url as string;
  assert.notEqual(fresh, made);
  assert.equal((await fetch(fresh)).status, 200);
});

test('feed content: window, deleted excluded, timed vs all-day, done prefix, description, VTIMEZONE', async t => {
  const { store } = makeStore();
  const timed = store.addTask({ ...task, title: 'Call Sam', at: '17:30', est: 45, project: 'Q4, budget', priority: 'high', notes: 'Line 1\nback\\slash; semi, comma' });
  const allDay = store.addTask({ ...task, title: 'Groceries', area: 'Personal', day: '2026-10-03' });
  const done = store.completeTask(store.addTask({ ...task, title: 'Gym', area: 'Health', day: '2026-09-30' }).id);
  store.addTask({ ...task, title: 'First day in', day: '2026-09-24' });
  store.addTask({ ...task, title: 'Last day in', day: '2026-11-30' });
  store.addTask({ ...task, title: 'Too old', day: '2026-09-23' });
  store.addTask({ ...task, title: 'Too far', day: '2026-12-01' });
  store.deleteTask(store.addTask({ ...task, title: 'Deleted' }).id);
  const { call } = serve(t, store);
  const url = (await call('POST', '/feed')).body.url as string;
  const ics = await (await fetch(url)).text();

  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  const head = unfold(ics).split('BEGIN:VEVENT')[0];
  for (const p of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Docket//EN', 'X-WR-CALNAME:Docket', `X-WR-TIMEZONE:${tzName()}`, 'BEGIN:VTIMEZONE', `TZID:${tzName()}`]) {
    assert.ok(head.includes(p + '\r\n'), p);
  }
  const ev = events(ics);
  const by = (title: string) => ev.find(e => e.SUMMARY === title || e.SUMMARY === 'Done: ' + title);
  assert.deepEqual(ev.map(e => e.SUMMARY).sort(), ['Call Sam', 'Done: Gym', 'First day in', 'Groceries', 'Last day in']);
  for (const e of ev) for (const p of ['UID', 'DTSTAMP', 'SUMMARY', 'DESCRIPTION', 'CATEGORIES']) assert.ok(e[p], p);
  assert.match(ev[0].DTSTAMP, /^\d{8}T\d{6}Z$/);

  const c = by('Call Sam')!;
  assert.equal(c.UID, `${timed.id}@docket`);
  assert.equal(c[`DTSTART;TZID=${tzName()}`], '20261001T173000');
  assert.equal(c.DURATION, 'PT45M');
  assert.equal(c.DTEND, undefined);
  assert.equal(c.DESCRIPTION, `Project: Q4\\, budget\\nPriority: high\\nArea: Work\\nLine 1\\nback\\\\slash\\; semi\\, comma\\nOpen: ${new URL(url).origin}/`);
  assert.equal(c.CATEGORIES, 'Work');
  assert.equal(c.STATUS, undefined);

  const g = by('Groceries')!;
  assert.equal(g.UID, `${allDay.id}@docket`);
  assert.deepEqual([g['DTSTART;VALUE=DATE'], g['DTEND;VALUE=DATE'], g.DURATION], ['20261003', '20261004', undefined]);
  assert.equal(g.CATEGORIES, 'Personal');

  const d = by('Gym')!;
  assert.deepEqual([d.SUMMARY, d.STATUS, d.UID], ['Done: Gym', 'COMPLETED', `${done.id}@docket`]);
});

test('ICS helpers: escaping, folding at 75 octets without splitting characters, VTIMEZONE offsets', () => {
  assert.equal(escapeText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
  assert.equal(fold('SUMMARY:short'), 'SUMMARY:short');
  const long = 'SUMMARY:' + 'Plan the Lisbon trip, book flights and the hotel near Alfama '.repeat(3);
  const folded = fold(long);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  assert.equal(Buffer.byteLength(parts[0]), 75);
  for (const p of parts.slice(1)) { assert.ok(p.startsWith(' ')); assert.ok(Buffer.byteLength(p) <= 75); }
  assert.equal(folded.replace(/\r\n /g, ''), long);
  // Multi-byte text: no character is cut between lines.
  const wide = 'SUMMARY:' + 'चाय पीना और योजना बनाना '.repeat(6) + 'déjà vu';
  const wf = fold(wide);
  for (const p of wf.split('\r\n')) { assert.ok(Buffer.byteLength(p) <= 75); assert.ok(!p.includes('�')); }
  assert.equal(wf.replace(/\r\n /g, ''), wide);

  const at = new Date('2026-10-01T10:00:00Z');
  assert.deepEqual(vtimezone('Asia/Kolkata', at), [
    'BEGIN:VTIMEZONE', 'TZID:Asia/Kolkata', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
  ]);
  assert.equal(tzOffset('Europe/London', new Date('2026-01-15T12:00:00Z')), '+0000');
  assert.ok(vtimezone('Europe/London', new Date('2026-07-01T12:00:00Z')).includes('TZOFFSETTO:+0100'), 'a DST zone: the offset in force now');
  assert.equal(tzOffset('America/New_York', new Date('2026-01-15T12:00:00Z')), '-0500');

  const t = { id: 'abc', title: 'x', area: 'Work', day: '2026-10-01', at: null, est: 30, priority: 'med', done: false, project: null, notes: null, updated_at: 'x' } as unknown as Task;
  const ics = buildIcs([t], { now: at, tz: 'Asia/Kolkata', appUrl: 'https://docket.example.com/' });
  assert.match(ics, /\r\nDESCRIPTION:Priority: med\\nArea: Work\\nOpen: https:\/\/docket\.example\.com\/\r\n/);
  assert.doesNotMatch(ics, /LAST-MODIFIED/, 'an unparseable updated_at is left out');
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/, 'CRLF only');
});
