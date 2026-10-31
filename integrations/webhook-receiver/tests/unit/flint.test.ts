import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@flintpay/node';
import { createAuth, preflight } from '../../src/flint.ts';

test('merchant preflight preserves sandbox response header guards without requiring payment readiness', async () => {
  const auth = createAuth('flint_test_unit');
  const run = (headers: Record<string, string>, guard?: string) => preflight({ merchants: {
    getWithResponse: async (params: unknown, options: unknown) => {
      assert.equal(params, undefined); assert.deepEqual(options, auth.merchant());
      return { body: { data: { readiness: { capabilities: [] } } }, meta: { headers } };
    },
  } } as unknown as Client, auth, guard);
  assert.deepEqual(await run({ 'flint-mode': 'test', 'flint-sandbox-id': 'test_UNIT' }, 'test_UNIT'), { sandboxId: 'test_UNIT' });
  await assert.rejects(run({ 'flint-mode': 'live', 'flint-sandbox-id': 'test_UNIT' }), /Live API responses are refused/);
  await assert.rejects(run({ 'flint-mode': 'test' }), /Sandbox identity guard failed/);
  await assert.rejects(run({ 'flint-sandbox-id': 'test_OTHER' }, 'test_UNIT'), /Sandbox identity guard failed/);
});
