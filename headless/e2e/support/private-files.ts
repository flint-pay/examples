import { mkdir, realpath, stat, open, rename, readFile, chmod } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant } from './safe.ts';

export const checkoutRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export async function privateDirectory(path: string): Promise<string> {
  invariant(isAbsolute(path), 'PRIVATE_DIRECTORY_ABSOLUTE_REQUIRED');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const actual = await realpath(path);
  const rel = relative(await realpath(checkoutRoot), actual);
  invariant(rel.startsWith('..') && !isAbsolute(rel), 'PRIVATE_DIRECTORY_OUTSIDE_CHECKOUT_REQUIRED');
  const info = await stat(actual);
  invariant(info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'PRIVATE_DIRECTORY_PERMISSIONS');
  return actual;
}
export async function writePrivate(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, JSON.stringify(value, null, 2) + '\n');
}
export async function writePrivateText(path: string, value: string): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function readPrivate<T>(path: string): Promise<T> {
  return JSON.parse(await readPrivateText(path)) as T;
}
export async function readPrivateText(path: string): Promise<string> {
  const actual = await realpath(path);
  await privateDirectory(dirname(actual));
  const info = await stat(actual);
  invariant(info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'PRIVATE_FILE_PERMISSIONS');
  return readFile(actual, 'utf8');
}
