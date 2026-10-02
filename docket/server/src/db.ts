import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { snapshot } from './backup.js';

// Version 1 is the baseline schema. Later versions are migrations in MIGRATIONS below:
// they only ever add (columns, tables, indexes), so an older snapshot can always be upgraded.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('Work','Personal','Health')),
  project TEXT,
  day TEXT NOT NULL,
  due TEXT,
  est_min INTEGER NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high','med','low')),
  energy TEXT NOT NULL CHECK (energy IN ('high','low')),
  done INTEGER NOT NULL DEFAULT 0,
  source TEXT CHECK (source IN ('gmail') OR source IS NULL),
  draft TEXT,
  gmail_draft_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);

CREATE TABLE IF NOT EXISTS steps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, idx)
);

CREATE TABLE IF NOT EXISTS moves (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_day TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','skipped')),
  created_at TEXT NOT NULL
);

-- Requests the budget guard stopped. tool/args hold the content Claude already
-- produced, so "Run anyway" can apply it without another Claude call.
CREATE TABLE IF NOT EXISTS held_requests (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_id TEXT,
  priority TEXT NOT NULL DEFAULT 'med',
  tool TEXT,
  args TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','dropped'))
);

-- Requests queued from the UI for Claude to pick up with get_pending_requests.
CREATE TABLE IF NOT EXISTS pending_requests (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_id TEXT,
  priority TEXT NOT NULL DEFAULT 'high',
  override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  reply TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  period_start TEXT PRIMARY KEY,
  used_pct INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  est_calls REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  weight REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capacity_hours REAL NOT NULL DEFAULT 6,
  reserve_pct INTEGER NOT NULL DEFAULT 20,
  high_only INTEGER NOT NULL DEFAULT 1,
  week_start TEXT NOT NULL DEFAULT 'monday',
  reset TEXT NOT NULL DEFAULT 'Mon 09:00',
  pct_per_call REAL NOT NULL DEFAULT 0.3,
  claude_url TEXT NOT NULL DEFAULT 'https://claude.ai/new'
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS reviews (
  week_start TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);

-- Emails Claude read with its own Gmail connector, and the tasks it suggested from them.
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  received TEXT NOT NULL DEFAULT '',
  thread_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY,
  email_id TEXT,
  title TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'Work',
  project TEXT,
  due TEXT,
  est_min INTEGER NOT NULL DEFAULT 30,
  priority TEXT NOT NULL DEFAULT 'med',
  energy TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','added','skipped')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/** ALTER TABLE ADD COLUMN unless it is already there, so a migration can be re-run safely. */
function addColumn(db: DatabaseSync, table: string, def: string) {
  const name = def.split(' ')[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}

const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v1: the baseline. Idempotent, so a database made before versioning upgrades cleanly.
  db => db.exec(SCHEMA_V1),
  // v2: notes, links and results on tasks; outcomes and read state on requests; where a
  // usage figure came from; weekly plans.
  db => {
    for (const [table, col] of [
      ['tasks', 'notes TEXT'], ['tasks', 'link TEXT'], ['tasks', 'completed_at TEXT'], ['tasks', 'result TEXT'],
      ['tasks', 'result_url TEXT'], ['tasks', 'result_at TEXT'], ['pending_requests', 'outcome TEXT'],
      ['pending_requests', 'detail TEXT'], ['pending_requests', 'seen INTEGER NOT NULL DEFAULT 0'], ['usage', 'source TEXT'],
    ]) addColumn(db, table, col);
    db.exec(`
      CREATE INDEX IF NOT EXISTS pending_requests_status ON pending_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS held_requests_status ON held_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS tasks_done_day ON tasks(done, day);
      CREATE TABLE IF NOT EXISTS week_plans (
        week_start TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- Requests finished before this version are old news, not "Claude finished N things";
      -- a done task's last edit is the best guess at when it was completed.
      UPDATE pending_requests SET seen = 1 WHERE status != 'pending';
      UPDATE tasks SET completed_at = updated_at WHERE done = 1 AND completed_at IS NULL;
    `);
  },
  // v3: where a task came from (a chat, a Cowork or Claude Code session, an email), so
  // "Give to Claude" can continue there instead of carrying the context in notes.
  db => {
    for (const col of ['origin_kind TEXT', 'origin_title TEXT', 'origin_url TEXT']) addColumn(db, 'tasks', col);
  },
  // v4: a time of day ("HH:MM", local) and recurring tasks: the rule, what the next one counts
  // from ('planned' or 'done', checked in schemas.ts), and the series the instances share.
  db => {
    for (const col of ['at TEXT', 'repeat TEXT', `repeat_from TEXT NOT NULL DEFAULT 'planned'`, 'series_id TEXT']) addColumn(db, 'tasks', col);
    db.exec('CREATE INDEX IF NOT EXISTS tasks_series ON tasks(series_id)');
  },
  // v5: soft delete. A deleted task keeps its row (and steps) with deleted_at set, so it can be
  // restored; every read filters it out, and rows deleted over 30 days ago are purged hourly.
  db => {
    addColumn(db, 'tasks', 'deleted_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS tasks_deleted ON tasks(deleted_at)');
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export type DB = DatabaseSync;

export const userVersion = (db: DB) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

export interface OpenResult { db: DB; created: boolean; migrated_from: number }

export function openDb(path: string): DB { return openDbInfo(path).db; }

/** Opens (or creates) the database and brings its schema up to date. */
export function openDbInfo(path: string): OpenResult {
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const created = memory || !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const from = userVersion(db);
  if (from > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database ${path} is schema version ${from}, newer than this build (${SCHEMA_VERSION}). Deploy a newer Docket or restore an older snapshot.`);
  }
  if (from < SCHEMA_VERSION) {
    // A real upgrade of an existing file: keep a copy first. A file at version 0 is one the
    // pre-versioning build wrote, so it counts too.
    if (!created) snapshot(db, dirname(path) + '/backups', 'pre-migration');
    for (let v = from; v < SCHEMA_VERSION; v++) {
      tx(db, () => {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }
  return { db, created, migrated_from: from };
}

// Re-entrant transactions: the outermost call opens BEGIN IMMEDIATE, inner calls use
// savepoints, so store methods can call each other without "cannot start a transaction".
const depth = new WeakMap<DatabaseSync, number>();

export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT sp${d}`);
  depth.set(db, d + 1);
  try {
    const out = fn();
    if (d === 0) db.exec('COMMIT');
    else db.exec(`RELEASE sp${d}`);
    return out;
  } catch (e) {
    if (d === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO sp${d}; RELEASE sp${d}`);
    throw e;
  } finally {
    depth.set(db, d);
  }
}
