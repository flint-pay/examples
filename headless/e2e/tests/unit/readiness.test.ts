import test from 'node:test';
import assert from 'node:assert/strict';
import { unresolvedSuitePrerequisites, prerequisites } from '../../support/readiness.ts';
import { rows } from '../../scenarios/registry.ts';
import { Results } from '../../support/results.ts';

test('fixture checks fail pending roots without counting unexecuted or blocked coverage as passing', () => {
  const results = new Results('/tmp/unused-unit-readiness.json', rows.map(row => row.id));
  for (const id of new Set(rows.flatMap(row => prerequisites(row.id)))) results.root({ id, code: 'UNIT', status: 'RESOLVED' });
  results.roots.set('PRQ-GIFT-CHALLENGE', { id: 'PRQ-GIFT-CHALLENGE', code: 'UNIT_MISSING_CONTRACT', status: 'PENDING' });
  results.roots.set('PRQ-REFRESH-REPLAY', { id: 'PRQ-REFRESH-REPLAY', code: 'UNIT_SCOPE_STOP', status: 'BLOCKED' });
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'standard' }, {}, results), ['PRQ-GIFT-CHALLENGE']);
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'extended' }, {}, results), ['PRQ-GIFT-CHALLENGE', 'PRQ-REFRESH-REPLAY']);
  const acceptedExceptions = [{ id: 'SF-GIFTCHALLENGE', acceptedByUser: true as const, reference: 'UNIT_EXPLICIT_USER_EXCEPTION' }];
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'standard' }, { acceptedExceptions }, results), []);
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'extended' }, { acceptedExceptions }, results), ['PRQ-REFRESH-REPLAY']);
});
