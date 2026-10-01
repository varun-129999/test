import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server's package.json version, shown by /healthz and get_usage so a deploy can be confirmed. */
export const version: string = (() => {
  try { return JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version ?? '0'; } catch { return '0'; }
})();
