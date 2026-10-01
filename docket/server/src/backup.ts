// Backups: consistent snapshots of the SQLite file (VACUUM INTO), retention, a JSON
// export, and a restore that runs before the database is opened.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export type Label = 'hourly' | 'pre-migration' | 'pre-restore' | 'pre-reset' | 'manual';

/** Writes a consistent copy of the open database to `dir` and returns its path. */
export function snapshot(db: DatabaseSync, dir: string, label: Label = 'hourly', at = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `docket-${stamp(at)}-${label}.db`);
  if (existsSync(file)) unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

export interface SnapshotInfo { file: string; label: string; at: Date; bytes: number }

export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(f => {
      const m = /^docket-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z-]+)\.db$/.exec(f);
      if (!m) return null;
      const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return { file: join(dir, f), label: m[7], at, bytes: statSync(join(dir, f)).size };
    })
    .filter((x): x is SnapshotInfo => !!x)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Keeps every snapshot from the last 48 hours, then one per day for 30 days,
 * and any pre-migration / pre-restore / pre-reset / manual copy for 30 days.
 */
export function prune(dir: string, now = new Date()): string[] {
  const dayMs = 864e5;
  const removed: string[] = [];
  const keptDays = new Set<string>();
  for (const s of listSnapshots(dir)) {
    const age = now.getTime() - s.at.getTime();
    const day = s.at.toDateString();
    let keep: boolean;
    if (age > 30 * dayMs) keep = false;
    else if (s.label !== 'hourly') keep = true;
    else if (age <= 2 * dayMs) keep = true;
    else { keep = !keptDays.has(day); }
    if (keep) { if (s.label === 'hourly') keptDays.add(day); }
    else { unlinkSync(s.file); removed.push(s.file); }
  }
  return removed;
}

const TABLES = ['tasks', 'steps', 'moves', 'held_requests', 'pending_requests', 'usage', 'call_log', 'settings', 'reviews', 'emails', 'finds', 'meta'];

/** Every table as plain JSON, for a human-readable backup or a move to another store. */
export function exportJson(db: DatabaseSync) {
  const out: Record<string, unknown> = {
    format: 'docket-export', exported_at: new Date().toISOString(),
    schema_version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  };
  for (const t of TABLES) {
    try { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { out[t] = []; }
  }
  return out;
}

/** Opens a snapshot read-only and checks it is a sane Docket database. */
export function checkSnapshot(file: string): { ok: boolean; tasks: number; schema_version: number; problem?: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') return { ok: false, tasks: 0, schema_version: 0, problem: 'integrity_check: ' + integrity };
    const tasks = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
    const schema_version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    return { ok: true, tasks, schema_version };
  } catch (e) {
    return { ok: false, tasks: 0, schema_version: 0, problem: e instanceof Error ? e.message : String(e) };
  } finally {
    db?.close();
  }
}

/**
 * Replaces the live database file with a snapshot. Must run before the database is
 * opened. The old file is moved aside, never deleted.
 */
export function restore(dbPath: string, snapshotFile: string): { moved_aside: string | null; tasks: number } {
  const check = checkSnapshot(snapshotFile);
  if (!check.ok) throw new Error(`Refusing to restore ${snapshotFile}: ${check.problem}`);
  let movedAside: string | null = null;
  if (existsSync(dbPath)) {
    movedAside = `${dbPath}.before-restore-${stamp()}`;
    renameSync(dbPath, movedAside);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, `${movedAside ?? dbPath}${suffix}.before-restore-${stamp()}`);
  }
  copyFileSync(snapshotFile, dbPath);
  return { moved_aside: movedAside, tasks: check.tasks };
}

export const snapshotName = (file: string) => basename(file);
