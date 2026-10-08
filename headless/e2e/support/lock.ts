import { open, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, invariant } from './safe.ts';
import { privateDirectory } from './private-files.ts';
import type { Config } from './config.ts';

export async function acquirePairLock(config: Config): Promise<() => Promise<void>> {
  const root = `/tmp/flint-headless-e2e-${process.getuid?.()}`; await mkdir(root, { mode: 0o700 });
  await privateDirectory(root);
  const file = join(root, `${digest(Object.values(config.pins).map(p => [p.merchantId, p.sandboxId]).sort()).slice(0, 32)}.lock`);
  let handle;
  try { handle = await open(file, 'wx', 0o600); } catch { invariant(false, 'SANDBOX_PAIR_ALREADY_LOCKED'); }
  await handle!.writeFile(JSON.stringify({ run: config.run, pid: process.pid })); await handle!.sync();
  return async () => { await handle!.close(); await unlink(file); };
}
