import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askClaude, parseQuickAdd } from '../src/quick.js';
import './helpers.js';

const T = '2026-10-01'; // a Thursday
const q = (text: string, today = T) => parseQuickAdd(text, today);

test('plain text is the title; only the fields found are returned', () => {
  assert.deepEqual(q('Groceries'), { title: 'Groceries' });
  assert.deepEqual(q('  Buy   milk  '), { title: 'Buy milk' });
  assert.deepEqual(q('Read 2 chapters'), { title: 'Read 2 chapters' });
  assert.deepEqual(q('tomorrow 30m'), { title: '', day: '2026-10-02', est: 30 });
});

test('durations: 45m, 1h, 1h30, 1.5h, 90 min, for 20m', () => {
  const cases: [string, number][] = [
    ['Call 45m', 45], ['Deck 1h', 60], ['Deck 1h30', 90], ['Deck 1h30m', 90], ['Deck 1.5h', 90], ['Deck 2 hours', 120],
    ['Call 90 min', 90], ['Call 20 minutes', 20], ['Walk for 20m', 20], ['Call 25mins', 25],
  ];
  for (const [text, est] of cases) assert.equal(q(text).est, est, text);
  assert.equal(q('Walk for 20m').title, 'Walk');
  assert.equal(q('Marathon 30h').est, 1800, 'the caller clamps');
});

test('#project, quoted (straight or curly), and #area', () => {
  assert.deepEqual(q('Plan seating #Wedding'), { title: 'Plan seating', project: 'Wedding' });
  assert.deepEqual(q('Book hotel #"Bokaro trip" fri'), { title: 'Book hotel', project: 'Bokaro trip', day: '2026-10-02' });
  assert.equal(q('Book hotel #“Bokaro trip”').project, 'Bokaro trip');
  assert.deepEqual(q('Fix laptop #work'), { title: 'Fix laptop', area: 'Work' });
  assert.deepEqual(q('Gym #Health #Fitness'), { title: 'Gym', area: 'Health', project: 'Fitness' });
  assert.equal(q('Q4 #Planning.').project, 'Planning');
});

test('days: today, tomorrow, tmrw, weekday names (1 to 7 days ahead), next mon, next week', () => {
  const cases: [string, string][] = [
    ['Pay rent today', T], ['Pay rent tomorrow', '2026-10-02'], ['Pay rent tmrw', '2026-10-02'],
    ['Gym fri', '2026-10-02'], ['Gym Friday', '2026-10-02'], ['Gym mon', '2026-10-05'], ['Standup thu', '2026-10-08'],
    ['Gym next mon', '2026-10-05'], ['Review next fri', '2026-10-09'], ['Offsite next week', '2026-10-05'],
    ['Brunch on sun', '2026-10-04'], ['Brunch this sat', '2026-10-03'], ['Gym sunday', '2026-10-04'],
  ];
  for (const [text, day] of cases) assert.equal(q(text).day, day, text);
  assert.equal(q('Gym next mon', '2026-10-04').day, '2026-10-05', 'from a Sunday, next week starts tomorrow');
});

test('days: in 3 days, in 2 weeks, 15 oct, oct 15, 15/10, 2026-10-15; past dates roll to next year', () => {
  const cases: [string, string | undefined][] = [
    ['Dentist in 3 days', '2026-10-04'], ['Passport in 2 weeks', '2026-10-15'], ['Passport in a week', '2026-10-08'],
    ['Party 15 oct', '2026-10-15'], ['Party oct 15', '2026-10-15'], ['Party 15th October', '2026-10-15'], ['Party on 15 oct', '2026-10-15'],
    ['Party 15/10', '2026-10-15'], ['Party 15/10/27', '2027-10-15'], ['Party 2026-10-15', '2026-10-15'],
    ['Taxes 15 sep', '2027-09-15'], ['Party 31/02', undefined], ['Party 2026-02-30', undefined],
  ];
  for (const [text, day] of cases) assert.equal(q(text).day, day, text);
  assert.equal(q('Party 31/02').title, 'Party 31/02', 'not a real date: it stays in the title');
  assert.equal(q('New year 1 jan', '2026-12-31').day, '2027-01-01');
});

test('ordinary words that look like days stay in the title', () => {
  assert.deepEqual(q('Enjoy the sun'), { title: 'Enjoy the sun' });
  assert.deepEqual(q('Gym sat'), { title: 'Gym sat' });
  assert.deepEqual(q('24/7 support rota'), { title: '24/7 support rota' });
});

test('due <date> sets due, not day', () => {
  assert.deepEqual(q('Report due fri'), { title: 'Report', due: '2026-10-02' });
  assert.deepEqual(q('Report due 20 oct'), { title: 'Report', due: '2026-10-20' });
  assert.deepEqual(q('Report mon due wed'), { title: 'Report', day: '2026-10-05', due: '2026-10-07' });
  assert.equal(q('Report due next week').due, '2026-10-05');
});

test('times: at 5pm, 5:30pm, at 17:00, @ 9am, 12am, 12pm', () => {
  const cases: [string, string][] = [
    ['Call at 5pm', '17:00'], ['Call 5:30pm', '17:30'], ['Call at 5 pm', '17:00'], ['Call at 17:00', '17:00'], ['Call 17:30', '17:30'],
    ['Standup @ 9am', '09:00'], ['Standup @9am', '09:00'], ['Pills 12am', '00:00'], ['Lunch at 12pm', '12:00'], ['Call 9:05AM', '09:05'],
  ];
  for (const [text, at] of cases) assert.equal(q(text).at, at, text);
  assert.equal(q('Call at 5pm').title, 'Call');
  assert.deepEqual(q('Call Sam at 5:30 p.m. tomorrow'), { title: 'Call Sam', day: '2026-10-02', at: '17:30' }, 'iOS dictation');
  assert.equal(q('Dentist at 9 A.M.').at, '09:00');
  assert.equal(q('Call 13pm').at, undefined);
  assert.equal(q('Score 3:1').at, undefined);
});

test('priority: p1-p3 anywhere, !high anywhere, high/med/low only as the last word', () => {
  assert.equal(q('Pay bill p1').priority, 'high');
  assert.equal(q('P2 pay bill').priority, 'med');
  assert.equal(q('Pay bill p3').priority, 'low');
  assert.deepEqual(q('Pay bill !low tomorrow'), { title: 'Pay bill', day: '2026-10-02', priority: 'low' });
  assert.deepEqual(q('Pay bill high'), { title: 'Pay bill', priority: 'high' });
  assert.equal(q('Pay bill medium').priority, 'med');
  assert.deepEqual(q('High tea with Sam'), { title: 'High tea with Sam' });
  assert.deepEqual(q('Turn the heating too low'), { title: 'Turn the heating too low' });
  assert.deepEqual(q('high'), { title: 'high' }, 'a lone word is the title');
});

test('energy and area', () => {
  assert.deepEqual(q('Run high energy'), { title: 'Run', energy: 'high' });
  assert.deepEqual(q('Inbox low energy high'), { title: 'Inbox', priority: 'high', energy: 'low' });
  assert.deepEqual(q('Stretch health'), { title: 'Stretch', area: 'Health' });
  assert.deepEqual(q('Call mum Personal'), { title: 'Call mum', area: 'Personal' });
  assert.deepEqual(q('Slides for work'), { title: 'Slides', area: 'Work' });
  assert.deepEqual(q('Drive to work'), { title: 'Drive to work' });
});

test('repeats: daily, weekdays, weekly, every mon,thu, every 2 weeks, monthly, monthly 25, every 3 months', () => {
  const cases: [string, string][] = [
    ['Water plants daily', 'daily'], ['Vitamins every day', 'daily'], ['Standup weekdays', 'weekdays'], ['Standup every weekday', 'weekdays'],
    ['Review weekly', 'weekly:Thu'], ['Review weekly fri', 'weekly:Fri'], ['Review every week', 'weekly:Thu'],
    ['Gym every mon,thu', 'weekly:Mon,Thu'], ['Gym every thu, mon', 'weekly:Mon,Thu'], ['Gym every mon and thu', 'weekly:Mon,Thu'], ['Gym every Sat', 'weekly:Sat'],
    ['Clean every 2 weeks', 'every:2:weeks'], ['Water every 3 days', 'every:3:days'], ['Haircut every 3 months', 'every:3:months'],
    ['Rent monthly', 'monthly:1'], ['Rent monthly 25', 'monthly:25'], ['Rent every month on the 25th', 'monthly:25'], ['Rent every month on 25', 'monthly:25'],
  ];
  for (const [text, repeat] of cases) assert.equal(q(text).repeat, repeat, text);
  assert.equal(q('Gym every mon,thu').day, undefined, 'a rule does not move the first one');
  assert.equal(q('Rent monthly', '2026-12-31').repeat, 'monthly:31');
  assert.deepEqual(q('Water every 3 days after done'), { title: 'Water', repeat: 'every:3:days', repeat_from: 'done' });
  assert.equal(q('Haircut every 6 weeks from done').repeat_from, 'done');
  assert.deepEqual(q('Daily standup notes'), { title: 'standup notes', repeat: 'daily' }, 'any order: the word counts wherever it is');
});

test('links, punctuation, case, and everything at once', () => {
  assert.deepEqual(q('Read https://example.com/a?b=1 tomorrow'), { title: 'Read', day: '2026-10-02', link: 'https://example.com/a?b=1' });
  assert.equal(q('Check https://example.com/x.').link, 'https://example.com/x');
  assert.deepEqual(q('Call bank, tomorrow.'), { title: 'Call bank', day: '2026-10-02' });
  assert.deepEqual(q('PAY RENT TOMORROW P1'), { title: 'PAY RENT', day: '2026-10-02', priority: 'high' });
  assert.deepEqual(q('Call Sam fri at 5pm 45m #Wedding p1 weekly'),
    { title: 'Call Sam', project: 'Wedding', day: '2026-10-02', at: '17:00', est: 45, priority: 'high', repeat: 'weekly:Fri' });
  assert.deepEqual(q('Q4 planning 17:30 2h work high due mon'),
    { title: 'Q4 planning', area: 'Work', due: '2026-10-05', at: '17:30', est: 120, priority: 'high' });
});

test('the shared fixture (replayed by the web app too) matches this parser', () => {
  const cases = JSON.parse(readFileSync(new URL('../../shared/quick-cases.json', import.meta.url), 'utf8')) as { text: string; today: string; expect: object }[];
  assert.ok(cases.length >= 40);
  for (const c of cases) assert.deepEqual(parseQuickAdd(c.text, c.today), c.expect, c.text);
  // Every grammar rule appears in the fixture.
  const has = (f: string) => cases.some(c => f in c.expect);
  for (const f of ['area', 'project', 'day', 'due', 'at', 'est', 'priority', 'energy', 'repeat', 'repeat_from', 'link']) assert.ok(has(f), f);
});

test('askClaude: the prefixes that turn a capture into a request', () => {
  assert.equal(askClaude('ask Claude to plan my week'), 'plan my week');
  assert.equal(askClaude('Ask claude: what is due'), 'what is due');
  assert.equal(askClaude('claude, draft a reply to Sam'), 'draft a reply to Sam');
  assert.equal(askClaude('Claude: summarise'), 'summarise');
  assert.equal(askClaude('ask claude'), '');
  assert.equal(askClaude('Call Claude about the lease'), null);
  assert.equal(askClaude('Claudette birthday'), null);
  assert.equal(askClaude('ask claudette'), null);
});
