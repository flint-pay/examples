import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '../support/config.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';
import { validateRegistry, rows } from '../scenarios/registry.ts';

async function main() {
  validateRegistry();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  invariant(pkg.dependencies['@flintpay/node'] === SDK_VERSION && lock.packages['node_modules/@flintpay/node'].version === SDK_VERSION, 'SDK_EXACT_PIN_REQUIRED');
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.runs'].includes(item.name) || item.name.startsWith('.env') && item.name !== '.env.example') continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (/\.(ts|json|md)$/.test(path)) {
        const text = await readFile(path, 'utf8'); invariant(!/[\u2013\u2014]/.test(text), 'PUNCTUATION_CONTRACT');
        if (path !== fileURLToPath(import.meta.url)) invariant(!/recordVideo|recordHar|tracing\.start|\.screenshot\(|storageState\(/.test(text), 'RAW_BROWSER_ARTIFACTS_FORBIDDEN');
      }
    }
  };
  await walk(root); emit({ event: 'HARNESS_STATIC_CHECK_PASS', count: rows.length });
}
main().catch(e => { emit({ event: 'HARNESS_STATIC_CHECK_FAIL', code: safeFailure(e) }); process.exitCode = 1; });
