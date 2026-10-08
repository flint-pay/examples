// Preload for run-owned app processes. Responses and authentication stay in the app.
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory } from './private-files.ts';
import { invariant } from './safe.ts';
import { auditedFetch } from './audit-transport.ts';

const directory = await privateDirectory(process.env.E2E_APP_AUDIT_DIR ?? '');
const app = process.env.E2E_APP_AUDIT_NAME, run = process.env.E2E_RUN_ID, sandbox = process.env.E2E_APP_AUDIT_SANDBOX;
invariant(['storefrontA', 'storefrontB', 'accountA'].includes(app ?? '') && run && ['A', 'B'].includes(sandbox ?? ''), 'APP_AUDIT_CONFIG_REQUIRED');
const file = join(directory, `app-audit-${app}.jsonl`);
try { const info = await lstat(file); invariant(!info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'APP_AUDIT_FILE_PERMISSIONS'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const handle = await open(file, 'a', 0o600);
let queue = Promise.resolve();
const append = (entry: Record<string, unknown>): Promise<void> => {
  queue = queue.then(async () => {
    await handle.write(`${JSON.stringify({ schema_version: 1, run, app, sandbox, timestamp: Date.now(), ...entry })}\n`);
    await handle.sync();
  });
  return queue;
};
await append({ kind: 'READY' });
globalThis.fetch = auditedFetch(globalThis.fetch, append);
