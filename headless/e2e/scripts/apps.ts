import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../support/config.ts';
import { appEnvironment } from '../support/app-environment.ts';
import { loadFixtures } from '../support/fixtures.ts';
import { privateDirectory, checkoutRoot } from '../support/private-files.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { CredentialScanner } from '../support/credential-scan.ts';
import { spawnChild } from '../support/child.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';
import { verifySourceCheckout } from '../support/source.ts';
import { verifyApiBuild } from '../support/build.ts';

async function unused(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}
async function main() {
  invariant(process.argv.slice(2).length === 1 && process.argv[2] === '--apply', 'APPS_EXPLICIT_APPLY_REQUIRED');
  const config = loadConfig(process.env, true), fixtures = await loadFixtures(config), directory = await privateDirectory(config.privateDir);
  invariant(fixtures.values.serviceOwnership?.coordinated === true, 'PARENT_SERVICE_OWNERSHIP_HANDOFF_REQUIRED');
  verifySourceCheckout(config); await verifyApiBuild(config);
  const clients = new VerifiedClients(config, fixtures); await clients.verify('A'); await clients.verify('B');
  const scanner = new CredentialScanner([config.pins.A.key, config.pins.B.key, config.operatorPins.A.key, config.operatorPins.B.key]);
  const secret = process.env.E2E_WEBHOOK_SECRET ?? `whsec_${randomBytes(32).toString('base64')}`;
  const apps = [
    { name: 'storefrontA', app: 'storefront', sandbox: 'A' as const, origin: config.origins.storefrontA, identity: 'identity-a.sqlite', cookie: 'cedar_session' },
    { name: 'accountA', app: 'account', sandbox: 'A' as const, origin: config.origins.accountA, identity: 'identity-a.sqlite', cookie: 'cedar_session' },
    { name: 'storefrontB', app: 'storefront', sandbox: 'B' as const, origin: config.origins.storefrontB, identity: 'identity-b.sqlite', cookie: 'cedar_session_b' },
  ];
  for (const app of apps) {
    const url = new URL(app.origin); invariant(['localhost', '127.0.0.1'].includes(url.hostname), 'LOCAL_APP_LAUNCH_ONLY'); await unused(Number(url.port));
  }
  const children: ReturnType<typeof spawnChild>[] = [];
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const app of apps) {
      children.push(spawnChild(process.execPath, ['--import', join(checkoutRoot, 'headless/e2e/support/app-audit.ts'), join(checkoutRoot, 'headless', app.app, 'src/server.ts')], checkoutRoot, scanner, appEnvironment(config, fixtures, directory, secret, app)));
    }
    emit({ event: 'OWNED_APPS_STARTING', count: children.length });
    await Promise.race(children.map(child => new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => stopping && (code === 0 || code === null) ? resolve() : reject(new Error('owned child exited'))); })));
  } finally {
    stop(); const killTimer = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000);
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))));
    clearTimeout(killTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); scanner.assertClean(); emit({ event: 'OWNED_APPS_STOPPED' });
  }
}
main().catch(e => { emit({ event: 'APP_LAUNCH_FAILED', code: safeFailure(e) }); process.exitCode = 1; });
