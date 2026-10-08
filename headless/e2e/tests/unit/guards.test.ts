import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationDecision } from '../../support/flint-boundary.ts';
import { CredentialScanner } from '../../support/credential-scan.ts';
import { pinApiOrigin, origin, API_ORIGIN, alias } from '../../support/config.ts';
import { pinnedFetch } from '../../support/sdk.ts';
import { auditLinks, parseLinks } from '../../support/inbox.ts';
import { safeFailure, HarnessError, canonical } from '../../support/safe.ts';

test('only the exact main-frame provider relay is admitted', () => {
  assert.equal(navigationDecision(`${API_ORIGIN}/payment-returns/relay_PLACEHOLDER`, 'GET', true), 'relay');
  for (const [url, method, main] of [[`${API_ORIGIN}/payment-returns/x?token=PLACEHOLDER`, 'GET', true], [`${API_ORIGIN}/payment-returns/x`, 'POST', true], [`${API_ORIGIN}/payment-returns/x`, 'GET', false], ['https://checkout.staging.withflintpay.com/x', 'GET', true], ['https://withflintpay.com/x', 'GET', true], ['https://api.withflintpay.com/payment-returns/x', 'GET', true]] as const) assert.equal(navigationDecision(url, method, main), 'reject');
});
test('staging origin cannot be overridden by URL equivalence or a production host', () => {
  assert.equal(pinApiOrigin(API_ORIGIN), API_ORIGIN);
  for (const url of [undefined, `${API_ORIGIN}/`, 'http://api.staging.withflintpay.com', 'https://api.withflintpay.com']) assert.throws(() => pinApiOrigin(url));
});
test('merchant app origins reject credentials, Flint hosts and insecure remote origins', () => {
  assert.equal(origin('http://localhost:4100'), 'http://localhost:4100');
  for (const url of ['https://user:PLACEHOLDER@shop.example.invalid', 'https://account.withflintpay.com', 'http://shop.example.invalid', 'https://shop.example.invalid/?token=PLACEHOLDER']) assert.throws(() => origin(url));
});
test('transport refuses wrong origin, private routes, headers and redirects before writes', async () => {
  let called = 0; const transport = pinnedFetch(async () => { called++; return new Response('{}'); });
  for (const url of ['https://api.withflintpay.com/v1/orders', `${API_ORIGIN}/internal/rpc`]) await assert.rejects(() => transport(url, { method: 'POST' }));
  await assert.rejects(() => transport(`${API_ORIGIN}/v1/orders`, { method: 'POST', headers: { 'Flint-Merchant-Id': 'PLACEHOLDER' } })); assert.equal(called, 0);
  await transport(`${API_ORIGIN}/v1/orders`, { method: 'POST' }); assert.equal(called, 1);
  await assert.rejects(() => pinnedFetch(async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }))(`${API_ORIGIN}/v1/orders`));
});
test('Flint credentials and private DTO authority always fail scanning', () => {
  for (const value of ['flint_test_PLACEHOLDER', 'flint_live_PLACEHOLDER', 'ckat_PLACEHOLDER', 'flint_cses_PLACEHOLDER', '{"refresh_token":"PLACEHOLDER"}']) {
    const scanner = new CredentialScanner(); scanner.scan(value, 'body', { providerJob: true }); assert.throws(() => scanner.assertClean());
  }
});
test('provider client secrets are permitted only in required job or provider transport', () => {
  const scanner = new CredentialScanner(); scanner.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', 'body', { providerJob: true }); scanner.assertClean();
  scanner.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', 'console'); assert.throws(() => scanner.assertClean());
  for (const surface of ['url', 'storage', 'cookie', 'child', 'dom'] as const) { const s = new CredentialScanner(); s.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', surface); assert.throws(() => s.assertClean()); }
});
test('gift values are confined to the specific submitted request and sensitive input', () => {
  const scanner = new CredentialScanner(); scanner.addGift('GIFT-PLACEHOLDER'); scanner.scan('GIFT-PLACEHOLDER', 'request', { submittedGift: true }); scanner.scan('GIFT-PLACEHOLDER', 'dom', { sensitiveInput: true }); scanner.assertClean();
  scanner.scan('GIFT-PLACEHOLDER', 'body'); assert.throws(() => scanner.assertClean());
});
test('token-bearing URLs fail without putting their content in an exception', () => {
  const scanner = new CredentialScanner(); scanner.scan('https://shop.example.invalid/path?email=buyer%40example.invalid', 'url'); assert.throws(() => scanner.assertClean(), { message: 'CREDENTIAL_LEAK' });
});
test('email audit rejects every unmatched Flint gift or commerce link', () => {
  const mail = { subject: '', from: '', receivedAt: '', text: '', html: '', codes: [], links: [{ text: '', href: 'https://gift.withflintpay.com/recipient/PLACEHOLDER' }] };
  assert.throws(() => auditLinks(mail, ['https://account.example.invalid']), { message: 'EMAIL_FLINT_COMMERCE_LINK' });
  mail.links = [{ text: '', href: 'https://account.example.invalid/orders/ord_PLACEHOLDER?flint_resource_type=order' }]; auditLinks(mail, ['https://account.example.invalid']);
});
test('MIME HTML link parsing decodes entities and extracts all anchors', () => {
  const links = parseLinks('<a href="https://account.example.invalid/?a=1&amp;b=2">Order</a>', 'https://carrier.example.invalid/x'); assert.equal(links[0].href, 'https://account.example.invalid/?a=1&b=2'); assert.equal(links.length, 2);
});
test('raw errors and URL data cannot enter normalized evidence', () => {
  assert.equal(safeFailure(new Error('https://example.invalid/?code=PLACEHOLDER')), 'EXECUTION_FAILED'); assert.equal(safeFailure(new HarnessError('EXPECTED_FAILURE')), 'EXPECTED_FAILURE'); assert.equal(safeFailure(new HarnessError('email@example.invalid')), 'EXECUTION_FAILED');
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});
test('run aliases exist only in supplied private runtime configuration', () => {
  assert.equal(alias({ inboxAddress: 'buyer@example.invalid', run: '20000101T000000Z-00000000' }, 'b2'), 'buyer+fx-20000101T000000Z-00000000-b2@example.invalid');
});
