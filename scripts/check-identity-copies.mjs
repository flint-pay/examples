import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function identityFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return identityFiles(join(directory, entry.name), path);
    if (!entry.isFile()) throw new Error('Identity modules must contain regular files only.');
    return [{ path, bytes: readFileSync(join(directory, entry.name)) }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function checkIdentityCopies(root = process.cwd()) {
  const storefront = identityFiles(join(root, 'headless/storefront/src/identity'));
  const account = identityFiles(join(root, 'headless/account/src/identity'));
  if (!storefront.length || storefront.length !== account.length || storefront.some((file, index) =>
    file.path !== account[index].path || !file.bytes.equals(account[index].bytes))) {
    throw new Error('Storefront and account identity modules must match byte for byte.');
  }
  return storefront.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(`Identity copies match across ${checkIdentityCopies()} files.`); }
  catch (error) { console.error(error.code ? 'Both example identity modules are required.' : error.message); process.exitCode = 1; }
}
