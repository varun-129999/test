import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd, quickPreview, quickTask } from './prompts';

const T = '2026-10-01'; // a Thursday
const p = (text: string, today = T) => parseQuickAdd(text, today);

test('composer: only a leading + is a quick add; defaults are applied there', () => {
  assert.equal(quickTask('groceries 45m', T), null);
  assert.equal(quickTask('+', T), null);
  assert.equal(quickTask('  +   ', T), null);
  assert.equal(quickTask('+ tomorrow 45m', T), null, 'nothing left for a title');
  assert.deepEqual(quickTask('+ groceries', T), { title: 'groceries', area: 'Work', day: T, est: 30, priority: 'med', energy: 'low' });
  assert.equal(quickTask('+ groceries', T, { area: 'Personal' })!.area, 'Personal');
  assert.equal(quickTask('+ marathon 30h', T)!.est, 24 * 60);
});

test('the parser returns only what it found', () => {
  assert.deepEqual(p('groceries'), { title: 'groceries' });
  assert.deepEqual(p('  Call   bank  '), { title: 'Call bank' });
});

test('durations', () => {
  for (const [text, est] of [['deck 45m', 45], ['deck 1h', 60], ['deck 1h30', 90], ['deck 1h30m', 90], ['deck 1.5h', 90], ['deck 90 min', 90], ['deck 20 minutes', 20], ['deck 2 hours', 120], ['deck 30min', 30]] as const) {
    assert.deepEqual(p(text), { title: 'deck', est }, text);
  }
});

test('days: today, tomorrow, weekday names, next, in N, dates', () => {
  const cases: [string, string][] = [
    ['x today', T], ['x tomorrow', '2026-10-02'], ['x tmrw', '2026-10-02'],
    ['x fri', '2026-10-02'], ['x friday', '2026-10-02'], ['x thu', '2026-10-08'], ['x mon', '2026-10-05'], ['x Sunday', '2026-10-04'],
    ['x next mon', '2026-10-05'], ['x next fri', '2026-10-09'], ['x next week', '2026-10-05'],
    ['x in 3 days', '2026-10-04'], ['x in 2 weeks', '2026-10-15'],
    ['x 15 oct', '2026-10-15'], ['x oct 15', '2026-10-15'], ['x 15/10', '2026-10-15'], ['x 2026-10-15', '2026-10-15'],
    ['x 5 sep', '2027-09-05'], ['x 1 oct', T],
  ];
  for (const [text, day] of cases) assert.deepEqual(p(text), { title: 'x', day }, text);
  assert.deepEqual(p('x 31/02'), { title: 'x 31/02' }, 'not a real date');
});

test('due <date> sets due, not day', () => {
  assert.deepEqual(p('Pay invoice due fri'), { title: 'Pay invoice', due: '2026-10-02' });
  assert.deepEqual(p('Pay invoice tomorrow due 15 oct'), { title: 'Pay invoice', day: '2026-10-02', due: '2026-10-15' });
  assert.deepEqual(p('Due diligence'), { title: 'Due diligence' });
});

test('times', () => {
  const cases: [string, string][] = [['x at 5pm', '17:00'], ['x 5:30pm', '17:30'], ['x at 17:00', '17:00'], ['x @ 9am', '09:00'], ['x @9am', '09:00'], ['x 12am', '00:00'], ['x 12pm', '12:00'], ['x at 5 pm', '17:00'], ['x 9:05', '09:05']];
  for (const [text, at] of cases) assert.deepEqual(p(text), { title: 'x', at }, text);
  assert.deepEqual(p('Look at the deck'), { title: 'Look at the deck' });
  assert.deepEqual(p('x at 25:00'), { title: 'x at 25:00' });
});

test('priority: p1-p3, !word, or a bare word at the very end', () => {
  assert.equal(p('x p1').priority, 'high');
  assert.equal(p('x p2').priority, 'med');
  assert.equal(p('x p3').priority, 'low');
  assert.equal(p('x !high tomorrow').priority, 'high');
  assert.equal(p('x !medium').priority, 'med');
  assert.deepEqual(p('Fix the heating high'), { title: 'Fix the heating', priority: 'high' });
  assert.deepEqual(p('Call mum tomorrow low'), { title: 'Call mum', day: '2026-10-02', priority: 'low' });
  assert.deepEqual(p('High tea with Sam'), { title: 'High tea with Sam' });
  assert.deepEqual(p('high'), { title: 'high' });
});

test('energy and area', () => {
  assert.deepEqual(p('Write report high energy'), { title: 'Write report', energy: 'high' });
  assert.deepEqual(p('Write report low energy low'), { title: 'Write report', energy: 'low', priority: 'low' });
  assert.deepEqual(p('Gym health'), { title: 'Gym', area: 'Health' });
  assert.deepEqual(p('Gym #health'), { title: 'Gym', area: 'Health' });
  assert.deepEqual(p('Dentist Personal'), { title: 'Dentist', area: 'Personal' });
});

test('projects', () => {
  assert.deepEqual(p('Book hotel #Wedding'), { title: 'Book hotel', project: 'Wedding' });
  assert.deepEqual(p('Book train #"Bokaro trip" fri'), { title: 'Book train', project: 'Bokaro trip', day: '2026-10-02' });
  assert.deepEqual(p('#Q4 slides #work'), { title: 'slides', project: 'Q4', area: 'Work' });
});

test('repeats', () => {
  const cases: [string, string][] = [
    ['x daily', 'daily'], ['x every day', 'daily'], ['x weekdays', 'weekdays'], ['x every weekday', 'weekdays'],
    ['x weekly', 'weekly:Thu'], ['x weekly fri', 'weekly:Fri'], ['x every mon', 'weekly:Mon'], ['x every mon,thu', 'weekly:Mon,Thu'],
    ['x every thu, mon', 'weekly:Mon,Thu'], ['x every 2 weeks', 'every:2:weeks'], ['x every 3 days', 'every:3:days'], ['x every 3 months', 'every:3:months'],
    ['x monthly', 'monthly:1'], ['x monthly 25', 'monthly:25'], ['x every month on 25', 'monthly:25'],
  ];
  for (const [text, repeat] of cases) {
    const r = p(text);
    assert.equal(r.repeat, repeat, text);
    assert.equal(r.title, 'x', text);
  }
  assert.deepEqual(p('Water plants every 3 days after done'), { title: 'Water plants', repeat: 'every:3:days', repeat_from: 'done' });
  assert.equal(p('x weekly from done').repeat_from, 'done');
  assert.equal(p('x every mon').day, undefined, 'the rule does not move the day');
});

test('links', () => {
  assert.deepEqual(p('Read https://example.com/a?b=1 tomorrow'), { title: 'Read', day: '2026-10-02', link: 'https://example.com/a?b=1' });
  assert.deepEqual(p('Read this: https://example.com/x.'), { title: 'Read this', link: 'https://example.com/x' });
});

test('everything at once, in any order', () => {
  assert.deepEqual(p('Call Sam fri at 5:30pm 45m #Wedding !high weekly'), { title: 'Call Sam', project: 'Wedding', day: '2026-10-02', at: '17:30', est: 45, priority: 'high', repeat: 'weekly:Fri' });
  assert.deepEqual(p('p1 45m tomorrow Prepare Q4 planning at 9am work'), { title: 'Prepare Q4 planning', area: 'Work', day: '2026-10-02', at: '09:00', est: 45, priority: 'high' });
  assert.equal(p('Plan Friday drinks').day, '2026-10-02', 'weekday names count anywhere');
});

test('a second value of the same kind stays in the title', () => {
  assert.deepEqual(p('x tomorrow fri'), { title: 'x fri', day: '2026-10-02' });
  assert.deepEqual(p('x 45m 1h'), { title: 'x 1h', est: 45 });
});

test('the composer preview', () => {
  const q = quickTask('+ Call Sam fri at 5:30pm 45m #Wedding !high weekly', T)!;
  assert.deepEqual(quickPreview(q, T), ['Tomorrow', '17:30', '45m', 'Wedding', 'Work', 'high', 'repeats every Fri']);
  assert.deepEqual(quickPreview(quickTask('+ x 2026-10-09 due 2026-10-15 high energy every 2 weeks after done', T)!, T), ['Fri 9 Oct', '30m', 'Work', 'high energy', 'due Thu 15 Oct', 'repeats every 2 weeks, counted from when it is done']);
  assert.deepEqual(quickPreview(quickTask('+ x', T)!, T), ['Today', '30m', 'Work']);
});

test('ordinary words that look like tokens', () => {
  assert.deepEqual(p('Enjoy the sun'), { title: 'Enjoy the sun' });
  assert.deepEqual(p('Brunch on sun'), { title: 'Brunch', day: '2026-10-04' });
  assert.deepEqual(p('Drive to work'), { title: 'Drive to work' });
  assert.deepEqual(p('Slides for work'), { title: 'Slides', area: 'Work' });
  assert.deepEqual(p('Set the heating too low'), { title: 'Set the heating too low' });
  assert.deepEqual(p('Run for 45m'), { title: 'Run', est: 45 });
  assert.deepEqual(p('Support 24/7'), { title: 'Support 24/7' });
  assert.deepEqual(p('Book #“Bokaro trip”'), { title: 'Book', project: 'Bokaro trip' }, 'curly quotes from the iPhone keyboard');
});
