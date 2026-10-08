import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareStagingContext } from './prepare-staging-context.mjs';

test('staging fixture material stays private and is never written into environment exports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'examples-ci-'));
  try {
    const checkout = join(directory, 'checkout');
    // An existing regular directory is required for realpath checks.
    const parent = mkdtempSync(join(directory, 'runner-'));
    const root = mkdtempSync(checkout);
    const exports = join(parent, 'exports'); writeFileSync(exports, '');
    const secret = 'synthetic-private-fixture-value';
    const env = { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'flint-pay/examples', RUNNER_TEMP: parent, GITHUB_ENV: exports,
      E2E_FIXTURE_JSON: JSON.stringify({ schema_version: 1, run: '20000101T000000Z-abcdef12', private: secret }) };
    const result = prepareStagingContext(env, root);
    assert.equal(statSync(result.directory).mode & 0o777, 0o700);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).private, secret);
    assert.equal(readFileSync(exports, 'utf8').includes(secret), false);
    assert.throws(() => prepareStagingContext({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, root));
    assert.throws(() => prepareStagingContext({ ...env, RUNNER_TEMP: root }, root));
    const link = join(parent, 'inside-checkout'); symlinkSync(root, link);
    assert.throws(() => prepareStagingContext({ ...env, RUNNER_TEMP: link }, root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
