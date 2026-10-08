import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrustedStagingRun } from './check-staging-event.mjs';

const trusted = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'flint-pay/examples' };

test('permits manual and nightly checks only from the canonical main branch', () => {
  assert.equal(isTrustedStagingRun(trusted), true);
  assert.equal(isTrustedStagingRun({ ...trusted, eventName: 'schedule' }), true);
});

test('rejects fork PRs, privileged PR events, branch dispatches, forks, and missing context', () => {
  for (const eventName of ['pull_request', 'pull_request_target', 'push', 'repository_dispatch', undefined]) {
    assert.equal(isTrustedStagingRun({ ...trusted, eventName }), false);
  }
  assert.equal(isTrustedStagingRun({ ...trusted, ref: 'refs/pull/12/merge' }), false);
  assert.equal(isTrustedStagingRun({ ...trusted, ref: 'refs/heads/feature' }), false);
  assert.equal(isTrustedStagingRun({ ...trusted, repository: 'contributor/examples' }), false);
  assert.equal(isTrustedStagingRun({}), false);
});
