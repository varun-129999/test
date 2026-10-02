import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { describeRepeat, isRepeat, nextOccurrence, parseRepeat } from '../src/repeat.js';

const THU = '2026-10-01';

test('parseRepeat: human and canonical forms become canonical; others are null', () => {
  const cases: [string, string | null][] = [
    ['daily', 'daily'], ['Every day', 'daily'], ['weekdays', 'weekdays'], ['every weekday', 'weekdays'],
    ['weekly', 'weekly:Thu'], ['every week', 'weekly:Thu'], ['weekly:Mon,Thu', 'weekly:Mon,Thu'], ['weekly:thu,mon', 'weekly:Mon,Thu'],
    ['every mon, thu', 'weekly:Mon,Thu'], ['every monday and thursday', 'weekly:Mon,Thu'], ['weekly on fri', 'weekly:Fri'], ['every sun', 'weekly:Sun'],
    ['every:2:weeks', 'every:2:weeks'], ['every 2 weeks', 'every:2:weeks'], ['every 3 days', 'every:3:days'], ['every 1 month', 'every:1:months'],
    ['monthly', 'monthly:1'], ['monthly:25', 'monthly:25'], ['monthly 25', 'monthly:25'], ['every month on the 31st', 'monthly:31'], ['Repeats daily', 'daily'],
    ['monthly:32', null], ['every 0 days', null], ['fortnightly', null], ['every blue moon', null], ['', null], ['weekly:Mon,Xyz', null],
  ];
  for (const [human, out] of cases) assert.equal(parseRepeat(human, THU), out, human);
  assert.equal(parseRepeat('monthly', '2026-12-31'), 'monthly:31');
  assert.equal(parseRepeat('weekly', '2026-10-04'), 'weekly:Sun');
  for (const c of ['daily', 'weekdays', 'weekly:Mon,Thu', 'every:2:weeks', 'monthly:25']) assert.ok(isRepeat(c), c);
  for (const c of ['weekly', 'weekly:mon', 'every:2:fortnights', 'monthly:0']) assert.equal(isRepeat(c), false, c);
});

test('describeRepeat', () => {
  assert.equal(describeRepeat('daily'), 'Repeats daily');
  assert.equal(describeRepeat('weekdays'), 'Repeats on weekdays');
  assert.equal(describeRepeat('weekly:Mon,Thu'), 'Repeats every Mon, Thu');
  assert.equal(describeRepeat('every:1:weeks'), 'Repeats every week');
  assert.equal(describeRepeat('every:2:weeks'), 'Repeats every 2 weeks');
  assert.equal(describeRepeat('monthly:1'), 'Repeats monthly on the 1st');
  assert.equal(describeRepeat('monthly:22'), 'Repeats monthly on the 22nd');
  assert.equal(describeRepeat('monthly:13'), 'Repeats monthly on the 13th');
  assert.equal(describeRepeat('every:3:days', 'done'), 'Repeats every 3 days, counted from when it is done');
  assert.equal(describeRepeat('nonsense'), '');
  assert.equal(describeRepeat(null), '');
});

test('nextOccurrence: daily, weekdays, weekly lists wrapping the week', () => {
  assert.equal(nextOccurrence('daily', THU, 'planned', THU), '2026-10-02');
  assert.equal(nextOccurrence('weekdays', '2026-10-02', 'planned', '2026-10-02'), '2026-10-05', 'Friday to Monday');
  assert.equal(nextOccurrence('weekdays', THU, 'planned', THU), '2026-10-02');
  assert.equal(nextOccurrence('weekly:Mon,Thu', '2026-10-05', 'planned', '2026-10-05'), '2026-10-08', 'Mon to Thu');
  assert.equal(nextOccurrence('weekly:Mon,Thu', THU, 'planned', THU), '2026-10-05', 'Thu wraps to next Mon');
  assert.equal(nextOccurrence('weekly:Thu', THU, 'planned', THU), '2026-10-08');
  assert.equal(nextOccurrence('weekly:Sun', '2026-10-04', 'planned', '2026-10-04'), '2026-10-11');
});

test('nextOccurrence: every N, and monthly clamped to the month end', () => {
  assert.equal(nextOccurrence('every:3:days', THU, 'planned', THU), '2026-10-04');
  assert.equal(nextOccurrence('every:2:weeks', THU, 'planned', THU), '2026-10-15');
  assert.equal(nextOccurrence('every:1:months', '2027-01-31', 'planned', '2027-01-31'), '2027-02-28');
  assert.equal(nextOccurrence('every:1:months', '2028-01-31', 'planned', '2028-01-31'), '2028-02-29', 'leap year');
  assert.equal(nextOccurrence('every:3:months', '2026-11-30', 'planned', '2026-11-30'), '2027-02-28');
  assert.equal(nextOccurrence('monthly:25', THU, 'planned', THU), '2026-10-25');
  assert.equal(nextOccurrence('monthly:25', '2026-10-25', 'planned', '2026-10-25'), '2026-11-25');
  assert.equal(nextOccurrence('monthly:31', '2026-10-31', 'planned', '2026-10-31'), '2026-11-30', 'clamped');
  assert.equal(nextOccurrence('monthly:31', '2026-11-30', 'planned', '2026-11-30'), '2026-12-31', 'back to the 31st');
  assert.equal(nextOccurrence('monthly:30', '2027-01-30', 'planned', '2027-01-30'), '2027-02-28');
  assert.equal(nextOccurrence('monthly:1', '2026-12-01', 'planned', '2026-12-01'), '2027-01-01', 'over the year end');
  assert.throws(() => nextOccurrence('fortnightly', THU, 'planned', THU), /Unknown repeat rule/);
});

test('nextOccurrence: from the planned day vs from completion; never in the past', () => {
  // Planned Thu 1 Oct every 2 weeks, done on Sat 3 Oct.
  assert.equal(nextOccurrence('every:2:weeks', THU, 'planned', '2026-10-03'), '2026-10-15');
  assert.equal(nextOccurrence('every:2:weeks', THU, 'done', '2026-10-03'), '2026-10-17');
  assert.equal(nextOccurrence('weekly:Mon', THU, 'done', '2026-10-06'), '2026-10-12');
  // Done early (on Tue for Fri): planned keeps the rhythm.
  assert.equal(nextOccurrence('weekly:Fri', '2026-10-02', 'planned', '2026-09-29'), '2026-10-09');
  // A daily task finished three days late: the next one is today, not a trail of overdue copies.
  assert.equal(nextOccurrence('daily', '2026-09-28', 'planned', THU), THU);
  assert.equal(nextOccurrence('monthly:25', '2026-08-25', 'planned', THU), '2026-10-25');
  assert.equal(nextOccurrence('daily', '2026-09-28', 'done', THU), '2026-10-02');
  assert.equal(nextOccurrence('daily', THU, null, THU), '2026-10-02', 'null means planned');
});
