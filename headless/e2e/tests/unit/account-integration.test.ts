import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseAccountApi } from '../../support/account-integration.ts';
import { Operator } from '../../support/operator.ts';
import { Ledger } from '../../support/ledger.ts';
import type { AccountClients } from '../../support/account-integration.ts';
import type { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures } from '../../support/fixtures.ts';

const run = '20000101T000000Z-00000000', customer = 'cus_UNIT_FAKE';
async function fixture(dir: string, options: { owned?: boolean; wrongCustomer?: boolean; lostRefresh?: boolean; stillValid?: boolean } = {}) {
  const ledger = new Ledger(join(dir, 'ledger.json'), run);
  await ledger.record({ resource: customer, type: 'customer', mode: 'test', sandbox: 'A', merchant: 'mer_UNIT_FAKE', sandboxId: 'test_UNIT_FAKE', createdBy: run, purpose: 'synthetic-unit', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: options.owned ?? true });
  let writes = 0, revoked = false;
  const seen: string[] = [], keys: string[] = [], secrets: string[] = [];
  const first = { customer_id: customer, customer_session_id: 'cses_UNIT_FIRST_FAKE', secret: 'flint_cses_UNIT_FIRST_FAKE', refresh_token: 'flint_cref_UNIT_FIRST_FAKE' };
  const second = { ...first, customer_session_id: 'cses_UNIT_SECOND_FAKE', secret: 'flint_cses_UNIT_SECOND_FAKE', refresh_token: 'flint_cref_UNIT_SECOND_FAKE' };
  const merchant = { customers: { get: async () => ({ customer_id: options.wrongCustomer ? 'cus_UNIT_FOREIGN_FAKE' : customer }) }, customerSessions: {
    createWithResponse: async (body: any, opts: any) => { assert.equal(body.customer_id, customer); writes++; keys.push(opts.idempotencyKey); return { body: { data: first }, meta: {} }; },
    revoke: async (id: string, _body: unknown, opts: any) => { writes++; keys.push(opts.idempotencyKey); revoked = true; return { customer_session_id: id, revoked: true }; },
  } };
  const verified = { config: { apiOrigin: 'https://api.staging.withflintpay.com', pins: { A: { merchantId: 'mer_UNIT_FAKE', sandboxId: 'test_UNIT_FAKE' } } }, clients: { A: merchant }, writable: async () => merchant } as unknown as VerifiedClients;
  const operator = new Operator(verified, ledger, {} as Fixtures);
  const injected = { anonymous: { close: async () => {}, customerSessions: { refresh: async (body: any, opts: any) => {
    assert.deepEqual(Object.keys(opts), ['idempotencyKey']); assert.equal(body.refresh_token, first.refresh_token); writes++; keys.push(opts.idempotencyKey);
    if (options.lostRefresh) throw new Error('synthetic transport interrupted'); return second;
  } } }, buyer: (secret: string) => {
    secrets.push(secret);
    const me: Record<string, unknown> = { get: async () => { seen.push('get'); if (revoked && !options.stillValid) throw Object.assign(new Error('synthetic session revoked'), { code: 'INVALID_CUSTOMER_SESSION' }); return { customer_id: customer }; } };
    for (const method of ['listOrders', 'listSubscriptions', 'listInvoices', 'listReturns', 'listPaymentMethods', 'listAddresses', 'listGiftCards']) me[method] = async () => { seen.push(method); return { data: [] }; };
    return { me, close: async () => {} };
  } } as unknown as AccountClients;
  return { ledger, operator, injected, first, second, seen, keys, secrets, writes: () => writes };
}
async function temp(work: (dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'account-api-unit-')); try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test('account API coverage uses its own session family, buyer reads, anonymous refresh, and verified revocation', async () => temp(async dir => {
  const f = await fixture(dir);
  assert.deepEqual(await exerciseAccountApi(f.operator, customer, f.injected), ['PUBLIC_ACCOUNT_SESSION_MINT', 'PUBLIC_BUYER_RESOURCE_LISTS', 'PUBLIC_ACCOUNT_SESSION_REFRESH', 'PUBLIC_ACCOUNT_SESSION_REVOKE_AND_DENIAL']);
  assert.deepEqual(f.secrets, [f.first.secret, f.second.secret]); assert.equal(f.seen.filter(method => method !== 'get').length, 7); assert.equal(new Set(f.keys).size, 3);
  await f.operator.cleanup(); f.ledger.assertTracked();
  const journal = await readFile(f.ledger.file, 'utf8');
  for (const token of [f.first.secret, f.second.secret, f.first.refresh_token, f.second.refresh_token]) assert.equal(journal.includes(token), false);
  assert.equal(f.ledger.state.resources.filter(r => r.type === 'customer_session' && r.status === 'CLEANED UP').length, 2);
}));

test('supplied unowned or foreign customers refuse session writes', async () => temp(async dir => {
  for (const option of [{ owned: false }, { wrongCustomer: true }]) {
    const f = await fixture(dir, option); await assert.rejects(() => exerciseAccountApi(f.operator, customer, f.injected)); assert.equal(f.writes(), 0);
  }
}));

test('lost refresh remains unreconciled and a usable revoked session fails acceptance', async () => temp(async dir => {
  const lost = await fixture(dir, { lostRefresh: true }); await assert.rejects(() => exerciseAccountApi(lost.operator, customer, lost.injected));
  assert.equal(lost.ledger.state.actions['A:account-api-refresh'].phase, 'unknown'); await assert.rejects(() => lost.operator.cleanup(), { message: 'UNRECONCILED_CREATION_OR_MUTATION' });
  const valid = await fixture(dir, { stillValid: true }); await assert.rejects(() => exerciseAccountApi(valid.operator, customer, valid.injected), { message: 'ACCOUNT_REVOKED_SESSION_MUST_BE_INVALID' });
}));
