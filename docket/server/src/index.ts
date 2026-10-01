#!/usr/bin/env node
// HTTP entry: remote MCP at /mcp, REST API at /api, and the web app.
import { config, openStore } from './config.js';
import { createApp } from './http.js';

const host = config.host || (config.token ? '0.0.0.0' : '127.0.0.1');
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!config.token && !local) {
  console.error('Refusing to listen on ' + host + ' without DOCKET_TOKEN. Set a long random token (openssl rand -hex 32).');
  process.exit(1);
}

const store = openStore();

// The stdio MCP server may write to the same database from another process;
// notice its commits so open apps refresh.
let version = (store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
setInterval(() => {
  const v = (store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  if (v !== version) { version = v; store.events.emit('change'); }
}, 1500).unref();
createApp(store, { token: config.token, webDir: config.webDir }).listen(config.port, host, () => {
  console.log(`Docket on http://${host === '0.0.0.0' ? 'localhost' : host}:${config.port}  (db ${config.dbPath})`);
  console.log(`MCP endpoint: /mcp${config.token ? '  (auth: Bearer token, ?token= or /mcp/<token>)' : '  (no auth, local only)'}`);
});
