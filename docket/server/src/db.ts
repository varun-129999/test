import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
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

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
