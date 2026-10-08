import { join } from 'node:path';
import { loadConfig } from '../support/config.ts';
import { loadFixtures } from '../support/fixtures.ts';
import { privateDirectory, writePrivate } from '../support/private-files.ts';
import { acquirePairLock } from '../support/lock.ts';
import { verifyBuilds } from '../support/build.ts';
import { verifySourceCheckout } from '../support/source.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { Ledger } from '../support/ledger.ts';
import { Operator } from '../support/operator.ts';
import { exerciseAccountApi } from '../support/account-integration.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';

async function main(): Promise<void> {
  invariant(process.argv.slice(2).length === 1 && process.argv[2] === '--apply', 'ACCOUNT_INTEGRATION_EXPLICIT_APPLY_REQUIRED');
  const config = loadConfig(process.env, true), directory = await privateDirectory(config.privateDir), fixtures = await loadFixtures(config);
  verifySourceCheckout(config);
  invariant(fixtures.values.serviceOwnership?.coordinated === true, 'PARENT_SERVICE_OWNERSHIP_HANDOFF_REQUIRED');
  const customerId = fixtures.values.sessionDisposableCustomerId;
  const customer = fixtures.resources.find(r => r.sandbox === 'A' && r.type === 'customer' && r.id === customerId && r.ownedByRun);
  invariant(customer, 'DISPOSABLE_SESSION_CUSTOMER_AUTHORITY_REQUIRED');
  const release = await acquirePairLock(config);
  let operator: Operator | undefined, complete = false, failure: string | undefined, interrupted = false;
  const interrupt = () => { interrupted = true; }; process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try {
    const clients = new VerifiedClients(config, fixtures); await clients.verify('A'); await clients.verify('B'); await verifyBuilds(config);
    const ledger = new Ledger(join(directory, 'account-api-ledger.json'), config.run); await ledger.load();
    await ledger.record({ resource: customer.id, type: 'customer', mode: 'test', sandbox: 'A', merchant: config.pins.A.merchantId, sandboxId: config.pins.A.sandboxId, createdBy: config.run, purpose: 'supplied-disposable-customer', cleanup: 'review', owner: customer.owner, reviewAt: customer.reviewAt, owned: true });
    operator = new Operator(clients, ledger, fixtures);
    const evidence = await exerciseAccountApi(operator, customer.id);
    invariant(!interrupted, 'RUN_INTERRUPTED');
    await writePrivate(join(directory, 'account-api-integration.json'), { schema_version: 1, run: config.run, evidence_class: 'real_account_public_api', complete: true, evidence });
    complete = true;
  } catch (error) { failure = safeFailure(error); }
  finally {
    try { await operator?.cleanup(); } catch (error) { failure ??= safeFailure(error); }
    try { await writePrivate(join(directory, 'account-api-lifecycle.json'), { schema_version: 1, run: config.run, evidence_class: 'lifecycle', complete: complete && !!operator && !failure && !interrupted, ...(failure ? { code: failure } : {}) }); }
    finally { await release(); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); }
  }
  invariant(complete && !failure && !interrupted, failure ?? 'ACCOUNT_INTEGRATION_INCOMPLETE');
  emit({ event: 'ACCOUNT_PUBLIC_API_INTEGRATION_FINISHED' });
}
main().catch(error => { emit({ event: 'ACCOUNT_PUBLIC_API_INTEGRATION_INCOMPLETE', code: safeFailure(error) }); process.exitCode = 1; });
