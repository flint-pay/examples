import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runWithoutPrivateOutput } from './run-staging-check.mjs';

test('does not expose private child output on success or failure', () => {
  for (const code of [0, 1]) {
    assert.equal(runWithoutPrivateOutput(process.execPath, ['-e',
      `console.log('private stdout'); console.error('private stderr'); process.exit(${code});`]), code === 0);
  }
});

test('a fork event cannot invoke the staging runner even with a valid script name', () => {
  const result = spawnSync(process.execPath, ['scripts/run-staging-check.mjs', '.', 'e2e'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'flint-pay/examples' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Staging check refused/);
  assert.equal(result.stdout, '');
});
