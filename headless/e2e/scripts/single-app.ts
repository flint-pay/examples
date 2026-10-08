import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { loadConfig, alias } from '../support/config.ts';
import { loadFixtures } from '../support/fixtures.ts';
import { privateDirectory, checkoutRoot, readPrivate, writePrivate } from '../support/private-files.ts';
import { acquirePairLock } from '../support/lock.ts';
import { verifyBuilds } from '../support/build.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { Ledger } from '../support/ledger.ts';
import { Operator } from '../support/operator.ts';
import { Driver } from '../support/driver.ts';
import { syncAppAudit } from '../support/audit-feed.ts';
import { runChild } from '../support/child.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';
import { verifySourceCheckout } from '../support/source.ts';
import { appEnvironment } from '../support/app-environment.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2), integration = args.length === 4 && args[3] === '--integration';
  invariant((args.length === 3 || integration && args[2] === 'storefront') && args[0] === '--apply' && args[1] === '--app' && ['storefront', 'account'].includes(args[2]), 'SINGLE_APP_EXPLICIT_MODE_REQUIRED');
  const app = args[2], label = integration ? 'storefront-integration' : app, config = loadConfig(process.env, true), dir = await privateDirectory(config.privateDir), fixtures = await loadFixtures(config);
  verifySourceCheckout(config);
  invariant(fixtures.values.serviceOwnership?.coordinated === true, 'PARENT_SERVICE_OWNERSHIP_HANDOFF_REQUIRED');
  if (app === 'storefront') {
    const helper = await readFile(join(checkoutRoot, 'headless/storefront/tests/browser/acceptance/support/staging.ts'), 'utf8');
    const buyer = await readFile(join(checkoutRoot, 'headless/storefront/tests/browser/acceptance/support/buyer.ts'), 'utf8');
    invariant(helper.includes('requireBrowserLifecycle(process.env)') && buyer.includes('E2E_BROWSER_BUYER_EMAIL'), 'SINGLE_APP_RUN_ALIAS_CONTRACT_REQUIRED');
  }
  const release = await acquirePairLock(config); let operator: Operator | undefined, driver: Driver | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; }; process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try {
    const clients = new VerifiedClients(config, fixtures); await clients.verify('A'); await clients.verify('B'); await verifyBuilds(config);
    const ledger = new Ledger(join(dir, 'ledger.json'), config.run); await ledger.load();
    // These jobs borrow the shared fixture pair. Only resources this job creates
    // gain cleanup authority; the final cross-app suite owns fixture teardown.
    for (const r of fixtures.resources) { const pin = config.pins[r.sandbox]; await ledger.record({ resource: r.id, type: r.type, mode: 'test', sandbox: r.sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: 'preexisting-reference', purpose: 'supplied-fixture', cleanup: r.cleanup, owner: r.owner, reviewAt: r.reviewAt, owned: false }); }
    operator = new Operator(clients, ledger, fixtures);
    driver = new Driver(config, fixtures, undefined as never, operator); await syncAppAudit(driver);
    const childArgs = integration ? ['--import', join(checkoutRoot, 'headless/e2e/support/app-audit.ts'), '--test', join(checkoutRoot, 'headless/storefront/tests/integration/storefront.test.ts')] : [join(checkoutRoot, 'headless/e2e/node_modules/@playwright/test/cli.js'), 'test', '--config', join(checkoutRoot, 'headless/e2e/single-app.config.ts')];
    await runChild(process.execPath, childArgs, checkoutRoot, driver.scanner, {
      ...(integration ? appEnvironment(config, fixtures, dir, '', { name: 'storefrontA', app: 'storefront', sandbox: 'A', origin: config.origins.storefrontA, identity: 'storefront-integration-identity.sqlite', cookie: 'storefront_integration' }) : {}),
      ...(integration ? { E2E_INTEGRATION_JOURNAL_DIR: join(dir, 'storefront-integration-journals') } : {}),
      E2E_SINGLE_APP: app, E2E_PRIVATE_RUN_DIR: dir, E2E_RUN_ID: config.run, E2E_STOREFRONT_A_ORIGIN: config.origins.storefrontA, E2E_ACCOUNT_A_ORIGIN: config.origins.accountA,
      E2E_BROWSER_BUYER_EMAIL: alias(config, 'b1'), STOREFRONT_ACCEPTANCE: '1', ACCOUNT_BROWSER_MODE: 'staging', APP_ORIGIN: config.origins.storefrontA, ACCOUNT_BASE_URL: config.origins.accountA,
      FLINT_API_BASE_URL: config.apiOrigin, FLINT_API_KEY: config.pins.A.key, FLINT_SANDBOX_ID: config.pins.A.sandboxId,
      NODE_OPTIONS: `--import=${join(checkoutRoot, 'headless/e2e/support/app-audit.ts')}`, E2E_APP_AUDIT_DIR: dir, E2E_APP_AUDIT_NAME: app === 'storefront' ? 'storefrontA' : 'accountA', E2E_APP_AUDIT_SANDBOX: 'A',
    });
    invariant(!interrupted, 'RUN_INTERRUPTED');
    if (!integration) { const result = await readPrivate<{ run: string; complete: boolean }>(join(dir, `single-app-${app}.json`)); invariant(result.run === config.run && result.complete, 'SINGLE_APP_INCOMPLETE'); }
    else await writePrivate(join(dir, 'storefront-integration.json'), { schema_version: 1, run: config.run, evidence_class: 'real_storefront_api', complete: true });
  } finally {
    let code: string | undefined;
    try { if (driver) await syncAppAudit(driver, true); } catch (error) { code = safeFailure(error); }
    try { await operator?.cleanup(); } catch (error) { code ??= safeFailure(error); }
    if (interrupted) code ??= 'RUN_INTERRUPTED';
    try {
      await writePrivate(join(dir, `single-app-${label}-lifecycle.json`), { schema_version: 1, run: config.run, evidence_class: 'lifecycle', complete: !!operator && !code, ...(code ? { code } : {}) });
      await rm(join(dir, `single-app-${app}-temporary`), { recursive: true, force: true });
    } finally { await release(); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); }
    invariant(!code, code ?? 'SINGLE_APP_TEARDOWN_FAILED');
  }
}
main().catch(error => { emit({ event: 'SINGLE_APP_BROWSER_INCOMPLETE', code: safeFailure(error) }); process.exitCode = 1; });
