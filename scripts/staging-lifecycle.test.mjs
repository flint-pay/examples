import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStagingLifecycle, startPrivateChild } from './run-staging-e2e.mjs';
import { stagingDispatch } from './run-staging-check.mjs';
import { verifySourceCheckout } from '../headless/e2e/support/source.ts';
import { CredentialScanner } from '../headless/e2e/support/credential-scan.ts';
import { readBuild as storefrontBuild } from '../headless/storefront/src/build.ts';
import { readBuild as accountBuild } from '../headless/account/src/build.ts';
import { browserBuyerEmail, requireBrowserLifecycle } from '../headless/storefront/tests/browser/acceptance/support/buyer.ts';

const sha = 'a'.repeat(40);
function setup(options = {}) {
  const calls = [], stops = [];
  const config = { targetCommit: sha, pins: { A: { key: 'flint_test_UNIT_A_FAKE' }, B: { key: 'flint_test_UNIT_B_FAKE' } }, operatorPins: { A: { key: 'flint_test_UNIT_OPERATOR_FAKE' } }, builds: { storefrontA: `${sha}:headless/storefront`, storefrontB: `${sha}:headless/storefront`, accountA: `${sha}:headless/account` } };
  let apps;
  const dependencies = { loadConfig: () => config, verifySource: () => calls.push('source'), verifyApi: async () => calls.push('api'), verifyBuilds: async () => calls.push('builds'), stopTimeout: 20,
    start: (script, args, _env, scanner) => {
      calls.push({ script, args }); let running = true, resolve;
      const done = new Promise(finish => { resolve = finish; });
      const child = { done, running: () => running, stop: signal => { stops.push([script, signal]); running = false; resolve({ code: options.teardownFailure ? 1 : 0 }); } };
      if (script.endsWith('apps.ts')) apps = child;
      else queueMicrotask(() => { running = false; if (options.leak) scanner.scan('flint_cses_UNIT_FAKE', 'child'); if (options.appExit) apps.stop('SIGTERM'); resolve({ code: options.suiteFailure ? 1 : 0 }); });
      return child;
    },
  };
  return { calls, stops, config, dependencies };
}

test('trusted runtime dispatch routes browser and API jobs to lifecycle owners only', () => {
  for (const app of ['account', 'storefront']) {
    assert.deepEqual(stagingDispatch(`headless/${app}`, 'test:browser'), { mode: `browser:${app}` });
    assert.deepEqual(stagingDispatch(`headless/${app}`, 'test:integration'), { mode: `integration:${app}` });
  }
  assert.deepEqual(stagingDispatch('headless/e2e', 'e2e'), { mode: 'e2e' });
  for (const directory of ['.', '../private', 'headless/account;printenv', 'headless/unknown']) assert.equal(stagingDispatch(directory, 'test:browser'), undefined);
  assert.equal(stagingDispatch('headless/account', 'fixtures:check'), undefined);
});

test('lifecycle checks reviewed source and API before owned startup, then builds before applying the adapter', async () => {
  for (const [mode, script, args] of [
    ['browser:storefront', 'single-app.ts', ['--apply', '--app', 'storefront']],
    ['browser:account', 'single-app.ts', ['--apply', '--app', 'account']],
    ['integration:account', 'account-integration.ts', ['--apply']],
    ['integration:storefront', 'single-app.ts', ['--apply', '--app', 'storefront', '--integration']],
    ['e2e', 'e2e.ts', ['--apply']],
  ]) {
    const s = setup(); assert.equal(await runStagingLifecycle(mode, {}, s.dependencies), true);
    assert.deepEqual(s.calls, ['source', 'api', { script: 'headless/e2e/scripts/apps.ts', args: ['--apply'] }, 'builds', { script: `headless/e2e/scripts/${script}`, args }]);
    assert.equal(s.stops.length, 2);
  }
});

test('source or API mismatch prevents startup, and readiness failure stops the owned launcher before tests', async () => {
  for (const gate of ['verifySource', 'verifyApi']) {
    const s = setup(); s.dependencies[gate] = () => { throw new Error('synthetic mismatch'); };
    assert.equal(await runStagingLifecycle('e2e', {}, s.dependencies), false); assert.equal(s.calls.some(call => typeof call === 'object'), false);
  }
  const s = setup(); s.dependencies.verifyBuilds = async () => { throw new Error('synthetic stale app'); }; s.dependencies.readyTimeout = 5; s.dependencies.pollInterval = 1;
  assert.equal(await runStagingLifecycle('browser:account', {}, s.dependencies), false); assert.equal(s.stops.length, 1); assert.equal(s.calls.filter(call => typeof call === 'object').length, 1);
});

test('suite failure, premature launcher exit, failed teardown, or private output cannot establish a pass', async () => {
  for (const option of ['suiteFailure', 'appExit', 'teardownFailure', 'leak']) {
    const s = setup({ [option]: true }); assert.equal(await runStagingLifecycle('browser:account', {}, s.dependencies), false, option); assert.equal(s.stops.length >= 2, true);
  }
});

test('failure stopping a suite still stops its owned app launcher', async () => {
  const s = setup(), start = s.dependencies.start;
  s.dependencies.start = (...args) => { const child = start(...args); if (!args[0].endsWith('apps.ts')) child.stop = () => { throw new Error('synthetic stop failure'); }; return child; };
  assert.equal(await runStagingLifecycle('e2e', {}, s.dependencies), false);
  assert.equal(s.stops.some(([script]) => script.endsWith('apps.ts')), true);
});

test('an interruption fails the run, stops both children and removes task signal handlers', async () => {
  const before = process.listenerCount('SIGTERM'), s = setup(), start = s.dependencies.start;
  s.dependencies.start = (...args) => { const child = start(...args); if (!args[0].endsWith('apps.ts')) queueMicrotask(() => process.emit('SIGTERM')); return child; };
  assert.equal(await runStagingLifecycle('browser:account', {}, s.dependencies), false); assert.equal(s.stops.length >= 2, true); assert.equal(process.listenerCount('SIGTERM'), before);
});

test('private child output is discarded and scanned before its tracked close result', async () => {
  const scanner = new CredentialScanner();
  const child = startPrivateChild('-e', ["console.log('flint_cses_UNIT_FAKE'); console.error('buyer@example.invalid');"], {}, scanner);
  try { assert.equal((await child.done).code, 0); assert.throws(() => scanner.assertClean(), { message: 'CREDENTIAL_LEAK' }); }
  finally { child.stop('SIGTERM'); }
});

test('owned source provenance rejects dirty, wrong, failed and relabeled checkouts', () => {
  const s = setup();
  const git = (head = sha, status = '', code = 0) => args => ({ status: code, stdout: args[0] === 'rev-parse' ? head + '\n' : status });
  verifySourceCheckout(s.config, git());
  for (const command of [git('b'.repeat(40)), git(sha, '?? unreviewed.ts\n'), git(sha, ' M source.ts\n'), git(sha, '', 1)]) assert.throws(() => verifySourceCheckout(s.config, command), { message: 'REVIEWED_SOURCE_CHECKOUT_REQUIRED' });
  assert.throws(() => verifySourceCheckout({ ...s.config, builds: { ...s.config.builds, accountA: 'invented-artifact' } }, git()), { message: 'OWNED_SOURCE_ARTIFACT_REQUIRED' });
});

test('apps omit unknown build identity, refuse partial metadata, and report actual process start time', () => {
  for (const readBuild of [storefrontBuild, accountBuild]) {
    assert.equal(readBuild({}), undefined);
    for (const env of [{ BUILD_SHA: sha }, { BUILD_ARTIFACT_ID: 'unit' }, { BUILD_SHA: 'main', BUILD_ARTIFACT_ID: 'unit' }, { BUILD_SHA: sha, BUILD_ARTIFACT_ID: 'unit\nforged' }]) assert.throws(() => readBuild(env));
    const build = readBuild({ BUILD_SHA: sha, BUILD_ARTIFACT_ID: `${sha}:headless/account` });
    assert.equal(build.sha, sha); assert.equal(build.artifactId, `${sha}:headless/account`); assert.equal(Date.parse(build.startedAt), Math.floor(performance.timeOrigin));
  }
});

test('browser buyers must use the supplied exact run alias before any acceptance write', () => {
  const run = '20000101T000000Z-abcdef12', email = `buyer+fx-${run}-b1@example.invalid`;
  assert.equal(browserBuyerEmail({ E2E_RUN_ID: run, E2E_BROWSER_BUYER_EMAIL: email }), email);
  for (const env of [{}, { E2E_RUN_ID: run }, { E2E_RUN_ID: run, E2E_BROWSER_BUYER_EMAIL: 'buyer@example.invalid' }, { E2E_RUN_ID: '20000101T000000Z-abcdef13', E2E_BROWSER_BUYER_EMAIL: email }]) assert.throws(() => browserBuyerEmail(env));
  const audited = { E2E_RUN_ID: run, E2E_BROWSER_BUYER_EMAIL: email, E2E_APP_AUDIT_DIR: '/tmp/unit-private', E2E_APP_AUDIT_NAME: 'storefrontA', E2E_APP_AUDIT_SANDBOX: 'A', NODE_OPTIONS: '--import=/synthetic/headless/e2e/support/app-audit.ts' };
  requireBrowserLifecycle(audited);
  for (const key of ['E2E_APP_AUDIT_DIR', 'E2E_APP_AUDIT_NAME', 'E2E_APP_AUDIT_SANDBOX', 'NODE_OPTIONS']) assert.throws(() => requireBrowserLifecycle({ ...audited, [key]: undefined }));
});
