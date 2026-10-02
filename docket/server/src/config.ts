import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDbInfo } from './db.js';
import { Store } from './store.js';
export { version } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DOCKET_DB || resolve(here, '../data/docket.db');

export const config = {
  dbPath,
  /** Where hourly snapshots go. Defaults to a backups/ folder next to the database. */
  backupDir: process.env.DOCKET_BACKUP_DIR || (dbPath === ':memory:' ? '' : join(dirname(dbPath), 'backups')),
  token: process.env.DOCKET_TOKEN || '',
  /** Optional second token that can only add tasks (POST /api/quick), for Apple Shortcuts and Siri. */
  captureToken: process.env.DOCKET_CAPTURE_TOKEN || '',
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '',
  webDir: process.env.WEB_DIR || resolve(here, '../../web/dist'),
  /** Allows the sample-data reset (and loads samples into an empty database). Never set in production. */
  sample: process.env.DOCKET_SAMPLE === '1',
  /** Refuse to start unless the database directory is a mounted disk, not the container's own filesystem. */
  requireDisk: process.env.DOCKET_REQUIRE_DISK === '1',
  /** Path of a snapshot to restore at boot (once). */
  restoreFrom: process.env.DOCKET_RESTORE_FROM || '',
};

export function openStore() {
  const { db, created, migrated_from } = openDbInfo(config.dbPath);
  const store = new Store(db, { flags: { sample: config.sample } });
  const tasks = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
  if (created) store.setMeta({ created_at: new Date().toISOString() });
  if (config.sample && tasks === 0) store.loadSample();
  return { store, created, migrated_from, tasks };
}
