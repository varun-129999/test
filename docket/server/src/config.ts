import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openDb } from './db.js';
import { Store } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));

export const config = {
  dbPath: process.env.DOCKET_DB || resolve(here, '../data/docket.db'),
  token: process.env.DOCKET_TOKEN || '',
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '',
  webDir: process.env.WEB_DIR || resolve(here, '../../web/dist'),
  sample: process.env.DOCKET_SAMPLE === '1',
};

export function openStore() {
  const store = new Store(openDb(config.dbPath));
  const empty = (store.db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n === 0;
  if (config.sample && empty) store.loadSample();
  return store;
}
