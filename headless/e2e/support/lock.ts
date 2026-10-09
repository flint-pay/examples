import { open, mkdir, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, invariant } from './safe.ts';
import { privateDirectory, readPrivate } from './private-files.ts';
import type { Config } from './config.ts';

const heldLocks = new Map<string, Awaited<ReturnType<typeof open>>>();
export async function acquirePairLock(config: Config): Promise<() => Promise<void>> {
  const root = `/tmp/flint-headless-e2e-${process.getuid?.()}`; await mkdir(root, { mode: 0o700, recursive: true });
  await privateDirectory(root);
  const file = join(root, `${digest(Object.values(config.pins).map(p => [p.merchantId, p.sandboxId]).sort()).slice(0, 32)}.lock`);
  let handle;
  try { handle = await open(file, 'wx', 0o600); } catch { invariant(false, 'SANDBOX_PAIR_ALREADY_LOCKED'); }
  await handle!.writeFile(JSON.stringify({ run: config.run, pid: process.pid })); await handle!.sync();
  heldLocks.set(file, handle!);
  return async () => { heldLocks.delete(file); await handle!.close(); await unlink(file); };
}

export async function assertPairLock(config: Config): Promise<void> {
  const root = `/tmp/flint-headless-e2e-${process.getuid?.()}`;
  const file = join(root, `${digest(Object.values(config.pins).map(p => [p.merchantId, p.sandboxId]).sort()).slice(0, 32)}.lock`);
  const handle = heldLocks.get(file); invariant(handle, 'REVIEWED_SOURCE_CHECKOUT_REQUIRED');
  const [pathInfo, descriptor] = await Promise.all([lstat(file), handle.stat()]);
  invariant(!pathInfo.isSymbolicLink() && pathInfo.dev === descriptor.dev && pathInfo.ino === descriptor.ino, 'REVIEWED_SOURCE_CHECKOUT_REQUIRED');
  const lock = await readPrivate<{run: string; pid: number}>(file);
  invariant(lock.run === config.run && lock.pid === process.pid, 'REVIEWED_SOURCE_CHECKOUT_REQUIRED');
}
