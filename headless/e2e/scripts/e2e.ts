import { chromium } from '@playwright/test';
import { join } from 'node:path';
import { loadConfig } from '../support/config.ts';
import { loadFixtures, assertSessionExceptions } from '../support/fixtures.ts';
import { privateDirectory } from '../support/private-files.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { Results } from '../support/results.ts';
import { Ledger } from '../support/ledger.ts';
import { Operator } from '../support/operator.ts';
import { Driver } from '../support/driver.ts';
import { createInbox } from '../support/inbox.ts';
import { inventoryReadiness, prerequisites } from '../support/readiness.ts';
import { verifyBuilds } from '../support/build.ts';
import { verifySourceCheckout } from '../support/source.ts';
import { acquirePairLock } from '../support/lock.ts';
import { verifyVaultAuthority, VaultGateError } from '../support/app-vault.ts';
import { syncAppAudit } from '../support/audit-feed.ts';
import { rows, handlers, executionOrder, dependencies, validateRegistry } from '../scenarios/registry.ts';
import { emit, invariant, safeFailure } from '../support/safe.ts';

async function main() {
  validateRegistry(); invariant(process.argv.slice(2).length === 1 && process.argv[2] === '--apply', 'E2E_EXPLICIT_APPLY_REQUIRED');
  const config = loadConfig(process.env, true), dir = await privateDirectory(config.privateDir);
  verifySourceCheckout(config);
  const results = new Results(join(dir, 'acceptance.json'), rows.map(r => r.id));
  let release: (() => Promise<void>) | undefined, driver: Driver | undefined, operator: Operator | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let interrupted = false; const interrupt = () => { interrupted = true; }; process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  const progress = setInterval(() => emit({ event: 'ACCEPTANCE_RUNNING' }), 45_000);
  try {
    release = await acquirePairLock(config); const fixtures = await loadFixtures(config); assertSessionExceptions(fixtures.acceptedExceptions); inventoryReadiness(config, fixtures, results);
    const clients = new VerifiedClients(config, fixtures);
    try { await clients.verify('A'); await clients.verify('B'); await verifyBuilds(config); }
    catch (e) { results.root({ id: 'PRQ-RUN-IDENTITY', status: 'FAIL', code: safeFailure(e) }); for (const row of rows) results.stopped(row.id, 'PRQ-RUN-IDENTITY'); return; }
    const ledger = new Ledger(join(dir, 'ledger.json'), config.run); await ledger.load();
    for (const resource of fixtures.resources) {
      const pin = config.pins[resource.sandbox]; await ledger.record({ resource: resource.id, type: resource.type, mode: 'test', sandbox: resource.sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: config.run, purpose: 'supplied-fixture', cleanup: resource.cleanup, owner: resource.owner, reviewAt: resource.reviewAt, owned: resource.ownedByRun });
    }
    operator = new Operator(clients, ledger, fixtures);
    let inbox;
    try { inbox = createInbox(config); } catch (e) { results.updateRoot({ id: 'PRQ-INBOX', status: 'PENDING', code: safeFailure(e) }); }
    browser = await chromium.launch({ headless: true }); driver = new Driver(config, fixtures, browser, operator, inbox);
    try { await syncAppAudit(driver); } catch { results.root({ id: 'PRQ-APP-RESOURCE-AUDIT', status: 'PENDING', code: 'NONSECRET_APP_RESOURCE_AUDIT_REQUIRED' }); }
    for (const id of executionOrder) {
      const row = rows.find(r => r.id === id)!;
      const exception = fixtures.acceptedExceptions?.find(e => e.id === id);
      if (exception) { results.exception(id, exception); continue; }
      if (interrupted) { results.root({ id: 'PRQ-RUN-INTERRUPTED', status: 'PENDING', code: 'RUN_INTERRUPTED' }); results.stopped(id, 'PRQ-RUN-INTERRUPTED'); continue; }
      if (results.roots.has('PRQ-GUARDS')) { results.stopped(id, 'PRQ-GUARDS'); continue; }
      if (id !== 'U-01' && results.roots.has('PRQ-APP-RESOURCE-AUDIT')) { results.stopped(id, 'PRQ-APP-RESOURCE-AUDIT'); continue; }
      if (row.schedule === 'extended' && config.suite !== 'extended') { results.root({ id: 'PRQ-EXTENDED-RUN', status: 'PENDING', code: 'EXTENDED_SUITE_REQUIRED' }); results.stopped(id, 'PRQ-EXTENDED-RUN'); continue; }
      const dependency = (dependencies[id] ?? []).find(dep => results.rows.get(dep)?.status !== 'PASS');
      if (dependency) { const root = `PRQ-SCENARIO-${dependency}`; results.root({ id: root, status: 'PENDING', code: 'IMMEDIATE_SCENARIO_NOT_PASSED' }); results.stopped(id, root); continue; }
      if (id === 'AC-15' || id === 'AC-16'||id==='SF-GIFTCHALLENGE'||id==='AC-GIFTCHALLENGE') {
        if (results.roots.get('PRQ-APP-VAULT-AUTHORITY')?.status === 'FAIL') { results.stopped(id, 'PRQ-APP-VAULT-AUTHORITY'); continue; }
        try { await verifyVaultAuthority(driver, id); results.updateRoot({ id: 'PRQ-APP-VAULT-AUTHORITY', status: 'RESOLVED', code: 'APP_VAULT_RUN_OWNED_GATES_VERIFIED' }); }
        catch (error) {
          const status = error instanceof VaultGateError ? error.status : 'FAIL';
          results.updateRoot({ id: 'PRQ-APP-VAULT-AUTHORITY', status, code: safeFailure(error) });
          if (status === 'FAIL') results.finish(id, 'FAIL', [safeFailure(error)], 'PRQ-APP-VAULT-AUTHORITY'); else results.stopped(id, 'PRQ-APP-VAULT-AUTHORITY');
          await results.save(); continue;
        }
      }
      const missing = prerequisites(id).find(p => results.roots.get(p)?.status !== 'RESOLVED');
      if (missing) { results.stopped(id, missing); continue; }
      clients.requestIds.clear(); for (const guard of driver.guards.values()) guard.requestIds.clear();
      try {
        if (id !== 'U-01') { await clients.verify('A'); await clients.verify('B'); }
        const evidence = await handlers[id](driver); await syncAppAudit(driver); await driver.guardCheck(); results.finish(id, 'PASS', evidence, undefined, [...clients.requestIds, ...[...driver.guards.values()].flatMap(g => [...g.requestIds])]);
      }
      catch (e) {
        const code = safeFailure(e); results.finish(id, e instanceof VaultGateError && e.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL', [code]);
        if (e instanceof VaultGateError && e.status === 'FAIL') results.updateRoot({ id: 'PRQ-APP-VAULT-AUTHORITY', status: 'FAIL', code });
        if (/^INBOX_/.test(code)) results.updateRoot({ id: 'PRQ-INBOX', status: 'FAIL', code });
        if (driver.scanner.violations.size || [...driver.guards.values()].some(g => g.violations.size)) results.updateRoot({ id: 'PRQ-GUARDS', status: 'FAIL', code: 'BROWSER_OR_CREDENTIAL_GUARD_FAILED' });
      }
      await results.save(); emit({ event: 'SCENARIO_RESULT', row: id, status: results.rows.get(id)!.status });
    }
  } finally {
    clearInterval(progress); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    if (driver) { try { await syncAppAudit(driver, true); } catch (e) { results.root({ id: 'PRQ-APP-AUDIT-TEARDOWN', status: 'FAIL', code: safeFailure(e) }); } try { await driver.guardCheck(); } catch (e) { results.updateRoot({ id: 'PRQ-GUARDS', status: 'FAIL', code: safeFailure(e) }); } await driver.close(); await driver.inbox?.close().catch(() => {}); }
    await browser?.close();
    if (operator) { try { await operator.cleanup(); } catch (e) { results.root({ id: 'PRQ-TEARDOWN', status: 'FAIL', code: safeFailure(e) }); } }
    await results.save(); await release?.();
    const incomplete = [...results.rows.values()].some(r => r.status !== 'PASS' && r.status !== 'OUT OF SCOPE') || [...results.roots.values()].some(r => r.status === 'FAIL');
    if (incomplete) process.exitCode = 1;
    emit({ event: incomplete ? 'ACCEPTANCE_INCOMPLETE' : 'ACCEPTANCE_COMPLETE', count: [...results.rows.values()].filter(r => r.status === 'PASS').length });
  }
}
main().catch(e => { emit({ event: 'ACCEPTANCE_FAILED', code: safeFailure(e) }); process.exitCode = 1; });
