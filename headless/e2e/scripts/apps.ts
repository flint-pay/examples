import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../support/config.ts';
import { appEnvironment } from '../support/app-environment.ts';
import { loadFixtures } from '../support/fixtures.ts';
import { privateDirectory, checkoutRoot, writePrivate } from '../support/private-files.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { CredentialScanner } from '../support/credential-scan.ts';
import {ChallengeLogCapture,serveChallengeLogScan} from '../support/challenge-hygiene.ts';
import { spawnChild } from '../support/child.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';
import { verifySourceCheckout } from '../support/source.ts';
import type { OwnedApps } from '../support/app-vault.ts';
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
  const logCapture=new ChallengeLogCapture(),closeLogScan=await serveChallengeLogScan(directory,config.run,config.targetCommit,logCapture);
  const children: ReturnType<typeof spawnChild>[] = [];
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const manifest: OwnedApps = { schema_version: 1, run: config.run, target_commit: config.targetCommit, launcher_pid: process.pid, private_dir_realpath: directory, children: [] };
  let scanQueue = Promise.resolve(), scanError = false;
  const writeScan = () => {
    scanQueue = scanQueue.then(() => writePrivate(join(directory, 'owned-apps-scan.json'), { run: config.run, updated_at: new Date().toISOString(), violation_surfaces: scanner.surfaces() })).catch(() => { scanError = true; stop(); });
  };
  const unsubscribe = scanner.onChange(writeScan); writeScan();
  const scanTimer = setInterval(writeScan, 5000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const app of apps) {
      const child = spawnChild(process.execPath, ['--import', join(checkoutRoot, 'headless/e2e/support/app-audit.ts'), join(checkoutRoot, 'headless', app.app, 'src/server.ts')], checkoutRoot, scanner, appEnvironment(config, fixtures, directory, secret, app),(stream,chunk)=>logCapture.capture(app.name,stream,chunk));
      children.push(child); invariant(child.pid, 'OWNED_APP_PROCESS_REQUIRED');
      manifest.children.push({ name: app.name, pid: child.pid, port: Number(new URL(app.origin).port), origin: app.origin, artifact_id: config.builds[app.name], identity_file: app.identity, app_database_file: `${app.name}.sqlite` });
      await writePrivate(join(directory, 'owned-apps.json'), manifest);
    }
    emit({ event: 'OWNED_APPS_STARTING', count: children.length });
    await Promise.race(children.map(child => new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => stopping && (code === 0 || code === null) ? resolve() : reject(new Error('owned child exited'))); })));
  } finally {
    await closeLogScan();clearInterval(scanTimer); unsubscribe(); stop(); const killTimer = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000);
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))));
    clearTimeout(killTimer); writeScan(); await scanQueue; invariant(!scanError, 'OWNED_APP_SCAN_STATUS_WRITE_FAILED'); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); scanner.assertClean(); emit({ event: 'OWNED_APPS_STOPPED' });
  }
}
main().catch(e => { emit({ event: 'APP_LAUNCH_FAILED', code: safeFailure(e) }); process.exitCode = 1; });
