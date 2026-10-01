#!/usr/bin/env node
// HTTP entry: remote MCP at /mcp, REST API at /api, and the web app.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, openStore, version } from './config.js';
import { createApp } from './http.js';
import { checkTimeZone } from './dates.js';
import { listSnapshots, prune, restore, snapshot } from './backup.js';
import { SCHEMA_VERSION } from './db.js';

const log = (msg: string) => console.log(`[docket] ${msg}`);
const fail = (msg: string): never => { console.error(`[docket] ${msg}`); process.exit(1); };

const host = config.host || (config.token ? '0.0.0.0' : '127.0.0.1');
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!config.token && !local) fail('Refusing to listen on ' + host + ' without DOCKET_TOKEN. Set a long random token (openssl rand -hex 32).');

// Time zone: "today" and the weekly reset depend on it, and a typo silently means UTC.
const tz = checkTimeZone(process.env.TZ);
if (!tz.ok) fail(tz.problem!);
if (tz.problem) log(tz.problem);

// Persistence: a missing disk mount would quietly create a fresh database that the next deploy wipes.
if (config.requireDisk && config.dbPath !== ':memory:') {
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) fail(`DOCKET_REQUIRE_DISK=1 but ${dir} does not exist. Mount the persistent disk there.`);
  if (statSync(dir).dev === statSync('/').dev) fail(`DOCKET_REQUIRE_DISK=1 but ${dir} is on the container's own filesystem, not a mounted disk. Data written there is lost on redeploy.`);
}

// One-time restore from a snapshot, before the database is opened.
if (config.restoreFrom) {
  const marker = config.dbPath + '.restored-from';
  const already = existsSync(marker) && readFileSync(marker, 'utf8') === config.restoreFrom;
  if (already) log(`DOCKET_RESTORE_FROM is still set but ${config.restoreFrom} was already restored; ignoring. Unset the variable.`);
  else {
    const r = restore(config.dbPath, config.restoreFrom);
    writeFileSync(marker, config.restoreFrom);
    log(`restored ${config.restoreFrom} (${r.tasks} tasks); previous database kept at ${r.moved_aside ?? '(none)'}`);
  }
}

const { store, created, migrated_from, tasks } = openStore();
if (created) log(`CREATED NEW EMPTY DATABASE at ${config.dbPath}`);
else log(`opened existing database (${tasks} tasks, schema v${SCHEMA_VERSION}${migrated_from < SCHEMA_VERSION ? `, upgraded from v${migrated_from}` : ''}, created ${store.meta('created_at') ?? 'unknown'})`);
log(`version ${version}, TZ ${process.env.TZ || '(unset)'} (${tz.resolved}), today ${store.today()}`);

// Hourly snapshots on the same disk, with retention. Off-site copies pull /api/backup.
if (config.backupDir && config.dbPath !== ':memory:') {
  const run = () => {
    try {
      const file = snapshot(store.db, config.backupDir, 'hourly');
      const removed = prune(config.backupDir);
      log(`snapshot ${file}${removed.length ? `, pruned ${removed.length}` : ''}`);
    } catch (e) {
      console.error('[docket] snapshot failed', e);
    }
  };
  const latest = listSnapshots(config.backupDir)[0];
  if (!latest || Date.now() - latest.at.getTime() > 3600e3) run();
  setInterval(run, 3600e3).unref();
}

// The stdio MCP server may write to the same database from another process;
// notice its commits so open apps refresh.
let dataVersion = (store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
const poll = setInterval(() => {
  const v = (store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  if (v !== dataVersion) { dataVersion = v; store.events.emit('change'); }
}, 1500);
poll.unref();

const app = createApp(store, { token: config.token, webDir: config.webDir, backupDir: config.backupDir, version });
const server = app.listen(config.port, host, () => {
  log(`listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${config.port}`);
  log(`MCP endpoint: /mcp${config.token ? '  (auth: Bearer token, ?token= or /mcp/<token>)' : '  (no auth, local only)'}`);
});

// Node runs as PID 1 in the container, where SIGTERM has no default handler: without
// this, every deploy waits for SIGKILL and the WAL is left un-checkpointed.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  clearInterval(poll);
  store.events.emit('shutdown');
  server.close(() => {
    try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.db.close(); } catch (e) { console.error(e); }
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 1000).unref();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
