import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@flintpay/node';
import { Ledger } from '../../support/ledger.ts';
import { Operator, operations } from '../../support/operator.ts';
import type { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures } from '../../support/fixtures.ts';

const run = '20000101T000000Z-00000000';
const config = { pins: { A: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A' }, B: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_B' } } };
async function setup(fn: (ledger: Ledger, dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'headless-operator-unit-')); try { await fn(new Ledger(join(dir, 'ledger.json'), run), dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('every operator method exists in the exact published SDK', () => {
  const client = new Client({ baseUrl: 'https://api.staging.withflintpay.com', apiKey: 'flint_test_PLACEHOLDER' });
  for (const operation of Object.keys(operations)) { const [resource, method] = operation.split('.'); assert.equal(typeof (client as any)[resource]?.[`${method}WithResponse`], 'function', operation); }
});
test('settings reject arbitrary preexisting authority before invoking the client', async () => setup(async ledger => {
  let called = false;
  const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: {} } as Fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }), { message: 'PREEXISTING_SETTINGS_CHANGE_FORBIDDEN' }); assert.equal(called, false);
}));
test('unknown settings outcome replays the original version and restores the snapshot', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } }, lost = true;
  const seen: any[] = [], cache = new Map<string, any>();
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any, options: any) => {
    seen.push({ body: structuredClone(body), key: options.idempotencyKey });
    if (cache.has(options.idempotencyKey)) return cache.get(options.idempotencyKey);
    assert.equal(body.expected_version, current.version); current = { ...body, version: (BigInt(current.version) + 1n).toString() }; delete current.expected_version;
    const response = structuredClone(current); cache.set(options.idempotencyKey, response); if (lost) { lost = false; throw new Error('unknown'); } return response;
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const fixtures = { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures;
  const op = new Operator(clients, ledger, fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }));
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); assert.deepEqual(seen[0], seen[1]);
  await op.cleanup(); assert.equal(current.customer_account.mode, 'flint_hosted'); ledger.assertTracked();
}));
test('concurrent settings change is preserved and teardown fails', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } };
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any) => { current = { ...body, version: '2' }; delete current.expected_version; return structuredClone(current); } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures);
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); current = { version: '3', customer_account: { mode: 'foreign-owner-value' } };
  await assert.rejects(() => op.cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(current.customer_account.mode, 'foreign-owner-value');
}));
test('cleanup fails if supported revocation reports failure', async () => setup(async ledger => {
  const clients = { config, writable: async () => ({ customerSessions: { revoke: async () => ({ revoked: false, customer_session_id: 'cs_PLACEHOLDER' }) } }) } as unknown as VerifiedClients;
  await ledger.record({ resource: 'cs_PLACEHOLDER', type: 'customer_session', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'customer_session', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true });
  await assert.rejects(() => new Operator(clients, ledger, {} as Fixtures).cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(ledger.state.resources[0].status, 'PENDING AUTHORIZED CLEANUP');
}));
test('supplied unowned resources are never cleaned up', async () => setup(async ledger => {
  let called = false; const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  await ledger.record({ resource: 'sub_PLACEHOLDER', type: 'subscription', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'subscription', owner: 'fixture-owner', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  await new Operator(clients, ledger, {} as Fixtures).cleanup(); assert.equal(called, false);
}));
test('same explicit key is durably recorded in both sandbox journals', async () => setup(async ledger => {
  for (const sandbox of ['A', 'B'] as const) await ledger.action('isolation', sandbox, 'orders.create', [], async key => key, async () => {}, 'same-PLACEHOLDER-key');
  assert.equal(ledger.state.actions['A:isolation'].key, ledger.state.actions['B:isolation'].key);
}));

test('external gift funding uses a sanctioned customer ID read through the public client', async () => setup(async ledger => {
  const id = 'cus_FUNDING_PLACEHOLDER';
  await ledger.record({ resource: id, type: 'customer', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'supplied-fixture', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  let buyerId: string | undefined;
  const fake = { customers: { get: async (value: string) => { assert.equal(value, id); return { customer_id: id }; } }, giftCards: { createWithResponse: async (body: any) => { buyerId = body.funding.source.buyer_id; return { body: { data: { gift_card: { gift_card_id: 'gift_PLACEHOLDER' }, code: 'GIFT-PLACEHOLDER' } }, meta: {} }; } } };
  const clients = { config, clients: { A: fake }, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: id } } as unknown as Fixtures); await op.issueGiftCard('funded'); assert.equal(buyerId, id);
}));
test('synthetic unrecognized gift funding references are refused before issuance', async () => setup(async ledger => {
  let calls = 0; const clients = { config, clients: { A: { customers: { get: async () => { calls++; } } } } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: 'cus_UNSANCTIONED_PLACEHOLDER' } } as unknown as Fixtures);
  await assert.rejects(() => op.issueGiftCard('funded'), { message: 'SANCTIONED_FUNDING_CUSTOMER_REQUIRED' }); assert.equal(calls, 0);
}));
test('nullable settings cannot be replaced with invented defaults or mutated with the pinned SDK', async () => setup(async ledger => {
  let writes = 0;
  const fake = { settings: { get: async () => ({ version: '1', customer_account: null }), update: async () => { writes++; } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }), { message: 'NULL_SETTINGS_SNAPSHOT_UNSUPPORTED_BY_PINNED_SDK' }); assert.equal(writes, 0);
}));
