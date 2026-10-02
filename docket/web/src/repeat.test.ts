import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRule, describeRepeat, formatRule, parseRule, shortRepeat } from './repeat';

test('parseRule and formatRule round-trip the canonical forms', () => {
  for (const c of ['daily', 'weekdays', 'weekly:Mon', 'weekly:Mon,Thu', 'weekly:Mon,Tue,Wed,Thu,Fri,Sat,Sun', 'every:2:weeks', 'every:3:days', 'every:6:months', 'monthly:1', 'monthly:31']) {
    const r = parseRule(c);
    assert.ok(r, c);
    assert.equal(formatRule(r!), c);
  }
  assert.equal(formatRule({ kind: 'weekly', days: [4, 1, 4, 0] }), 'weekly:Mon,Thu,Sun', 'sorted Monday first, no repeats');
});

test('parseRule refuses anything else', () => {
  for (const c of [null, undefined, '', 'weekly', 'weekly:', 'weekly:Mon,Xyz', 'every:0:days', 'every:2:years', 'monthly:0', 'monthly:32', 'monthly', 'fortnightly']) assert.equal(parseRule(c as string), null, String(c));
});

test('describeRepeat, the full text', () => {
  assert.equal(describeRepeat('daily'), 'Repeats daily');
  assert.equal(describeRepeat('weekdays'), 'Repeats on weekdays');
  assert.equal(describeRepeat('weekly:Fri'), 'Repeats every Fri');
  assert.equal(describeRepeat('weekly:Mon,Thu'), 'Repeats every Mon, Thu');
  assert.equal(describeRepeat('every:2:weeks'), 'Repeats every 2 weeks');
  assert.equal(describeRepeat('every:1:months'), 'Repeats every month');
  assert.equal(describeRepeat('monthly:25'), 'Repeats monthly on the 25th');
  assert.equal(describeRepeat('monthly:1'), 'Repeats monthly on the 1st');
  assert.equal(describeRepeat('monthly:22'), 'Repeats monthly on the 22nd');
  assert.equal(describeRepeat('monthly:13'), 'Repeats monthly on the 13th');
  assert.equal(describeRepeat('every:3:days', 'done'), 'Repeats every 3 days, counted from when it is done');
  assert.equal(describeRepeat('daily', 'planned'), 'Repeats daily');
  assert.equal(describeRepeat(null), '');
  assert.equal(describeRepeat('yearly:1:1'), '', 'unknown rules show nothing');
});

test('shortRepeat, the tag on a block', () => {
  assert.equal(shortRepeat('daily'), 'Daily');
  assert.equal(shortRepeat('weekdays'), 'Weekdays');
  assert.equal(shortRepeat('weekly:Fri'), 'Weekly');
  assert.equal(shortRepeat('weekly:Mon,Thu'), 'Mon, Thu');
  assert.equal(shortRepeat('every:2:weeks'), 'Every 2 weeks');
  assert.equal(shortRepeat('every:1:weeks'), 'Weekly');
  assert.equal(shortRepeat('monthly:25'), 'Monthly');
  assert.equal(shortRepeat(null), '');
});

test('defaultRule follows the task day', () => {
  assert.deepEqual(defaultRule('weekly', '2026-10-02'), { kind: 'weekly', days: [5] });
  assert.deepEqual(defaultRule('monthly', '2026-10-25'), { kind: 'monthly', date: 25 });
  assert.deepEqual(defaultRule('every', '2026-10-25'), { kind: 'every', n: 2, unit: 'weeks' });
  assert.deepEqual(defaultRule('daily', '2026-10-25'), { kind: 'daily' });
});
