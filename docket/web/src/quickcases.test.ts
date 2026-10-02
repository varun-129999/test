// Replays shared/quick-cases.json (written with the server's parser) against the web parser,
// so the composer's preview and POST /api/quick read the same text the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseQuickAdd } from './quick';

const file = fileURLToPath(new URL('../../shared/quick-cases.json', import.meta.url));
const cases: { text: string; today: string; expect: Record<string, unknown> }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

test('shared quick-add cases match the server parser', { skip: existsSync(file) ? false : `no fixture at ${file} yet (the server build writes it)` }, () => {
  assert.ok(cases.length > 0, 'the fixture is empty');
  for (const c of cases) assert.deepEqual({ ...parseQuickAdd(c.text, c.today) }, c.expect, `${JSON.stringify(c.text)} on ${c.today}`);
});
