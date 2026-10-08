import { join } from 'node:path';
import { loadConfig } from '../support/config.ts';
import { loadFixtures } from '../support/fixtures.ts';
import { privateDirectory } from '../support/private-files.ts';
import { VerifiedClients } from '../support/sdk.ts';
import { Ledger } from '../support/ledger.ts';
import { Operator } from '../support/operator.ts';
import { Results } from '../support/results.ts';
import { inventoryReadiness, unresolvedSuitePrerequisites } from '../support/readiness.ts';
import { rows } from '../scenarios/registry.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';

async function main() {
  const args = new Set(process.argv.slice(2));
  invariant([...args].every(a => ['--check', '--dryrun', '--apply', '--cleanup', '--reconcile'].includes(a)), 'FIXTURE_ARGUMENT_INVALID');
  invariant(['--dryrun', '--check', '--apply'].filter(a => args.has(a)).length === 1, 'EXPLICIT_FIXTURE_MODE_REQUIRED');
  invariant(!args.has('--cleanup') && !args.has('--reconcile') || args.has('--apply'), 'EXPLICIT_APPLY_REQUIRED');
  invariant(!(args.has('--cleanup') && args.has('--reconcile')), 'FIXTURE_MODE_CONFLICT');
  const config = loadConfig(process.env, args.has('--apply'));
  const directory = await privateDirectory(config.privateDir), fixtures = await loadFixtures(config);
  const ledger = new Ledger(join(directory, 'ledger.json'), config.run); await ledger.load();
  for (const r of fixtures.resources) {
    const pin = config.pins[r.sandbox];
    await ledger.record({ resource: r.id, type: r.type, mode: 'test', sandbox: r.sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: config.run, purpose: 'supplied-fixture', cleanup: r.cleanup, owner: r.owner, reviewAt: r.reviewAt, owned: r.ownedByRun });
  }
  const clients = new VerifiedClients(config, fixtures), operator = new Operator(clients, ledger, fixtures);
  const results = new Results(join(directory, 'readiness.json'), rows.map(r => r.id)); inventoryReadiness(config, fixtures, results);
  if (!config.apply && !args.has('--check')) {
    for (const step of fixtures.operatorPlan ?? []) operator.validate(step);
    await results.save(); emit({ event: 'FIXTURE_DRYRUN', count: fixtures.operatorPlan?.length ?? 0 }); return;
  }
  await clients.verify('A'); await clients.verify('B');
  if (args.has('--check')) {
    const missing = unresolvedSuitePrerequisites(config, fixtures, results);
    await results.save(); emit({ event: 'FIXTURE_READINESS_CHECKED', count: missing.length });
    invariant(missing.length === 0, 'SUITE_FIXTURE_READINESS_INCOMPLETE'); return;
  }
  invariant(config.apply, 'EXPLICIT_APPLY_REQUIRED');
  if (args.has('--cleanup')) await operator.cleanup();
  else {
    if (args.has('--reconcile')) {
      for (const [name, action] of Object.entries(ledger.state.actions)) if (action.phase === 'unknown' || action.phase === 'prepared') {
        const step = fixtures.operatorPlan?.find(s => s.name === name.slice(2) && s.sandbox === action.sandbox);
        invariant(step, 'ORIGINAL_OPERATOR_PLAN_REQUIRED'); await operator.execute(step);
      }
    } else {
      await operator.applyPlan(fixtures.operatorPlan ?? []);
      for (const sandbox of ['A', 'B'] as const) if (fixtures.values.settingsPatches?.[sandbox]) await operator.settings(sandbox, fixtures.values.settingsPatches[sandbox]);
    }
  }
  await results.save(); emit({ event: args.has('--cleanup') ? 'FIXTURE_CLEANUP_COMPLETE' : 'FIXTURE_APPLY_COMPLETE' });
}
main().catch(e => { emit({ event: 'FIXTURE_COMMAND_FAILED', code: safeFailure(e) }); process.exitCode = 1; });
