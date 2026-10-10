import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditedFetch, creationTypes } from '../../support/audit-transport.ts';
import { consumeAppFeed, assertFreshRevocation } from '../../support/audit-feed.ts';
import { Driver } from '../../support/driver.ts';
import { Ledger } from '../../support/ledger.ts';
import { CredentialScanner } from '../../support/credential-scan.ts';
import { writePrivateText } from '../../support/private-files.ts';
import { API_ORIGIN } from '../../support/config.ts';
import type { Config } from '../../support/config.ts';
import { verifyBuilds } from '../../support/build.ts';

const run = '20000101T000000Z-00000000';
const pin = { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER', providerId: 'acct_PLACEHOLDER', key: 'flint_test_PLACEHOLDER' };
function config(dir: string): Config { return { run, pins: { A: pin, B: { ...pin, sandboxId: 'test_PLACEHOLDER_B' } }, operatorPins: { A: { ...pin, key: 'flint_test_OPERATOR_PLACEHOLDER' }, B: { ...pin, sandboxId: 'test_PLACEHOLDER_B' } }, apiOrigin: API_ORIGIN, privateDir: dir, fixtureFile: '', suite: 'extended', apply: false, inboxAddress: '', targetCommit: '0'.repeat(40), apiCommit: '1'.repeat(40), builds: { storefrontA: 'PLACEHOLDER_SF_A', storefrontB: 'PLACEHOLDER_SF_B', accountA: 'PLACEHOLDER_AC', api: 'PLACEHOLDER_API' }, origins: { storefrontA: 'http://localhost:4100', storefrontB: 'http://localhost:4110', accountA: 'http://localhost:4200' } }; }
async function temp(fn: (dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'audit-unit-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
const identity = { schema_version: 1, run, app: 'accountA', sandbox: 'A' };
const lines = (...entries: Record<string, unknown>[]) => entries.map(e => JSON.stringify({ ...identity, ...e }) + '\n').join('');
function driver(dir: string): Driver { return new Driver(config(dir), {} as any, {} as any, { ledger: new Ledger(join(dir, 'ledger.json'), run) } as any); }

test('audit preserves SDK responses and exports resource IDs without authentication authority', async () => temp(async dir => {
  const entries: Record<string, unknown>[] = [];
  const payload = { data: { customer_session_id: 'cses_PLACEHOLDER', customer_id: 'cus_PLACEHOLDER', secret: 'flint_cses_PLACEHOLDER', refresh_token: 'flint_cref_PLACEHOLDER', expires_at: '2000-02-01T00:00:00Z' } };
  const response = Response.json(payload, { headers: { 'x-request-id': 'req_PLACEHOLDER' } });
  const transport = auditedFetch(async () => response, async e => { entries.push(e); await writePrivateText(join(dir, 'app-audit.jsonl'), lines(...entries)); });
  const received = await transport(`${API_ORIGIN}/v1/customer-sessions`, { method: 'POST', headers: { authorization: 'Bearer flint_test_PLACEHOLDER', 'idempotency-key': 'key_PLACEHOLDER' }, body: JSON.stringify({ customer_id: 'cus_PLACEHOLDER' }) });
  assert.equal(received, response); assert.deepEqual(await received.json(), payload);
  const recorded = await readFile(join(dir, 'app-audit.jsonl'), 'utf8');
  for (const secret of ['flint_test_PLACEHOLDER', 'flint_cses_PLACEHOLDER', 'flint_cref_PLACEHOLDER', 'key_PLACEHOLDER']) assert.equal(recorded.includes(secret), false);
  assert.equal(entries.find(e => e.id === 'cses_PLACEHOLDER')?.created, true);
  assert.equal(entries.find(e => e.id === 'cus_PLACEHOLDER')?.created, false);
  assert.equal(entries.at(-1)?.kind, 'RESOLVED');
}));
test('audit rejects production, private routes, first-party headers, live keys and direct provider writes before transport', async () => {
  let calls = 0; const entries: unknown[] = [];
  const transport = auditedFetch(async () => { calls++; return Response.json({}); }, async e => { entries.push(e); });
  for (const url of ['https://api.withflintpay.com/v1/orders', `${API_ORIGIN}/internal/rpc`, 'https://api.stripe.com/v1/payment_intents', 'https://api.affirm.com/x']) await assert.rejects(() => transport(url, { method: 'POST' }));
  await assert.rejects(() => transport(`${API_ORIGIN}/v1/me`, { method: 'PATCH', headers: { 'Flint-Merchant-Id': 'mer_PLACEHOLDER' } }));
  await assert.rejects(() => transport(`${API_ORIGIN}/v1/me`, { method: 'PATCH', headers: { authorization: 'Bearer flint_live_PLACEHOLDER' } }));
  assert.equal(calls, 0); assert.equal(entries.length, 0);
});
test('customer and nested creation paths require a key while read-like previews remain usable', async () => {
  let calls = 0; const transport = auditedFetch(async () => { calls++; return Response.json({ data: {} }); }, async () => {});
  for (const path of ['/v1/me/addresses', '/v1/me/returns', '/v1/me/invoices/inv_PLACEHOLDER/checkout-session', '/v1/me/subscriptions/sub_PLACEHOLDER/payment-retries', '/v1/customer-sessions/refresh', '/v1/checkout-sessions/cks_PLACEHOLDER/delivery-selections']) {
    assert.ok(creationTypes(path).size); await assert.rejects(() => transport(API_ORIGIN + path, { method: 'POST' }), { message: 'APP_CREATION_DURABLE_KEY_REQUIRED' });
  }
  assert.equal(calls, 0); await transport(`${API_ORIGIN}/v1/me/return-previews`, { method: 'POST' }); assert.equal(calls, 1);
});
test('unknown app mutation outcome fails final reconciliation and exact replay resolves it', async () => temp(async dir => {
  const d = driver(dir), events: Record<string, unknown>[] = [{ kind: 'READY' }]; let fail = true;
  const transport = auditedFetch(async () => { if (fail) throw new Error('injected unknown'); return Response.json({ data: {} }); }, async e => { events.push(e); });
  const request = { method: 'POST', headers: { 'idempotency-key': 'key_PLACEHOLDER' }, body: '{}' };
  await assert.rejects(() => transport(`${API_ORIGIN}/v1/orders`, request));
  await assert.rejects(() => consumeAppFeed(d, 'accountA', lines(...events), true), { message: 'APP_MUTATION_OUTCOME_UNKNOWN' });
  fail = false; await transport(`${API_ORIGIN}/v1/orders`, request); await consumeAppFeed(d, 'accountA', lines(...events), true);
}));
test('feed handles partial writes and repeated reads without reusing old logout evidence', async () => temp(async dir => {
  const d = driver(dir), ready = lines({ kind: 'READY' }), revoked = lines({ kind: 'REVOCATION_ALL', customerId: 'cus_PLACEHOLDER', count: '1' });
  await consumeAppFeed(d, 'accountA', ready + revoked.slice(0, -2)); assert.equal(d.revocations.length, 0);
  await consumeAppFeed(d, 'accountA', ready + revoked); assertFreshRevocation(d, 0, 'accountA', { customerId: 'cus_PLACEHOLDER' });
  const checkpoint = d.revocations.length; await consumeAppFeed(d, 'accountA', ready + revoked);
  assert.throws(() => assertFreshRevocation(d, checkpoint, 'accountA', { customerId: 'cus_PLACEHOLDER' }));
  await consumeAppFeed(d, 'accountA', ready + revoked + lines({ kind: 'REVOCATION', id: 'cses_PLACEHOLDER' })); assertFreshRevocation(d, checkpoint, 'accountA', { sessionId: 'cses_PLACEHOLDER' });
  assert.throws(() => assertFreshRevocation(d, checkpoint, 'storefrontA', { sessionId: 'cses_PLACEHOLDER' }));
  await assert.rejects(() => consumeAppFeed(d, 'accountA', ready), { message: 'APP_AUDIT_FEED_REPLACED' });
}));
test('audit cannot turn supplied unowned fixture references into cleanup authority', async () => temp(async dir => {
  const d = driver(dir); await d.observeResource('A', 'payment_method', 'pm_PLACEHOLDER', 'payment_method', '2000-02-01T00:00:00Z', undefined, false);
  await consumeAppFeed(d, 'accountA', lines({ kind: 'READY' }, { kind: 'RESOURCE', id: 'pm_PLACEHOLDER', type: 'payment_method', cleanup: 'payment_method', reviewAt: '2000-02-01T00:00:00Z', created: true }));
  assert.equal(d.operator.ledger.state.resources.length, 1); assert.equal(d.operator.ledger.state.resources[0].owned, false);
}));
test('candidate checks use app healthz and separate API identity and refuse missing build fields', async () => temp(async dir => {
  const c = config(dir), seen: string[] = [];
  await verifyBuilds(c, async input => { const u = new URL(String(input)); seen.push(u.pathname); const name = u.origin === API_ORIGIN ? 'api' : Object.keys(c.origins).find(k => c.origins[k as keyof typeof c.origins] === u.origin)!; return Response.json({ build: { sha: name === 'api' ? c.apiCommit : c.targetCommit, artifactId: c.builds[name], startedAt: '2000-01-01T00:00:00Z' } }); });
  assert.deepEqual(seen, ['/healthz', '/healthz', '/healthz', '/health']);
  await assert.rejects(() => verifyBuilds(c, async () => Response.json({ status: 'ok' })), { message: 'TARGET_BUILD_MISMATCH' });
  c.healthPaths = { storefrontA: '//example.invalid/health' }; await assert.rejects(() => verifyBuilds(c, async () => { throw new Error('must not call'); }), { message: 'HEALTH_PATH_INVALID' });
}));
test('durable responses redact credentials and restart replays the original key to recover them', async () => temp(async dir => {
  const ledger = new Ledger(join(dir, 'ledger.json'), run), keys: string[] = [];
  const send = async (key: string) => { keys.push(key); return { id: 'cses_PLACEHOLDER', secret: 'flint_cses_PLACEHOLDER', refresh_token: 'flint_cref_PLACEHOLDER', code: 'GIFT-PLACEHOLDER', checkout_access: { checkout_auth_token: 'ckat_PLACEHOLDER' } }; };
  await ledger.action('ephemeral', 'A', 'customerSessions.create', [], send, async () => {});
  const written = await readFile(ledger.file, 'utf8'); for (const value of ['flint_cses_PLACEHOLDER', 'flint_cref_PLACEHOLDER', 'GIFT-PLACEHOLDER', 'ckat_PLACEHOLDER']) assert.equal(written.includes(value), false);
  const restarted = new Ledger(ledger.file, run); await restarted.load(); const response = await restarted.action('ephemeral', 'A', 'customerSessions.create', [], send, async () => {});
  assert.equal(response.secret, 'flint_cses_PLACEHOLDER'); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
}));

test('private checkout response fields leave a clean journal and replay before known or interrupted reconciliation', async t => {
  for (const phase of ['known', 'unknown'] as const) await t.test(phase, async () => temp(async dir => {
    const ledger = new Ledger(join(dir, 'ledger.json'), run), keys: string[] = [];
    const args = ['inv_PLACEHOLDER', { surface: 'embedded' }];
    const response = { invoice_id: 'inv_PLACEHOLDER', checkout_session: { checkout_session_id: 'cs_PLACEHOLDER', order_id: 'ord_PLACEHOLDER', recovery: [{ superseding_checkout_session_id: 'cs_NEXT_PLACEHOLDER', recovery_payment_attempt_id: 'pat_PLACEHOLDER' }] } };
    const send = async (key: string) => { keys.push(key); return response; };
    const initial = ledger.action('invoice-session', 'A', 'invoices.getOrCreateCheckoutSession', args, send, async received => {
      assert.deepEqual(received, response);
      if (phase === 'unknown') throw new Error('interrupted reconciliation');
    });
    if (phase === 'unknown') await assert.rejects(() => initial, /interrupted reconciliation/); else await initial;
    const raw = new CredentialScanner(); raw.scan(JSON.stringify(ledger.state), 'body');
    assert.deepEqual([...raw.violations], ['PRIVATE_DTO_FIELD']); assert.throws(() => raw.assertClean(), { code: 'CREDENTIAL_LEAK' });
    const clean = new CredentialScanner(); clean.scan(await readFile(ledger.file, 'utf8'), 'body'); clean.assertClean();
    const loaded = new Ledger(ledger.file, run); await loaded.load();
    const action = loaded.state.actions['A:invoice-session'];
    assert.equal(action.phase, phase); assert.equal(action.responseNeedsReplay, true); assert.deepEqual(action.args, args); assert.equal(action.key, keys[0]);
    assert.deepEqual(action.response, { invoice_id: response.invoice_id, checkout_session: { order_id: response.checkout_session.order_id, recovery: [{}] } });
    await loaded.save();
    const restarted = new Ledger(ledger.file, run); await restarted.load();
    assert.equal(restarted.state.actions['A:invoice-session'].responseNeedsReplay, true);
    let reconciled = 0;
    assert.deepEqual(await restarted.action('invoice-session', 'A', 'invoices.getOrCreateCheckoutSession', args, send, async received => {
      assert.equal(keys.length, 2); assert.deepEqual(received, response); reconciled++;
    }), response);
    assert.equal(reconciled, 1); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    assert.equal(restarted.state.actions['A:invoice-session'].phase, 'known');
    const durable = new Ledger(ledger.file, run); await durable.load();
    assert.equal(durable.state.actions['A:invoice-session'].responseNeedsReplay, true); assert.deepEqual(durable.state.actions['A:invoice-session'].args, args);
    const replayed = new CredentialScanner(); replayed.scan(await readFile(ledger.file, 'utf8'), 'body'); replayed.assertClean();
  }));
});

test('raw browser checkout DTOs and registered credentials remain forbidden', () => {
  for (const field of ['checkout_session_id', 'superseding_checkout_session_id', 'recovery_payment_attempt_id']) {
    const scanner = new CredentialScanner(); scanner.scan(JSON.stringify({ [field]: 'PLACEHOLDER' }), 'body', { providerJob: true });
    assert.deepEqual([...scanner.violations], ['PRIVATE_DTO_FIELD']); assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
  }
  const secret = 'unit-registered-authority', scanner = new CredentialScanner([secret]);
  scanner.scan(JSON.stringify({ actions: { response: { value: secret } } }), 'body');
  assert.deepEqual([...scanner.violations], ['CREDENTIAL_BODY']); assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
});

test('gift apply audit records checkout authority and proof presence without the code or header value',async()=>{
 const entries:Record<string,unknown>[]=[],proof='gccp_'+ 'X'.repeat(30),code='GIFT-FIXTURE-SECRET';let calls=0;
 const transport=auditedFetch(async()=>{calls++;return Response.json({data:{order_id:'ord_PLACEHOLDER'}});},async entry=>{entries.push(entry);});
 await transport(`${API_ORIGIN}/v1/orders/ord_PLACEHOLDER/gift-cards`,{method:'POST',headers:{'X-Checkout-Session-ID':'cs_PLACEHOLDER','X-Checkout-Session-Secret':'ckat_PLACEHOLDER','Flint-Gift-Card-Challenge':proof,'idempotency-key':'key_PLACEHOLDER'},body:JSON.stringify({gift_card_code:code,order_revision:'1'})});
 const entry=entries.find(entry=>entry.kind==='MUTATION');assert.equal(entry?.operation,'ORDER_APPLY_GIFT_CARD');assert.equal(entry?.authMode,'checkout');assert.equal(entry?.challengeProof,true);assert.equal(entry?.targetId,'ord_PLACEHOLDER');for(const value of [proof,code,'ckat_PLACEHOLDER'])assert.equal(JSON.stringify(entries).includes(value),false);
 await assert.rejects(()=>transport(`${API_ORIGIN}/v1/orders/ord_PLACEHOLDER/gift-cards`,{method:'POST',headers:{authorization:'Bearer flint_test_PLACEHOLDER'},body:'{}'}),{code:'APP_GIFT_APPLY_MERCHANT_AUTH'});assert.equal(calls,1);
});
