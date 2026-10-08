import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseOwnSessionRefresh } from '../../support/owned-sessions.ts';
import { Operator } from '../../support/operator.ts';
import { Ledger } from '../../support/ledger.ts';
import type { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures } from '../../support/fixtures.ts';

const run = '20000101T000000Z-00000000', customerId = 'cus_PLACEHOLDER';
test('own public session reuse checks do not extract application authority or store tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-unit-'));
  try {
    const ledger = new Ledger(join(dir, 'ledger.json'), run); await ledger.record({ resource: customerId, type: 'customer', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER', createdBy: run, purpose: 'unit', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true });
    let rotated = false, revoked = false; const keys: string[] = [];
    const first = { customer_id: customerId, customer_session_id: 'cses_PLACEHOLDER_1', secret: 'first-s', refresh_token: 'first-r' };
    const second = { customer_id: customerId, customer_session_id: 'cses_PLACEHOLDER_2', secret: 'second-s', refresh_token: 'second-r' };
    const client = { customers: { get: async () => ({ customer_id: customerId }) }, customerSessions: {
      createWithResponse: async () => ({ body: { data: first }, meta: {} }),
      refresh: async (body: any, options: any) => { assert.equal(body.refresh_token, first.refresh_token); keys.push(options.idempotencyKey); if (rotated) { revoked = true; throw Object.assign(new Error('CUSTOMER_SESSION_REFRESH_REUSED'), { code: 'CUSTOMER_SESSION_REFRESH_REUSED', status: 401 }); } rotated = true; return second; },
    } };
    const clients = { config: { apiOrigin: 'https://api.staging.withflintpay.com', pins: { A: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER' } } }, clients: { A: client }, writable: async () => client } as unknown as VerifiedClients;
    const op = new Operator(clients, ledger, {} as Fixtures);
    const evidence = await exerciseOwnSessionRefresh(op, customerId, secret => ({ me: { get: async () => { assert.equal(secret, second.secret); if (revoked) throw Object.assign(new Error('INVALID_CUSTOMER_SESSION'), { code: 'INVALID_CUSTOMER_SESSION' }); return { customer_id: customerId }; } } } as any), client as any);
    assert.deepEqual(evidence, ['PUBLIC_OWN_SESSION_REFRESH_ROTATION_REUSE_FAMILY_REVOCATION']); assert.notEqual(keys[0], keys[1]);
    assert.equal(ledger.state.resources.filter(r => r.type === 'customer_session').length, 2);
    const persisted = await readFile(ledger.file, 'utf8'); for (const value of [first.secret, first.refresh_token, second.secret, second.refresh_token]) assert.equal(persisted.includes(value), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
