import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from './prompts';

const T = '2026-10-01'; // a Thursday

test('only a leading + is a quick add', () => {
  assert.equal(parseQuickAdd('groceries 45m', T), null);
  assert.equal(parseQuickAdd('+', T), null);
  assert.equal(parseQuickAdd('  +   ', T), null);
  assert.ok(parseQuickAdd('  + groceries', T));
});

test('defaults: today, 30 minutes, med, low energy, the given area', () => {
  assert.deepEqual(parseQuickAdd('+ groceries', T), { title: 'Groceries', area: 'Work', day: T, est: 30, priority: 'med', energy: 'low' });
  assert.equal(parseQuickAdd('+ groceries', T, { area: 'Personal' })!.area, 'Personal');
});

test('durations', () => {
  assert.equal(parseQuickAdd('+ groceries 45m', T)!.est, 45);
  assert.equal(parseQuickAdd('+ deck 2h', T)!.est, 120);
  assert.equal(parseQuickAdd('+ deck 1.5h', T)!.est, 90);
  assert.equal(parseQuickAdd('+ deck 1h30m', T)!.est, 90);
  assert.equal(parseQuickAdd('+ deck 1h 30', T)!.est, 90);
  assert.equal(parseQuickAdd('+ call 20 minutes', T)!.est, 20);
  assert.equal(parseQuickAdd('+ call 90 min', T)!.est, 90);
  assert.equal(parseQuickAdd('+ walk an hour', T)!.est, 60);
  assert.equal(parseQuickAdd('+ walk half an hour', T)!.est, 30);
  assert.equal(parseQuickAdd('+ marathon 30h', T)!.est, 24 * 60);
});

test('days: today, tonight, tomorrow, weekday names (1 to 7 days ahead)', () => {
  assert.equal(parseQuickAdd('+ groceries tomorrow', T)!.day, '2026-10-02');
  assert.equal(parseQuickAdd('+ groceries tonight', T)!.day, T);
  assert.equal(parseQuickAdd('+ gym mon', T)!.day, '2026-10-05');
  assert.equal(parseQuickAdd('+ gym on Monday', T)!.day, '2026-10-05');
  assert.equal(parseQuickAdd('+ gym next Mon', T)!.day, '2026-10-05');
  assert.equal(parseQuickAdd('+ standup thursday', T)!.day, '2026-10-08');
  assert.equal(parseQuickAdd('+ brunch on sun', T)!.day, '2026-10-04');
});

test('the spoken example from the review', () => {
  assert.deepEqual(parseQuickAdd('+ groceries 45 minutes tonight', T), { title: 'Groceries', area: 'Work', day: T, est: 45, priority: 'med', energy: 'low' });
});

test('tokens at the end in any order; area, priority, energy, due', () => {
  assert.deepEqual(parseQuickAdd('+ Pay Acme invoice 10m work high due fri', T), { title: 'Pay Acme invoice', area: 'Work', day: T, est: 10, priority: 'high', energy: 'low', due: '2026-10-02' });
  assert.deepEqual(parseQuickAdd('+ Gym 1h30m health mon', T), { title: 'Gym', area: 'Health', day: '2026-10-05', est: 90, priority: 'med', energy: 'low' });
  const t = parseQuickAdd('+ call mum tomorrow 20m personal low priority high energy', T)!;
  assert.equal(t.title, 'Call mum');
  assert.equal(t.day, '2026-10-02');
  assert.equal(t.est, 20);
  assert.equal(t.area, 'Personal');
  assert.equal(t.priority, 'low');
  assert.equal(t.energy, 'high');
  assert.equal(parseQuickAdd('+ Slides for work', T)!.title, 'Slides');
  assert.equal(parseQuickAdd('+ Slides for work', T)!.area, 'Work');
  assert.equal(parseQuickAdd('+ Call bank, tomorrow.', T)!.title, 'Call bank');
});

test('words in the middle of the title stay in the title', () => {
  assert.equal(parseQuickAdd('+ Plan Friday drinks', T)!.title, 'Plan Friday drinks');
  assert.equal(parseQuickAdd('+ Plan Friday drinks', T)!.day, T);
  assert.equal(parseQuickAdd('+ Read 2 chapters', T)!.title, 'Read 2 chapters');
  assert.equal(parseQuickAdd('+ Read 2 chapters', T)!.est, 30);
  assert.equal(parseQuickAdd('+ thu report 1.5h', T)!.title, 'Thu report');
});

test('common words that look like tokens are left alone', () => {
  const sun = parseQuickAdd('+ Enjoy the sun', T)!;
  assert.equal(sun.title, 'Enjoy the sun');
  assert.equal(sun.day, T);
  const drive = parseQuickAdd('+ Drive to work', T, { area: 'Personal' })!;
  assert.equal(drive.title, 'Drive to work');
  assert.equal(drive.area, 'Personal');
  assert.equal(parseQuickAdd('+ Set the thermostat too low', T)!.title, 'Set the thermostat too low');
});
